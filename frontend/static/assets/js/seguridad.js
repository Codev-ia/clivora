// Mi Perfil → Seguridad: cambiar la contraseña y la verificación en dos
// pasos (apps/accounts/seguridad.py). Cada acción guarda por su cuenta; el
// botón "Guardar Cambios" del perfil no las toca.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Mensaje del servidor sin el nombre del campo ("current_password: …").
  function mensaje(error) {
    return String(error.message || error).split(' · ').map((m) => m.replace(/^[a-z_]+: /, '')).join(' ');
  }

  function api(path, body) {
    return window.ClivoraUI.api(path, body === undefined ? {} : { method: 'POST', body });
  }

  function showMsg(el, text, ok) {
    el.textContent = text;
    el.className = `profile-security-msg ${text ? (ok ? 'is-ok' : 'is-error') : ''}`;
  }

  async function withBusy(button, fn) {
    button.disabled = true;
    try { await fn(); } finally { button.disabled = false; }
  }

  // ── Contraseña ──────────────────────────────────────────────────────────
  function resetPassword() {
    ['secCurrentPass', 'secNewPass', 'secConfirmPass'].forEach((id) => { $(id).value = ''; });
    showMsg($('secPasswordMsg'), '');
  }

  async function savePassword() {
    const actual = $('secCurrentPass').value;
    const nueva = $('secNewPass').value;
    const msg = $('secPasswordMsg');
    if (!actual || !nueva) return showMsg(msg, 'Escribe la contraseña actual y la nueva.');
    if (nueva !== $('secConfirmPass').value) return showMsg(msg, 'La confirmación no coincide con la nueva contraseña.');
    await withBusy($('secPasswordSave'), async () => {
      try {
        await api('me/password/', { current_password: actual, new_password: nueva });
        resetPassword();
        showMsg(msg, 'Contraseña cambiada.', true);
      } catch (e) { showMsg(msg, mensaje(e)); }
    });
  }

  // ── Verificación en dos pasos ───────────────────────────────────────────
  let estado = { dos_pasos: false };

  function renderEstado() {
    const activa = estado.dos_pasos;
    const badge = $('sec2faBadge');
    badge.textContent = activa ? 'Activada' : 'Desactivada';
    badge.classList.toggle('is-on', activa);
    $('sec2faDesc').textContent = activa
      ? `Activada el ${new Date(estado.activado_en).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}. Te quedan ${estado.codigos_restantes} código(s) de recuperación.`
      : 'Además de tu contraseña, pide un código de una app de autenticación en tu teléfono.';
    $('sec2faToggle').textContent = activa ? 'Administrar' : 'Activar';
  }

  async function loadEstado() {
    try {
      estado = await api('me/seguridad/');
      renderEstado();
    } catch (e) { console.error('No se pudo leer la seguridad de la cuenta:', e); }
  }

  const panel = () => $('sec2faPanel');

  function closePanel() {
    panel().hidden = true;
    panel().innerHTML = '';
  }

  // Paso con contraseña: activar (QR), códigos nuevos o desactivar.
  function pedirContrasena(texto, boton, accion) {
    panel().hidden = false;
    panel().innerHTML = `
      <p class="profile-security-help">${esc(texto)}</p>
      <div class="modal-field"><label>Tu contraseña</label><input type="password" id="sec2faPass" autocomplete="current-password"></div>
      <div class="profile-security-msg" id="sec2faMsg"></div>
      <div class="profile-security-actions">
        <button type="button" class="btn-secondary modal-header-btn-standard" data-sec="cancelar">Cancelar</button>
        <button type="button" class="btn-primary modal-header-btn-standard" id="sec2faNext">${esc(boton)}</button>
      </div>`;
    $('sec2faPass').focus();
    $('sec2faNext').onclick = () => withBusy($('sec2faNext'), async () => {
      try { await accion($('sec2faPass').value); } catch (e) { showMsg($('sec2faMsg'), mensaje(e)); }
    });
  }

  function mostrarQR(data) {
    const secreto = data.secreto.replace(/(.{4})/g, '$1 ').trim();
    panel().innerHTML = `
      <ol class="profile-security-steps">
        <li>Instala una app de autenticación en tu teléfono (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
        <li>En la app, agrega una cuenta y escanea este código:</li>
      </ol>
      <div class="profile-security-qr"><img src="${data.qr}" alt="Código QR para la app de autenticación"></div>
      <p class="profile-security-help">¿No puedes escanearlo? Escribe esta clave en la app: <code class="profile-security-secret">${esc(secreto)}</code></p>
      <ol class="profile-security-steps" start="3"><li>Escribe el código de 6 dígitos que muestra la app:</li></ol>
      <div class="modal-field"><input type="text" id="sec2faCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" class="profile-security-code"></div>
      <div class="profile-security-msg" id="sec2faMsg"></div>
      <div class="profile-security-actions">
        <button type="button" class="btn-secondary modal-header-btn-standard" data-sec="cancelar">Cancelar</button>
        <button type="button" class="btn-primary modal-header-btn-standard" id="sec2faConfirm">Activar</button>
      </div>`;
    $('sec2faCode').focus();
    $('sec2faConfirm').onclick = () => withBusy($('sec2faConfirm'), async () => {
      try {
        const r = await api('me/dos_pasos/activar/', { codigo: $('sec2faCode').value });
        estado = r;
        renderEstado();
        mostrarCodigos(r.codigos, 'La verificación en dos pasos quedó activada.');
      } catch (e) { showMsg($('sec2faMsg'), mensaje(e)); }
    });
  }

  function mostrarCodigos(codigos, titulo) {
    const texto = codigos.join('\n');
    panel().innerHTML = `
      <p class="profile-security-ok">${esc(titulo)}</p>
      <p class="profile-security-help">Guarda estos <strong>códigos de recuperación</strong> en un lugar seguro. Si pierdes tu teléfono, cada uno te deja entrar una vez. No se volverán a mostrar.</p>
      <div class="profile-security-codes">${codigos.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
      <div class="profile-security-actions">
        <button type="button" class="btn-secondary modal-header-btn-standard" id="sec2faCopy">Copiar</button>
        <button type="button" class="btn-secondary modal-header-btn-standard" id="sec2faDownload">Descargar</button>
        <button type="button" class="btn-primary modal-header-btn-standard" data-sec="cancelar">Ya los guardé</button>
      </div>`;
    $('sec2faCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(texto); $('sec2faCopy').textContent = '✓ Copiados'; } catch (e) { /* sin permiso de portapapeles */ }
    };
    $('sec2faDownload').onclick = () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([`Códigos de recuperación de Clivora\n\n${texto}\n`], { type: 'text/plain' }));
      link.download = 'clivora-codigos-recuperacion.txt';
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }

  function administrar() {
    panel().hidden = false;
    panel().innerHTML = `
      <div class="profile-security-actions profile-security-actions-start">
        <button type="button" class="btn-secondary modal-header-btn-standard" id="sec2faNewCodes">Generar códigos de recuperación nuevos</button>
        <button type="button" class="btn-secondary modal-header-btn-standard profile-security-danger" id="sec2faOff">Desactivar</button>
      </div>`;
    $('sec2faNewCodes').onclick = () => pedirContrasena(
      'Los códigos de recuperación anteriores dejarán de servir.', 'Generar códigos', async (password) => {
        const r = await api('me/dos_pasos/codigos/', { password });
        estado = r;
        renderEstado();
        mostrarCodigos(r.codigos, 'Códigos de recuperación nuevos.');
      });
    $('sec2faOff').onclick = () => pedirContrasena(
      'Tu cuenta quedará protegida solo con la contraseña.', 'Desactivar', async (password) => {
        estado = await api('me/dos_pasos/desactivar/', { password });
        renderEstado();
        closePanel();
      });
  }

  function toggle2fa() {
    if (!panel().hidden) return closePanel();
    if (estado.dos_pasos) return administrar();
    pedirContrasena('Para empezar, confirma tu contraseña.', 'Continuar', async (password) => {
      mostrarQR(await api('me/dos_pasos/iniciar/', { password }));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const section = $('profileSecurity');
    if (!section) return;
    $('secPasswordToggle').addEventListener('click', () => {
      const panelPass = $('secPasswordPanel');
      panelPass.hidden = !panelPass.hidden;
      if (!panelPass.hidden) $('secCurrentPass').focus();
    });
    $('secPasswordSave').addEventListener('click', savePassword);
    $('sec2faToggle').addEventListener('click', toggle2fa);
    section.addEventListener('click', (e) => { if (e.target.closest('[data-sec="cancelar"]')) closePanel(); });
    // La sección vive dentro del formulario del perfil: Enter no debe enviarlo.
    section.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const boton = e.target.closest('.profile-security-panel')?.querySelector('.btn-primary');
      if (boton) boton.click();
    });
    // Cada vez que se abre Mi Perfil: estado al día y paneles cerrados.
    $('userProfileBtn')?.addEventListener('click', () => {
      $('secPasswordPanel').hidden = true;
      resetPassword();
      closePanel();
      loadEstado();
    });
  });
})();
