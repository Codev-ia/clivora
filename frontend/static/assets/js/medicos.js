// Médicos y enfermería (lista y ficha con cédulas y firma; de los médicos,
// especialidad y enfermera asignada) y Configuración → Especialidades. El
// administrador ve y edita a todos; los demás solo su ficha (lo filtra el
// servidor). Usa las utilidades de app-ui.js.
(function () {
  'use strict';

  const {
    $, esc, api, alertError, query, debounce, openModal, closeModal, setBusy, emptyRow, fillSelect, formValues,
    fillForm, loadMe, watchView,
  } = window.ClivoraUI;

  let me = {};
  let especialidades = null; // activas, para los selectores
  let enfermeras = null;

  const EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function applyPermissions() {
    document.querySelectorAll('.app-nav-medicos').forEach((el) => el.classList.toggle('inv-hidden', !me.canSeeMedicos));
    // Sin permiso de administrar cada quien solo se ve a sí mismo: sin filtros.
    document.querySelectorAll('.med-manage').forEach((el) => el.classList.toggle('inv-hidden', !me.canManageMedicos));
    $('medEspecialidadesLink').hidden = !me.canManageEspecialidades;
    $('espForm').classList.toggle('inv-hidden', !me.canManageEspecialidades);
    const active = document.querySelector('.page-view.active-view');
    if (active && active.id === 'medicosView' && !me.canSeeMedicos && typeof switchView === 'function') switchView('dashboard');
  }

  async function loadEspecialidades(force) {
    if (!especialidades || force) especialidades = await api('especialidades/').catch(() => []);
    return especialidades;
  }

  async function loadEnfermeras() {
    if (!enfermeras) enfermeras = await api('medicos/enfermeras/').catch(() => []);
    return enfermeras;
  }

  // ── MÉDICOS ─────────────────────────────────────────────────────────────
  let editing = null;
  // Firma elegida y aún no guardada: data URL, '' = quitar, null = sin cambios.
  let firmaPendiente = null;

  async function loadMedicos() {
    const body = $('medBody');
    body.innerHTML = emptyRow(7, 'Cargando…');
    try {
      if (me.canManageMedicos) {
        const filter = $('medEspecialidadFilter');
        const current = filter.value;
        fillSelect(filter, await loadEspecialidades(), { placeholder: 'Todas', selected: current });
        if (!filter.querySelector('option[value="none"]')) filter.insertAdjacentHTML('beforeend', '<option value="none">Sin especialidad</option>');
        filter.value = current;
      }
      const tipo = $('medTipoFilter').value;
      const data = await api(`medicos/?${query({
        q: $('medSearch').value.trim(), tipo, especialidad: $('medEspecialidadFilter').value,
      })}`);
      $('medCount').textContent = data.length;
      $('medCountLabel').textContent = { medico: 'médicos', enfermeria: 'enfermeras' }[tipo] || 'registros';
      body.innerHTML = data.length ? data.map((m) => {
        const esMedico = m.tipo === 'medico';
        const especialidad = !esMedico ? '<span class="inv-hint">—</span>' : m.especialidad_name
          ? `<span class="cfg-role-chip">${esc(m.especialidad_name)}</span>` : '<span class="inv-hint">Sin especialidad</span>';
        const asignados = esMedico ? esc(m.enfermera_name) : esc(m.medicos_asignados.join(', '));
        return `
        <tr class="inv-clickable" data-medico-id="${m.id}">
          <td class="inv-name">${esc(m.full_name)}${m.es_externo ? ' <span class="badge badge-en_progreso" style="margin-left: 6px;">EXTERNO</span>' : ''}</td>
          <td><span class="med-tipo ${m.tipo}">${esMedico ? 'Médico' : 'Enfermería'}</span></td>
          <td>${especialidad}</td>
          <td class="inv-code">${esc(m.cedula_profesional) || '<span class="inv-hint">—</span>'}</td>
          <td class="inv-muted">${asignados || '—'}</td>
          <td>${m.firma_url ? '<span class="badge badge-aprobado">CAPTURADA</span>' : '<span class="badge badge-finalizado">SIN FIRMA</span>'}</td>
          <td><div class="inv-actions"><button type="button" class="inv-icon-btn edit" title="Ver / editar" data-medico-id="${m.id}">${EDIT_ICON}</button></div></td>
        </tr>`;
      }).join('') : emptyRow(7, me.canManageMedicos
        ? 'No hay nadie que coincida. Médicos y enfermeras se dan de alta en Usuarios y roles con su rol.'
        : 'No hay registros.');
    } catch (e) { body.innerHTML = emptyRow(7, e.message); }
  }

  function renderFirma(src) {
    $('medFirmaPreview').innerHTML = src ? `<img src="${esc(src)}" alt="Firma">` : '<span>Sin firma</span>';
    $('medFirmaRemove').style.display = src ? '' : 'none';
  }

  async function openMedico(id) {
    try {
      const [m, esps, enfs] = await Promise.all([api(`medicos/${id}/`), loadEspecialidades(), loadEnfermeras()]);
      editing = m;
      firmaPendiente = null;
      const form = $('medForm');
      // La especialidad actual se conserva en la lista aunque esté desactivada.
      const opcionesEsp = esps.some((e) => e.id === m.especialidad) || !m.especialidad
        ? esps : [...esps, { id: m.especialidad, name: `${m.especialidad_name} (desactivada)` }];
      fillSelect(form.especialidad, opcionesEsp, { placeholder: 'Sin especialidad' });
      const opcionesEnf = enfs.some((e) => e.id === m.enfermera) || !m.enfermera
        ? enfs : [...enfs, { id: m.enfermera, name: m.enfermera_name }];
      fillSelect(form.enfermera, opcionesEnf, { placeholder: 'Sin enfermera asignada' });
      fillForm(form, m);
      const esMedico = m.tipo === 'medico';
      form.querySelectorAll('.med-solo-medico').forEach((el) => el.classList.toggle('inv-hidden', !esMedico));
      form.querySelectorAll('.med-solo-enfermeria').forEach((el) => el.classList.toggle('inv-hidden', esMedico));
      $('medAsignados').textContent = m.medicos_asignados.join(', ') || 'Ningún médico la tiene asignada.';
      renderFirma(m.firma_url);
      $('medFirmaInput').value = '';
      $('medModalTitle').textContent = m.full_name;
      const tipoLabel = !esMedico ? 'Enfermería' : m.es_externo ? 'Médico externo' : 'Médico';
      $('medModalSubtitle').textContent = [tipoLabel, m.username, m.email].filter(Boolean).join(' · ');
      openModal('medModal');
    } catch (e) { alertError(e); }
  }

  function onFirmaElegida(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      alertError(new Error('La firma debe ser PNG, JPG o WebP.')); input.value = ''; return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alertError(new Error('La firma no puede pesar más de 2 MB.')); input.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = () => { firmaPendiente = reader.result; renderFirma(firmaPendiente); };
    reader.readAsDataURL(file);
  }

  async function saveMedico() {
    const form = $('medForm');
    if (!form.reportValidity()) return;
    const data = formValues(form);
    ['cedula_profesional', 'cedula_especialidad', 'universidad', 'telefono'].forEach((k) => { data[k] = (data[k] || '').trim(); });
    data.especialidad = data.especialidad ? Number(data.especialidad) : null;
    data.enfermera = data.enfermera ? Number(data.enfermera) : null;
    if (editing.tipo !== 'medico') ['especialidad', 'cedula_especialidad', 'enfermera'].forEach((k) => delete data[k]);
    const btn = $('medSaveBtn');
    setBusy(btn, true);
    try {
      await api(`medicos/${editing.id}/`, { method: 'PATCH', body: data });
      if (firmaPendiente) {
        await api(`medicos/${editing.id}/firma/`, { method: 'POST', body: { firma: firmaPendiente } });
      } else if (firmaPendiente === '' && editing.firma_url) {
        await api(`medicos/${editing.id}/firma/`, { method: 'DELETE' });
      }
      closeModal('medModal');
      // La especialidad del médico filtra "Cita con" en agenda y pacientes.
      if (typeof clivoraDoctorsCatalog !== 'undefined') clivoraDoctorsCatalog = null;
      if (typeof clivoraCitasCatalogsCache !== 'undefined') clivoraCitasCatalogsCache = null;
      loadMedicos();
    } catch (e) { alertError(e, 'No se pudo guardar el médico'); } finally { setBusy(btn, false); }
  }

  // ── ESPECIALIDADES ──────────────────────────────────────────────────────
  let listaEsp = [];

  async function loadListaEspecialidades() {
    const body = $('espBody');
    body.innerHTML = emptyRow(4, 'Cargando…');
    try {
      listaEsp = await api(`especialidades/?${query({ active: $('espInactive').checked ? 'all' : '' })}`);
      $('espCount').textContent = listaEsp.length;
      const canEdit = me.canManageEspecialidades;
      body.innerHTML = listaEsp.length ? listaEsp.map((e) => `
        <tr>
          <td class="inv-name">${canEdit ? `<input type="text" class="search-input inv-price-input cfg-sala-name" value="${esc(e.name)}" data-esp-name="${e.id}" maxlength="120">` : esc(e.name)}</td>
          <td class="inv-num">${e.medicos_count}</td>
          <td><span class="badge ${e.active ? 'badge-aprobado' : 'badge-finalizado'}">${e.active ? 'ACTIVA' : 'DESACTIVADA'}</span></td>
          <td>${canEdit ? `<div class="inv-actions">
            <button type="button" class="inv-icon-btn ${e.active ? 'cancel' : 'ok'}" title="${e.active ? 'Desactivar' : 'Activar'}" data-esp-toggle="${e.id}">
              ${e.active
                ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
                : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'}
            </button></div>` : ''}</td>
        </tr>`).join('') : emptyRow(4, 'Todavía no hay especialidades. Agrega la primera arriba.');
    } catch (e) { body.innerHTML = emptyRow(4, e.message); }
  }

  // Los selectores de especialidad de app.js (agenda, pacientes) guardan el
  // catálogo en memoria: se olvida para que vean el cambio sin recargar.
  function catalogoCambiado() {
    especialidades = null;
    if (typeof clivoraDoctorSpecialtiesCatalog !== 'undefined') clivoraDoctorSpecialtiesCatalog = null;
    if (typeof clivoraCitasCatalogsCache !== 'undefined') clivoraCitasCatalogsCache = null;
  }

  async function addEspecialidad(e) {
    e.preventDefault();
    const form = $('espForm');
    const data = formValues(form);
    data.name = (data.name || '').trim();
    if (!data.name) { alertError(new Error('Escribe el nombre de la especialidad.')); return; }
    const btn = $('espAddBtn');
    setBusy(btn, true, 'Agregando…');
    try {
      await api('especialidades/', { method: 'POST', body: { name: data.name, active: true } });
      form.reset();
      catalogoCambiado();
      await loadListaEspecialidades();
    } catch (err) { alertError(err, 'No se pudo agregar la especialidad'); } finally { setBusy(btn, false); }
  }

  async function toggleEspecialidad(id) {
    const esp = listaEsp.find((e) => String(e.id) === String(id));
    try {
      await api(`especialidades/${id}/`, { method: 'PATCH', body: { active: !esp.active } });
      catalogoCambiado();
      await loadListaEspecialidades();
    } catch (e) { alertError(e); }
  }

  async function renameEspecialidad(input) {
    const name = input.value.trim();
    if (!name) { input.classList.add('inv-input-error'); return; }
    input.classList.remove('inv-input-error');
    try {
      await api(`especialidades/${input.dataset.espName}/`, { method: 'PATCH', body: { name } });
      input.classList.add('inv-input-saved');
      setTimeout(() => input.classList.remove('inv-input-saved'), 900);
      catalogoCambiado();
    } catch (e) { alertError(e, 'No se pudo renombrar la especialidad'); }
  }

  // ── eventos ─────────────────────────────────────────────────────────────
  function bindEvents() {
    $('medSearch').addEventListener('input', debounce(loadMedicos));
    $('medEspecialidadFilter').addEventListener('change', loadMedicos);
    // La especialidad solo aplica a médicos: con Enfermería se limpia.
    $('medTipoFilter').addEventListener('change', () => {
      const filter = $('medEspecialidadFilter');
      const soloEnfermeria = $('medTipoFilter').value === 'enfermeria';
      filter.closest('.filter-group').classList.toggle('inv-hidden', soloEnfermeria);
      if (soloEnfermeria && filter.value) {
        filter.value = '';
        filter.dispatchEvent(new Event('change')); // recarga la lista (ver arriba)
        return;
      }
      loadMedicos();
    });
    $('medBody').addEventListener('click', (e) => {
      const row = e.target.closest('[data-medico-id]');
      if (row) openMedico(row.dataset.medicoId);
    });
    $('medSaveBtn').addEventListener('click', saveMedico);
    $('medForm').addEventListener('submit', (e) => { e.preventDefault(); saveMedico(); });
    $('medFirmaInput').addEventListener('change', (e) => onFirmaElegida(e.target));
    $('medFirmaRemove').addEventListener('click', () => { firmaPendiente = ''; $('medFirmaInput').value = ''; renderFirma(''); });
    $('medEspecialidadesLink').addEventListener('click', () => {
      closeModal('medModal');
      if (typeof switchView === 'function') switchView('especialidades');
    });

    $('espForm').addEventListener('submit', addEspecialidad);
    $('espInactive').addEventListener('change', loadListaEspecialidades);
    $('espBody').addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-esp-toggle]');
      if (toggle) toggleEspecialidad(toggle.dataset.espToggle);
    });
    $('espBody').addEventListener('change', (e) => {
      const input = e.target.closest('[data-esp-name]');
      if (input) renameEspecialidad(input);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!$('medicosView')) return;
    bindEvents();
    me = await loadMe();
    applyPermissions();
    watchView('medicosView', loadMedicos);
    watchView('especialidadesView', loadListaEspecialidades);
  });
}());
