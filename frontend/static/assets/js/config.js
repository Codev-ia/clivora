// Configuración: selector de clínica activa (multiempresa) del encabezado y
// las pantallas Clínicas, Lugares y salas, y Usuarios y roles.
// Productos y Listas de precios también viven en el menú Configuración, pero
// su lógica está en inventario.js. Usa las utilidades de app-ui.js.
(function () {
  'use strict';

  const {
    $, esc, api, alertError, query, dateTime, debounce, openModal, closeModal, setBusy, emptyRow, fillSelect,
    formValues, fillForm, setPager, loadMe, confirmDialog, watchView,
  } = window.ClivoraUI;

  let me = {};

  // ── permisos: menú y botones ────────────────────────────────────────────
  function applyPermissions() {
    const show = {
      clinicas: me.canManageClinicas,
      lugares: me.canManageLugares,
      usuarios: me.canManageUsers,
      productos: me.canSeeInventory,
      precios: me.canSeeInventory,
      sistema: me.isSuperuser,
    };
    Object.entries(show).forEach(([key, visible]) => {
      document.querySelectorAll(`.app-nav-${key}`).forEach((el) => el.classList.toggle('inv-hidden', !visible));
    });
    const section = $('configNavSection');
    if (section) section.style.display = Object.values(show).some(Boolean) ? '' : 'none';
    document.querySelectorAll('.cfg-manage-clinicas').forEach((el) => el.classList.toggle('inv-hidden', !me.canManageClinicas));
    document.querySelectorAll('.cfg-manage-lugares').forEach((el) => el.classList.toggle('inv-hidden', !me.canManageLugares));
    document.querySelectorAll('.cfg-manage-usuarios').forEach((el) => el.classList.toggle('inv-hidden', !me.canManageUsers));
    // Si la última pantalla guardada ya no está permitida, regresa al Inicio.
    const active = document.querySelector('.page-view.active-view');
    const viewKey = active && active.id.replace(/View$/, '');
    if (viewKey in show && !show[viewKey] && typeof switchView === 'function') switchView('dashboard');
  }

  // ── límites de la instalación (Configuración → Sistema) ─────────────────
  let limites = {};

  function limitText(used, max, noun) {
    const activos = noun === 'clínicas' ? 'activas' : 'activos';
    return max === null || max === undefined ? `${used} ${noun} ${activos} · sin límite` : `${used} de ${max} ${noun} ${activos}`;
  }

  function renderLimits() {
    const full = (used, max) => max !== null && max !== undefined && used >= max;
    const pills = [
      ['cfgUsuariosLimit', limites.usuarios, limites.maxUsuarios, 'usuarios', 'cfgNewUsuarioBtn'],
      ['cfgClinicasLimit', limites.clinicas, limites.maxClinicas, 'clínicas', 'cfgNewClinicaBtn'],
    ];
    pills.forEach(([pillId, used, max, noun, btnId]) => {
      const pill = $(pillId);
      const isFull = full(used, max);
      if (pill) {
        pill.textContent = max === null || max === undefined ? '' : `${used} / ${max}`;
        pill.classList.toggle('is-full', isFull);
        pill.title = limitText(used, max, noun);
      }
      const btn = $(btnId);
      if (btn) {
        btn.disabled = isFull;
        btn.title = isFull ? `Se alcanzó el máximo: ${limitText(used, max, noun)}` : '';
        btn.style.opacity = isFull ? '0.55' : '';
      }
    });
  }

  async function refreshLimits() {
    try {
      const s = await api('sistema/');
      limites = { usuarios: s.usuarios, maxUsuarios: s.max_usuarios, clinicas: s.clinicas, maxClinicas: s.max_clinicas };
      renderLimits();
      return s;
    } catch (e) { console.error(e); return null; }
  }

  // ── SISTEMA (solo superusuario) ─────────────────────────────────────────
  function renderUsage(barId, textId, used, max, noun) {
    const bar = $(barId);
    const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
    bar.style.width = max ? `${pct}%` : '0';
    bar.classList.toggle('is-full', !!max && used >= max);
    bar.classList.toggle('is-near', !!max && used < max && pct >= 80);
    $(textId).textContent = limitText(used, max, noun);
  }

  async function loadSistema() {
    const [s, profile] = await Promise.all([refreshLimits(), api('me/').catch(() => null)]);
    if (s) {
      fillForm($('sysLimitsForm'), { max_usuarios: s.max_usuarios ?? '', max_clinicas: s.max_clinicas ?? '' });
      renderUsage('sysUsersBar', 'sysUsersText', s.usuarios, s.max_usuarios, 'usuarios');
      renderUsage('sysClinicsBar', 'sysClinicsText', s.clinicas, s.max_clinicas, 'clínicas');
      $('sysLimitsUpdated').textContent = s.updated_by_name
        ? `Última modificación: ${s.updated_by_name} · ${dateTime(s.updated_at)}` : '';
    }
    if (profile) fillForm($('sysProfileForm'), profile);
    $('sysPasswordForm').reset();
    await loadCorreo();
  }

  // ── servidor de correo (Sistema) ────────────────────────────────────────
  const PUERTOS = { tls: 587, ssl: 465, ninguna: 25 };

  async function loadCorreo() {
    const correo = await api('sistema/correo/').catch(() => null);
    if (!correo) return;
    fillForm($('sysCorreoForm'), { ...correo, smtp_password: '' });
    $('sysCorreoPassword').placeholder = correo.smtp_password_guardada ? '•••••••• (guardada)' : '';
  }

  async function saveCorreo() {
    const form = $('sysCorreoForm');
    if (!form.reportValidity()) return;
    const data = formValues(form);
    if (!data.smtp_password) delete data.smtp_password; // vacía: conservar la guardada
    const btn = $('sysCorreoSaveBtn');
    setBusy(btn, true);
    try {
      await api('sistema/correo/', { method: 'PATCH', body: data });
      await loadCorreo();
      flashSaved(btn, 'Servidor guardado');
    } catch (e) { alertError(e, 'No se pudo guardar el servidor de correo'); } finally { setBusy(btn, false); }
  }

  async function sendCorreoPrueba() {
    const form = $('sysCorreoPruebaForm');
    if (!form.reportValidity()) return;
    const btn = $('sysCorreoPruebaBtn');
    setBusy(btn, true, 'Enviando…');
    try {
      await api('sistema/correo/prueba/', { method: 'POST', body: formValues(form) });
      flashSaved(btn, 'Correo enviado');
    } catch (e) { alertError(e, 'No se pudo enviar el correo de prueba'); } finally { setBusy(btn, false); }
  }

  // Confirmación verde junto al botón (la ventana de avisos de Clivora es para errores).
  function flashSaved(button, text) {
    let note = button.parentElement.querySelector('.cfg-saved-note');
    if (!note) {
      note = document.createElement('span');
      note.className = 'cfg-saved-note';
      button.before(note);
    }
    note.textContent = `✓ ${text}`;
    note.classList.add('show');
    clearTimeout(note._t);
    note._t = setTimeout(() => note.classList.remove('show'), 3000);
  }

  async function saveLimits() {
    const form = $('sysLimitsForm');
    if (!form.reportValidity()) return;
    const toValue = (v) => (v === '' || v === null ? null : Number(v));
    const btn = $('sysLimitsSaveBtn');
    setBusy(btn, true);
    try {
      await api('sistema/', { method: 'PATCH', body: {
        max_usuarios: toValue(form.max_usuarios.value), max_clinicas: toValue(form.max_clinicas.value),
      } });
      await loadSistema();
      flashSaved(btn, 'Límites guardados');
    } catch (e) { alertError(e, 'No se pudieron guardar los límites'); } finally { setBusy(btn, false); }
  }

  async function saveProfile() {
    const form = $('sysProfileForm');
    if (!form.reportValidity()) return;
    const btn = $('sysProfileSaveBtn');
    setBusy(btn, true);
    try {
      await api('me/', { method: 'PATCH', body: formValues(form) });
      // El nombre aparece en el encabezado y en el menú lateral.
      window.location.reload();
    } catch (e) { alertError(e, 'No se pudieron guardar los datos'); } finally { setBusy(btn, false); }
  }

  async function savePassword() {
    const form = $('sysPasswordForm');
    const data = formValues(form);
    if (!data.current_password || !data.new_password) { alertError(new Error('Escribe la contraseña actual y la nueva.')); return; }
    if (data.new_password !== data.confirm_password) { alertError(new Error('La confirmación no coincide con la nueva contraseña.')); return; }
    const btn = $('sysPasswordSaveBtn');
    setBusy(btn, true, 'Cambiando…');
    try {
      await api('me/password/', { method: 'POST', body: { current_password: data.current_password, new_password: data.new_password } });
      form.reset();
      flashSaved(btn, 'Contraseña cambiada');
    } catch (e) { alertError(e, 'No se pudo cambiar la contraseña'); } finally { setBusy(btn, false); }
  }

  // ── selector de clínica activa (encabezado) ────────────────────────────
  function renderClinicaPill() {
    const pill = $('appClinicaPill');
    const name = $('appClinicaName');
    const menu = $('appClinicaMenu');
    if (!pill) return;
    const activa = me.clinicaActiva;
    const clinicas = me.clinicas || [];
    name.textContent = activa ? activa.name : 'Sin clínica';
    const multiple = clinicas.length > 1;
    $('appClinicaChevron').style.display = multiple ? '' : 'none';
    pill.classList.toggle('is-switchable', multiple);
    const full = activa ? [activa.name, activa.city].filter(Boolean).join(' · ') : '';
    pill.title = multiple ? `${full} — cambiar de clínica` : full;
    menu.innerHTML = `<div class="app-clinica-menu-title">Cambiar de clínica</div>` + clinicas.map((c) => `
      <button type="button" class="app-clinica-option${activa && c.id === activa.id ? ' is-active' : ''}" data-clinica-id="${c.id}" role="menuitem">
        <span>${esc(c.name)}</span>${c.city ? `<small>${esc(c.city)}</small>` : ''}
      </button>`).join('');
  }

  async function switchClinica(id) {
    if (me.clinicaActiva && Number(id) === me.clinicaActiva.id) { $('appClinicaPill').classList.remove('open'); return; }
    try {
      await api('me/clinica/', { method: 'POST', body: { clinica: Number(id) } });
      // Todo lo que se ve (inventario, listas, lugares…) depende de la clínica:
      // se recarga la página completa en la misma pantalla.
      window.location.reload();
    } catch (e) { alertError(e, 'No se pudo cambiar de clínica'); }
  }

  // ── CLÍNICAS ────────────────────────────────────────────────────────────
  let editingClinica = null;
  let regimenes = null;
  // Logo elegido y aún no guardado: data URL, '' = quitar, null = sin cambios.
  let logoPendiente = null;

  async function loadRegimenes() {
    if (!regimenes) regimenes = await api('/clivora/api/fiscal_regimes').catch(() => []);
    return regimenes;
  }

  async function loadClinicas() {
    const body = $('cfgClinicasBody');
    body.innerHTML = emptyRow(8, 'Cargando…');
    try {
      const data = await api(`core/clinicas/?${query({ active: $('cfgClinicasArchived').checked ? 'all' : '' })}`);
      $('cfgClinicasCount').textContent = data.length;
      body.innerHTML = data.length ? data.map((c) => `
        <tr class="inv-clickable" data-clinica-id="${c.id}">
          <td class="inv-name"><div class="cfg-name-cell">${c.logo_url ? `<img class="cfg-logo-thumb" src="${esc(c.logo_url)}" alt="">` : ''}<span>${esc(c.name)}</span>${me.clinicaActiva && me.clinicaActiva.id === c.id ? ' <span class="badge badge-aprobado" style="margin-left: 8px;">ACTIVA</span>' : ''}</div></td>
          <td class="inv-muted">${esc(c.legal_name)}</td>
          <td class="inv-code">${esc(c.rfc)}</td>
          <td class="inv-muted">${c.regimen_fiscal ? `${esc(c.regimen_fiscal)} · ${esc(c.regimen_fiscal_label)}` : '<span class="inv-hint">Sin datos fiscales</span>'}</td>
          <td class="inv-num">${c.lugares_count}</td>
          <td class="inv-num">${c.usuarios_count}</td>
          <td><span class="badge ${c.active ? 'badge-aprobado' : 'badge-finalizado'}">${c.active ? 'ACTIVA' : 'ARCHIVADA'}</span></td>
          <td><div class="inv-actions"><button type="button" class="inv-icon-btn edit" title="Ver / editar" data-clinica-id="${c.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></div></td>
        </tr>`).join('') : emptyRow(8, 'No hay clínicas.');
    } catch (e) { body.innerHTML = emptyRow(8, e.message); }
  }

  function renderLogo(src) {
    $('cfgClinicaLogoPreview').innerHTML = src ? `<img src="${esc(src)}" alt="Logo">` : '<span>Sin logo</span>';
    $('cfgClinicaLogoRemove').style.display = src ? '' : 'none';
  }

  function renderPersona() {
    const rfc = $('cfgClinicaForm').rfc.value.trim();
    $('cfgClinicaPersona').textContent = rfc.length === 12 ? '· persona moral' : rfc.length === 13 ? '· persona física' : '';
  }

  async function openClinica(id) {
    try {
      const [c, regs] = await Promise.all([
        id ? api(`core/clinicas/${id}/`) : Promise.resolve({ name: '', city: '', phone: '', email: '', active: true, legal_name: '',
          rfc: '', regimen_fiscal: '', codigo_postal: '', calle: '', numero_exterior: '', numero_interior: '', colonia: '',
          municipio: '', estado: '', pais: 'México', logo_url: '' }),
        loadRegimenes(),
      ]);
      editingClinica = c;
      logoPendiente = null;
      const form = $('cfgClinicaForm');
      fillSelect(form.regimen_fiscal, regs, { value: 'code', label: (r) => `${r.code} · ${r.label}`, placeholder: 'Seleccionar…' });
      fillForm(form, c);
      renderLogo(c.logo_url);
      renderPersona();
      $('cfgClinicaLogoInput').value = '';
      form.classList.toggle('inv-readonly', Boolean(!me.canManageClinicas));
      $('cfgClinicaModalTitle').textContent = id ? c.name : 'Nueva clínica';
      openModal('cfgClinicaModal');
    } catch (e) { alertError(e); }
  }

  function onLogoElegido(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      alertError(new Error('El logo debe ser PNG, JPG o WebP.')); input.value = ''; return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alertError(new Error('El logo no puede pesar más de 2 MB.')); input.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = () => { logoPendiente = reader.result; renderLogo(logoPendiente); };
    reader.readAsDataURL(file);
  }

  async function saveClinica() {
    const form = $('cfgClinicaForm');
    if (!form.reportValidity()) return;
    const data = formValues(form);
    // Los selectores vacíos llegan como null; en la clínica son texto vacío.
    Object.keys(data).forEach((k) => { if (data[k] === null) data[k] = ''; });
    data.rfc = (data.rfc || '').toUpperCase();
    const btn = $('cfgClinicaSaveBtn');
    setBusy(btn, true);
    try {
      const id = editingClinica && editingClinica.id;
      const saved = await api(id ? `core/clinicas/${id}/` : 'core/clinicas/', { method: id ? 'PATCH' : 'POST', body: data });
      if (logoPendiente) {
        await api(`core/clinicas/${saved.id}/logo/`, { method: 'POST', body: { logo: logoPendiente } });
      } else if (logoPendiente === '' && editingClinica.logo_url) {
        await api(`core/clinicas/${saved.id}/logo/`, { method: 'DELETE' });
      }
      closeModal('cfgClinicaModal');
      // Una clínica nueva o renombrada cambia el selector del encabezado.
      window.location.reload();
    } catch (e) { alertError(e, 'No se pudo guardar la clínica'); } finally { setBusy(btn, false); }
  }

  // ── LUGARES Y SALAS ─────────────────────────────────────────────────────
  let editingLugar = null;

  function salaBadges(salas) {
    const activas = salas.filter((s) => s.active);
    if (!activas.length) return '<span class="inv-muted">Sin salas</span>';
    return activas.map((s) => `<span class="cfg-sala-chip ${s.tipo}">${esc(s.name)}</span>`).join('');
  }

  async function loadLugares() {
    const wrap = $('cfgLugaresCards');
    $('cfgLugaresClinica').textContent = me.clinicaActiva ? me.clinicaActiva.name : '';
    $('cfgNewLugarBtn').disabled = !me.clinicaActiva;
    if (!me.clinicaActiva) {
      $('cfgLugaresCount').textContent = 0;
      wrap.innerHTML = '<div class="cfg-empty">Primero da de alta una clínica en Configuración → Clínicas.</div>';
      return;
    }
    wrap.innerHTML = '<div class="cfg-empty">Cargando…</div>';
    try {
      const data = await api(`core/lugares/?${query({ active: $('cfgLugaresArchived').checked ? 'all' : '' })}`);
      $('cfgLugaresCount').textContent = data.length;
      wrap.innerHTML = data.length ? data.map((l) => {
        const tratamiento = l.salas.filter((s) => s.tipo === 'tratamiento' && s.active).length;
        const consulta = l.salas.filter((s) => s.tipo === 'consulta' && s.active).length;
        return `
        <div class="cfg-card${l.active ? '' : ' is-inactive'}" data-lugar-id="${l.id}">
          <div class="cfg-card-head">
            <div>
              <div class="cfg-card-title">${esc(l.name)}</div>
              <div class="cfg-card-sub">${esc(l.address) || '&nbsp;'}</div>
            </div>
            ${l.active ? '' : '<span class="badge badge-finalizado">INACTIVO</span>'}
          </div>
          <div class="cfg-card-stats">
            <span><strong>${tratamiento}</strong> salas de tratamiento</span>
            <span><strong>${consulta}</strong> consultorios</span>
          </div>
          <div class="cfg-sala-chips">${salaBadges(l.salas)}</div>
        </div>`;
      }).join('') : `<div class="cfg-empty">La clínica activa no tiene lugares de atención.${me.canManageLugares ? ' Agrega el primero con "+ Nuevo lugar".' : ''}</div>`;
    } catch (e) { wrap.innerHTML = `<div class="cfg-empty">${esc(e.message)}</div>`; }
  }

  function renderSalas() {
    const body = $('cfgSalasBody');
    const salas = (editingLugar && editingLugar.salas) || [];
    const canEdit = me.canManageLugares;
    body.innerHTML = salas.length ? salas.map((s) => `
      <tr>
        <td class="inv-name">${canEdit ? `<input type="text" class="search-input inv-price-input cfg-sala-name" value="${esc(s.name)}" data-sala-name="${s.id}" maxlength="80">` : esc(s.name)}</td>
        <td><span class="cfg-sala-chip ${s.tipo}">${esc(s.tipo_label)}</span></td>
        <td><span class="badge ${s.active ? 'badge-aprobado' : 'badge-finalizado'}">${s.active ? 'ACTIVA' : 'INACTIVA'}</span></td>
        <td>${canEdit ? `<div class="inv-actions">
          <button type="button" class="inv-icon-btn ${s.active ? 'cancel' : 'ok'}" title="${s.active ? 'Desactivar' : 'Activar'}" data-sala-toggle="${s.id}">
            ${s.active
              ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
              : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'}
          </button></div>` : ''}</td>
      </tr>`).join('') : emptyRow(4, 'Este lugar todavía no tiene salas ni consultorios.');
  }

  async function openLugar(id) {
    try {
      const l = id ? await api(`core/lugares/${id}/`) : { name: '', address: '', active: true, salas: [] };
      editingLugar = l;
      const form = $('cfgLugarForm');
      fillForm(form, l);
      form.classList.toggle('inv-readonly', Boolean(!me.canManageLugares));
      $('cfgLugarModalTitle').textContent = id ? l.name : 'Nuevo lugar de atención';
      $('cfgLugarModalSubtitle').textContent = id ? l.clinica_name : (me.clinicaActiva ? me.clinicaActiva.name : '');
      $('cfgSalasBlock').style.display = id ? '' : 'none';
      $('cfgSalaForm').reset();
      renderSalas();
      openModal('cfgLugarModal');
    } catch (e) { alertError(e); }
  }

  async function refreshLugar() {
    editingLugar = await api(`core/lugares/${editingLugar.id}/`);
    renderSalas();
    loadLugares();
  }

  async function saveLugar() {
    const form = $('cfgLugarForm');
    if (!form.reportValidity()) return;
    const data = formValues(form);
    const btn = $('cfgLugarSaveBtn');
    setBusy(btn, true);
    try {
      const id = editingLugar && editingLugar.id;
      if (!id) data.clinica = me.clinicaActiva && me.clinicaActiva.id;
      const saved = await api(id ? `core/lugares/${id}/` : 'core/lugares/', { method: id ? 'PATCH' : 'POST', body: data });
      loadLugares();
      if (!id) openLugar(saved.id); // recién creado: sigue con sus salas
      else closeModal('cfgLugarModal');
    } catch (e) { alertError(e, 'No se pudo guardar el lugar'); } finally { setBusy(btn, false); }
  }

  async function addSala() {
    const form = $('cfgSalaForm');
    const name = form.name.value.trim();
    if (!name) { alertError(new Error('Escribe el nombre de la sala.')); return; }
    const btn = $('cfgSalaAddBtn');
    setBusy(btn, true, 'Agregando…');
    try {
      await api('core/salas/', { method: 'POST', body: {
        lugar: editingLugar.id, name, tipo: form.tipo.value, sequence: (editingLugar.salas.length + 1) * 10,
      } });
      form.name.value = '';
      await refreshLugar();
    } catch (e) { alertError(e, 'No se pudo agregar la sala'); } finally { setBusy(btn, false); }
  }

  async function toggleSala(id) {
    const sala = editingLugar.salas.find((s) => String(s.id) === String(id));
    try {
      await api(`core/salas/${id}/`, { method: 'PATCH', body: { active: !sala.active } });
      await refreshLugar();
    } catch (e) { alertError(e); }
  }

  async function renameSala(input) {
    const name = input.value.trim();
    if (!name) { input.classList.add('inv-input-error'); return; }
    input.classList.remove('inv-input-error');
    try {
      await api(`core/salas/${input.dataset.salaName}/`, { method: 'PATCH', body: { name } });
      input.classList.add('inv-input-saved');
      setTimeout(() => input.classList.remove('inv-input-saved'), 900);
      editingLugar = await api(`core/lugares/${editingLugar.id}/`);
      loadLugares();
    } catch (e) { alertError(e, 'No se pudo renombrar la sala'); }
  }

  // ── USUARIOS Y ROLES ────────────────────────────────────────────────────
  const usr = { page: 1, pageSize: 50, roles: [], editing: null };

  async function loadRoles() {
    if (!usr.roles.length) usr.roles = await api('roles/');
    return usr.roles;
  }

  async function loadUsuarios() {
    const body = $('cfgUsuariosBody');
    body.innerHTML = emptyRow(7, 'Cargando…');
    try {
      const roles = await loadRoles();
      if ($('cfgUsuariosRol').options.length <= 1) fillSelect($('cfgUsuariosRol'), roles, { placeholder: 'Todos los roles' });
      if (!$('cfgUsuariosClinica').options.length) {
        const opts = [...(me.clinicas || [])];
        fillSelect($('cfgUsuariosClinica'), opts, { selected: me.clinicaActiva && me.clinicaActiva.id });
        if (opts.length > 1) $('cfgUsuariosClinica').insertAdjacentHTML('beforeend', '<option value="all">Todas mis clínicas</option>');
      }
      const data = await api(`usuarios/?${query({
        q: $('cfgUsuariosSearch').value.trim(), clinica: $('cfgUsuariosClinica').value, role: $('cfgUsuariosRol').value,
        active: $('cfgUsuariosActive').value, page: usr.page, page_size: usr.pageSize,
      })}`);
      $('cfgUsuariosCount').textContent = data.count.toLocaleString('es-MX');
      setPager('cfgUsuarios', usr.page, data.count, usr.pageSize);
      body.innerHTML = data.results.length ? data.results.map((u) => {
        const roles = u.role_names.filter((r) => r !== 'Acceso a Clivora');
        return `
        <tr class="inv-clickable" data-usuario-id="${u.id}">
          <td class="inv-name">${esc(u.full_name)}${u.is_superuser ? ' <span class="badge badge-en_progreso" style="margin-left: 6px;">SUPERUSUARIO</span>' : ''}</td>
          <td class="inv-muted">${esc(u.username)}</td>
          <td><div class="cfg-role-chips">${roles.length ? roles.map((r) => `<span class="cfg-role-chip">${esc(r)}</span>`).join('') : '<span class="inv-muted">—</span>'}</div>
            ${u.role_names.includes('Acceso a Clivora') || u.is_superuser ? '' : '<div class="inv-hint" style="margin-top: 4px;">Sin acceso a Clivora</div>'}</td>
          <td class="inv-muted">${esc(u.clinica_names.join(', ')) || '—'}</td>
          <td class="inv-muted" style="white-space: nowrap;">${u.last_login ? dateTime(u.last_login) : 'Nunca'}</td>
          <td><span class="badge ${u.is_active ? 'badge-aprobado' : 'badge-finalizado'}">${u.is_active ? 'ACTIVO' : 'INACTIVO'}</span></td>
          <td><div class="inv-actions"><button type="button" class="inv-icon-btn edit" title="Ver / editar" data-usuario-id="${u.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></div></td>
        </tr>`;
      }).join('') : emptyRow(7, 'No hay usuarios que coincidan con los filtros.');
    } catch (e) { body.innerHTML = emptyRow(7, e.message); }
  }

  // ── Permisos: tarjetas con el interruptor de Clivora (.toggle-switch) ──────
  const SVG = (paths) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const ROLE_ICONS = {
    'Acceso a Clivora': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
    Administrador: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    'Médicos': '<path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/>',
    'Médico Externo': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
    'Enfermería': '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    'Jefa de Enfermería': '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M12 8v6"/><path d="M9 11h6"/>',
    'Recepción': '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-5h6v5"/>',
    'Jefe de Admisiones/Recepción': '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="m9 14 2 2 4-4"/>',
    'Coordinación de Citas': '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="m9 16 2 2 4-4"/>',
    Farmacia: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>',
    Comercial: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
    'Compartir Expediente': '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    'Desglose de Documentos': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
    'Historial Médico: Editar Fecha de Creación': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  };
  const ROLE_GROUPS = [
    ['Acceso y administración', ['Acceso a Clivora', 'Administrador']],
    ['Atención clínica', ['Médicos', 'Médico Externo', 'Enfermería', 'Jefa de Enfermería']],
    ['Recepción y citas', ['Recepción', 'Jefe de Admisiones/Recepción', 'Coordinación de Citas']],
    ['Farmacia y comercial', ['Farmacia', 'Comercial']],
    ['Expediente', ['Compartir Expediente', 'Desglose de Documentos', 'Historial Médico: Editar Fecha de Creación']],
  ];
  const CLINICA_ICON = '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/>';

  function permCard(item, name, checked, { icon, desc }) {
    return `
      <label class="cfg-perm${checked ? ' is-on' : ''}">
        <input type="checkbox" name="${name}" value="${item.id}" ${checked ? 'checked' : ''} hidden>
        <span class="cfg-perm-icon">${SVG(icon)}</span>
        <span class="cfg-perm-text">
          <span class="cfg-perm-name">${esc(item.name)}</span>
          ${desc ? `<span class="cfg-perm-desc">${esc(desc)}</span>` : ''}
        </span>
        <span class="toggle-switch${checked ? ' active' : ''}" aria-hidden="true"><span class="toggle-switch-knob"></span></span>
      </label>`;
  }

  function renderRoles(container, roles, selectedIds) {
    const selected = new Set((selectedIds || []).map(String));
    const byName = new Map(roles.map((r) => [r.name, r]));
    const used = new Set();
    const groups = ROLE_GROUPS.map(([title, names]) => {
      const items = names.map((n) => byName.get(n)).filter(Boolean);
      items.forEach((r) => used.add(r.name));
      return [title, items];
    });
    const otros = roles.filter((r) => !used.has(r.name));
    if (otros.length) groups.push(['Otros', otros]);
    container.innerHTML = groups.filter(([, items]) => items.length).map(([title, items]) => `
      <div class="cfg-perm-group">
        <div class="cfg-perm-group-title">${esc(title)}</div>
        <div class="cfg-perm-grid">${items.map((r) => permCard(r, 'roles', selected.has(String(r.id)),
          { icon: ROLE_ICONS[r.name] || ROLE_ICONS['Acceso a Clivora'], desc: r.description })).join('')}</div>
      </div>`).join('');
    updatePermCount(container, 'roles');
  }

  function renderClinicasPerm(container, clinicas, selectedIds) {
    const selected = new Set((selectedIds || []).map(String));
    container.innerHTML = `<div class="cfg-perm-grid">${clinicas.map((c) => permCard(c, 'clinicas', selected.has(String(c.id)),
      { icon: CLINICA_ICON, desc: c.city || '' })).join('')}</div>`;
    updatePermCount(container, 'clinicas');
  }

  function updatePermCount(container, name) {
    const n = container.querySelectorAll(`input[name="${name}"]:checked`).length;
    const counter = $(name === 'roles' ? 'cfgUsuarioRolesCount' : 'cfgUsuarioClinicasCount');
    if (counter) counter.textContent = n === 1 ? '1 asignado' : `${n} asignados`;
  }

  // Sincroniza tarjeta e interruptor con su casilla (el clic en la tarjeta
  // cambia la casilla nativa del <label>).
  function onPermChange(e) {
    const input = e.target.closest('.cfg-perm input[type="checkbox"]');
    if (!input) return;
    const card = input.closest('.cfg-perm');
    card.classList.toggle('is-on', input.checked);
    card.querySelector('.toggle-switch').classList.toggle('active', input.checked);
    updatePermCount(e.currentTarget, input.name);
  }

  function syncClinicaActivaOptions() {
    const form = $('cfgUsuarioForm');
    const checked = [...form.querySelectorAll('input[name="clinicas"]:checked')].map((el) => Number(el.value));
    const options = (me.clinicas || []).filter((c) => checked.includes(c.id));
    const current = form.clinica_activa.value;
    fillSelect(form.clinica_activa, options, {
      placeholder: options.length ? null : 'Sin clínicas',
      selected: options.some((c) => String(c.id) === current) ? current : (options[0] && options[0].id),
    });
  }

  async function openUsuario(id) {
    try {
      const roles = await loadRoles();
      const u = id ? await api(`usuarios/${id}/`) : {
        username: '', first_name: '', last_name: '', email: '', is_active: true,
        roles: roles.filter((r) => r.name === 'Acceso a Clivora').map((r) => r.id),
        clinicas: me.clinicaActiva ? [me.clinicaActiva.id] : [], clinica_activa: me.clinicaActiva && me.clinicaActiva.id,
      };
      usr.editing = u;
      const form = $('cfgUsuarioForm');
      renderClinicasPerm($('cfgUsuarioClinicas'), me.clinicas || [], u.clinicas);
      renderRoles($('cfgUsuarioRoles'), roles, u.roles);
      fillForm(form, { ...u, password: '' });
      syncClinicaActivaOptions();
      form.clinica_activa.value = u.clinica_activa || form.clinica_activa.value;
      form.clinica_activa.dispatchEvent(new Event('change'));
      $('cfgUsuarioPasswordLabel').textContent = id ? 'Nueva contraseña (opcional)' : 'Contraseña *';
      form.classList.toggle('inv-readonly', Boolean(!me.canManageUsers || (u.is_superuser && !me.isSuperuser)));
      $('cfgUsuarioDosPasos').hidden = !u.dos_pasos;
      $('cfgUsuarioModalTitle').textContent = id ? u.full_name : 'Nuevo usuario';
      $('cfgUsuarioModalSubtitle').textContent = id
        ? `${u.username}${u.last_login ? ` · último acceso ${dateTime(u.last_login)}` : ' · nunca ha entrado'}` : '';
      openModal('cfgUsuarioModal');
    } catch (e) { alertError(e); }
  }

  async function quitarDosPasos() {
    const u = usr.editing;
    if (!u || !u.id) return;
    if (!(await confirmDialog(`¿Quitar la verificación en dos pasos de ${u.full_name}? Podrá entrar solo con su contraseña hasta que la vuelva a activar.`))) return;
    try {
      usr.editing = await api(`usuarios/${u.id}/quitar_dos_pasos/`, { method: 'POST' });
      $('cfgUsuarioDosPasos').hidden = true;
    } catch (e) { alertError(e, 'No se pudo quitar la verificación en dos pasos'); }
  }

  async function saveUsuario() {
    const form = $('cfgUsuarioForm');
    if (!form.reportValidity()) return;
    const data = {
      first_name: form.first_name.value.trim(),
      last_name: form.last_name.value.trim(),
      username: form.username.value.trim(),
      email: form.email.value.trim(),
      is_active: form.is_active.checked,
      clinicas: [...form.querySelectorAll('input[name="clinicas"]:checked')].map((el) => Number(el.value)),
      roles: [...form.querySelectorAll('input[name="roles"]:checked')].map((el) => Number(el.value)),
      clinica_activa: form.clinica_activa.value ? Number(form.clinica_activa.value) : null,
    };
    if (form.password.value) data.password = form.password.value;
    const id = usr.editing && usr.editing.id;
    if (!data.clinicas.length && !(usr.editing && usr.editing.is_superuser)) {
      if (!(await confirmDialog('El usuario no tiene ninguna clínica permitida, así que no podrá entrar a Clivora. ¿Guardar de todos modos?', 'Sin clínicas'))) return;
    }
    const btn = $('cfgUsuarioSaveBtn');
    setBusy(btn, true);
    try {
      await api(id ? `usuarios/${id}/` : 'usuarios/', { method: id ? 'PATCH' : 'POST', body: data });
      closeModal('cfgUsuarioModal');
      loadUsuarios();
      refreshLimits();
    } catch (e) { alertError(e, 'No se pudo guardar el usuario'); } finally { setBusy(btn, false); }
  }

  // ── eventos ─────────────────────────────────────────────────────────────
  function bindEvents() {
    // Selector de clínica
    const pill = $('appClinicaPill');
    pill.addEventListener('click', (e) => {
      const option = e.target.closest('[data-clinica-id]');
      if (option) { switchClinica(option.dataset.clinicaId); return; }
      if (pill.classList.contains('is-switchable')) pill.classList.toggle('open');
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#appClinicaPill')) pill.classList.remove('open'); });
    document.addEventListener('keyup', (e) => { if (e.key === 'Escape') pill.classList.remove('open'); });

    // Clínicas
    $('cfgClinicasArchived').addEventListener('change', loadClinicas);
    $('cfgNewClinicaBtn').addEventListener('click', () => openClinica(null));
    $('cfgClinicasBody').addEventListener('click', (e) => {
      const row = e.target.closest('[data-clinica-id]');
      if (row) openClinica(row.dataset.clinicaId);
    });
    $('cfgClinicaSaveBtn').addEventListener('click', saveClinica);
    $('cfgClinicaLogoInput').addEventListener('change', (e) => onLogoElegido(e.target));
    $('cfgClinicaLogoRemove').addEventListener('click', () => { logoPendiente = ''; $('cfgClinicaLogoInput').value = ''; renderLogo(''); });
    $('cfgClinicaForm').rfc.addEventListener('input', renderPersona);

    // Lugares y salas
    $('cfgLugaresArchived').addEventListener('change', loadLugares);
    $('cfgNewLugarBtn').addEventListener('click', () => openLugar(null));
    $('cfgLugaresCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-lugar-id]');
      if (card) openLugar(card.dataset.lugarId);
    });
    $('cfgLugarSaveBtn').addEventListener('click', saveLugar);
    $('cfgSalaAddBtn').addEventListener('click', addSala);
    $('cfgSalaForm').addEventListener('submit', (e) => { e.preventDefault(); addSala(); });
    $('cfgSalasBody').addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-sala-toggle]');
      if (toggle) toggleSala(toggle.dataset.salaToggle);
    });
    $('cfgSalasBody').addEventListener('change', (e) => {
      const input = e.target.closest('[data-sala-name]');
      if (input) renameSala(input);
    });

    // Usuarios
    const reloadUsuarios = () => { usr.page = 1; loadUsuarios(); };
    $('cfgUsuariosSearch').addEventListener('input', debounce(reloadUsuarios));
    ['cfgUsuariosClinica', 'cfgUsuariosRol', 'cfgUsuariosActive'].forEach((id) => $(id).addEventListener('change', reloadUsuarios));
    $('cfgNewUsuarioBtn').addEventListener('click', () => openUsuario(null));
    $('cfgUsuariosBody').addEventListener('click', (e) => {
      const row = e.target.closest('[data-usuario-id]');
      if (row) openUsuario(row.dataset.usuarioId);
    });
    $('cfgUsuarioClinicas').addEventListener('change', (e) => { onPermChange(e); syncClinicaActivaOptions(); });
    $('cfgUsuarioRoles').addEventListener('change', onPermChange);
    $('cfgUsuarioSaveBtn').addEventListener('click', saveUsuario);
    $('cfgUsuarioQuitar2faBtn').addEventListener('click', quitarDosPasos);

    // Sistema
    $('sysLimitsSaveBtn').addEventListener('click', saveLimits);
    $('sysProfileSaveBtn').addEventListener('click', saveProfile);
    $('sysPasswordSaveBtn').addEventListener('click', savePassword);
    $('sysCorreoSaveBtn').addEventListener('click', saveCorreo);
    $('sysCorreoPruebaBtn').addEventListener('click', sendCorreoPrueba);
    // Al cambiar la seguridad se propone su puerto habitual.
    $('sysCorreoSeguridad').addEventListener('change', (e) => {
      const puerto = $('sysCorreoForm').smtp_puerto;
      if (Object.values(PUERTOS).includes(Number(puerto.value)) || !puerto.value) puerto.value = PUERTOS[e.target.value];
    });

    // Paginador de usuarios (los de inventario.js ignoran este prefijo).
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pager="cfgUsuarios"]');
      if (!btn) return;
      const pages = Number($('cfgUsuariosPager').dataset.pages || 1);
      const next = Math.min(pages, Math.max(1, usr.page + Number(btn.dataset.dir)));
      if (next !== usr.page) { usr.page = next; loadUsuarios(); }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!$('clinicasView')) return;
    bindEvents();
    me = await loadMe();
    renderClinicaPill();
    applyPermissions();
    limites = me.limites || {};
    renderLimits();
    watchView('clinicasView', loadClinicas);
    watchView('lugaresView', loadLugares);
    watchView('usuariosView', loadUsuarios);
    if (me.isSuperuser) watchView('sistemaView', loadSistema);
  });
}());
