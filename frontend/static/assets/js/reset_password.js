// Restablecer contraseña con el diseño del login de Clivora
// (/clivora/reset_password): pedir el enlace manda un correo; el enlace trae
// el token con el que se elige la contraseña nueva.

document.addEventListener('DOMContentLoaded', () => {
  let state = {};
  try {
    state = JSON.parse(document.body.dataset.state || '{}');
  } catch (e) {
    state = {};
  }
  const token = new URLSearchParams(window.location.search).get('token') || '';

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

  function showStep(step) {
    document.querySelectorAll('.reset-step').forEach(el => {
      el.hidden = el.dataset.step !== step;
    });
    const focusable = document.querySelector(`.reset-step[data-step="${step}"] input`);
    if (focusable) focusable.focus();
  }

  function setLoading(form, loading) {
    const button = form.querySelector('.login-submit');
    button.classList.toggle('loading', loading);
    button.disabled = loading;
  }

  function showError(form, message) {
    setLoading(form, false);
    const box = form.querySelector('.login-error');
    box.querySelector('.login-error-text').textContent = message;
    box.classList.remove('visible');
    void box.offsetWidth; // reflow para re-disparar la animación de shake
    box.classList.add('visible');
  }

  // reCAPTCHA v3: solo si el servidor tiene la clave configurada.
  let recaptchaReady = null;
  if (state.recaptchaKey) {
    recaptchaReady = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = `https://www.recaptcha.net/recaptcha/api.js?render=${encodeURIComponent(state.recaptchaKey)}`;
      script.onload = () => window.grecaptcha.ready(resolve);
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
  }
  async function recaptchaToken() {
    if (!recaptchaReady) return '';
    await recaptchaReady;
    try {
      return await window.grecaptcha.execute(state.recaptchaKey, { action: 'password_reset' });
    } catch (e) {
      return '';
    }
  }

  async function post(url, fields) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    if (!response.ok) return { ok: false, error: 'server' };
    return response.json();
  }

  const REQUEST_ERRORS = {
    missing: 'Ingresa tu correo.',
    send_failed: 'No se pudo enviar el correo. Intenta más tarde o contacta al consultorio.',
    server: 'No se pudo completar la solicitud. Intenta de nuevo.',
    network: 'No se pudo conectar. Intenta de nuevo.',
  };
  const CONFIRM_ERRORS = {
    missing: 'Escribe tu nueva contraseña en los dos campos.',
    mismatch: 'Las contraseñas no coinciden.',
    server: 'No se pudo guardar la contraseña. Intenta de nuevo.',
    network: 'No se pudo conectar. Intenta de nuevo.',
  };

  const requestForm = document.getElementById('resetRequestForm');
  requestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = document.getElementById('resetEmail').value.trim();
    if (!login) {
      showError(requestForm, REQUEST_ERRORS.missing);
      return;
    }
    setLoading(requestForm, true);
    try {
      const result = await post('/clivora/reset_password', {
        login,
        recaptcha_token_response: await recaptchaToken(),
      });
      if (result.ok) {
        showStep('sent');
      } else {
        showError(requestForm, result.message || REQUEST_ERRORS[result.error] || REQUEST_ERRORS.server);
      }
    } catch (error) {
      console.error('Error al solicitar el restablecimiento de contraseña:', error);
      showError(requestForm, REQUEST_ERRORS.network);
    }
  });

  const confirmForm = document.getElementById('resetConfirmForm');
  confirmForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('resetPassword').value;
    const confirmPassword = document.getElementById('resetPasswordConfirm').value;
    if (!password || !confirmPassword) {
      showError(confirmForm, CONFIRM_ERRORS.missing);
      return;
    }
    if (password !== confirmPassword) {
      showError(confirmForm, CONFIRM_ERRORS.mismatch);
      return;
    }
    setLoading(confirmForm, true);
    try {
      const result = await post('/clivora/reset_password/confirm', {
        token,
        password,
        confirm_password: confirmPassword,
      });
      if (result.ok) {
        const loginLink = document.getElementById('resetDoneLogin');
        if (loginLink && result.login) {
          loginLink.href = `/clivora/login?login=${encodeURIComponent(result.login)}`;
        }
        showStep('done');
      } else if (result.error === 'invalid_token') {
        showStep('invalid');
      } else {
        showError(confirmForm, result.message || CONFIRM_ERRORS[result.error] || CONFIRM_ERRORS.server);
      }
    } catch (error) {
      console.error('Error al guardar la nueva contraseña:', error);
      showError(confirmForm, CONFIRM_ERRORS.network);
    }
  });

  if (state.mode === 'confirm' && state.name) {
    document.getElementById('resetConfirmGreeting').textContent =
      `Hola, ${state.name}. Escríbela dos veces para confirmarla.`;
  }
  showStep(state.mode || 'request');
});
