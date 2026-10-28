// Login de Clivora (/clivora/login): autentica contra el servidor (POST a
// /clivora/login, ver apps/web/views.py) y muestra la animación de bienvenida.

document.addEventListener('DOMContentLoaded', () => {
  const loginOverlay = document.getElementById('loginOverlay');
  const loginForm = document.getElementById('loginForm');
  const loginEmail = document.getElementById('loginEmail');
  const loginPassword = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');
  const loginErrorText = document.getElementById('loginErrorText');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');
  const loginSuccessOverlay = document.getElementById('loginSuccessOverlay');
  const loginParticles = document.getElementById('loginParticles');

  if (!loginOverlay || !loginForm) return;

  function createParticles() {
    for (let i = 0; i < 30; i++) {
      const particle = document.createElement('div');
      particle.className = 'login-particle';
      particle.style.left = Math.random() * 100 + '%';
      particle.style.width = (Math.random() * 4 + 2) + 'px';
      particle.style.height = particle.style.width;
      particle.style.animationDuration = (Math.random() * 8 + 6) + 's';
      particle.style.animationDelay = (Math.random() * 5) + 's';
      particle.style.opacity = Math.random() * 0.5 + 0.1;
      loginParticles.appendChild(particle);
    }
  }
  createParticles();

  // ?login=… (al volver de restablecer la contraseña): el correo ya escrito.
  const prefillLogin = new URLSearchParams(window.location.search).get('login');
  if (prefillLogin) {
    loginEmail.value = prefillLogin;
    loginPassword.focus();
  }

  const ERROR_MESSAGES = {
    missing: 'Ingresa tu correo y contraseña.',
    invalid: 'Correo o contraseña incorrectos.',
    forbidden: 'Esta cuenta no tiene acceso a esta aplicación. Contacta al consultorio.',
    network: 'No se pudo conectar. Intenta de nuevo.',
  };

  function showError(code) {
    loginSubmitBtn.classList.remove('loading');
    loginSubmitBtn.disabled = false;

    loginErrorText.textContent = ERROR_MESSAGES[code] || 'No se pudo iniciar sesión.';
    loginError.classList.remove('visible');
    void loginError.offsetWidth; // reflow para re-disparar la animación de shake
    loginError.classList.add('visible');

    loginEmail.style.borderColor = '#EF4444';
    loginPassword.style.borderColor = '#EF4444';
    setTimeout(() => {
      loginEmail.style.borderColor = '';
      loginPassword.style.borderColor = '';
    }, 1500);
  }

  // redirect: destino que decide el servidor (ver apps/web/views.py).
  function playSuccessAnimation(name, role, redirect) {
    const successName = document.getElementById('loginSuccessName');
    const successRole = document.getElementById('loginSuccessRole');
    if (successName) successName.textContent = 'Bienvenido' + (name ? ', ' + name : '');
    if (successRole) successRole.textContent = role || '';

    const successParticles = document.getElementById('successParticles');
    if (successParticles) {
      const colors = ['#60A5FA', '#93C5FD', '#BFDBFE', '#FFFFFF', '#3B82F6'];
      for (let i = 0; i < 40; i++) {
        const p = document.createElement('div');
        p.className = 'success-particle';
        const angle = (Math.PI * 2 * i) / 40;
        const distance = 80 + Math.random() * 200;
        const tx = Math.cos(angle) * distance;
        const ty = Math.sin(angle) * distance;
        p.style.background = colors[Math.floor(Math.random() * colors.length)];
        p.style.width = (Math.random() * 6 + 3) + 'px';
        p.style.height = p.style.width;
        p.style.animation = `particleBurst ${0.8 + Math.random() * 0.6}s ${0.3 + Math.random() * 0.3}s cubic-bezier(0.25, 1, 0.5, 1) forwards`;
        p.style.setProperty('--tx', tx + 'px');
        p.style.setProperty('--ty', ty + 'px');
        successParticles.appendChild(p);
      }
    }

    loginSuccessOverlay.classList.add('active');

    const destination = redirect || '/clivora';
    // Mientras corre la animación, el navegador ya va pidiendo la página de
    // destino — así la navegación del final se siente inmediata.
    const prefetch = document.createElement('link');
    prefetch.rel = 'prefetch';
    prefetch.href = destination;
    document.head.appendChild(prefetch);

    setTimeout(() => {
      if (destination === '/clivora') {
        // Clivora: se desvanece la pantalla oscura para "revelar" el fondo
        // morado de Clivora justo antes de entrar.
        loginOverlay.classList.add('hidden');
        setTimeout(() => {
          window.location.href = destination;
        }, 800);
      } else {
        // Otro destino: sin fundido; la pantalla de bienvenida se queda hasta
        // que el navegador pinta la página siguiente.
        window.location.href = destination;
      }
    }, 2800);
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    loginError.classList.remove('visible');
    loginSubmitBtn.classList.add('loading');
    loginSubmitBtn.disabled = true;

    try {
      const response = await fetch('/clivora/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          login: loginEmail.value.trim(),
          password: loginPassword.value,
          // Destino original (enlace directo o sesión expirada); el servidor
          // decide si lo respeta (_safe_next_url en apps/web/views.py).
          redirect: new URLSearchParams(window.location.search).get('redirect') || '',
        }),
      });
      const result = await response.json();
      if (result.ok && result.mfa) {
        // Verificación en dos pasos pendiente: directo a la pantalla para
        // capturar el código (la sesión todavía no está completa,
        // así que no hay bienvenida que mostrar aún).
        window.location.href = result.redirect;
      } else if (result.ok) {
        playSuccessAnimation(result.name, result.specialty, result.redirect);
      } else {
        showError(result.error);
      }
    } catch (error) {
      console.error('Error al iniciar sesión:', error);
      showError('network');
    }
  });
});
