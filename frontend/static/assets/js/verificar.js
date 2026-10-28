// Segundo paso del inicio de sesión (/clivora/login/verificar): código de la
// app de autenticación o un código de recuperación.

document.addEventListener('DOMContentLoaded', () => {
  let state = {};
  try {
    state = JSON.parse(document.body.dataset.state || '{}');
  } catch (e) {
    state = {};
  }

  const particles = document.getElementById('loginParticles');
  if (particles) {
    for (let i = 0; i < 30; i++) {
      const particle = document.createElement('div');
      particle.className = 'login-particle';
      particle.style.left = Math.random() * 100 + '%';
      particle.style.width = (Math.random() * 4 + 2) + 'px';
      particle.style.height = particle.style.width;
      particle.style.animationDuration = (Math.random() * 8 + 6) + 's';
      particle.style.animationDelay = (Math.random() * 5) + 's';
      particle.style.opacity = Math.random() * 0.5 + 0.1;
      particles.appendChild(particle);
    }
  }

  const form = document.getElementById('verifyForm');
  const input = document.getElementById('verifyCode');
  const button = form.querySelector('.login-submit');
  const errorBox = document.getElementById('verifyError');
  let recuperacion = false;

  if (state.name) {
    document.getElementById('verifyHint').textContent =
      `Hola, ${state.name}. Escribe el código de 6 dígitos de tu app de autenticación.`;
  }
  if (state.dias) {
    document.getElementById('verifyRememberText').textContent =
      `No volver a pedirlo en este equipo durante ${state.dias} días`;
  }

  function showError(message) {
    button.classList.remove('loading');
    button.disabled = false;
    errorBox.querySelector('.login-error-text').textContent = message;
    errorBox.classList.remove('visible');
    void errorBox.offsetWidth; // reflow para re-disparar la animación de shake
    errorBox.classList.add('visible');
    input.select();
  }

  // Código de la app (6 dígitos) o de recuperación (xxxx-xxxx).
  document.getElementById('verifyToggle').addEventListener('click', () => {
    recuperacion = !recuperacion;
    input.value = '';
    input.maxLength = recuperacion ? 9 : 6;
    input.inputMode = recuperacion ? 'text' : 'numeric';
    input.placeholder = recuperacion ? 'xxxx-xxxx' : '123456';
    document.getElementById('verifyHint').textContent = recuperacion
      ? 'Escribe uno de tus códigos de recuperación. Cada uno sirve una sola vez.'
      : 'Escribe el código de 6 dígitos de tu app de autenticación.';
    document.getElementById('verifyToggle').textContent = recuperacion
      ? 'Usar el código de la app'
      : '¿No tienes tu teléfono? Usa un código de recuperación';
    errorBox.classList.remove('visible');
    input.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) {
      showError('Escribe el código.');
      return;
    }
    errorBox.classList.remove('visible');
    button.classList.add('loading');
    button.disabled = true;
    try {
      const response = await fetch('/clivora/login/verificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, remember: document.getElementById('verifyRemember').checked ? '1' : '' }),
      });
      const result = await response.json();
      if (result.ok) {
        window.location.href = result.redirect || '/clivora';
      } else if (result.error === 'expired') {
        showError('Se agotó el tiempo o los intentos. Inicia sesión de nuevo.');
        setTimeout(() => { window.location.href = '/clivora/logout'; }, 2500);
      } else {
        showError(`Código incorrecto. Te quedan ${result.remaining} intento(s).`);
      }
    } catch (error) {
      console.error('Error al verificar el código:', error);
      showError('No se pudo conectar. Intenta de nuevo.');
    }
  });

  input.focus();
});
