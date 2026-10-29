// ============================================================
// Clivora — App Logic (app.js)
// ============================================================
// Este archivo controla toda la interactividad de la aplicación:
//   - Login y autenticación
//   - Navegación entre vistas principales (sidebar)
//   - Sub-tabs del dashboard de Inicio
//   - Calendario/Agenda
//   - Detalle de paciente y expediente
//   - Navegación de secciones HC (Historia Clínica)
//   - Navegación de subtabs del expediente
//   - Búsqueda de pacientes y vista grid/lista
//   - Modales (agregar paciente, agregar cita)
//   - Gráficas (Chart.js)
//   - Lógica de formularios HC (heredo, no patológicos, patológicos, diagnósticos)
//   - Persistencia con localStorage


// Global Date Formatting Helper
function formatDateIso(d) {
  if (!d) return '';
  const dateObj = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dateObj.getTime())) return '';
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================
// Candado contra guardados duplicados
// ============================================================
// Pacientes, citas, recetas, órdenes y notas se duplicaban en Producción: los
// botones de guardar no se bloqueaban mientras el servidor respondía y un
// segundo clic (o Enter) mandaba otro "crear" idéntico, con fracciones de
// segundo de diferencia. Si llega un POST a la API de Clivora exactamente igual
// (misma URL y mismo cuerpo) a uno que sigue en curso o que terminó hace
// menos de CLIVORA_POST_DEDUPE_MS, no se vuelve a enviar: se reutiliza la
// respuesta del primero (cada llamada recibe su propio clone()). No aplica a
// subidas de archivos (FormData) ni a POST sin cuerpo.
const CLIVORA_POST_DEDUPE_MS = 2000;
(function installClivoraPostDedupe() {
  if (window.__clivoraPostDedupeInstalled) return;
  window.__clivoraPostDedupeInstalled = true;
  const originalFetch = window.fetch.bind(window);
  const recent = new Map();
  window.fetch = function clivoraDedupedFetch(input, init) {
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    const body = init && init.body;
    if (method !== 'POST' || typeof body !== 'string' || !url.includes('/clivora/api/')) {
      return originalFetch(input, init);
    }
    const key = `${url}\n${body}`;
    const existing = recent.get(key);
    if (existing) return existing.promise.then((response) => response.clone());
    const entry = { promise: originalFetch(input, init) };
    recent.set(key, entry);
    entry.promise.then(
      () => setTimeout(() => { if (recent.get(key) === entry) recent.delete(key); }, CLIVORA_POST_DEDUPE_MS),
      () => { if (recent.get(key) === entry) recent.delete(key); },
    );
    return entry.promise.then((response) => response.clone());
  };
})();

// Bloquea un botón de guardar mientras se guarda ("Guardando…") y lo regresa
// a como estaba al terminar.
function setClivoraButtonBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.clivoraBusy === '1') return;
    btn.dataset.clivoraBusy = '1';
    btn.dataset.clivoraBusyHtml = btn.innerHTML;
    // Conserva el ancho del botón (antes al cambiar a solo texto se
    // encogía/estiraba y movía el resto del encabezado del modal) y pone un
    // ícono girando en lugar del ícono original.
    btn.dataset.clivoraBusyMinWidth = btn.style.minWidth || '';
    btn.style.minWidth = `${btn.offsetWidth}px`;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.classList.add('is-saving');
    btn.innerHTML = '<svg class="clivora-btn-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg><span>Guardando…</span>';
  } else {
    if (btn.dataset.clivoraBusy !== '1') return;
    btn.innerHTML = btn.dataset.clivoraBusyHtml || btn.innerHTML;
    btn.style.minWidth = btn.dataset.clivoraBusyMinWidth || '';
    btn.classList.remove('is-saving');
    delete btn.dataset.clivoraBusyMinWidth;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    delete btn.dataset.clivoraBusy;
    delete btn.dataset.clivoraBusyHtml;
  }
}

// Candado de un guardado completo (no solo de la petición al servidor): el
// candado de installClivoraPostDedupe no alcanza cuando, tras guardar, el
// formulario se limpia y luego se esperan otras recargas antes de mostrar el
// aviso de éxito — un segundo clic en ese lapso mandaba un guardado distinto
// (ya vacío) y creaba otro registro (p. ej. Órdenes Médicas). Mientras `fn`
// corre, cualquier otro clic con la misma `key` se ignora y el botón muestra
// "Guardando…".
const clivoraSaveLocks = new Set();
// Lee un archivo como data URL (base64) con await, para que el candado cubra
// también la lectura (antes era un callback de FileReader suelto).
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function runClivoraSaveOnce(key, btn, fn) {
  if (clivoraSaveLocks.has(key)) return undefined;
  clivoraSaveLocks.add(key);
  setClivoraButtonBusy(btn, true);
  try {
    return await fn();
  } finally {
    clivoraSaveLocks.delete(key);
    setClivoraButtonBusy(btn, false);
  }
}

// ============================================================
// 0. LOGIN — Autenticación y animación de entrada
// ============================================================
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

// Inverso de escapeHtml: campos como *_observations/*_note se capturan con
// el editor de texto enriquecido y guardan HTML tal cual — usar ese valor
// directo en un <input>/<textarea> plano (que solo entiende texto, no
// markup) muestra las etiquetas literales en vez de renderizarlas. Se usa
// para resúmenes de solo-lectura como "Alergias" en los encabezados de
// Receta/Nota (ver populatePatientHeaderInfo), no para los editores de
// texto enriquecido en sí (esos ya manejan HTML real vía innerHTML).
function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

// Igual que stripHtml pero para precargar un <textarea> editable: conserva
// los saltos de línea (<br> y fin de <p>/<div>/<li>) en vez de colapsarlos.
// Lo usa "3. Notas" de la Nota de Oncología Médica: es un textarea, pero se
// guarda en extra_indications (Html), que regresa envuelto en <p>…</p>.
function htmlToTextareaValue(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|li|h[1-6])>/gi, '\n');
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

// Modal de alerta genérico de toda la app — reemplaza al diálogo nativo del
// navegador (feo, no responsivo, distinto en cada navegador y bloqueado por
// política de DevTools en algunos equipos), que hasta ahora se usaba en la
// mayoría de los guardados fallidos y validaciones. Mismo diseño ya
// validado en showPatientValidationWarningModal (advertencia ámbar), pero
// como función global compartida en vez de duplicarla otra vez por cada
// módulo — antes existía además una copia casi idéntica de esta función
// solo para los modales de citas (showCitaWarningModal), ya unificada acá.
// Mensaje para un guardado que el servidor rechazó: el texto genérico
// (fallback) más el motivo real cuando el servidor lo da — antes solo se
// mostraba "No se pudo guardar…" y no había forma de saber por qué (campo
// obligatorio, falta de permisos…). Algunos errores (422, 403) pueden llegar
// como una página HTML con el mensaje en un <p>; los endpoints de la API,
// como JSON con "message". Un error interno (500) no trae
// nada útil para el usuario: queda solo el genérico.
async function clivoraResponseErrorMessage(response, fallback) {
  if (!response || response.status >= 500) return fallback;
  try {
    const text = await response.text();
    let detail = '';
    try {
      const data = JSON.parse(text);
      detail = (data && typeof data.message === 'string') ? data.message : '';
    } catch (e) {
      const match = text.match(/<p>([\s\S]*?)<\/p>/i);
      if (match) detail = new DOMParser().parseFromString(match[1], 'text/html').body.textContent || '';
    }
    detail = detail.trim();
    return detail ? `${fallback} ${detail}` : fallback;
  } catch (e) {
    return fallback;
  }
}

function showClivoraAlertModal(message, title = 'No se pudo completar la acción') {
  let modal = document.getElementById('clivoraAlertModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'clivoraAlertModal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px); z-index: 1000000; align-items: center; justify-content: center; padding: 20px;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="max-width: 440px; width: 94%; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 28px 24px; box-shadow: 0 24px 48px rgba(0,0,0,0.3); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px;">
      <div style="width: 60px; height: 60px; border-radius: 50%; background: #FEF3C7; border: 2px solid #F59E0B; color: #D97706; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 20px rgba(245, 158, 11, 0.22);">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>

      <div>
        <h3 style="font-size: 18px; font-weight: 800; color: var(--text-main); margin: 0 0 6px 0; letter-spacing: -0.3px;">${escapeHtml(title)}</h3>
        <p style="font-size: 13px; color: var(--text-muted); margin: 0; font-weight: 500; line-height: 1.4; white-space: pre-line;">${escapeHtml(message)}</p>
      </div>

      <button type="button" class="btn-anim-lift" onclick="document.getElementById('clivoraAlertModal').style.display='none';"
        style="width: 100%; padding: 11px 16px; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: var(--radius-md); background: #D97706; color: #FFFFFF; cursor: pointer; border: none; box-shadow: 0 4px 12px rgba(217, 119, 6, 0.25); margin-top: 4px;">
        Entendido
      </button>
    </div>
  `;
  modal.style.display = 'flex';
}

// Modal de confirmación genérico — reemplaza a confirm() nativo (mismo
// problema que alert(): feo, no responsivo, y algunos equipos lo bloquean
// por política de DevTools). A diferencia de confirm(), esto es asíncrono
// (el navegador no deja "pausar" el script para esperar un modal propio),
// así que cada llamado existente pasó de `if (!confirm(x)) return;` a
// `if (!(await showClivoraConfirmModal(x))) return;` dentro de una función
// async. Se usa sobre todo para confirmar eliminaciones — por eso el ícono
// es de advertencia en rojo en vez del ámbar de showClivoraAlertModal.
// `options.variant`: 'danger' (rojo, default — confirmar eliminaciones) o
// 'warning' (ámbar — confirmar una acción fuera de lo normal pero no
// destructiva, ej. agendar una cita en el pasado). `options.confirmLabel`
// permite un texto de botón distinto a "Eliminar" (ej. "Sí, continuar").
function showClivoraConfirmModal(message, title = 'Confirmar eliminación', options = {}) {
  const isWarning = options.variant === 'warning';
  const confirmLabel = options.confirmLabel || (isWarning ? 'Sí, continuar' : 'Eliminar');
  const cancelLabel = options.cancelLabel || 'Cancelar';
  const accentColor = isWarning ? '#D97706' : '#EF4444';
  const accentBg = isWarning ? '#FEF3C7' : '#FEF2F2';
  const iconPath = isWarning
    ? '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
    : '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>';

  return new Promise((resolve) => {
    let modal = document.getElementById('clivoraConfirmModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'clivoraConfirmModal';
      modal.className = 'modal-overlay';
      modal.style.cssText = 'display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px); z-index: 1000000; align-items: center; justify-content: center; padding: 20px;';
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <div style="max-width: 440px; width: 94%; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 28px 24px; box-shadow: 0 24px 48px rgba(0,0,0,0.3); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px;">
        <div style="width: 60px; height: 60px; border-radius: 50%; background: ${accentBg}; border: 2px solid ${accentColor}; color: ${accentColor}; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 20px ${isWarning ? 'rgba(245, 158, 11, 0.22)' : 'rgba(239, 68, 68, 0.22)'};">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            ${iconPath}
          </svg>
        </div>

        <div>
          <h3 style="font-size: 18px; font-weight: 800; color: var(--text-main); margin: 0 0 6px 0; letter-spacing: -0.3px;">${escapeHtml(title)}</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin: 0; font-weight: 500; line-height: 1.4;">${escapeHtml(message)}</p>
        </div>

        <div style="display: flex; gap: 10px; width: 100%; margin-top: 4px;">
          <button type="button" id="clivoraConfirmModalCancel" class="btn-anim-lift"
            style="flex: 1; padding: 11px 16px; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: var(--radius-md); border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-main); cursor: pointer;">
            ${escapeHtml(cancelLabel)}
          </button>
          <button type="button" id="clivoraConfirmModalAccept" class="btn-anim-lift"
            style="flex: 1; padding: 11px 16px; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: var(--radius-md); background: ${accentColor}; color: #FFFFFF; cursor: pointer; border: none; box-shadow: 0 4px 12px ${isWarning ? 'rgba(217, 119, 6, 0.25)' : 'rgba(239, 68, 68, 0.25)'};">
            ${escapeHtml(confirmLabel)}
          </button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';

    const settle = (result) => {
      modal.style.display = 'none';
      resolve(result);
    };
    modal.querySelector('#clivoraConfirmModalCancel').onclick = () => settle(false);
    modal.querySelector('#clivoraConfirmModalAccept').onclick = () => settle(true);
  });
}

// Único grupo autorizado a corregir "Creado el" en el historial médico (ver
// rol group_historial_create_date_edit) — window.clivoraCurrentUser
// se llena una vez por sesión con el payload completo de /clivora/api/me
// (ver loadCurrentUserProfile), así que esta bandera ya viene incluida ahí,
// sin necesidad de un fetch aparte.
function canEditHistorialCreateDate() {
  return !!(window.clivoraCurrentUser && window.clivoraCurrentUser.canEditHistorialCreateDate);
}

// "Anotaciones de Enfermería" de la cita: visibles para todos, editables solo
// para Enfermería (canEditAnotacionesEnfermeria en /api/me). Sin permiso, el
// editor queda de solo lectura y sin barra de herramientas.
function canEditCitaAnotaciones() {
  return !!(window.clivoraCurrentUser && window.clivoraCurrentUser.canEditAnotacionesEnfermeria);
}
function applyCitaAnotacionesPermission() {
  const editor = document.getElementById('citaAnotacionesEnfermeria');
  if (!editor) return;
  const canEdit = canEditCitaAnotaciones();
  editor.setAttribute('contenteditable', canEdit ? 'true' : 'false');
  editor.dataset.placeholder = canEdit ? 'Anotaciones de enfermería...' : 'Sin anotaciones de enfermería.';
  editor.title = canEdit ? '' : 'Solo Enfermería puede modificar las anotaciones';
  const toolbar = editor.previousElementSibling;
  if (toolbar && toolbar.classList.contains('rich-text-toolbar')) toolbar.style.display = canEdit ? '' : 'none';
  // "Esquema de tratamiento" de la cita: mismo permiso que las Anotaciones.
  const esquema = document.getElementById('citaEsquemaTratamiento');
  if (esquema) {
    esquema.readOnly = !canEdit;
    esquema.placeholder = canEdit ? 'Esquema de tratamiento...' : 'Sin esquema de tratamiento.';
    esquema.title = canEdit ? '' : 'Solo Enfermería puede modificar el esquema de tratamiento';
  }
}

// Modal para corregir "Creado el" de un registro del historial médico
// (Historia Clínica/Notas Clínicas) — mismo patrón que showClivoraConfirmModal,
// pero resuelve con el valor de <input type="datetime-local"> elegido (o
// null si se cancela) en vez de un booleano.
function showEditCreateDateModal(currentIso) {
  return new Promise((resolve) => {
    let modal = document.getElementById('clivoraEditCreateDateModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'clivoraEditCreateDateModal';
      modal.className = 'modal-overlay';
      // z-index 999000, NO 1000000 como los demás modales (showClivoraAlertModal/
      // showClivoraConfirmModal): el <input type="datetime-local"> de abajo lo
      // convierte automáticamente en el selector propio de la app
      // (enhanceCustomDatePicker, ver el MutationObserver clivoraDatePickerObserver
      // más abajo en este archivo), cuyo panel .custom-date-panel se "porta" a
      // <body> al abrirse con z-index:999999 !important — con este modal en
      // 1000000 esa portada quedaba SIEMPRE detrás del overlay (el bug
      // reportado). Este es el único modal de la app con un campo de fecha
      // adentro, por eso ningún otro lo sufría. 999000 sigue por encima de
      // cualquier tarjeta/página normal, y por debajo tanto del panel de
      // fecha (999999) como de un showClivoraAlertModal de error que se abra
      // encima (1000000).
      modal.style.cssText = 'display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px); z-index: 999000; align-items: center; justify-content: center; padding: 20px;';
      document.body.appendChild(modal);
    }
    const currentValue = currentIso ? String(currentIso).slice(0, 16) : '';
    modal.innerHTML = `
      <div style="max-width: 380px; width: 94%; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 28px 24px; box-shadow: 0 24px 48px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 16px;">
        <div>
          <h3 style="font-size: 16px; font-weight: 800; color: var(--text-main); margin: 0 0 6px 0; letter-spacing: -0.3px;">Editar fecha de creación</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin: 0; font-weight: 500;">Corrige el "Creado el" de este registro del historial médico.</p>
        </div>
        <input type="datetime-local" id="clivoraEditCreateDateInput" value="${escapeHtml(currentValue)}"
          style="width: 100%; padding: 9px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-main);">
        <div style="display: flex; gap: 10px;">
          <button type="button" id="clivoraEditCreateDateCancel" class="btn-anim-lift"
            style="flex: 1; padding: 11px 16px; font-size: 13px; font-weight: 700; border-radius: var(--radius-md); border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-main); cursor: pointer;">
            Cancelar
          </button>
          <button type="button" id="clivoraEditCreateDateAccept" class="btn-anim-lift"
            style="flex: 1; padding: 11px 16px; font-size: 13px; font-weight: 700; border-radius: var(--radius-md); background: var(--primary-blue); color: #FFFFFF; cursor: pointer; border: none;">
            Guardar
          </button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    const settle = (result) => {
      modal.style.display = 'none';
      resolve(result);
    };
    modal.querySelector('#clivoraEditCreateDateCancel').onclick = () => settle(null);
    modal.querySelector('#clivoraEditCreateDateAccept').onclick = () => {
      const val = modal.querySelector('#clivoraEditCreateDateInput').value;
      settle(val || null);
    };
  });
}

// Abre el modal de arriba y, si se confirma, guarda contra
// /clivora/api/historial/<model>/<id>/create_date (ver
// clivora_historial_create_date_update en el controlador). Devuelve el
// nuevo create_date (ISO, hora local — mismo formato que ya usan
// hc.createdAt/c.fecha) o null si se canceló o falló, para que quien la
// llame decida cómo refrescar su propia pantalla.
async function editHistorialCreateDate(model, recordId, currentIso) {
  const newLocal = await showEditCreateDateModal(currentIso);
  if (!newLocal) return null;
  try {
    const response = await fetch(`/clivora/api/historial/${model}/${recordId}/create_date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create_date: newLocal }),
    });
    if (response.status === 403) {
      showClivoraAlertModal('No tienes permiso para editar la fecha de creación de este registro.');
      return null;
    }
    if (!response.ok) {
      showClivoraAlertModal('No se pudo actualizar la fecha de creación.');
      return null;
    }
    const data = await response.json();
    return data.create_date;
  } catch (e) {
    showClivoraAlertModal('No se pudo actualizar la fecha de creación.');
    return null;
  }
}

// Botón de lápiz que buildCreatedUpdatedMetaHtml/updateHcAuditInfo inyectan
// junto a "Creado el ..." — un solo listener delegado porque ese botón se
// re-inyecta cada vez que se repinta la tarjeta/sección (innerHTML). Al
// guardar, en vez de ir a buscar cómo refrescar cada una de las ~10
// pantallas donde vive esta auditoría, se reconstruye en el momento la
// misma línea (con el "por <creador>" que ya tenía) directamente en el DOM.
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('.clivora-edit-create-date-btn');
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();
  const model = btn.dataset.model;
  const recordId = parseInt(btn.dataset.id, 10);
  if (!model || !recordId) return;
  const row = btn.closest('div');
  const createdBy = btn.dataset.createdBy || '';
  const newIso = await editHistorialCreateDate(model, recordId, null);
  if (!newIso || !row) return;
  const bits = [`el ${formatClivoraDateTime(newIso)}`, createdBy ? `por ${createdBy}` : ''].filter(Boolean);
  row.innerHTML = `| ${escapeHtml(`Creado ${bits.join(' ')}`)}${btn.outerHTML}`;
});

// Textarea "modular": crece o encoge según su contenido en vez de quedar
// fija con scrollbar — se limita entre minHeight y maxHeight (por encima de
// maxHeight vuelve a hacer scroll interno normal para no empujar el resto
// del modal fuera de la pantalla).
function autoResizeTextarea(el, minHeight = 70, maxHeight = 260) {
  if (!el) return;
  el.style.height = 'auto';
  const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

document.addEventListener('input', (event) => {
  if (event.target && event.target.id === 'citaNota') {
    autoResizeTextarea(event.target);
  }
});

// El atributo min="..." en un <input type="number"> solo bloquea las
// flechitas del spinner y marca el campo como inválido al enviar el
// formulario — no impide escribir "-" a mano. Ningún campo numérico de Clivora
// (signos vitales, somatometría, laboratorios, edades, años…) admite
// negativos, así que se aplica a todos: antes solo a los que traían min="0" o
// más, y Peso/Talla de Signos Vitales (svPeso/svAltura) y otros sin "min" se
// podían guardar en negativo. Solo se respeta un min negativo explícito.
function isNonNegativeNumberInput(target) {
  if (!target || target.tagName !== 'INPUT' || target.type !== 'number') return false;
  const min = parseFloat(target.min);
  return Number.isNaN(min) || min >= 0;
}
document.addEventListener('keydown', (event) => {
  if (event.key === '-' && isNonNegativeNumberInput(event.target)) event.preventDefault();
});
// Sin "min", las flechitas del spinner bajan de 0 a negativos.
document.addEventListener('focusin', (event) => {
  if (isNonNegativeNumberInput(event.target) && !event.target.hasAttribute('min')) {
    event.target.min = '0';
  }
});
// Texto pegado con Ctrl+V.
document.addEventListener('input', (event) => {
  const target = event.target;
  if (isNonNegativeNumberInput(target) && target.value.includes('-')) {
    target.value = target.value.replace(/-/g, '');
  }
});

// Restringe en tiempo real qué se puede escribir según data-charset —
// antes cada campo numérico necesitaba su propio listener con el id
// hardcodeado (ver newTelefono/newCelular, migrados a data-charset="numbers");
// ahora basta con el atributo para sumar cualquier campo nuevo sin tocar JS.
// Corre en 'input' (no keydown) para que también filtre texto pegado con
// Ctrl+V.
//   letters  — nombres, ciudades, ocupación, etc.
//   numbers  — teléfonos, códigos postales, cédulas (enteros, sin signo)
//   alnum    — calle, colonia, RFC, número de casa (letras+números+. - # °)
//   decimal  — peso/talla/temperatura en campos de texto libre (no
//              <input type="number">, que ya valida su propio decimal)
//   bp       — presión arterial "120/80" (dígitos + una sola diagonal)
const CLIVORA_CHARSET_PATTERNS = {
  letters: /[^a-zA-ZÀ-ÖØ-öø-ÿ\s]/g,
  numbers: /[^0-9]/g,
  alnum: /[^a-zA-ZÀ-ÖØ-öø-ÿ0-9\s.\-#°]/g,
  decimal: /[^0-9.]/g,
  bp: /[^0-9/]/g,
};
document.addEventListener('input', (event) => {
  const target = event.target;
  const pattern = target?.dataset && CLIVORA_CHARSET_PATTERNS[target.dataset.charset];
  if (!pattern) return;
  const cleaned = target.value.replace(pattern, '');
  if (target.value !== cleaned) target.value = cleaned;
});

function createPatientCard(patient) {
  const card = document.createElement('div');
  // "open-patient-detail" también está en la propia tarjeta (no solo en el
  // botón "Ver Paciente") para poder entrar al expediente haciendo clic en
  // cualquier parte del card — mismo listener delegado, mismos data-*
  // (id/name/exp) que ya trae el botón, así que closest() los reutiliza sin
  // ningún cambio en la lógica de apertura.
  card.className = 'patient-card open-patient-detail';
  card.dataset.id = patient.id || '';
  card.dataset.name = (patient.name || '').toUpperCase();
  card.dataset.exp = patient.exp || '00000';

  const initials = (patient.initials || (patient.name || '').split(' ').map(w => w[0]).slice(0, 2).join('')).toUpperCase() || 'XX';
  const patientName = (patient.name || '').toUpperCase();
  const patientExp = patient.exp || '00000';

  const altaDate = patient.createDate ? new Date(patient.createDate) : null;
  const alta = altaDate && !isNaN(altaDate) ? altaDate.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

  card.innerHTML = `
    <div class="patient-card-header">
      <span class="patient-id">#${escapeHtml(patientExp)}</span>
    </div>
    <div class="patient-card-body">
      <div class="patient-avatar">${escapeHtml(initials)}</div>
      <div class="patient-name-group">
        <h3 class="patient-name">${escapeHtml(patientName)}</h3>
        <span class="patient-email">${escapeHtml(patient.email || 'Sin correo')}</span>
      </div>
    </div>
    <dl class="patient-card-facts">
      <div><dt>Médico asignado</dt><dd>${escapeHtml(patient.doctorName || 'Sin asignar')}</dd></div>
      <div><dt>Alta</dt><dd>${escapeHtml(alta)}</dd></div>
    </dl>
    <div class="patient-card-footer">
      <button class="btn-view-patient open-patient-detail" data-id="${patient.id || ''}" data-name="${escapeHtml(patientName)}" data-exp="${escapeHtml(patientExp)}">Ver Paciente</button>
    </div>`;

  return card;
}

let clivoraPatientsCache = [];

// ── Buscador de pacientes (directorio de Pacientes y paciente de la cita) ──
// Antes solo encontraba el texto exacto ("jesus" no encontraba "Jesús",
// "lopez maria" no encontraba "María López"). Ahora: sin acentos ni
// mayúsculas, palabras en cualquier orden y a medio escribir, número de
// expediente, correo electrónico, y con errores de escritura (una letra de
// diferencia en palabras de 4-6 letras, dos en las de 7 o más, letras
// invertidas). Todo en el navegador sobre la lista que ya se carga
// (clivoraPatientsCache). El correo se parte en palabras por "@", "." y demás
// signos ("ana.lopez@gmail.com" → ana, lopez, gmail, com), así que se
// encuentra escribiéndolo completo, a medias o con errores.
function clivoraNormalizeSearch(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Distancia de edición (Damerau-Levenshtein restringida: cuenta una letra de
// más, de menos, distinta o dos letras invertidas como 1). Corta en cuanto
// supera "max" — solo importa saber si está dentro de la tolerancia.
function clivoraEditDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

// Qué tan bien coincide una palabra escrita con alguna palabra del nombre:
// 3 igual, 2 empieza igual (palabra a medio escribir), 1 parecida (error de
// escritura), 0 nada.
function clivoraWordMatchScore(queryWord, nameWords) {
  const tolerance = queryWord.length >= 7 ? 2 : (queryWord.length >= 4 ? 1 : 0);
  let best = 0;
  for (const word of nameWords) {
    if (word === queryWord) return 3;
    if (word.startsWith(queryWord)) { best = Math.max(best, 2); continue; }
    if (best < 1 && tolerance) {
      // Contra la palabra completa y contra su inicio del mismo largo (para
      // una palabra a medio escribir y además con error: "rodrg" → Rodríguez).
      const distance = Math.min(
        clivoraEditDistance(queryWord, word, tolerance),
        clivoraEditDistance(queryWord, word.slice(0, queryWord.length), tolerance),
      );
      if (distance <= tolerance) best = 1;
    }
  }
  return best;
}

// { exact, suggestions }: "exact" coincide sin errores de escritura (sin
// acentos, en cualquier orden, a medio escribir); "suggestions" solo con
// errores ("¿Quisiste decir…?"). Cada palabra escrita tiene que coincidir con
// alguna palabra del nombre o del correo, o con el expediente. Ordenados por
// qué tan bien coinciden.
function clivoraSearchPatients(patients, query) {
  const queryWords = clivoraNormalizeSearch(query).split(' ').filter(Boolean);
  if (!queryWords.length) return { exact: patients.slice(), suggestions: [] };
  const exact = [];
  const suggestions = [];
  patients.forEach(patient => {
    const searchKey = `${patient.name}|${patient.exp}|${patient.email || ''}`;
    if (patient._searchKey !== searchKey) {
      patient._searchKey = searchKey;
      // Palabras del nombre y del correo juntas: cada palabra escrita puede
      // coincidir con cualquiera de las dos.
      patient._searchName = clivoraNormalizeSearch(`${patient.name || ''} ${patient.email || ''}`).split(' ').filter(Boolean);
      patient._searchExp = clivoraNormalizeSearch(patient.exp);
    }
    let score = 0;
    let fuzzy = false;
    for (const word of queryWords) {
      let wordScore = clivoraWordMatchScore(word, patient._searchName);
      // Expediente: el exacto hasta arriba, luego los que lo contienen.
      if (patient._searchExp === word) wordScore = 5;
      else if (patient._searchExp && patient._searchExp.includes(word)) wordScore = Math.max(wordScore, 3);
      if (!wordScore) return;
      if (wordScore === 1) fuzzy = true;
      score += wordScore;
    }
    (fuzzy ? suggestions : exact).push({ patient, score });
  });
  const byScore = (a, b) => b.score - a.score || (a.patient.name || '').localeCompare(b.patient.name || '');
  return {
    exact: exact.sort(byScore).map(item => item.patient),
    suggestions: suggestions.sort(byScore).map(item => item.patient),
  };
}

// Filtro activo aplicado al listado de Pacientes cuando se llega ahí desde
// una tarjeta del Dashboard (ej. "En protocolo", "Consultas este mes") —
// antes esas tarjetas no hacían nada al hacer clic. null = sin filtro.
let clivoraPacientesActiveFilter = null; // { label, ids: Set<number> }

function applyPacientesFilter(label, ids) {
  clivoraPacientesActiveFilter = { label, ids: new Set(ids || []) };
  renderPatientsGrid();
  if (typeof switchView === 'function') switchView('pacientes');
}

function clearPacientesFilter() {
  clivoraPacientesActiveFilter = null;
  renderPatientsGrid();
}

function renderPatientsGrid() {
  const patientsGrid = document.getElementById('patientsGrid');
  const chip = document.getElementById('pacientesActiveFilterChip');
  const chipLabel = document.getElementById('pacientesActiveFilterLabel');
  if (chip) chip.style.display = clivoraPacientesActiveFilter ? 'flex' : 'none';
  if (chipLabel && clivoraPacientesActiveFilter) {
    chipLabel.textContent = `${clivoraPacientesActiveFilter.label} (${clivoraPacientesActiveFilter.ids.size})`;
  }
  if (!patientsGrid) return;
  const list = clivoraPacientesActiveFilter
    ? clivoraPatientsCache.filter(p => clivoraPacientesActiveFilter.ids.has(p.id))
    : clivoraPatientsCache;
  // Buscador (ver clivoraSearchPatients): primero los que coinciden sin errores
  // de escritura y después, aparte, los parecidos ("¿Quisiste decir…?").
  const query = document.getElementById('patientSearchInput')?.value || '';
  const { exact, suggestions } = clivoraSearchPatients(list, query);
  patientsGrid.innerHTML = '';
  if (!exact.length && !suggestions.length) {
    if (query.trim() || clivoraPacientesActiveFilter || cotizaFilter) {
      const message = document.createElement('p');
      message.style.cssText = 'color: var(--text-muted); font-size: 13px; grid-column: 1 / -1;';
      message.textContent = query.trim()
        ? `Ningún paciente coincide con "${query.trim()}".`
        : 'Ningún paciente coincide con este filtro.';
      patientsGrid.appendChild(message);
    }
    return;
  }
  exact.forEach(patient => {
    patientsGrid.appendChild(createPatientCard(patient));
  });
  if (suggestions.length) {
    const heading = document.createElement('div');
    heading.className = 'patient-search-suggestions-title';
    heading.textContent = exact.length ? 'Nombres parecidos' : '¿Quisiste decir…?';
    patientsGrid.appendChild(heading);
    suggestions.slice(0, 30).forEach(patient => {
      patientsGrid.appendChild(createPatientCard(patient));
    });
  }
}

// Escribir en el buscador vuelve a armar el listado (con una pequeña espera
// para no recalcularlo en cada tecla al escribir rápido).
let clivoraPatientSearchTimer = null;
document.addEventListener('input', (event) => {
  if (event.target.id !== 'patientSearchInput') return;
  clearTimeout(clivoraPatientSearchTimer);
  clivoraPatientSearchTimer = setTimeout(renderPatientsGrid, 120);
});

document.addEventListener('click', (event) => {
  if (event.target.closest('#pacientesActiveFilterClear')) clearPacientesFilter();
});

document.addEventListener('change', (event) => {
});

async function loadPatientsList() {
  try {
    const response = await fetch('/clivora/api/patients');
    if (!response.ok) {
      console.error('No se pudo cargar la lista de pacientes');
      return;
    }
    const patients = await response.json();
    clivoraPatientsCache = patients;
    renderPatientsGrid();

    if (typeof updateDashboardMetrics === 'function') updateDashboardMetrics();
  } catch (error) {
    console.error('Error al cargar pacientes:', error);
  }
}

function getNextPatientExp() {
  const maxExp = clivoraPatientsCache.reduce((max, patient) => {
    const current = Number.parseInt(patient.exp || '0', 10);
    return Number.isFinite(current) && current > max ? current : max;
  }, 0);
  return String(maxExp + 1).padStart(5, '0');
}

let clivoraDoctorsCatalog = null;

async function ensureDoctorsCatalog() {
  if (clivoraDoctorsCatalog) return clivoraDoctorsCatalog;
  try {
    const response = await fetch('/clivora/api/doctors', { cache: 'no-store' });
    clivoraDoctorsCatalog = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar médicos:', error);
    clivoraDoctorsCatalog = [];
  }
  return clivoraDoctorsCatalog;
}

// Antes esta función llenaba el <select> con una lista fija de ~100
// médicos hardcodeados en el código (agrupados por "Interno"/"Externo" y
// filtrados por una "especialidad" que no existía). Ahora lee los
// doctores reales (/clivora/api/doctors). specialtyId
// (opcional, 3er argumento): filtra a solo los doctores de esa especialidad
// real (catálogo de especialidades) — usado por "Cita con" en Nuevo Paciente
// (ver updateDoctorSelect). referralKind (opcional, 2do argumento:
// 'external' | 'internal'): filtra a solo los doctores marcados
// is_external_referral_doctor / is_internal_referral_doctor (ver
// res_partner.py) — usado por los selectores "Médico Externo/Interno de
// Referencia" del alta de paciente, así Clivora solo ve ahí a los doctores que
// realmente cobran el bono por referir pacientes, no a todo el personal
// clínico. "Médico Referenciador"/"San José" no mandan este argumento y
// siguen mostrando todos los doctores, igual que antes.
async function populateDoctorSelectOptions(selectEl, referralKind, specialtyId) {
  if (!selectEl) return;
  const currentVal = selectEl.value;
  const allDoctors = await ensureDoctorsCatalog();
  let doctors = allDoctors;
  if (referralKind === 'external') {
    doctors = doctors.filter(doctor => doctor.isExternalReferral);
  } else if (referralKind === 'internal') {
    doctors = doctors.filter(doctor => doctor.isInternalReferral);
  }
  if (specialtyId) {
    doctors = doctors.filter(doctor => String(doctor.specialtyId) === String(specialtyId));
  }
  selectEl.innerHTML = '<option value="">Seleccionar médico</option>';
  doctors.forEach(doctor => {
    const option = document.createElement('option');
    option.value = doctor.name;
    option.textContent = doctor.name;
    selectEl.appendChild(option);
  });
  if (currentVal) selectEl.value = currentVal;
}

let clivoraDoctorSpecialtiesCatalog = null;

async function ensureDoctorSpecialtiesCatalog() {
  if (clivoraDoctorSpecialtiesCatalog) return clivoraDoctorSpecialtiesCatalog;
  try {
    const response = await fetch('/clivora/api/doctor_specialties', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clivoraDoctorSpecialtiesCatalog = await response.json();
  } catch (error) {
    console.error('Error al cargar especialidades médicas:', error);
    return [];
  }
  return clivoraDoctorSpecialtiesCatalog;
}

async function populateEspecialidadSelectOptions(selectEl) {
  if (!selectEl) return;
  const currentVal = selectEl.value;
  const specialties = await ensureDoctorSpecialtiesCatalog();
  selectEl.innerHTML = '<option value="">Seleccionar especialidad</option>';
  specialties.forEach(specialty => {
    const option = document.createElement('option');
    option.value = String(specialty.id);
    option.textContent = specialty.name;
    selectEl.appendChild(option);
  });
  if (currentVal) selectEl.value = currentVal;
}

let clivoraPatientsCatalog = null;

async function ensurePatientsCatalog() {
  if (clivoraPatientsCatalog) return clivoraPatientsCatalog;
  try {
    const response = await fetch('/clivora/api/patients', { cache: 'no-store' });
    clivoraPatientsCatalog = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar pacientes:', error);
    clivoraPatientsCatalog = [];
  }
  return clivoraPatientsCatalog;
}

let clivoraCitasCatalogsCache = null;

async function ensureCitasCatalogs() {
  if (clivoraCitasCatalogsCache) return clivoraCitasCatalogsCache;
  try {
    const response = await fetch('/clivora/api/citas/catalogs', { cache: 'no-store' });
    clivoraCitasCatalogsCache = response.ok ? await response.json() : { types: [], reasons: [], doctors: [], nurses: [], rejectionReasons: [], specialties: [], lugares: [] };
  } catch (error) {
    console.error('Error al cargar catálogos de citas:', error);
    clivoraCitasCatalogsCache = { types: [], reasons: [], doctors: [], nurses: [], rejectionReasons: [], specialties: [], lugares: [] };
  }
  // Lugares y salas de la clínica activa (Configuración → Lugares y salas);
  // antes eran constantes en este archivo (Penthouse 2/3, Piso 15…).
  CLIVORA_LUGARES = clivoraCitasCatalogsCache.lugares || [];
  document.dispatchEvent(new CustomEvent('clivora:lugares'));
  return clivoraCitasCatalogsCache;
}

// specialtyId (opcional): filtra la lista a solo los doctores con esa
// especialidad (catálogo de especialidades) —
// antes "Cita con (Especialidad)" era puramente decorativo, nunca se usaba
// para acotar el <select> de Doctor, porque la especialidad del doctor era
// texto libre sin catálogo real contra el cual filtrar de forma confiable.
// "Cita con (Especialidad)" está oculto en el modal de la cita: Doctor lista
// a todos los doctores y no se bloquea sin especialidad. Para volver a
// filtrar por especialidad, poner true y quitar el display:none de
// #citaEspecialidadField en index.html.
const CLIVORA_CITA_FILTRA_POR_ESPECIALIDAD = false;

async function populateCitaDoctorSelect(selectEl, selectedId, specialtyId, requireSpecialty = false) {
  if (!selectEl) return;
  if (selectEl.id === 'citaDoctor' && !CLIVORA_CITA_FILTRA_POR_ESPECIALIDAD) {
    specialtyId = '';
    requireSpecialty = false;
  }
  const catalogs = await ensureCitasCatalogs();
  // requireSpecialty (modal de cita): sin especialidad, Doctor queda
  // bloqueado y sin opciones — antes mostraba a todos los doctores y dejaba
  // agendar sin especialidad. Única excepción:
  // una cita ya existente cuyo doctor no tiene especialidad en su ficha
  // conserva ese doctor (bloqueado) para no borrarlo al guardar.
  let doctors;
  if (specialtyId) {
    doctors = catalogs.doctors.filter(doctor => String(doctor.specialtyId) === String(specialtyId));
  } else if (!requireSpecialty) {
    doctors = catalogs.doctors;
  } else {
    doctors = selectedId
      ? catalogs.doctors.filter(doctor => String(doctor.id) === String(selectedId))
      : [];
  }
  if (requireSpecialty) selectEl.disabled = !specialtyId;
  const specialtyNames = new Map((catalogs.specialties || []).map(s => [String(s.id), s.name]));
  selectEl.innerHTML = '<option value="">Seleccionar doctor...</option>';
  doctors.forEach(doctor => {
    const option = document.createElement('option');
    option.value = String(doctor.id);
    option.textContent = doctor.name;
    // Especialidad a la derecha en el buscador de la agenda (ver
    // attachCitaSelectSearch), en lugar del id.
    option.dataset.badge = specialtyNames.get(String(doctor.specialtyId)) || '';
    selectEl.appendChild(option);
  });
  // Si el doctor seleccionado no queda entre los filtrados por la nueva
  // especialidad (p.ej. el usuario cambió de especialidad después de haber
  // elegido un doctor), no tiene caso dejarlo forzado en un <option> que ya
  // no existe — se limpia para que el usuario elija uno de los visibles.
  const stillValid = !selectedId || doctors.some(doctor => String(doctor.id) === String(selectedId));
  if (selectedId && stillValid) {
    selectEl.value = String(selectedId);
  }
  // Asignar .value por JS no dispara 'change' — el widget de select
  // personalizado (enhanceCustomSelect) solo refresca el texto visible del
  // trigger cuando escucha ese evento en el <select> real.
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}

async function populateCitaEspecialidadSelect(selectEl, selectedId) {
  if (!selectEl) return;
  const catalogs = await ensureCitasCatalogs();
  selectEl.innerHTML = '<option value="">Seleccionar especialidad...</option>';
  (catalogs.specialties || []).forEach(specialty => {
    const option = document.createElement('option');
    option.value = String(specialty.id);
    option.textContent = specialty.name;
    selectEl.appendChild(option);
  });
  if (selectedId) selectEl.value = String(selectedId);
}

// Buscador tipo "Buscar paciente" para Doctor y Enfermera del modal de la
// cita: un <input> con lista desplegable sobre el <select> real (oculto), que
// sigue siendo la fuente del valor — todo el resto del código (filtro por
// especialidad, guardar, bloquear en solo lectura) sigue usando el <select>.
// Al elegir se asigna su value y se dispara 'change'; si el <select> cambia
// de opciones, de valor o se (des)habilita, el input se sincroniza solo. A la
// derecha de cada nombre va option.dataset.badge (la especialidad del doctor).
function attachCitaSelectSearch(selectEl, placeholder) {
  if (!selectEl || selectEl.dataset.searchAttached) return;
  selectEl.dataset.searchAttached = '1';
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.innerHTML = `
    <input type="text" class="search-input full-width cita-select-search-input" autocomplete="off" placeholder="${placeholder}"
      style="width: 100%; height: 38px; font-size: 13px; padding-right: 32px;">
    <button type="button" class="clear-search-btn btn-anim-lift" style="display: none;" title="Quitar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
    <div class="cita-patient-dropdown" style="display: none;"></div>`;
  selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);
  const input = wrapper.querySelector('input');
  const clearBtn = wrapper.querySelector('.clear-search-btn');
  const dropdown = wrapper.querySelector('.cita-patient-dropdown');
  const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const options = () => Array.from(selectEl.options).filter(o => o.value);

  function syncFromSelect() {
    const opt = selectEl.options[selectEl.selectedIndex];
    input.value = opt && opt.value ? opt.textContent : '';
    input.disabled = selectEl.disabled;
    input.placeholder = selectEl.disabled && !options().length
      ? 'Seleccione primero una especialidad'
      : placeholder;
    clearBtn.style.display = selectEl.value && !selectEl.disabled ? 'flex' : 'none';
  }

  function render(filterText) {
    const q = norm(filterText);
    const matches = options().filter(o => !q || norm(o.textContent).includes(q) || norm(o.dataset.badge).includes(q));
    dropdown.innerHTML = '';
    if (!matches.length) {
      dropdown.innerHTML = '<div style="padding: 10px; font-size: 12px; color: var(--text-muted); text-align: center;">Sin resultados</div>';
    }
    matches.forEach(o => {
      const item = document.createElement('div');
      item.className = 'cita-patient-item';
      const name = document.createElement('span');
      name.textContent = o.textContent;
      item.appendChild(name);
      if (o.dataset.badge) {
        const badge = document.createElement('span');
        badge.className = 'patient-exp-badge';
        badge.textContent = o.dataset.badge;
        item.appendChild(badge);
      }
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        selectEl.value = o.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        dropdown.style.display = 'none';
        syncFromSelect();
      });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  }

  input.addEventListener('focus', () => { if (!input.disabled) render(''); });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; syncFromSelect(); }, 150);
  });
  clearBtn.addEventListener('click', () => {
    selectEl.value = '';
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    syncFromSelect();
    input.focus();
  });
  selectEl.addEventListener('change', syncFromSelect);
  new MutationObserver(syncFromSelect).observe(selectEl, { childList: true, attributes: true, attributeFilter: ['disabled'] });
  syncFromSelect();
}

// Enfermera asignada a la cita — a diferencia de Doctor, no se filtra por
// especialidad (las enfermeras no tienen ese campo).
async function populateCitaEnfermeraSelect(selectEl, selectedId) {
  if (!selectEl) return;
  const catalogs = await ensureCitasCatalogs();
  selectEl.innerHTML = '<option value="">Seleccionar enfermera...</option>';
  (catalogs.nurses || []).forEach(nurse => {
    const option = document.createElement('option');
    option.value = String(nurse.id);
    option.textContent = nurse.name;
    selectEl.appendChild(option);
  });
  if (selectedId) selectEl.value = String(selectedId);
  // Asignar .value por JS no dispara 'change' — el widget de select
  // personalizado (enhanceCustomSelect) solo refresca el texto visible del
  // trigger cuando escucha ese evento en el <select> real.
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}

// Al cambiar la especialidad en el modal de Agendar/Editar Cita, el <select>
// de Doctor se reduce a solo los doctores de esa especialidad (ver
// populateCitaDoctorSelect) — antes ese cambio no tenía ningún efecto sobre
// la lista de doctores.
document.addEventListener('change', (event) => {
  if (event.target && event.target.id === 'citaConEspecialidad') {
    const doctorSelect = document.getElementById('citaDoctor');
    if (doctorSelect) {
      // Si se limpia la especialidad, el doctor también se limpia.
      const keepDoctor = event.target.value ? doctorSelect.value : '';
      populateCitaDoctorSelect(doctorSelect, keepDoctor, event.target.value, true);
    }
  }
});

// Precarga Especialidad + Doctor del modal de cita. La cita no guarda
// especialidad propia, así que al editar se toma la del doctor asignado —
// sin esto Especialidad quedaba vacía y (ahora) Doctor bloqueado. Doctor se
// llena primero (await) y luego se dispara 'change' en Especialidad, igual
// que en la precarga por paciente, para no competir con el listener global.
async function populateCitaEspecialidadAndDoctor(especialidadSelect, doctorSelect, doctorId, specialtyId) {
  const catalogs = await ensureCitasCatalogs();
  if (!specialtyId && doctorId) {
    const doctor = catalogs.doctors.find(d => String(d.id) === String(doctorId));
    specialtyId = doctor && doctor.specialtyId ? doctor.specialtyId : '';
  }
  if (especialidadSelect) await populateCitaEspecialidadSelect(especialidadSelect, specialtyId);
  if (doctorSelect) await populateCitaDoctorSelect(doctorSelect, doctorId || '', specialtyId || '', true);
  if (especialidadSelect) especialidadSelect.dispatchEvent(new Event('change', { bubbles: true }));
}

// Origen de Referencia → <select> de médico de referencia que le toca (prefix
// 'new' = alta de paciente, 'detail' = ficha). Solo se manda el del origen
// elegido: los demás quedan ocultos pero pueden conservar un valor viejo.
// Se guarda como médico de referencia, separado del médico asignado
// ("Médico / Doctor asignado").
const CLIVORA_REFERRAL_DOCTOR_SELECT_SUFFIX = {
  'Médico Externo': 'MedicoExterno',
  'Médico Interno': 'MedicoInterno',
  'Médico Referenciador': 'MedicoReferenciador',
  'San José Valle Real': 'MedicoSanJose',
};

function getReferralDoctorSelect(prefix, origen) {
  const suffix = CLIVORA_REFERRAL_DOCTOR_SELECT_SUFFIX[origen];
  return suffix ? document.getElementById(prefix + suffix) : null;
}

// Grupo "Comercial" (rol group_comercial, ver /clivora/api/me
// canSkipRequiredFields) — se consulta una sola vez por sesión y en cuanto
// se resuelve, si aplica, se quita el atributo required de los campos del
// formulario "Nuevo Paciente" para que ni el Enter del teclado dispare la
// validación nativa del navegador (handleNewPatientSubmit hace el mismo
// chequeo del lado del cliente, pero eso solo cubre el botón Guardar).
let clivoraCanSkipPatientRequiredFields = false;
const CLIVORA_NEW_PATIENT_REQUIRED_IDS = [
  'newPrimerApellido', 'newNombres', 'newOrigenReferencia',
  'newFechaNacimiento', 'newGenero', 'newTerminosCondiciones',
  'newEmail', 'newCelular',
];

async function applyComercialGroupToNewPatientForm() {
  try {
    const response = await fetch('/clivora/api/me', { cache: 'no-store' });
    const data = response.ok ? await response.json() : null;
    clivoraCanSkipPatientRequiredFields = !!(data && data.canSkipRequiredFields);
  } catch (error) {
    console.error('Error al verificar permisos del grupo Comercial:', error);
    clivoraCanSkipPatientRequiredFields = false;
  }
  if (clivoraCanSkipPatientRequiredFields) {
    CLIVORA_NEW_PATIENT_REQUIRED_IDS.forEach(id => {
      document.getElementById(id)?.removeAttribute('required');
    });
  }
}

function initializeNewPatientModule() {
  const form = document.getElementById('newPatientForm');
  if (!form) return;

  applyComercialGroupToNewPatientForm();

  const patientExpInput = document.getElementById('newPatientExp');
  const origenReferencia = document.getElementById('newOrigenReferencia');
  const medicoExternoGroup = document.getElementById('newMedicoExternoGroup');
  const medicoInternoGroup = document.getElementById('newMedicoInternoGroup');
  const medicoReferenciadorGroup = document.getElementById('newMedicoReferenciadorGroup');
  const medicoSanJoseGroup = document.getElementById('newMedicoSanJoseGroup');
  const medicoExternoSelect = document.getElementById('newMedicoExterno');
  const medicoInternoSelect = document.getElementById('newMedicoInterno');
  const medicoReferenciadorSelect = document.getElementById('newMedicoReferenciador');
  const medicoSanJoseSelect = document.getElementById('newMedicoSanJose');
  const citaConSelect = document.getElementById('newCitaCon');
  const doctorSelect = document.getElementById('newDoctor');
  const fechaNacimientoInput = document.getElementById('newFechaNacimiento');
  const tutorLegalGroup = document.getElementById('newTutorLegalGroup');

  // "Cita con" (especialidad) ahora es un catálogo real
  // (catálogo de especialidades) — "Doctor"
  // sí se filtra por la especialidad elegida.
  if (citaConSelect) populateEspecialidadSelectOptions(citaConSelect);
  // Sin especialidad elegida, Doctor queda vacío y bloqueado — antes se
  // habilitaba con TODOS los doctores y se podía guardar un doctor sin
  // especialidad.
  const updateDoctorSelect = async (specialtyId) => {
    if (!doctorSelect) return;
    if (!specialtyId) {
      doctorSelect.innerHTML = '<option value="">Seleccionar doctor</option>';
      doctorSelect.value = '';
      doctorSelect.disabled = true;
    } else {
      await populateDoctorSelectOptions(doctorSelect, null, specialtyId);
      doctorSelect.disabled = false;
    }
    doctorSelect.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (medicoExternoSelect) populateDoctorSelectOptions(medicoExternoSelect, 'external');
  if (medicoInternoSelect) populateDoctorSelectOptions(medicoInternoSelect, 'internal');
  if (medicoReferenciadorSelect) populateDoctorSelectOptions(medicoReferenciadorSelect);
  if (medicoSanJoseSelect) populateDoctorSelectOptions(medicoSanJoseSelect);
  populatePricelistSelectOptions(document.getElementById('newListaPrecios'), null);
  populateFiscalRegimeSelectOptions(document.getElementById('newRegimenFiscal'), null);

  const updateReferenceFields = () => {
    const value = origenReferencia?.value || '';
    if (medicoExternoGroup) medicoExternoGroup.classList.toggle('hidden', value !== 'Médico Externo');
    if (medicoInternoGroup) medicoInternoGroup.classList.toggle('hidden', value !== 'Médico Interno');
    if (medicoReferenciadorGroup) medicoReferenciadorGroup.classList.toggle('hidden', value !== 'Médico Referenciador');
    if (medicoSanJoseGroup) medicoSanJoseGroup.classList.toggle('hidden', value !== 'San José Valle Real');
  };

  if (origenReferencia) {
    origenReferencia.addEventListener('change', updateReferenceFields);
    updateReferenceFields();
  }

  // Tutor legal solo aplica a menores de edad — se mantiene oculto hasta
  // que se capture la fecha de nacimiento, y solo se muestra si la edad
  // calculada confirma que el paciente es menor de edad.
  const updateTutorLegalVisibility = () => {
    if (!tutorLegalGroup) return;
    const fechaVal = fechaNacimientoInput?.value || '';
    if (!fechaVal) {
      tutorLegalGroup.classList.add('hidden');
      return;
    }
    const ageStr = calculateAge(fechaVal);
    const age = parseInt(ageStr, 10);
    const isMinor = ageStr !== '' && !Number.isNaN(age) && age < 18;
    tutorLegalGroup.classList.toggle('hidden', !isMinor);
    if (!isMinor) {
      const tutorLegalInput = document.getElementById('newTutorLegal');
      if (tutorLegalInput) tutorLegalInput.value = '';
    }
  };

  if (fechaNacimientoInput) {
    fechaNacimientoInput.addEventListener('change', updateTutorLegalVisibility);
    updateTutorLegalVisibility();
  }

  if (citaConSelect) {
    citaConSelect.addEventListener('change', () => updateDoctorSelect(citaConSelect.value));
    updateDoctorSelect(citaConSelect.value);
  }

  // Los selects de médico (interno/externo/referenciador/San José) guardan
  // "Nombre (Dr. Interno)" — se quita el sufijo para intentar hacer match
  // contra el nombre real del doctor.
  const stripDoctorSuffix = (val) => (val || '').replace(/\s*\(Dr\.\s*(Interno|Externo)\)\s*$/i, '').trim();

  const buildPatientObject = () => {
    const firstName = document.getElementById('newPrimerApellido')?.value.trim() || '';
    const secondName = document.getElementById('newSegundoApellido')?.value.trim() || '';
    const names = document.getElementById('newNombres')?.value.trim() || '';
    return {
      primerApellido: firstName,
      segundoApellido: secondName,
      nombres: names,
      name: [firstName, secondName, names].filter(Boolean).join(' '),
      origenReferencia: origenReferencia?.value || '',
      fechaNacimiento: document.getElementById('newFechaNacimiento')?.value || '',
      religion: document.getElementById('newReligion')?.value.trim() || '',
      ocupacion: document.getElementById('newOcupacion')?.value.trim() || '',
      curp: document.getElementById('newCurp')?.value.trim().toUpperCase() || '',
      genero: document.getElementById('newGenero')?.value || '',
      medicoReferencia: stripDoctorSuffix(getReferralDoctorSelect('new', origenReferencia?.value)?.value),
      tutorLegal: document.getElementById('newTutorLegal')?.value.trim() || '',
      email: document.getElementById('newEmail')?.value.trim() || '',
      telefono: document.getElementById('newTelefono')?.value.trim() || '',
      celular: document.getElementById('newCelular')?.value.trim() || '',
      listaPreciosId: document.getElementById('newListaPrecios')?.value || false,
      estadoCivil: document.getElementById('newEstadoCivil')?.value || '',
      doctor: stripDoctorSuffix(doctorSelect?.value),
      pais: document.getElementById('newPais')?.value.trim() || '',
      estado: document.getElementById('newEstado')?.value.trim() || '',
      ciudad: document.getElementById('newCiudad')?.value.trim() || '',
      colonia: document.getElementById('newColonia')?.value.trim() || '',
      codigoPostal: document.getElementById('newCodigoPostal')?.value.trim() || '',
      calle: document.getElementById('newCalle')?.value.trim() || '',
      numeroCasa: document.getElementById('newNumeroCasa')?.value.trim() || '',
      rfc: document.getElementById('newRFC')?.value.trim() || '',
      regimenFiscal: document.getElementById('newRegimenFiscal')?.value || '',
      terminosCondiciones: document.getElementById('newTerminosCondiciones')?.checked || false
    };
  };

  const resetNewPatientForm = () => {
    form.reset();
    // form.reset() sí limpia el .value real de cada <select> (vuelve a la
    // opción "Seleccionar..." vacía), pero NO dispara 'change' — el widget
    // de select personalizado (enhanceCustomSelect) solo refresca el texto
    // visible de su trigger cuando escucha ese evento en el <select> real,
    // así que sin esto el <select> ya quedaba en "" pero el trigger seguía
    // mostrando la última opción elegida (ej. "Casado") como si aún
    // estuviera seleccionada — Estado civil, Cita con, Régimen Fiscal y
    // Origen de referencia son justo los <select> de este formulario.
    form.querySelectorAll('select').forEach(sel => {
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (patientExpInput) patientExpInput.value = getNextPatientExp();
    updateReferenceFields();
    if (citaConSelect) updateDoctorSelect(citaConSelect.value);
  };

  resetNewPatientForm();

  document.addEventListener('click', (event) => {
    const openBtn = event.target.closest('#openNuevoPacienteView');
    if (openBtn) {
      // Sin este reset, el formulario se quedaba con los datos del último
      // paciente creado/capturado (Estado civil, Cita con, Régimen Fiscal,
      // Origen de referencia y demás campos) cada vez que se abría "Nuevo
      // Paciente" por esta vía (el botón/enlace normal de la barra
      // lateral) — solo se limpiaba si se había pasado antes por Cancelar
      // o por el modal de éxito al guardar, no en este punto de entrada.
      resetNewPatientForm();
      // Re-consulta el grupo Comercial cada vez que se abre el formulario en
      // vez de confiar solo en el chequeo de arranque: si al usuario lo
      // agregaron al grupo con la pestaña ya abierta, antes se necesitaba
      // recargar toda la página para que el permiso surtiera efecto aquí.
      applyComercialGroupToNewPatientForm();
      switchView('nuevoPaciente');
      return;
    }

    const cancelBtn = event.target.closest('#cancelNewPatientBtn');
    if (cancelBtn) {
      resetNewPatientForm();
      switchView('pacientes');
      return;
    }
  });


  function showPatientCreatedSuccessModal(patient) {
    const overlay = document.getElementById('patientCreatedModalOverlay');
    if (!overlay) {
      resetNewPatientForm();
      switchView('pacientes');
      return;
    }

    const nameEl = document.getElementById('successPatientName');
    const subEl = document.getElementById('successPatientSub');
    const expEl = document.getElementById('successPatientExp');

    if (nameEl) nameEl.textContent = patient.name || 'Nuevo Paciente';
    if (subEl) {
      subEl.textContent = patient.doctor ? `Doctor: ${patient.doctor}` : (patient.citaCon ? `Especialidad: ${patient.citaCon}` : 'Paciente registrado correctamente');
    }
    if (expEl) expEl.textContent = `#${patient.exp || '00000'}`;

    overlay.style.display = 'flex';
    overlay.classList.add('open');

    const btnAddAnother = document.getElementById('btnAddAnotherPatient');
    const btnViewCurrent = document.getElementById('btnViewCurrentPatient');
    const btnGoToList = document.getElementById('btnGoToPatientsList');

    if (btnAddAnother) {
      btnAddAnother.onclick = () => {
        overlay.classList.remove('open');
        overlay.style.display = 'none';
        resetNewPatientForm();
        applyComercialGroupToNewPatientForm();
        switchView('nuevoPaciente');
      };
    }

    if (btnViewCurrent) {
      btnViewCurrent.onclick = () => {
        overlay.classList.remove('open');
        overlay.style.display = 'none';

        const detailNameEl = document.getElementById('detailPatientName');
        const detailExpEl = document.getElementById('detailPatientExp');
        if (detailNameEl) detailNameEl.textContent = patient.name;
        if (detailExpEl) detailExpEl.textContent = 'Expediente: ' + patient.exp;

        window.clivoraCurrentPatientId = patient.id;
        loadPatientDetail(patient.id);
        loadPatientFiles(patient.id);
        loadPatientChemotherapy(patient.id);
        loadPatientQuestionnaire(patient.id);
        loadPatientInsurance(patient.id);
        loadPatientLabOrders(patient.id);
        loadPatientConsultas(patient.id);
        loadPatientRecipes(patient.id);
        loadPatientShares(patient.id);

        resetNewPatientForm();
        switchView('pacienteDetail');
      };
    }

    if (btnGoToList) {
      btnGoToList.onclick = () => {
        overlay.classList.remove('open');
        overlay.style.display = 'none';
        resetNewPatientForm();
        switchView('pacientes');
      };
    }
  }

  // Variante de showClivoraAlertModal con lista de campos — cuando faltan
  // campos obligatorios al guardar un paciente nuevo conviene enumerarlos
  // en vez de un solo mensaje de texto corrido.
  // Advertencia de posible paciente duplicado (nombre similar por
  // difflib, o mismo teléfono/celular/fecha de nacimiento — ver
  // /clivora/api/patients/check_similar). A diferencia de
  // showPatientValidationWarningModal, esta SÍ deja continuar: es una
  // sugerencia para que el usuario revise antes de guardar, no un bloqueo.
  function showDuplicatePatientWarningModal(candidates, onConfirm) {
    let modal = document.getElementById('modalDuplicatePatientWarning');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modalDuplicatePatientWarning';
      modal.className = 'modal-overlay';
      modal.style.cssText = 'display: flex; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px); z-index: 10800; align-items: center; justify-content: center; padding: 20px;';
      document.body.appendChild(modal);
    }

    const listHtml = candidates.map(c => `
      <li style="font-size: 13px; color: var(--text-main); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 10px 12px; text-align: left;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <strong>${c.name}</strong>
          <span style="font-size: 11px; font-weight: 700; color: var(--primary-blue); background: var(--primary-blue-light); padding: 2px 8px; border-radius: var(--radius-sm); flex-shrink: 0;">Exp #${c.exp || 'N/A'}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${c.reasons.join(' · ')}</div>
      </li>`).join('');

    modal.innerHTML = `
      <div style="max-width: 460px; width: 94%; max-height: calc(100vh - 40px); overflow-y: auto; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 28px 24px; box-shadow: 0 24px 48px rgba(0,0,0,0.3); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px; box-sizing: border-box;">
        <div style="width: 60px; height: 60px; border-radius: 50%; background: #FEF3C7; border: 2px solid #F59E0B; color: #D97706; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 20px rgba(245, 158, 11, 0.22); flex-shrink: 0;">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>

        <div>
          <h3 style="font-size: 18px; font-weight: 800; color: var(--text-main); margin: 0 0 6px 0; letter-spacing: -0.3px;">Posible Paciente Duplicado</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin: 0; font-weight: 500; line-height: 1.4;">Encontramos ${candidates.length === 1 ? 'un paciente parecido' : 'pacientes parecidos'} ya registrado${candidates.length === 1 ? '' : 's'}. Revisa antes de continuar:</p>
        </div>

        <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; width: 100%; max-height: 260px; overflow-y: auto;">${listHtml}</ul>

        <!-- position:sticky al fondo del propio card (que ahora scrollea
             internamente, ver max-height arriba): con varios pacientes
             parecidos (5+, ej. varios registros de prueba con el mismo
             RFC) la lista sola ya puede ocupar toda la pantalla — sin esto,
             había que adivinar que hacía falta scrollear para encontrar
             "Guardar de todos modos". -->
        <div style="display: flex; flex-direction: column; gap: 10px; width: 100%; margin: 4px -24px -28px; padding: 10px 24px 28px; position: sticky; bottom: -28px; background: var(--bg-main); flex-shrink: 0;">
          <button type="button" id="btnCancelDuplicatePatient" class="btn-anim-lift" style="width: 100%; padding: 11px 16px; font-size: 13px; font-weight: 700; border-radius: var(--radius-md); border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-main); cursor: pointer;">
            Cancelar y revisar
          </button>
          <button type="button" id="btnConfirmDuplicatePatient" class="btn-anim-lift" style="width: 100%; padding: 11px 16px; font-size: 13px; font-weight: 700; border-radius: var(--radius-md); background: #D97706; color: #FFFFFF; cursor: pointer; border: none; box-shadow: 0 4px 12px rgba(217, 119, 6, 0.25);">
            Guardar de todos modos
          </button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';

    document.getElementById('btnCancelDuplicatePatient').onclick = () => {
      modal.style.display = 'none';
    };
    document.getElementById('btnConfirmDuplicatePatient').onclick = () => {
      modal.style.display = 'none';
      onConfirm();
    };
  }

  function showPatientValidationWarningModal(title, message, fieldList = []) {
    let modal = document.getElementById('modalPatientValidationWarning');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modalPatientValidationWarning';
      modal.className = 'modal-overlay';
      modal.style.cssText = 'display: flex; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px); z-index: 10800; align-items: center; justify-content: center; padding: 20px;';
      document.body.appendChild(modal);
    }

    const listHtml = fieldList.length
      ? `<ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; width: 100%; text-align: left;">${fieldList.map(f => `<li style="font-size: 13px; font-weight: 600; color: var(--text-main); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 8px 12px;">${f}</li>`).join('')}</ul>`
      : '';

    modal.innerHTML = `
      <div style="max-width: 460px; width: 94%; max-height: calc(100vh - 40px); overflow-y: auto; box-sizing: border-box; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 28px 24px; box-shadow: 0 24px 48px rgba(0,0,0,0.3); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px;">
        <div style="width: 60px; height: 60px; border-radius: 50%; background: #FEF3C7; border: 2px solid #F59E0B; color: #D97706; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 20px rgba(245, 158, 11, 0.22); flex-shrink: 0;">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>

        <div>
          <h3 style="font-size: 18px; font-weight: 800; color: var(--text-main); margin: 0 0 6px 0; letter-spacing: -0.3px;">${title}</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin: 0; font-weight: 500; line-height: 1.4;">${message}</p>
        </div>

        ${listHtml}

        <button type="button" onclick="document.getElementById('modalPatientValidationWarning').style.display='none';"
          style="width: 100%; padding: 11px 16px; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: var(--radius-md); background: #D97706; color: #FFFFFF; cursor: pointer; border: none; box-shadow: 0 4px 12px rgba(217, 119, 6, 0.25); margin-top: 4px;">
          Entendido
        </button>
      </div>
    `;
    modal.style.display = 'flex';
  }

  // Candados del alta de paciente (ver installClivoraPostDedupe): patientSubmitting
  // cubre la validación y la búsqueda de posibles duplicados; patientSaving, el
  // guardado en sí (al que también llega el "Continuar" del aviso de duplicado).
  let patientSubmitting = false;
  let patientSaving = false;
  const patientSaveButtons = () => Array.from(document.querySelectorAll(
    'button[form="newPatientForm"], .patient-create-actions button[type="submit"]'));

  async function handleNewPatientSubmit(event) {
    if (event) event.preventDefault();
    if (patientSubmitting || patientSaving) return;
    patientSubmitting = true;
    try {
      await runNewPatientSubmit();
    } finally {
      patientSubmitting = false;
    }
  }

  async function runNewPatientSubmit() {

    const primerApellido = document.getElementById('newPrimerApellido')?.value.trim() || '';
    const nombres = document.getElementById('newNombres')?.value.trim() || '';
    const origenReferencia = document.getElementById('newOrigenReferencia')?.value || '';
    const fechaNacimiento = document.getElementById('newFechaNacimiento')?.value || '';
    const genero = document.getElementById('newGenero')?.value || '';
    const terminosCheckbox = document.getElementById('newTerminosCondiciones');
    const doctorAsignado = document.getElementById('newDoctor')?.value || '';
    const listaPrecios = document.getElementById('newListaPrecios')?.value || '';

    if (!clivoraCanSkipPatientRequiredFields) {
      const missingFields = [];
      if (!primerApellido) missingFields.push('Primer apellido');
      if (!nombres) missingFields.push('Nombres');
      if (!origenReferencia) missingFields.push('Origen de referencia');
      if (!fechaNacimiento) missingFields.push('Fecha de nacimiento');
      if (!genero) missingFields.push('Género');
      // Correo y Celular: obligatorios en el servidor para pacientes
      // (validación del backend) — antes no se
      // revisaban aquí y el guardado fallaba con un error genérico.
      if (!document.getElementById('newEmail')?.value.trim()) missingFields.push('Correo electrónico');
      if (!document.getElementById('newCelular')?.value.trim()) missingFields.push('Celular');
      if (!doctorAsignado) missingFields.push('Doctor');
      if (!listaPrecios) missingFields.push('Seguros (Lista de precios)');
      if (!terminosCheckbox || !terminosCheckbox.checked) missingFields.push('Aceptar Términos & Condiciones');

      if (missingFields.length > 0) {
        showPatientValidationWarningModal(
          'Campos obligatorios incompletos',
          'Por favor complete los siguientes campos para poder guardar el paciente:',
          missingFields,
        );
        return;
      }
    }

    const telefono = document.getElementById('newTelefono')?.value.trim() || '';
    const celular = document.getElementById('newCelular')?.value.trim() || '';
    const phoneRegex = /^\d*$/;

    if (!phoneRegex.test(telefono) || !phoneRegex.test(celular)) {
      showClivoraAlertModal('Los campos Teléfono y Celular sólo deben contener números.');
      return;
    }

    // Antes esto se validaba con pattern="[0-9]{10}" en el <input> — el
    // navegador bloqueaba el submit() en silencio (sin pasar por este
    // handler, sin fetch, sin nada en consola/terminal) y solo enfocaba el
    // campo con su burbuja nativa, que dentro de este modal (position:fixed
    // + backdrop-filter) no siempre se alcanza a ver. Se valida aquí para
    // que el error sea siempre visible.
    if ((telefono && telefono.length !== 10) || (celular && celular.length !== 10)) {
      showClivoraAlertModal('Los campos Teléfono y Celular deben tener exactamente 10 dígitos.');
      return;
    }

    async function proceedWithPatientSave() {
      // Candado: el aviso de posible duplicado también llama a esta función
      // (botón "Continuar"), así que se protege aquí y no solo en el submit.
      if (patientSaving) return;
      patientSaving = true;
      patientSaveButtons().forEach((btn) => setClivoraButtonBusy(btn, true));
      try {
        await doPatientSave();
      } finally {
        patientSaving = false;
        patientSaveButtons().forEach((btn) => setClivoraButtonBusy(btn, false));
      }
    }

    async function doPatientSave() {
      const payload = buildPatientObject();
      let created;
      try {
        const response = await fetch('/clivora/api/patients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar el paciente.'));
          return;
        }
        created = await response.json();
      } catch (error) {
        console.error('Error al guardar paciente:', error);
        showClivoraAlertModal('No se pudo guardar el paciente. Intente de nuevo.');
        return;
      }
      const newPatient = { ...payload, id: created.id, exp: created.exp, name: created.name };

      // Mostrar modal con animación de guardado exitoso y las 3 opciones
      // requeridas en cuanto el servidor confirma. La lista completa de
      // pacientes se recarga después, sin esperarla: tardaba varios segundos
      // con el formulario aún en pantalla y daba tiempo a un segundo
      // "Guardar Paciente" (paciente duplicado).
      showPatientCreatedSuccessModal(newPatient);
      loadPatientsList();
    }

    // Advertencia (no bloqueo) de posible duplicado por nombre/apellido
    // parecido, mismo celular o mismo RFC, al momento de capturar.
    try {
      const params = new URLSearchParams({
        nombres, primerApellido, segundoApellido: document.getElementById('newSegundoApellido')?.value.trim() || '',
        celular, rfc: document.getElementById('newRFC')?.value.trim() || '',
      });
      const dupResponse = await fetch(`/clivora/api/patients/check_similar?${params.toString()}`, { cache: 'no-store' });
      const candidates = dupResponse.ok ? await dupResponse.json() : [];
      if (candidates.length > 0) {
        showDuplicatePatientWarningModal(candidates, proceedWithPatientSave);
        return;
      }
    } catch (error) {
      console.error('Error al verificar pacientes duplicados:', error);
      // Si la verificación falla, se sigue con el guardado normal en vez de
      // bloquear al usuario por un problema de red ajeno a sus datos.
    }

    await proceedWithPatientSave();
  }

  form.addEventListener('submit', handleNewPatientSubmit);
}

// Delegación global para el botón Guardar Paciente
document.addEventListener('click', (e) => {
  const saveBtn = e.target.closest('button[form="newPatientForm"]') || e.target.closest('.patient-create-actions button[type="submit"]');
  if (saveBtn) {
    const form = document.getElementById('newPatientForm');
    if (form) {
      e.preventDefault();
      form.requestSubmit();
    }
  }
});

function updateDetailReferenceFields() {
  const origenVal = document.getElementById('detailOrigenReferencia')?.value || '';
  const extGroup = document.getElementById('detailMedicoExternoGroup');
  const intGroup = document.getElementById('detailMedicoInternoGroup');
  const refGroup = document.getElementById('detailMedicoReferenciadorGroup');
  const sjGroup = document.getElementById('detailMedicoSanJoseGroup');

  // Estos valores deben coincidir exactamente con los "name" sembrados en el
  // catálogo de orígenes de referencia (/clivora/api/patient_referrals).
  if (extGroup) extGroup.classList.toggle('hidden', origenVal !== 'Médico Externo');
  if (intGroup) intGroup.classList.toggle('hidden', origenVal !== 'Médico Interno');
  if (refGroup) refGroup.classList.toggle('hidden', origenVal !== 'Médico Referenciador');
  if (sjGroup) sjGroup.classList.toggle('hidden', origenVal !== 'San José Valle Real');
}

function calculateAge(birthDateString) {
  if (!birthDateString) return '';
  const parts = birthDateString.split('-');
  if (parts.length !== 3) return '';
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const birthDate = new Date(year, month, day);
  const today = new Date();
  if (isNaN(birthDate.getTime())) return '';

  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  if (isNaN(age) || age < 0) return '0 años';
  return age === 1 ? '1 año' : `${age} años`;
}

function formatDateDMY(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dateStr;
}

async function loadPatientDetail(patientId) {
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}`);
    if (!response.ok) {
      console.error('No se pudo cargar el detalle del paciente');
      return;
    }
    const data = await response.json();
    await populatePatientInfoGeneral(data);
    toggleInfoGeneralEditMode(false);
    populatePatientDomicilioPersonal(data);
    toggleDomicilioPersonalEditMode(false);
    await populatePatientFacturacion(data);
    toggleFacturacionEditMode(false);
    populatePatientDomicilioFiscal(data);
    await populateHistoriaClinicaAll(data);
    await loadPatientFamilyHistory(patientId);
    await loadPatologicosSublists(patientId);
    await loadPatientMedications(patientId);
    await loadPatientDiagnosisLines(patientId);
  } catch (error) {
    console.error('Error al cargar el detalle del paciente:', error);
  }
}

// Ids de .hc-audit-info por sección (ver data-hc-section en el nav lateral
// y hc-section-N en cada tarjeta) — las secciones de Historia Clínica
// consolidan sus campos en el mismo registro,
// pero eso ya NO significa que compartan la misma auditoría de "última
// modificación": hc.sectionsAudit (ver _HC_SECTION_FIELD_GROUPS en el
// controlador) trae, para cada una de estas 7 secciones, cuándo/quién
// cambió de verdad algún campo DE ESA sección — antes se usaba
// updatedBy/updatedAt del registro completo para las 9 por igual, así que
// guardar cualquier sección (el frontend manda el formulario completo cada
// vez) hacía ver a TODAS como recién modificadas. "Creado" sí sigue siendo
// compartido: es la fecha real de creación del expediente completo.
// Archivos de HC (14) queda FUERA de esta lista a propósito: vive en su
// propia lista (archivos del expediente, ver clivoraPatientFiles más abajo), no
// en la historia clínica — si se dejaba aquí, como sectionsAudit
// nunca trae esa clave, esta función siempre caía al fallback general
// (hc.updatedBy/updatedAt), y guardar CUALQUIER otra sección de Historia
// Clínica hacía ver a Archivos de HC como "recién modificada" sin haberla
// tocado. Su propia auditoría real la pone updateHcFilesAuditInfo,
// calculada a partir de su propia lista.
const HC_AUDIT_INFO_SECTION_IDS = [1, 8, 9, 10, 15, 12, 13];

function updateHcAuditInfo(hc) {
  const createdBy = hc.createdBy || '';
  const createdAt = hc.createdAt ? formatClivoraDateTime(hc.createdAt) : '';
  const sectionsAudit = hc.sectionsAudit || {};
  // Botón de lápiz para corregir create_date de la historia clínica
  // (ver rol group_historial_create_date_edit) — las 9 secciones
  // comparten este mismo id/fecha (ver comentario de HC_AUDIT_INFO_SECTION_IDS
  // más arriba), así que cada una recibe su propia copia del botón, todas
  // apuntando al mismo registro.
  const canEditCreateDate = hc.id && canEditHistorialCreateDate();
  const editBtn = canEditCreateDate
    ? ` <button type="button" class="clivora-edit-create-date-btn" data-model="historia_clinica" data-id="${hc.id}" data-created-by="${escapeHtml(createdBy)}" title="Editar fecha de creación" style="border: none; background: none; cursor: pointer; color: var(--primary-blue); padding: 0; margin-left: 4px; vertical-align: middle; display: inline-flex;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>`
    : '';

  HC_AUDIT_INFO_SECTION_IDS.forEach(n => {
    const el = document.getElementById(`hcAuditInfo-${n}`);
    if (!el) return;
    const sectionAudit = sectionsAudit[String(n)];
    const updatedByRaw = sectionAudit ? sectionAudit.updatedBy : hc.updatedBy;
    const updatedAtRaw = sectionAudit ? sectionAudit.updatedAt : hc.updatedAt;
    const updatedBy = updatedByRaw || '';
    const updatedAt = updatedAtRaw ? formatClivoraDateTime(updatedAtRaw) : '';

    // Cada línea en su propio renglón (con "|" al frente, ver captura de QA)
    // en vez de una sola línea con las dos unidas por " · " — así se
    // distinguen de un vistazo sin tener que leer la línea completa. El
    // botón de editar va FUERA de escapeHtml (si no, se pintaría como texto
    // literal en vez de como botón real).
    const rows = [];
    const createdBits = [createdAt ? `el ${createdAt}` : '', createdBy ? `por ${createdBy}` : ''].filter(Boolean);
    if (createdBits.length) rows.push(`<div>| ${escapeHtml(`Creado ${createdBits.join(' ')}`)}${editBtn}</div>`);
    const updatedBits = [updatedAt ? `el ${updatedAt}` : '', updatedBy ? `por ${updatedBy}` : ''].filter(Boolean);
    if (updatedBits.length) rows.push(`<div>| ${escapeHtml(`Última modificación ${updatedBits.join(' ')}`)}</div>`);

    el.innerHTML = rows.join('');
    el.style.display = rows.length ? 'block' : 'none';
  });
}

// Todas las secciones "1 registro por paciente" de Historia Clínica viven en
// HistoriaClinica: un solo fetch (data.historia_clinica) trae todo,
// y un solo POST (saveHistoriaClinica) lo guarda todo junto.
async function populateHistoriaClinicaAll(data) {
  const hc = (data && data.historia_clinica) || {};
  setEditableFieldValue(document.getElementById('hcAntecedentesImportantes'), hc.antecedentes_importantes || '');
  setEditableFieldValue(document.getElementById('hcMotivoConsulta'), hc.motivo_consulta || '');

  await populateNoPatologicos(hc);
  populatePatologicos(hc);
  await populateGineco(hc);
  populateAparatosSistemas(hc);
  await populateExploracionFisica(hc);
  populatePeea(hc);
  populateAnalisisDiagnostico(hc);
  await populatePlanTratamiento(hc);
  updateHcAuditInfo(hc);
}

async function saveHistoriaClinica() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const el = document.getElementById('hcAntecedentesImportantes');
  const motivoEl = document.getElementById('hcMotivoConsulta');
  const motivoValue = getEditableFieldValue(motivoEl).trim();
  const payload = {
    // Si el doctor no llenó Antecedentes Médicos, se guarda el valor por
    // defecto explícito en vez de vacío (mismo criterio que aplica el
    // backend al guardar, por si el
    // frontend guarda antes de que se refleje ahí).
    antecedentes_importantes: getEditableFieldValue(el).trim() ? getEditableFieldValue(el) : 'Interrogado y Negado',
    motivo_consulta: motivoValue,
  };
  collectNoPatologicos(payload);
  collectPatologicos(payload);
  collectGineco(payload);
  collectAparatosSistemas(payload);
  collectExploracionFisica(payload);
  collectPeea(payload);
  collectAnalisisDiagnostico(payload);
  collectPlanTratamiento(payload);
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/historia_clinica`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    console.error('Error al guardar Historia Clínica:', error);
    return false;
  }
}

// ============================
// HC — Toggles genéricos (secciones 3, 4 y 5) + helpers de carga/guardado
// ============================
// Apagado siempre dice "Interrogado y Negado"; encendido dice qué
// antecedente sí tiene el paciente (mismo criterio que Gineco-obstétricos).
const CLIVORA_HC_TOGGLES = [
  { id: 'toggle-tabaco', labelId: 'toggle-tabaco-label', formId: 'tabaco-form-area', activeText: 'Con antecedentes de tabaquismo', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-vape', labelId: 'toggle-vape-label', formId: 'vape-form-area', activeText: 'Con antecedentes de vapeo', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-humo', labelId: 'toggle-humo-label', formId: 'humo-form-area', activeText: 'Con exposición pasiva a humo', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-alcohol', labelId: 'toggle-alcohol-label', formId: 'alcohol-form-area', activeText: 'Con antecedentes de alcoholismo', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-drogas', labelId: 'toggle-drogas-label', formId: 'drogas-form-area', activeText: 'Con consumo de drogas', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-alergias', labelId: 'toggle-alergias-label', formId: 'alergias-form-area', activeText: 'Con alergias', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-cirugias', labelId: 'toggle-cirugias-label', formId: 'cirugias-form-area', activeText: 'Con antecedentes quirúrgicos', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-transfusiones', labelId: 'toggle-transfusiones-label', formId: 'transfusiones-form-area', activeText: 'Con antecedentes transfusionales', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-reproductivos', labelId: 'toggle-reproductivos-label', formId: 'reproductivos-form-area', activeText: 'Con antecedentes reproductivos', inactiveText: 'Interrogado y Negado' },
  { id: 'toggle-gineco', labelId: 'toggle-gineco-label', disabledId: 'gineco-disabled-box', formId: 'gineco-form-area', activeText: 'Con antecedentes gineco-obstétricos', inactiveText: 'Sin antecedentes gineco-obstétricos' },
];

// El campo de observaciones (formArea) se muestra solo cuando el switch
// está activado — con el switch en "Interrogado y Negado" (o "Sin
// antecedentes...") no hay nada que anotar, así que el textarea
// correspondiente se oculta en vez de quedar visible pero vacío/sin uso.
function setClivoraToggleState(cfg, active) {
  const toggle = document.getElementById(cfg.id);
  const toggleLabel = document.getElementById(cfg.labelId);
  const disabledBox = document.getElementById(cfg.disabledId);
  const formArea = document.getElementById(cfg.formId);

  if (toggle) toggle.classList.toggle('active', active);
  if (toggleLabel) toggleLabel.textContent = active ? cfg.activeText : cfg.inactiveText;
  if (disabledBox) disabledBox.style.display = 'none';
  if (formArea) formArea.style.display = active ? 'block' : 'none';
}

function isClivoraToggleActive(toggleId) {
  return document.getElementById(toggleId)?.classList.contains('active') || false;
}

let clivoraHcCatalogs = null;

async function ensureHcCatalogs() {
  if (clivoraHcCatalogs) return clivoraHcCatalogs;
  const empty = {
    forecast_options: [], mammography_results: [], pap_smear_results: [],
    contraceptive_methods: [], drug_types: [], allergy_reactions: [], transfusion_types: [],
    blood_groups: [], blood_rh_factors: [],
  };
  try {
    const response = await fetch('/clivora/api/hc/catalogs', { cache: 'no-store' });
    clivoraHcCatalogs = response.ok ? await response.json() : empty;
  } catch (error) {
    console.error('Error al cargar catálogos de historia clínica:', error);
    clivoraHcCatalogs = empty;
  }
  return clivoraHcCatalogs;
}

function fillSelectOptions(selectEl, options, selectedId, placeholder, valueKey = 'id', labelKey = 'name') {
  if (!selectEl) return;
  selectEl.innerHTML = [`<option value="">${placeholder || 'Seleccionar...'}</option>`]
    .concat((options || []).map(o =>
      `<option value="${o[valueKey]}" ${String(o[valueKey]) === String(selectedId) ? 'selected' : ''}>${o[labelKey]}</option>`))
    .join('');
}

function applyFieldMap(data, fieldMap) {
  Object.entries(fieldMap).forEach(([elId, fieldName]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    setEditableFieldValue(el, (data || {})[fieldName]);
  });
}

function collectFieldMapInto(payload, fieldMap) {
  Object.entries(fieldMap).forEach(([elId, fieldName]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    payload[fieldName] = getEditableFieldValue(el);
  });
}

// ============================
// HC — Antecedentes Heredofamiliares
// ============================

// El campo de "miembro de la familia" (catálogo de familiares)
// se quita de esta tarjeta: se pidió reemplazarlo por un campo de
// descripción libre para poder anotar cualquier información del familiar,
// no solo un nombre de catálogo (ver "Descripción del familiar" debajo).
function buildFamiliarCardHtml(row, cardId, familiarIndex) {
  const r = row || {};

  return `
    <div class="familiar-form-card" id="${cardId}" data-record-id="${r.id || ''}">
      <div class="familiar-card-header">
        <h4>FAMILIAR ${familiarIndex}</h4>
        <button type="button" class="btn-close-familiar btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="familiar-card-body">
        <label class="custom-checkbox">
          <input type="checkbox" class="familiar-has-died" ${r.has_died ? 'checked' : ''} /><span></span> FALLECIDO
        </label>
        <div class="familiar-field-group">
          <label>Descripción del familiar</label>
          <div class="rich-text-editor">
            <div class="rich-text-toolbar">
              <select class="rt-cmd-select" data-cmd="fontName" title="Fuente">
                <option value="Calibri">Calibri</option>
                <option value="Arial">Arial</option>
                <option value="Georgia">Georgia</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Verdana">Verdana</option>
                <option value="Courier New">Courier New</option>
              </select>
              <select class="rt-cmd-select" data-cmd="fontSize" title="Tamaño de fuente">
                <option value="2">10</option>
                <option value="3" selected>12</option>
                <option value="4">14</option>
                <option value="5">18</option>
                <option value="6">24</option>
                <option value="7">36</option>
              </select>
              <span class="rt-sep"></span>
              <button type="button" class="rt-cmd-btn" data-cmd="bold" title="Negrita"><b>N</b></button>
              <button type="button" class="rt-cmd-btn" data-cmd="italic" title="Cursiva"><i>K</i></button>
              <button type="button" class="rt-cmd-btn" data-cmd="underline" title="Subrayado"><u>U</u></button>
              <button type="button" class="rt-cmd-btn" data-cmd="strikeThrough" title="Tachado"><s>S</s></button>
              <span class="rt-sep"></span>
              <span class="rt-color-icon-group" title="Color de texto"><span class="rt-color-icon-label">A</span><input type="color" class="rt-cmd-color" data-cmd="foreColor" value="#1F2937"></span>
              <span class="rt-color-icon-group" title="Resaltado"><span class="rt-color-icon-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg></span><input type="color" class="rt-cmd-color" data-cmd="hiliteColor" value="#FEF08A"></span>
              <span class="rt-color-icon-group" title="Color de subrayado"><span class="rt-color-icon-label rt-color-icon-underline">U</span><input type="color" class="rt-cmd-color" data-cmd="underlineColor" value="#DC2626"></span>
              <span class="rt-sep"></span>
              <button type="button" class="rt-cmd-btn" data-cmd="justifyLeft" title="Alinear a la izquierda"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg></button>
              <button type="button" class="rt-cmd-btn" data-cmd="justifyCenter" title="Centrar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg></button>
              <button type="button" class="rt-cmd-btn" data-cmd="justifyRight" title="Alinear a la derecha"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg></button>
              <span class="rt-sep"></span>
              <button type="button" class="rt-cmd-btn" data-cmd="insertUnorderedList" title="Lista con viñetas"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg></button>
              <button type="button" class="rt-cmd-btn" data-cmd="insertOrderedList" title="Lista numerada"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg></button>
            </div>
            <div class="rich-text-content familiar-obs-other" contenteditable="true" data-placeholder="Descripción del familiar...">${r.other_diseases || ''}</div>
          </div>
        </div>
      </div>
    </div>`;
}

async function loadPatientFamilyHistory(patientId) {
  if (!patientId) return;
  let rows = [];
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/family_history`, { cache: 'no-store' });
    rows = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar antecedentes heredofamiliares:', error);
  }

  const dynamicList = document.getElementById('heredo-dynamic-list');
  if (dynamicList) {
    dynamicList.innerHTML = rows
      .map((row, index) => buildFamiliarCardHtml(row, `familiar-${row.id}`, index + 1))
      .join('');
  }
}

function readFamilyHistoryRowsFromDom() {
  const dynamicList = document.getElementById('heredo-dynamic-list');
  if (!dynamicList) return [];
  // Solo se envían los campos que la tarjeta simplificada realmente edita
  // (has_died, other_diseases) — edad/diagnóstico/las observaciones por
  // padecimiento no tienen campo en el formulario; si se mandaran en blanco
  // el backend borraría esos datos existentes en cada guardado. Al omitir
  // la clave, el backend no la toca.
  return Array.from(dynamicList.querySelectorAll('.familiar-form-card')).map(card => {
    return {
      id: card.dataset.recordId ? parseInt(card.dataset.recordId, 10) : undefined,
      has_died: card.querySelector('.familiar-has-died')?.checked || false,
      other_diseases: getEditableFieldValue(card.querySelector('.familiar-obs-other')),
    };
  });
}

async function saveFamilyHistory() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const rows = readFamilyHistoryRowsFromDom();
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/family_history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    return response.ok;
  } catch (error) {
    console.error('Error al guardar antecedentes heredofamiliares:', error);
    return false;
  }
}

// ============================
// HC — Sección 3: Antecedentes No Patológicos
// ============================
const NO_PATOLOGICOS_FIELD_MAP = {
  npNonPathologicalObservations: 'non_pathological_observations',
};

async function populateNoPatologicos(hc) {
  applyFieldMap(hc, NO_PATOLOGICOS_FIELD_MAP);
}

function collectNoPatologicos(payload) {
  collectFieldMapInto(payload, NO_PATOLOGICOS_FIELD_MAP);
  if (!payload.non_pathological_observations) {
    payload.non_pathological_observations = 'Interrogado y Negado';
  }
}

// ============================
// HC — Sección 4: Antecedentes Patológicos
// Solo campos de cabecera; las sub-listas de drogas/alergias/cirugías/
// transfusiones quedan pendientes de una siguiente pasada.
// ============================
const PATOLOGICOS_FIELD_MAP = {
  patSmokingObservations: 'smoking_observations',
  patVapingObservations: 'vaping_observations',
  patSmokeExposedObservations: 'exposed_to_smoke_observations',
  patAlcoholObservations: 'alcoholism_observations',
  patDrugObservations: 'drug_observations',
  patAllergiesObservations: 'allergies_observations',
  patSurgeriesObservations: 'surgeries_observations',
  patTransfusionsObservations: 'transfusions_observations',
  patReproductiveObservations: 'reproductive_observations',
  patOtherPersonalDiseases: 'other_personal_diseases',
};
const PATOLOGICOS_TOGGLE_BOOL = {
  'toggle-tabaco': 'smoking',
  'toggle-vape': 'vapes',
  'toggle-humo': 'exposed_to_smoke',
  'toggle-alcohol': 'alcoholism',
  'toggle-drogas': 'uses_drugs',
  'toggle-alergias': 'has_allergies_hc',
  'toggle-cirugias': 'has_surgeries',
  'toggle-transfusiones': 'has_transfusions',
  'toggle-reproductivos': 'is_reproductive',
};

function populatePatologicos(hc) {
  applyFieldMap(hc, PATOLOGICOS_FIELD_MAP);
  Object.entries(PATOLOGICOS_TOGGLE_BOOL).forEach(([toggleId, fieldName]) => {
    setClivoraToggleState(CLIVORA_HC_TOGGLES.find(t => t.id === toggleId), !!hc[fieldName]);
  });
}

// Un campo patológico "no activado" (toggle en Interrogado y Negado) debe
// guardarse con ese texto literal — antes solo se mostraba como leyenda del
// toggle, nunca se escribía en el campo de observaciones, así que en el
// expediente impreso esos campos se veían vacíos en vez de reflejar que sí
// se preguntó y se negó.
const PATOLOGICOS_TOGGLE_OBSERVATIONS = {
  'toggle-tabaco': 'patSmokingObservations',
  'toggle-vape': 'patVapingObservations',
  'toggle-humo': 'patSmokeExposedObservations',
  'toggle-alcohol': 'patAlcoholObservations',
  'toggle-drogas': 'patDrugObservations',
  'toggle-alergias': 'patAllergiesObservations',
  'toggle-cirugias': 'patSurgeriesObservations',
  'toggle-transfusiones': 'patTransfusionsObservations',
  'toggle-reproductivos': 'patReproductiveObservations',
};

function collectPatologicos(payload) {
  Object.entries(PATOLOGICOS_TOGGLE_BOOL).forEach(([toggleId, fieldName]) => {
    payload[fieldName] = isClivoraToggleActive(toggleId);
  });
  collectFieldMapInto(payload, PATOLOGICOS_FIELD_MAP);
  Object.entries(PATOLOGICOS_TOGGLE_OBSERVATIONS).forEach(([toggleId, elId]) => {
    const fieldName = PATOLOGICOS_FIELD_MAP[elId];
    if (!fieldName) return;
    if (!isClivoraToggleActive(toggleId) && !payload[fieldName]) {
      payload[fieldName] = 'Interrogado y Negado';
    }
  });
  // "Otras enfermedades personales" (nopat-card) no tiene un toggle
  // correlacionado en PATOLOGICOS_TOGGLE_BOOL — se resuelve aparte.
  if (!payload.other_personal_diseases) {
    payload.other_personal_diseases = 'Interrogado y Negado';
  }
}

// ============================
// HC — Sección 4 (sub-listas): Drogas / Alergias / Cirugías / Transfusiones
// Antes estas 4 tablas eran solo maqueta estática — el "TIPO DE X" era un
// <div class="custom-select"> decorativo sin opciones ni JS detrás (nada de
// agregar/quitar filas, nada que las guardara). Mismo patrón de sync
// completo (crear/actualizar/borrar) que heredofamiliares.
// ============================

function buildCatalogOptionsHtml(catalog, selectedId, placeholder) {
  return ['<option value="">' + placeholder + '</option>']
    .concat((catalog || []).map(o =>
      `<option value="${o.id}" ${String(o.id) === String(selectedId) ? 'selected' : ''}>${o.name}</option>`))
    .join('');
}

function buildDrugCardHtml(row, cardId, index, catalogs) {
  const r = row || {};
  return `
    <div class="repetable-block" id="${cardId}" data-record-id="${r.id || ''}">
      <div class="repetable-block-header">
        <h4>Droga ${index}</h4>
        <button type="button" class="btn-remove-block btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="familiar-row-2col">
        <div class="familiar-field-group">
          <label>TIPO DE DROGA</label>
          <select class="familiar-input drug-type-select" style="background: var(--bg-card); color: var(--text-main);">
            ${buildCatalogOptionsHtml(catalogs.drug_types, r.drug_type_id, 'Seleccionar tipo')}
          </select>
        </div>
        <div class="familiar-field-group">
          <label>MESES DE CONSUMO</label>
          <input type="number" class="familiar-input drug-months" placeholder="Meses" value="${r.drugs_months || ''}">
        </div>
      </div>
    </div>`;
}

function buildAllergyCardHtml(row, cardId, index, catalogs) {
  const r = row || {};
  return `
    <div class="repetable-block" id="${cardId}" data-record-id="${r.id || ''}">
      <div class="repetable-block-header">
        <h4>Alergia ${index}</h4>
        <button type="button" class="btn-remove-block btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="familiar-row-2col">
        <div class="familiar-field-group">
          <label>¿A QUÉ ES ALÉRGICO?</label>
          ${richTextEditorHtmlClass('allergy-description', '', r.allergy_description)}
        </div>
        <div class="familiar-field-group">
          <label>TIPO DE REACCIÓN</label>
          <select class="familiar-input allergy-reaction-select" style="background: var(--bg-card); color: var(--text-main);">
            ${buildCatalogOptionsHtml(catalogs.allergy_reactions, r.allergy_reaction_id, 'Seleccionar reacción')}
          </select>
        </div>
      </div>
      <div class="familiar-field-group" style="margin-top: 16px;">
        <label>OTRAS REACCIONES / OBSERVACIONES</label>
        ${richTextEditorHtmlClass('allergy-other-reactions', '', r.other_allergy_reactions)}
      </div>
    </div>`;
}

function buildSurgeryCardHtml(row, cardId, index) {
  const r = row || {};
  return `
    <div class="repetable-block" id="${cardId}" data-record-id="${r.id || ''}">
      <div class="repetable-block-header">
        <h4>Cirugía ${index}</h4>
        <button type="button" class="btn-remove-block btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="familiar-row-2col">
        <div class="familiar-field-group">
          <label>DESCRIPCIÓN DE LA CIRUGÍA</label>
          ${richTextEditorHtmlClass('surgery-description', '', r.surgery_description)}
        </div>
        <div class="familiar-field-group">
          <label>EDAD AL MOMENTO</label>
          <input type="number" class="familiar-input surgery-age" placeholder="Edad" value="${r.age || ''}">
        </div>
      </div>
      <div class="familiar-field-group" style="margin-top: 16px;">
        <label>COMPLICACIONES</label>
        ${richTextEditorHtmlClass('surgery-complications', '', r.complications)}
      </div>
    </div>`;
}

function buildTransfusionCardHtml(row, cardId, index, catalogs) {
  const r = row || {};
  return `
    <div class="repetable-block" id="${cardId}" data-record-id="${r.id || ''}">
      <div class="repetable-block-header">
        <h4>Transfusión ${index}</h4>
        <button type="button" class="btn-remove-block btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="familiar-row-2col">
        <div class="familiar-field-group">
          <label>AÑO</label>
          <input type="number" class="familiar-input transfusion-year" placeholder="Año" value="${r.year || ''}">
        </div>
        <div class="familiar-field-group">
          <label>TIPO DE TRANSFUSIÓN</label>
          <select class="familiar-input transfusion-type-select" style="background: var(--bg-card); color: var(--text-main);">
            ${buildCatalogOptionsHtml(catalogs.transfusion_types, r.type_id, 'Seleccionar tipo')}
          </select>
        </div>
      </div>
    </div>`;
}

const PATOLOGICOS_SUBLISTS = {
  drugs: {
    endpoint: 'drugs',
    containerId: 'drogas-dynamic-list',
    addBtnId: 'btn-add-droga',
    cardPrefix: 'droga',
    build: buildDrugCardHtml,
    readRow: (card) => ({
      id: card.dataset.recordId ? parseInt(card.dataset.recordId, 10) : undefined,
      drug_type_id: parseInt(card.querySelector('.drug-type-select')?.value, 10) || false,
      drugs_months: parseInt(card.querySelector('.drug-months')?.value, 10) || 0,
    }),
  },
  allergies: {
    endpoint: 'allergies',
    containerId: 'alergias-dynamic-list',
    addBtnId: 'btn-add-alergia',
    cardPrefix: 'alergia',
    build: buildAllergyCardHtml,
    readRow: (card) => ({
      id: card.dataset.recordId ? parseInt(card.dataset.recordId, 10) : undefined,
      allergy_description: getEditableFieldValue(card.querySelector('.allergy-description')),
      allergy_reaction_id: parseInt(card.querySelector('.allergy-reaction-select')?.value, 10) || false,
      other_allergy_reactions: getEditableFieldValue(card.querySelector('.allergy-other-reactions')),
    }),
  },
  surgeries: {
    endpoint: 'surgeries',
    containerId: 'cirugias-dynamic-list',
    addBtnId: 'btn-add-cirugia',
    cardPrefix: 'cirugia',
    build: buildSurgeryCardHtml,
    readRow: (card) => ({
      id: card.dataset.recordId ? parseInt(card.dataset.recordId, 10) : undefined,
      surgery_description: getEditableFieldValue(card.querySelector('.surgery-description')),
      age: parseInt(card.querySelector('.surgery-age')?.value, 10) || 0,
      complications: getEditableFieldValue(card.querySelector('.surgery-complications')),
    }),
  },
  transfusions: {
    endpoint: 'transfusions',
    containerId: 'transfusiones-dynamic-list',
    addBtnId: 'btn-add-transfusion',
    cardPrefix: 'transfusion',
    build: buildTransfusionCardHtml,
    readRow: (card) => ({
      id: card.dataset.recordId ? parseInt(card.dataset.recordId, 10) : undefined,
      year: parseInt(card.querySelector('.transfusion-year')?.value, 10) || 0,
      type_id: parseInt(card.querySelector('.transfusion-type-select')?.value, 10) || false,
    }),
  },
};

let clivoraPatologicosSublistRows = { drugs: [], allergies: [], surgeries: [], transfusions: [] };

async function loadPatologicosSublists(patientId) {
  if (!patientId) return;
  const catalogs = await ensureHcCatalogs();
  await Promise.all(Object.entries(PATOLOGICOS_SUBLISTS).map(async ([key, cfg]) => {
    let rows = [];
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}/${cfg.endpoint}`, { cache: 'no-store' });
      rows = response.ok ? await response.json() : [];
    } catch (error) {
      console.error(`Error al cargar ${cfg.endpoint}:`, error);
    }
    clivoraPatologicosSublistRows[key] = rows;
    renderPatologicosSublist(key, catalogs);
  }));
}

function renderPatologicosSublist(key, catalogs) {
  const cfg = PATOLOGICOS_SUBLISTS[key];
  const container = document.getElementById(cfg.containerId);
  if (!container) return;
  const rows = clivoraPatologicosSublistRows[key] || [];
  container.innerHTML = rows
    .map((row, index) => cfg.build(row, `${cfg.cardPrefix}-${row.id || index}`, index + 1, catalogs))
    .join('');
}

async function addPatologicosSublistRow(key) {
  const cfg = PATOLOGICOS_SUBLISTS[key];
  const container = document.getElementById(cfg.containerId);
  if (!container) return;
  const catalogs = await ensureHcCatalogs();
  const index = container.querySelectorAll('.repetable-block').length + 1;
  const cardId = `${cfg.cardPrefix}-new-${Date.now()}`;
  container.insertAdjacentHTML('beforeend', cfg.build({}, cardId, index, catalogs));
}

async function savePatologicosSublists() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return true;
  // Estas 4 tablas repetibles (drogas/alergias/cirugías/transfusiones) ya
  // no tienen contenedor en el DOM — la tarjeta se simplificó a un solo
  // textarea de observaciones (ver PATOLOGICOS_FIELD_MAP). Si se mandara
  // rows:[] igual se sincronizaría contra el backend, que borra todo lo
  // que no venga en la lista — se omite el POST por completo en vez de
  // arriesgarse a borrar registros existentes de pacientes antiguos.
  const results = await Promise.all(Object.entries(PATOLOGICOS_SUBLISTS).map(async ([key, cfg]) => {
    const container = document.getElementById(cfg.containerId);
    if (!container) return true;
    const rows = Array.from(container.querySelectorAll('.repetable-block')).map(cfg.readRow);
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}/${cfg.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      return response.ok;
    } catch (error) {
      console.error(`Error al guardar ${cfg.endpoint}:`, error);
      return false;
    }
  }));
  return results.every(Boolean);
}

// ============================
// HC — Sección 6: Medicamentos / Tratamientos
// "Buscar medicamento" era un input suelto sin datalist, "MOMENTO DEL DÍA"
// era el mismo <div class="custom-select"> decorativo de las otras
// secciones, y "+ Agregar medicamento" no tenía ningún listener — se
// reutiliza el datalist de productos que ya usa Quimioterapia
// (clivoraProductsDatalist / ensureProductsDatalist) y se siembra el catálogo
// el catálogo de momentos del día (nunca tuvo datos ni
// endpoint).
// ============================
let clivoraMedications = [];

function buildMedicationRowHtml(row, rowId) {
  const r = row || {};
  return `
    <div class="meds-table-row" id="${rowId}" data-record-id="${r.id || ''}" style="grid-template-columns: 1fr auto; align-items: flex-start;">
      <div class="meds-col-name">
        <div class="rich-text-editor">
          <div class="rich-text-toolbar">
            <select class="rt-cmd-select" data-cmd="fontName" title="Fuente">
              <option value="Calibri">Calibri</option>
              <option value="Arial">Arial</option>
              <option value="Georgia">Georgia</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Verdana">Verdana</option>
              <option value="Courier New">Courier New</option>
            </select>
            <select class="rt-cmd-select" data-cmd="fontSize" title="Tamaño de fuente">
              <option value="2">10</option>
              <option value="3" selected>12</option>
              <option value="4">14</option>
              <option value="5">18</option>
              <option value="6">24</option>
              <option value="7">36</option>
            </select>
            <span class="rt-sep"></span>
            <button type="button" class="rt-cmd-btn" data-cmd="bold" title="Negrita"><b>N</b></button>
            <button type="button" class="rt-cmd-btn" data-cmd="italic" title="Cursiva"><i>K</i></button>
            <button type="button" class="rt-cmd-btn" data-cmd="underline" title="Subrayado"><u>U</u></button>
            <button type="button" class="rt-cmd-btn" data-cmd="strikeThrough" title="Tachado"><s>S</s></button>
            <span class="rt-sep"></span>
            <span class="rt-color-icon-group" title="Color de texto"><span class="rt-color-icon-label">A</span><input type="color" class="rt-cmd-color" data-cmd="foreColor" value="#1F2937"></span>
            <span class="rt-color-icon-group" title="Resaltado"><span class="rt-color-icon-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg></span><input type="color" class="rt-cmd-color" data-cmd="hiliteColor" value="#FEF08A"></span>
            <span class="rt-color-icon-group" title="Color de subrayado"><span class="rt-color-icon-label rt-color-icon-underline">U</span><input type="color" class="rt-cmd-color" data-cmd="underlineColor" value="#DC2626"></span>
            <span class="rt-sep"></span>
            <button type="button" class="rt-cmd-btn" data-cmd="justifyLeft" title="Alinear a la izquierda"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg></button>
            <button type="button" class="rt-cmd-btn" data-cmd="justifyCenter" title="Centrar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg></button>
            <button type="button" class="rt-cmd-btn" data-cmd="justifyRight" title="Alinear a la derecha"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg></button>
            <span class="rt-sep"></span>
            <button type="button" class="rt-cmd-btn" data-cmd="insertUnorderedList" title="Lista con viñetas"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg></button>
            <button type="button" class="rt-cmd-btn" data-cmd="insertOrderedList" title="Lista numerada"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg></button>
          </div>
          <div class="rich-text-content med-descripcion" contenteditable="true" data-placeholder="Descripción del medicamento...">${r.product || ''}</div>
        </div>
      </div>
      <div class="meds-col-actions" style="display: flex; align-items: center; justify-content: flex-end; padding-top: 4px;">
        <button type="button" class="btn-remove-med btn-anim-lift" onclick="document.getElementById('${rowId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
}

async function loadPatientMedications(patientId) {
  if (!patientId) return;
  const catalogs = await ensureHcCatalogs();
  let rows = [];
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/medications`, { cache: 'no-store' });
    rows = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar medicamentos:', error);
  }
  clivoraMedications = rows;
  renderMedicationsList(catalogs);
  ensureProductsDatalist();
}

function renderMedicationsList() {
  const container = document.getElementById('meds-dynamic-list');
  if (!container) return;
  container.innerHTML = clivoraMedications
    .map((row) => buildMedicationRowHtml(row, `med-row-${row.id}`))
    .join('');
}

function addMedicationRow() {
  const container = document.getElementById('meds-dynamic-list');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', buildMedicationRowHtml({}, `med-row-new-${Date.now()}`));
}

async function saveMedications() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return true;
  const container = document.getElementById('meds-dynamic-list');
  const rows = container ? Array.from(container.querySelectorAll('.meds-table-row')).map(row => ({
    id: row.dataset.recordId ? parseInt(row.dataset.recordId, 10) : undefined,
    // product es texto plano (no Html) — richTextValue() mandaba
    // el innerHTML crudo del contenteditable (<div>, <br>, hasta <b>/<ul>
    // si se pegaba texto con formato) y quedaba guardado tal cual, con
    // etiquetas y todo, en vez de texto plano.
    product: plainTextValue(row.querySelector('.med-descripcion')),
  })) : [];
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/medications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    return response.ok;
  } catch (error) {
    console.error('Error al guardar medicamentos:', error);
    return false;
  }
}

// ============================
// HC — Sección 7: Historia Gineco-Obstétrica
// ============================
const GINECO_FIELD_MAP = {
  gynObservations: 'gynecological_other',
};

async function populateGineco(hc) {
  applyFieldMap(hc, GINECO_FIELD_MAP);
  setClivoraToggleState(CLIVORA_HC_TOGGLES.find(t => t.id === 'toggle-gineco'), !!hc.has_gineco_history);
}

function collectGineco(payload) {
  payload.has_gineco_history = isClivoraToggleActive('toggle-gineco');
  collectFieldMapInto(payload, GINECO_FIELD_MAP);
  // Igual que Aparatos y Sistemas / Patológicos: si el doctor no escribe nada,
  // se guarda "Interrogado y Negado" en vez de dejar el campo vacío.
  if (!payload.gynecological_other) payload.gynecological_other = 'Interrogado y Negado';
}

// ============================
// HC — Sección 9: Aparatos y Sistemas
// ============================
const APARATOS_FIELD_MAP = {
  apRespiratory: 'respiratory',
  apEndocrine: 'endocrine',
  apSkin: 'skin_and_appendages',
  apCardiovascular: 'cardiovascular',
  apMusculoskeletal: 'musculoskeletal',
  apDigestive: 'digestive',
  apGenitourinary: 'genitourinary',
  apGeneralComments: 'aparatus_general_comments',
};

function populateAparatosSistemas(hc) {
  applyFieldMap(hc, APARATOS_FIELD_MAP);
}

// Igual que en Patológicos: si el médico no escribe nada para un aparato o
// sistema, el campo debe guardarse como "Interrogado y Negado" (ya era el
// placeholder visual, pero nunca se mandaba como valor real, así que el
// campo quedaba vacío). No aplica a "aparatus_general_comments":
// es un campo de comentarios generales, no un hallazgo por aparato.
const APARATOS_DEFAULT_TO_NEGADO = [
  'apRespiratory', 'apEndocrine', 'apSkin', 'apCardiovascular',
  'apMusculoskeletal', 'apDigestive', 'apGenitourinary',
];

function collectAparatosSistemas(payload) {
  collectFieldMapInto(payload, APARATOS_FIELD_MAP);
  APARATOS_DEFAULT_TO_NEGADO.forEach(elId => {
    const fieldName = APARATOS_FIELD_MAP[elId];
    if (fieldName && !payload[fieldName]) payload[fieldName] = 'Interrogado y Negado';
  });
}

// ============================
// HC — Sección 10: Exploración Física
// ============================
const EXPLORACION_FIELD_MAP = {
  expHead: 'physical_exploration_head',
  expNeck: 'physical_exploration_neck',
  expThorax: 'physical_exploration_thorax',
  expAbdomen: 'physical_exploration_abdomen',
  expGenitals: 'physical_exploration_genitals',
  expExtremities: 'physical_exploration_extremities',
  expFechaHora: 'physical_exploration_datetime',
};

function syncExploracionCheckboxState(chk) {
  if (!chk) return;
  const txt = document.getElementById(chk.dataset.target);
  if (!txt) return;
  const isChecked = chk.checked;
  // El editor enriquecido (div[contenteditable]) no tiene .disabled/.readOnly
  // — se bloquea apagando contentEditable, igual que setNoteFormLocked.
  if (txt.classList && txt.classList.contains('rich-text-content')) {
    txt.contentEditable = isChecked ? 'true' : 'false';
  } else {
    txt.disabled = !isChecked;
    txt.readOnly = !isChecked;
  }
  txt.style.opacity = isChecked ? '1' : '0.65';
  txt.style.cursor = isChecked ? 'text' : 'not-allowed';
  txt.style.backgroundColor = isChecked ? '#FFFFFF' : '#F8FAFC';
}

async function populateExploracionFisica(hc) {
  applyFieldMap(hc, EXPLORACION_FIELD_MAP);
  if (!hc.physical_exploration_datetime) {
    const fechaInput = document.getElementById('expFechaHora');
    if (fechaInput && !fechaInput.value) {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      fechaInput.value = now.toISOString().slice(0, 16);
    }
  }
  document.querySelectorAll('.chk-explora-toggle').forEach(chk => {
    const txt = document.getElementById(chk.dataset.target);
    chk.checked = !!(txt && getEditableFieldValue(txt));
    syncExploracionCheckboxState(chk);
  });
  const creadoPorInput = document.getElementById('expCreadoPor');
  if (creadoPorInput) {
    try {
      const response = await fetch('/clivora/api/me', { cache: 'no-store' });
      if (response.ok) {
        const me = await response.json();
        creadoPorInput.value = [me.name, me.function].filter(Boolean).join(' - ');
      }
    } catch (error) {
      console.error('Error al cargar el usuario actual:', error);
    }
  }
}

// Igual que Aparatos y Sistemas (APARATOS_DEFAULT_TO_NEGADO): si el doctor no
// encuentra nada que reportar en una región, el campo debe quedar con el
// machote de exploración normal en vez de vacío — sirve como constancia de
// que sí se revisó esa región, no solo un placeholder visual.
const EXPLORACION_DEFAULT_TEXT = {
  expHead: 'Normocéfalo, adecuada coloración de piel y tegumentos, pupilas isocóricas, cavidad oral normal, sin asimetrías ni movimientos musculares anormales.',
  expNeck: 'Cuello simétrico, sin tumoraciones ni adenopatías palpables, sin ingurgitación yugular ni rigidez.',
  expThorax: 'Tórax simétrico, con buena expansión bilateral, murmullo vesicular presente sin ruidos agregados, ruidos cardiacos rítmicos sin soplos.',
  expAbdomen: 'Abdomen blando, no distendido, no doloroso a la palpación, sin tumoraciones ni visceromegalias, peristalsis presente y normal.',
  expGenitals: 'Genitales de aspecto normal para la edad y sexo, sin lesiones, secreciones ni tumoraciones aparentes.',
  expExtremities: 'Extremidades simétricas, sin edema ni deformidades, pulsos periféricos presentes y simétricos, fuerza y tono muscular conservados.',
};

function collectExploracionFisica(payload) {
  collectFieldMapInto(payload, EXPLORACION_FIELD_MAP);
  Object.entries(EXPLORACION_DEFAULT_TEXT).forEach(([elId, defaultText]) => {
    const fieldName = EXPLORACION_FIELD_MAP[elId];
    if (fieldName && !payload[fieldName]) payload[fieldName] = defaultText;
  });
}

document.addEventListener('change', (event) => {
  const chk = event.target.closest('.chk-explora-toggle');
  if (!chk) return;
  syncExploracionCheckboxState(chk);
});

// ============================
// HC — Sección 6: PEEA
// ============================
const PEEA_FIELD_MAP = { peeaDescription: 'peea_description' };

function populatePeea(hc) {
  applyFieldMap(hc, PEEA_FIELD_MAP);
}

function collectPeea(payload) {
  collectFieldMapInto(payload, PEEA_FIELD_MAP);
}

// ============================
// Cuestionario de Ingreso (patient.questionnaire)
// ============================
const QUESTIONNAIRE_FIELD_MAP = {
  cqBloodType: 'blood_type',
  cqUnknownType: 'unknown_type',
  cqAllergies: 'allergies',
  cqTypeAllergies: 'type_allergies',
  cqCausesAllergies: 'causes_allergies',
  cqReasonVisit: 'reason_visit',
  cqBothersomeSymptom: 'bothersome_symptom',
  cqWhichSymptom: 'which_symptom',
  cqFever: 'fever',
  cqDateFever: 'date_fever',
  cqStudies: 'studies',
  cqWhichStudies: 'which_studies',
  cqRecommendationUs: 'recommendation_us',
  cqMedicalInsurance: 'medical_insurance',
  cqWhichMedicalInsurance: 'which_medical_insurance',
  cqEmergencyName: 'emergency_name',
  cqPhoneEmergency: 'phone_emergency',
  cqRelationshipPatient: 'relationship_patient',
  cqBilling: 'billing',
  cqReadSignNotice: 'read_sign_notice',
  cqFc: 'fc',
  cqFr: 'fr',
  cqTa: 'ta',
  cqTemperature: 'temperature',
  cqOxygenation: 'oxygenation',
  cqWeight: 'weight',
  cqHeight: 'height',
};

async function loadPatientQuestionnaire(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/questionnaire`, { cache: 'no-store' });
    const data = response.ok ? await response.json() : {};
    applyFieldMap(data, QUESTIONNAIRE_FIELD_MAP);
  } catch (error) {
    console.error('Error al cargar el cuestionario:', error);
  }
}

async function saveQuestionnaire() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const payload = {};
  collectFieldMapInto(payload, QUESTIONNAIRE_FIELD_MAP);
  try {
    await fetch(`/clivora/api/patients/${patientId}/questionnaire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Error al guardar el cuestionario:', error);
    showClivoraAlertModal('No se pudo guardar el Cuestionario.');
  }
}

// ============================
// Aseguradoras
// ============================
let clivoraPatientInsurance = [];
let clivoraAseguradorasCatalog = null;

async function ensureAseguradorasCatalog() {
  if (clivoraAseguradorasCatalog) return clivoraAseguradorasCatalog;
  try {
    const response = await fetch('/clivora/api/aseguradoras', { cache: 'no-store' });
    clivoraAseguradorasCatalog = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar catálogo de aseguradoras:', error);
    clivoraAseguradorasCatalog = [];
  }
  const select = document.getElementById('insAseguradora');
  if (select) {
    select.innerHTML = '<option value="">Seleccionar aseguradora</option>' +
      clivoraAseguradorasCatalog.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  }
  return clivoraAseguradorasCatalog;
}

async function loadPatientInsurance(patientId) {
  if (!patientId) return;
  await ensureAseguradorasCatalog();
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/insurance`, { cache: 'no-store' });
    clivoraPatientInsurance = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar aseguradoras del paciente:', error);
    clivoraPatientInsurance = [];
  }
  renderInsuranceList();
}

function renderInsuranceList() {
  const container = document.getElementById('insuranceListContainer');
  const countLabel = document.getElementById('insuranceCountLabel');
  if (countLabel) countLabel.textContent = `${clivoraPatientInsurance.length} registro(s)`;
  if (!container) return;

  if (clivoraPatientInsurance.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No hay información de aseguradoras registrada para este paciente.</p>';
    return;
  }

  container.innerHTML = clivoraPatientInsurance.map(rec => `
    <div class="nopat-card" style="padding: 14px 18px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="font-weight: 600; font-size: 13px;">${rec.title || '(Sin título)'}${rec.aseguradora_name ? ' — ' + rec.aseguradora_name : ''}</div>
        <div style="font-size: 12px; color: var(--text-muted);">${[rec.type_file, rec.comment].filter(Boolean).join(' · ')}</div>
      </div>
      <div style="display: flex; gap: 10px; align-items: center;">
        ${rec.fileUrl ? `<a href="${rec.fileUrl.replace('download=false', 'download=true')}" title="Descargar" style="display:inline-flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>` : ''}
        <button type="button" class="ins-remove btn-anim-lift" data-id="${rec.id}" title="Eliminar" style="background:none;border:none;cursor:pointer;color:#EF4444;display:inline-flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.ins-remove').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (!(await showClivoraConfirmModal('¿Eliminar este registro?'))) return;
      try {
        await fetch(`/clivora/api/insurance/${id}/delete`, { method: 'POST' });
        await loadPatientInsurance(window.clivoraCurrentPatientId);
      } catch (error) {
        console.error('Error al eliminar registro de aseguradora:', error);
      }
    };
  });
}

async function addPatientInsurance() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const title = document.getElementById('insTitle')?.value.trim() || '';
  const aseguradoraId = document.getElementById('insAseguradora')?.value || '';
  const typeFile = document.getElementById('insTypeFile')?.value.trim() || '';
  const comment = document.getElementById('insComment')?.value.trim() || '';
  const fileInput = document.getElementById('insFile');
  const file = fileInput?.files[0];

  if (!title) {
    showClivoraAlertModal('Por favor ingrese un título.');
    return;
  }

  const saveRecord = async (dataUrl) => {
    try {
      await fetch(`/clivora/api/patients/${patientId}/insurance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          aseguradora_id: aseguradoraId || false,
          type_file: typeFile,
          comment,
          file: dataUrl || '',
        }),
      });
      document.getElementById('insTitle').value = '';
      document.getElementById('insAseguradora').value = '';
      document.getElementById('insTypeFile').value = '';
      document.getElementById('insComment').value = '';
      if (fileInput) fileInput.value = '';
      await loadPatientInsurance(patientId);
    } catch (error) {
      console.error('Error al guardar registro de aseguradora:', error);
      showClivoraAlertModal('No se pudo guardar el registro.');
    }
  };

  await saveRecord(file ? await readFileAsDataUrl(file) : null);
}

// Aviso de vinculación (Receta Médica / Receta Oncológica / Orden Médica):
// cuando alguno de estos documentos se crea desde los botones de "Acciones
// Especiales" de una Nota de Oncología Médica queda enlazado a ella
// (clinic_consultations_id) — antes esto nunca se guardaba (los 3 botones ni
// siquiera abrían el modal dedicado) y el texto de este aviso era fijo,
// mostrando "estará vinculada" sin importar si de verdad lo estaba. Ahora
// refleja el estado real: el id de la nota si viene de una, o "Independiente"
// si el documento se creó directo desde su propia pestaña del expediente.
function renderVinculoBadge(bannerId, textId, consultationId, docLabel) {
  const banner = document.getElementById(bannerId);
  const text = document.getElementById(textId);
  if (!text) return;
  if (consultationId) {
    text.innerHTML = `<strong>Vinculada:</strong> Esta ${docLabel} proviene de la Nota de Oncología Médica (ID: ${consultationId}).`;
    if (banner) {
      banner.style.background = '#EEF2FF';
      banner.style.borderColor = '#C7D2FE';
      banner.style.color = '#2F4C8A';
    }
  } else {
    text.innerHTML = `<strong>Independiente:</strong> ${docLabel} Independiente — no viene vinculada de ninguna Nota de Oncología Médica.`;
    if (banner) {
      banner.style.background = '#FEF3C7';
      banner.style.borderColor = '#F59E0B';
      banner.style.color = '#92400E';
    }
  }
}

// Reverso de renderVinculoBadge: dentro de la propia Nota de Oncología
// Médica (al crearla o reabrirla) lista los documentos que ya se generaron
// desde sus botones de Acciones Especiales — antes solo el documento sabía
// de qué nota venía, la nota misma no mostraba nada. `docs` es
// linkedDocuments, tal como lo devuelve el backend.
function renderOncoLinkedDocuments(containerId, docs) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const list = docs || [];
  if (!list.length) {
    container.innerHTML = '<p style="font-size: 12px; color: var(--text-muted); margin: 0;">Aún no se ha generado ningún documento desde esta nota.</p>';
    return;
  }
  container.innerHTML = list.map(doc => `
    <div class="onco-linked-doc-item" data-kind="${doc.kind}" data-id="${doc.id}" data-label="${doc.label}"
      style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-main); cursor: pointer;">
      <span style="font-size: 12px; font-weight: 700; color: var(--primary-blue);">${doc.label} #${String(doc.id).padStart(3, '0')}</span>
      <span style="font-size: 11px; color: var(--text-muted);">${formatClivoraDateTime(doc.create_date)}</span>
    </div>
  `).join('');
}

// Click en cualquier tarjeta de "Documentos generados desde esta nota"
// (dentro de la Nota de Oncología, nueva o ya guardada): salta al documento
// real en su propia pestaña del expediente.
//
// Esto SÍ saca al médico de la pantalla actual, así que es aquí (y no en los
// 3 botones de Acciones Especiales, que solo abren un modal apilado encima
// sin salir de la nota) donde corresponde advertir que la nota se guardará
// tal cual esté. Ese guardado (ensureOncoNotaSaved) solo aplica dentro del
// modal de creación/edición (#oncoLinkedDocsContainer) — la tarjeta de
// "Editar Nota" del panel derecho (#edOncoLinkedDocsContainer) usa campos
// propios (edOnco*) que ensureOncoNotaSaved no lee, así que ahí se navega
// directo, sin guardado silencioso de por medio.
document.addEventListener('click', (event) => {
  const item = event.target.closest('.onco-linked-doc-item');
  if (!item) return;
  const id = parseInt(item.dataset.id, 10);
  if (!id) return;
  (async () => {
    if (item.closest('#oncoLinkedDocsContainer')) {
      const confirmed = await showClivoraConfirmModal(
        `Vas a salir de esta pantalla para ver ${item.dataset.label}. Antes de continuar se guardará automáticamente la Nota de Oncología Médica tal como está ahora mismo, aunque no hayas terminado de llenarla.`,
        'Se guardará la nota antes de continuar',
        { variant: 'warning', confirmLabel: 'Sí, guardar y continuar' });
      if (!confirmed) return;
      const consultationId = await ensureOncoNotaSaved();
      if (!consultationId) return;
    }
    const modalOnco = document.getElementById('modalNotaOncologiaMedica');
    if (modalOnco) modalOnco.style.display = 'none';
    if (item.dataset.kind === 'lab_order') {
      goToExpedienteSubTab('tab-laboratorio');
      clivoraSelectedLabOrderId = id;
      renderLabOrdersList();
    } else {
      goToExpedienteSubTab('tab-recetas');
      showRecipeDetail(id);
    }
  })();
});

// ============================
// Solicitudes de Laboratorio
// ============================
let clivoraPatientLabOrders = [];
// Nota de Oncología Médica de origen cuando la Orden Médica se abre desde su
// botón "Órdenes Médicas" (Acciones Especiales) — null = orden independiente
// (abierta desde la pestaña Laboratorio). Ver openOrdenMedicaModal.
let clivoraActiveLabOrderSourceConsultationId = null;
let clivoraLabCatalogs = null;

async function ensureLabCatalogs() {
  if (clivoraLabCatalogs) return clivoraLabCatalogs;
  const empty = { laboratories: [], studies: [], employees: [] };
  try {
    const response = await fetch('/clivora/api/lab_catalogs', { cache: 'no-store' });
    clivoraLabCatalogs = response.ok ? await response.json() : empty;
  } catch (error) {
    console.error('Error al cargar catálogos de laboratorio:', error);
    clivoraLabCatalogs = empty;
  }
  fillSelectOptions(document.getElementById('loEmployee'), clivoraLabCatalogs.employees, null, 'Seleccionar doctor');
  return clivoraLabCatalogs;
}

async function loadPatientLabOrders(patientId) {
  if (!patientId) return;
  await ensureLabCatalogs();
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/lab_orders`, { cache: 'no-store' });
    clivoraPatientLabOrders = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar órdenes de laboratorio:', error);
    clivoraPatientLabOrders = [];
  }
  renderLabOrdersList();
}

let clivoraSelectedLabOrderId = null;

function renderLabOrdersList() {
  const container = document.getElementById('labOrdersListContainer');
  const countLabel = document.getElementById('labOrdersCountLabel');
  if (countLabel) countLabel.textContent = `${clivoraPatientLabOrders.length} orden(es)`;
  if (!container) return;

  if (clivoraPatientLabOrders.length === 0) {
    clivoraSelectedLabOrderId = null;
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">No hay órdenes registradas.</p>';
    renderLabOrderDetail(null);
    syncLabOrderDetailPanelHeight();
    return;
  }

  if (!clivoraSelectedLabOrderId || !clivoraPatientLabOrders.some(o => String(o.id) === String(clivoraSelectedLabOrderId))) {
    clivoraSelectedLabOrderId = clivoraPatientLabOrders[0].id;
  }

  // Mismo diseño de tarjeta que la pestaña Notas (.file-card: ícono propio,
  // fila de doctor, fila de fecha) — antes esta lista usaba .hc-section-item
  // "pelón" (solo título + doctor en texto plano, sin ícono ni fecha).
  container.innerHTML = clivoraPatientLabOrders.map((order) => {
    const isActive = String(order.id) === String(clivoraSelectedLabOrderId);
    return `
      <div class="file-card lab-order-item ${isActive ? 'active-card' : ''}" data-id="${order.id}" style="cursor: pointer; margin-bottom: 8px;">
        <div class="file-card-icon" style="background-color: #EFF6FF; color: #2563EB; flex-shrink: 0;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
          </svg>
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 13px; font-weight: 800; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Orden Médica #${String(order.id).padStart(3, '0')}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            ${order.hr_employee_name || 'Sin doctor asignado'}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; margin-top: 4px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            ${formatClivoraDateTime(order.create_date)}
          </div>
        </div>
      </div>`;
  }).join('');

  renderLabOrderDetail(clivoraPatientLabOrders.find(o => String(o.id) === String(clivoraSelectedLabOrderId)) || null);
  syncLabOrderDetailPanelHeight();
}

function renderLabOrderDetail(order, isEditing = false) {
  const panel = document.getElementById('labOrderDetailPanel');
  if (!panel) return;

  if (!order) {
    panel.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 460px; text-align: center; color: var(--text-muted);">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 12px; opacity: 0.5;"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
        <p style="font-size: 13px; margin: 0;">No hay órdenes de laboratorio registradas para este paciente.</p>
      </div>`;
    return;
  }

  const patientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';

  const headerBtns = isEditing ? `
      <button type="button" class="btn-secondary btn-anim-lift" id="btnDiscardLabOrderEdit" style="padding: 6px 14px; font-size: 12px;">Descartar</button>
      <button type="button" class="btn-primary btn-anim-lift" id="btnSaveLabOrderEdit" style="padding: 6px 14px; font-size: 12px;">Guardar</button>
  ` : `
      <button type="button" class="btn-secondary btn-anim-lift" id="btnPrintLabOrderDetail" style="padding: 6px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Imprimir
      </button>
      <button type="button" class="btn-secondary btn-anim-lift" id="btnDownloadLabOrderDetail" style="padding: 6px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Descargar PDF
      </button>
      <button type="button" class="btn-secondary btn-anim-lift" id="btnEditLabOrderDetail" style="padding: 6px 14px; font-size: 12px;">Editar</button>
      <button type="button" class="btn-anim-lift" id="btnDeleteLabOrderDetail" data-id="${order.id}" title="Eliminar orden" style="background:none;border:none;cursor:pointer;color:#EF4444;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
  `;

  const bodyHtml = isEditing ? `
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <div class="form-group">
        <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">Doctor Asignado</label>
        <select id="editLoEmployee" class="familiar-input custom-select"></select>
      </div>
      <div class="form-group">
        <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">Observaciones</label>
        ${richTextEditorHtml('editLoObservations', '', order.observations || '')}
      </div>
    </div>` : `
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <div class="form-group">
        <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">Doctor Asignado</label>
        <div class="familiar-input" style="display: flex; align-items: center; background: var(--bg-main); font-weight: 700;">${order.hr_employee_name || '(Sin doctor asignado)'}</div>
      </div>
      <div class="form-group">
        <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">Observaciones</label>
        <div class="editor-textarea" style="min-height: 120px; background: var(--bg-main);">${order.observations || 'Sin observaciones'}</div>
      </div>
    </div>`;

  const orderCreatedMeta = buildCreatedUpdatedMetaHtml(
    formatClivoraDateTime(order.create_date), order.createdBy,
    formatClivoraDateTime(order.write_date), order.updatedBy,
    { model: 'orden_estudios', id: order.id });

  panel.innerHTML = `
    <div class="expediente-detail-header" style="font-size: 15px; font-weight: 800; color: var(--text-main); margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 14px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary-blue)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
        <div style="min-width: 0;">
          <span>Orden médica del paciente ${patientName}</span>
          ${orderCreatedMeta}
        </div>
      </div>
      <div class="expediente-detail-header-actions" style="display: flex; align-items: center; gap: 8px;">${headerBtns}</div>
    </div>
    <div id="loDetailVinculoBanner" style="padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; display: flex; align-items: center; gap: 8px; margin-bottom: 18px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span id="loDetailVinculoBadgeText"></span>
    </div>
    ${bodyHtml}`;

  renderVinculoBadge('loDetailVinculoBanner', 'loDetailVinculoBadgeText', order.clinic_consultations_id || null, 'Orden Médica');

  if (isEditing) {
    fillSelectOptions(document.getElementById('editLoEmployee'), (clivoraLabCatalogs || {}).employees, order.hr_employee_id, 'Seleccionar doctor');
  }
}

// Abre el modal "Crear Orden Médica" — reutilizado tanto desde la pestaña
// Laboratorio (btnOpenCrearOrdenMedica, sourceConsultationId=null: orden
// "independiente") como desde el botón "Órdenes Médicas" de las Acciones
// Especiales de una Nota de Oncología Médica (sourceConsultationId = id de
// esa nota, ya guardada por ensureOncoNotaSaved).
function openOrdenMedicaModal(sourceConsultationId) {
  clivoraActiveLabOrderSourceConsultationId = sourceConsultationId || null;

  const loEmployeeSelect = document.getElementById('loEmployee');
  if (loEmployeeSelect) loEmployeeSelect.value = '';
  setEditableFieldValue(document.getElementById('loObservations'), '');
  const subtitle = document.getElementById('crearOrdenMedicaSubtitle');
  const patientName = document.getElementById('detailPatientName')?.textContent?.trim();
  if (subtitle) subtitle.textContent = patientName ? `Orden médica del paciente ${patientName}` : 'Orden médica del paciente';
  renderVinculoBadge('loVinculoBanner', 'loVinculoBadgeText', clivoraActiveLabOrderSourceConsultationId, 'Orden Médica');
  // Mismo criterio que openRecetaMedicaModal/openRecetaOncologicaModal (ver
  // showModalOnTop): abierto desde el botón "Órdenes Médicas" de la Nota de
  // Oncología Médica, este modal está más arriba en el HTML que
  // #modalNotaOncologiaMedica — con solo display:flex quedaba tapado detrás
  // de esa nota ya abierta y parecía que el botón no hacía nada.
  showModalOnTop(document.getElementById('modalCrearOrdenMedica'));

  // Precarga el doctor asignado al paciente — #loEmployee ahora selecciona
  // directo por id de médico (ver doctorPartnerId en /api/patients/<id>),
  // el mismo que el médico asignado del paciente, así que ya no hace falta traducir el id a
  // hr.employee (ese modelo casi nunca tiene un registro para el doctor,
  // razón por la que esta precarga nunca funcionaba). Queda editable por si
  // el médico está de vacaciones y hay que asignar la orden a otro.
  if (loEmployeeSelect && window.clivoraCurrentPatientId) {
    fetch(`/clivora/api/patients/${window.clivoraCurrentPatientId}`, { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        const doctorPartnerId = data?.info_general?.doctorPartnerId;
        if (doctorPartnerId) {
          // El <select> solo trae las opciones de /api/lab_catalogs, que
          // filtra por is_doctor=True en el contacto — pero appointee_id del
          // paciente (el doctor ya asignado) solo usa ese mismo domain como
          // sugerencia del selector en el formulario, no como restricción
          // real: un doctor puede quedar asignado a un paciente y luego
          // perder el flag is_doctor sin que esto se corrija solo. Si pasa
          // eso, no existe ningún <option> con este id y el .value de abajo
          // se ignora en silencio, dejando el campo vacío aunque el
          // paciente sí tenga doctor asignado. Se agrega la opción al vuelo
          // con el nombre que ya trae este mismo endpoint para que la
          // precarga nunca dependa de que ese flag siga sincronizado.
          if (!loEmployeeSelect.querySelector(`option[value="${doctorPartnerId}"]`)) {
            const doctorOption = document.createElement('option');
            doctorOption.value = String(doctorPartnerId);
            doctorOption.textContent = data.info_general.doctorName || 'Doctor asignado';
            loEmployeeSelect.appendChild(doctorOption);
          }
          loEmployeeSelect.value = String(doctorPartnerId);
          // Asignar .value por JS no dispara 'change' — el widget de select
          // personalizado (enhanceCustomSelect) solo refresca el texto
          // visible del trigger cuando escucha ese evento en el <select>
          // real, si no el campo se ve vacío aunque el valor real ya quedó
          // asignado.
          loEmployeeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })
      .catch(error => console.error('Error al precargar el doctor asignado:', error));
  }
}

async function addPatientLabOrder() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;

  const payload = {
    hr_employee_id: document.getElementById('loEmployee')?.value || false,
    observations: getEditableFieldValue(document.getElementById('loObservations')),
    // Solo tiene efecto al crear — ver clivora_patient_lab_orders_create.
    clinic_consultations_id: clivoraActiveLabOrderSourceConsultationId || false,
  };

  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/lab_orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Antes seguía como si se hubiera guardado (limpiaba el formulario y
      // mostraba el aviso de éxito) aunque el servidor lo rechazara.
      showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar la orden médica.'));
      return;
    }
    const saved = await response.json();
    document.getElementById('loEmployee').value = '';
    setEditableFieldValue(document.getElementById('loObservations'), '');
    if (saved && saved.id) clivoraSelectedLabOrderId = saved.id;
    await loadPatientLabOrders(patientId);
    // Ver el comentario equivalente en saveRecetaMedica: si esta orden
    // quedó vinculada a la Nota de Oncología Médica abierta detrás,
    // refresca su lista de "Documentos generados desde esta nota".
    if (clivoraActiveLabOrderSourceConsultationId) await ensureOncoNotaSaved();
    const successOverlay = document.getElementById('ordenMedicaSuccessOverlay');
    const btnNew = document.getElementById('btnNextNewOrdenMedica');
    const btnView = document.getElementById('btnNextViewOrdenesMedicas');
    const btnBackToOnco = document.getElementById('btnNextBackToOncoNotaFromOrden');
    if (btnNew) {
      btnNew.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
      };
    }
    // "Volver a consultas" vivía como onclick="..." inline en el HTML — se
    // mueve acá (mismo criterio que el resto de los botones de este overlay)
    // para que quede en el mismo lugar donde se resuelven sus dependencias
    // (renderPatientConsultas, getActivePatientExp) en vez de depender de
    // que ambas existan como globals accesibles desde el atributo inline.
    if (btnView) {
      btnView.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        const modal = document.getElementById('modalCrearOrdenMedica');
        if (modal) modal.style.display = 'none';
        if (typeof renderPatientConsultas === 'function') renderPatientConsultas(getActivePatientExp());
      };
    }
    // Ver el comentario equivalente en saveRecetaMedica: solo se ofrece
    // "Regresar a la nota oncológica" cuando esta orden se generó desde el
    // botón "Órdenes Médicas" DENTRO de #modalNotaOncologiaMedica — esa nota
    // nunca se cerró de fondo, así que basta con esconder este modal para
    // que vuelva a quedar visible.
    if (btnBackToOnco) {
      if (clivoraActiveLabOrderSourceConsultationId) {
        btnBackToOnco.style.display = 'inline-flex';
        btnBackToOnco.onclick = () => {
          if (successOverlay) successOverlay.style.display = 'none';
          const modal = document.getElementById('modalCrearOrdenMedica');
          if (modal) modal.style.display = 'none';
          showModalOnTop(document.getElementById('modalNotaOncologiaMedica'));
        };
      } else {
        btnBackToOnco.style.display = 'none';
        btnBackToOnco.onclick = null;
      }
    }
    if (successOverlay) successOverlay.style.display = 'flex';
  } catch (error) {
    console.error('Error al guardar orden de laboratorio:', error);
    showClivoraAlertModal('No se pudo guardar la orden de laboratorio.');
  }
}

// ============================
// Recetas independientes
// ============================
let clivoraPatientRecipeHeaders = [];
let clivoraActiveRecipeHeaderId = null;
let clivoraRecipeHeaderModalMode = 'create';
// Nota de Oncología Médica de origen (Receta Médica u Oncológica abierta
// desde sus botones de Acciones Especiales) — null = receta independiente
// (abierta desde la pestaña Recetas Médicas). Ver openRecetaMedicaModal/
// openRecetaOncologicaModal y renderVinculoBadge.
let clivoraActiveRecipeHeaderConsultationId = null;

function formatRecipeDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-MX');
}

async function loadPatientRecipes(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/recipe_headers`, { cache: 'no-store' });
    clivoraPatientRecipeHeaders = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar recetas del paciente:', error);
    clivoraPatientRecipeHeaders = [];
  }
  renderRecipesList();
}

function renderRecipesList() {
  const container = document.getElementById('recipesListContainer');
  if (!container) return;

  if (clivoraPatientRecipeHeaders.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No hay recetas registradas para este paciente.</p>';
    syncRecipeDetailCardHeight();
    return;
  }

  // Mismo diseño de tarjeta que la pestaña Notas (.file-card: ícono propio,
  // fila de doctor, fila de fecha) — antes esta lista usaba .hc-section-item
  // "pelón" (solo título + paciente en texto plano, sin ícono ni fecha).
  container.innerHTML = clivoraPatientRecipeHeaders.map(rec => {
    const isOnco = rec.recipe_type === 'oncological';
    const iconBg = isOnco ? '#FEE2E2' : '#FEF3C7';
    const iconColor = isOnco ? '#EF4444' : '#D97706';
    const iconSvg = isOnco
      ? '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'
      : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>';
    return `
    <div class="file-card recipe-card ${String(rec.id) === String(clivoraActiveRecipeHeaderId) ? 'active-card' : ''}" data-id="${rec.id}" style="cursor: pointer; margin-bottom: 8px;">
      <div class="file-card-icon" style="background-color: ${iconBg}; color: ${iconColor}; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconSvg}</svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 13px; font-weight: 800; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${isOnco ? 'Receta Oncológica' : 'Receta Médica'} #${String(rec.id).padStart(3, '0')}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${rec.doctor_name || 'Sin doctor asignado'}
        </div>
        <div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; margin-top: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          ${formatClivoraDateTime(rec.create_date)}
        </div>
      </div>
    </div>
  `;
  }).join('');

  container.querySelectorAll('.recipe-card').forEach(card => {
    card.onclick = () => showRecipeDetail(parseInt(card.dataset.id, 10));
  });
  syncRecipeDetailCardHeight();
}

// Pestaña "Ventas" del expediente — lista de ventas del paciente
// (partner_id), sin importar si vinieron de un Tratamiento/Cita o se
// crearon directo desde aquí con "+ Nueva Venta" (ver
// openNuevaVentaPacienteModal). "Ver" reutiliza el mismo modal de solo
// lectura que ya usan Agenda y Tratamientos (openVentaViewModal).
let clivoraPatientSaleOrders = [];
const PATIENT_SALE_STATE_COLORS = {
  draft: '#64748B', sent: '#2563EB', sale: '#16A34A', done: '#2F4C8A', cancel: '#DC2626',
};

async function loadPatientSaleOrders(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/sale_orders`, { cache: 'no-store' });
    clivoraPatientSaleOrders = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar ventas del paciente:', error);
    clivoraPatientSaleOrders = [];
  }
  renderPatientSaleOrdersList();
}

function renderPatientSaleOrdersList() {
  const container = document.getElementById('patientSalesListContainer');
  const countLabel = document.getElementById('patientSalesCountLabel');
  if (countLabel) countLabel.textContent = `${clivoraPatientSaleOrders.length} venta(s)`;
  if (!container) return;

  if (clivoraPatientSaleOrders.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px 16px; text-align: center; color: var(--text-muted); font-size: 12px; background: var(--bg-main); border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        Este paciente no tiene ventas registradas.
      </div>
    `;
    return;
  }

  container.innerHTML = clivoraPatientSaleOrders.map(o => {
    const color = PATIENT_SALE_STATE_COLORS[o.state] || '#64748B';
    return `
      <div class="sale-order-item" data-order-id="${o.id}" style="background: var(--bg-card); border-left: 4px solid ${color}; padding: 12px 16px; border-radius: var(--radius-md); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; gap: 12px; cursor: pointer; margin-bottom: 8px;">
        <div>
          <div style="font-weight: 700; font-size: 13px; color: var(--text-main);">${o.name}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${o.dateOrder || 'Sin fecha'}</div>
        </div>
        <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
          <span style="font-size: 10px; font-weight: 800; color: ${color}; text-transform: uppercase;">${o.stateLabel}</span>
          <span style="font-size: 13px; font-weight: 700; color: var(--text-main);">$${(o.amountTotal || 0).toFixed(2)}</span>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.sale-order-item').forEach(item => {
    item.onclick = () => openVentaViewModal(parseInt(item.dataset.orderId, 10));
  });
}

function showRecipeEmptyState() {
  clivoraActiveRecipeHeaderId = null;
  const detail = document.getElementById('recipeDetailCard');
  if (!detail) return;
  detail.classList.add('empty-state-container');
  detail.innerHTML = `
    <div class="empty-state-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="1.5">
        <path d="M10.5 20H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v3" />
        <circle cx="18" cy="18" r="3" />
        <path d="m22 22-1.5-1.5" />
      </svg>
    </div>
    <h3 class="empty-state-title">Selecciona una receta</h3>
    <p class="empty-state-desc">Haz clic en una receta de la lista para ver sus detalles o crea una nueva</p>
  `;
  renderRecipesList();
}

async function showRecipeDetail(headerId) {
  const rec = clivoraPatientRecipeHeaders.find(r => String(r.id) === String(headerId));
  if (!rec) return;
  clivoraActiveRecipeHeaderId = headerId;
  const detail = document.getElementById('recipeDetailCard');
  if (!detail) return;
  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';
  const recipeCreatedMeta = buildCreatedUpdatedMetaHtml(
    formatClivoraDateTime(rec.create_date), rec.createdBy,
    formatClivoraDateTime(rec.write_date), rec.updatedBy,
    { model: 'receta', id: rec.id });
  detail.classList.remove('empty-state-container');
  detail.innerHTML = `
    <div
      class="expediente-detail-header"
      style="font-size: 15px; font-weight: 800; color: var(--text-main); margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 14px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary-blue)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
          <path d="M10.5 20H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v3" />
          <circle cx="18" cy="18" r="3" />
          <path d="m22 22-1.5-1.5" />
        </svg>
        <div style="min-width: 0;">
          <span>${rec.recipe_type === 'oncological' ? 'Receta oncológica' : 'Receta médica'} del paciente ${activePatientName}</span>
          ${recipeCreatedMeta}
        </div>
      </div>
      <div class="expediente-detail-header-actions" style="display: flex; gap: 8px;">
        <button type="button" class="btn-secondary btn-anim-lift" id="btnPrintRecipeHeader" style="padding: 6px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Imprimir
        </button>
        <button type="button" class="btn-secondary btn-anim-lift" id="btnDownloadRecipeHeader" style="padding: 6px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Descargar PDF
        </button>
        <button type="button" class="btn-secondary btn-anim-lift" id="btnEditRecipeHeader" style="padding: 6px 14px; font-size: 12px;">Editar</button>
        <button type="button" class="btn-secondary btn-anim-lift" id="btnCreateQuoteRecipeHeader" style="padding: 6px 14px; font-size: 12px;"
          title="${rec.saleOrderId ? `Ver la venta de desglose ${rec.saleOrderName || ''}` : 'Generar la venta en estado Desglose de esta receta'}">
          ${rec.saleOrderId ? 'Ver desglose' : 'Crear desglose'}
        </button>
        <button type="button" class="btn-anim-lift" id="btnDeleteRecipeHeader" style="background: none; border: none; cursor: pointer; color: #EF4444;" title="Eliminar receta">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
        </button>
      </div>
    </div>

    <div id="rdVinculoBanner" style="padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; display: flex; align-items: center; gap: 8px; margin-bottom: 14px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span id="rdVinculoBadgeText"></span>
    </div>

    <!-- DATOS GENERALES DEL PACIENTE -->
    <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 14px;">
      <div style="font-size: 11px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary-blue)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Datos Generales del Paciente
      </div>
      <div class="familiar-row-2col" style="gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
        <div class="familiar-field-group" style="margin-bottom: 0;">
          <label>PACIENTE</label>
          <input type="text" class="familiar-input" id="rdPacienteNombre" readonly style="background: var(--bg-card); font-weight: 700; color: var(--text-main);">
        </div>
        <div class="familiar-field-group" style="margin-bottom: 0;">
          <label>FECHA NAC / EDAD</label>
          <input type="text" class="familiar-input" id="rdFechaNacEdad" readonly style="background: var(--bg-card); font-weight: 700; color: var(--text-main);">
        </div>
        <div class="familiar-field-group" style="margin-bottom: 0;">
          <label>GÉNERO / GRUPO RH</label>
          <input type="text" class="familiar-input" id="rdGenero" readonly style="background: var(--bg-card); font-weight: 700; color: var(--text-main);">
        </div>
        ${rec.recipe_type === 'oncological' ? '' : `
        <div class="familiar-field-group" style="margin-bottom: 0;">
          <label>TALLA (cm) / PESO (kg)</label>
          <input type="text" class="familiar-input" id="rdTallaPeso" readonly style="background: var(--bg-card); font-weight: 700; color: var(--text-main);">
        </div>`}
        <div class="familiar-field-group" style="margin-bottom: 0;">
          <label>EXPEDIENTE</label>
          <input type="text" class="familiar-input" id="rdExpediente" readonly style="background: var(--bg-card); font-weight: 700; color: var(--text-main);">
        </div>
        <div class="familiar-field-group" style="margin-bottom: 0;">
          <label>MÉDICO TRATANTE</label>
          <input type="text" class="familiar-input" id="rdMedicoTratante" readonly style="background: var(--bg-card); font-weight: 700; color: var(--text-main);">
        </div>
        <div class="familiar-field-group" style="margin-bottom: 0; grid-column: span 2;">
          <label>ALERGIAS</label>
          <input type="text" class="familiar-input" id="rdAlergias" readonly style="background: #FEF2F2; border-color: #FCA5A5; color: #B91C1C; font-weight: 700;">
        </div>
        ${rec.recipe_type === 'oncological' ? `
        <div class="familiar-field-group" style="margin-bottom: 0; grid-column: 1 / -1;">
          <label>DIAGNÓSTICO</label>
          <div class="familiar-input" style="background: var(--bg-card); font-weight: 700; color: var(--text-main); white-space: pre-line; height: auto; min-height: 42px; padding: 10px 12px;">${escapeHtml(rec.general_diagnosis || 'Sin diagnóstico registrado.')}</div>
        </div>` : ''}
      </div>
    </div>

    ${rec.recipe_type === 'oncological' ? `
      <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">1. Datos Principales del Paciente</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
          ${[
            ['Número de Ciclo', rec.cycle_number], ['Aplicación', rec.application_day],
            ['Fecha de Creación', formatRecipeDate(rec.create_date)], ['Próximo Tratamiento', formatRecipeDate(rec.next_treatment_date)],
          ].map(([label, val]) => `
            <div class="form-group">
              <label style="font-size: 10px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; display: block;">${label}</label>
              <div style="font-size: 13px; color: var(--text-main); font-weight: 700;">${val || '—'}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">2. Signos Vitales del Paciente</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px;">
          ${[
            // Mismos nombres y orden que la tarjeta de Signos Vitales.
            ['PA Sistólica (mmHg)', (rec.blood_pressure || '').split('/')[0]],
            ['PA Diastólica (mmHg)', (rec.blood_pressure || '').split('/')[1]],
            ['FC (lpm)', rec.heart_rate], ['FR (rpm)', rec.respiratory_rate], ['Temp (°C)', rec.temperature],
            ['Sat O₂ (%)', rec.oxygen_saturation], ['Peso (kg)', rec.weight], ['Altura (cm)', rec.height],
            ['BSA DuBois (m²)', rec.body_surface_area], ['IMC (kg/m²)', rec.body_mass_index],
          ].map(([label, val]) => `
            <div class="form-group">
              <label style="font-size: 10px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; display: block;">${label}</label>
              <div style="font-size: 13px; color: var(--text-main); font-weight: 700;">${val || '0'}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">3. Tratamientos Oncológicos</div>
        ${(rec.lines || []).length === 0 ? '<p style="color: var(--text-muted); font-size: 13px; margin: 0;">Sin tratamientos.</p>' : `
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <tbody>
              ${rec.lines.map((line, i) => `
                <tr style="border-bottom: 1px solid var(--border-color);">
                  <td style="padding: 8px 10px; font-weight: 700; color: #2F4C8A; white-space: nowrap; vertical-align: top;">Tratamiento ${i + 1}</td>
                  <td style="padding: 8px 10px; color: var(--text-main);">${line.product || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">4. Premedicación Estándar</div>
        <div style="font-size: 13px; color: var(--text-main); white-space: pre-line;">${rec.premedication_description || 'Sin premedicación registrada.'}</div>
      </div>

      <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
        <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">5. Postmedicación Estándar</div>
        <div style="font-size: 13px; color: var(--text-main); white-space: pre-line;">${rec.postmedication_description || 'Sin postmedicación registrada.'}</div>
      </div>
    ` : `
      <div class="form-group" style="margin-bottom: 18px;">
        <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">Médico Prescriptor</label>
        <div style="font-size: 13px; color: var(--text-main); font-weight: 700;">${rec.doctor_name || '—'}</div>
      </div>

      <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: block;">Medicamentos Prescritos</label>
      ${(rec.lines || []).length === 0 ? '<p style="color: var(--text-muted); font-size: 13px;">Sin medicamentos.</p>' : `
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 20px;">
          <thead>
            <tr style="background: var(--bg-main); text-align: left;">
              <th style="padding: 8px 10px; border: 1px solid var(--border-color);">Medicamento</th>
              <th style="padding: 8px 10px; border: 1px solid var(--border-color);">Dosis / Indicaciones</th>
              <th style="padding: 8px 10px; border: 1px solid var(--border-color);">Notas</th>
            </tr>
          </thead>
          <tbody>
            ${rec.lines.map(line => `
              <tr>
                <td style="padding: 8px 10px; border: 1px solid var(--border-color); font-weight: 700; color: var(--text-main);">${line.product || '—'}</td>
                <td style="padding: 8px 10px; border: 1px solid var(--border-color); color: var(--text-main);">${line.indications || '—'}</td>
                <td style="padding: 8px 10px; border: 1px solid var(--border-color); color: var(--text-main);">${line.notes || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}

      <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: block;">Notas y Recomendaciones Generales</label>
      <div class="nopat-card" style="display: flex; align-items: center; min-height: 48px; padding: 14px 18px; font-size: 13px; color: var(--text-main); white-space: pre-line; width: 100%; box-sizing: border-box;">${rec.notes || 'Sin notas registradas.'}</div>
    `}
  `;
  renderVinculoBadge('rdVinculoBanner', 'rdVinculoBadgeText', rec.clinic_consultations_id || null,
    rec.recipe_type === 'oncological' ? 'Receta Oncológica' : 'Receta Médica');
  await populatePatientHeaderInfo('rd');
  renderRecipesList();
}

// Fila de la tabla "4. Tratamientos Oncológicos" de Receta Oncológica —
// portado de la versión anterior del diseño (modalRecetaOncologica): una sola
// descripción libre por tratamiento ("Paclitaxel 260 mg en Solución
// Fisiológica 0.9% 500 mL para 3 hrs IV") en vez de las 3 columnas
// producto/indicaciones/notas que usa la Receta Médica estándar — se
// mapea al mismo campo `product` de la receta (ya está pensado para
// texto libre en este caso, ver el modelo). El número "Tratamiento N" se
// recalcula en renumberRecetaOncoTratamientos, no se guarda como dato.
function buildRecetaOncoTratamientoRowHtml(value, rowId) {
  const escapeAttr = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
  return `
    <tr class="receta-onco-tratamiento-row" id="${rowId}" style="border-bottom: 1px solid var(--border-color);">
      <td class="receta-onco-tratamiento-label" style="padding: 8px 10px; font-weight: 700; color: #2F4C8A; white-space: nowrap;"></td>
      <td style="padding: 8px 10px;">
        <input type="text" class="receta-onco-tratamiento-input" placeholder="Ej: Paclitaxel 260 mg en Solución Fisiológica 0.9% 500 mL para 3 hrs IV" value="${escapeAttr(value)}" style="width: 100%; box-sizing: border-box; font-size: 12px; height: 38px; padding: 0 8px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
      </td>
      <td style="padding: 8px 10px; text-align: center;">
        <button type="button" class="btn-delete-onco-tratamiento btn-remove-med btn-anim-lift" title="Eliminar tratamiento"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </td>
    </tr>`;
}

// Vuelve a numerar "Tratamiento 1", "Tratamiento 2"... en orden de fila —
// necesario después de agregar/quitar filas para que nunca queden huecos
// (ej. Tratamiento 1, 3, 4 tras borrar el 2).
function renumberRecetaOncoTratamientos() {
  const container = document.getElementById('recetaOncologicaLinesContainer');
  if (!container) return;
  container.querySelectorAll('.receta-onco-tratamiento-row').forEach((row, index) => {
    const label = row.querySelector('.receta-onco-tratamiento-label');
    if (label) label.textContent = `Tratamiento ${index + 1}`;
  });
}

// Encabezado "Datos Generales del Paciente (e Ingreso)" — compartido por la
// Nota de Oncología Médica, la Receta Médica y la Receta Oncológica (mismo
// bloque visual, mismos datos: nombre/fecha nac./edad/género/grupo RH/talla-
// peso/expediente/médico tratante/alergias/fecha de ingreso). `prefix` es el
// prefijo de los ids en el HTML de cada modal (ej. "onco", "rm", "ro") — cada
// campo del bloque es `${prefix}NombreDelCampo`, y si un modal no tiene
// alguno de esos ids (ej. Receta Médica no tiene "FechaIngreso" propio) el
// `if (el)` correspondiente simplemente no hace nada.
// Mismo resumen de alergias que ya arma populatePatientHeaderInfo (lista
// estructurada de alergias, con fallback
// al texto libre de "Observaciones sobre alergias" de Historia Clínica) pero
// como función aparte para reusarlo en modales que no siguen el patrón de
// prefijos de esa función (ej. Evaluación Inicial de Enfermería, con ids
// "eiTalla"/"eiPeso"/"eiExpediente" en vez de "eiTallaPeso"/un solo campo).
async function fetchPatientAllergiesSummary(patientId) {
  if (!patientId) return 'Sin alergias conocidas';
  try {
    const [responseAllergies, responseHc, hcCatalogs] = await Promise.all([
      fetch(`/clivora/api/patients/${patientId}/allergies`, { cache: 'no-store' }),
      fetch(`/clivora/api/patients/${patientId}`, { cache: 'no-store' }),
      ensureHcCatalogs(),
    ]);
    if (!responseAllergies.ok) return 'Sin alergias conocidas';
    const allergies = await responseAllergies.json();
    const patientData = responseHc.ok ? await responseHc.json() : null;
    const hc = patientData?.historia_clinica || {};
    const summary = allergies.map(a => {
      const reaction = hcCatalogs.allergy_reactions.find(r => r.id === a.allergy_reaction_id)?.name || '';
      return [a.allergy_description, reaction].filter(Boolean).join(' — ');
    }).filter(Boolean).join('; ');
    return summary || stripHtml(hc.allergies_observations) || 'Sin alergias conocidas';
  } catch (error) {
    console.error('Error al cargar alergias del paciente:', error);
    return 'Sin alergias conocidas';
  }
}

async function populatePatientHeaderInfo(prefix) {
  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || 'Paciente';
  const nombreEl = document.getElementById(`${prefix}PacienteNombre`);
  if (nombreEl) nombreEl.value = activePatientName;

  const expedienteEl = document.getElementById(`${prefix}Expediente`);
  if (expedienteEl) expedienteEl.value = document.getElementById('detailPatientExp')?.textContent?.trim() || '';

  const generoEl = document.getElementById(`${prefix}Genero`);
  if (generoEl) {
    const generoSelect = document.getElementById('detailGenero');
    generoEl.value = generoSelect?.options[generoSelect.selectedIndex]?.textContent?.trim() || '';
  }

  const fechaNacEdadEl = document.getElementById(`${prefix}FechaNacEdad`);
  if (fechaNacEdadEl) {
    const fechaNac = document.getElementById('detailFechaNacimiento')?.value || '';
    const edad = document.getElementById('detailEdad')?.value || '';
    fechaNacEdadEl.value = [fechaNac, edad].filter(Boolean).join(' / ');
  }

  const medicoEl = document.getElementById(`${prefix}MedicoTratante`);
  if (medicoEl) {
    const doctorSelect = document.getElementById('detailDoctor');
    medicoEl.value = doctorSelect?.options[doctorSelect.selectedIndex]?.textContent?.trim() || '';
  }

  const alergiasEl = document.getElementById(`${prefix}Alergias`);
  if (alergiasEl) alergiasEl.value = 'Sin alergias conocidas';

  const fechaIngresoEl = document.getElementById(`${prefix}FechaIngreso`);
  if (fechaIngresoEl) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    fechaIngresoEl.value = now.toISOString().slice(0, 16);
    // Asignar .value por JS no dispara 'change' — el widget de fecha+hora
    // personalizado (enhanceCustomDatePicker) solo refresca el texto del
    // botón visible (y la hora que precarga su panel) al escuchar ese
    // evento en el input real. Sin esto, el botón se quedaba mostrando
    // "dd/mm/aaaa" (su estado inicial, de cuando el campo todavía estaba
    // vacío) para siempre, aunque el input ya tuviera la fecha/hora actual
    // cargada por dentro.
    fechaIngresoEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const tallaPesoEl = document.getElementById(`${prefix}TallaPeso`);
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;

  // Talla/Peso: el registro real de signos vitales más reciente del
  // paciente (mismo patrón que ya usaba la Nota de Oncología Médica). Si el
  // paciente todavía no tiene signos vitales registrados, el campo se deja
  // editable (en vez de "readonly" y vacío, que se ve como un campo roto e
  // imposible de llenar) para que el médico pueda anotarlo a mano.
  if (tallaPesoEl) {
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}/consultations`, { cache: 'no-store' });
      if (response.ok) {
        const consultas = await response.json();
        const latestSV = consultas.find(c => c.source === 'vitals') || null;
        const talla = latestSV?.altura ? `${latestSV.altura} cm` : '';
        const peso = latestSV?.peso ? `${latestSV.peso} kg` : '';
        const combined = [talla, peso].filter(Boolean).join(' | ');
        tallaPesoEl.value = combined;
        tallaPesoEl.readOnly = !!combined;
        tallaPesoEl.style.background = combined ? 'var(--bg-main)' : 'var(--bg-card)';
      }
    } catch (error) {
      console.error('Error al cargar signos vitales para encabezado de paciente:', error);
    }
  }

  // Grupo Sanguíneo/RH y Alergias: se precargan con lo ya capturado en la
  // Historia Clínica del paciente (blood_group/blood_rh_factor y la lista
  // real de alergias) en vez de dejar el
  // texto fijo "Sin alergias conocidas" sin importar el paciente.
  try {
    const [responseHc, responseAllergies, hcCatalogs] = await Promise.all([
      fetch(`/clivora/api/patients/${patientId}`, { cache: 'no-store' }),
      fetch(`/clivora/api/patients/${patientId}/allergies`, { cache: 'no-store' }),
      ensureHcCatalogs(),
    ]);
    const patientData = responseHc.ok ? await responseHc.json() : null;
    const hc = patientData?.historia_clinica || {};
    if (generoEl) {
      const bloodGroup = hc.blood_group || '';
      const bloodRh = hc.blood_rh_factor || '';
      const grupoRh = `${bloodGroup}${bloodRh}`.trim();
      if (grupoRh) generoEl.value = [generoEl.value, grupoRh].filter(Boolean).join(' | ');
    }
    if (responseAllergies.ok && alergiasEl) {
      const allergies = await responseAllergies.json();
      const summary = allergies.map(a => {
        const reaction = hcCatalogs.allergy_reactions.find(r => r.id === a.allergy_reaction_id)?.name || '';
        return [a.allergy_description, reaction].filter(Boolean).join(' — ');
      }).filter(Boolean).join('; ');
      // Si no hay renglones en la lista estructurada de alergias, el médico
      // pudo haber capturado la información como texto libre en la Sección 1
      // (Antecedentes Médicos > Alergias > "Observaciones sobre alergias")
      // en vez de agregar un renglón — sin este fallback esa observación se
      // perdía y siempre se mostraba "Sin alergias conocidas" aunque el
      // expediente sí tuviera algo capturado.
      alergiasEl.value = summary || stripHtml(hc.allergies_observations) || 'Sin alergias conocidas';
    }
  } catch (error) {
    console.error('Error al cargar historia clínica/alergias para encabezado de paciente:', error);
  }
}

function buildRecetaMedicaLineHtml(line, cardId) {
  const r = line || {};
  const escapeAttr = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
  return `
    <tr class="receta-medica-line" id="${cardId}" data-record-id="${r.id || ''}">
      <td style="padding: 6px 8px; border: 1px solid var(--border-color);">
        <input type="text" class="rm-line-product" placeholder="Ej: Paracetamol 500mg" value="${escapeAttr(r.product)}" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
      </td>
      <td style="padding: 6px 8px; border: 1px solid var(--border-color);">
        <input type="text" class="rm-line-indications" placeholder="Ej: 1 tableta c/8h x 5 días" value="${escapeAttr(r.indications)}" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
      </td>
      <td style="padding: 6px 8px; border: 1px solid var(--border-color);">
        <input type="text" class="rm-line-notes" placeholder="Ej: Tomar con alimento" value="${escapeAttr(r.notes)}" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
      </td>
      <td style="padding: 6px 8px; border: 1px solid var(--border-color); text-align: center;">
        <button type="button" class="btn-remove-med btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </td>
    </tr>`;
}

// Todos los .modal-overlay comparten z-index:100 (ver styles.css), así que
// cuál queda encima depende del orden en el DOM, no de cuál se abrió último.
// El flujo de recetas (Seleccionar Tipo → Receta Médica/Oncológica) se puede
// abrir desde dentro de la Nota Oncológica, que está más abajo en el HTML —
// sin esto, esos modales quedaban tapados detrás de la nota ya abierta.
// Botones "Descargar PDF" (Órdenes, Recetas y Notas): el mismo PDF que abre
// "Imprimir", pero con ?download=1 para que el servidor lo mande como
// descarga (Content-Disposition: attachment, ver _pdf_disposition).
function clivoraDownloadPdf(url) {
  const link = document.createElement('a');
  link.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function showModalOnTop(modal) {
  if (!modal) return;
  document.body.appendChild(modal);
  modal.style.display = 'flex';
}

async function openRecetaMedicaModal(mode, headerId, sourceConsultationId) {
  clivoraRecipeHeaderModalMode = mode;
  clivoraActiveRecipeHeaderId = headerId || null;

  const titleEl = document.getElementById('crearRecetaMedicaTitle');
  if (titleEl) titleEl.textContent = mode === 'edit' ? 'Editar Receta Médica' : 'Crear Receta Médica';

  await populatePatientHeaderInfo('rm');

  const doctorSelect = document.getElementById('rmMedicoPrescriptor');
  const notesEl = document.getElementById('rmNotasGenerales');
  const linesContainer = document.getElementById('recetaMedicaLinesContainer');

  const rec = mode === 'edit'
    ? clivoraPatientRecipeHeaders.find(r => String(r.id) === String(headerId))
    : null;

  // Al editar, el vínculo ya quedó fijo desde que se creó la receta (viene
  // del registro guardado); al crear, es el id de la Nota de Oncología
  // Médica que se acaba de guardar (ver ensureOncoNotaSaved) — o null si el
  // modal se abrió directo desde la pestaña Recetas Médicas ("independiente").
  clivoraActiveRecipeHeaderConsultationId = rec
    ? (rec.clinic_consultations_id || null)
    : (sourceConsultationId || null);
  renderVinculoBadge('rmVinculoBanner', 'rmVinculoBadgeText', clivoraActiveRecipeHeaderConsultationId, 'Receta Médica');

  // Precarga el médico asignado actual del paciente — también al editar,
  // para que una receta editada después de cambiar el médico asignado tome
  // al nuevo (si el paciente no tiene, se conserva el ya guardado). Queda
  // editable por si el médico está de vacaciones y prescribe otro.
  let defaultDoctorId = rec ? rec.doctor_id : null;
  if (window.clivoraCurrentPatientId) {
    try {
      const response = await fetch(`/clivora/api/patients/${window.clivoraCurrentPatientId}`, { cache: 'no-store' });
      const patientData = response.ok ? await response.json() : null;
      defaultDoctorId = patientData?.info_general?.doctorId || defaultDoctorId;
    } catch (error) {
      console.error('Error al precargar el médico asignado:', error);
    }
  }

  if (doctorSelect) await populateCitaDoctorSelect(doctorSelect, defaultDoctorId);

  // Al crear una receta médica nueva, se precarga con los medicamentos y
  // notas de la última receta médica ya guardada del paciente (mismo
  // criterio que ya usa Nota de Oncología Médica con su "última nota") —
  // el médico solo edita lo que cambió en vez de volver a escribir todo.
  // Solo mira recipe_type distinto de 'oncological': una Receta Oncológica
  // tiene su propio flujo de precarga aparte (openRecetaOncologicaModal).
  let lastMedica = null;
  if (!rec && window.clivoraCurrentPatientId) {
    try {
      const response = await fetch(`/clivora/api/patients/${window.clivoraCurrentPatientId}/recipe_headers`, { cache: 'no-store' });
      const headers = response.ok ? await response.json() : [];
      lastMedica = headers.find(h => h.recipe_type !== 'oncological') || null;
    } catch (error) {
      console.error('Error al precargar la última receta médica:', error);
    }
  }

  const sourceMedica = rec || lastMedica;
  setEditableFieldValue(notesEl, sourceMedica ? (sourceMedica.notes || '') : '');
  if (linesContainer) {
    const lines = sourceMedica && sourceMedica.lines && sourceMedica.lines.length ? sourceMedica.lines : [{}];
    linesContainer.innerHTML = lines
      .map((line, index) => buildRecetaMedicaLineHtml(line, `rm-line-${line.id || `new-${index}`}`))
      .join('');
  }

  showModalOnTop(document.getElementById('modalCrearRecetaMedica'));
}

async function saveRecetaMedica() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const doctorSelect = document.getElementById('rmMedicoPrescriptor');
  const notesEl = document.getElementById('rmNotasGenerales');
  const linesContainer = document.getElementById('recetaMedicaLinesContainer');
  const lines = linesContainer ? Array.from(linesContainer.querySelectorAll('.receta-medica-line')).map(row => ({
    id: row.dataset.recordId ? parseInt(row.dataset.recordId, 10) : undefined,
    product: row.querySelector('.rm-line-product')?.value.trim() || '',
    indications: row.querySelector('.rm-line-indications')?.value.trim() || '',
    notes: row.querySelector('.rm-line-notes')?.value.trim() || '',
  })) : [];

  if (!lines.some(l => l.product)) {
    showClivoraAlertModal('Agrega al menos un medicamento con nombre.');
    return;
  }

  const payload = {
    doctor_id: doctorSelect && doctorSelect.value ? parseInt(doctorSelect.value, 10) : false,
    notes: getEditableFieldValue(notesEl),
    lines,
    // Solo tiene efecto al crear (el backend la ignora en el update, que
    // nunca la manda) — ver _recipe_header_vals_from_payload.
    clinic_consultations_id: clivoraActiveRecipeHeaderConsultationId || false,
  };
  const url = clivoraRecipeHeaderModalMode === 'edit'
    ? `/clivora/api/recipe_headers/${clivoraActiveRecipeHeaderId}`
    : `/clivora/api/patients/${patientId}/recipe_headers`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar la receta.'));
      return;
    }
    const saved = await response.json();
    await loadPatientRecipes(patientId);
    // Si esta receta se generó vinculada a la Nota de Oncología Médica
    // abierta detrás, su tarjeta en "Documentos generados desde esta nota"
    // no se refrescaba sola — quedaba desactualizada hasta el próximo
    // ensureOncoNotaSaved() disparado por otra acción (ej. "Guardar Nota").
    if (clivoraActiveRecipeHeaderConsultationId) await ensureOncoNotaSaved();

    const successOverlay = document.getElementById('recetaMedicaSuccessOverlay');
    const btnNew = document.getElementById('btnNextNewRecetaMedica');
    const btnView = document.getElementById('btnNextViewRecetaMedica');
    const btnBackToOnco = document.getElementById('btnNextBackToOncoNota');
    if (btnNew) {
      btnNew.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        openRecetaMedicaModal('create');
      };
    }
    if (btnView) {
      btnView.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        const modal = document.getElementById('modalCrearRecetaMedica');
        if (modal) modal.style.display = 'none';
        if (saved && saved.id) showRecipeDetail(saved.id);
      };
    }
    // Solo se ofrece "Regresar a la nota oncológica" cuando esta receta se
    // generó desde el botón "Generar Receta Médica" DENTRO de
    // #modalNotaOncologiaMedica (ver btnAgregarRecetaOnco) — esa nota nunca
    // se cerró de fondo (showModalOnTop solo la tapa reordenando el DOM), así
    // que basta con esconder este modal para que vuelva a quedar visible.
    if (btnBackToOnco) {
      if (clivoraActiveRecipeHeaderConsultationId) {
        btnBackToOnco.style.display = 'inline-flex';
        btnBackToOnco.onclick = () => {
          if (successOverlay) successOverlay.style.display = 'none';
          const modal = document.getElementById('modalCrearRecetaMedica');
          if (modal) modal.style.display = 'none';
          showModalOnTop(document.getElementById('modalNotaOncologiaMedica'));
        };
      } else {
        btnBackToOnco.style.display = 'none';
        btnBackToOnco.onclick = null;
      }
    }
    if (successOverlay) successOverlay.style.display = 'flex';
  } catch (error) {
    console.error('Error al guardar receta médica:', error);
    showClivoraAlertModal('No se pudo guardar la receta.');
  }
}

// Texto estándar de Premedicación/Postmedicación de Receta Oncológica: antes
// solo vivían como "placeholder" del <textarea> (un ejemplo de una sola
// línea, truncado) — nunca se guardaba nada si el médico no escribía todo de
// nuevo. Se usan como valor por defecto cuando el campo llega vacío (nota
// nueva, o una ya guardada sin este texto capturado).
const RECETA_ONCO_PREMEDICACION_DEFAULT =
  'Solucion fisiológica al 0.9 % 250 mL + Dexametasona 8 mg + Ondasetron 8 mg + Difenhidramina 20 mg para 15 minutos D1';
const RECETA_ONCO_POSTMEDICACION_DEFAULT = `1.- DECOREX 6 MG
tomar 1 tableta via oral por dia por 3 dias posterior a QT (1 antes de la QT)
2.- PANTOPRAZOL 40 MG
tomar 1 tableta via oral cada 12 hrs por 3 días posterior a QT
3.- APREPITANT 125/80 MG
tomar 1 tableta via oral diaria por 3 dias posterior a quimio

EN CASO DE NAUSEA PERSISTENTE
4.- ONDASETRON 8 mg
tomar 1 tableta vía oral cada 12 hrs x 3 dias posterior a QT`;

// Receta Oncológica: prescripción independiente que se entrega al paciente
// (ciclo, aplicación, signos vitales, diagnóstico y medicamentos) — distinta
// de la Nota Oncológica, que es la nota clínica completa de la consulta.
async function openRecetaOncologicaModal(mode, headerId, sourceConsultationId) {
  clivoraRecipeHeaderModalMode = mode || 'create';
  clivoraActiveRecipeHeaderId = headerId || null;

  const titleEl = document.getElementById('crearRecetaOncologicaTitle');
  if (titleEl) titleEl.textContent = clivoraRecipeHeaderModalMode === 'edit' ? 'Editar Receta Oncológica' : 'Receta Oncológica';

  await populatePatientHeaderInfo('ro');

  const existing = clivoraRecipeHeaderModalMode === 'edit'
    ? clivoraPatientRecipeHeaders.find(r => String(r.id) === String(headerId))
    : null;

  // Al crear una receta oncológica nueva, se precarga con el ciclo,
  // tratamientos y premedicación/postmedicación/dilución de la última
  // receta oncológica ya guardada del paciente — mismo criterio que
  // openRecetaMedicaModal con su "última receta médica". El diagnóstico
  // (roGeneralDiagnosis) y los signos vitales NO salen de aquí: siguen su
  // propia fuente más abajo (Historia Clínica / expediente), ver los
  // comentarios en ese bloque.
  let lastOnco = null;
  if (!existing && window.clivoraCurrentPatientId) {
    try {
      const response = await fetch(`/clivora/api/patients/${window.clivoraCurrentPatientId}/recipe_headers`, { cache: 'no-store' });
      const headers = response.ok ? await response.json() : [];
      lastOnco = headers.find(h => h.recipe_type === 'oncological') || null;
    } catch (error) {
      console.error('Error al precargar la última receta oncológica:', error);
    }
  }
  const sourceOnco = existing || lastOnco;

  // Mismo criterio que openRecetaMedicaModal: al editar, el vínculo viene del
  // registro guardado; al crear, es el id de la Nota de Oncología Médica
  // recién guardada (ensureOncoNotaSaved) o null si se abrió directo desde
  // la pestaña Recetas Médicas ("independiente").
  clivoraActiveRecipeHeaderConsultationId = existing
    ? (existing.clinic_consultations_id || null)
    : (sourceConsultationId || null);
  renderVinculoBadge('roVinculoBanner', 'roVinculoBadgeText', clivoraActiveRecipeHeaderConsultationId, 'Receta Oncológica');

  ['roCycleNumber', 'roApplicationDay', 'roNextTreatmentDate', 'roWeight', 'roHeight',
    'roBloodPressure', 'roPASistolica', 'roPADiastolica', 'roHeartRate', 'roRespiratoryRate', 'roTemperature',
    'roOxygenSaturation', 'roBodySurfaceArea', 'roBodyMassIndex', 'roGeneralDiagnosis',
    'txtPremedicacionEstandar', 'txtPostmedicacionEstandar'].forEach(id => {
    setEditableFieldValue(document.getElementById(id), '');
  });

  if (sourceOnco) {
    const setVal = (id, val) => {
      if (val !== undefined && val !== null && val !== false) setEditableFieldValue(document.getElementById(id), val);
    };
    setVal('roCycleNumber', sourceOnco.cycle_number);
    setVal('roApplicationDay', sourceOnco.application_day);
    setVal('roNextTreatmentDate', sourceOnco.next_treatment_date);
    // Los 9 campos de Signos Vitales (roWeight...roBodyMassIndex) ya NO se
    // cargan desde sourceOnco.* aquí: son de solo lectura y siempre reflejan
    // el signo vital más reciente del expediente (ver el fetch más abajo),
    // no la foto congelada de cuando se creó esa receta.
    setVal('txtPremedicacionEstandar', sourceOnco.premedication_description);
    setVal('txtPostmedicacionEstandar', sourceOnco.postmedication_description);
  }
  // roGeneralDiagnosis solo se precarga aquí al EDITAR (existing); al
  // crear sale de la Historia Clínica, ver el bloque de más abajo.
  if (existing) {
    setEditableFieldValue(document.getElementById('roGeneralDiagnosis'), existing.general_diagnosis || '');
  }

  // Si el campo llega vacío (nota nueva, o una ya guardada sin este texto
  // capturado) se precarga con el estándar de la clínica en vez de dejarlo
  // en blanco — el médico lo ajusta si el caso lo requiere.
  const txtPremedicacion = document.getElementById('txtPremedicacionEstandar');
  if (txtPremedicacion && !getEditableFieldValue(txtPremedicacion).trim()) setEditableFieldValue(txtPremedicacion, RECETA_ONCO_PREMEDICACION_DEFAULT);
  const txtPostmedicacion = document.getElementById('txtPostmedicacionEstandar');
  if (txtPostmedicacion && !getEditableFieldValue(txtPostmedicacion).trim()) setEditableFieldValue(txtPostmedicacion, RECETA_ONCO_POSTMEDICACION_DEFAULT.replace(/\n/g, '<br>'));

  const linesContainer = document.getElementById('recetaOncologicaLinesContainer');
  if (linesContainer) {
    const lines = sourceOnco && sourceOnco.lines && sourceOnco.lines.length ? sourceOnco.lines : [{}];
    linesContainer.innerHTML = lines
      .map((line, index) => buildRecetaOncoTratamientoRowHtml(line.product || '', `ro-tratamiento-${line.id || `new-${index}`}`))
      .join('');
    renumberRecetaOncoTratamientos();
  }
  const creationDateInput = document.getElementById('roCreationDate');
  if (creationDateInput) creationDateInput.value = new Date().toISOString().slice(0, 10);

  // Signos Vitales del Paciente (sección 2): son de solo lectura (ver
  // readonly en paciente-detail.html) y SIEMPRE reflejan el registro de
  // signos vitales más reciente del expediente — tanto al crear una receta
  // nueva como al editar una ya guardada. Antes solo se precargaban al
  // crear, y al editar se mostraba la foto congelada de cuando se creó esa
  // receta (podía quedar desactualizada frente al expediente real, y como
  // encima eran editables a mano, un valor mal escrito ahí se guardaba
  // como si fuera el signo vital real del paciente). Mismo patrón (mismo
  // endpoint /consultations, mismo "el más reciente con source==='vitals'")
  // que ya usa openNotaOncologiaModal.
  const patientId = window.clivoraCurrentPatientId;
  if (patientId) {
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}/consultations`, { cache: 'no-store' });
      if (response.ok) {
        const consultas = await response.json();
        const latestSV = consultas.find(c => c.source === 'vitals') || null;
        const setIf = (id, val) => {
          const el = document.getElementById(id);
          if (el) el.value = val || '';
        };
        setIf('roWeight', latestSV?.peso);
        setIf('roHeight', latestSV?.altura);
        setIf('roPASistolica', latestSV?.sistolica);
        setIf('roPADiastolica', latestSV?.diastolica);
        // Se guarda junta en blood_pressure ("120/80"), como antes.
        setIf('roBloodPressure', (latestSV?.sistolica && latestSV?.diastolica) ? `${latestSV.sistolica}/${latestSV.diastolica}` : '');
        setIf('roHeartRate', latestSV?.fc);
        setIf('roRespiratoryRate', latestSV?.fr);
        setIf('roTemperature', latestSV?.temperatura);
        setIf('roOxygenSaturation', latestSV?.saturacion);
        // BSA/IMC con unidad y 2 decimales, igual que la tarjeta de Signos
        // Vitales ("1.84 m²", "40.00 kg/m²"). Al guardar, parseFloat()
        // descarta la unidad (ver saveRecetaOncologica).
        const bsa = parseFloat(latestSV?.bsa);
        const imc = parseFloat(latestSV?.imc);
        setIf('roBodySurfaceArea', bsa ? `${bsa.toFixed(2)} m²` : '');
        setIf('roBodyMassIndex', imc ? `${imc.toFixed(2)} kg/m²` : '');

        // "Diagnóstico" de Datos Generales: los diagnósticos de la Historia
        // Clínica (Análisis y Diagnóstico) con sus
        // comentarios, uno por línea; si no tiene, los de la última Nota de
        // Oncología Médica. Al editar una receta ya guardada se conserva el
        // que se guardó (ver arriba), salvo que haya quedado vacío.
        const generalDiagnosisEl = document.getElementById('roGeneralDiagnosis');
        if (generalDiagnosisEl && (!existing || !existing.general_diagnosis)) {
          let hcDiagnosis = [];
          try {
            const responseDx = await fetch(`/clivora/api/patients/${patientId}/diagnosis_lines`, { cache: 'no-store' });
            hcDiagnosis = responseDx.ok ? await responseDx.json() : [];
          } catch (error) {
            console.error('Error al cargar los diagnósticos de historia clínica para receta oncológica:', error);
          }
          const hcText = hcDiagnosis
            .filter(d => d.diagnosis)
            .map(d => `${d.diagnosis}${d.comment ? ` — ${d.comment}` : ''}`)
            .join('\n');
          const lastNotaRo = consultas.find(c => c.source === 'consultation') || null;
          const notaText = ((lastNotaRo && lastNotaRo.diagnosticos) || [])
            .filter(d => d.codigo)
            .map(d => `${d.codigo}${d.tipo ? ` (${d.tipo})` : ''}${d.comment ? ` — ${d.comment}` : ''}`)
            .join('\n');
          generalDiagnosisEl.value = hcText || notaText;
        }

      }
    } catch (error) {
      console.error('Error al cargar signos vitales/diagnóstico para receta oncológica:', error);
    }
  }

  showModalOnTop(document.getElementById('modalCrearRecetaOncologica'));
}

async function saveRecetaOncologica() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const linesContainer = document.getElementById('recetaOncologicaLinesContainer');
  const lines = linesContainer ? Array.from(linesContainer.querySelectorAll('.receta-onco-tratamiento-row')).map(row => ({
    product: row.querySelector('.receta-onco-tratamiento-input')?.value.trim() || '',
  })) : [];

  if (!lines.some(l => l.product)) {
    showClivoraAlertModal('Agrega al menos un tratamiento con descripción.');
    return;
  }

  const val = (id) => getEditableFieldValue(document.getElementById(id));
  // Sin doctor_id: la Receta Oncológica no tiene selector de médico, el
  // backend le pone el médico asignado del paciente (ver
  // _recipe_header_default_doctor en el controlador).
  const payload = {
    recipe_type: 'oncological',
    notes: '',
    lines,
    cycle_number: val('roCycleNumber'),
    application_day: val('roApplicationDay'),
    next_treatment_date: val('roNextTreatmentDate') || false,
    weight: parseFloat(val('roWeight')) || 0,
    height: parseFloat(val('roHeight')) || 0,
    blood_pressure: val('roBloodPressure'),
    heart_rate: parseInt(val('roHeartRate'), 10) || 0,
    respiratory_rate: parseInt(val('roRespiratoryRate'), 10) || 0,
    temperature: parseFloat(val('roTemperature')) || 0,
    oxygen_saturation: parseInt(val('roOxygenSaturation'), 10) || 0,
    body_surface_area: parseFloat(val('roBodySurfaceArea')) || 0,
    body_mass_index: parseFloat(val('roBodyMassIndex')) || 0,
    general_diagnosis: document.getElementById('roGeneralDiagnosis')?.value || '',
    premedication_description: val('txtPremedicacionEstandar'),
    postmedication_description: val('txtPostmedicacionEstandar'),
    // Solo tiene efecto al crear (el backend la ignora en el update, que
    // nunca la manda) — ver _recipe_header_vals_from_payload.
    clinic_consultations_id: clivoraActiveRecipeHeaderConsultationId || false,
  };
  const url = clivoraRecipeHeaderModalMode === 'edit'
    ? `/clivora/api/recipe_headers/${clivoraActiveRecipeHeaderId}`
    : `/clivora/api/patients/${patientId}/recipe_headers`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar la receta oncológica.'));
      return;
    }
    const saved = await response.json();
    // Ver el comentario equivalente en saveRecetaMedica: si esta receta
    // oncológica quedó vinculada a la Nota de Oncología Médica abierta
    // detrás, refresca su lista de "Documentos generados desde esta nota".
    if (clivoraActiveRecipeHeaderConsultationId) await ensureOncoNotaSaved();
    await loadPatientRecipes(patientId);

    const successOverlay = document.getElementById('recetaOncologicaSuccessOverlay');
    const btnNew = document.getElementById('btnNextNewRecetaOncologica');
    const btnView = document.getElementById('btnNextViewRecetaOncologica');
    const btnBackToOnco = document.getElementById('btnNextBackToOncoNotaFromReceta');
    if (btnNew) {
      btnNew.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        openRecetaOncologicaModal('create');
      };
    }
    if (btnView) {
      btnView.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        const modal = document.getElementById('modalCrearRecetaOncologica');
        if (modal) modal.style.display = 'none';
        goToExpedienteSubTab('tab-recetas');
        if (saved && saved.id) showRecipeDetail(saved.id);
      };
    }
    // Mismo criterio que btnNextBackToOncoNota en saveRecetaMedica: solo se
    // ofrece cuando esta receta se generó desde dentro de la Nota Oncológica
    // Médica (#modalNotaOncologiaMedica), que nunca se cerró de fondo.
    if (btnBackToOnco) {
      if (clivoraActiveRecipeHeaderConsultationId) {
        btnBackToOnco.style.display = 'inline-flex';
        btnBackToOnco.onclick = () => {
          if (successOverlay) successOverlay.style.display = 'none';
          const modal = document.getElementById('modalCrearRecetaOncologica');
          if (modal) modal.style.display = 'none';
          showModalOnTop(document.getElementById('modalNotaOncologiaMedica'));
        };
      } else {
        btnBackToOnco.style.display = 'none';
        btnBackToOnco.onclick = null;
      }
    }
    if (successOverlay) successOverlay.style.display = 'flex';
  } catch (error) {
    console.error('Error al guardar receta oncológica:', error);
    showClivoraAlertModal('No se pudo guardar la receta oncológica.');
  }
}

// Nota de Oncología Médica actualmente abierta en el modal de creación
// (#modalNotaOncologiaMedica) — null mientras no se haya guardado todavía.
// La fijan ensureOncoNotaSaved() (primer guardado, disparado por cualquiera
// de los 3 botones de Acciones Especiales o por "Guardar Nota") y
// openNotaOncologiaModal() (la resetea a null al abrir el modal en blanco
// para una nota nueva).
let clivoraActiveOncoConsultationId = null;

// Guarda (crea o, si ya se guardó antes en esta misma apertura del modal,
// actualiza) la Nota de Oncología Médica que se está redactando. La usan los
// 3 botones de "Acciones Especiales" (Receta Oncológica / Generar Receta
// Médica / Órdenes Médicas) para asegurar que exista un registro real al que
// vincular el documento que van a abrir, y el propio "Guardar Nota" — así,
// si el médico ya usó alguno de esos botones antes de darle Guardar, esto
// actualiza esa misma nota en vez de crear una segunda duplicada.
// Una sola ejecución a la vez: si ya hay un guardado de la nota en curso
// (p. ej. "Guardar Nota" y una receta/orden generada desde la nota casi al
// mismo tiempo), se espera ese mismo en lugar de lanzar otro — dos llamadas
// en paralelo veían la nota aún sin id y creaban dos notas.
let clivoraOncoNotaSaving = null;
function ensureOncoNotaSaved() {
  if (!clivoraOncoNotaSaving) {
    clivoraOncoNotaSaving = doEnsureOncoNotaSaved().finally(() => { clivoraOncoNotaSaving = null; });
  }
  return clivoraOncoNotaSaving;
}

async function doEnsureOncoNotaSaved() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return null;

  const diagnosticos = [];
  document.querySelectorAll('#tbodyOncoDiagnosticos tr').forEach(row => {
    const codigoInput = row.querySelector('.onco-diag-codigo');
    const selectedId = codigoInput?.dataset.selectedId || '';
    const codigo = selectedId ? codigoInput.value.trim() : '';
    const tipo = row.querySelector('.onco-diag-tipo')?.value;
    const comment = row.querySelector('.onco-diag-comment')?.value.trim() || '';
    if (codigo) {
      diagnosticos.push({
        codigo, tipo, comment,
        cie11_diagnosis_id: selectedId ? parseInt(selectedId, 10) : false,
      });
    }
  });

  // Recetas médicas (tarjetas de #recetasContainer, agregadas por
  // btnNuevaRecetaIndependiente): precargadas desde la última Nota de
  // Oncología (prefillRecetasFromLastNota) y editables acá — no lo que ya
  // toma el paciente (eso es Medicamentos/Tratamientos de Historia Clínica,
  // aparte).
  const recetas = [];
  document.querySelectorAll('#recetasContainer .tbody-receta-meds tr').forEach(row => {
    const nombre = row.querySelector('.receta-med-nombre')?.value?.trim();
    const indicaciones = row.querySelector('.receta-med-indicaciones')?.value?.trim();
    const notas = row.querySelector('.receta-med-notas')?.value?.trim();
    if (nombre) recetas.push({ nombre, indicaciones, notas });
  });

  const payload = {
    // Igual que evolutionDatetime: se manda el value crudo de datetime-local,
    // no un toISOString() (el backend lo convierte a UTC; un ISO con
    // "T"/"Z"/milisegundos no coincide con el formato que fields.Datetime
    // espera y hacía tronar el create() entero).
    admissionDatetime: document.getElementById('oncoFechaIngreso')?.value || false,
    treatmentCycle: document.getElementById('oncoCiclo')?.value?.trim() || '',
    allergiesNote: document.getElementById('oncoAlergias')?.value?.trim() || 'Sin alergias conocidas',
    analisis: richTextValue(document.getElementById('oncoAnalisisClinico')),
    indicaciones: document.getElementById('oncoIndicacionesMedicas')?.value?.trim() || '',
    diagnosticos,
    recetas,
  };

  try {
    const url = clivoraActiveOncoConsultationId
      ? `/clivora/api/consultations/oncology/${clivoraActiveOncoConsultationId}`
      : `/clivora/api/patients/${patientId}/consultations/oncology`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar la nota de oncología médica.'));
      return null;
    }
    const saved = await response.json();
    if (saved && saved.consultation_id) clivoraActiveOncoConsultationId = saved.consultation_id;
    renderOncoLinkedDocuments('oncoLinkedDocsContainer', saved && saved.linkedDocuments);
    await loadPatientConsultas(patientId);
    return clivoraActiveOncoConsultationId;
  } catch (error) {
    console.error('Error al guardar la nota de oncología médica:', error);
    showClivoraAlertModal('No se pudo guardar la nota de oncología médica.');
    return null;
  }
}

document.addEventListener('click', (event) => {
  const btnOpenOnco = event.target.closest('#btnRecetaOncologicaOnco');
  if (btnOpenOnco) {
    event.preventDefault();
    (async () => {
      const consultationId = await ensureOncoNotaSaved();
      if (!consultationId) return;
      openRecetaOncologicaModal('create', null, consultationId);
    })();
    return;
  }
  const btnCloseOnco = event.target.closest('#closeCrearRecetaOncologicaModal');
  if (btnCloseOnco) {
    event.preventDefault();
    const modal = document.getElementById('modalCrearRecetaOncologica');
    if (modal) modal.style.display = 'none';
    return;
  }
  const btnBackOnco = event.target.closest('#btnBackRecetaOncologica');
  if (btnBackOnco) {
    event.preventDefault();
    const modal = document.getElementById('modalCrearRecetaOncologica');
    if (modal) modal.style.display = 'none';
    // Si se está editando una receta ya guardada (viene del detalle de la
    // receta, no del selector de tipo), "Atrás" solo cierra el modal en vez
    // de mandar al selector de tipo de receta, que no tiene sentido aquí
    // (mismo criterio que btnBackRecetaMedica).
    if (clivoraRecipeHeaderModalMode !== 'edit') {
      showModalOnTop(document.getElementById('modalSeleccionTipoReceta'));
    }
    return;
  }
  const btnPrintOnco = event.target.closest('#btnPrintRecetaOncologica');
  if (btnPrintOnco) {
    event.preventDefault();
    window.print();
    return;
  }
  if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalCrearRecetaOncologica') {
    event.target.style.display = 'none';
    return;
  }
  const btnAddOncoTratamiento = event.target.closest('#btnAddRecetaOncoTratamientoRow');
  if (btnAddOncoTratamiento) {
    event.preventDefault();
    const container = document.getElementById('recetaOncologicaLinesContainer');
    if (container) {
      container.insertAdjacentHTML('beforeend', buildRecetaOncoTratamientoRowHtml('', `ro-tratamiento-${Date.now()}`));
      renumberRecetaOncoTratamientos();
    }
    return;
  }
  const btnDeleteOncoTratamiento = event.target.closest('.btn-delete-onco-tratamiento');
  if (btnDeleteOncoTratamiento) {
    event.preventDefault();
    const row = btnDeleteOncoTratamiento.closest('.receta-onco-tratamiento-row');
    if (row) {
      row.remove();
      renumberRecetaOncoTratamientos();
    }
    return;
  }
  const btnSaveOnco = event.target.closest('#btnSaveRecetaOncologica');
  if (btnSaveOnco) {
    event.preventDefault();
    runClivoraSaveOnce('recetaOncologica', btnSaveOnco, saveRecetaOncologica);
    return;
  }
});

document.addEventListener('click', (event) => {
  const btnNuevaVenta = event.target.closest('#btnOpenNuevaVentaPaciente');
  if (btnNuevaVenta) {
    event.preventDefault();
    const patientId = window.clivoraCurrentPatientId;
    if (!patientId) return;
    const patientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';
    openNuevaVentaPacienteModal(patientId, patientName);
    return;
  }
  const btnNueva = event.target.closest('#btnOpenNuevaRecetaForm');
  if (btnNueva) {
    event.preventDefault();
    showModalOnTop(document.getElementById('modalSeleccionTipoReceta'));
    return;
  }
  const btnCloseTipo = event.target.closest('#closeSeleccionTipoRecetaModal');
  if (btnCloseTipo) {
    event.preventDefault();
    const modal = document.getElementById('modalSeleccionTipoReceta');
    if (modal) modal.style.display = 'none';
    return;
  }
  if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalSeleccionTipoReceta') {
    event.target.style.display = 'none';
    return;
  }
  const btnTipoMedica = event.target.closest('#btnTipoRecetaMedica');
  if (btnTipoMedica) {
    event.preventDefault();
    const tipoModal = document.getElementById('modalSeleccionTipoReceta');
    if (tipoModal) tipoModal.style.display = 'none';
    openRecetaMedicaModal('create');
    return;
  }
  const btnTipoOnco = event.target.closest('#btnTipoRecetaOncologica');
  if (btnTipoOnco) {
    event.preventDefault();
    const tipoModal = document.getElementById('modalSeleccionTipoReceta');
    if (tipoModal) tipoModal.style.display = 'none';
    // La Receta Oncológica es una prescripción propia, distinta de la Nota
    // Oncológica (nota clínica completa) — antes este botón abría por error
    // la Nota Oncológica completa en vez de un formulario de receta.
    openRecetaOncologicaModal();
    return;
  }
  const btnCloseRecetaMedica = event.target.closest('#closeCrearRecetaMedicaModal');
  if (btnCloseRecetaMedica) {
    event.preventDefault();
    const modal = document.getElementById('modalCrearRecetaMedica');
    if (modal) modal.style.display = 'none';
    return;
  }
  const btnBackRecetaMedica = event.target.closest('#btnBackRecetaMedica');
  if (btnBackRecetaMedica) {
    event.preventDefault();
    const modal = document.getElementById('modalCrearRecetaMedica');
    if (modal) modal.style.display = 'none';
    // Si se está editando una receta ya guardada (viene del detalle de la
    // receta, no del selector de tipo), "Atrás" solo cierra el modal en vez
    // de mandar al selector de tipo de receta, que no tiene sentido aquí.
    if (clivoraRecipeHeaderModalMode !== 'edit') {
      showModalOnTop(document.getElementById('modalSeleccionTipoReceta'));
    }
    return;
  }
  if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalCrearRecetaMedica') {
    event.target.style.display = 'none';
    return;
  }
  const btnAddLine = event.target.closest('#btnAddRecetaMedicaLine');
  if (btnAddLine) {
    event.preventDefault();
    const container = document.getElementById('recetaMedicaLinesContainer');
    if (container) container.insertAdjacentHTML('beforeend', buildRecetaMedicaLineHtml({}, `rm-line-new-${Date.now()}`));
    return;
  }
  const btnPrintRecetaMedica = event.target.closest('#btnPrintRecetaMedica');
  if (btnPrintRecetaMedica) {
    event.preventDefault();
    window.print();
    return;
  }
  const btnSaveRecetaMedica = event.target.closest('#btnSaveRecetaMedica');
  if (btnSaveRecetaMedica) {
    event.preventDefault();
    runClivoraSaveOnce('recetaMedica', btnSaveRecetaMedica, saveRecetaMedica);
    return;
  }
  const btnDownloadRecipeHeader = event.target.closest('#btnDownloadRecipeHeader');
  if (btnDownloadRecipeHeader) {
    event.preventDefault();
    const patientId = window.clivoraCurrentPatientId;
    const rec = clivoraPatientRecipeHeaders.find(r => String(r.id) === String(clivoraActiveRecipeHeaderId));
    if (clivoraActiveRecipeHeaderId && patientId && rec) {
      const route = rec.recipe_type === 'oncological' ? 'onco_print' : 'print';
      clivoraDownloadPdf(`/clivora/api/patients/${patientId}/recipe_headers/${clivoraActiveRecipeHeaderId}/${route}`);
    }
    return;
  }
  const btnPrintRecipeHeader = event.target.closest('#btnPrintRecipeHeader');
  if (btnPrintRecipeHeader) {
    event.preventDefault();
    const patientId = window.clivoraCurrentPatientId;
    const rec = clivoraPatientRecipeHeaders.find(r => String(r.id) === String(clivoraActiveRecipeHeaderId));
    if (clivoraActiveRecipeHeaderId && patientId && rec && rec.recipe_type === 'oncological') {
      window.open(`/clivora/api/patients/${patientId}/recipe_headers/${clivoraActiveRecipeHeaderId}/onco_print`, '_blank');
    } else if (clivoraActiveRecipeHeaderId && patientId && rec) {
      window.open(`/clivora/api/patients/${patientId}/recipe_headers/${clivoraActiveRecipeHeaderId}/print`, '_blank');
    } else {
      window.print();
    }
    return;
  }
  const btnEditRecipeHeader = event.target.closest('#btnEditRecipeHeader');
  if (btnEditRecipeHeader) {
    event.preventDefault();
    if (!clivoraActiveRecipeHeaderId) return;
    const rec = clivoraPatientRecipeHeaders.find(r => String(r.id) === String(clivoraActiveRecipeHeaderId));
    if (rec && rec.recipe_type === 'oncological') {
      openRecetaOncologicaModal('edit', clivoraActiveRecipeHeaderId);
    } else {
      openRecetaMedicaModal('edit', clivoraActiveRecipeHeaderId);
    }
    return;
  }
  // "Crear desglose" — mismo flujo que "Crear cotización" de un archivo
  // tipo Recetas (ver btnCreateQuoteFilePreview): una venta en estado
  // Desglose por receta; si ya existe, abre esa venta.
  const btnCreateQuoteRecipeHeader = event.target.closest('#btnCreateQuoteRecipeHeader');
  if (btnCreateQuoteRecipeHeader) {
    event.preventDefault();
    if (!clivoraActiveRecipeHeaderId) return;
    const headerId = clivoraActiveRecipeHeaderId;
    const rec = clivoraPatientRecipeHeaders.find(r => String(r.id) === String(headerId));
    if (rec && rec.saleOrderId) {
      openVentaViewModal(rec.saleOrderId);
      return;
    }
    (async () => {
      btnCreateQuoteRecipeHeader.disabled = true;
      try {
        const response = await fetch(`/clivora/api/recipe_headers/${headerId}/create_quote`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
          let message = 'No se pudo crear el desglose.';
          if (data && data.error === 'no_patient') {
            message = 'Esta receta no tiene un paciente vinculado.';
          } else if (data && data.error === 'sale_order_failed' && data.message) {
            message = `No se pudo crear el desglose:\n\n${data.message}`;
          }
          showClivoraAlertModal(message);
          return;
        }
        await loadPatientRecipes(window.clivoraCurrentPatientId);
        showRecipeDetail(headerId);
      } catch (error) {
        console.error('Error al crear el desglose de la receta:', error);
        showClivoraAlertModal('No se pudo crear el desglose.');
      } finally {
        btnCreateQuoteRecipeHeader.disabled = false;
      }
    })();
    return;
  }
  const btnDeleteRecipeHeader = event.target.closest('#btnDeleteRecipeHeader');
  if (btnDeleteRecipeHeader) {
    event.preventDefault();
    if (!clivoraActiveRecipeHeaderId) return;
    (async () => {
      if (!(await showClivoraConfirmModal('¿Eliminar esta receta?'))) return;
      fetch(`/clivora/api/recipe_headers/${clivoraActiveRecipeHeaderId}/delete`, { method: 'POST' })
        .then(() => {
          showRecipeEmptyState();
          loadPatientRecipes(window.clivoraCurrentPatientId);
        })
        .catch(error => console.error('Error al eliminar receta:', error));
    })();
    return;
  }
});

// ============================
// Compartir expediente
// ============================
let clivoraPatientShares = [];
let clivoraCanShare = null;
// Contexto de "qué se va a compartir" al entrar a la pestaña Compartir
// desde Archivos con documentos puntuales seleccionados — [] significa
// "se comparte el expediente completo" (entrada desde cualquier otro lado
// del expediente). Se limpia después de cada envío exitoso.
let clivoraShareContextFiles = [];

// Modal "Compartir Archivo" (WhatsApp/Facebook) — diseño tomado de
// Mejoras/Modal Compartir archivo.txt, ver #modalCompartirArchivos en
// paciente-detail.html. Usa su PROPIA función de selección en vez de
// clivoraShareContextFiles (de arriba, que alimenta la pestaña "Compartir
// expediente" con acceso de doctor) — ese array se limpia solo desde
// loadPatientShares(), pensado para el flujo viejo, y reutilizarlo aquí
// dejaba este modal mostrando "no hay archivos seleccionados" pese a tener
// casillas marcadas. Se lee directo del DOM (checkboxes marcados) al
// momento de compartir, así no depende de ningún estado intermedio.
function getArchivoFilesSeleccionados() {
  return Array.from(document.querySelectorAll('.file-card-checkbox:checked')).map(cb => {
    const fileId = cb.dataset.fileId;
    return clivoraPatientFiles.find(f => String(f.id) === String(fileId));
  }).filter(Boolean);
}

function showShareStatus(message, ok) {
  const el = document.getElementById('shareStatusAlert');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = ok ? '#DCFCE7' : '#FEE2E2';
  el.style.color = ok ? '#166534' : '#B91C1C';
  el.textContent = message;
}

function compartirPorPlataforma(platform) {
  const files = getArchivoFilesSeleccionados().filter(f => f && f.fileUrl);
  if (files.length === 0) {
    showShareStatus('No hay archivos seleccionados para compartir.', false);
    return;
  }
  // Los archivos de una versión anterior traen el data-URL
  // completo en fileUrl en vez de una ruta real (/clivora/patient_files/...) — no hay
  // forma de compartir eso como link por WhatsApp/Facebook.
  const shareable = files.filter(f => f.fileUrl.startsWith('/clivora/patient_files/'));
  if (shareable.length === 0) {
    showShareStatus('Estos archivos son de una versión anterior y no se pueden compartir como link. Descárgalos y compártelos manualmente.', false);
    return;
  }

  const origin = window.location.origin;

  if (platform === 'WhatsApp') {
    const text = shareable.map(f => `${f.title || 'Archivo'}: ${origin}${f.fileUrl}`).join('\n');
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  } else if (platform === 'Facebook') {
    // El diálogo de Facebook solo acepta una URL (parámetro ?u=) — si hay
    // varios archivos seleccionados se comparte el primero.
    const url = `${origin}${shareable[0].fileUrl}`;
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank', 'width=600,height=500');
  } else {
    return;
  }

  const skipped = files.length - shareable.length;
  showShareStatus(
    `Se abrió ${platform} para compartir ${shareable.length > 1 ? 'el primer archivo' : 'el archivo'} seleccionado.` +
    (skipped > 0 ? ` (${skipped} archivo(s) legado no se pudieron incluir.)` : ''),
    true,
  );
}
window.compartirPorPlataforma = compartirPorPlataforma;

async function ensureCanShare() {
  if (clivoraCanShare !== null) return clivoraCanShare;
  try {
    const response = await fetch('/clivora/api/me', { cache: 'no-store' });
    clivoraCanShare = response.ok ? (await response.json()).canShare : false;
  } catch (error) {
    console.error('Error al verificar permiso de compartir:', error);
    clivoraCanShare = false;
  }
  const formCard = document.getElementById('shareFormCard');
  const noPermMsg = document.getElementById('shareNoPermissionMsg');
  if (formCard) formCard.style.display = clivoraCanShare ? 'block' : 'none';
  if (noPermMsg) noPermMsg.style.display = clivoraCanShare ? 'none' : 'block';
  return clivoraCanShare;
}

async function loadPatientShares(patientId) {
  if (!patientId) return;
  ensureCanShare();
  populateShareDoctorSelect(document.getElementById('shDoctor'));
  // loadPatientShares solo se llama al abrir/recargar un paciente o tras
  // guardar/eliminar un share — nunca en medio del flujo "seleccionar
  // archivos en Archivos y darle Compartir" (ese flujo llena
  // clivoraShareContextFiles y navega directo a la pestaña sin pasar por
  // aquí). Limpiarlo acá evita que el contexto de archivos de un paciente
  // se arrastre a otro paciente abierto después sin haber compartido.
  clivoraShareContextFiles = [];
  renderShareContextSummary();
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/shares`, { cache: 'no-store' });
    clivoraPatientShares = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar registros de expediente compartido:', error);
    clivoraPatientShares = [];
  }
  renderSharesList();
}

function renderSharesList() {
  const container = document.getElementById('sharesListContainer');
  const countLabel = document.getElementById('sharesCountLabel');
  if (countLabel) countLabel.textContent = `${clivoraPatientShares.length} registro(s)`;
  if (!container) return;

  if (clivoraPatientShares.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">El expediente no se ha compartido con nadie todavía.</p>';
    return;
  }

  container.innerHTML = clivoraPatientShares.map(rec => {
    const scopeBadge = rec.file_titles && rec.file_titles.length
      ? rec.file_titles.map(t => `<span style="background: var(--primary-blue-light); color: var(--primary-blue); font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: var(--radius-full); margin-right: 4px;">${escapeHtml(t)}</span>`).join('')
      : '<span style="color: var(--text-muted); font-size: 11px;">Expediente completo</span>';
    return `
    <div class="nopat-card" style="padding: 14px 18px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="font-weight: 600; font-size: 13px;">${escapeHtml(rec.doctor_name || '(Doctor eliminado)')}</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${rec.shared_by_name ? `Compartido por ${escapeHtml(rec.shared_by_name)}` : ''}</div>
        ${rec.note ? `<div style="font-size: 12px; margin-top: 4px;">${rec.note}</div>` : ''}
        <div style="margin-top: 6px;">${scopeBadge}</div>
      </div>
      ${clivoraCanShare ? `<button type="button" class="sh-remove btn-anim-lift" data-id="${rec.id}" title="Eliminar" style="background:none;border:none;cursor:pointer;color:#EF4444;display:inline-flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
    </div>
  `;
  }).join('');

  container.querySelectorAll('.sh-remove').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (!(await showClivoraConfirmModal('¿Eliminar este registro de expediente compartido?'))) return;
      try {
        await fetch(`/clivora/api/shares/${id}/delete`, { method: 'POST' });
        await loadPatientShares(window.clivoraCurrentPatientId);
      } catch (error) {
        console.error('Error al eliminar registro de expediente compartido:', error);
      }
    };
  });
}

// El select de doctores del formulario de Compartir usa el id real del
// médico como value — a
// diferencia de populateDoctorSelectOptions, que llena selects que solo
// guardan el nombre como texto libre.
async function populateShareDoctorSelect(selectEl) {
  if (!selectEl) return;
  const doctors = await ensureDoctorsCatalog();
  selectEl.innerHTML = '<option value="">Seleccionar doctor</option>';
  doctors.forEach(doctor => {
    const option = document.createElement('option');
    option.value = doctor.id;
    option.textContent = doctor.name;
    selectEl.appendChild(option);
  });
}

// Refleja en el formulario si se va a compartir el expediente completo o
// solo los documentos puntuales seleccionados en Archivos (ver
// clivoraShareContextFiles, llenado por el botón #btnShareSelectedArchivos).
function renderShareContextSummary() {
  const titleEl = document.getElementById('shareFormTitle');
  const summaryEl = document.getElementById('shareContextSummary');
  if (!titleEl || !summaryEl) return;

  if (clivoraShareContextFiles.length === 0) {
    titleEl.textContent = 'Compartir expediente completo';
    summaryEl.style.display = 'none';
    summaryEl.innerHTML = '';
    return;
  }

  titleEl.textContent = `Compartir ${clivoraShareContextFiles.length} archivo(s)`;
  summaryEl.style.display = 'flex';
  summaryEl.innerHTML = clivoraShareContextFiles.map(f => `
    <span style="background: var(--primary-blue-light); color: var(--primary-blue); font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: var(--radius-full);">${escapeHtml(f.title || 'Sin título')}</span>
  `).join('');
}

async function addPatientShare() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const doctorId = document.getElementById('shDoctor')?.value || '';
  if (!doctorId) {
    showClivoraAlertModal('Por favor seleccione con qué doctor se comparte el expediente.');
    return;
  }
  const payload = {
    doctor_id: doctorId,
    note: getEditableFieldValue(document.getElementById('shNota')),
    file_ids: clivoraShareContextFiles.map(f => f.id),
  };
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 403) {
      showClivoraAlertModal('No tienes permiso para compartir expedientes.');
      return;
    }
    document.getElementById('shDoctor').value = '';
    setEditableFieldValue(document.getElementById('shNota'), '');
    document.querySelectorAll('.file-card-checkbox:checked').forEach(cb => { cb.checked = false; });
    clivoraShareContextFiles = [];
    renderShareContextSummary();
    await loadPatientShares(patientId);
  } catch (error) {
    console.error('Error al guardar registro de expediente compartido:', error);
    showClivoraAlertModal('No se pudo guardar el registro.');
  }
}

// ============================
// Notas Clínicas desde Consultas (Enfermería / Nutrición / Psicología /
// Procedimientos Ambulatorios / Hospitalización-Egreso)
// ============================
const NOTA_CLINICA_TYPES = {
  'Notas de enfermeria': { title: 'Registro Clínico de Enfermería', endpoint: 'nursing' },
  'Nota de Nutrición': { title: 'Nota de Nutrición', endpoint: 'nutrition' },
  'Nota de Psicología': { title: 'Nota de Psicología', endpoint: 'psychology' },
  'Nota de Procedimientos ambulatorios': { title: 'Nota de Procedimientos Ambulatorios', endpoint: 'ambulatory' },
  'Nota de Hospitalización': { title: 'Nota de Hospitalización', endpoint: 'discharge' },
  'Nota de Egreso hospitalario': { title: 'Nota de Egreso Hospitalario', endpoint: 'discharge' },
  'Nota de Nefrología': { title: 'Nota de Nefrología', endpoint: 'nephrology' },
  'Nota de Cuidados Paliativos': { title: 'Nota de Cuidados Paliativos', endpoint: 'paliative' },
};

async function openNotaClinicaModal(type) {
  const config = NOTA_CLINICA_TYPES[type];
  if (!config) return;
  const modal = document.getElementById('modalNotaClinica');
  const titleEl = document.getElementById('notaClinicaTitle');
  if (titleEl) titleEl.textContent = config.title;
  const iconEl = document.getElementById('notaClinicaIcon');
  if (iconEl) iconEl.style.display = type === 'Notas de enfermeria' ? 'block' : 'none';
  if (modal) modal.dataset.noteType = type;

  document.querySelectorAll('#modalNotaClinica .nc-fields').forEach(group => {
    const types = (group.dataset.noteType || '').split(',');
    group.style.display = types.includes(type) ? 'flex' : 'none';
    group.style.flexDirection = 'column';
    group.style.gap = '14px';
  });

  // Limpiar campos
  modal.querySelectorAll('input, textarea').forEach(el => {
    if (el.type === 'checkbox') el.checked = false;
    else {
      el.value = '';
      // Los <input type="time"/"date"> quedan envueltos por
      // enhanceCustomTimePicker/enhanceCustomDatePicker, que solo
      // refrescan su propio texto visible ("Hora de Captura", etc.) al
      // escuchar el evento 'change' del input real — sin dispatchear uno
      // acá, limpiar el .value a mano dejaba el widget mostrando la
      // última hora capturada de la nota anterior aunque el input ya
      // estuviera vacío por dentro.
      if (el.type === 'time' || el.type === 'date') {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
  // Los editores enriquecidos (div[contenteditable].rich-text-content) no
  // los toca el querySelectorAll de arriba — se limpian aparte con .innerHTML.
  modal.querySelectorAll('.rich-text-content').forEach(el => { el.innerHTML = ''; });
  // Signos Vitales adicionales (+ Agregar signo vital): el reset de
  // arriba solo vacía los <input> que YA existan dentro de cada fila,
  // pero no quita las filas mismas — abrir una nota nueva después de
  // haber agregado varias en una nota anterior las dejaba ahí, vacías,
  // en vez de arrancar sin ninguna.
  const ncExtraVitalSigns = document.getElementById('ncExtraVitalSignsContainer');
  if (ncExtraVitalSigns) ncExtraVitalSigns.innerHTML = '';

  // Datos generales del paciente e ingreso: ahora es un bloque siempre
  // visible (no exclusivo de "Notas de enfermeria"), se rellena para
  // cualquier tipo de nota clínica seleccionada. Los campos ya se
  // vaciaron arriba junto con el resto de <input>/<textarea> del modal.
  await populatePatientHeaderInfo('nc');

  if (type === 'Notas de enfermeria') {
    const ncAislamiento = document.getElementById('ncAislamiento');
    if (ncAislamiento) ncAislamiento.value = 'ninguno';

    // Bloques 1-8 del Registro Clínico: valores por defecto de una nota
    // nueva (no hay flujo de edición de notas de enfermería ya guardadas).
    ['ncEvaLocation', 'ncEvaIntervention',
      'ncNurseResponsible1', 'ncNurseResponsible2', 'ncDischargeTime', 'ncNewsHora'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    resetNcDischargeMedications('ncDischargeMedicationsContainer');
    ['ncNauseaScale', 'ncMucositisScale', 'ncNeutropeniaScale'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '0';
    });
    const ffScale = document.getElementById('ncFunctionalFatigueScale');
    if (ffScale) ffScale.value = '10';
    ['ncLabHemoglobin', 'ncLabLeukocytes', 'ncLabPlatelets', 'ncLabNeutrophils',
      'ncNewsFC', 'ncNewsPAS', 'ncNewsFR', 'ncNewsTemp', 'ncNewsSat'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const ncNewsConsciencia = document.getElementById('ncNewsConsciencia');
    if (ncNewsConsciencia) ncNewsConsciencia.value = 'A';
    ['ncSystemsConsciousness', 'ncSystemsMood', 'ncSystemsUrinary', 'ncSystemsGastrointestinal',
      'ncSystemsCardiorespiratory', 'ncSystemsSkin'].forEach(id => {
      const el = document.getElementById(id); if (el) el.selectedIndex = 0;
    });
    const evaRange = document.getElementById('ncEvaRangeInput');
    if (evaRange) evaRange.value = '0';
    updateNcEvaVisual(0);
    const evaChar = document.getElementById('ncEvaCharacteristics');
    if (evaChar) evaChar.value = 'sin_dolor';
    ['ncFallPreventionSideRails', 'ncFallPreventionBrake', 'ncFallPreventionBell'].forEach(id => {
      const el = document.getElementById(id); if (el) el.checked = true;
    });
    const blueBracelet = document.getElementById('ncFallPreventionBlueBracelet');
    if (blueBracelet) blueBracelet.checked = false;
    NC_DOWNTON_CHECKBOX_IDS.forEach(id => {
      const el = document.getElementById(id); if (el) el.checked = false;
    });
    recalcNcDowntonScore();
    recalcNcNewsScore();
    const medsBody = document.getElementById('ncMedicationsTableBody');
    if (medsBody) medsBody.innerHTML = buildNcMedicationRowHtml();
  }

  const successOverlay = document.getElementById('notaClinicaSuccessOverlay');
  if (successOverlay) successOverlay.style.display = 'none';
  if (modal) modal.style.display = 'flex';
}

// ============================
// Registro Clínico de Enfermería — Bloque 2 (NEWS), Bloque 5 (EVA) y
// Bloque 7 (tabla de administración de medicamentos). Antes solo existían
// como maqueta estática sin cálculo real ni guardado.
// ============================
function recalcNcNewsScore() {
  const fc = parseInt(document.getElementById('ncNewsFC')?.value, 10) || 0;
  const pas = parseInt(document.getElementById('ncNewsPAS')?.value, 10) || 0;
  const fr = parseInt(document.getElementById('ncNewsFR')?.value, 10) || 0;
  const temp = parseFloat(document.getElementById('ncNewsTemp')?.value) || 0;
  const sat = parseInt(document.getElementById('ncNewsSat')?.value, 10) || 0;
  const cons = document.getElementById('ncNewsConsciencia')?.value || 'A';

  let score = 0;
  if (fr <= 8 || fr >= 25) score += 3; else if (fr >= 21) score += 2; else if (fr <= 11) score += 1;
  if (sat <= 91) score += 3; else if (sat <= 93) score += 2; else if (sat <= 95) score += 1;
  if (pas <= 90 || pas >= 220) score += 3; else if (pas <= 100) score += 2; else if (pas <= 110) score += 1;
  if (fc <= 40 || fc >= 131) score += 3; else if (fc >= 111) score += 2; else if (fc <= 50 || fc >= 91) score += 1;
  if (temp <= 35.0) score += 3; else if (temp >= 39.1) score += 2; else if (temp <= 36.0 || temp >= 38.1) score += 1;
  if (cons !== 'A') score += 3;

  const badge = document.getElementById('ncNewsScoreBadge');
  const text = document.getElementById('ncNewsAccionText');
  if (!badge || !text) return score;

  if (score >= 7) {
    badge.style.background = '#EF4444';
    badge.textContent = `NEWS Score: ${score} (RIESGO ALTO / ROJO)`;
    text.textContent = 'Acción urgente: Evaluación médica inmediata por médico especialista / alerta crítica.';
  } else if (score >= 5) {
    badge.style.background = '#F59E0B';
    badge.textContent = `NEWS Score: ${score} (RIESGO MEDIO / AMARILLO)`;
    text.textContent = 'Acción sugerida: Informar a médico tratante y aumentar frecuencia de monitoreo a cada hora.';
  } else {
    badge.style.background = '#10B981';
    badge.textContent = `NEWS Score: ${score} (BAJO RIESGO / VERDE)`;
    text.textContent = 'Acción sugerida: Continuar monitoreo de rutina cada 4 horas.';
  }
  return score;
}

function updateNcEvaVisual(val) {
  const v = parseInt(val, 10) || 0;
  const display = document.getElementById('ncEvaValueDisplay');
  if (!display) return;
  let text = '';
  let color = '#10B981';
  if (v === 0) { text = '0 (Sin Dolor)'; color = '#10B981'; }
  else if (v <= 3) { text = `${v} (Dolor Leve)`; color = '#3B82F6'; }
  else if (v <= 6) { text = `${v} (Dolor Moderado)`; color = '#F59E0B'; }
  else if (v <= 8) { text = `${v} (Dolor Intenso)`; color = '#EA580C'; }
  else { text = `${v} (Dolor Insoportable)`; color = '#EF4444'; }
  display.style.color = color;
  display.textContent = text;
}

const NC_DOWNTON_CHECKBOX_IDS = [
  'ncDowntonPreviousFalls', 'ncDowntonSedatives', 'ncDowntonDiuretics',
  'ncDowntonAntihipertensives', 'ncDowntonAntiparkinsonians', 'ncDowntonAntidepressants',
  'ncDowntonDesoriented', 'ncDowntonVisual', 'ncDowntonAuditive', 'ncDowntonLimbs',
  'ncDowntonSafeWithHelp', 'ncDowntonUnsafeWithHelp', 'ncDowntonImpossible',
];

function recalcNcDowntonScore() {
  const score = NC_DOWNTON_CHECKBOX_IDS.reduce((sum, id) => {
    const el = document.getElementById(id);
    return sum + (el && el.checked ? 1 : 0);
  }, 0);

  const badge = document.getElementById('ncDowntonScoreBadge');
  if (badge) {
    const isHighRisk = score >= 2;
    badge.style.background = isHighRisk ? '#EF4444' : '#10B981';
    badge.textContent = `Puntaje: ${score} (${isHighRisk ? 'Alto Riesgo' : 'Bajo Riesgo'})`;
  }
  if (score >= 2) {
    const blueBracelet = document.getElementById('ncFallPreventionBlueBracelet');
    if (blueBracelet) blueBracelet.checked = true;
  }
  return score;
}

function buildNcMedicationRowHtml(row) {
  const r = row || {};
  const escapeAttr = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
  return `
    <tr class="nc-medication-row" data-record-id="${r.id || ''}">
      <td style="padding: 6px; border: 1px solid var(--border-color);"><input type="text" class="familiar-input nc-med-name" value="${escapeAttr(r.medicationName)}" style="width: 100%; padding: 4px 8px; font-size: 11px;"></td>
      <td style="padding: 6px; border: 1px solid var(--border-color);"><input type="text" class="familiar-input nc-med-dose" value="${escapeAttr(r.doseText)}" style="width: 100%; padding: 4px 8px; font-size: 11px;"></td>
      <td style="padding: 6px; border: 1px solid var(--border-color);"><input type="text" class="familiar-input nc-med-route" value="${escapeAttr(r.route)}" style="width: 100%; padding: 4px 8px; font-size: 11px;"></td>
      <td style="padding: 6px; border: 1px solid var(--border-color);"><input type="time" class="familiar-input nc-med-time" value="${escapeAttr(r.time)}" style="width: 100%; padding: 4px 8px; font-size: 11px;"></td>
      <td style="padding: 6px; border: 1px solid var(--border-color);">
        <input type="text" class="familiar-input nc-med-doublecheck-1" value="${escapeAttr(r.doubleCheckVerification1)}" placeholder="Nombre verificación 1" style="width: 100%; padding: 4px 8px; font-size: 11px; margin-bottom: 4px;">
        <input type="text" class="familiar-input nc-med-doublecheck-2" value="${escapeAttr(r.doubleCheckVerification2)}" placeholder="Nombre verificación 2" style="width: 100%; padding: 4px 8px; font-size: 11px;">
      </td>
      <td style="padding: 6px; border: 1px solid var(--border-color); text-align: center;">
        <button type="button" class="btn-remove-med btn-anim-lift" onclick="this.closest('tr').remove()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </td>
    </tr>`;
}

// Signo vital adicional del grupo "Signos Vitales" (Registro Clínico de
// Enfermería) — independiente del único registro que alimenta la Escala
// NEWS (ver kind en nursing.note.vital.signs). Solo repite Hora/PAS/PAD/FC/
// FR/Temp/Sat: Peso/Talla/BSA/IMC siguen siendo un valor fijo por nota
// (ncPeso/ncTalla/ncBSA/ncIMC), no se repiten por signo vital.
function buildNcVitalSignRowHtml(row) {
  const r = row || {};
  const cardStyle = 'background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;';
  const titleStyle = 'font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; margin-bottom: 12px;';
  const gridStyle = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;';
  const ro = 'background-color: #F5F6F8 !important; font-weight: 800 !important; color: #2F4C8A !important; border-color: #C9D6EC !important; cursor: not-allowed;';
  const pulse = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F4C8A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>';
  const v = (x) => (x ? x : '');
  const pesoNum = parseFloat(r.peso);
  const tallaNum = parseFloat(r.talla);
  const hasBody = pesoNum > 0 && tallaNum > 0;
  const bsaText = hasBody ? (0.007184 * Math.pow(pesoNum, 0.425) * Math.pow(tallaNum, 0.725)).toFixed(2) + ' m²' : '';
  const imcText = hasBody ? (pesoNum / Math.pow(tallaNum > 3 ? tallaNum / 100 : tallaNum, 2)).toFixed(2) + ' kg/m²' : '';
  return `
    <div class="nc-vital-sign-row" data-record-id="${r.id || ''}" style="border: 1.5px dashed rgba(47, 76, 138, 0.35); background: rgba(47, 76, 138, 0.03); border-radius: var(--radius-lg); padding: 16px; display: flex; flex-direction: column; gap: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
        <div style="font-size: 13px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 8px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2F4C8A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Signos Vitales
        </div>
        <div style="display: flex; align-items: flex-end; gap: 10px;">
          <div class="familiar-field-group" style="min-width: 160px; margin: 0;"><label>Hora de Captura</label><input type="time" class="familiar-input nc-vs-hora" value="${r.hora || ''}"></div>
          <button type="button" class="btn-remove-med btn-anim-lift" onclick="this.closest('.nc-vital-sign-row').remove()" title="Eliminar signo vital" style="flex-shrink: 0; margin-bottom: 7px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="nc-block-card" style="${cardStyle}">
        <div style="${titleStyle}">${pulse} Parámetros Hemodinámicos y Respiratorios</div>
        <div style="${gridStyle}">
          <div class="familiar-field-group"><label>Sistólica (mmHg)</label><input type="number" class="familiar-input nc-vs-pas" placeholder="Ej: 120" min="40" max="250" value="${v(r.pas)}"></div>
          <div class="familiar-field-group"><label>Diastólica (mmHg)</label><input type="number" class="familiar-input nc-vs-pad" placeholder="Ej: 80" min="30" max="180" value="${v(r.pad)}"></div>
          <div class="familiar-field-group"><label>Frec. Cardíaca (lpm)</label><input type="number" class="familiar-input nc-vs-fc" placeholder="Ej: 75" min="30" max="220" value="${v(r.fc)}"></div>
          <div class="familiar-field-group"><label>Frec. Respiratoria (rpm)</label><input type="number" class="familiar-input nc-vs-fr" placeholder="Ej: 18" min="8" max="60" value="${v(r.fr)}"></div>
        </div>
      </div>
      <div class="nc-block-card" style="${cardStyle}">
        <div style="${titleStyle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F4C8A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg> Temperaturas y Somatometría</div>
        <div style="${gridStyle}">
          <div class="familiar-field-group"><label>Temperatura (°C)</label><input type="number" step="0.1" class="familiar-input nc-vs-temp" placeholder="Ej: 36.5" min="30" max="45" value="${v(r.temp)}"></div>
          <div class="familiar-field-group"><label>Saturación O₂ (%)</label><input type="number" class="familiar-input nc-vs-sat" placeholder="Ej: 98" min="50" max="100" value="${v(r.sat)}"></div>
          <div class="familiar-field-group"><label>Peso (kg)</label><input type="number" step="0.1" class="familiar-input nc-vs-peso" placeholder="Ej: 70" min="1" max="300" value="${v(r.peso)}"></div>
          <div class="familiar-field-group"><label>Talla / Altura (cm)</label><input type="number" step="1" class="familiar-input nc-vs-talla" placeholder="Ej: 170" min="30" max="250" value="${v(r.talla)}"></div>
        </div>
      </div>
      <div class="nc-block-card" style="${cardStyle}">
        <div style="${titleStyle}">Índices Calculados Automáticamente (Solo Lectura)</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
          <div class="familiar-field-group"><label>Superficie Corporal (BSA DuBois m²)</label><input type="text" readonly placeholder="Calculado automáticamente" class="familiar-input nc-vs-bsa" style="${ro}" value="${bsaText}"></div>
          <div class="familiar-field-group"><label>Índice de Masa Corporal (IMC kg/m²)</label><input type="text" readonly placeholder="Calculado automáticamente" class="familiar-input nc-vs-imc" style="${ro}" value="${imcText}"></div>
        </div>
      </div>
    </div>`;
}

// "+ Agregar signo vital": cada fila nueva debe llegar completamente en
// blanco. Cada toma de signos vitales es independiente (distinta hora,
// distintos valores), así que no se precarga con los datos de la fila
// anterior.
function nextNcVitalSignDefaults(containerId) {
  return { hora: '' };
}

// "Medicamentos Entregados al Paciente al Egreso" (Bloque 7 de Registro
// Clínico de Enfermería, creación "nc*" y edición "edNc*") — antes era un
// solo <input>, así que un egreso con varios medicamentos había que
// apretujarlo todo en una sola línea. discharge_medications_note sigue
// siendo un Char único en el backend: cada renglón capturado aquí es solo
// una fila de UI, se juntan con "\n" al guardar (collectNcDischargeMedications)
// y se vuelven a separar por "\n" al reabrir una nota ya guardada para
// editar (ver el uso de .split('\n') en renderNursingClinicalEditCard).
function buildNcDischargeMedicationRowHtml(value) {
  const escapeAttr = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
  return `
    <div class="nc-discharge-medication-row" style="display: flex; gap: 8px; align-items: center;">
      <input type="text" class="familiar-input nc-discharge-medication-input" value="${escapeAttr(value)}" placeholder="Ej: Filgrastim 300 mcg SC (5 frascos) - Aplicación diaria a partir de mañana" style="width: 100%;">
      <button type="button" class="btn-remove-med btn-anim-lift" onclick="this.closest('.nc-discharge-medication-row').remove()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function resetNcDischargeMedications(containerId) {
  const container = document.getElementById(containerId);
  if (container) container.innerHTML = buildNcDischargeMedicationRowHtml('');
}

function collectNcDischargeMedications(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return '';
  return Array.from(container.querySelectorAll('.nc-discharge-medication-input'))
    .map(inp => inp.value.trim())
    .filter(Boolean)
    .join('\n');
}

document.addEventListener('input', (event) => {
  if (['ncNewsFC', 'ncNewsPAS', 'ncNewsFR', 'ncNewsTemp', 'ncNewsSat'].includes(event.target.id)) {
    recalcNcNewsScore();
  }
  if (event.target.id === 'ncEvaRangeInput') {
    updateNcEvaVisual(event.target.value);
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'ncNewsConsciencia') recalcNcNewsScore();
  if (NC_DOWNTON_CHECKBOX_IDS.includes(event.target.id)) recalcNcDowntonScore();
  // Sincronización ECOG → Karnofsky, igual que en la nota de Oncología (ver
  // 'selectECOG'/'edOncoECOG' más abajo en este archivo) — cubre tanto el
  // formulario de creación (ncEcogNumber) como la tarjeta de edición
  // independiente (edNcEcogNumber).
  const NC_ECOG_TO_KARNOFSKY = { ncEcogNumber: 'ncKarnofskyNumber', edNcEcogNumber: 'edNcKarnofskyNumber' };
  const karnofskyId = NC_ECOG_TO_KARNOFSKY[event.target.id];
  if (karnofskyId) {
    const ecogVal = parseInt(event.target.value, 10);
    const karnofskySelect = document.getElementById(karnofskyId);
    if (karnofskySelect && !isNaN(ecogVal)) {
      karnofskySelect.value = String(Math.max(0, 100 - (ecogVal * 20)));
      karnofskySelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
});

document.addEventListener('click', (event) => {
  if (event.target.closest('#btnRecalcularNews')) {
    event.preventDefault();
    recalcNcNewsScore();
    return;
  }
  const btnAddMedRow = event.target.closest('#btnAddNcMedicationRow');
  if (btnAddMedRow) {
    event.preventDefault();
    const tbody = document.getElementById('ncMedicationsTableBody');
    if (tbody) tbody.insertAdjacentHTML('beforeend', buildNcMedicationRowHtml());
    return;
  }
  const btnAddVitalSign = event.target.closest('#btnAddNcVitalSign');
  if (btnAddVitalSign) {
    event.preventDefault();
    const container = document.getElementById('ncExtraVitalSignsContainer');
    if (container) container.insertAdjacentHTML('beforeend', buildNcVitalSignRowHtml(nextNcVitalSignDefaults('ncExtraVitalSignsContainer')));
    return;
  }
  const btnAddDischargeMed = event.target.closest('#btnAddNcDischargeMedication');
  if (btnAddDischargeMed) {
    event.preventDefault();
    const container = document.getElementById('ncDischargeMedicationsContainer');
    if (container) container.insertAdjacentHTML('beforeend', buildNcDischargeMedicationRowHtml(''));
  }
});

async function saveNotaClinica() {
  const modal = document.getElementById('modalNotaClinica');
  const type = modal?.dataset.noteType;
  const config = NOTA_CLINICA_TYPES[type];
  const patientId = window.clivoraCurrentPatientId;
  if (!config || !patientId) return;

  let payload = {};
  if (config.endpoint === 'nursing') {
    const chk = (id) => document.getElementById(id)?.checked || false;
    payload = {
      nursingNoteKind: 'clinical_record',
      admissionWeightKg: parseFloat(document.getElementById('ncPeso')?.value) || 0,
      admissionHeightCm: parseFloat(document.getElementById('ncTalla')?.value) || 0,
      admissionTreatmentCycle: document.getElementById('ncCiclo')?.value.trim() || '',
      admissionAllergiesNote: document.getElementById('ncAlergias')?.value.trim() || 'Sin alergias conocidas',
      admissionFloorSuite: document.getElementById('ncPisoSuite')?.value.trim() || '',
      admissionIsolation: document.getElementById('ncAislamiento')?.value || 'ninguno',
      admissionCareModality: document.getElementById('ncModalidadAtencion')?.value.trim() || '',
      painScale: document.getElementById('ncEvaRangeInput')?.value || 0,
      downtonScore: recalcNcDowntonScore(),
      ecogNumber: document.getElementById('ncEcogNumber')?.value || 0,
      karnofskyNumber: document.getElementById('ncKarnofskyNumber')?.value || 0,
      glasgowMotor: document.getElementById('ncGlasgowMotor')?.value || 0,
      glasgowVerbal: document.getElementById('ncGlasgowVerbal')?.value || 0,
      glasgowOcular: document.getElementById('ncGlasgowOcular')?.value || 0,
      glasgowResult: document.getElementById('ncGlasgowResult')?.value || 0,
      previous_falls_downton: chk('ncDowntonPreviousFalls'),
      sedatives_downton: chk('ncDowntonSedatives'),
      diuretics_downton: chk('ncDowntonDiuretics'),
      antihipertensives_downton: chk('ncDowntonAntihipertensives'),
      antiparkinsonians_downton: chk('ncDowntonAntiparkinsonians'),
      antidepressants_downton: chk('ncDowntonAntidepressants'),
      desoriented_downton: chk('ncDowntonDesoriented'),
      visual_downton: chk('ncDowntonVisual'),
      auditive_downton: chk('ncDowntonAuditive'),
      limbs_downton: chk('ncDowntonLimbs'),
      safe_with_help_downton: chk('ncDowntonSafeWithHelp'),
      unsafe_with_help_downton: chk('ncDowntonUnsafeWithHelp'),
      impossible_downton: chk('ncDowntonImpossible'),
      comentarios: getEditableFieldValue(document.getElementById('ncNursingReport')),
      nauseaScale: document.getElementById('ncNauseaScale')?.value || '0',
      mucositisScale: document.getElementById('ncMucositisScale')?.value || '0',
      functionalFatigueScale: document.getElementById('ncFunctionalFatigueScale')?.value || '10',
      neutropeniaScale: document.getElementById('ncNeutropeniaScale')?.value || '0',
      labHemoglobin: parseFloat(document.getElementById('ncLabHemoglobin')?.value) || 0,
      labLeukocytes: parseInt(document.getElementById('ncLabLeukocytes')?.value, 10) || 0,
      labPlatelets: parseInt(document.getElementById('ncLabPlatelets')?.value, 10) || 0,
      labNeutrophils: parseInt(document.getElementById('ncLabNeutrophils')?.value, 10) || 0,
      systemsConsciousness: document.getElementById('ncSystemsConsciousness')?.value || 'alerta',
      systemsMood: document.getElementById('ncSystemsMood')?.value || 'tranquilo',
      systemsUrinary: document.getElementById('ncSystemsUrinary')?.value || 'espontaneo',
      systemsGastrointestinal: document.getElementById('ncSystemsGastrointestinal')?.value || 'normal',
      systemsCardiorespiratory: document.getElementById('ncSystemsCardiorespiratory')?.value || 'normal',
      systemsSkin: document.getElementById('ncSystemsSkin')?.value || 'integra',
      systemsObservations: getEditableFieldValue(document.getElementById('ncSystemsObservations')),
      evaPainLevel: parseInt(document.getElementById('ncEvaRangeInput')?.value, 10) || 0,
      evaCharacteristics: document.getElementById('ncEvaCharacteristics')?.value || 'sin_dolor',
      evaLocation: getEditableFieldValue(document.getElementById('ncEvaLocation')),
      evaIntervention: getEditableFieldValue(document.getElementById('ncEvaIntervention')),
      fallPreventionSideRails: chk('ncFallPreventionSideRails'),
      fallPreventionBrake: chk('ncFallPreventionBrake'),
      fallPreventionBlueBracelet: chk('ncFallPreventionBlueBracelet'),
      fallPreventionBell: chk('ncFallPreventionBell'),
      dischargeMedicationsNote: collectNcDischargeMedications('ncDischargeMedicationsContainer'),
      nurseResponsible1: document.getElementById('ncNurseResponsible1')?.value.trim() || '',
      nurseResponsible2: document.getElementById('ncNurseResponsible2')?.value.trim() || '',
      dischargeTime: document.getElementById('ncDischargeTime')?.value || '',
      newsVitals: {
        time: document.getElementById('ncNewsHora')?.value || '',
        fc: document.getElementById('ncNewsFC')?.value || 0,
        pas: document.getElementById('ncNewsPAS')?.value || 0,
        pad: document.getElementById('ncNewsPAD')?.value || 0,
        fr: document.getElementById('ncNewsFR')?.value || 0,
        temp: document.getElementById('ncNewsTemp')?.value || 0,
        sat: document.getElementById('ncNewsSat')?.value || 0,
        consciousness: document.getElementById('ncNewsConsciencia')?.value || 'A',
        newsScore: recalcNcNewsScore(),
      },
      vitalSignsCaptureTime: document.getElementById('ncVitalSignsHora')?.value || '',
      manualVitalSigns: Array.from(document.querySelectorAll('#ncExtraVitalSignsContainer .nc-vital-sign-row')).map(row => ({
        id: row.dataset.recordId ? parseInt(row.dataset.recordId, 10) : undefined,
        hora: row.querySelector('.nc-vs-hora')?.value || '',
        pas: row.querySelector('.nc-vs-pas')?.value || 0,
        pad: row.querySelector('.nc-vs-pad')?.value || 0,
        fc: row.querySelector('.nc-vs-fc')?.value || 0,
        fr: row.querySelector('.nc-vs-fr')?.value || 0,
        temp: row.querySelector('.nc-vs-temp')?.value || 0,
        sat: row.querySelector('.nc-vs-sat')?.value || 0,
        peso: row.querySelector('.nc-vs-peso')?.value || 0,
        talla: row.querySelector('.nc-vs-talla')?.value || 0,
      })),
      appliedMedications: Array.from(document.querySelectorAll('#ncMedicationsTableBody .nc-medication-row')).map(row => ({
        id: row.dataset.recordId ? parseInt(row.dataset.recordId, 10) : undefined,
        medicationName: row.querySelector('.nc-med-name')?.value.trim() || '',
        doseText: row.querySelector('.nc-med-dose')?.value.trim() || '',
        route: row.querySelector('.nc-med-route')?.value.trim() || '',
        time: row.querySelector('.nc-med-time')?.value || '',
        doubleCheckVerification1: row.querySelector('.nc-med-doublecheck-1')?.value.trim() || '',
        doubleCheckVerification2: row.querySelector('.nc-med-doublecheck-2')?.value.trim() || '',
      })).filter(m => m.medicationName),
    };
  } else if (config.endpoint === 'nutrition') {
    payload = {
      comentarios: getEditableFieldValue(document.getElementById('ncConsultationReason')),
      doesExercise: document.getElementById('ncDoesExercise')?.checked || false,
      exercisePerWeek: document.getElementById('ncExercisePerWeek')?.value || 0,
      diet: getEditableFieldValue(document.getElementById('ncDiet')),
      supplements: getEditableFieldValue(document.getElementById('ncSupplements')),
    };
  } else if (config.endpoint === 'psychology') {
    payload = {
      primaryCarer: document.getElementById('ncPrimaryCarer')?.value.trim() || '',
      hasEmotionalSupport: document.getElementById('ncHasEmotionalSupport')?.checked || false,
      calm: document.getElementById('ncCalm')?.checked || false,
      anxious: document.getElementById('ncAnxious')?.checked || false,
      sad: document.getElementById('ncSad')?.checked || false,
      irritable: document.getElementById('ncIrritable')?.checked || false,
      psychEvalPain: getEditableFieldValue(document.getElementById('ncPsychEvalPain')),
      comentarios: getEditableFieldValue(document.getElementById('ncPsychTeamObservations')),
    };
  } else if (config.endpoint === 'ambulatory') {
    payload = {
      procedureDate: document.getElementById('ncProcedureDate')?.value || false,
      procedureName: document.getElementById('ncProcedureName')?.value.trim() || '',
      procedureIndications: getEditableFieldValue(document.getElementById('ncProcedureIndications')),
      procedureDescription: getEditableFieldValue(document.getElementById('ncProcedureDescription')),
      patientTolerance: getEditableFieldValue(document.getElementById('ncPatientTolerance')),
    };
  } else if (config.endpoint === 'discharge') {
    payload = {
      dischargeDate: document.getElementById('ncDischargeDate')?.value || false,
      hospital: document.getElementById('ncHospital')?.value.trim() || '',
      hospitalRoom: document.getElementById('ncHospitalRoom')?.value.trim() || '',
      admissionDiagnosis: document.getElementById('ncAdmissionDiagnosis')?.value.trim() || '',
      dischargeDiagnosis: document.getElementById('ncDischargeDiagnosis')?.value.trim() || '',
      clinicSummary: getEditableFieldValue(document.getElementById('ncClinicSummary')),
      specificRecommendations: getEditableFieldValue(document.getElementById('ncSpecificRecommendations')),
    };
  } else if (config.endpoint === 'nephrology') {
    payload = {
      tfge: document.getElementById('ncTfge')?.value || 0,
      proteinuria: document.getElementById('ncProteinuria')?.value || 0,
      proteinuriaTotal: document.getElementById('ncProteinuriaTotal')?.value || 0,
      albumin: document.getElementById('ncAlbumin')?.value || 0,
      urineRatio: document.getElementById('ncUrineRatio')?.value || 0,
      comentarios: getEditableFieldValue(document.getElementById('ncNephrologyComments')),
    };
  } else if (config.endpoint === 'paliative') {
    payload = {
      edmontonPain: document.getElementById('ncEdmontonPain')?.value || 0,
      edmontonTiredness: document.getElementById('ncEdmontonTiredness')?.value || 0,
      edmontonNausea: document.getElementById('ncEdmontonNausea')?.value || 0,
      edmontonDepression: document.getElementById('ncEdmontonDepression')?.value || 0,
      edmontonAnxiety: document.getElementById('ncEdmontonAnxiety')?.value || 0,
      joinManage: document.getElementById('ncJoinManage')?.checked || false,
      medicalSupport: document.getElementById('ncMedicalSupport')?.checked || false,
      comentarios: getEditableFieldValue(document.getElementById('ncPaliativeComments')),
    };
  }

  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/consultations/${config.endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('save failed');
    await loadPatientConsultas(patientId);

    // Antes esto solo cerraba el modal sin ningún aviso — el usuario no
    // tenía forma de saber si el guardado había funcionado. Mismo overlay
    // de éxito que ya usan Signos Vitales / Nota Oncológica / Evaluación
    // Inicial, con título dinámico porque este modal se reutiliza para
    // Enfermería, Nutrición, Psicología, Procedimientos y Hospitalización.
    const successOverlay = document.getElementById('notaClinicaSuccessOverlay');
    const successTitle = document.getElementById('notaClinicaSuccessTitle');
    if (successTitle) successTitle.textContent = `¡${config.title} Guardada!`;
    if (successOverlay) successOverlay.style.display = 'flex';

    const btnNext = document.getElementById('btnNextNewNotaClinica');
    if (btnNext) {
      btnNext.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        if (modal) modal.style.display = 'none';
        const nuevaConsultaModal = document.getElementById('nuevaConsultaModal');
        if (nuevaConsultaModal) nuevaConsultaModal.style.display = 'flex';
      };
    }
    const btnBack = document.getElementById('btnNextViewConsultasNotaClinica');
    if (btnBack) {
      btnBack.onclick = () => {
        if (successOverlay) successOverlay.style.display = 'none';
        if (modal) modal.style.display = 'none';
      };
    }
  } catch (error) {
    console.error('Error al guardar nota clínica:', error);
    showClivoraAlertModal('No se pudo guardar la nota.');
  }
}

// ============================
// Evaluación Inicial de Enfermería — Valoración por Patrones Funcionales de
// Salud (Marjory Gordon). Reporte de entrada del paciente, distinto del
// Registro Clínico de Enfermería (arriba, modalNotaClinica) que es el
// reporte de salida/seguimiento.
// ============================
let clivoraNursingAssessmentQuestions = null;

async function fetchNursingAssessmentQuestions() {
  if (clivoraNursingAssessmentQuestions) return clivoraNursingAssessmentQuestions;
  try {
    const response = await fetch('/clivora/api/nursing/assessment_questions', { cache: 'no-store' });
    clivoraNursingAssessmentQuestions = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar preguntas de valoración de enfermería:', error);
    clivoraNursingAssessmentQuestions = [];
  }
  return clivoraNursingAssessmentQuestions;
}

function buildAssessmentQuestionRowHtml(item, index) {
  const name = `eiAnswer${index}`;
  return `
    <div class="familiar-form-card ei-question-card" data-pattern="${item.pattern.replace(/"/g, '&quot;')}" data-question="${item.question.replace(/"/g, '&quot;')}" style="padding: 12px 14px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card);">
      <div style="font-size: 13px; font-weight: 700; color: var(--text-main); margin-bottom: 8px;">${item.question}</div>
      <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 8px;">
        <label class="custom-radio"><input type="radio" name="${name}" value="si"><span></span> Sí</label>
        <label class="custom-radio"><input type="radio" name="${name}" value="no" checked><span></span> No</label>
        <label class="custom-radio"><input type="radio" name="${name}" value="na"><span></span> N/A</label>
      </div>
      <input type="text" class="familiar-input ei-answer-detail" placeholder="Especificar / detalle..." style="width: 100%;">
    </div>`;
}

// Agrupa las preguntas por patrón (Marjory Gordon) en acordeones plegables,
// cada uno con un atajo de "selección rápida" que marca Sí/No/N/A de golpe
// para todas las preguntas de ese patrón — antes era una lista plana sin
// agrupar, obligando a revisar radio por radio.
function buildAssessmentPatternAccordionHtml(pattern, items, offsetIndex, patternIndex) {
  const bodyId = `eiPatternBody${patternIndex}`;
  const rowsHtml = items
    .map((item, i) => buildAssessmentQuestionRowHtml(item, offsetIndex + i))
    .join('');
  return `
    <div class="ei-pattern-accordion" data-pattern-index="${patternIndex}" style="border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden;">
      <div class="ei-pattern-header" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--bg-main); cursor: pointer;">
        <span style="font-size: 12.5px; font-weight: 800; color: #2F4C8A;">${patternIndex + 1}. ${pattern}</span>
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="ei-quick-select" data-target="${bodyId}" style="display: flex; align-items: center; gap: 4px; font-size: 10px;">
            <span style="color: var(--text-muted); font-weight: 700; margin-right: 2px;">Selección rápida:</span>
            <button type="button" class="btn-secondary btn-anim-lift ei-quick-btn" data-value="si" style="padding: 2px 8px; font-size: 10px;">Sí</button>
            <button type="button" class="btn-secondary btn-anim-lift ei-quick-btn" data-value="no" style="padding: 2px 8px; font-size: 10px;">No</button>
            <button type="button" class="btn-secondary btn-anim-lift ei-quick-btn" data-value="na" style="padding: 2px 8px; font-size: 10px;">N/A</button>
          </div>
          <svg class="ei-pattern-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.2s;"><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </div>
      <div class="ei-pattern-body" id="${bodyId}" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; padding: 14px;">
        ${rowsHtml}
      </div>
    </div>`;
}

function groupAssessmentQuestionsByPattern(questions) {
  const groups = [];
  const byPattern = new Map();
  questions.forEach((item) => {
    if (!byPattern.has(item.pattern)) {
      const group = { pattern: item.pattern, items: [] };
      byPattern.set(item.pattern, group);
      groups.push(group);
    }
    byPattern.get(item.pattern).items.push(item);
  });
  return groups;
}

async function openEvaluacionInicialModal() {
  const nombreInput = document.getElementById('eiPacienteNombre');
  if (nombreInput) nombreInput.value = document.getElementById('detailPatientName')?.textContent?.trim() || '';
  const fechaInput = document.getElementById('eiFechaIngreso');
  if (fechaInput && !fechaInput.value) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    fechaInput.value = now.toISOString().slice(0, 16);
  }
  setEditableFieldValue(document.getElementById('eiNursingReport'), '');

  // Datos generales de solo lectura: se toman de lo que ya está cargado en
  // la ficha del paciente (Información General), no se piden de nuevo.
  const eiGenero = document.getElementById('eiGenero');
  if (eiGenero) {
    const generoSelect = document.getElementById('detailGenero');
    eiGenero.value = generoSelect?.options[generoSelect.selectedIndex]?.textContent?.trim() || '';
  }
  const eiFechaNacEdad = document.getElementById('eiFechaNacEdad');
  if (eiFechaNacEdad) {
    const fechaNac = document.getElementById('detailFechaNacimiento')?.value || '';
    const edad = document.getElementById('detailEdad')?.value || '';
    eiFechaNacEdad.value = [fechaNac, edad].filter(Boolean).join(' / ');
  }
  const eiMedico = document.getElementById('eiMedicoTratante');
  if (eiMedico) {
    const doctorSelect = document.getElementById('detailDoctor');
    eiMedico.value = doctorSelect?.options[doctorSelect.selectedIndex]?.textContent?.trim() || '';
  }
  const eiExpediente = document.getElementById('eiExpediente');
  if (eiExpediente) eiExpediente.value = document.getElementById('detailPatientExp')?.textContent?.trim() || '';

  // Datos propios de esta nota (talla/peso/ciclo/alergias/piso/aislamiento/
  // modalidad): se capturan aquí y se guardan con la nota, ya se agregaron
  // los campos correspondientes en el modelo nursing.note del backend.
  ['eiTalla', 'eiPeso', 'eiCiclo', 'eiPisoSuite', 'eiModalidadAtencion'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Alergias: antes se dejaba fijo en "Sin alergias conocidas" sin importar
  // el paciente — ahora se precarga con lo ya capturado en su Historia
  // Clínica, igual que ya hace populatePatientHeaderInfo en Recetas/Nota
  // Oncológica (queda editable por si hay que anotar algo puntual de esta
  // valoración).
  const eiAlergias = document.getElementById('eiAlergias');
  if (eiAlergias) {
    eiAlergias.value = 'Sin alergias conocidas';
    fetchPatientAllergiesSummary(window.clivoraCurrentPatientId).then(summary => {
      eiAlergias.value = summary;
    });
  }
  const eiAislamiento = document.getElementById('eiAislamiento');
  if (eiAislamiento) eiAislamiento.value = 'ninguno';

  const questions = await fetchNursingAssessmentQuestions();
  const groups = groupAssessmentQuestionsByPattern(questions);
  const container = document.getElementById('eiAssessmentContainer');
  if (container) {
    let offset = 0;
    container.innerHTML = groups.map((group, patternIndex) => {
      const html = buildAssessmentPatternAccordionHtml(group.pattern, group.items, offset, patternIndex);
      offset += group.items.length;
      return html;
    }).join('');
  }
  const modal = document.getElementById('modalEvaluacionInicialEnfermeria');
  if (modal) modal.style.display = 'flex';
}

// Plegar/desplegar un patrón al hacer clic en su encabezado, y aplicar la
// selección rápida (Sí/No/N/A) a todas las preguntas de ese patrón.
document.addEventListener('click', (event) => {
  const quickBtn = event.target.closest('.ei-quick-btn');
  if (quickBtn) {
    event.preventDefault();
    const wrapper = quickBtn.closest('.ei-quick-select');
    const bodyId = wrapper?.dataset.target;
    const body = bodyId ? document.getElementById(bodyId) : null;
    if (body) {
      body.querySelectorAll(`input[type="radio"][value="${quickBtn.dataset.value}"]`).forEach(radio => {
        radio.checked = true;
      });
    }
    return;
  }
  const patternHeader = event.target.closest('.ei-pattern-header');
  if (patternHeader && !event.target.closest('.ei-quick-select')) {
    const accordion = patternHeader.closest('.ei-pattern-accordion');
    const body = accordion?.querySelector('.ei-pattern-body');
    const chevron = accordion?.querySelector('.ei-pattern-chevron');
    if (body) {
      const isCollapsed = body.style.display === 'none';
      body.style.display = isCollapsed ? 'grid' : 'none';
      if (chevron) chevron.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
  }
});

async function saveEvaluacionInicial() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;
  const container = document.getElementById('eiAssessmentContainer');
  const assessmentAnswers = container ? Array.from(container.querySelectorAll('.familiar-form-card')).map(card => {
    const checked = card.querySelector('input[type="radio"]:checked');
    return {
      pattern: card.dataset.pattern || '',
      question: card.dataset.question || '',
      answer: checked ? checked.value : 'no',
      detail: card.querySelector('.ei-answer-detail')?.value.trim() || '',
    };
  }) : [];

  const payload = {
    nursingNoteKind: 'initial_assessment',
    comentarios: getEditableFieldValue(document.getElementById('eiNursingReport')),
    assessmentAnswers,
    admissionWeightKg: parseFloat(document.getElementById('eiPeso')?.value) || 0,
    admissionHeightCm: parseFloat(document.getElementById('eiTalla')?.value) || 0,
    admissionTreatmentCycle: document.getElementById('eiCiclo')?.value.trim() || '',
    admissionAllergiesNote: document.getElementById('eiAlergias')?.value.trim() || 'Sin alergias conocidas',
    admissionFloorSuite: document.getElementById('eiPisoSuite')?.value.trim() || '',
    admissionIsolation: document.getElementById('eiAislamiento')?.value || 'ninguno',
    admissionCareModality: document.getElementById('eiModalidadAtencion')?.value.trim() || '',
  };
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/consultations/nursing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      showClivoraAlertModal('No se pudo guardar la Evaluación Inicial de Enfermería.');
      return;
    }
    await loadPatientConsultas(patientId);
    const successOverlay = document.getElementById('notasEnfermeriaSuccessOverlay');
    if (successOverlay) successOverlay.style.display = 'flex';
  } catch (error) {
    console.error('Error al guardar Evaluación Inicial de Enfermería:', error);
    showClivoraAlertModal('No se pudo guardar la Evaluación Inicial de Enfermería.');
  }
}

document.addEventListener('click', (event) => {
  const btnBackFormato = event.target.closest('#btnBackSeleccionFormatoEnfermeria');
  if (btnBackFormato) {
    event.preventDefault();
    const modal = document.getElementById('modalSeleccionFormatoEnfermeria');
    if (modal) modal.style.display = 'none';
    const nuevaConsulta = document.getElementById('nuevaConsultaModal');
    if (nuevaConsulta) nuevaConsulta.style.display = 'flex';
    return;
  }
  if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalSeleccionFormatoEnfermeria') {
    event.target.style.display = 'none';
    return;
  }
  const btnEvalInicial = event.target.closest('#btnFormatoEvaluacionInicial');
  if (btnEvalInicial) {
    event.preventDefault();
    const modalFormato = document.getElementById('modalSeleccionFormatoEnfermeria');
    if (modalFormato) modalFormato.style.display = 'none';
    openEvaluacionInicialModal();
    return;
  }
  const btnRegistroClinico = event.target.closest('#btnFormatoRegistroClinico');
  if (btnRegistroClinico) {
    event.preventDefault();
    const modalFormato = document.getElementById('modalSeleccionFormatoEnfermeria');
    if (modalFormato) modalFormato.style.display = 'none';
    openNotaClinicaModal('Notas de enfermeria');
    return;
  }
  const btnCloseEval = event.target.closest('#closeEvaluacionInicialModal');
  if (btnCloseEval) {
    event.preventDefault();
    const modal = document.getElementById('modalEvaluacionInicialEnfermeria');
    if (modal) modal.style.display = 'none';
    return;
  }
  if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalEvaluacionInicialEnfermeria') {
    event.target.style.display = 'none';
    return;
  }
  const btnSaveEval = event.target.closest('#btnSaveEvaluacionInicial');
  if (btnSaveEval) {
    event.preventDefault();
    runClivoraSaveOnce('evaluacionInicial', btnSaveEval, saveEvaluacionInicial);
    return;
  }
  const btnBackEval = event.target.closest('#btnBackEvaluacionInicial');
  if (btnBackEval) {
    event.preventDefault();
    const modal = document.getElementById('modalEvaluacionInicialEnfermeria');
    const modalFormato = document.getElementById('modalSeleccionFormatoEnfermeria');
    if (modal) modal.style.display = 'none';
    if (modalFormato) modalFormato.style.display = 'flex';
    return;
  }
  const btnPrintEval = event.target.closest('#btnPrintEvaluacionInicial');
  if (btnPrintEval) {
    event.preventDefault();
    window.print();
    return;
  }
});

// ============================
// HC — Sección 12: Análisis y Diagnóstico
// ============================
const ANALISIS_FIELD_MAP = { analysisText: 'hc_analysis' };

// Si el campo llega vacío (paciente nuevo, o una historia clínica ya
// guardada sin este texto capturado) se precarga con "VER PEEA" en vez de
// dejarlo en blanco — el análisis real vive en la sección PEEA, este campo
// legado ya no se llena a mano salvo que el médico lo necesite. El médico
// lo ajusta/sobreescribe si el caso lo requiere (mismo criterio que el
// texto estándar de Premedicación/Postmedicación en Receta Oncológica).
function populateAnalisisDiagnostico(hc) {
  applyFieldMap({ ...hc, hc_analysis: hc.hc_analysis || 'VER PEEA' }, ANALISIS_FIELD_MAP);
}

function collectAnalisisDiagnostico(payload) {
  collectFieldMapInto(payload, ANALISIS_FIELD_MAP);
}

// ============================
// HC — Sección 12b: Lista de Diagnósticos
// Antes "Diagnóstico (CIE-11)" era un solo campo de texto fijo — el diseño
// nuevo permite varios diagnósticos con "+ Agregar Diagnóstico" y quitar
// (x) por entrada, con su propio modelo/endpoint (mismo patrón de sync
// completo que family_history).
// ============================
let clivoraDiagnosisLines = [];

// Selección contra el catálogo CIE-11 (cie11.diagnosis) — antes "Análisis y
// Diagnóstico" y la tabla de diagnósticos de la Nota Oncológica eran texto
// libre sin ningún catálogo real detrás. Es un buscador (escribe código o
// nombre) que pega al backend por cada tecla (con debounce): el backend
// busca en el CIE-11 completo de la OMS y el CIE-10 de la OPS, sin depender
// de acentos ni de ortografía exacta y también por sinónimos — ver
// /clivora/api/cie11/search en apps/expediente/compat.py. Ya no se puede traer "todo el catálogo" una sola vez
// como antes (era viable con 38 registros curados, no con el catálogo
// completo).
function escapeHtmlCie11(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// `input` es el <input class="cie11-search-input"> y su dropdown flotante es
// el sibling `.cie11-search-dropdown` dentro del mismo wrapper (ver
// buildDiagnosisLineCardHtml y la fila de diagnósticos de Nota Oncológica).
// El id realmente seleccionado vive en input.dataset.selectedId — el texto
// visible ("código - nombre") es solo para mostrar/editar la búsqueda, no la
// fuente de verdad (a diferencia del <select> anterior, donde value SÍ lo era).
// El valor inicial (para una fila ya guardada) lo pone quien arma el HTML
// (ej. buildDiagnosisLineCardHtml usa row.diagnosis) — esta función ya no
// necesita resolverlo contra ningún catálogo pre-cargado.
function attachCie11Search(input) {
  if (!input || input.dataset.cie11Wired) return;
  input.dataset.cie11Wired = '1';
  const dropdown = input.parentElement?.querySelector('.cie11-search-dropdown');
  if (!dropdown) return;

  // Este buscador vive dentro de tarjetas/acordeones que recortan su propio
  // contenido (.nopat-card, .accordion-content, etc.) — sin esto el
  // dropdown flotante se cortaba contra el borde de la tarjeta en vez de
  // quedar por encima. Mismo mecanismo "has-open-select" que ya usan
  // enhanceCustomSelect/enhanceCustomDatePicker para lo mismo.
  const containerClasses = ['nopat-card', 'form-group', 'accordion-content', 'accordion-item', 'onco-accordion-content', 'onco-accordion-item', 'patient-create-section', 'nc-block-card'];

  // Además, en la Tabla de Diagnósticos de la Nota Oncológica el buscador va
  // dentro de una tabla con scroll horizontal que recortaba la lista (solo se
  // veía una opción). Mientras está abierta, la lista se saca al <body> y se
  // posiciona fija bajo el input (o encima, si no cabe abajo); al cerrar
  // regresa a su lugar.
  const dropdownHome = dropdown.parentElement;
  function positionDropdown() {
    if (dropdown.style.display !== 'block') return;
    const rect = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const height = Math.min(dropdown.scrollHeight || 240, 240);
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = `${Math.max(rect.width, 260)}px`;
    if (spaceBelow < height + 12 && rect.top > spaceBelow) {
      dropdown.style.top = `${Math.max(rect.top - height - 4, 8)}px`;
    } else {
      dropdown.style.top = `${rect.bottom + 4}px`;
    }
  }
  function floatDropdown() {
    if (dropdown.parentElement !== document.body) document.body.appendChild(dropdown);
    Object.assign(dropdown.style, { position: 'fixed', right: 'auto', zIndex: '100000', maxHeight: '240px', overflowY: 'auto' });
    positionDropdown();
  }
  window.addEventListener('scroll', positionDropdown, true);
  window.addEventListener('resize', positionDropdown);

  function openDropdown() {
    floatDropdown();
    let p = input.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        p.classList.add('has-open-select');
        p.style.overflow = 'visible';
      }
      p = p.parentElement;
    }
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    if (dropdownHome && dropdown.parentElement !== dropdownHome && dropdownHome.isConnected) {
      dropdownHome.appendChild(dropdown);
    } else if (!dropdownHome?.isConnected) {
      dropdown.remove();
    }
    let p = input.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        if (!p.querySelector('.cie11-search-dropdown[style*="block"], .custom-select-container.is-open, .custom-date-container.is-open')) {
          p.classList.remove('has-open-select');
          p.style.overflow = '';
        }
      }
      p = p.parentElement;
    }
  }

  function renderResults(list) {
    dropdown.innerHTML = '';
    if (list.length === 0) {
      dropdown.innerHTML = '<div style="padding: 8px 12px; font-size: 11px; color: var(--text-muted); text-align: center;">No hay diagnósticos con ese texto</div>';
    } else {
      list.forEach((r) => {
        const item = document.createElement('div');
        item.className = 'cita-patient-item';
        // Etiqueta del catálogo (CIE-11 / CIE-10, ver catalog en
        // /clivora/api/cie11/search) antes del código.
        const catalogLabel = r.catalog === 'cie10' ? 'CIE-10' : 'CIE-11';
        item.innerHTML = `<span><span class="cie-catalog-tag cie-catalog-${escapeHtmlCie11(r.catalog || 'cie11')}">${catalogLabel}</span>${escapeHtmlCie11(r.code)} - ${escapeHtmlCie11(r.name)}</span>`;
        item.addEventListener('click', () => {
          input.value = `${r.code} - ${r.name}`;
          input.dataset.selectedId = r.id;
          closeDropdown();
        });
        dropdown.appendChild(item);
      });
    }
    dropdown.style.display = 'block';
    openDropdown();
  }

  let searchToken = 0;
  async function performSearch(term) {
    const query = term.trim();
    const myToken = ++searchToken;
    if (!query) {
      dropdown.innerHTML = '<div style="padding: 8px 12px; font-size: 11px; color: var(--text-muted); text-align: center;">Escribe para buscar (código o nombre)</div>';
      dropdown.style.display = 'block';
      openDropdown();
      return;
    }
    dropdown.innerHTML = '<div style="padding: 8px 12px; font-size: 11px; color: var(--text-muted); text-align: center;">Buscando...</div>';
    dropdown.style.display = 'block';
    openDropdown();
    let results = [];
    try {
      const response = await fetch(`/clivora/api/cie11/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      results = response.ok ? await response.json() : [];
    } catch (error) {
      console.error('Error al buscar en el catálogo CIE-11:', error);
      results = [];
    }
    // Una búsqueda más nueva ya salió disparada mientras esta esperaba
    // respuesta (el usuario siguió escribiendo) — descartarla evita que una
    // respuesta vieja "adelante" pise el resultado de la búsqueda actual.
    if (myToken !== searchToken) return;
    renderResults(results);
  }

  let debounceTimer = null;
  input.addEventListener('focus', () => performSearch(input.value));
  input.addEventListener('input', () => {
    // Escribir invalida la selección anterior hasta que se elija una opción
    // de la lista de nuevo — evita guardar un id viejo que ya no corresponde
    // al texto visible.
    input.dataset.selectedId = '';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => performSearch(input.value), 300);
  });
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      closeDropdown();
    }
  });
}

function buildDiagnosisLineCardHtml(row, cardId, index) {
  const r = row || {};
  const escapeAttr = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
  return `
    <div class="nopat-card diagnosis-line-card" id="${cardId}" data-record-id="${r.id || ''}"
      style="padding: 24px; border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <label style="font-size: 12px; font-weight: 800; color: var(--text-main);">DIAGNÓSTICO ${index}</label>
        <button type="button" class="btn-remove-med btn-anim-lift" onclick="document.getElementById('${cardId}').remove()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <label
        style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: block;">DIAGNÓSTICO
        (CIE-11 / CIE-10)</label>
      <div style="position: relative; margin-bottom: 16px;">
        <input type="text" class="familiar-input diagnosis-line-input cie11-search-input" data-selected-id="${r.cie11_diagnosis_id || ''}"
          value="${escapeAttr(r.diagnosis || '')}"
          placeholder="Buscar por código o nombre (ej. C50, Leucemia, COVID)..." autocomplete="off" style="width: 100%;">
        <div class="cie11-search-dropdown agenda-patient-dropdown" style="display: none;"></div>
      </div>
      <label
        style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: block;">COMENTARIOS</label>
      <input type="text" class="familiar-input diagnosis-line-comment" value="${escapeAttr(r.comment || '')}"
        placeholder="Comentario breve sobre este diagnóstico..." style="width: 100%;">
    </div>`;
}

function renderDiagnosisLines() {
  const container = document.getElementById('diagnosisLinesContainer');
  if (!container) return;
  container.innerHTML = clivoraDiagnosisLines
    .map((row, index) => buildDiagnosisLineCardHtml(row, `diagnosis-line-${row.id || `new-${index}`}`, index + 1))
    .join('');
  container.querySelectorAll('.diagnosis-line-input').forEach(attachCie11Search);
}

async function loadPatientDiagnosisLines(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/diagnosis_lines`, { cache: 'no-store' });
    clivoraDiagnosisLines = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar diagnósticos:', error);
    clivoraDiagnosisLines = [];
  }
  renderDiagnosisLines();
}

function addDiagnosisLineRow() {
  const container = document.getElementById('diagnosisLinesContainer');
  if (!container) return;
  const index = container.querySelectorAll('.diagnosis-line-card').length + 1;
  container.insertAdjacentHTML('beforeend', buildDiagnosisLineCardHtml({}, `diagnosis-line-new-${Date.now()}`, index));
  const added = container.lastElementChild?.querySelector('.diagnosis-line-input');
  if (added) attachCie11Search(added);
}

async function saveDiagnosisLines() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return true;
  const container = document.getElementById('diagnosisLinesContainer');
  const rows = container ? Array.from(container.querySelectorAll('.diagnosis-line-card')).map(card => {
    const input = card.querySelector('.diagnosis-line-input');
    const selectedId = input?.dataset.selectedId || '';
    return {
      id: card.dataset.recordId ? parseInt(card.dataset.recordId, 10) : undefined,
      diagnosis: selectedId ? input.value.trim() : '',
      cie11_diagnosis_id: selectedId ? parseInt(selectedId, 10) : false,
      comment: card.querySelector('.diagnosis-line-comment')?.value.trim() || '',
    };
  }) : [];
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/diagnosis_lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    if (!response.ok) console.error('Error al guardar diagnósticos: HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error('Error al guardar diagnósticos:', error);
    return false;
  }
}

document.addEventListener('click', (event) => {
  const btnAddDiag = event.target.closest('#btnAddDiagnosisLine');
  if (btnAddDiag) {
    event.preventDefault();
    addDiagnosisLineRow();
  }
});

// ============================
// HC — Sección 13: Plan de Tratamiento y Pronóstico
// ============================
const PLAN_TRATAMIENTO_FIELD_MAP = {
  treatmentPlanDescription: 'treatment_plan_description',
  treatmentPlanForecast: 'forecast_option_id',
};

// Igual criterio que ANALISIS_FIELD_MAP: el plan real vive en PEEA, así
// que este campo legado se precarga con "VER PEEA" en vez de vacío. El
// Pronóstico, al no tener todavía nada capturado, siempre debe arrancar en
// "Reservado" (no en blanco) — el médico lo cambia si el caso es
// Favorable/Desfavorable.
async function populatePlanTratamiento(hc) {
  const catalogs = await ensureHcCatalogs();
  const reservado = (catalogs.forecast_options || [])
    .find(o => (o.name || '').trim().toLowerCase() === 'reservado');
  const forecastId = hc.forecast_option_id || (reservado ? reservado.id : '');
  fillSelectOptions(document.getElementById('treatmentPlanForecast'), catalogs.forecast_options,
                     forecastId, 'Seleccionar pronóstico');
  applyFieldMap({
    ...hc,
    treatment_plan_description: hc.treatment_plan_description || 'VER PEEA',
    forecast_option_id: forecastId,
  }, PLAN_TRATAMIENTO_FIELD_MAP);
}

function collectPlanTratamiento(payload) {
  collectFieldMapInto(payload, PLAN_TRATAMIENTO_FIELD_MAP);
}

function populatePatientDomicilioFiscal(data) {
  const fiscal = (data && data.domicilio_fiscal) || {};
  const setField = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  };
  setField('detailFiscalPais', fiscal.pais);
  setField('detailFiscalEstado', fiscal.estado);
  setField('detailFiscalCiudad', fiscal.ciudad);
  setField('detailFiscalColonia', fiscal.colonia);
  setField('detailFiscalCodigoPostal', fiscal.codigoPostal);
  setField('detailFiscalCalle', fiscal.calle);
  setField('detailFiscalNumeroCasa', fiscal.numeroCasa);
}

// "Médico / Doctor Asignado" de la ficha, filtrado por la "Especialidad" de
// al lado (como "Cita con" → "Doctor" del alta). Sin especialidad muestra a
// todos los doctores: hay pacientes cuyo doctor no tiene especialidad en su
// ficha y no deben perderlo.
async function populateDetailDoctorSelect(selectedName) {
  const doctorEl = document.getElementById('detailDoctor');
  if (!doctorEl) return;
  const specialtyId = document.getElementById('detailDoctorEspecialidad')?.value || '';
  doctorEl.value = '';
  await populateDoctorSelectOptions(doctorEl, null, specialtyId);
  if (selectedName && [...doctorEl.options].some(opt => opt.value === selectedName)) {
    doctorEl.value = selectedName;
  }
  doctorEl.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('change', (event) => {
  if (event.target && event.target.id === 'detailDoctorEspecialidad') {
    populateDetailDoctorSelect(document.getElementById('detailDoctor')?.value || '');
  }
});

async function populatePatientReferralSelectOptions(selectEl, selectedName) {
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">Seleccionar origen</option>';
  try {
    const response = await fetch('/clivora/api/patient_referrals');
    if (!response.ok) return;
    const referrals = await response.json();
    referrals.forEach(referral => {
      const option = document.createElement('option');
      option.value = referral.name;
      option.textContent = referral.name;
      selectEl.appendChild(option);
    });
    if (selectedName) selectEl.value = selectedName;
  } catch (error) {
    console.error('Error al cargar origen de referencia:', error);
  }
}

// La tarjeta de "Historia Gineco-Obstétrica" dentro del acordeón de
// Antecedentes Médicos solo aplica a pacientes femeninas — se oculta esa
// tarjeta (no toda la sección, que ahora agrupa las 7 antiguas secciones)
// para cualquier otro género.
function updateGinecoSectionVisibility(genero) {
  const isFemale = genero === 'Femenino';
  const ginecoItem = document.getElementById('hc-gineco-accordion-item');
  if (ginecoItem) ginecoItem.style.display = isFemale ? '' : 'none';
}

document.addEventListener('change', (event) => {
  if (event.target && event.target.id === 'detailGenero') {
    updateGinecoSectionVisibility(event.target.value);
  }
});

async function populatePatientInfoGeneral(data) {
  setDetailPatientAvatar((data && data.photoUrl) || '');
  const info = (data && data.info_general) || {};
  // "Religión" vive en la Historia Clínica, no en los datos del paciente
  // como el resto de estos campos — se muestra aquí por pedido
  // del usuario, pero se puebla/guarda contra ese otro registro (ver
  // saveInfoGeneral).
  const religionEl = document.getElementById('detailReligion');
  if (religionEl) religionEl.value = (data && data.historia_clinica && data.historia_clinica.religion) || '';

  const primerApellidoEl = document.getElementById('detailPrimerApellido');
  const segundoApellidoEl = document.getElementById('detailSegundoApellido');
  const nombresEl = document.getElementById('detailNombres');
  const fechaNacimientoEl = document.getElementById('detailFechaNacimiento');
  const edadEl = document.getElementById('detailEdad');
  const generoEl = document.getElementById('detailGenero');
  const ocupacionEl = document.getElementById('detailOcupacion');
  const origenEl = document.getElementById('detailOrigenReferencia');
  const emailEl = document.getElementById('detailEmail');
  const celularEl = document.getElementById('detailCelular');
  const telefonoEl = document.getElementById('detailTelefono');
  const estadoCivilEl = document.getElementById('detailEstadoCivil');
  const curpEl = document.getElementById('detailCurp');

  const extEl = document.getElementById('detailMedicoExterno');
  const intEl = document.getElementById('detailMedicoInterno');
  const refEl = document.getElementById('detailMedicoReferenciador');
  const sjEl = document.getElementById('detailMedicoSanJose');

  const pillNacimiento = document.getElementById('detailPillNacimiento');
  const pillEdad = document.getElementById('detailPillEdad');
  const pillCelular = document.getElementById('detailPillCelular');
  const pillMedico = document.getElementById('detailPillMedico');

  await Promise.all([
    populateDoctorSelectOptions(extEl, 'external'),
    populateDoctorSelectOptions(intEl, 'internal'),
    populateDoctorSelectOptions(refEl),
    populateDoctorSelectOptions(sjEl),
  ]);
  const especialidadEl = document.getElementById('detailDoctorEspecialidad');
  if (especialidadEl) {
    especialidadEl.value = '';
    await populateEspecialidadSelectOptions(especialidadEl);
    especialidadEl.value = info.doctorSpecialtyId ? String(info.doctorSpecialtyId) : '';
  }
  await populateDetailDoctorSelect(info.doctorName);
  // Refresca el texto visible del select personalizado (enhanceCustomSelect);
  // su listener vuelve a filtrar Doctor con el mismo valor, sin efecto.
  especialidadEl?.dispatchEvent(new Event('change', { bubbles: true }));

  if (primerApellidoEl) primerApellidoEl.value = info.primerApellido || '';
  if (segundoApellidoEl) segundoApellidoEl.value = info.segundoApellido || '';
  if (nombresEl) nombresEl.value = info.nombres || '';

  const birthDateVal = info.fechaNacimiento || '';
  if (fechaNacimientoEl) fechaNacimientoEl.value = birthDateVal;
  // La edad ya viene calculada desde el backend (a partir de la fecha de
  // nacimiento) — se usa esa como fuente de verdad;
  // calculateAge() queda solo para el recálculo instantáneo en pantalla
  // mientras se edita la fecha, antes de guardar.
  const computedAge = info.edad || calculateAge(birthDateVal);
  if (edadEl) edadEl.value = computedAge;

  if (pillNacimiento) pillNacimiento.textContent = birthDateVal ? formatDateDMY(birthDateVal) : 'Sin registrar';
  if (pillEdad) pillEdad.textContent = computedAge || 'Sin calcular';

  if (generoEl) generoEl.value = info.genero || '';
  updateGinecoSectionVisibility(info.genero);
  if (ocupacionEl) ocupacionEl.value = info.ocupacion || '';
  await populatePatientReferralSelectOptions(origenEl, info.origenReferencia);
  if (emailEl) emailEl.value = info.email || '';
  if (celularEl) celularEl.value = info.celular || '';
  if (telefonoEl) telefonoEl.value = info.telefono || '';
  if (estadoCivilEl) estadoCivilEl.value = info.estadoCivil || '';
  if (curpEl) curpEl.value = info.curp || '';
  const tutorLegalEl = document.getElementById('detailTutorLegal');
  if (tutorLegalEl) tutorLegalEl.value = info.tutorLegal || '';
  updateDetailTutorLegalVisibility(info.fechaNacimiento);

  [extEl, intEl, refEl, sjEl].forEach(el => { if (el) el.value = ''; });
  const referralEl = getReferralDoctorSelect('detail', info.origenReferencia);
  if (referralEl && info.medicoReferencia) {
    // El doctor guardado puede ya no tener el check de referencia (y por eso
    // no venir en la lista filtrada) — se agrega para no perderlo al guardar.
    if (![...referralEl.options].some(opt => opt.value === info.medicoReferencia)) {
      const option = document.createElement('option');
      option.value = info.medicoReferencia;
      option.textContent = info.medicoReferencia;
      referralEl.appendChild(option);
    }
    referralEl.value = info.medicoReferencia;
  }
  // Refresca el texto visible del select personalizado (enhanceCustomSelect).
  [extEl, intEl, refEl, sjEl].forEach(el => el?.dispatchEvent(new Event('change', { bubbles: true })));

  if (pillMedico) pillMedico.textContent = info.doctorName || 'Sin asignar';
  if (pillCelular) pillCelular.textContent = info.celular || 'Sin registrar';

  updateDetailReferenceFields();
}

function toggleInfoGeneralEditMode(enable) {
  const fields = document.querySelectorAll('#infoGeneralForm .info-general-field');
  fields.forEach(field => {
    field.disabled = !enable;
  });

  const actionsEl = document.getElementById('infoGeneralActions');
  if (actionsEl) {
    actionsEl.style.display = enable ? 'flex' : 'none';
  }

  const editBtn = document.getElementById('btnEditInfoGeneral');
  if (editBtn) {
    if (enable) {
      editBtn.classList.add('editing');
      editBtn.title = 'Cancelar edición';
    } else {
      editBtn.classList.remove('editing');
      editBtn.title = 'Editar Información General';
    }
  }

  if (enable) {
    const accordion = document.getElementById('infoGeneralAccordion');
    if (accordion) accordion.classList.add('open');
    const firstInput = document.getElementById('detailPrimerApellido');
    if (firstInput) firstInput.focus();
  }
}

// Edad (campo y tarjeta del encabezado) y tarjeta de Nacimiento a partir de
// la fecha de nacimiento de Información General.
function updateDetailAgeFromBirthdate(birthDate) {
  const computedAge = calculateAge(birthDate);
  const edadEl = document.getElementById('detailEdad');
  const pillEdad = document.getElementById('detailPillEdad');
  const pillNacimiento = document.getElementById('detailPillNacimiento');
  if (edadEl) edadEl.value = computedAge;
  if (pillEdad) pillEdad.textContent = computedAge || 'Sin calcular';
  if (pillNacimiento) pillNacimiento.textContent = birthDate ? formatDateDMY(birthDate) : 'Sin registrar';
  updateDetailTutorLegalVisibility(birthDate);
}

// Tutor legal de la Información General: igual que en el alta de paciente,
// aplica a menores de edad; también se muestra si ya hay uno capturado (para
// no esconder un dato guardado).
function updateDetailTutorLegalVisibility(birthDate) {
  const group = document.getElementById('detailTutorLegalGroup');
  if (!group) return;
  const tutorVal = document.getElementById('detailTutorLegal')?.value.trim() || '';
  const age = parseInt(calculateAge(birthDate || ''), 10);
  const isMinor = !!birthDate && !Number.isNaN(age) && age < 18;
  group.classList.toggle('hidden', !isMinor && !tutorVal);
}

async function saveInfoGeneral() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;

  const primerApellido = document.getElementById('detailPrimerApellido')?.value.trim() || '';
  const segundoApellido = document.getElementById('detailSegundoApellido')?.value.trim() || '';
  const nombres = document.getElementById('detailNombres')?.value.trim() || '';

  if (!primerApellido || !nombres) {
    showClivoraAlertModal('Por favor complete los campos obligatorios (Primer Apellido y Nombres).');
    return;
  }

  const celular = document.getElementById('detailCelular')?.value.trim() || '';
  const telefono = document.getElementById('detailTelefono')?.value.trim() || '';
  // maxlength="15" en el <input> ya bloquea escribir/pegar de más (15 en vez
  // de 10 para poder capturar números extranjeros con lada de país), pero no
  // corta un valor largo que haya quedado cargado de antes (un contacto
  // editado antes de que existiera este límite) — sin esto, "Guardar"
  // seguía dejando pasar ese valor tal cual.
  if (celular.length > 15 || telefono.length > 15) {
    showClivoraAlertModal('Teléfono y Celular deben tener máximo 15 dígitos.');
    return;
  }

  const payload = {
    primerApellido,
    segundoApellido,
    nombres,
    fechaNacimiento: document.getElementById('detailFechaNacimiento')?.value || '',
    celular,
    telefono,
    doctor: document.getElementById('detailDoctor')?.value || '',
    genero: document.getElementById('detailGenero')?.value || '',
    ocupacion: document.getElementById('detailOcupacion')?.value || '',
    origenReferencia: document.getElementById('detailOrigenReferencia')?.value || '',
    medicoReferencia: getReferralDoctorSelect('detail', document.getElementById('detailOrigenReferencia')?.value)?.value || '',
    email: document.getElementById('detailEmail')?.value || '',
    estadoCivil: document.getElementById('detailEstadoCivil')?.value || '',
    curp: document.getElementById('detailCurp')?.value.trim().toUpperCase() || '',
    tutorLegal: document.getElementById('detailTutorLegal')?.value.trim() || '',
  };

  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/info_general`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar la Información General.'));
      return;
    }
    // "Religión" vive en la Historia Clínica, no en los datos del paciente
    // como el resto de este formulario — se guarda aparte
    // contra ese endpoint, mandando solo esta clave para no tocar el resto
    // de la Historia Clínica del paciente.
    await fetch(`/clivora/api/patients/${patientId}/historia_clinica`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ religion: document.getElementById('detailReligion')?.value.trim() || '' }),
    });
  } catch (error) {
    console.error('Error al guardar Información General:', error);
    showClivoraAlertModal('No se pudo guardar la Información General.');
    return;
  }

  const fullName = [nombres, primerApellido, segundoApellido].filter(Boolean).join(' ').toUpperCase();
  const detailName = document.getElementById('detailPatientName');
  if (detailName) detailName.textContent = fullName;

  // Tarjetas del encabezado (Nacimiento, Edad, Celular, Médico): antes solo
  // se llenaban al abrir el paciente (populatePatientInfoGeneral), así que
  // seguían mostrando los datos anteriores hasta recargar la página.
  const pillCelular = document.getElementById('detailPillCelular');
  const pillMedico = document.getElementById('detailPillMedico');
  updateDetailAgeFromBirthdate(payload.fechaNacimiento);
  if (pillCelular) pillCelular.textContent = celular || 'Sin registrar';
  if (pillMedico) pillMedico.textContent = payload.doctor || 'Sin asignar';

  toggleInfoGeneralEditMode(false);
}

function populatePatientDomicilioPersonal(data) {
  const domicilio = (data && data.domicilio_personal) || {};

  const paisEl = document.getElementById('detailPais');
  const estadoEl = document.getElementById('detailEstado');
  const ciudadEl = document.getElementById('detailCiudad');
  const coloniaEl = document.getElementById('detailColonia');
  const cpEl = document.getElementById('detailCodigoPostal');
  const calleEl = document.getElementById('detailCalle');
  const numEl = document.getElementById('detailNumeroCasa');

  if (paisEl) paisEl.value = domicilio.pais || '';
  if (estadoEl) estadoEl.value = domicilio.estado || '';
  if (ciudadEl) ciudadEl.value = domicilio.ciudad || '';
  if (coloniaEl) coloniaEl.value = domicilio.colonia || '';
  if (cpEl) cpEl.value = domicilio.codigoPostal || '';
  if (calleEl) calleEl.value = domicilio.calle || '';
  if (numEl) numEl.value = domicilio.numeroCasa || '';
}

function toggleDomicilioPersonalEditMode(enable) {
  const fields = document.querySelectorAll('#domicilioPersonalAccordion .domicilio-personal-field');
  fields.forEach(field => { field.disabled = !enable; });
  const copyBtn = document.getElementById('btnCopiarDomicilioFiscal');
  if (copyBtn) copyBtn.style.display = enable ? '' : 'none';

  const actionsEl = document.getElementById('domicilioPersonalActions');
  if (actionsEl) actionsEl.style.display = enable ? 'flex' : 'none';

  const editBtn = document.getElementById('btnEditDomicilioPersonal');
  if (editBtn) {
    if (enable) {
      editBtn.classList.add('editing');
      editBtn.title = 'Cancelar edición';
    } else {
      editBtn.classList.remove('editing');
      editBtn.title = 'Editar Domicilios';
    }
  }

  if (enable) {
    const accordion = document.getElementById('domicilioPersonalAccordion');
    if (accordion) accordion.classList.add('open');
    const firstInput = document.getElementById('detailFiscalPais');
    if (firstInput) firstInput.focus();
  }
}

// Campo del JSON de domicilio_fiscal → id del input (y su par del domicilio
// personal, para "Copiar del domicilio personal").
const DOMICILIO_FISCAL_FIELDS = {
  pais: 'detailFiscalPais', estado: 'detailFiscalEstado', ciudad: 'detailFiscalCiudad',
  colonia: 'detailFiscalColonia', codigoPostal: 'detailFiscalCodigoPostal',
  calle: 'detailFiscalCalle', numeroCasa: 'detailFiscalNumeroCasa',
};
const DOMICILIO_PERSONAL_IDS = {
  pais: 'detailPais', estado: 'detailEstado', ciudad: 'detailCiudad', colonia: 'detailColonia',
  codigoPostal: 'detailCodigoPostal', calle: 'detailCalle', numeroCasa: 'detailNumeroCasa',
};

function copiarDomicilioPersonalAFiscal() {
  Object.entries(DOMICILIO_FISCAL_FIELDS).forEach(([key, id]) => {
    const fiscalEl = document.getElementById(id);
    const personalEl = document.getElementById(DOMICILIO_PERSONAL_IDS[key]);
    if (fiscalEl && personalEl) fiscalEl.value = personalEl.value;
  });
}

async function saveDomicilioPersonal() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;

  const payload = {
    pais: document.getElementById('detailPais')?.value || '',
    estado: document.getElementById('detailEstado')?.value || '',
    ciudad: document.getElementById('detailCiudad')?.value || '',
    colonia: document.getElementById('detailColonia')?.value || '',
    codigoPostal: document.getElementById('detailCodigoPostal')?.value || '',
    calle: document.getElementById('detailCalle')?.value || '',
    numeroCasa: document.getElementById('detailNumeroCasa')?.value || '',
    fiscal: Object.fromEntries(Object.entries(DOMICILIO_FISCAL_FIELDS).map(
      ([key, id]) => [key, document.getElementById(id)?.value || ''])),
  };

  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/domicilio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await (await fetch(`/clivora/api/patients/${patientId}`)).json();
    populatePatientDomicilioPersonal(data);
    populatePatientDomicilioFiscal(data);
  } catch (error) {
    console.error('Error al guardar los domicilios:', error);
    showClivoraAlertModal('No se pudieron guardar los domicilios.');
    return;
  }

  toggleDomicilioPersonalEditMode(false);
}

async function populateFiscalRegimeSelectOptions(selectEl, selectedCode) {
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">Seleccionar régimen</option>';
  try {
    const response = await fetch('/clivora/api/fiscal_regimes');
    if (!response.ok) return;
    const regimes = await response.json();
    regimes.forEach(regime => {
      const option = document.createElement('option');
      option.value = regime.code;
      option.textContent = regime.label;
      selectEl.appendChild(option);
    });
    if (selectedCode) selectEl.value = selectedCode;
  } catch (error) {
    console.error('Error al cargar régimen fiscal:', error);
  }
}

let clivoraPricelistsCatalog = null;

async function populatePricelistSelectOptions(selectEl, selectedId) {
  if (!selectEl) return;
  if (!clivoraPricelistsCatalog) {
    try {
      const response = await fetch('/clivora/api/pricelists', { cache: 'no-store' });
      clivoraPricelistsCatalog = response.ok ? await response.json() : [];
    } catch (error) {
      console.error('Error al cargar listas de precios:', error);
      clivoraPricelistsCatalog = [];
    }
  }
  fillSelectOptions(selectEl, clivoraPricelistsCatalog, selectedId, 'Seleccionar lista de precios');
}

async function populatePatientFacturacion(data) {
  const facturacion = (data && data.facturacion) || {};

  const listaEl = document.getElementById('detailListaPrecios');
  const rfcEl = document.getElementById('detailRFC');
  const regimenEl = document.getElementById('detailRegimenFiscal');

  await populatePricelistSelectOptions(listaEl, facturacion.listaPreciosId);
  if (rfcEl) rfcEl.value = facturacion.rfc || '';
  await populateFiscalRegimeSelectOptions(regimenEl, facturacion.regimenFiscal);
}

function toggleFacturacionEditMode(enable) {
  const fields = document.querySelectorAll('#facturacionForm .facturacion-field');
  fields.forEach(field => { field.disabled = !enable; });

  const actionsEl = document.getElementById('facturacionActions');
  if (actionsEl) actionsEl.style.display = enable ? 'flex' : 'none';

  const editBtn = document.getElementById('btnEditFacturacion');
  if (editBtn) {
    if (enable) {
      editBtn.classList.add('editing');
      editBtn.title = 'Cancelar edición';
    } else {
      editBtn.classList.remove('editing');
      editBtn.title = 'Editar Información de Facturación';
    }
  }

  if (enable) {
    const accordion = document.getElementById('facturacionAccordion');
    if (accordion) accordion.classList.add('open');
    const firstInput = document.getElementById('detailListaPrecios');
    if (firstInput) firstInput.focus();
  }
}

async function saveFacturacion() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;

  const payload = {
    listaPreciosId: document.getElementById('detailListaPrecios')?.value || false,
    rfc: document.getElementById('detailRFC')?.value || '',
    regimenFiscal: document.getElementById('detailRegimenFiscal')?.value || '',
  };

  try {
    await fetch(`/clivora/api/patients/${patientId}/facturacion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Error al guardar Facturación:', error);
    showClivoraAlertModal('No se pudo guardar la Información de Facturación.');
    return;
  }

  toggleFacturacionEditMode(false);
}

// ============================
// ARCHIVOS del expediente
// ============================
let clivoraPatientFiles = [];

// Mismo orden/catálogo completo que las <option> estáticas de #filterFileType
// en el HTML — se usa solo para ordenar los tipos que sí aparecen en los
// archivos de ESTE paciente (ver updateFileTypeFilterOptions), no para
// listarlos todos de una: antes el filtro mostraba los ~19 tipos posibles
// aunque el paciente solo tuviera archivos de 1 o 2, dejando casi todas las
// opciones sin ningún resultado si se elegían.
const CLIVORA_FILE_TYPE_CATALOG = [
  'Estudios de laboratorio', 'Estudios de imagen', 'Imágenes médicas (Archivos DICOM y Nifti)',
  'Consentimientos informados', 'Indicaciones', 'Recetas', 'Informes médicos / seguros',
  'Fotos clinicas', 'Estudios de patología', 'Estudios moleculares', 'Biocomposiciones / Nutrición',
  'INE', 'Bitácora', 'Carta de autorización', 'Carátula de seguro', 'Póliza de seguro', 'CSF',
  'Documento Clínico', 'Otros',
];

function updateFileTypeFilterOptions() {
  const select = document.getElementById('filterFileType');
  if (!select) return;
  const currentValue = select.value;
  const present = new Set(clivoraPatientFiles.map(f => f.type_document).filter(Boolean));
  const orderedPresent = CLIVORA_FILE_TYPE_CATALOG.filter(t => present.has(t));
  select.innerHTML = ['<option value="">Todos los tipos de documento</option>']
    .concat(orderedPresent.map(t => `<option value="${t}">${t}</option>`))
    .join('');
  select.value = present.has(currentValue) ? currentValue : '';
}

const CLIVORA_EXT_BY_MIME = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp',
};

function guessFileName(file) {
  const base = (file.title || 'documento').replace(/[^a-z0-9\-_ ]/gi, '').trim() || 'documento';
  let mime = file.mimetype || '';
  if (!mime && file.fileUrl) {
    const match = /^data:([^;]+);base64,/.exec(file.fileUrl);
    mime = match ? match[1] : '';
  }
  return `${base}.${CLIVORA_EXT_BY_MIME[mime] || 'bin'}`;
}

function downloadSingleFile(file) {
  if (!file || !file.fileUrl) {
    showClivoraAlertModal('Este archivo no tiene contenido adjunto.');
    return;
  }
  const a = document.createElement('a');
  // /clivora/patient_files/<id>?download=false se usa para previsualizar inline; al
  // descargar se cambia a true. Los archivos legado (data-URL directo) no
  // tienen esa query string, el replace no les afecta.
  a.href = file.fileUrl.replace('download=false', 'download=true');
  a.download = guessFileName(file);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadMultipleFiles(files) {
  if (!files || files.length === 0) {
    const modal = document.getElementById('modalNoFilesSelectedWarning');
    if (modal) modal.style.display = 'flex';
    return;
  }
  files.forEach((f, index) => {
    setTimeout(() => downloadSingleFile(f), index * 350);
  });
}

async function loadPatientFiles(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/files`, { cache: 'no-store' });
    clivoraPatientFiles = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar archivos del paciente:', error);
    clivoraPatientFiles = [];
  }
  updateFileTypeFilterOptions();
  renderArchivosList();
  renderHcFilesList();
}

// Auditoría propia de la sección "Archivos de HC" (14): a diferencia de las
// demás secciones de Historia Clínica, esta vive en su propia lista
// (clivoraPatientFiles), así que su "última modificación"
// real es la fecha del archivo más reciente — no la modificación compartida de
// la historia clínica, que cualquier otra sección de Historia
// Clínica pisa al guardarse (ver HC_AUDIT_INFO_SECTION_IDS más arriba).
function updateHcFilesAuditInfo() {
  const el = document.getElementById('hcAuditInfo-14');
  if (!el) return;
  const latest = clivoraPatientFiles.reduce((max, file) => {
    if (!file.create_date) return max;
    return (!max || file.create_date > max.create_date) ? file : max;
  }, null);
  if (!latest) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  // Los archivos no traen su propia fecha de modificación — lo único
  // que se sabe de verdad de un archivo es cuándo/quién lo subió
  // (create_date/uploaded_by). "Última modificación" acá no es una edición
  // real (no existe ese flujo, ver comentario de la función), sino el mismo
  // dato del archivo más reciente repetido en el segundo renglón — mismo
  // criterio visual de dos líneas ("Creado"/"Última modificación") que usan
  // el resto de secciones de Historia Clínica (ver updateHcAuditInfo).
  const bits = [
    `el ${formatClivoraDateTime(latest.create_date)}`,
    latest.uploaded_by ? `por ${latest.uploaded_by}` : '',
  ].filter(Boolean);
  el.innerHTML = [
    `<div>| ${escapeHtml(`Creado ${bits.join(' ')}`)}</div>`,
    `<div>| ${escapeHtml(`Última modificación ${bits.join(' ')}`)}</div>`,
  ].join('');
  el.style.display = 'block';
}

// Lista simplificada de archivos que se muestra en "Archivos de HC" (último
// paso de Historia Clínica) — mismos datos reales de clivoraPatientFiles que
// usa la pestaña Archivos, solo con una presentación más ligera (sin
// filtros ni selección múltiple), igual que en el diseño de referencia.
function renderHcFilesList() {
  updateHcFilesAuditInfo();
  const container = document.getElementById('hcFilesListContainer');
  if (!container) return;
  if (clivoraPatientFiles.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">No hay archivos cargados</div>`;
    return;
  }
  container.innerHTML = clivoraPatientFiles.map(file => `
    <div class="nopat-card" style="padding: 14px 18px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
      <div style="flex: 1 1 160px; min-width: 0;">
        <div style="font-weight: 700; font-size: 13px; color: var(--text-main); overflow-wrap: anywhere;">${file.title || '(Sin título)'}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${file.type_document || ''} · ${formatClivoraDateTime(file.create_date)}</div>
      </div>
      <div style="display: flex; gap: 8px; flex-shrink: 0; align-items: center;">
        ${canEditHistorialCreateDate() ? `<button type="button" title="Editar fecha de creación" style="border: none; background: none; cursor: pointer; color: var(--primary-blue); padding: 4px; display: inline-flex; align-items: center;" onclick="editHcFileCreateDate(${file.id})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>` : ''}
        ${file.fileUrl ? `<button type="button" class="btn-secondary btn-anim-lift" style="padding: 6px 12px; font-size: 11px; font-weight: 700;" onclick="previewHcFile(${file.id})">Vista previa</button>` : ''}
        ${file.fileUrl ? `<a href="${file.fileUrl}" target="_blank" class="btn-secondary btn-anim-lift" style="padding: 6px 12px; font-size: 11px; font-weight: 700;">Descargar</a>` : ''}
      </div>
    </div>
  `).join('');
}

// "Archivos de HC" (sección 14 de Historia Clínica) no tiene su propio
// visor de documentos — en vez de duplicar esa UI (iframe de PDF, imagen,
// etc.), reusa el mismo panel de vista previa de la pestaña ARCHIVOS
// (mismos datos, mismo componente showFilePreview): cambia a esa pestaña y
// selecciona ahí la tarjeta del mismo archivo.
function previewHcFile(fileId) {
  goToExpedienteSubTab('tab-archivos');
  const card = document.querySelector(`#archivosListContainer .file-card[data-file-id="${fileId}"]`);
  if (card) card.click();
}

// Botón de lápiz de "Archivos de HC" (lista simplificada dentro de Historia
// Clínica, ver renderHcFilesList) — misma corrección de create_date que el
// botón equivalente de la pestaña ARCHIVOS (showFilePreview), solo que este
// no tiene una tarjeta de detalle propia que repintar: recargar la lista ya
// actualiza tanto esta vista como updateHcFilesAuditInfo/el sidebar de
// ARCHIVOS, que leen del mismo clivoraPatientFiles.
async function editHcFileCreateDate(fileId) {
  const newIso = await editHistorialCreateDate('archivo', fileId, null);
  if (!newIso) return;
  await loadPatientFiles(window.clivoraCurrentPatientId);
}

// Subida rápida desde "Archivos de HC": mismo endpoint que la subida
// clasificada de la pestaña ARCHIVOS, pero sin pedir tipo de documento ni
// título — el título se toma del nombre del archivo y el tipo se guarda
// como "Otros" (mismo valor que ya existe en el filtro de tipo de la
// pestaña ARCHIVOS), para que el doctor pueda soltar cualquier archivo
// suelto sin llenar ningún formulario.
async function uploadHcFileQuick(file) {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId || !file) return;
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
  const title = file.name.replace(/\.[^/.]+$/, '') || file.name;
  try {
    await fetch(`/clivora/api/patients/${patientId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Otros', type_document: 'Otros', title, file: dataUrl }),
    });
  } catch (error) {
    console.error('Error al subir archivo:', error);
  }
}

async function quickUploadHcFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    await uploadHcFileQuick(file);
  }
  await loadPatientFiles(window.clivoraCurrentPatientId);
}

function initializeHcFilesDropzone() {
  const dropzone = document.getElementById('hcFilesDropzone');
  const input = document.getElementById('hcQuickUploadInput');
  if (!dropzone || !input || dropzone.dataset.wired) return;
  dropzone.dataset.wired = '1';

  dropzone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    quickUploadHcFiles(input.files);
    input.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#1C2F57';
    dropzone.style.background = 'linear-gradient(135deg, rgba(47, 76, 138,0.12), rgba(139,92,246,0.16))';
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = '#2F4C8A';
    dropzone.style.background = 'linear-gradient(135deg, rgba(47, 76, 138,0.05) 0%, rgba(139,92,246,0.08) 100%)';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#2F4C8A';
    dropzone.style.background = 'linear-gradient(135deg, rgba(47, 76, 138,0.05) 0%, rgba(139,92,246,0.08) 100%)';
    quickUploadHcFiles(e.dataTransfer.files);
  });
}

// Muestra la foto real del paciente (data.photoUrl) en vez del ícono SVG placeholder;
// vuelve al placeholder si el paciente todavía no tiene foto guardada.
function setDetailPatientAvatar(photoUrl) {
  const img = document.getElementById('detailPatientAvatarPhoto');
  const placeholder = document.getElementById('detailPatientAvatarPlaceholder');
  if (!img || !placeholder) return;
  if (photoUrl) {
    img.src = photoUrl;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    placeholder.style.display = '';
  }
}

// El botón de cámara sobre el avatar (paciente-detail.html) no tenía
// ningún listener — click en él no hacía nada. Reusa el mismo patrón de
// FileReader + POST data-URL que uploadHcFileQuick.
function initializePatientPhotoUpload() {
  const btn = document.getElementById('detailPatientPhotoBtn');
  const input = document.getElementById('detailPatientPhotoInput');
  if (!btn || !input || btn.dataset.wired) return;
  btn.dataset.wired = '1';

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const patientId = window.clivoraCurrentPatientId;
    if (!patientId) return;
    if (!file.type.startsWith('image/')) {
      showClivoraAlertModal('Selecciona un archivo de imagen válido.');
      return;
    }
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo: dataUrl }),
      });
      if (!response.ok) throw new Error('upload failed');
      const result = await response.json();
      setDetailPatientAvatar(result.photoUrl || '');
    } catch (error) {
      console.error('Error al subir la foto del paciente:', error);
      showClivoraAlertModal('No se pudo actualizar la foto del paciente. Intenta de nuevo.');
    }
  });
}

function formatClivoraDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return `${d.toLocaleDateString('es-MX')}, ${d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
}

// "Creado el/por" + "Última modificación el/por" de Recetas, Órdenes
// Médicas y Notas (todas las notas de #modalNotaClinica) — mismo formato y
// separación que ya usa updateHcAuditInfo para las secciones de Historia
// Clínica (una línea por dato, cada una con "| " al frente). Antes estas 3
// pantallas solo mostraban "Creado el/por" y nunca la última modificación.
// `editableRecord` ({model, id}, ver consultaEditableRecord): si se manda Y
// el usuario tiene rol group_historial_create_date_edit, agrega
// el botón de lápiz para corregir create_date — se omite en los llamados
// que no lo pasan (Recetas/Órdenes Médicas/Nota de Oncología, fuera del
// alcance de ese grupo), sin cambiar su resultado.
function buildCreatedUpdatedMetaHtml(createdAt, createdBy, updatedAt, updatedBy, editableRecord) {
  const rows = [];
  const editBtn = (editableRecord && canEditHistorialCreateDate())
    ? ` <button type="button" class="clivora-edit-create-date-btn" data-model="${escapeHtml(editableRecord.model)}" data-id="${editableRecord.id}" data-created-by="${escapeHtml(createdBy || '')}" title="Editar fecha de creación" style="border: none; background: none; cursor: pointer; color: var(--primary-blue); padding: 0; margin-left: 4px; vertical-align: middle; display: inline-flex;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>`
    : '';
  const createdBits = [createdAt ? `el ${createdAt}` : '', createdBy ? `por ${createdBy}` : ''].filter(Boolean);
  if (createdBits.length) rows.push(`<div>| ${escapeHtml(`Creado ${createdBits.join(' ')}`)}${editBtn}</div>`);
  const updatedBits = [updatedAt ? `el ${updatedAt}` : '', updatedBy ? `por ${updatedBy}` : ''].filter(Boolean);
  if (updatedBits.length) rows.push(`<div>| ${escapeHtml(`Última modificación ${updatedBits.join(' ')}`)}</div>`);
  if (!rows.length) return '';
  return `<div style="font-size: 11px; font-weight: 500; color: var(--text-subtle); margin-top: 2px;">${rows.join('')}</div>`;
}

// Mapea c.source (tipo de consulta que manda el backend) al tipo de registro — así el
// frontend puede armar el {model, id} que necesita el botón de editar
// create_date sin que el backend tenga que mandar el modelo en cada fila
// de la lista de consultas. Cada tipo debe estar dado de alta en
// FECHA_CREACION_MODELOS (apps/expediente/compat.py). Recetas/Órdenes Médicas no
// pasan por este mapa (no vienen de /consultations, ver showRecipeDetail/
// renderLabOrderDetail más arriba, que arman su propio {model, id}).
const CONSULTA_SOURCE_MODEL_MAP = {
  vitals: 'signos_vitales',
  consultation: 'consulta',
  nursing: 'nota_enfermeria',
  nutrition: 'nota_nutricion',
  psychology: 'nota_psicologia',
  ambulatory: 'nota_procedimientos',
  evolution: 'nota_evolucion',
  discharge: 'nota_alta',
  nephrology: 'nota_nefrologia',
  paliative: 'nota_cuidados_paliativos',
};

// c.id viene con un prefijo por tipo ("v-12", "n-7", "ev-3") — se extrae el id numérico real
// que espera el endpoint de create_date. Devuelve null si el source no está
// en el mapa de arriba (Nota de Oncología, etc.), para que el botón
// simplemente no se muestre en esos casos.
function consultaEditableRecord(c) {
  const model = CONSULTA_SOURCE_MODEL_MAP[c && c.source];
  if (!model) return null;
  const recordId = parseInt(String(c.id).split('-')[1], 10);
  return recordId ? { model, id: recordId } : null;
}

function renderArchivosList() {
  const container = document.getElementById('archivosListContainer');
  if (!container) return;

  const countLabel = document.getElementById('archivosCountLabel');
  const searchTerm = (document.getElementById('searchFileInput')?.value || '').toLowerCase().trim();
  const filterType = (document.getElementById('filterFileType')?.value || '').trim();

  const filteredFiles = clivoraPatientFiles.filter(file => {
    const matchSearch = !searchTerm ||
      (file.title || '').toLowerCase().includes(searchTerm) ||
      (file.type_document || '').toLowerCase().includes(searchTerm) ||
      (file.comment || '').toLowerCase().includes(searchTerm);
    const matchType = !filterType || file.type_document === filterType;
    return matchSearch && matchType;
  });

  if (countLabel) {
    countLabel.textContent = `${filteredFiles.length} de ${clivoraPatientFiles.length} archivos`;
  }

  container.innerHTML = '';

  if (filteredFiles.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px 16px; text-align: center; color: var(--text-muted); font-size: 12px; background: var(--bg-main); border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        ${clivoraPatientFiles.length === 0 ? 'Este paciente no tiene archivos registrados.' : 'No se encontraron archivos con los filtros seleccionados.'}
      </div>
    `;
    const previewCard = document.getElementById('archivoPreviewCard');
    if (previewCard) {
      previewCard.classList.add('empty-state-container');
      previewCard.innerHTML = `
        <div class="empty-state-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <h3 class="empty-state-title">Sin archivos</h3>
        <p class="empty-state-desc">Sube el primer documento de este paciente</p>
      `;
    }
    syncArchivoPreviewCardHeight();
    return;
  }

  filteredFiles.forEach((file, index) => {
    const fileCard = document.createElement('div');
    fileCard.className = `file-card ${index === 0 ? 'active-card' : ''}`;
    fileCard.style.cursor = 'pointer';
    fileCard.style.marginBottom = '8px';
    fileCard.style.display = 'flex';
    fileCard.style.alignItems = 'center';
    fileCard.style.gap = '10px';
    fileCard.dataset.fileId = file.id;

    const typeLc = (file.type_document || '').toLowerCase();
    const isLab = typeLc.includes('laboratorio');
    const isImg = typeLc.includes('imagen') || typeLc.includes('foto');
    const iconBg = isLab ? '#FEE2E2' : (isImg ? '#EFF6FF' : '#FEF3C7');
    const iconColor = isLab ? '#EF4444' : (isImg ? '#2563EB' : '#D97706');

    fileCard.innerHTML = `
      <input type="checkbox" class="file-card-checkbox" data-file-id="${file.id}" style="cursor: pointer; width: 15px; height: 15px; flex-shrink: 0;" onclick="event.stopPropagation();">
      <div class="file-card-icon" style="background-color: ${iconBg}; color: ${iconColor}; flex-shrink: 0;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 11px; color: ${iconColor}; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.type_document || 'Documento'}</div>
        <div style="font-size: 13px; font-weight: 800; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.title || 'Sin título'}</div>
        <div style="font-size: 11px; line-height: 1; color: var(--text-muted); display: flex; align-items: center; gap: 4px; margin-top: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; display: block;">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>${formatClivoraDateTime(file.create_date)}</span>
        </div>
      </div>
    `;

    fileCard.onclick = () => {
      container.querySelectorAll('.file-card').forEach(c => c.classList.remove('active-card'));
      fileCard.classList.add('active-card');
      showFilePreview(file);
    };

    container.appendChild(fileCard);
  });

  showFilePreview(filteredFiles[0]);
  syncArchivoPreviewCardHeight();
}

function showFilePreview(file) {
  const previewCard = document.getElementById('archivoPreviewCard');
  if (!previewCard) return;
  // .empty-state-container centra su contenido vertical y horizontalmente
  // (pensado para el ícono+texto de "Selecciona un archivo") — sin quitarla
  // aquí, el contenido real de la vista también quedaba centrado dentro de
  // la tarjeta alta en vez de empezar arriba, dejando un hueco enorme.
  previewCard.classList.remove('empty-state-container');

  const typeLc = (file.type_document || '').toLowerCase();
  const isLab = typeLc.includes('laboratorio');
  const isImg = typeLc.includes('imagen') || typeLc.includes('foto');
  const iconColor = isLab ? '#EF4444' : (isImg ? '#2563EB' : '#D97706');

  const fileDataUrl = file.fileUrl;
  const mime = file.mimetype || (fileDataUrl && fileDataUrl.startsWith('data:') ? fileDataUrl.slice(5).split(';')[0] : '');
  const isPdf = mime === 'application/pdf';
  const isImageFile = mime.startsWith('image/');

  let previewContentHtml = '';

  if (fileDataUrl) {
    if (isPdf) {
      previewContentHtml = `
        <div style="width: 100%; height: 520px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color); background: #525659;">
          <iframe src="${fileDataUrl}" width="100%" height="100%" style="border: none;"></iframe>
        </div>
      `;
    } else if (isImageFile) {
      previewContentHtml = `
        <div style="width: 100%; display: flex; align-items: center; justify-content: center; background: var(--bg-main); border-radius: var(--radius-md); padding: 20px; border: 1px solid var(--border-color);">
          <img src="${fileDataUrl}" alt="${file.title}" style="max-width: 100%; max-height: 500px; border-radius: 8px; object-fit: contain; box-shadow: 0 10px 25px rgba(0,0,0,0.15);" />
        </div>
      `;
    } else {
      previewContentHtml = `
        <div style="border: 2px dashed var(--border-color); border-radius: var(--radius-md); padding: 50px 20px; text-align: center; background: var(--bg-main); display: flex; flex-direction: column; align-items: center; justify-content: center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="1.5" style="margin-bottom: 12px;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <div style="font-size: 16px; font-weight: 800; color: var(--text-main);">${file.title}</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Documento adjunto (${file.type_document})</div>
        </div>
      `;
    }
  } else {
    previewContentHtml = `
      <div style="border: 2px dashed var(--border-color); border-radius: var(--radius-md); padding: 40px 20px; text-align: center; background: var(--bg-main); color: var(--text-muted); font-size: 13px;">
        Este registro no tiene un archivo adjunto (solo metadatos).
      </div>
    `;
  }

  const metaRow = (label, value) => value ? `
    <div>
      <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">${label}</div>
      <div style="font-size: 13px; color: var(--text-main);">${value}</div>
    </div>
  ` : '';

  previewCard.innerHTML = `
    <div style="width: 100%; text-align: left;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
        <div>
          <span style="font-size: 11px; font-weight: 800; color: ${iconColor}; text-transform: uppercase; letter-spacing: 0.05em;">${file.type_document || 'Documento'}</span>
          <h2 style="font-size: 20px; font-weight: 800; color: var(--text-main); margin-top: 2px;">${file.title || 'Sin título'}</h2>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 12px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px;">
            ${formatClivoraDateTime(file.create_date)}
            ${canEditHistorialCreateDate() ? `<button type="button" id="btnEditFileCreateDate" title="Editar fecha de creación" style="border: none; background: none; cursor: pointer; color: var(--primary-blue); padding: 0; display: inline-flex; align-items: center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>` : ''}
          </span>
          <button type="button" class="btn-primary btn-anim-lift" id="btnDownloadSinglePreview" style="padding: 8px 16px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Descargar Archivo
          </button>
          ${file.type_document === 'Recetas' ? `
          <button type="button" class="btn-secondary btn-anim-lift" id="btnCreateQuoteFilePreview" style="padding: 8px 16px; font-size: 12px;">
            ${file.saleOrderId ? 'Ver cotización' : 'Crear cotización'}
          </button>
          ` : ''}
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDeleteFilePreview" style="padding: 8px 16px; font-size: 12px; color: #EF4444; border-color: #FCA5A5;">
            Eliminar
          </button>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; background: var(--bg-main); border: 1px solid var(--border-color); padding: 14px 18px; border-radius: var(--radius-md); margin-bottom: 20px;">
        ${metaRow('Ciclo', file.cycle)}
        ${metaRow('Fecha de ciclo', file.date_cycle)}
        ${metaRow('Archivo primario', file.treatment_primary ? 'Sí' : 'No')}
        ${metaRow('Compartido con paciente', file.share_patient ? 'Sí' : 'No')}
        ${metaRow('Honorarios', file.fee ? `Sí ($${(file.fee_cycle || 0).toFixed(2)})` : 'No')}
        ${metaRow('Subido por', file.uploaded_by)}
        ${metaRow('Versión', file.version)}
      </div>

      ${file.comment ? `
        <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 14px 18px; border-radius: var(--radius-md); margin-bottom: 20px;">
          <div style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; margin-bottom: 4px;">Comentarios u observaciones</div>
          <div style="font-size: 13px; color: var(--text-main); line-height: 1.5;">${file.comment}</div>
        </div>
      ` : ''}

      ${previewContentHtml}
    </div>
  `;

  const btnDl = previewCard.querySelector('#btnDownloadSinglePreview');
  if (btnDl) btnDl.onclick = () => downloadSingleFile(file);

  const btnEditFileDate = previewCard.querySelector('#btnEditFileCreateDate');
  if (btnEditFileDate) {
    btnEditFileDate.onclick = async () => {
      const newIso = await editHistorialCreateDate('archivo', file.id, null);
      if (!newIso) return;
      // archivos del expediente no viene de buildCreatedUpdatedMetaHtml/
      // updateHcAuditInfo (esta tarjeta arma su propio encabezado a mano,
      // ver arriba), así que en vez del patch en el DOM que usa el botón
      // genérico, se recarga la lista completa (mantiene en sync la tarjeta
      // del sidebar, "Archivos de HC" dentro de Historia Clínica y esta
      // misma vista previa, que muestran la misma fecha en 3 lugares) y se
      // vuelve a pintar esta vista con el dato ya actualizado.
      await loadPatientFiles(window.clivoraCurrentPatientId);
      const updated = clivoraPatientFiles.find(f => String(f.id) === String(file.id));
      if (updated) showFilePreview(updated);
    };
  }

  const btnQuote = previewCard.querySelector('#btnCreateQuoteFilePreview');
  if (btnQuote) {
    btnQuote.onclick = () => runClivoraSaveOnce('fileQuote', btnQuote, createFileQuote);
    const createFileQuote = async () => {
      if (file.saleOrderId) {
        openVentaViewModal(file.saleOrderId);
        return;
      }
      try {
        const response = await fetch(`/clivora/api/files/${file.id}/create_quote`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
          // 'sale_order_failed' trae el mensaje real del servidor — antes se mostraba siempre el mismo
          // aviso genérico sin importar la causa real, así que no había
          // forma de saber qué corregir sin ver el log del servidor.
          let message = 'No se pudo crear la cotización.';
          if (data && data.error === 'no_patient') {
            message = 'Este documento no tiene un paciente vinculado.';
          } else if (data && data.error === 'sale_order_failed' && data.message) {
            message = `No se pudo crear la cotización:\n\n${data.message}`;
          }
          showClivoraAlertModal(message);
          return;
        }
        loadPatientFiles(window.clivoraCurrentPatientId);
      } catch (error) {
        console.error('Error al crear la cotización:', error);
        showClivoraAlertModal('No se pudo crear la cotización.');
      }
    };
  }

  const btnDel = previewCard.querySelector('#btnDeleteFilePreview');
  if (btnDel) {
    btnDel.onclick = async () => {
      if (!(await showClivoraConfirmModal(`¿Eliminar "${file.title}"? Esta acción no se puede deshacer.`))) return;
      try {
        await fetch(`/clivora/api/files/${file.id}/delete`, { method: 'POST' });
      } catch (error) {
        console.error('Error al eliminar el archivo:', error);
      }
      loadPatientFiles(window.clivoraCurrentPatientId);
    };
  }
}

// ============================
// ESQUEMAS (chemotherapy.assign + chemotherapy.lines.assign) — datos reales
// ============================
let clivoraPatientChemo = [];
let clivoraChemoCatalogs = null;
let clivoraChemoEditingId = null; // null = nada seleccionado, 'new' = creando, id = editando
let clivoraChemoLinesDraft = [];
let clivoraProductsCatalogLoaded = false;

async function loadPatientChemotherapy(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/chemotherapy`, { cache: 'no-store' });
    clivoraPatientChemo = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar esquemas de quimioterapia:', error);
    clivoraPatientChemo = [];
  }
  clivoraChemoEditingId = null;
  renderEsquemasList();
  renderEsquemaEmptyState();
}

async function ensureChemoCatalogs() {
  if (clivoraChemoCatalogs) return clivoraChemoCatalogs;
  const empty = { chemotherapies: [], treatment_reasons: [], unit_doses: [], vias_administration: [], unit_times: [], employees: [] };
  try {
    const response = await fetch('/clivora/api/chemotherapy_catalogs', { cache: 'no-store' });
    clivoraChemoCatalogs = response.ok ? await response.json() : empty;
  } catch (error) {
    console.error('Error al cargar catálogos de quimioterapia:', error);
    clivoraChemoCatalogs = empty;
  }
  return clivoraChemoCatalogs;
}

async function ensureProductsDatalist() {
  const datalist = document.getElementById('clivoraProductsDatalist');
  if (!datalist || clivoraProductsCatalogLoaded) return;
  try {
    const response = await fetch('/clivora/api/products', { cache: 'no-store' });
    const products = response.ok ? await response.json() : [];
    datalist.innerHTML = products.map(p => `<option data-id="${p.id}" value="${p.name}"></option>`).join('');
    clivoraProductsCatalogLoaded = true;
  } catch (error) {
    console.error('Error al cargar catálogo de productos:', error);
  }
}

function renderEsquemasList() {
  const container = document.getElementById('esquemasListContainer');
  const countLabel = document.getElementById('esquemasCountLabel');
  if (countLabel) countLabel.textContent = `${clivoraPatientChemo.length} esquema${clivoraPatientChemo.length === 1 ? '' : 's'}`;
  if (!container) return;
  container.innerHTML = '';

  if (clivoraPatientChemo.length === 0) {
    container.innerHTML = `
      <div style="padding: 20px 12px; text-align: center; color: var(--text-muted); font-size: 11px; background: var(--bg-main); border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        Sin esquemas registrados
      </div>
    `;
    return;
  }

  clivoraPatientChemo.forEach(assign => {
    const card = document.createElement('div');
    card.className = `file-card ${clivoraChemoEditingId === assign.id ? 'active-card' : ''}`;
    card.style.cursor = 'pointer';
    card.style.marginBottom = '8px';
    card.dataset.assignId = assign.id;
    card.innerHTML = `
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 11px; color: #2563EB; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${assign.chemotherapy_name || 'Esquema sin catálogo'}</div>
        <div style="font-size: 13px; font-weight: 800; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${assign.diagnosis || 'Sin diagnóstico'}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Ciclo ${assign.current_cycle || '-'} de ${assign.total_cycle || '-'} &bull; ${assign.lines.length} línea${assign.lines.length === 1 ? '' : 's'}</div>
      </div>
    `;
    card.onclick = () => renderEsquemaForm(assign.id);
    container.appendChild(card);
  });
}

function renderEsquemaEmptyState() {
  const card = document.getElementById('esquemaDetailCard');
  if (!card) return;
  card.className = 'expediente-editor-card empty-state-container';
  card.style.padding = '24px';
  card.innerHTML = `
    <div class="empty-state-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    </div>
    <h3 class="empty-state-title" style="font-weight: 500; font-size: 13px; color: var(--text-muted);">Selecciona un
      esquema para ver o editar, o crea uno nuevo</h3>
  `;
}

function esqField(label, id, value, type = 'text', extra = '') {
  return `
    <div class="form-group">
      <label for="${id}" style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle);">${label}</label>
      <input type="${type}" id="${id}" value="${value != null ? String(value).replace(/"/g, '&quot;') : ''}" ${extra} style="width: 100%; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid var(--border-color); background-color: var(--bg-main); color: var(--text-main); font-size: 13px;">
    </div>
  `;
}

function esqSelect(label, id, options, selectedId) {
  const opts = ['<option value="">Seleccionar...</option>']
    .concat(options.map(o => `<option value="${o.id}" ${String(o.id) === String(selectedId) ? 'selected' : ''}>${o.name}</option>`));
  return `
    <div class="form-group">
      <label for="${id}" style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle);">${label}</label>
      <select id="${id}" class="custom-select" style="width: 100%; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid var(--border-color); background-color: var(--bg-main); color: var(--text-main); font-size: 13px;">
        ${opts.join('')}
      </select>
    </div>
  `;
}

function esqTextarea(label, id, value) {
  return `
    <div class="form-group" style="grid-column: 1 / -1;">
      <label for="${id}" style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle);">${label}</label>
      ${richTextEditorHtml(id, '', value)}
    </div>
  `;
}

function buildEsquemaLineCardHtml(line, index, catalogs) {
  const l = line || {};
  return `
    <div class="expediente-editor-card" data-line-index="${index}" style="padding: 14px; margin-bottom: 10px; border: 1px solid var(--border-color);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-size: 12px; font-weight: 800; color: var(--text-main);">Línea ${index + 1}</span>
        <button type="button" class="btn-secondary btn-anim-lift esq-remove-line" data-line-index="${index}" style="padding: 4px 10px; font-size: 11px; color: #EF4444; border-color: #FCA5A5;">Eliminar línea</button>
      </div>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">
        <div class="form-group" style="grid-column: 1 / -1;">
          <label style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-subtle);">Producto</label>
          <input type="text" class="line-product" list="clivoraProductsDatalist" data-product-id="${l.product_id || ''}" value="${l.product_name || ''}" style="width: 100%; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid var(--border-color); background-color: var(--bg-main); color: var(--text-main); font-size: 13px;">
        </div>
        ${esqField('Dosis', `line-dose-${index}`, l.dose, 'number')}
        ${esqSelect('Unidad de dosis', `line-unit-dose-${index}`, catalogs.unit_doses, l.chemotherapy_unit_dose_id)}
        ${esqSelect('Vía de administración', `line-via-${index}`, catalogs.vias_administration, l.chemotherapy_via_administration_id)}
        ${esqField('Volumen distribución', `line-vol-${index}`, l.distribution_volume, 'number')}
        ${esqField('Tiempo de infusión', `line-infusion-${index}`, l.infusion_time, 'number')}
        ${esqSelect('Unidad de tiempo', `line-unit-time-${index}`, catalogs.unit_times, l.chemotherapy_unit_time_id)}
        ${esqField('Días de tratamiento', `line-days-${index}`, l.treatment_days)}
        ${esqField('Multiplicar', `line-multiply-${index}`, l.multiply, 'number')}
        ${esqField('Creatinina', `line-creatinine-${index}`, l.creatinine, 'number')}
        ${esqField('AUC', `line-auc-${index}`, l.auc, 'number')}
        ${esqField('Tasa de filtración', `line-filtration-${index}`, l.filtration_rate)}
        ${esqField('Dosis total', `line-total-dose-${index}`, l.total_dose, 'number')}
        ${esqField('Tipo de solución', `line-type-solution-${index}`, l.type_solution)}
        ${esqField('Dosis carboplatino', `line-carboplatino-${index}`, l.dose_carboplatino)}
        <div class="form-group" style="display: flex; align-items: center; gap: 8px; margin-top: 18px;">
          <input type="checkbox" class="line-premedication" id="line-premed-${index}" ${l.premedication ? 'checked' : ''} style="width: 15px; height: 15px; cursor: pointer;">
          <label for="line-premed-${index}" style="font-size: 11px; font-weight: 700; text-transform: uppercase; margin: 0;">Premedicación</label>
        </div>
      </div>
    </div>
  `;
}

function renderEsquemaLinesContainer() {
  const container = document.getElementById('esqLinesContainer');
  const catalogs = clivoraChemoCatalogs;
  if (!container || !catalogs) return;
  container.innerHTML = clivoraChemoLinesDraft
    .map((line, index) => buildEsquemaLineCardHtml(line, index, catalogs))
    .join('') || '<div style="font-size: 12px; color: var(--text-muted); padding: 8px 0;">Sin líneas de tratamiento. Agrega la primera.</div>';

  container.querySelectorAll('.esq-remove-line').forEach(btn => {
    btn.onclick = () => {
      clivoraChemoLinesDraft.splice(parseInt(btn.dataset.lineIndex, 10), 1);
      renderEsquemaLinesContainer();
    };
  });
}

function readEsquemaLinesFromDom() {
  const container = document.getElementById('esqLinesContainer');
  if (!container) return [];
  return Array.from(container.querySelectorAll('[data-line-index]')).map((cardEl) => {
    const index = cardEl.dataset.lineIndex;
    const productInput = cardEl.querySelector('.line-product');
    const productOption = productInput
      ? document.querySelector(`#clivoraProductsDatalist option[value="${CSS.escape(productInput.value)}"]`)
      : null;
    const val = (sel) => cardEl.querySelector(sel)?.value || '';
    return {
      premedication: cardEl.querySelector('.line-premedication')?.checked || false,
      product_id: productOption ? parseInt(productOption.dataset.id, 10) : (productInput?.dataset.productId || false),
      dose: parseFloat(val(`#line-dose-${index}`)) || 0,
      chemotherapy_unit_dose_id: val(`#line-unit-dose-${index}`) || false,
      chemotherapy_via_administration_id: val(`#line-via-${index}`) || false,
      distribution_volume: parseFloat(val(`#line-vol-${index}`)) || 0,
      infusion_time: parseFloat(val(`#line-infusion-${index}`)) || 0,
      chemotherapy_unit_time_id: val(`#line-unit-time-${index}`) || false,
      treatment_days: val(`#line-days-${index}`),
      multiply: parseFloat(val(`#line-multiply-${index}`)) || 0,
      creatinine: parseFloat(val(`#line-creatinine-${index}`)) || 0,
      auc: parseFloat(val(`#line-auc-${index}`)) || 0,
      filtration_rate: val(`#line-filtration-${index}`),
      total_dose: parseFloat(val(`#line-total-dose-${index}`)) || 0,
      type_solution: val(`#line-type-solution-${index}`),
      dose_carboplatino: val(`#line-carboplatino-${index}`),
    };
  });
}

async function renderEsquemaForm(assignId) {
  const card = document.getElementById('esquemaDetailCard');
  if (!card) return;
  const catalogs = await ensureChemoCatalogs();
  await ensureProductsDatalist();

  const isNew = assignId === 'new';
  const data = isNew ? {} : (clivoraPatientChemo.find(a => a.id === assignId) || {});
  clivoraChemoEditingId = assignId;
  clivoraChemoLinesDraft = isNew ? [] : (data.lines || []).map(l => ({ ...l }));
  renderEsquemasList();

  card.className = 'expediente-editor-card';
  card.style.padding = '20px';
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
      <h3 style="font-size: 16px; font-weight: 800; margin: 0;">${isNew ? 'Nuevo Esquema' : (data.chemotherapy_name || 'Esquema de Quimioterapia')}</h3>
      <div style="display: flex; gap: 8px;">
        ${!isNew ? '<button type="button" class="btn-secondary btn-anim-lift" id="btnDeleteEsquema" style="padding: 8px 16px; font-size: 12px; color: #EF4444; border-color: #FCA5A5;">Eliminar</button>' : ''}
        <button type="button" class="btn-primary btn-anim-lift" id="btnSaveEsquema" style="padding: 8px 16px; font-size: 12px;">Guardar</button>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px;">
      ${esqSelect('Quimioterapia (catálogo)', 'esqChemoId', catalogs.chemotherapies, data.chemotherapy_id)}
      ${esqField('Diagnóstico', 'esqDiagnosis', data.diagnosis)}
      ${esqSelect('Motivo de tratamiento', 'esqReasonId', catalogs.treatment_reasons, data.chemotherapy_treatment_reason_id)}
      ${esqSelect('Doctor encargado', 'esqAppointeeId', catalogs.employees, data.appointee_id)}
      ${esqField('Ciclo', 'esqCycle', data.cycle)}
      ${esqField('Ciclo actual', 'esqCurrentCycle', data.current_cycle)}
      ${esqField('Total de ciclos', 'esqTotalCycle', data.total_cycle)}
      ${esqField('Fecha propuesta de inicio', 'esqDateInitial', data.date_initial, 'date')}
      ${esqField('Fecha propuesta de fin', 'esqDateEnd', data.date_end, 'date')}
      ${esqField('Peso', 'esqWeight', data.weight)}
      ${esqField('Superficie corporal', 'esqBodySurface', data.body_surface)}
      ${esqField('Talla', 'esqSize', data.size)}
      ${esqField('Género', 'esqGender', data.gender)}
      ${esqField('Edad', 'esqAge', data.age)}
      ${esqField('Catéter', 'esqCatheter', data.catheter)}
      ${esqField('Toxicidad', 'esqToxicity', data.toxicity)}
      ${esqField('Disolución', 'esqDissolution', data.dissolution)}
      ${esqTextarea('Premedicación', 'esqPremedication', data.premedication_description)}
      ${esqTextarea('Postmedicación', 'esqPostmedication', data.postmedication_description)}
      ${esqTextarea('Indicaciones de quimioterapia', 'esqIndications', data.indications_chemotherapy)}
      ${esqTextarea('Comentarios', 'esqComments', data.comments)}
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <h4 style="font-size: 13px; font-weight: 800; margin: 0;">Líneas de tratamiento</h4>
      <!-- Nunca usar "btn-hc-action blue-outline" aquí: ese combo de clases
           es exactamente lo que el listener global de clicks usa para
           detectar el botón "Imprimir Historia Clínica"
           (event.target.closest('.btn-hc-action.blue-outline')) — con esas
           clases, cada click en "+ Agregar línea" también disparaba
           printHistoriaClinica() (abría una pestaña nueva e imprimía el
           expediente) además de agregar la línea. -->
      <button type="button" class="btn-secondary btn-anim-lift" id="btnAddEsquemaLine" style="padding: 6px 14px; font-size: 12px;">+ Agregar línea</button>
    </div>
    <div id="esqLinesContainer"></div>
  `;

  renderEsquemaLinesContainer();

  document.getElementById('btnAddEsquemaLine').onclick = () => {
    clivoraChemoLinesDraft.push({});
    renderEsquemaLinesContainer();
  };

  const btnSaveEsquema = document.getElementById('btnSaveEsquema');
  btnSaveEsquema.onclick = () => runClivoraSaveOnce('esquema', btnSaveEsquema, () => saveEsquemaForm(isNew));

  const btnDelete = document.getElementById('btnDeleteEsquema');
  if (btnDelete) {
    btnDelete.onclick = async () => {
      if (!(await showClivoraConfirmModal('¿Eliminar este esquema de quimioterapia? Esta acción no se puede deshacer.'))) return;
      try {
        await fetch(`/clivora/api/chemotherapy/${assignId}/delete`, { method: 'POST' });
      } catch (error) {
        console.error('Error al eliminar el esquema:', error);
      }
      await loadPatientChemotherapy(window.clivoraCurrentPatientId);
    };
  }
}

async function saveEsquemaForm(isNew) {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) {
    showClivoraAlertModal('No se pudo identificar al paciente activo.');
    return;
  }
  const val = (id) => getEditableFieldValue(document.getElementById(id));
  const payload = {
    chemotherapy_id: val('esqChemoId') || false,
    diagnosis: val('esqDiagnosis'),
    chemotherapy_treatment_reason_id: val('esqReasonId') || false,
    appointee_id: val('esqAppointeeId') || false,
    cycle: val('esqCycle'),
    current_cycle: val('esqCurrentCycle'),
    total_cycle: val('esqTotalCycle'),
    date_initial: val('esqDateInitial'),
    date_end: val('esqDateEnd'),
    weight: val('esqWeight'),
    body_surface: val('esqBodySurface'),
    size: val('esqSize'),
    gender: val('esqGender'),
    age: val('esqAge'),
    catheter: val('esqCatheter'),
    toxicity: val('esqToxicity'),
    dissolution: val('esqDissolution'),
    premedication_description: val('esqPremedication'),
    postmedication_description: val('esqPostmedication'),
    indications_chemotherapy: val('esqIndications'),
    comments: val('esqComments'),
    lines: readEsquemaLinesFromDom(),
  };

  const btnSave = document.getElementById('btnSaveEsquema');
  if (btnSave) btnSave.disabled = true;
  try {
    const url = isNew
      ? `/clivora/api/patients/${patientId}/chemotherapy`
      : `/clivora/api/chemotherapy/${clivoraChemoEditingId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('save failed');
    const saved = await response.json();
    await loadPatientChemotherapy(patientId);
    renderEsquemaForm(isNew ? saved.id : clivoraChemoEditingId);
  } catch (error) {
    console.error('Error al guardar el esquema:', error);
    showClivoraAlertModal('No se pudo guardar el esquema. Intente de nuevo.');
  } finally {
    if (btnSave) btnSave.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const btnNuevo = event.target.closest('#btnNuevoEsquema');
  if (btnNuevo) {
    event.preventDefault();
    if (!window.clivoraCurrentPatientId) {
      showClivoraAlertModal('No se pudo identificar al paciente activo.');
      return;
    }
    renderEsquemaForm('new');
    return;
  }

});

let clivoraPatientConsultas = [];

// Mismo orden/catálogo completo que las <option> estáticas de
// #filterConsultaType en el HTML. Se usa para ordenar los tipos que sí tiene
// ESTE paciente (ver updateConsultaTypeFilterOptions), no para listarlos
// todos: antes el filtro mostraba los ~16 tipos posibles aunque el
// paciente solo tuviera, por ejemplo, Signos Vitales. Las dos entradas de
// "Notas de enfermeria" usan una clave sintética "tipo:nursingNoteKind"
// (ver getConsultaFilterKey) porque el backend guarda ambos tipos de nota
// de enfermería bajo el mismo "tipo", pero son formularios distintos que
// el usuario quiere poder filtrar por separado.
const CLIVORA_CONSULTA_TYPE_CATALOG = [
  { value: 'Signos vitales', label: 'Signos vitales' },
  { value: 'Notas de enfermeria:initial_assessment', label: 'Evaluación inicial de enfermería' },
  { value: 'Notas de enfermeria:clinical_record', label: 'Registro clínico de enfermería' },
  { value: 'Nota de oncología médica', label: 'Nota de oncología médica' },
  { value: 'Nota de radioterapia', label: 'Nota de radioterapia' },
  { value: 'Nota Médica de infusión', label: 'Nota Médica de infusión' },
  { value: 'Nota de Hematología', label: 'Nota de Hematología' },
  { value: 'Nota de Cuidados Paliativos', label: 'Nota de Cuidados Paliativos' },
  { value: 'Nota de Medicina Interna', label: 'Nota de Medicina Interna' },
  { value: 'Nota de Nefrología', label: 'Nota de Nefrología' },
  { value: 'Nota de Psicología', label: 'Nota de Psicología' },
  { value: 'Nota de Nutrición', label: 'Nota de Nutrición' },
  { value: 'Nota de Dermatología', label: 'Nota de Dermatología' },
  { value: 'Nota médica de cirugía', label: 'Nota médica de cirugía' },
  { value: 'Nota de Procedimientos ambulatorios', label: 'Nota de Procedimientos ambulatorios' },
  { value: 'Nota de Hospitalización', label: 'Nota de Hospitalización' },
  { value: 'Nota de Egreso hospitalario', label: 'Nota de Egreso hospitalario' },
];

// Notas de enfermeria son un único "tipo" en el backend, pero al usuario le
// interesa filtrar Evaluación Inicial y Registro Clínico por separado (son
// formularios completamente distintos) — se les da una clave sintética
// "tipo:nursingNoteKind" solo para el filtro, sin tocar c.tipo.
function getConsultaFilterKey(c) {
  if (c.source === 'nursing') return `${c.tipo}:${c.nursingNoteKind || 'clinical_record'}`;
  return c.tipo;
}

function updateConsultaTypeFilterOptions() {
  const select = document.getElementById('filterConsultaType');
  if (!select) return;
  const currentValue = select.value;
  const present = new Set(clivoraPatientConsultas.map(getConsultaFilterKey).filter(Boolean));
  const orderedPresent = CLIVORA_CONSULTA_TYPE_CATALOG.filter(t => present.has(t.value));
  select.innerHTML = ['<option value="">Todas las consultas</option>']
    .concat(orderedPresent.map(t => `<option value="${t.value}">${t.label}</option>`))
    .join('');
  select.value = present.has(currentValue) ? currentValue : '';
}

async function loadPatientConsultas(patientId) {
  if (!patientId) return;
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/consultations`, { cache: 'no-store' });
    clivoraPatientConsultas = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar consultas del paciente:', error);
    clivoraPatientConsultas = [];
  }
  updateConsultaTypeFilterOptions();
  renderPatientConsultas();
}

// #consultaDetailCard (la nota que se despliega a la derecha) no lleva una
// altura fija en CSS: un valor fijo no necesariamente coincide con lo que
// mide la columna izquierda una vez que suma buscador + filtro + botón +
// lista de notas (topada a ~5, ver #consultasListContainer en styles.css).
// Se sincroniza aquí al alto real ya renderizado de .expediente-sidebar
// para que ambas columnas queden exactamente parejas.
function syncConsultaDetailCardHeight() {
  const sidebar = document.querySelector('#tab-consultas .expediente-sidebar');
  const detailCard = document.getElementById('consultaDetailCard');
  if (!sidebar || !detailCard) return;
  const sidebarHeight = sidebar.offsetHeight;
  if (sidebarHeight > 0) {
    detailCard.style.height = `${sidebarHeight}px`;
  }
}
window.addEventListener('resize', syncConsultaDetailCardHeight);

// Misma idea que syncConsultaDetailCardHeight, para la pestaña Archivos:
// #archivoPreviewCard toma el alto real de .expediente-sidebar (buscador +
// filtro + botón + lista topada, ver #archivosListContainer en styles.css)
// en vez de una altura fija, para que ambas columnas queden parejas.
function syncArchivoPreviewCardHeight() {
  const sidebar = document.querySelector('#tab-archivos .expediente-sidebar');
  const previewCard = document.getElementById('archivoPreviewCard');
  if (!sidebar || !previewCard) return;
  const sidebarHeight = sidebar.offsetHeight;
  if (sidebarHeight > 0) {
    previewCard.style.height = `${sidebarHeight}px`;
  }
}
window.addEventListener('resize', syncArchivoPreviewCardHeight);

// Misma idea, para la pestaña "Órdenes Médicas": #labOrderDetailPanel toma
// el alto real de .expediente-sidebar (botón + lista topada, ver
// #labOrdersListContainer en styles.css) en vez de una altura fija.
function syncLabOrderDetailPanelHeight() {
  const sidebar = document.querySelector('#tab-laboratorio .expediente-sidebar');
  const detailPanel = document.getElementById('labOrderDetailPanel');
  if (!sidebar || !detailPanel) return;
  const sidebarHeight = sidebar.offsetHeight;
  if (sidebarHeight > 0) {
    detailPanel.style.height = `${sidebarHeight}px`;
  }
}
window.addEventListener('resize', syncLabOrderDetailPanelHeight);

// Misma idea, para la pestaña "Recetas": #recipeDetailCard toma el alto
// real de .expediente-sidebar (botón + lista topada, ver
// #recipesListContainer en styles.css) en vez de una altura fija.
function syncRecipeDetailCardHeight() {
  const sidebar = document.querySelector('#tab-recetas .expediente-sidebar');
  const detailCard = document.getElementById('recipeDetailCard');
  if (!sidebar || !detailCard) return;
  const sidebarHeight = sidebar.offsetHeight;
  if (sidebarHeight > 0) {
    detailCard.style.height = `${sidebarHeight}px`;
  }
}
window.addEventListener('resize', syncRecipeDetailCardHeight);

// Ícono + color por tipo de nota, tomados tal cual del selector "Nueva
// Consulta" (ver .consulta-type-btn / #btnFormatoEvaluacionInicial /
// #btnFormatoRegistroClinico en paciente-detail.html) — antes la lista de
// la izquierda pintaba el mismo ícono (el de Oncología) para toda nota sin
// importar su tipo. Los tipos que no tienen un botón propio en ese
// selector (Nutrición, Psicología, Procedimientos ambulatorios, Egreso,
// Nefrología, Cuidados Paliativos) caen al ícono genérico de documento.
function getConsultaIconInfo(c) {
  const tipo = c.tipo || '';
  if (tipo === 'Signos vitales') {
    return { bg: '#EFF6FF', color: '#2563EB', svg: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>' };
  }
  if (tipo === 'Notas de enfermeria') {
    if (c.nursingNoteKind === 'initial_assessment') {
      return { bg: 'rgba(37,99,235,0.1)', color: '#2563EB', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' };
    }
    return { bg: 'rgba(16,185,129,0.1)', color: '#10B981', svg: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' };
  }
  if (tipo === 'Nota de evolución') {
    return { bg: '#F3E8FF', color: '#2F4C8A', svg: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' };
  }
  if (tipo === 'Nota de oncología médica') {
    return { bg: '#FEE2E2', color: '#EF4444', svg: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' };
  }
  if (tipo === 'Nota de radioterapia') {
    return { bg: '#FEF3C7', color: '#D97706', svg: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' };
  }
  return { bg: '#F1F5F9', color: '#64748B', svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' };
}

function renderPatientConsultas() {
  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';

  const container = document.getElementById('consultasListContainer');
  if (!container) return;

  const countLabel = document.getElementById('consultasCountLabel');
  const searchInput = document.getElementById('searchConsultaInput');
  const filterTypeSelect = document.getElementById('filterConsultaType');

  const searchTerm = (searchInput?.value || '').toLowerCase().trim();
  const filterType = (filterTypeSelect?.value || '').trim();

  const userConsultas = clivoraPatientConsultas;

  const filtered = userConsultas.filter(c => {
    const matchSearch = !searchTerm ||
      (c.tipo || '').toLowerCase().includes(searchTerm) ||
      (c.titulo || '').toLowerCase().includes(searchTerm) ||
      (c.medico || '').toLowerCase().includes(searchTerm) ||
      (c.comentarios || '').toLowerCase().includes(searchTerm);

    const matchType = !filterType || getConsultaFilterKey(c) === filterType;
    return matchSearch && matchType;
  });

  if (countLabel) {
    countLabel.textContent = `${filtered.length} consultas`;
  }

  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px 16px; text-align: center; color: var(--text-muted); font-size: 12px; background: var(--bg-main); border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        No hay consultas registradas para este paciente.
      </div>
    `;
    const previewCard = document.getElementById('consultaDetailCard');
    if (previewCard) {
      previewCard.classList.add('empty-state-container');
      previewCard.innerHTML = `
        <div class="empty-state-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="1.5">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>
        <h3 class="empty-state-title">Sin consultas para ${activePatientName}</h3>
        <p class="empty-state-desc">Haz clic en "+ Nueva Consulta" para agregar la primera consulta o nota</p>
      `;
    }
    syncConsultaDetailCardHeight();
    return;
  }

  filtered.forEach((c, index) => {
    const card = document.createElement('div');
    card.className = `file-card ${index === 0 ? 'active-card' : ''}`;
    card.style.cursor = 'pointer';
    card.style.marginBottom = '8px';
    card.dataset.consultaId = c.id;

    const iconInfo = getConsultaIconInfo(c);
    card.innerHTML = `
      <div class="file-card-icon" style="background-color: ${iconInfo.bg}; color: ${iconInfo.color}; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${iconInfo.svg}
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <div style="font-size: 12px; font-weight: 800; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;">${c.tipo || c.titulo}</div>
          <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
            <span style="font-size: 10px; font-weight: 700; color: var(--text-subtle);" title="ID del registro">#${c.id}</span>
            ${c.source ? `<button type="button" class="btn-delete-consulta btn-anim-lift" data-source="${c.source}" title="Eliminar nota" aria-label="Eliminar nota"
              style="display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid #FCA5A5; border-radius: 6px; background: transparent; color: #EF4444; cursor: pointer;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>` : ''}
          </div>
        </div>
        <div style="font-size: 11px; color: var(--primary-blue); font-weight: 700; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${activePatientName}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.medico || 'Sin médico asignado'}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px; margin-top: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.fecha}${c.createdBy ? ` · ${c.createdBy}` : ''}</span>
        </div>
      </div>
    `;

    card.onclick = () => {
      container.querySelectorAll('.file-card').forEach(item => item.classList.remove('active-card'));
      card.classList.add('active-card');
      openConsultaCard(c);
    };

    const btnDeleteConsulta = card.querySelector('.btn-delete-consulta');
    if (btnDeleteConsulta) {
      btnDeleteConsulta.onclick = async (event) => {
        // Sin esto el click también abre la nota (card.onclick).
        event.stopPropagation();
        if (!(await showClivoraConfirmModal(`¿Eliminar la nota "${c.tipo || c.titulo || ''}" (#${c.id})? Esta acción no se puede deshacer.`))) return;
        try {
          // c.id viene con prefijo por tipo de nota ("v-12", "n-46", "o-3"…,
          // ver consultaEditableRecord) — la ruta espera solo el número.
          const recordId = String(c.id).split('-').pop();
          const response = await fetch(`/clivora/api/consultations/${c.source}/${recordId}/delete`, { method: 'POST' });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            showClivoraAlertModal(data && data.message ? `No se pudo eliminar la nota:\n\n${data.message}` : 'No se pudo eliminar la nota.');
            return;
          }
        } catch (error) {
          console.error('Error al eliminar la nota:', error);
          showClivoraAlertModal('No se pudo eliminar la nota.');
          return;
        }
        loadPatientConsultas(window.clivoraCurrentPatientId);
      };
    }

    container.appendChild(card);
  });

  // Auto-select de la primera nota: por el mismo enrutado que el click de
  // la tarjeta (openConsultaCard). Antes iba directo a showConsultaPreview
  // (vista genérica) porque las notas de enfermería/oncología se editaban en
  // un modal que se abría solo al entrar al paciente; ahora esas tarjetas se
  // pintan en el panel derecho y abren bloqueadas (solo lectura, ver
  // setNoteFormLocked), así que no hay nada que se abra encima. Con la vista
  // genérica, al recargar y volver a Notas la nota de enfermería se veía
  // "vacía" (solo "Nota registrada en el expediente...") y su Imprimir no
  // usaba el formato de su reporte.
  if (filtered.length > 0) {
    openConsultaCard(filtered[0]);
  }
  syncConsultaDetailCardHeight();
}

// Punto único de enrutado para abrir una nota de la pestaña Notas — usado
// tanto por el click de cada tarjeta como por el auto-select del primer
// resultado (antes ese auto-select llamaba a showConsultaPreview directo,
// así que si la primera nota era justo de enfermería u oncología caía en la
// vista genérica en vez de abrir su modal real).
function openConsultaCard(c) {
  // Enfermería y Oncología se editan con una tarjeta propia en el panel
  // derecho, con el mismo diseño que su modal/wizard de creación pero
  // construida de forma independiente (ids propios, sin compartir el nodo
  // del DOM con el modal) — así crear una nota nueva nunca se ve afectado
  // por editar una ya guardada, y cambiar entre notas de distinto tipo
  // siempre repinta correctamente (antes, al mover el mismo nodo del modal,
  // cualquier otra nota destruía ese nodo al repintar el panel).
  if (c.source === 'nursing') {
    if (c.nursingNoteKind === 'initial_assessment') {
      renderNursingAssessmentEditCard(c);
    } else {
      renderNursingClinicalEditCard(c);
    }
    return;
  }
  if (c.source === 'consultation') {
    renderOncologyEditCard(c);
    return;
  }
  showConsultaPreview(c);
}

let currentPreviewConsulta = null;

// getActivePatientExp() también está definida más abajo, pero anidada
// dentro de otro listener y por lo tanto fuera de alcance aquí — sin esta
// copia global, showConsultaPreview truena con "getActivePatientExp is not
// defined" en cuanto se llama y nunca llega a pintar el detalle de la
// consulta seleccionada.
function getActivePatientExp() {
  return document.getElementById('detailPatientExp')?.textContent?.replace(/[^0-9]/g, '') || '00180';
}

// Catálogos fijos de Nota de Oncología Médica — copia exacta de las
// <option> de #modalNotaOncologiaMedica (paciente-detail.html), para que
// la tarjeta de edición del panel use los mismos textos/valores.
const ONCO_ECOG_OPTIONS = [
  ['0', '0: Paciente asintomático. Puede realizar actividades normales de la vida diaria.'],
  ['1', '1: Paciente no puede realizar actividades de esfuerzo arduo, sin embargo, mantiene facultad de realizar sus actividades diarias ligeras sin ayuda. Sólo en cama por la noche.'],
  ['2', '2: No es capaz de desempeñar trabajo alguno. Síntomas le impiden realizar algunas actividades y lo obligan a permanecer en cama varias horas del día sin superar el 50% del día. Satisface casi todas sus actividades por sí solo.'],
  ['3', '3: Paciente necesita estar encamado más de la mitad del día por síntomas. Necesita ayuda en la mayoría de sus actividades, incluso el vestirse.'],
  ['4', '4: Paciente encamado el 100% del día y necesita apoyo para todas sus actividades de la vida diaria.'],
  ['5', '5: Paciente ha fallecido'],
];
const ONCO_KARNOFSKY_OPTIONS = [
  ['100', '100: Asintomático. No hay evidencia de enfermedad.'],
  ['90', '90: Con la capacidad de realizar actividades normales. Signos o síntomas de enfermedad (menores).'],
  ['80', '80: Actividad normal con esfuerzo. Algunos signos y síntomas de enfermedad.'],
  ['70', '70: Incapaz de poder trabajar o realizar actividades cotidianas. Independiente.'],
  ['60', '60: Ocasionalmente necesita asistencia. La gran mayoría de sus actividades las desarrolla por sí mismo.'],
  ['50', '50: Precisa de asistencia considerable. Frecuentemente solicita cuidados médicos.'],
  ['40', '40: Imposibilitado. Cuidados especiales y asistencia es requerida.'],
  ['30', '30: Se requiere hospitalización, aunque la muerte no es inminente.'],
  ['20', '20: Precisa hospitalización y en estado grave de enfermedad. Requiere tratamiento soporte activo.'],
  ['10', '10: Moribundo.'],
  ['0', '0: Finado.'],
];
function oncoOptionsHtml(options, currentValue) {
  return options.map(([value, label]) =>
    `<option value="${value}" ${String(value) === String(currentValue) ? 'selected' : ''}>${label}</option>`
  ).join('');
}

// Catálogos de "Valoración por Aparatos y Sistemas" del Registro Clínico de
// Enfermería — copia exacta de las <option> de #modalNotaClinica
// (paciente-detail.html), para que la tarjeta de edición del panel use los
// mismos valores/textos.
const NC_SYSTEMS_CONSCIOUSNESS_OPTIONS = [
  ['alerta', 'Alerta y orientado'],
  ['orientado_3_esferas', 'Orientado en 3 esferas'],
  ['lenguaje_claro', 'Lenguaje claro'],
  ['sigue_instrucciones', 'Sigue instrucciones'],
  ['moviliza_extremidades', 'Moviliza las 4 extremidades'],
  ['somnoliento', 'Somnoliento'],
  ['confuso', 'Confuso'],
  ['otro', 'Otro'],
];
const NC_SYSTEMS_MOOD_OPTIONS = [
  ['tranquilo', 'Tranquilo / Colaborador'],
  ['triste', 'Triste'],
  ['euforico', 'Eufórico'],
  ['ansioso', 'Ansioso'],
  ['agresivo', 'Agresivo'],
  ['deprimido', 'Deprimido'],
  ['otro', 'Otro'],
];
const NC_SYSTEMS_URINARY_OPTIONS = [
  ['espontaneo', 'Espontáneo / Claro (sin alteración)'],
  ['incontinencia_urinaria', 'Incontinencia'],
  ['disuria', 'Disuria'],
  ['retencion', 'Retención'],
  ['hematuria', 'Hematuria'],
  ['sonda', 'Sonda vesical'],
  ['otro', 'Otro'],
];
const NC_SYSTEMS_GASTROINTESTINAL_OPTIONS = [
  ['normal', 'Ruidos peristálticos (+) (sin alteración)'],
  ['estrenimiento', 'Estreñimiento'],
  ['incontinencia_gi', 'Incontinencia'],
  ['diarrea', 'Diarrea'],
  ['nausea', 'Náusea'],
  ['vomitos', 'Vómito'],
  ['anorexia', 'Anorexia'],
  ['distension', 'Distensión abdominal'],
  ['otro', 'Otro'],
];
const NC_SYSTEMS_CARDIORESPIRATORY_OPTIONS = [
  ['normal', 'Buena ventilación (sin alteración)'],
  ['palpitaciones', 'Palpitaciones'],
  ['disnea', 'Disnea'],
  ['parestesias', 'Parestesias'],
  ['neuropatias', 'Neuropatías'],
  ['edema', 'Edema'],
  ['tos', 'Tos / Secreciones'],
  ['otro', 'Otro'],
];
const NC_SYSTEMS_SKIN_OPTIONS = [
  ['integra', 'Piel íntegra / Hidratada'],
  ['deshidratada', 'Deshidratada'],
  ['ictericia', 'Ictericia'],
  ['palidez', 'Palidez'],
  ['hiperpigmentacion', 'Hiperpigmentación'],
  ['dermatitis', 'Dermatitis'],
  ['alopecia', 'Alopecia'],
  ['mucositis', 'Mucositis'],
  ['heridas', 'Heridas / Úlceras'],
  ['rash', 'Rash cutáneo'],
  ['otro', 'Otro'],
];

// Fila de la Tabla de Diagnósticos — reusada tanto para precargar las filas
// ya guardadas de la nota (editar) como para agregar una fila vacía nueva.
// Mismo markup que #tbodyOncoDiagnosticos del modal de creación, pero sin
// ids compartidos (el buscador CIE11 se engancha por clase, no por id).
// Bloquea/desbloquea todos los campos y botones de un formulario de edición
// de nota (Oncología/Enfermería) — por default las notas abren bloqueadas
// (modo lectura) para que navegar entre notas o dar clic sin querer no
// pueda modificar/guardar nada por accidente; solo tras presionar "Editar"
// se habilitan. Los campos ya marcados readOnly a propósito (ej. Signos
// Vitales autocargados, siempre de solo lectura) se dejan intactos en
// ambos sentidos.
function setNoteFormLocked(formEl, locked) {
  if (!formEl) return;
  formEl.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.readOnly) return;
    el.disabled = locked;
  });
  formEl.querySelectorAll('button').forEach(btn => { btn.disabled = locked; });
  // Los div[contenteditable] de .rich-text-content (ver Notas) no tienen
  // propiedad "disabled" — se bloquean apagando contentEditable.
  formEl.querySelectorAll('.rich-text-content[contenteditable]').forEach(el => {
    el.contentEditable = locked ? 'false' : 'true';
  });
}

// Escala de Glasgow del Registro Clínico de Enfermería (alta: ncGlasgow*,
// edición: edNcGlasgow*): "Resultado total" es de solo lectura y se calcula
// solo como Motora + Verbal + Ocular. Listener delegado porque la tarjeta de
// edición se reconstruye (innerHTML) al abrir cada nota.
document.addEventListener('input', (event) => {
  const match = /^(nc|edNc)Glasgow(Motor|Verbal|Ocular)$/.exec(event.target?.id || '');
  if (!match) return;
  const prefix = match[1];
  const values = ['Motor', 'Verbal', 'Ocular']
    .map(part => document.getElementById(`${prefix}Glasgow${part}`)?.value)
    .filter(value => value !== undefined && value !== '');
  const resultEl = document.getElementById(`${prefix}GlasgowResult`);
  if (!resultEl) return;
  resultEl.value = values.length
    ? values.reduce((sum, value) => sum + (parseInt(value, 10) || 0), 0)
    : '';
});

// ============================
// EDITOR DE TEXTO ENRIQUECIDO (.rich-text-editor)
// ============================
// Convierte cualquier div[contenteditable].rich-text-content (con su
// .rich-text-toolbar hermana justo antes en el DOM) en un editor con
// fuente/tamaño/negrita/cursiva/tachado/color/resaltado/alineación/listas,
// vía document.execCommand — sin depender de ninguna librería externa. El
// campo se lee/escribe con .innerHTML (ver richTextValue), no con .value.

// Se activa mientras el cursor está dentro del contenteditable (clic o
// flechas) — un <select>/<input color> de la barra de herramientas le quita
// el foco al elegir una opción, así que sin guardar el rango aquí se perdía
// dónde estaba el cursor y execCommand ya no sabía qué formatear.
function saveRichTextSelection(event) {
  const contentEl = event.target.closest?.('.rich-text-content');
  if (!contentEl) return;
  const sel = window.getSelection();
  if (sel.rangeCount > 0) contentEl._rtSavedRange = sel.getRangeAt(0).cloneRange();
  updateRichTextToolbarState(contentEl.previousElementSibling);
}
document.addEventListener('mouseup', saveRichTextSelection);
document.addEventListener('keyup', saveRichTextSelection);

function restoreRichTextSelection(contentEl) {
  if (!contentEl) return;
  contentEl.focus();
  const range = contentEl._rtSavedRange;
  if (range) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Refleja en la barra (botón resaltado) si el formato bajo el cursor ya está
// activo — mismo patrón que cualquier editor de texto (Word, Access, etc.)
// que se ve en la barra "Texto enriquecido" de referencia.
function updateRichTextToolbarState(toolbar) {
  if (!toolbar || !toolbar.classList || !toolbar.classList.contains('rich-text-toolbar')) return;
  ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(cmd => {
    const btn = toolbar.querySelector(`.rt-cmd-btn[data-cmd="${cmd}"]`);
    if (!btn) return;
    try {
      btn.classList.toggle('active', document.queryCommandState(cmd));
    } catch (error) {
      // queryCommandState puede tronar si el foco no está en un editable.
    }
  });
}

// Sin esto, Chrome/Safari ni siquiera implementan el comando "hiliteColor"
// (el resaltado): sin "styleWithCSS" en true, execCommand aplica el formato
// con <font>/<b> legacy en vez de estilos CSS reales, y "hiliteColor"
// específicamente queda como no-op ahí (solo "backColor" funcionaba sin
// esto, y con un resultado inconsistente frente a Firefox). Con styleWithCSS
// en true, fontName/fontSize/foreColor/hiliteColor generan <span style="...">
// en vez de <font>, consistente entre navegadores. Se reafirma antes de cada
// comando (no solo una vez al cargar) porque algunos navegadores lo resetean
// al perder el foco el contenteditable.
function ensureRichTextStyleWithCSS() {
  try {
    document.execCommand('styleWithCSS', false, true);
  } catch (error) {
    // Algunos navegadores viejos no soportan este comando — no es crítico,
    // solo se pierde la consistencia de estilos, no la funcionalidad base.
  }
}

// Los botones usan mousedown (no click) con preventDefault: así el
// contenteditable nunca pierde el foco/selección al hacer clic en la barra,
// y execCommand aplica el formato sobre el texto que el médico ya
// seleccionó en vez de perder la selección.
document.addEventListener('mousedown', (event) => {
  const btn = event.target.closest('.rich-text-toolbar .rt-cmd-btn');
  if (!btn) return;
  event.preventDefault();
  ensureRichTextStyleWithCSS();
  document.execCommand(btn.dataset.cmd, false, null);
  updateRichTextToolbarState(btn.closest('.rich-text-toolbar'));
});

// A diferencia de los botones (mousedown+preventDefault, nunca sueltan el
// foco), elegir una opción del <select> o del <input type="color"> SÍ le
// quita el foco al contenteditable antes de que este handler corra.
// restoreRichTextSelection ya lo re-enfoca y restaura la selección
// guardada, pero llamar a execCommand en el mismo tick del evento "change"/
// "input" corre contra el propio ciclo de blur/focus del navegador al
// cerrar el <select> — en Chrome, en particular, el foco tarda un tick en
// asentarse de vuelta en el contenteditable, y el comando se perdía en
// silencio (ni error en consola, ni cambio visible). Se difiere con
// setTimeout(0) para correr después de que el navegador termine ese ciclo.
document.addEventListener('change', (event) => {
  const select = event.target.closest('.rich-text-toolbar select.rt-cmd-select');
  if (!select) return;
  const contentEl = select.closest('.rich-text-toolbar')?.nextElementSibling;
  setTimeout(() => {
    restoreRichTextSelection(contentEl);
    ensureRichTextStyleWithCSS();
    document.execCommand(select.dataset.cmd, false, select.value);
  }, 0);
});

// El color de subrayado (data-cmd="underlineColor") no es un execCommand
// real del navegador — a diferencia de "foreColor"/"hiliteColor", no existe
// un comando nativo para "text-decoration-color" (el subrayado normal
// siempre sale del mismo color que el texto). Se arma a mano: subraya la
// selección y la envuelve en un <span> con text-decoration-color propio,
// así el subrayado puede quedar de un color distinto al de la letra (mismo
// resultado que "Color de subrayado" en Word/PowerPoint).
function applyUnderlineColor(contentEl, color) {
  if (!contentEl) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  // Fuera del contenteditable en cuestión (foco perdido a otro campo entre
  // el guardar-selección y este setTimeout) — no tocar nada ajeno.
  if (!contentEl.contains(range.commonAncestorContainer)) return;
  const span = document.createElement('span');
  span.style.textDecorationLine = 'underline';
  span.style.textDecorationColor = color;
  try {
    range.surroundContents(span);
  } catch (error) {
    // La selección cruza el borde de otro elemento (ej. mitad negrita,
    // mitad no) — surroundContents no lo permite; extraer e insertar sí
    // funciona igual para ese caso.
    const contents = range.extractContents();
    span.appendChild(contents);
    range.insertNode(span);
  }
  sel.removeAllRanges();
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.addRange(newRange);
}

// "input" (no "change") para que el color se vea aplicado en vivo mientras
// se arrastra en el selector, igual que el resto de editores de texto.
document.addEventListener('input', (event) => {
  const colorInput = event.target.closest('.rich-text-toolbar input.rt-cmd-color');
  if (!colorInput) return;
  const contentEl = colorInput.closest('.rich-text-toolbar')?.nextElementSibling;
  setTimeout(() => {
    restoreRichTextSelection(contentEl);
    ensureRichTextStyleWithCSS();
    if (colorInput.dataset.cmd === 'underlineColor') {
      applyUnderlineColor(contentEl, colorInput.value);
    } else {
      document.execCommand(colorInput.dataset.cmd, false, colorInput.value);
    }
  }, 0);
});

// El rediseño "estilo Word" (icono + barra de color delgada, ver
// .rt-color-icon-group en styles.css) dejó el <input type="color"> real
// reducido a una barra de solo 4px de alto — el glifo "A"/"U" que el
// usuario ve y con el que naturalmente intenta hacer clic es un <span>
// aparte, sin ningún listener propio, así que clicar ahí no abría el
// selector de color (solo clicar exactamente sobre la barra de 4px sí
// funcionaba). Se delega: cualquier clic dentro del grupo que no sea ya el
// propio input le reenvía un .click() para abrir su selector nativo.
document.addEventListener('click', (event) => {
  const group = event.target.closest('.rich-text-toolbar .rt-color-icon-group');
  if (!group || event.target.matches('input.rt-cmd-color')) return;
  const colorInput = group.querySelector('input.rt-cmd-color');
  if (colorInput) colorInput.click();
});

// Valor "guardable" de un .rich-text-content: su HTML, o '' si el usuario
// nunca escribió nada (un contenteditable vacío puede quedar con un <br> o
// un <div></div> huérfano en vez de una cadena vacía real).
function richTextValue(el) {
  if (!el) return '';
  const html = el.innerHTML.trim();
  return (html === '' || html === '<br>' || /^(<div><br><\/div>|<p><br><\/p>)$/.test(html)) ? '' : html;
}

// Para los pocos .rich-text-content que en realidad alimentan un campo Char
// del backend (no Html) — ej. product/diagnosis_text de la receta.
// richTextValue()/getEditableFieldValue() devuelven el innerHTML tal cual, que
// es lo correcto para los campos Html reales (Análisis Clínico, Indicaciones,
// notas, etc.), pero en un Char terminaba guardando las etiquetas crudas
// (<div>, <br>, hasta <b>/<ul> si alguien pegaba texto con formato) en vez de
// texto plano. Se arma con un <div> temporal (textContent ya decodifica
// entidades y ChatGPT-style saltos de línea de <br>/<div> quedan como
// separación real entre palabras, no pegados) en vez de un regex que quite
// "<[^>]+>" a mano, que uniría "Palabra1</div><div>Palabra2" en
// "Palabra1Palabra2" sin espacio.
function plainTextValue(el) {
  const html = richTextValue(el);
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html
    .replace(/<br\s*\/?>/gi, '<br> ')
    .replace(/<\/(div|p|li)>/gi, '$& ');
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

// Lee/escribe cualquier campo "de texto" sin que el código que ya existía
// (applyFieldMap, guardado de notas, botón de grabar audio, limpiar
// formularios, etc.) tenga que saber si detrás hay un <textarea>/<input>
// normal o un div[contenteditable] .rich-text-content — todos los
// <textarea> de la app se convirtieron a este editor enriquecido, y sin
// este helper cada punto que leía/escribía ".value" habría quedado roto
// (un div no tiene esa propiedad).
function getEditableFieldValue(el) {
  if (!el) return '';
  if (el.classList && el.classList.contains('rich-text-content')) return richTextValue(el);
  return el.type === 'checkbox' ? el.checked : el.value;
}
function setEditableFieldValue(el, val) {
  if (!el) return;
  const value = (val === null || val === undefined || val === false) ? '' : val;
  if (el.classList && el.classList.contains('rich-text-content')) {
    el.innerHTML = value;
    return;
  }
  if (el.type === 'checkbox') el.checked = !!val;
  else el.value = value;
}

// Barra de herramientas compartida por todo editor de texto enriquecido
// (fuente/tamaño/negrita/cursiva/tachado/color/resaltado/alineación/listas)
// — un solo template para no repetir este bloque en cada función que arma
// HTML dinámico (renderOncologyEditCard, tarjetas repetibles de HC, etc.).
const RICH_TEXT_TOOLBAR_HTML = `<div class="rich-text-toolbar">
      <select class="rt-cmd-select" data-cmd="fontName" title="Fuente">
        <option value="Calibri">Calibri</option>
        <option value="Arial">Arial</option>
        <option value="Georgia">Georgia</option>
        <option value="Times New Roman">Times New Roman</option>
        <option value="Verdana">Verdana</option>
        <option value="Courier New">Courier New</option>
      </select>
      <select class="rt-cmd-select" data-cmd="fontSize" title="Tamaño de fuente">
        <option value="2">10</option>
        <option value="3" selected>12</option>
        <option value="4">14</option>
        <option value="5">18</option>
        <option value="6">24</option>
        <option value="7">36</option>
      </select>
      <span class="rt-sep"></span>
      <button type="button" class="rt-cmd-btn" data-cmd="bold" title="Negrita"><b>N</b></button>
      <button type="button" class="rt-cmd-btn" data-cmd="italic" title="Cursiva"><i>K</i></button>
      <button type="button" class="rt-cmd-btn" data-cmd="underline" title="Subrayado"><u>U</u></button>
      <button type="button" class="rt-cmd-btn" data-cmd="strikeThrough" title="Tachado"><s>S</s></button>
      <span class="rt-sep"></span>
      <span class="rt-color-icon-group" title="Color de texto"><span class="rt-color-icon-label">A</span><input type="color" class="rt-cmd-color" data-cmd="foreColor" value="#1F2937"></span>
      <span class="rt-color-icon-group" title="Resaltado"><span class="rt-color-icon-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg></span><input type="color" class="rt-cmd-color" data-cmd="hiliteColor" value="#FEF08A"></span>
      <span class="rt-color-icon-group" title="Color de subrayado"><span class="rt-color-icon-label rt-color-icon-underline">U</span><input type="color" class="rt-cmd-color" data-cmd="underlineColor" value="#DC2626"></span>
      <span class="rt-sep"></span>
      <button type="button" class="rt-cmd-btn" data-cmd="justifyLeft" title="Alinear a la izquierda"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg></button>
      <button type="button" class="rt-cmd-btn" data-cmd="justifyCenter" title="Centrar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg></button>
      <button type="button" class="rt-cmd-btn" data-cmd="justifyRight" title="Alinear a la derecha"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg></button>
      <span class="rt-sep"></span>
      <button type="button" class="rt-cmd-btn" data-cmd="insertUnorderedList" title="Lista con viñetas"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg></button>
      <button type="button" class="rt-cmd-btn" data-cmd="insertOrderedList" title="Lista numerada"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg></button>
    </div>`;

// Genera el markup de un editor de texto enriquecido (mismo diseño que
// Premedicación/Postmedicación/Notas de Oncología) para insertar dentro de un
// template literal — usado por los paneles "editar consulta" que se arman
// dinámicamente en JS (a diferencia de los <textarea> estáticos del HTML,
// que se convirtieron directo en el archivo).
function richTextEditorHtml(id, placeholder, value) {
  const ph = String(placeholder || '').replace(/"/g, '&quot;');
  const content = value || '';
  return `<div class="rich-text-editor">
    ${RICH_TEXT_TOOLBAR_HTML}
    <div class="rich-text-content" id="${id}" contenteditable="true" data-placeholder="${ph}">${content}</div>
  </div>`;
}

// Misma idea, pero para tarjetas repetibles (alergias, cirugías, etc.) donde
// varias instancias del mismo campo conviven en la página — se identifican
// por clase (como ya hacía .med-descripcion en buildMedicationRowHtml), no
// por id único.
function richTextEditorHtmlClass(className, placeholder, value) {
  const ph = String(placeholder || '').replace(/"/g, '&quot;');
  const content = value || '';
  return `<div class="rich-text-editor">
    ${RICH_TEXT_TOOLBAR_HTML}
    <div class="rich-text-content ${className}" contenteditable="true" data-placeholder="${ph}">${content}</div>
  </div>`;
}

function buildEdOncoDiagRowHtml(diag) {
  const d = diag || {};
  const codigo = String(d.codigo || '').replace(/"/g, '&quot;');
  const selectedId = d.cie11_diagnosis_id || '';
  const tipo = d.tipo || 'Principal';
  const comentario = String(d.comment || '').replace(/"/g, '&quot;');
  const tipoOption = (val) => `<option value="${val}" ${tipo === val ? 'selected' : ''}>${val}</option>`;
  return `
    <tr>
      <td style="padding: 8px; border: 1px solid var(--border-color);">
        <div style="position: relative;">
          <input type="text" class="familiar-input onco-diag-codigo cie11-search-input"
            placeholder="Buscar por código o nombre..." autocomplete="off" style="width: 100%; padding: 6px; font-size: 12px;"
            value="${codigo}" ${selectedId ? `data-selected-id="${selectedId}"` : ''}>
          <div class="cie11-search-dropdown agenda-patient-dropdown" style="display: none;"></div>
        </div>
      </td>
      <td style="padding: 8px; border: 1px solid var(--border-color);">
        <select class="custom-select onco-diag-tipo" style="width: 100%; padding: 6px; font-size: 12px;">
          ${tipoOption('Principal')}${tipoOption('Secundario')}${tipoOption('Complicación')}
        </select>
      </td>
      <td style="padding: 8px; border: 1px solid var(--border-color);">
        <input type="text" class="familiar-input onco-diag-comment" placeholder="Comentario breve..."
          style="width: 100%; padding: 6px; font-size: 12px;" value="${comentario}">
      </td>
      <td style="padding: 8px; border: 1px solid var(--border-color); text-align: center;">
        <button type="button" class="btn-remove-row btn-anim-lift" style="background: transparent; border: none; color: #EF4444; cursor: pointer; font-size: 14px; display: inline-flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </td>
    </tr>
  `;
}

// Tarjeta de edición de Nota de Oncología Médica en el panel derecho —
// independiente de #modalNotaOncologiaMedica (ids propios "edOnco*", nunca
// comparte el nodo del DOM con el modal de creación), con el mismo alcance
// de campos ya acordado: Antecedentes, Signos Vitales (autocargados, solo
// lectura), ECOG/Karnofsky, Exploración, Tabla de Diagnósticos, Análisis,
// Notas. Recetas se quedan fuera (solo existen al crear la nota).
async function renderOncologyEditCard(c) {
  const card = document.getElementById('consultaDetailCard');
  if (!card) return;
  currentPreviewConsulta = c;
  card.classList.remove('empty-state-container');

  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';
  const activeExp = getActivePatientExp();
  const recordId = parseInt(String(c.id).split('-')[1], 10) || 0;

  card.innerHTML = `
    <div style="width: 100%; text-align: left;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
        <div>
          <span style="font-size: 11px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase; letter-spacing: 0.05em;">EDITAR NOTA DE ONCOLOGÍA MÉDICA</span>
          <h2 style="font-size: 22px; font-weight: 800; color: var(--text-main); margin-top: 2px;">Nota de Oncología Médica</h2>
          <div style="font-size: 13px; color: var(--primary-blue); font-weight: 800; margin-top: 4px; display: flex; align-items: center; gap: 6px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Paciente: ${activePatientName} <span style="font-weight: 500; color: var(--text-muted); font-size: 12px;">(Exp: ${activeExp})</span></div>
          ${buildCreatedUpdatedMetaHtml(c.fecha, c.createdBy, c.updatedAt, c.updatedBy, consultaEditableRecord(c))}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDiscardEdOnco" style="color: #EF4444; border-color: #FCA5A5; font-size: 12px; padding: 8px 14px; display: none;">Descartar</button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnEditEdOnco" style="font-size: 12px; padding: 8px 14px;">Editar</button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnPrintEdOnco" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir
          </button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDownloadEdOnco" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Descargar PDF
          </button>
          <button type="button" class="btn-primary btn-anim-lift" id="btnSaveEdOnco" style="font-size: 12px; padding: 8px 14px; display: none;">Guardar Nota</button>
        </div>
      </div>

      <div id="edOncoSaveFeedback" style="display: none; background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; font-weight: 700; margin-bottom: 16px; align-items: center; gap: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Nota actualizada con éxito.
      </div>

      <!-- DOCUMENTOS GENERADOS DESDE ESTA NOTA (dinámico, ver
           renderOncoLinkedDocuments más abajo). -->
      <div style="margin-bottom: 20px;">
        <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: block;">Documentos generados desde esta nota</label>
        <div id="edOncoLinkedDocsContainer" style="display: flex; flex-direction: column; gap: 6px;"></div>
      </div>

      <form id="formEdOncologia" style="display: flex; flex-direction: column; gap: 14px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label style="font-size: 11px; font-weight: 700;">Fecha y Hora de Ingreso</label>
            <input type="datetime-local" id="edOncoFechaIngreso" value="${(c.admissionDatetime || '').slice(0, 16)}" style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          </div>
          <div class="form-group">
            <label style="font-size: 11px; font-weight: 700;">Ciclo</label>
            <input type="text" id="edOncoCiclo" value="${c.treatmentCycle || ''}" style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          </div>
        </div>
        <div class="form-group">
          <label style="font-size: 11px; font-weight: 700;">Alergias</label>
          <input type="text" id="edOncoAlergias" value="${c.allergiesNote || 'Sin alergias conocidas'}" style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        </div>

        <div class="form-group">
          <label style="font-size: 12px; font-weight: 700; color: #2F4C8A; text-transform: uppercase; margin-bottom: 8px; display: block;">Signos Vitales y Somatometría</label>
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">Se cargan automáticamente los signos vitales actuales del paciente (solo lectura).</div>
          <div id="edOncoSignosVitalesGrid" class="onco-vitals-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px;"></div>
        </div>

        <div class="form-group">
          <label style="font-size: 12px; font-weight: 700; color: #2F4C8A; text-transform: uppercase; margin-bottom: 8px; display: block;">PEEA (Principio de Evolución y Estado Actual)</label>
          ${richTextEditorHtml('edOncoAnalisis', 'Describa el principio de evolución y el estado actual del paciente...', c.analisis)}
        </div>

        <div class="form-group">
          <label style="font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; display: block;">Tabla de Diagnósticos (Sincronizada con Diagnósticos Previos)</label>
          <div style="width: 100%; overflow-x: auto;">
            <table style="width: 100%; min-width: 480px; border-collapse: collapse; font-size: 12px; margin-bottom: 8px;">
              <thead>
                <tr style="background: var(--bg-main); text-align: left;">
                  <th style="padding: 8px; border: 1px solid var(--border-color);">Código / Diagnóstico</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 22%;">Tipo</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 28%;">Comentario</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 50px; text-align: center;">Acción</th>
                </tr>
              </thead>
              <tbody id="tbodyEdOncoDiagnosticos"></tbody>
            </table>
          </div>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnAddEdOncoDiagRow" style="font-size: 11px; padding: 6px 10px;">+ Agregar Diagnóstico</button>
        </div>

        <div class="form-group">
          <label style="font-size: 12px; font-weight: 700; color: #2F4C8A; text-transform: uppercase; margin-bottom: 8px; display: block;">Notas</label>
          <textarea id="edOncoIndicaciones" rows="3" placeholder="Nota corta..." style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color); font-family: inherit; resize: vertical;">${escapeHtml(htmlToTextareaValue(c.indicaciones))}</textarea>
        </div>
      </form>
    </div>
  `;

  renderOncoLinkedDocuments('edOncoLinkedDocsContainer', c.linkedDocuments);

  const edDiagTbody = document.getElementById('tbodyEdOncoDiagnosticos');
  if (edDiagTbody) {
    edDiagTbody.innerHTML = (c.diagnosticos || []).map(buildEdOncoDiagRowHtml).join('');
    edDiagTbody.querySelectorAll('.onco-diag-codigo').forEach(attachCie11Search);
  }

  document.querySelectorAll('#formEdOncologia select.custom-select').forEach(enhanceCustomSelect);

  const formEdOnco = document.getElementById('formEdOncologia');
  setNoteFormLocked(formEdOnco, true);
  const btnEditEdOnco = document.getElementById('btnEditEdOnco');
  if (btnEditEdOnco) {
    btnEditEdOnco.onclick = () => {
      setNoteFormLocked(formEdOnco, false);
      btnEditEdOnco.style.display = 'none';
      const saveBtn = document.getElementById('btnSaveEdOnco');
      if (saveBtn) saveBtn.style.display = '';
      const discardBtn = document.getElementById('btnDiscardEdOnco');
      if (discardBtn) discardBtn.style.display = '';
    };
  }

  // Signos Vitales Actuales: mismo autocargado del registro más reciente
  // del paciente que ya hace el modal de creación — informativo, de solo
  // lectura, no se guarda como parte de esta nota.
  const patientId = window.clivoraCurrentPatientId;
  const svGrid = document.getElementById('edOncoSignosVitalesGrid');
  if (patientId && svGrid) {
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}/consultations`, { cache: 'no-store' });
      const consultas = response.ok ? await response.json() : [];
      const latestSV = consultas.find(sv => sv.source === 'vitals') || null;
      const svFields = [
        ['PA Sistólica (mmHg)', latestSV?.sistolica],
        ['PA Diastólica (mmHg)', latestSV?.diastolica],
        ['FC (lpm)', latestSV?.fc],
        ['FR (rpm)', latestSV?.fr],
        ['Temp (°C)', latestSV?.temperatura],
        ['Sat O₂ (%)', latestSV?.saturacion],
        ['Peso (kg)', latestSV?.peso],
        ['Altura (cm)', latestSV?.altura],
        ['BSA DuBois (m²)', latestSV?.bsa],
        ['IMC (kg/m²)', latestSV?.imc],
      ];
      svGrid.innerHTML = svFields.map(([label, val]) => `
        <div class="form-group">
          <label style="font-size: 11px;">${label}</label>
          <input type="text" readonly value="${val || '--'}" style="padding: 8px 10px; font-size: 13px; background: var(--bg-card);">
        </div>
      `).join('');
    } catch (error) {
      console.error('Error al cargar signos vitales para editar nota de oncología:', error);
    }
  }

  const btnAddDiagEd = document.getElementById('btnAddEdOncoDiagRow');
  if (btnAddDiagEd) {
    btnAddDiagEd.onclick = () => {
      const tbody = document.getElementById('tbodyEdOncoDiagnosticos');
      if (!tbody) return;
      tbody.insertAdjacentHTML('beforeend', buildEdOncoDiagRowHtml());
      attachCie11Search(tbody.lastElementChild.querySelector('.onco-diag-codigo'));
      enhanceCustomSelect(tbody.lastElementChild.querySelector('select.custom-select'));
    };
  }

  const btnSave = document.getElementById('btnSaveEdOnco');
  if (btnSave) {
    btnSave.onclick = async () => {
      const diagnosticos = [];
      document.querySelectorAll('#tbodyEdOncoDiagnosticos tr').forEach(row => {
        const codigoInput = row.querySelector('.onco-diag-codigo');
        const selectedId = codigoInput?.dataset.selectedId || '';
        const codigo = selectedId ? codigoInput.value.trim() : '';
        const tipo = row.querySelector('.onco-diag-tipo')?.value;
        const comment = row.querySelector('.onco-diag-comment')?.value.trim() || '';
        if (codigo) {
          diagnosticos.push({
            codigo, tipo, comment,
            cie11_diagnosis_id: selectedId ? parseInt(selectedId, 10) : false,
          });
        }
      });
      const payload = {
        admissionDatetime: document.getElementById('edOncoFechaIngreso')?.value || false,
        treatmentCycle: document.getElementById('edOncoCiclo')?.value?.trim() || '',
        allergiesNote: document.getElementById('edOncoAlergias')?.value?.trim() || 'Sin alergias conocidas',
        analisis: richTextValue(document.getElementById('edOncoAnalisis')),
        diagnosticos,
        indicaciones: document.getElementById('edOncoIndicaciones')?.value?.trim() || '',
      };
      try {
        const response = await fetch(`/clivora/api/consultations/oncology/${recordId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudo guardar la nota de oncología médica.'));
          return;
        }
        await loadPatientConsultas(patientId);
        const updated = clivoraPatientConsultas.find(item => item.id === c.id);
        renderOncologyEditCard(updated || c);
        const feedback = document.getElementById('edOncoSaveFeedback');
        if (feedback) feedback.style.display = 'flex';
      } catch (error) {
        console.error('Error al guardar nota de oncología médica:', error);
        showClivoraAlertModal('No se pudo guardar la nota de oncología médica.');
      }
    };
  }

  const btnDiscard = document.getElementById('btnDiscardEdOnco');
  if (btnDiscard) {
    // Antes volvía a la lista completa (renderPatientConsultas), lo que
    // además reseleccionaba la primera nota en vez de quedarse en la que ya
    // se estaba viendo/editando. Al re-renderizar la misma tarjeta con los
    // datos originales (c) se descartan los cambios sin tocados y vuelve a
    // quedar en modo lectura sobre esta misma nota.
    btnDiscard.onclick = () => renderOncologyEditCard(c);
  }

  const btnDownloadEdOnco = document.getElementById('btnDownloadEdOnco');
  if (btnDownloadEdOnco) {
    btnDownloadEdOnco.onclick = () => {
      const patientId = window.clivoraCurrentPatientId;
      if (recordId && patientId) clivoraDownloadPdf(`/clivora/api/patients/${patientId}/consultations/oncology/${recordId}/print`);
    };
  }

  const btnPrintOnco = document.getElementById('btnPrintEdOnco');
  if (btnPrintOnco) {
    // Esta tarjeta solo se pinta para una nota YA guardada (viene de
    // openConsultaCard al hacer clic en una tarjeta de la pestaña Notas), a
    // diferencia de #btnPrintNotaOnco (modal de creación, que sí puede estar
    // vacío) — por eso acá siempre hay un recordId real y se abre
    // directamente el PDF (reporte PDF de nota oncológica), sin
    // fallback a window.print().
    btnPrintOnco.onclick = () => {
      const patientId = window.clivoraCurrentPatientId;
      if (recordId && patientId) {
        window.open(`/clivora/api/patients/${patientId}/consultations/oncology/${recordId}/print`, '_blank');
      } else {
        window.print();
      }
    };
  }
}

// ============================
// Registro Clínico de Enfermería — tarjeta de edición independiente en el
// panel derecho. Mismos ~30 campos/bloques que #modalNotaClinica (Datos
// Generales, Escalas Especializadas, NEWS, Laboratorio, Glasgow, ECOG/
// Karnofsky, Downton, Aparatos y Sistemas, EVA, Prevención de Caídas,
// Medicamentos, Nota+Firmas), con ids propios "edNc*" — nunca comparte el
// nodo del DOM con el modal de creación, así que crear una nota nueva no se
// ve afectado por editar una ya guardada.
// ============================

function edNcRecalcNewsScore() {
  const fc = parseInt(document.getElementById('edNcNewsFC')?.value, 10) || 0;
  const pas = parseInt(document.getElementById('edNcNewsPAS')?.value, 10) || 0;
  const fr = parseInt(document.getElementById('edNcNewsFR')?.value, 10) || 0;
  const temp = parseFloat(document.getElementById('edNcNewsTemp')?.value) || 0;
  const sat = parseInt(document.getElementById('edNcNewsSat')?.value, 10) || 0;
  const cons = document.getElementById('edNcNewsConsciencia')?.value || 'A';

  let score = 0;
  if (fr <= 8 || fr >= 25) score += 3; else if (fr >= 21) score += 2; else if (fr <= 11) score += 1;
  if (sat <= 91) score += 3; else if (sat <= 93) score += 2; else if (sat <= 95) score += 1;
  if (pas <= 90 || pas >= 220) score += 3; else if (pas <= 100) score += 2; else if (pas <= 110) score += 1;
  if (fc <= 40 || fc >= 131) score += 3; else if (fc >= 111) score += 2; else if (fc <= 50 || fc >= 91) score += 1;
  if (temp <= 35.0) score += 3; else if (temp >= 39.1) score += 2; else if (temp <= 36.0 || temp >= 38.1) score += 1;
  if (cons !== 'A') score += 3;

  const badge = document.getElementById('edNcNewsScoreBadge');
  const text = document.getElementById('edNcNewsAccionText');
  if (!badge || !text) return score;

  if (score >= 7) {
    badge.style.background = '#EF4444';
    badge.textContent = `NEWS Score: ${score} (RIESGO ALTO / ROJO)`;
    text.textContent = 'Acción urgente: Evaluación médica inmediata por médico especialista / alerta crítica.';
  } else if (score >= 5) {
    badge.style.background = '#F59E0B';
    badge.textContent = `NEWS Score: ${score} (RIESGO MEDIO / AMARILLO)`;
    text.textContent = 'Acción sugerida: Informar a médico tratante y aumentar frecuencia de monitoreo a cada hora.';
  } else {
    badge.style.background = '#10B981';
    badge.textContent = `NEWS Score: ${score} (BAJO RIESGO / VERDE)`;
    text.textContent = 'Acción sugerida: Continuar monitoreo de rutina cada 4 horas.';
  }
  return score;
}

function edNcUpdateEvaVisual(val) {
  const v = parseInt(val, 10) || 0;
  const display = document.getElementById('edNcEvaValueDisplay');
  if (!display) return;
  let text = '';
  let color = '#10B981';
  if (v === 0) { text = '0 (Sin Dolor)'; color = '#10B981'; }
  else if (v <= 3) { text = `${v} (Dolor Leve)`; color = '#3B82F6'; }
  else if (v <= 6) { text = `${v} (Dolor Moderado)`; color = '#F59E0B'; }
  else if (v <= 8) { text = `${v} (Dolor Intenso)`; color = '#EA580C'; }
  else { text = `${v} (Dolor Insoportable)`; color = '#EF4444'; }
  display.style.color = color;
  display.textContent = text;
}

const EDNC_DOWNTON_CHECKBOX_IDS = [
  'edNcDowntonPreviousFalls', 'edNcDowntonSedatives', 'edNcDowntonDiuretics',
  'edNcDowntonAntihipertensives', 'edNcDowntonAntiparkinsonians', 'edNcDowntonAntidepressants',
  'edNcDowntonDesoriented', 'edNcDowntonVisual', 'edNcDowntonAuditive', 'edNcDowntonLimbs',
  'edNcDowntonSafeWithHelp', 'edNcDowntonUnsafeWithHelp', 'edNcDowntonImpossible',
];

function edNcRecalcDowntonScore() {
  const score = EDNC_DOWNTON_CHECKBOX_IDS.reduce((sum, id) => {
    const el = document.getElementById(id);
    return sum + (el && el.checked ? 1 : 0);
  }, 0);

  const badge = document.getElementById('edNcDowntonScoreBadge');
  if (badge) {
    const isHighRisk = score >= 2;
    badge.style.background = isHighRisk ? '#EF4444' : '#10B981';
    badge.textContent = `Puntaje: ${score} (${isHighRisk ? 'Alto Riesgo' : 'Bajo Riesgo'})`;
  }
  if (score >= 2) {
    const blueBracelet = document.getElementById('edNcFallPreventionBlueBracelet');
    if (blueBracelet) blueBracelet.checked = true;
  }
  return score;
}

const EDNC_DOWNTON_FIELD_MAP = {
  previous_falls_downton: 'edNcDowntonPreviousFalls', sedatives_downton: 'edNcDowntonSedatives',
  diuretics_downton: 'edNcDowntonDiuretics', antihipertensives_downton: 'edNcDowntonAntihipertensives',
  antiparkinsonians_downton: 'edNcDowntonAntiparkinsonians', antidepressants_downton: 'edNcDowntonAntidepressants',
  desoriented_downton: 'edNcDowntonDesoriented', visual_downton: 'edNcDowntonVisual',
  auditive_downton: 'edNcDowntonAuditive', limbs_downton: 'edNcDowntonLimbs',
  safe_with_help_downton: 'edNcDowntonSafeWithHelp', unsafe_with_help_downton: 'edNcDowntonUnsafeWithHelp',
  impossible_downton: 'edNcDowntonImpossible',
};

// BSA (DuBois) / IMC a partir de Peso+Talla — misma fórmula para las 4
// tarjetas de "Índices Calculados Automáticamente" que ya existen en la app
// (Signos Vitales sv*/edit*, y ahora también Registro Clínico de Enfermería
// nc*/edNc*, que antes no los calculaba). Función de nivel superior (no
// dentro de initializePatientsModule) porque renderNursingClinicalEditCard
// también la necesita al precargar una nota ya guardada.
function computeBsaImc(pesoId, alturaId, bsaId, imcId) {
  const peso = parseFloat(document.getElementById(pesoId)?.value);
  const alturaCm = parseFloat(document.getElementById(alturaId)?.value);
  const bsaInput = document.getElementById(bsaId);
  const imcInput = document.getElementById(imcId);
  if (peso > 0 && alturaCm > 0) {
    // BSA DuBois Formula: 0.007184 * (peso ^ 0.425) * (alturaCm ^ 0.725)
    const bsa = 0.007184 * Math.pow(peso, 0.425) * Math.pow(alturaCm, 0.725);
    if (bsaInput) bsaInput.value = bsa.toFixed(2) + ' m²';
    // IMC Formula: peso (kg) / (altura (m) ^ 2)
    const alturaM = alturaCm > 3 ? alturaCm / 100 : alturaCm;
    const imc = peso / (alturaM * alturaM);
    if (imcInput) imcInput.value = imc.toFixed(2) + ' kg/m²';
  } else {
    if (bsaInput) bsaInput.value = '';
    if (imcInput) imcInput.value = '';
  }
}

async function renderNursingClinicalEditCard(c) {
  const card = document.getElementById('consultaDetailCard');
  if (!card) return;
  currentPreviewConsulta = c;
  card.classList.remove('empty-state-container');

  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';
  const activeExp = getActivePatientExp();
  const recordId = parseInt(String(c.id).split('-')[1], 10) || 0;
  const nv = c.newsVitals || {};

  const downtonCheckboxesHtml = Object.entries(EDNC_DOWNTON_FIELD_MAP).map(([key, id], i) => {
    const labels = ['Caídas previas', 'Sedantes', 'Diuréticos', 'Antihipertensivos', 'Antiparkinsonianos',
      'Antidepresivos', 'Desorientado', 'Déficit visual', 'Déficit auditivo', 'Déficit en extremidades',
      'Seguro con ayuda', 'Inseguro con ayuda', 'Imposible'];
    return `<label class="custom-checkbox"><input type="checkbox" id="${id}" ${c[key] ? 'checked' : ''}/><span></span> ${labels[i]}</label>`;
  }).join('');

  card.innerHTML = `
    <div style="width: 100%; text-align: left;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
        <div>
          <span style="font-size: 11px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase; letter-spacing: 0.05em;">EDITAR REGISTRO CLÍNICO DE ENFERMERÍA</span>
          <h2 style="font-size: 22px; font-weight: 800; color: var(--text-main); margin-top: 2px;">Registro Clínico de Enfermería</h2>
          <div style="font-size: 13px; color: var(--primary-blue); font-weight: 800; margin-top: 4px;">Paciente: ${activePatientName} <span style="font-weight: 500; color: var(--text-muted); font-size: 12px;">(Exp: ${activeExp})</span></div>
          ${buildCreatedUpdatedMetaHtml(c.fecha, c.createdBy, c.updatedAt, c.updatedBy, consultaEditableRecord(c))}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDiscardEdNc" style="color: #EF4444; border-color: #FCA5A5; font-size: 12px; padding: 8px 14px; display: none;">Descartar</button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnEditEdNc" style="font-size: 12px; padding: 8px 14px;">Editar</button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnPrintEdNc" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir
          </button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDownloadEdNc" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Descargar PDF
          </button>
          <button type="button" class="btn-primary btn-anim-lift" id="btnSaveEdNc" style="font-size: 12px; padding: 8px 14px; display: none;">Guardar Nota</button>
        </div>
      </div>

      <div id="edNcSaveFeedback" style="display: none; background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; font-weight: 700; margin-bottom: 16px; align-items: center; gap: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Nota actualizada con éxito.
      </div>

      <div id="edNcFieldsWrapper" style="display: flex; flex-direction: column; gap: 16px;">
        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Datos Generales de Ingreso</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
            <div class="familiar-field-group"><label>CICLO</label><input type="text" class="familiar-input" id="edNcCiclo" value="${c.admissionTreatmentCycle || ''}"></div>
            <div class="familiar-field-group"><label>ALERGIAS</label><input type="text" class="familiar-input" id="edNcAlergias" value="${c.admissionAllergiesNote || 'Sin alergias conocidas'}" style="background: #FEF2F2; border-color: #FCA5A5; color: #B91C1C; font-weight: 700;"></div>
            <div class="familiar-field-group"><label>PISO / SUITE</label><input type="text" class="familiar-input" id="edNcPisoSuite" value="${c.admissionFloorSuite || ''}"></div>
            <div class="familiar-field-group">
              <label>AISLAMIENTO</label>
              <select class="familiar-input custom-select" id="edNcAislamiento">
                <option value="ninguno" ${(!c.admissionIsolation || c.admissionIsolation === 'ninguno') ? 'selected' : ''}>Ninguno</option>
                <option value="contacto" ${c.admissionIsolation === 'contacto' ? 'selected' : ''}>Contacto</option>
                <option value="gotas" ${c.admissionIsolation === 'gotas' ? 'selected' : ''}>Gotas</option>
                <option value="aereo" ${c.admissionIsolation === 'aereo' ? 'selected' : ''}>Aéreo</option>
                <option value="protector" ${c.admissionIsolation === 'protector' ? 'selected' : ''}>Protector (Neutropénico)</option>
              </select>
            </div>
            <div class="familiar-field-group"><label>MODALIDAD DE ATENCIÓN</label><input type="text" class="familiar-input" id="edNcModalidadAtencion" value="${c.admissionCareModality || ''}"></div>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Escalas de Valoración Clínica Especializada</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
            <div class="familiar-field-group"><label>Escala de Náuseas (0-5)</label>
              <select class="familiar-input custom-select" id="edNcNauseaScale">
                <option value="0" ${(c.nauseaScale || '0') === '0' ? 'selected' : ''}>0: Sin náuseas</option>
                <option value="1" ${c.nauseaScale === '1' ? 'selected' : ''}>1: Náusea prevista / anticipatoria</option>
                <option value="2" ${c.nauseaScale === '2' ? 'selected' : ''}>2: Leve (Tolera vía oral)</option>
                <option value="3" ${c.nauseaScale === '3' ? 'selected' : ''}>3: Moderada (Ingesta disminuida)</option>
                <option value="4" ${c.nauseaScale === '4' ? 'selected' : ''}>4: Alta (Requiere antieméticos IV)</option>
                <option value="5" ${c.nauseaScale === '5' ? 'selected' : ''}>5: Intensa / Incoercible</option>
              </select>
            </div>
            <div class="familiar-field-group"><label>Escala de Mucositis OMS (0-4)</label>
              <select class="familiar-input custom-select" id="edNcMucositisScale">
                <option value="0" ${(c.mucositisScale || '0') === '0' ? 'selected' : ''}>Grado 0: Ninguna</option>
                <option value="1" ${c.mucositisScale === '1' ? 'selected' : ''}>Grado 1: Eritema / Dolor leve</option>
                <option value="2" ${c.mucositisScale === '2' ? 'selected' : ''}>Grado 2: Úlceras (Tolera sólido)</option>
                <option value="3" ${c.mucositisScale === '3' ? 'selected' : ''}>Grado 3: Úlceras (Tolera solo líquido)</option>
                <option value="4" ${c.mucositisScale === '4' ? 'selected' : ''}>Grado 4: Alimentación imposible IV</option>
              </select>
            </div>
            <div class="familiar-field-group"><label>Escala Funcional / Fatiga (10-2)</label>
              <select class="familiar-input custom-select" id="edNcFunctionalFatigueScale">
                <option value="10" ${(c.functionalFatigueScale || '10') === '10' ? 'selected' : ''}>10: Muy bien / Sin fatiga</option>
                <option value="8" ${c.functionalFatigueScale === '8' ? 'selected' : ''}>8: Fatiga leve con ejercicio</option>
                <option value="6" ${c.functionalFatigueScale === '6' ? 'selected' : ''}>6: Fatiga moderada (Reposo breve)</option>
                <option value="4" ${c.functionalFatigueScale === '4' ? 'selected' : ''}>4: Fatiga severa en cama</option>
                <option value="2" ${c.functionalFatigueScale === '2' ? 'selected' : ''}>2: Fatiga máxima encamado</option>
              </select>
            </div>
            <div class="familiar-field-group"><label>Escala Neutropenia (PMN)</label>
              <select class="familiar-input custom-select" id="edNcNeutropeniaScale">
                <option value="0" ${(c.neutropeniaScale || '0') === '0' ? 'selected' : ''}>Grado 0: &gt; 1500 /mm³ (Normal)</option>
                <option value="1" ${c.neutropeniaScale === '1' ? 'selected' : ''}>Grado 1: 1000 - 1500 /mm³ (Leve)</option>
                <option value="2" ${c.neutropeniaScale === '2' ? 'selected' : ''}>Grado 2: 500 - 999 /mm³ (Moderada)</option>
                <option value="3" ${c.neutropeniaScale === '3' ? 'selected' : ''}>Grado 3: &lt; 500 /mm³ (Severa)</option>
                <option value="4" ${c.neutropeniaScale === '4' ? 'selected' : ''}>Grado 4: Neutropenia Febril / Riesgo Alto</option>
              </select>
            </div>
          </div>
        </div>

        <!-- SIGNOS VITALES — agrupados en un solo contenedor "Signos
             Vitales" igual que en la creación de esta misma nota (ver
             #modalNotaClinica .nc-block-card "Parámetros Hemodinámicos..."
             en paciente-detail.html). TALLA/PESO se movieron aquí desde
             "Datos Generales de Ingreso" (arriba) — mismos ids
             (edNcTalla/edNcPeso), siguen alimentando
             admissionHeightCm/admissionWeightKg igual que antes, y NO se
             repiten por signo vital (a diferencia de PAS/PAD/FC/FR/Temp/
             Sat/Hora, que sí se pueden agregar en
             #edNcExtraVitalSignsContainer). La tarjeta de Alerta Temprana
             (NEWS) queda fuera de este grupo, sin verse afectada. -->
        <div style="border: 1.5px dashed rgba(47, 76, 138, 0.35); background: rgba(47, 76, 138, 0.03); border-radius: var(--radius-lg); padding: 16px; display: flex; flex-direction: column; gap: 16px;">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
            <div style="font-size: 13px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 8px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2F4C8A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Signos Vitales
            </div>
            <div class="familiar-field-group" style="min-width: 160px; margin: 0;">
              <label>Hora de Captura</label>
              <input type="time" class="familiar-input" id="edNcVitalSignsHora" value="${c.vitalSignsCaptureTime || ''}">
            </div>
          </div>

          <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
            <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Parámetros Hemodinámicos y Respiratorios</div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
              <div class="familiar-field-group"><label>Sistólica (mmHg)</label><input type="number" class="familiar-input" id="edNcNewsPAS" value="${nv.pas || ''}"></div>
              <div class="familiar-field-group"><label>Diastólica (mmHg)</label><input type="number" class="familiar-input" id="edNcNewsPAD" value="${nv.pad || ''}"></div>
              <div class="familiar-field-group"><label>Frec. Cardíaca (lpm)</label><input type="number" class="familiar-input" id="edNcNewsFC" value="${nv.fc || ''}"></div>
              <div class="familiar-field-group"><label>Frec. Respiratoria (rpm)</label><input type="number" class="familiar-input" id="edNcNewsFR" value="${nv.fr || ''}"></div>
            </div>
          </div>

          <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
            <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Temperaturas y Somatometría</div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
              <div class="familiar-field-group"><label>Temperatura (°C)</label><input type="number" step="0.1" class="familiar-input" id="edNcNewsTemp" value="${nv.temp || ''}"></div>
              <div class="familiar-field-group"><label>Saturación O₂ (%)</label><input type="number" class="familiar-input" id="edNcNewsSat" value="${nv.sat || ''}"></div>
              <div class="familiar-field-group"><label>Peso (kg)</label><input type="number" step="0.1" class="familiar-input" id="edNcPeso" value="${c.admissionWeightKg || ''}"></div>
              <div class="familiar-field-group"><label>Talla / Altura (cm)</label><input type="number" class="familiar-input" id="edNcTalla" value="${c.admissionHeightCm || ''}"></div>
            </div>
          </div>

          <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
            <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Índices Calculados Automáticamente (Solo Lectura)</div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
              <div class="familiar-field-group">
                <label>Superficie Corporal (BSA DuBois m²)</label>
                <input type="text" id="edNcBSA" readonly placeholder="Calculado automáticamente" class="familiar-input" style="background-color: #F5F6F8 !important; font-weight: 800 !important; color: #2F4C8A !important; border-color: #C9D6EC !important; cursor: not-allowed;">
              </div>
              <div class="familiar-field-group">
                <label>Índice de Masa Corporal (IMC kg/m²)</label>
                <input type="text" id="edNcIMC" readonly placeholder="Calculado automáticamente" class="familiar-input" style="background-color: #F5F6F8 !important; font-weight: 800 !important; color: #2F4C8A !important; border-color: #C9D6EC !important; cursor: not-allowed;">
              </div>
            </div>
          </div>

          <div id="edNcExtraVitalSignsContainer" style="display: flex; flex-direction: column; gap: 12px;">${(c.manualVitalSigns || []).map(v => buildNcVitalSignRowHtml(v)).join('')}</div>
          <button type="button" class="btn-add-repetable" id="btnAddEdNcVitalSign" style="align-self: flex-start; color: var(--text-muted); border-color: var(--border-color);">+ Agregar signo vital</button>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase;">Alerta Temprana (Escala NEWS)</span>
            <div id="edNcNewsScoreBadge" style="background: #10B981; color: white; font-size: 11px; font-weight: 800; padding: 4px 12px; border-radius: 20px;">NEWS Score: 0 (Bajo Riesgo)</div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
            <div class="familiar-field-group"><label>Hora Captura</label><input type="time" class="familiar-input" id="edNcNewsHora" value="${nv.time || ''}"></div>
            <div class="familiar-field-group">
              <label>Estado Consciencia</label>
              <select class="familiar-input custom-select" id="edNcNewsConsciencia">
                <option value="A" ${(nv.consciousness || 'A') === 'A' ? 'selected' : ''}>Alerta (A)</option>
                <option value="V" ${nv.consciousness === 'V' ? 'selected' : ''}>Responde a Voz (V)</option>
                <option value="P" ${nv.consciousness === 'P' ? 'selected' : ''}>Responde a Dolor (P)</option>
                <option value="U" ${nv.consciousness === 'U' ? 'selected' : ''}>Inconsciente (U)</option>
              </select>
            </div>
          </div>
          <div style="margin-top: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px;">
            <span style="font-size: 11px; font-weight: 700;" id="edNcNewsAccionText">Acción sugerida: Continuar monitoreo de rutina cada 4 horas.</span>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Resultados de Laboratorio Recientes</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px;">
            <div class="familiar-field-group"><label>Hemoglobina (g/dL)</label><input type="number" step="0.1" class="familiar-input" id="edNcLabHemoglobin" value="${c.labHemoglobin || ''}"></div>
            <div class="familiar-field-group"><label>Leucocitos (/mm³)</label><input type="number" class="familiar-input" id="edNcLabLeukocytes" value="${c.labLeukocytes || ''}"></div>
            <div class="familiar-field-group"><label>Plaquetas (/mm³)</label><input type="number" class="familiar-input" id="edNcLabPlatelets" value="${c.labPlatelets || ''}"></div>
            <div class="familiar-field-group"><label>Neutrófilos (/mm³)</label><input type="number" class="familiar-input" id="edNcLabNeutrophils" value="${c.labNeutrophils || ''}"></div>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Escala de Glasgow</div>
          <div class="form-grid form-grid-3">
            <div class="form-group"><label>Motora</label><input type="number" id="edNcGlasgowMotor" min="0" max="6" value="${c.glasgowMotor || ''}"></div>
            <div class="form-group"><label>Verbal</label><input type="number" id="edNcGlasgowVerbal" min="0" max="5" value="${c.glasgowVerbal || ''}"></div>
            <div class="form-group"><label>Ocular</label><input type="number" id="edNcGlasgowOcular" min="0" max="4" value="${c.glasgowOcular || ''}"></div>
          </div>
          <div class="form-group"><label style="color: var(--primary-blue);">Resultado total</label><input type="number" id="edNcGlasgowResult" min="3" max="15" value="${c.glasgowResult || ''}" readonly placeholder="Calculado automáticamente" title="Suma de Motora + Verbal + Ocular" style="font-weight: 800; color: var(--primary-blue); background: var(--bg-main);"></div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Escalas de Valoración Funcional (ECOG / Karnofsky)</div>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div class="familiar-field-group">
              <label>Escala ECOG</label>
              <select class="familiar-input custom-select" id="edNcEcogNumber" style="height: auto; padding: 8px 12px; white-space: normal;">${oncoOptionsHtml(ONCO_ECOG_OPTIONS, c.ecogNumber || '0')}</select>
            </div>
            <div class="familiar-field-group">
              <label>Escala Karnofsky</label>
              <select class="familiar-input custom-select" id="edNcKarnofskyNumber" style="height: auto; padding: 8px 12px; white-space: normal;">${oncoOptionsHtml(ONCO_KARNOFSKY_OPTIONS, c.karnofskyNumber || '100')}</select>
            </div>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase;">Escala de Downton (factores de riesgo de caídas)</div>
            <div id="edNcDowntonScoreBadge" style="background: #10B981; color: #FFFFFF; font-size: 11px; font-weight: 800; padding: 4px 12px; border-radius: 20px;">Puntaje: 0 (Bajo Riesgo)</div>
          </div>
          <div style="display: flex; gap: 14px; flex-wrap: wrap;">${downtonCheckboxesHtml}</div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Valoración por Aparatos y Sistemas</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px;">
            <div class="familiar-field-group"><label>Estado de Conciencia</label>
              <select class="familiar-input custom-select" id="edNcSystemsConsciousness">${oncoOptionsHtml(NC_SYSTEMS_CONSCIOUSNESS_OPTIONS, c.systemsConsciousness || 'alerta')}</select>
            </div>
            <div class="familiar-field-group"><label>Estado Anímico</label>
              <select class="familiar-input custom-select" id="edNcSystemsMood">${oncoOptionsHtml(NC_SYSTEMS_MOOD_OPTIONS, c.systemsMood || 'tranquilo')}</select>
            </div>
            <div class="familiar-field-group"><label>Sistema Urinario</label>
              <select class="familiar-input custom-select" id="edNcSystemsUrinary">${oncoOptionsHtml(NC_SYSTEMS_URINARY_OPTIONS, c.systemsUrinary || 'espontaneo')}</select>
            </div>
            <div class="familiar-field-group"><label>Gastrointestinal</label>
              <select class="familiar-input custom-select" id="edNcSystemsGastrointestinal">${oncoOptionsHtml(NC_SYSTEMS_GASTROINTESTINAL_OPTIONS, c.systemsGastrointestinal || 'normal')}</select>
            </div>
            <div class="familiar-field-group"><label>Cardiorespiratorio</label>
              <select class="familiar-input custom-select" id="edNcSystemsCardiorespiratory">${oncoOptionsHtml(NC_SYSTEMS_CARDIORESPIRATORY_OPTIONS, c.systemsCardiorespiratory || 'normal')}</select>
            </div>
            <div class="familiar-field-group"><label>Piel y Anexos</label>
              <select class="familiar-input custom-select" id="edNcSystemsSkin">${oncoOptionsHtml(NC_SYSTEMS_SKIN_OPTIONS, c.systemsSkin || 'integra')}</select>
            </div>
          </div>
          <div style="margin-top: 10px;">${richTextEditorHtml('edNcSystemsObservations', 'Observaciones detalladas de aparatos y sistemas...', c.systemsObservations)}</div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Valoración y Seguimiento del Dolor (Escala EVA)</div>
          <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; text-align: center; margin-bottom: 12px;">
            <div style="font-size: 12px; font-weight: 800; margin-bottom: 8px;">Nivel de Dolor Actual: <span id="edNcEvaValueDisplay" style="color: #10B981; font-size: 16px;">${c.painScale || 0} (Sin Dolor)</span></div>
            <div style="display: flex; align-items: center; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <span style="font-size: 11px; font-weight: 700;">0</span>
              <input type="range" id="edNcEvaRangeInput" min="0" max="10" value="${c.painScale || 0}" style="width: 60%; max-width: 320px; accent-color: #2F4C8A; cursor: pointer;">
              <span style="font-size: 11px; font-weight: 700;">10</span>
            </div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
            <div class="familiar-field-group"><label>Características</label>
              <select class="familiar-input custom-select" id="edNcEvaCharacteristics">
                <option value="sin_dolor" ${(c.evaCharacteristics || 'sin_dolor') === 'sin_dolor' ? 'selected' : ''}>Sin dolor</option>
                <option value="colico" ${c.evaCharacteristics === 'colico' ? 'selected' : ''}>Cólico</option>
                <option value="quemante" ${c.evaCharacteristics === 'quemante' ? 'selected' : ''}>Quemante / Urente</option>
                <option value="opresivo" ${c.evaCharacteristics === 'opresivo' ? 'selected' : ''}>Opresivo</option>
                <option value="punzante" ${c.evaCharacteristics === 'punzante' ? 'selected' : ''}>Punzante</option>
                <option value="sordo" ${c.evaCharacteristics === 'sordo' ? 'selected' : ''}>Sordo / Sostenido</option>
              </select>
            </div>
            <div class="familiar-field-group"><label>Localización</label><input type="text" class="familiar-input" id="edNcEvaLocation" value="${c.evaLocation || ''}"></div>
            <div class="familiar-field-group"><label>Intervención</label><input type="text" class="familiar-input" id="edNcEvaIntervention" value="${c.evaIntervention || ''}"></div>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Medidas de Prevención de Caídas Aplicadas</div>
          <div style="display: flex; gap: 16px; flex-wrap: wrap;">
            <label class="custom-checkbox"><input type="checkbox" id="edNcFallPreventionSideRails" ${c.fallPreventionSideRails ? 'checked' : ''}/><span></span> Barandales elevados</label>
            <label class="custom-checkbox"><input type="checkbox" id="edNcFallPreventionBrake" ${c.fallPreventionBrake ? 'checked' : ''}/><span></span> Freno de sillón/cama colocado</label>
            <label class="custom-checkbox"><input type="checkbox" id="edNcFallPreventionBlueBracelet" ${c.fallPreventionBlueBracelet ? 'checked' : ''}/><span></span> Brazalete Azul (Alto Riesgo)</label>
            <label class="custom-checkbox"><input type="checkbox" id="edNcFallPreventionBell" ${c.fallPreventionBell ? 'checked' : ''}/><span></span> Timbre al alcance</label>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Administración y Entrega de Medicamentos</div>
          <div style="overflow-x: auto; width: 100%; margin-bottom: 10px;">
            <table style="width: 100%; min-width: 520px; border-collapse: collapse; font-size: 11px;">
              <thead>
                <tr style="background: var(--bg-card); text-align: left;">
                  <th style="padding: 8px; border: 1px solid var(--border-color);">Medicamento / Solución</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 15%;">Dosis</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 15%;">Vía</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 12%;">Hora</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 20%;">Doble Verificación</th>
                  <th style="padding: 8px; border: 1px solid var(--border-color); width: 6%;"></th>
                </tr>
              </thead>
              <tbody id="edNcMedicationsTableBody">${(c.appliedMedications || []).length ? c.appliedMedications.map(m => buildNcMedicationRowHtml(m)).join('') : buildNcMedicationRowHtml()}</tbody>
            </table>
          </div>
          <button type="button" class="btn-add-repetable" id="btnAddEdNcMedicationRow" style="color: var(--text-muted); border-color: var(--border-color);">+ Agregar medicamento</button>
          <div style="margin-top: 12px;">
            <label style="font-size: 11px; font-weight: 800; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 6px;">Medicamentos Entregados al Paciente al Egreso</label>
            <div id="edNcDischargeMedicationsContainer" style="display: flex; flex-direction: column; gap: 8px;">
              ${(c.dischargeMedicationsNote ? c.dischargeMedicationsNote.split('\n') : ['']).map(buildNcDischargeMedicationRowHtml).join('')}
            </div>
            <button type="button" class="btn-add-repetable" id="btnAddEdNcDischargeMedication" style="color: var(--text-muted); border-color: var(--border-color); margin-top: 8px;">+ Agregar medicamento</button>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Nota Evolutiva de Enfermería</div>
          ${richTextEditorHtml('edNcNursingReport', '', c.comentarios)}
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-color);">
            <div class="familiar-field-group"><label>Enfermera Responsable 1</label><input type="text" class="familiar-input" id="edNcNurseResponsible1" value="${c.nurseResponsible1 || ''}"></div>
            <div class="familiar-field-group"><label>Enfermera Responsable 2</label><input type="text" class="familiar-input" id="edNcNurseResponsible2" value="${c.nurseResponsible2 || ''}"></div>
            <div class="familiar-field-group"><label>Hora de Egreso Ambulatorio</label><input type="time" class="familiar-input" id="edNcDischargeTime" value="${c.dischargeTime || ''}"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  card.querySelectorAll('select.custom-select').forEach(enhanceCustomSelect);
  edNcRecalcNewsScore();
  edNcRecalcDowntonScore();
  edNcUpdateEvaVisual(c.painScale || 0);
  // BSA/IMC ya con el Peso/Talla que trae la nota guardada (computeBsaImc,
  // ver el listener 'input' de ncPeso/ncTalla — aquí se llama a mano una vez
  // porque .value se puso por HTML, no por un evento 'input' real).
  computeBsaImc('edNcPeso', 'edNcTalla', 'edNcBSA', 'edNcIMC');

  card.querySelectorAll('#edNcNewsFC, #edNcNewsPAS, #edNcNewsFR, #edNcNewsTemp, #edNcNewsSat, #edNcNewsConsciencia').forEach(el => {
    el.addEventListener('input', edNcRecalcNewsScore);
    el.addEventListener('change', edNcRecalcNewsScore);
  });
  EDNC_DOWNTON_CHECKBOX_IDS.forEach(id => {
    document.getElementById(id)?.addEventListener('change', edNcRecalcDowntonScore);
  });
  document.getElementById('edNcEvaRangeInput')?.addEventListener('input', (e) => edNcUpdateEvaVisual(e.target.value));

  const btnAddMedRow = document.getElementById('btnAddEdNcMedicationRow');
  if (btnAddMedRow) {
    btnAddMedRow.onclick = (e) => {
      e.preventDefault();
      document.getElementById('edNcMedicationsTableBody')?.insertAdjacentHTML('beforeend', buildNcMedicationRowHtml());
    };
  }
  const btnAddVitalSign = document.getElementById('btnAddEdNcVitalSign');
  if (btnAddVitalSign) {
    btnAddVitalSign.onclick = (e) => {
      e.preventDefault();
      document.getElementById('edNcExtraVitalSignsContainer')?.insertAdjacentHTML('beforeend', buildNcVitalSignRowHtml(nextNcVitalSignDefaults('edNcExtraVitalSignsContainer')));
    };
  }
  const btnAddDischargeMed = document.getElementById('btnAddEdNcDischargeMedication');
  if (btnAddDischargeMed) {
    btnAddDischargeMed.onclick = (e) => {
      e.preventDefault();
      document.getElementById('edNcDischargeMedicationsContainer')?.insertAdjacentHTML('beforeend', buildNcDischargeMedicationRowHtml(''));
    };
  }

  const edNcFieldsWrapper = document.getElementById('edNcFieldsWrapper');
  setNoteFormLocked(edNcFieldsWrapper, true);
  const btnDownloadEdNc = document.getElementById('btnDownloadEdNc');
  if (btnDownloadEdNc) {
    btnDownloadEdNc.onclick = () => {
      const patientId = window.clivoraCurrentPatientId;
      if (recordId && patientId) clivoraDownloadPdf(`/clivora/api/patients/${patientId}/nursing_notes/${recordId}/clinical_print`);
    };
  }

  const btnPrintEdNc = document.getElementById('btnPrintEdNc');
  if (btnPrintEdNc) {
    btnPrintEdNc.onclick = () => {
      const patientId = window.clivoraCurrentPatientId;
      if (recordId && patientId) {
        window.open(`/clivora/api/patients/${patientId}/nursing_notes/${recordId}/clinical_print`, '_blank');
      } else {
        window.print();
      }
    };
  }
  const btnEditEdNc = document.getElementById('btnEditEdNc');
  if (btnEditEdNc) {
    btnEditEdNc.onclick = () => {
      setNoteFormLocked(edNcFieldsWrapper, false);
      btnEditEdNc.style.display = 'none';
      const saveBtn = document.getElementById('btnSaveEdNc');
      if (saveBtn) saveBtn.style.display = '';
      const discardBtn = document.getElementById('btnDiscardEdNc');
      if (discardBtn) discardBtn.style.display = '';
    };
  }

  const btnSave = document.getElementById('btnSaveEdNc');
  if (btnSave) {
    btnSave.onclick = async () => {
      const patientId = window.clivoraCurrentPatientId;
      const chk = (id) => document.getElementById(id)?.checked || false;
      const payload = {
        nursingNoteKind: 'clinical_record',
        admissionWeightKg: parseFloat(document.getElementById('edNcPeso')?.value) || 0,
        admissionHeightCm: parseFloat(document.getElementById('edNcTalla')?.value) || 0,
        admissionTreatmentCycle: document.getElementById('edNcCiclo')?.value.trim() || '',
        admissionAllergiesNote: document.getElementById('edNcAlergias')?.value.trim() || 'Sin alergias conocidas',
        admissionFloorSuite: document.getElementById('edNcPisoSuite')?.value.trim() || '',
        admissionIsolation: document.getElementById('edNcAislamiento')?.value || 'ninguno',
        admissionCareModality: document.getElementById('edNcModalidadAtencion')?.value.trim() || '',
        painScale: document.getElementById('edNcEvaRangeInput')?.value || 0,
        downtonScore: edNcRecalcDowntonScore(),
        ecogNumber: document.getElementById('edNcEcogNumber')?.value || 0,
        karnofskyNumber: document.getElementById('edNcKarnofskyNumber')?.value || 0,
        glasgowMotor: document.getElementById('edNcGlasgowMotor')?.value || 0,
        glasgowVerbal: document.getElementById('edNcGlasgowVerbal')?.value || 0,
        glasgowOcular: document.getElementById('edNcGlasgowOcular')?.value || 0,
        glasgowResult: document.getElementById('edNcGlasgowResult')?.value || 0,
        comentarios: getEditableFieldValue(document.getElementById('edNcNursingReport')),
        nauseaScale: document.getElementById('edNcNauseaScale')?.value || '0',
        mucositisScale: document.getElementById('edNcMucositisScale')?.value || '0',
        functionalFatigueScale: document.getElementById('edNcFunctionalFatigueScale')?.value || '10',
        neutropeniaScale: document.getElementById('edNcNeutropeniaScale')?.value || '0',
        labHemoglobin: parseFloat(document.getElementById('edNcLabHemoglobin')?.value) || 0,
        labLeukocytes: parseInt(document.getElementById('edNcLabLeukocytes')?.value, 10) || 0,
        labPlatelets: parseInt(document.getElementById('edNcLabPlatelets')?.value, 10) || 0,
        labNeutrophils: parseInt(document.getElementById('edNcLabNeutrophils')?.value, 10) || 0,
        systemsConsciousness: document.getElementById('edNcSystemsConsciousness')?.value || 'alerta',
        systemsMood: document.getElementById('edNcSystemsMood')?.value || 'tranquilo',
        systemsUrinary: document.getElementById('edNcSystemsUrinary')?.value || 'espontaneo',
        systemsGastrointestinal: document.getElementById('edNcSystemsGastrointestinal')?.value || 'normal',
        systemsCardiorespiratory: document.getElementById('edNcSystemsCardiorespiratory')?.value || 'normal',
        systemsSkin: document.getElementById('edNcSystemsSkin')?.value || 'integra',
        systemsObservations: getEditableFieldValue(document.getElementById('edNcSystemsObservations')),
        evaPainLevel: parseInt(document.getElementById('edNcEvaRangeInput')?.value, 10) || 0,
        evaCharacteristics: document.getElementById('edNcEvaCharacteristics')?.value || 'sin_dolor',
        evaLocation: document.getElementById('edNcEvaLocation')?.value.trim() || '',
        evaIntervention: document.getElementById('edNcEvaIntervention')?.value.trim() || '',
        fallPreventionSideRails: chk('edNcFallPreventionSideRails'),
        fallPreventionBrake: chk('edNcFallPreventionBrake'),
        fallPreventionBlueBracelet: chk('edNcFallPreventionBlueBracelet'),
        fallPreventionBell: chk('edNcFallPreventionBell'),
        dischargeMedicationsNote: collectNcDischargeMedications('edNcDischargeMedicationsContainer'),
        nurseResponsible1: document.getElementById('edNcNurseResponsible1')?.value.trim() || '',
        nurseResponsible2: document.getElementById('edNcNurseResponsible2')?.value.trim() || '',
        dischargeTime: document.getElementById('edNcDischargeTime')?.value || '',
        newsVitals: {
          time: document.getElementById('edNcNewsHora')?.value || '',
          fc: document.getElementById('edNcNewsFC')?.value || 0,
          pas: document.getElementById('edNcNewsPAS')?.value || 0,
          pad: document.getElementById('edNcNewsPAD')?.value || 0,
          fr: document.getElementById('edNcNewsFR')?.value || 0,
          temp: document.getElementById('edNcNewsTemp')?.value || 0,
          sat: document.getElementById('edNcNewsSat')?.value || 0,
          consciousness: document.getElementById('edNcNewsConsciencia')?.value || 'A',
          newsScore: edNcRecalcNewsScore(),
        },
        vitalSignsCaptureTime: document.getElementById('edNcVitalSignsHora')?.value || '',
        manualVitalSigns: Array.from(document.querySelectorAll('#edNcExtraVitalSignsContainer .nc-vital-sign-row')).map(row => ({
          id: row.dataset.recordId ? parseInt(row.dataset.recordId, 10) : undefined,
          hora: row.querySelector('.nc-vs-hora')?.value || '',
          pas: row.querySelector('.nc-vs-pas')?.value || 0,
          pad: row.querySelector('.nc-vs-pad')?.value || 0,
          fc: row.querySelector('.nc-vs-fc')?.value || 0,
          fr: row.querySelector('.nc-vs-fr')?.value || 0,
          temp: row.querySelector('.nc-vs-temp')?.value || 0,
          sat: row.querySelector('.nc-vs-sat')?.value || 0,
          peso: row.querySelector('.nc-vs-peso')?.value || 0,
          talla: row.querySelector('.nc-vs-talla')?.value || 0,
        })),
        appliedMedications: Array.from(document.querySelectorAll('#edNcMedicationsTableBody .nc-medication-row')).map(row => ({
          id: row.dataset.recordId ? parseInt(row.dataset.recordId, 10) : undefined,
          medicationName: row.querySelector('.nc-med-name')?.value.trim() || '',
          doseText: row.querySelector('.nc-med-dose')?.value.trim() || '',
          route: row.querySelector('.nc-med-route')?.value.trim() || '',
          time: row.querySelector('.nc-med-time')?.value || '',
          doubleCheckVerification1: row.querySelector('.nc-med-doublecheck-1')?.value.trim() || '',
          doubleCheckVerification2: row.querySelector('.nc-med-doublecheck-2')?.value.trim() || '',
        })).filter(m => m.medicationName),
      };
      Object.entries(EDNC_DOWNTON_FIELD_MAP).forEach(([key, id]) => { payload[key] = chk(id); });

      try {
        const response = await fetch(`/clivora/api/consultations/nursing/${recordId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error('save failed');
        await loadPatientConsultas(patientId);
        const updated = clivoraPatientConsultas.find(item => item.id === c.id);
        renderNursingClinicalEditCard(updated || c);
        const feedback = document.getElementById('edNcSaveFeedback');
        if (feedback) feedback.style.display = 'flex';
      } catch (error) {
        console.error('Error al guardar registro clínico de enfermería:', error);
        showClivoraAlertModal('No se pudo guardar el registro clínico de enfermería.');
      }
    };
  }

  const btnDiscard = document.getElementById('btnDiscardEdNc');
  if (btnDiscard) {
    btnDiscard.onclick = () => renderNursingClinicalEditCard(c);
  }
}

// ============================
// Evaluación Inicial de Enfermería — tarjeta de edición independiente en el
// panel derecho. Reutiliza el catálogo de preguntas Marjory Gordon
// (fetchNursingAssessmentQuestions/groupAssessmentQuestionsByPattern, sin
// tocarlos) pero con su propio builder de filas/acordeón ("edEi*" en vez de
// "ei*" para el name del radio y el id del cuerpo del acordeón) para que
// nunca comparta grupos de radio ni ids con el modal de creación — las
// clases sí se reutilizan tal cual (.ei-pattern-header, .ei-quick-btn,
// .ei-answer-detail, etc.) porque sus listeners ya están delegados a nivel
// document por clase, no por id, así que funcionan solos.
// ============================

function edEiBuildQuestionRowHtml(item, index, existingAnswer) {
  const name = `edEiAnswer${index}`;
  const answer = existingAnswer?.answer || 'no';
  const detail = existingAnswer?.detail || '';
  return `
    <div class="familiar-form-card ei-question-card" data-pattern="${item.pattern.replace(/"/g, '&quot;')}" data-question="${item.question.replace(/"/g, '&quot;')}" style="padding: 12px 14px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card);">
      <div style="font-size: 13px; font-weight: 700; color: var(--text-main); margin-bottom: 8px;">${item.question}</div>
      <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 8px;">
        <label class="custom-radio"><input type="radio" name="${name}" value="si" ${answer === 'si' ? 'checked' : ''}><span></span> Sí</label>
        <label class="custom-radio"><input type="radio" name="${name}" value="no" ${answer === 'no' ? 'checked' : ''}><span></span> No</label>
        <label class="custom-radio"><input type="radio" name="${name}" value="na" ${answer === 'na' ? 'checked' : ''}><span></span> N/A</label>
      </div>
      <input type="text" class="familiar-input ei-answer-detail" placeholder="Especificar / detalle..." style="width: 100%;" value="${String(detail).replace(/"/g, '&quot;')}">
    </div>`;
}

function edEiBuildPatternAccordionHtml(pattern, items, offsetIndex, patternIndex, answersByKey) {
  const bodyId = `edEiPatternBody${patternIndex}`;
  const rowsHtml = items
    .map((item, i) => edEiBuildQuestionRowHtml(item, offsetIndex + i, answersByKey.get(`${item.pattern}|${item.question}`)))
    .join('');
  return `
    <div class="ei-pattern-accordion" data-pattern-index="${patternIndex}" style="border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden;">
      <div class="ei-pattern-header" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--bg-main); cursor: pointer;">
        <span style="font-size: 12.5px; font-weight: 800; color: #2F4C8A;">${patternIndex + 1}. ${pattern}</span>
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="ei-quick-select" data-target="${bodyId}" style="display: flex; align-items: center; gap: 4px; font-size: 10px;">
            <span style="color: var(--text-muted); font-weight: 700; margin-right: 2px;">Selección rápida:</span>
            <button type="button" class="btn-secondary btn-anim-lift ei-quick-btn" data-value="si" style="padding: 2px 8px; font-size: 10px;">Sí</button>
            <button type="button" class="btn-secondary btn-anim-lift ei-quick-btn" data-value="no" style="padding: 2px 8px; font-size: 10px;">No</button>
            <button type="button" class="btn-secondary btn-anim-lift ei-quick-btn" data-value="na" style="padding: 2px 8px; font-size: 10px;">N/A</button>
          </div>
          <svg class="ei-pattern-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.2s;"><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </div>
      <div class="ei-pattern-body" id="${bodyId}" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; padding: 14px;">
        ${rowsHtml}
      </div>
    </div>`;
}

async function renderNursingAssessmentEditCard(c) {
  const card = document.getElementById('consultaDetailCard');
  if (!card) return;
  currentPreviewConsulta = c;
  card.classList.remove('empty-state-container');

  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';
  const activeExp = getActivePatientExp();
  const recordId = parseInt(String(c.id).split('-')[1], 10) || 0;

  const questions = await fetchNursingAssessmentQuestions();
  const groups = groupAssessmentQuestionsByPattern(questions);
  const answersByKey = new Map((c.assessmentAnswers || []).map(a => [`${a.pattern}|${a.question}`, a]));
  let offset = 0;
  const accordionHtml = groups.map((group, patternIndex) => {
    const html = edEiBuildPatternAccordionHtml(group.pattern, group.items, offset, patternIndex, answersByKey);
    offset += group.items.length;
    return html;
  }).join('');

  card.innerHTML = `
    <div style="width: 100%; text-align: left;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
        <div>
          <span style="font-size: 11px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase; letter-spacing: 0.05em;">EDITAR EVALUACIÓN INICIAL DE ENFERMERÍA</span>
          <h2 style="font-size: 22px; font-weight: 800; color: var(--text-main); margin-top: 2px;">Evaluación Inicial de Enfermería</h2>
          <div style="font-size: 13px; color: var(--primary-blue); font-weight: 800; margin-top: 4px;">Paciente: ${activePatientName} <span style="font-weight: 500; color: var(--text-muted); font-size: 12px;">(Exp: ${activeExp})</span></div>
          ${buildCreatedUpdatedMetaHtml(c.fecha, c.createdBy, c.updatedAt, c.updatedBy, consultaEditableRecord(c))}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDiscardEdEi" style="color: #EF4444; border-color: #FCA5A5; font-size: 12px; padding: 8px 14px; display: none;">Descartar</button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnEditEdEi" style="font-size: 12px; padding: 8px 14px;">Editar</button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnPrintEdEi" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir
          </button>
          <button type="button" class="btn-secondary btn-anim-lift" id="btnDownloadEdEi" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Descargar PDF
          </button>
          <button type="button" class="btn-primary btn-anim-lift" id="btnSaveEdEi" style="font-size: 12px; padding: 8px 14px; display: none;">Guardar Nota</button>
        </div>
      </div>

      <div id="edEiSaveFeedback" style="display: none; background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; font-weight: 700; margin-bottom: 16px; align-items: center; gap: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Nota actualizada con éxito.
      </div>

      <div id="edEiFieldsWrapper" style="display: flex; flex-direction: column; gap: 16px;">
        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Datos de Ingreso</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
            <div class="familiar-field-group"><label>TALLA (cm)</label><input type="number" class="familiar-input" id="edEiTalla" value="${c.admissionHeightCm || ''}"></div>
            <div class="familiar-field-group"><label>PESO (kg)</label><input type="number" step="0.1" class="familiar-input" id="edEiPeso" value="${c.admissionWeightKg || ''}"></div>
            <div class="familiar-field-group"><label>CICLO</label><input type="text" class="familiar-input" id="edEiCiclo" value="${c.admissionTreatmentCycle || ''}"></div>
            <div class="familiar-field-group"><label>ALERGIAS</label><input type="text" class="familiar-input" id="edEiAlergias" value="${c.admissionAllergiesNote || 'Sin alergias conocidas'}" style="background: #FEF2F2; border-color: #FCA5A5; color: #B91C1C; font-weight: 700;"></div>
            <div class="familiar-field-group"><label>PISO / SUITE</label><input type="text" class="familiar-input" id="edEiPisoSuite" value="${c.admissionFloorSuite || ''}"></div>
            <div class="familiar-field-group">
              <label>AISLAMIENTO</label>
              <select class="familiar-input custom-select" id="edEiAislamiento">
                <option value="ninguno" ${(!c.admissionIsolation || c.admissionIsolation === 'ninguno') ? 'selected' : ''}>Ninguno</option>
                <option value="contacto" ${c.admissionIsolation === 'contacto' ? 'selected' : ''}>Contacto</option>
                <option value="gotas" ${c.admissionIsolation === 'gotas' ? 'selected' : ''}>Gotas</option>
                <option value="aereo" ${c.admissionIsolation === 'aereo' ? 'selected' : ''}>Aéreo</option>
                <option value="protector" ${c.admissionIsolation === 'protector' ? 'selected' : ''}>Protector (Neutropénico)</option>
              </select>
            </div>
            <div class="familiar-field-group"><label>MODALIDAD DE ATENCIÓN</label><input type="text" class="familiar-input" id="edEiModalidadAtencion" value="${c.admissionCareModality || ''}"></div>
          </div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Valoración por Patrones Funcionales de Salud (Marjory Gordon)</div>
          <div style="display: flex; flex-direction: column; gap: 10px;">${accordionHtml}</div>
        </div>

        <div class="nc-block-card" style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
          <div style="font-size: 11px; font-weight: 800; color: #2F4C8A; text-transform: uppercase; margin-bottom: 12px;">Notas Generales de Ingreso</div>
          ${richTextEditorHtml('edEiNursingReport', '', c.comentarios)}
        </div>
      </div>
    </div>
  `;

  card.querySelectorAll('select.custom-select').forEach(enhanceCustomSelect);

  const edEiFieldsWrapper = document.getElementById('edEiFieldsWrapper');
  setNoteFormLocked(edEiFieldsWrapper, true);
  const btnEditEdEi = document.getElementById('btnEditEdEi');
  if (btnEditEdEi) {
    btnEditEdEi.onclick = () => {
      setNoteFormLocked(edEiFieldsWrapper, false);
      btnEditEdEi.style.display = 'none';
      const saveBtn = document.getElementById('btnSaveEdEi');
      if (saveBtn) saveBtn.style.display = '';
      const discardBtn = document.getElementById('btnDiscardEdEi');
      if (discardBtn) discardBtn.style.display = '';
    };
  }

  const btnSave = document.getElementById('btnSaveEdEi');
  if (btnSave) {
    btnSave.onclick = async () => {
      const patientId = window.clivoraCurrentPatientId;
      const assessmentAnswers = Array.from(card.querySelectorAll('.familiar-form-card.ei-question-card')).map(cardEl => {
        const checked = cardEl.querySelector('input[type="radio"]:checked');
        return {
          pattern: cardEl.dataset.pattern || '',
          question: cardEl.dataset.question || '',
          answer: checked ? checked.value : 'no',
          detail: cardEl.querySelector('.ei-answer-detail')?.value.trim() || '',
        };
      });
      const payload = {
        nursingNoteKind: 'initial_assessment',
        comentarios: getEditableFieldValue(document.getElementById('edEiNursingReport')),
        assessmentAnswers,
        admissionWeightKg: parseFloat(document.getElementById('edEiPeso')?.value) || 0,
        admissionHeightCm: parseFloat(document.getElementById('edEiTalla')?.value) || 0,
        admissionTreatmentCycle: document.getElementById('edEiCiclo')?.value.trim() || '',
        admissionAllergiesNote: document.getElementById('edEiAlergias')?.value.trim() || 'Sin alergias conocidas',
        admissionFloorSuite: document.getElementById('edEiPisoSuite')?.value.trim() || '',
        admissionIsolation: document.getElementById('edEiAislamiento')?.value || 'ninguno',
        admissionCareModality: document.getElementById('edEiModalidadAtencion')?.value.trim() || '',
      };
      try {
        const response = await fetch(`/clivora/api/consultations/nursing/${recordId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error('save failed');
        await loadPatientConsultas(patientId);
        const updated = clivoraPatientConsultas.find(item => item.id === c.id);
        renderNursingAssessmentEditCard(updated || c);
        const feedback = document.getElementById('edEiSaveFeedback');
        if (feedback) feedback.style.display = 'flex';
      } catch (error) {
        console.error('Error al guardar Evaluación Inicial de Enfermería:', error);
        showClivoraAlertModal('No se pudo guardar la Evaluación Inicial de Enfermería.');
      }
    };
  }

  const btnDiscardEi = document.getElementById('btnDiscardEdEi');
  if (btnDiscardEi) {
    btnDiscardEi.onclick = () => renderNursingAssessmentEditCard(c);
  }

  const btnDownloadEdEi = document.getElementById('btnDownloadEdEi');
  if (btnDownloadEdEi) {
    btnDownloadEdEi.onclick = () => {
      const patientId = window.clivoraCurrentPatientId;
      if (recordId && patientId) clivoraDownloadPdf(`/clivora/api/patients/${patientId}/nursing_notes/${recordId}/print`);
    };
  }

  const btnPrintEi = document.getElementById('btnPrintEdEi');
  if (btnPrintEi) {
    btnPrintEi.onclick = () => {
      const patientId = window.clivoraCurrentPatientId;
      if (recordId && patientId) {
        window.open(`/clivora/api/patients/${patientId}/nursing_notes/${recordId}/print`, '_blank');
      } else {
        window.print();
      }
    };
  }
}

// Nutrición/Psicología/Procedimientos Ambulatorios/Hospitalización-Egreso/
// Nefrología/Cuidados Paliativos — antes caían todas en la rama genérica de
// showConsultaPreview que solo mostraba/editaba un único campo "comentarios".
// Cada wizard de creación (paciente-detail.html, bloques data-note-type=
// "Nota de ...") sí captura estos campos y el backend ya los guarda — solo
// faltaba reflejarlos aquí. Una sola tabla de config (en vez de 6 ramas
// casi idénticas) basta porque son formularios cortos de campos simples,
// a diferencia de Enfermería/Oncología que sí necesitaron su propio layout.
const SIMPLE_NOTE_CONFIGS = {
  nutrition: {
    endpoint: 'nutrition',
    fields: [
      { key: 'comentarios', label: 'Motivo de Consulta', type: 'textarea' },
      { key: 'doesExercise', label: '¿Realiza ejercicio?', type: 'checkbox' },
      { key: 'exercisePerWeek', label: 'Veces por semana', type: 'number' },
      { key: 'diet', label: 'Dieta', type: 'textarea' },
      { key: 'supplements', label: 'Suplementos', type: 'textarea' },
    ],
  },
  psychology: {
    endpoint: 'psychology',
    fields: [
      { key: 'primaryCarer', label: 'Cuidador Primario', type: 'text' },
      { key: 'hasEmotionalSupport', label: '¿Tiene apoyo emocional?', type: 'checkbox' },
      { key: 'calm', label: 'Tranquilo', type: 'checkbox' },
      { key: 'anxious', label: 'Ansioso', type: 'checkbox' },
      { key: 'sad', label: 'Triste', type: 'checkbox' },
      { key: 'irritable', label: 'Irritable', type: 'checkbox' },
      { key: 'psychEvalPain', label: 'Evaluación (dolor/preocupaciones)', type: 'textarea' },
      { key: 'comentarios', label: 'Observaciones del Equipo', type: 'textarea' },
    ],
  },
  ambulatory: {
    endpoint: 'ambulatory',
    fields: [
      { key: 'procedureDate', label: 'Fecha del Procedimiento', type: 'date' },
      { key: 'procedureName', label: 'Nombre del Procedimiento', type: 'text' },
      { key: 'procedureIndications', label: 'Indicaciones', type: 'textarea' },
      { key: 'comentarios', label: 'Descripción', type: 'textarea' },
      { key: 'patientTolerance', label: 'Tolerancia del Paciente', type: 'textarea' },
    ],
  },
  discharge: {
    endpoint: 'discharge',
    fields: [
      { key: 'dischargeDate', label: 'Fecha de Egreso', type: 'date' },
      { key: 'hospital', label: 'Hospital', type: 'text' },
      { key: 'hospitalRoom', label: 'Habitación', type: 'text' },
      { key: 'admissionDiagnosis', label: 'Diagnóstico de Admisión', type: 'text' },
      { key: 'dischargeDiagnosis', label: 'Diagnóstico de Egreso', type: 'text' },
      { key: 'comentarios', label: 'Resumen Clínico', type: 'textarea' },
      { key: 'specificRecommendations', label: 'Recomendaciones Específicas', type: 'textarea' },
    ],
  },
  nephrology: {
    endpoint: 'nephrology',
    fields: [
      { key: 'tfge', label: 'TFGE', type: 'number' },
      { key: 'proteinuria', label: 'Proteinuria', type: 'number' },
      { key: 'proteinuriaTotal', label: 'Proteinuria Total', type: 'number' },
      { key: 'albumin', label: 'Albúmina', type: 'number' },
      { key: 'urineRatio', label: 'Ratio Albúmina/Creatinina en Orina', type: 'number' },
      { key: 'comentarios', label: 'Observaciones', type: 'textarea' },
    ],
  },
  paliative: {
    endpoint: 'paliative',
    fields: [
      { key: 'edmontonPain', label: 'Dolor (Edmonton 0-10)', type: 'number' },
      { key: 'edmontonTiredness', label: 'Cansancio (Edmonton 0-10)', type: 'number' },
      { key: 'edmontonNausea', label: 'Náusea (Edmonton 0-10)', type: 'number' },
      { key: 'edmontonDepression', label: 'Depresión (Edmonton 0-10)', type: 'number' },
      { key: 'edmontonAnxiety', label: 'Ansiedad (Edmonton 0-10)', type: 'number' },
      { key: 'joinManage', label: 'Manejo Conjunto', type: 'checkbox' },
      { key: 'medicalSupport', label: 'Apoyo Médico', type: 'checkbox' },
      { key: 'comentarios', label: 'Observaciones', type: 'textarea' },
    ],
  },
};

function buildSimpleNoteEditHtml(c, config) {
  return `<div style="display: flex; flex-direction: column; gap: 12px;">${config.fields.map(f => {
    const id = 'editSimple_' + f.key;
    const val = c[f.key];
    if (f.type === 'checkbox') {
      return `<label class="custom-checkbox"><input type="checkbox" id="${id}" ${val ? 'checked' : ''}/><span></span> ${f.label}</label>`;
    }
    if (f.type === 'textarea') {
      return `<div class="form-group"><label style="font-size: 11px; font-weight: 700;">${f.label}</label>${richTextEditorHtml(id, '', val)}</div>`;
    }
    return `<div class="form-group"><label style="font-size: 11px; font-weight: 700;">${f.label}</label><input type="${f.type}" id="${id}" value="${val != null ? val : ''}" style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);"></div>`;
  }).join('')}</div>`;
}

function buildSimpleNoteReadHtml(c, config) {
  const rows = config.fields.map(f => {
    const val = c[f.key];
    if (f.type === 'checkbox') {
      return `<div style="font-size: 13px;"><span style="color: var(--text-muted);">${f.label}:</span> <strong>${val ? 'Sí' : 'No'}</strong></div>`;
    }
    if (!val) return '';
    return `
      <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 10px 14px; border-radius: var(--radius-md);">
        <div style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; margin-bottom: 2px;">${f.label}</div>
        <div style="font-size: 13px; color: var(--text-main); white-space: pre-line;">${val}</div>
      </div>`;
  }).filter(Boolean).join('');
  return `<div style="display: flex; flex-direction: column; gap: 10px;">${rows || '<p style="color: var(--text-muted); font-size: 13px;">Sin datos registrados.</p>'}</div>`;
}

async function showConsultaPreview(c, isEditing = false) {
  const card = document.getElementById('consultaDetailCard');
  if (!card) return;
  currentPreviewConsulta = c;
  // .empty-state-container centra su contenido vertical y horizontalmente
  // (pensado para el mensaje de "sin consultas") — si se queda puesta al
  // pintar una nota real, el encabezado aparece centrado dentro de la
  // tarjeta en vez de arriba, dejando un hueco por encima que varía de
  // tamaño según el zoom/alto de viewport.
  card.classList.remove('empty-state-container');

  const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || '';
  const activeExp = getActivePatientExp();
  const isSignos = (c.tipo || '').toLowerCase().includes('signos vitales');
  const isEvolution = c.source === 'evolution';
  const simpleNoteConfig = SIMPLE_NOTE_CONFIGS[c.source];

  let bodyHtml = '';

  if (isEditing) {
    // MODO EDICIÓN
    if (isEvolution) {
      bodyHtml = `
        <form id="formEditConsulta" style="display: flex; flex-direction: column; gap: 14px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label style="font-size: 11px; font-weight: 700;">Doctor</label>
              <select id="editEvolutionDoctor" style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);"></select>
            </div>
            <div class="form-group">
              <label style="font-size: 11px; font-weight: 700;">Fecha y Hora</label>
              <input type="datetime-local" id="editEvolutionDatetime" value="${(c.evolutionDatetime || '').slice(0, 16)}" style="width: 100%; padding: 8px; font-size: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
            </div>
          </div>
          <div class="form-group">
            <label style="font-size: 11px; font-weight: 700;">Nota de Evolución</label>
            ${richTextEditorHtml('editComentarios', '', c.comentarios)}
          </div>
        </form>
      `;
    } else if (simpleNoteConfig) {
      bodyHtml = `<form id="formEditConsulta">${buildSimpleNoteEditHtml(c, simpleNoteConfig)}</form>`;
    } else if (isSignos) {
      bodyHtml = `
        <form id="formEditConsulta" style="display: flex; flex-direction: column; gap: 14px;">
          <div style="font-size: 11px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase;">Editar Signos Vitales y Somatometría</div>
          <!-- align-items: end: si una etiqueta ocupa dos líneas (p.ej. "PA
               Diastólica (mmHg)" en pantallas angostas), su campo ya no se
               recorre hacia abajo respecto a los demás de la fila. -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; align-items: end;">
            <div class="form-group">
              <label style="font-size: 11px;">PA Sistólica (mmHg)</label>
              <input type="number" id="editSistolica" value="${c.sistolica || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">PA Diastólica (mmHg)</label>
              <input type="number" id="editDiastolica" value="${c.diastolica || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">FC (lpm)</label>
              <input type="number" id="editFC" value="${c.fc || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">FR (rpm)</label>
              <input type="number" id="editFR" value="${c.fr || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">Temp (°C)</label>
              <input type="number" step="0.1" id="editTemp" value="${c.temperatura || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">Sat O₂ (%)</label>
              <input type="number" id="editSat" value="${c.saturacion || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">Peso (kg)</label>
              <input type="number" step="0.1" id="editPeso" value="${c.peso || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px;">Altura (cm)</label>
              <input type="number" id="editAltura" value="${c.altura || ''}" style="padding: 6px; font-size: 12px;">
            </div>
            <div class="form-group">
              <label style="font-size: 11px; color: var(--primary-blue);">BSA DuBois (m²)</label>
              <input type="text" id="editBSA" readonly value="${c.bsa || ''}" style="padding: 6px; font-size: 12px; font-weight: 800; color: var(--primary-blue); background: var(--bg-main);">
            </div>
            <div class="form-group">
              <label style="font-size: 11px; color: var(--primary-blue);">IMC (kg/m²)</label>
              <input type="text" id="editIMC" readonly value="${c.imc || ''}" style="padding: 6px; font-size: 12px; font-weight: 800; color: var(--primary-blue); background: var(--bg-main);">
            </div>
          </div>
          <div class="form-group">
            <label style="font-size: 11px;">Observaciones / Comentarios</label>
            ${richTextEditorHtml('editComentarios', '', c.comentarios)}
          </div>
        </form>
      `;
    } else {
      bodyHtml = `
        <form id="formEditConsulta" style="display: flex; flex-direction: column; gap: 14px;">
          <div class="form-group">
            <label style="font-size: 11px; font-weight: 700;">Detalles de la Nota / Consulta</label>
            ${richTextEditorHtml('editComentarios', '', c.comentarios)}
          </div>
        </form>
      `;
    }
  } else {
    // MODO LECTURA (READ ONLY)
    if (isEvolution) {
      bodyHtml = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 10px 14px; border-radius: var(--radius-md);">
              <span style="font-size: 11px; font-weight: 700; color: var(--text-subtle);">Doctor:</span>
              <div style="font-size: 13px; font-weight: 700; color: var(--text-main);">${c.medico || 'Sin doctor asignado'}</div>
            </div>
            <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 10px 14px; border-radius: var(--radius-md);">
              <span style="font-size: 11px; font-weight: 700; color: var(--text-subtle);">Fecha y Hora:</span>
              <div style="font-size: 13px; font-weight: 700; color: var(--text-main);">${c.evolutionDatetime ? formatTratFechaHora(c.evolutionDatetime) : 'Sin fecha registrada'}</div>
            </div>
          </div>
          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 14px 18px; border-radius: var(--radius-md);">
            <div style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; margin-bottom: 4px;">Nota de Evolución</div>
            <div style="font-size: 13px; color: var(--text-main); white-space: pre-line;">${c.comentarios || 'Sin nota registrada.'}</div>
          </div>
        </div>
      `;
    } else if (simpleNoteConfig) {
      bodyHtml = buildSimpleNoteReadHtml(c, simpleNoteConfig);
    } else if (isSignos) {
      bodyHtml = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 20px;">
          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">Presión Arterial</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main); margin-top: 4px;">${c.sistolica || '--'} / ${c.diastolica || '--'} <span style="font-size: 11px; font-weight: 500; color: var(--text-muted);">mmHg</span></div>
          </div>

          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">Freq. Cardíaca</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main); margin-top: 4px;">${c.fc || '--'} <span style="font-size: 11px; font-weight: 500; color: var(--text-muted);">lpm</span></div>
          </div>

          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">Freq. Respiratoria</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main); margin-top: 4px;">${c.fr || '--'} <span style="font-size: 11px; font-weight: 500; color: var(--text-muted);">rpm</span></div>
          </div>

          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">Temperatura</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main); margin-top: 4px;">${c.temperatura || '--'} <span style="font-size: 11px; font-weight: 500; color: var(--text-muted);">°C</span></div>
          </div>

          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">Sat. Oxígeno</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main); margin-top: 4px;">${c.saturacion || '--'} <span style="font-size: 11px; font-weight: 500; color: var(--text-muted);">%</span></div>
          </div>

          <div style="grid-column: 1 / -1; background: var(--bg-main); border: 1px solid var(--border-color); padding: 12px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 10px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase;">Peso / Altura</div>
            <div style="font-size: 16px; font-weight: 800; color: var(--text-main); margin-top: 4px;">${c.peso || '--'} kg / ${c.altura || '--'} cm</div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;">
          <div style="background: #EFF6FF; border: 1px solid #BFDBFE; padding: 14px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #1E40AF; text-transform: uppercase;">Superficie Corporal (BSA DuBois)</div>
            <div style="font-size: 22px; font-weight: 800; color: #2563EB; margin-top: 4px;">${c.bsa || 'N/A'}</div>
          </div>

          <div style="background: #ECFDF5; border: 1px solid #A7F3D0; padding: 14px; border-radius: var(--radius-md); text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #065F46; text-transform: uppercase;">Índice de Masa Corporal (IMC)</div>
            <div style="font-size: 22px; font-weight: 800; color: #10B981; margin-top: 4px;">${c.imc || 'N/A'}</div>
          </div>
        </div>

        ${c.comentarios ? `
          <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 14px 18px; border-radius: var(--radius-md);">
            <div style="font-size: 11px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; margin-bottom: 4px;">Observaciones</div>
            <div style="font-size: 13px; color: var(--text-main);">${c.comentarios}</div>
          </div>
        ` : ''}
      `;
    } else {
      bodyHtml = `
        <div style="background: var(--bg-main); border: 1px solid var(--border-color); padding: 20px; border-radius: var(--radius-md); margin-bottom: 20px;">
          <div style="font-size: 12px; font-weight: 700; color: var(--text-subtle); text-transform: uppercase; margin-bottom: 8px;">Detalles de la Nota</div>
          <div style="font-size: 14px; color: var(--text-main); line-height: 1.6;">${c.comentarios || 'Nota registrada en el expediente clínico del paciente.'}</div>
        </div>
      `;
    }
  }

  card.innerHTML = `
    <div style="width: 100%; text-align: left;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
        <div>
          <span style="font-size: 11px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase; letter-spacing: 0.05em;">REGISTRO MÉDICO DEL PACIENTE</span>
          <h2 style="font-size: 22px; font-weight: 800; color: var(--text-main); margin-top: 2px;">${c.tipo || c.titulo}</h2>
          <div style="font-size: 13px; color: var(--primary-blue); font-weight: 800; margin-top: 4px; display: flex; align-items: center; gap: 6px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Paciente: ${activePatientName} <span style="font-weight: 500; color: var(--text-muted); font-size: 12px;">(Exp: ${activeExp})</span></div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">A cargo de: <strong>${c.medico || 'Sin médico asignado'}</strong></div>
          ${buildCreatedUpdatedMetaHtml(c.fecha, c.createdBy, c.updatedAt, c.updatedBy, consultaEditableRecord(c))}
        </div>

        <div style="display: flex; align-items: center; gap: 8px;">
          ${isEditing ? `
            <button type="button" class="btn-secondary btn-anim-lift" id="btnDiscardConsultaEdit" style="color: #EF4444; border-color: #FCA5A5; font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Descartar
            </button>
            <button type="button" class="btn-primary btn-anim-lift" id="btnSaveConsultaEdit" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Guardar
            </button>
          ` : `
            <button type="button" class="btn-secondary btn-anim-lift" id="btnToggleConsultaEdit" data-source="${c.source || ''}" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg> Editar
            </button>
            <button type="button" class="btn-secondary btn-anim-lift" id="btnPrintConsultaView" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir
            </button>
            ${c.source === 'vitals' ? `
            <button type="button" class="btn-secondary btn-anim-lift" id="btnDownloadConsultaView" style="font-size: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Descargar PDF
            </button>
            ` : ''}
          `}
        </div>
      </div>

      <div id="consultaSaveFeedback" style="display: none; background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46; padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; font-weight: 700; margin-bottom: 16px; align-items: center; gap: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Consulta actualizada con éxito.
      </div>

      ${bodyHtml}
    </div>
  `;

  if (isEditing && isEvolution) {
    await populateCitaDoctorSelect(document.getElementById('editEvolutionDoctor'), c.doctorId);
  }
}

// Escuchadores Globales para Editar, Descartar, Guardar e Imprimir Consulta
document.addEventListener('click', (event) => {
  const btnToggleEdit = event.target.closest('#btnToggleConsultaEdit');
  if (btnToggleEdit) {
    event.preventDefault();
    if (currentPreviewConsulta) {
      showConsultaPreview(currentPreviewConsulta, true);
    }
    return;
  }

  const btnDiscardEdit = event.target.closest('#btnDiscardConsultaEdit');
  if (btnDiscardEdit) {
    event.preventDefault();
    if (currentPreviewConsulta) {
      showConsultaPreview(currentPreviewConsulta, false);
    }
    return;
  }

  const btnDownloadView = event.target.closest('#btnDownloadConsultaView');
  if (btnDownloadView) {
    event.preventDefault();
    const rawId = currentPreviewConsulta && currentPreviewConsulta.source === 'vitals'
      ? String(currentPreviewConsulta.id).split('-')[1] : null;
    const patientId = window.clivoraCurrentPatientId;
    if (rawId && patientId) {
      clivoraDownloadPdf(`/clivora/api/patients/${patientId}/consultations/vitals/${rawId}/print`);
    }
    return;
  }
  const btnPrintView = event.target.closest('#btnPrintConsultaView');
  if (btnPrintView) {
    event.preventDefault();
    // Signos Vitales ya tiene reporte PDF propio (mismo header/logo de la
    // compañía que Historia Clínica); el resto de tipos de consulta todavía
    // no, así que siguen cayendo al window.print() genérico de la página.
    if (currentPreviewConsulta && currentPreviewConsulta.source === 'vitals') {
      const rawId = String(currentPreviewConsulta.id).split('-')[1];
      const patientId = window.clivoraCurrentPatientId;
      if (rawId && patientId) {
        window.open(`/clivora/api/patients/${patientId}/consultations/vitals/${rawId}/print`, '_blank');
        return;
      }
    }
    window.print();
    return;
  }

  const btnSaveEdit = event.target.closest('#btnSaveConsultaEdit');
  if (btnSaveEdit) {
    event.preventDefault();
    if (!currentPreviewConsulta) return;
    const [prefix, rawId] = String(currentPreviewConsulta.id).split('-');
    const recordId = parseInt(rawId, 10);
    if (!recordId) return;

    (async () => {
      try {
        if (prefix === 'v') {
          const payload = {
            sistolica: document.getElementById('editSistolica')?.value || '',
            diastolica: document.getElementById('editDiastolica')?.value || '',
            fc: document.getElementById('editFC')?.value || '',
            fr: document.getElementById('editFR')?.value || '',
            temperatura: document.getElementById('editTemp')?.value || '',
            saturacion: document.getElementById('editSat')?.value || '',
            peso: document.getElementById('editPeso')?.value || '',
            altura: document.getElementById('editAltura')?.value || '',
            comentarios: getEditableFieldValue(document.getElementById('editComentarios')),
          };
          await fetch(`/clivora/api/consultations/vitals/${recordId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } else if (prefix === 'ev') {
          const payload = {
            doctorId: document.getElementById('editEvolutionDoctor')?.value || false,
            evolutionDatetime: document.getElementById('editEvolutionDatetime')?.value || false,
            comentarios: getEditableFieldValue(document.getElementById('editComentarios')),
          };
          await fetch(`/clivora/api/consultations/evolution/${recordId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } else {
          const config = SIMPLE_NOTE_CONFIGS[currentPreviewConsulta.source];
          if (config) {
            const payload = {};
            config.fields.forEach(f => {
              const el = document.getElementById('editSimple_' + f.key);
              if (!el) return;
              payload[f.key] = getEditableFieldValue(el);
            });
            await fetch(`/clivora/api/consultations/${config.endpoint}/${recordId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          }
        }
        await loadPatientConsultas(window.clivoraCurrentPatientId);
        const updated = clivoraPatientConsultas.find(c => c.id === currentPreviewConsulta.id);
        showConsultaPreview(updated || currentPreviewConsulta, false);
        const feedback = document.getElementById('consultaSaveFeedback');
        if (feedback) feedback.style.display = 'flex';
      } catch (error) {
        console.error('Error al guardar cambios de la consulta:', error);
        showClivoraAlertModal('No se pudieron guardar los cambios.');
      }
    })();
  }
});

function initializePatientsModule() {
  if (document.body.dataset.patientModuleInitialized === 'true') return;
  document.body.dataset.patientModuleInitialized = 'true';

  initializeMovableTabs();
  initializeMovableHCSections();
  initializeHCSectionStates();

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.open-patient-detail');
    if (!btn) return;

    // Este botón ahora también vive dentro del modal de Agendar/Editar Cita
    // (ver citaVerPacienteBtn en openCitaModal) — sin cerrarlo, el modal se
    // quedaba flotando encima de la vista de Paciente Detail al navegar,
    // tapándola por completo.
    document.getElementById('addCitaModal')?.classList.remove('open');

    const patientId = btn.dataset.id || '';
    const name = btn.dataset.name || '';
    const exp = btn.dataset.exp || '';
    const detailName = document.getElementById('detailPatientName');
    const detailExp = document.getElementById('detailPatientExp');
    if (detailName) detailName.textContent = name;
    if (detailExp) detailExp.textContent = 'Expediente: ' + (exp || 'N/A');

    window.clivoraCurrentPatientId = patientId ? parseInt(patientId, 10) : null;

    // Información General/Domicilios/Facturación son un solo DOM estático
    // que se reutiliza para cualquier paciente (solo se rellenan sus campos
    // al cambiar de paciente) — la clase "open" que les pone el click en
    // .accordion-header (ver el listener de abajo) nunca se quitaba sola,
    // así que una vez expandida una de estas tarjetas se quedaba abierta
    // para siempre, incluso al entrar a un paciente distinto. Se cierran a
    // fuerza cada vez que se abre el detalle de un paciente (el que sea).
    ['infoGeneralAccordion', 'domicilioPersonalAccordion', 'facturacionAccordion'].forEach(id => {
      document.getElementById(id)?.classList.remove('open');
    });

    if (patientId) {
      loadPatientDetail(patientId);
      loadPatientFiles(window.clivoraCurrentPatientId);
      loadPatientChemotherapy(window.clivoraCurrentPatientId);
      loadPatientQuestionnaire(window.clivoraCurrentPatientId);
      loadPatientInsurance(window.clivoraCurrentPatientId);
      loadPatientLabOrders(window.clivoraCurrentPatientId);
      loadPatientConsultas(window.clivoraCurrentPatientId);
      loadPatientRecipes(window.clivoraCurrentPatientId);
      loadPatientShares(window.clivoraCurrentPatientId);
      loadPatientSaleOrders(window.clivoraCurrentPatientId);
    }

    initializeMovableTabs();
    initializeMovableHCSections();
    initializeHCSectionStates();
    switchView('pacienteDetail');
  });

// --- LÓGICA DE PESTAÑAS MOVIBLES POR DRAG & DROP CON ANIMACIÓN DE EMPUJE EN TIEMPO REAL ---
function initializeMovableTabs() {
  const container = document.querySelector('.expediente-subtabs-bar');
  if (!container) return;

  const savedOrder = JSON.parse(localStorage.getItem('clivora_expediente_subtabs_order') || '[]');
  if (savedOrder.length > 0) {
    const tabsMap = {};
    const tabs = Array.from(container.querySelectorAll('.expediente-subtab'));
    tabs.forEach(tab => {
      if (tab.dataset.tab) tabsMap[tab.dataset.tab] = tab;
    });

    savedOrder.forEach(tabId => {
      if (tabsMap[tabId]) {
        container.appendChild(tabsMap[tabId]);
      }
    });

    tabs.forEach(tab => {
      if (!savedOrder.includes(tab.dataset.tab)) {
        container.appendChild(tab);
      }
    });
  }

  let draggedTab = null;

  container.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.expediente-subtab');
    if (!tab) return;
    draggedTab = tab;
    setTimeout(() => {
      tab.classList.add('dragging');
    }, 0);
    e.dataTransfer.effectAllowed = 'move';
    if (tab.dataset.tab) {
      e.dataTransfer.setData('text/plain', tab.dataset.tab);
    }
  });

  container.addEventListener('dragend', (e) => {
    const tab = e.target.closest('.expediente-subtab');
    if (tab) tab.classList.remove('dragging');
    container.querySelectorAll('.expediente-subtab').forEach(t => t.classList.remove('drag-over', 'dragging'));
    draggedTab = null;
    saveExpedienteSubtabsOrder();
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!draggedTab) return;

    const afterElement = getDragAfterElement(container, e.clientX);
    if (afterElement == null) {
      container.appendChild(draggedTab);
    } else {
      container.insertBefore(draggedTab, afterElement);
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.querySelectorAll('.expediente-subtab').forEach(t => t.classList.remove('drag-over', 'dragging'));
    saveExpedienteSubtabsOrder();
  });
}

function getDragAfterElement(container, x) {
  const draggableElements = [...container.querySelectorAll('.expediente-subtab:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function saveExpedienteSubtabsOrder() {
  const container = document.querySelector('.expediente-subtabs-bar');
  if (!container) return;
  const currentOrder = Array.from(container.querySelectorAll('.expediente-subtab'))
    .map(t => t.dataset.tab)
    .filter(Boolean);
  localStorage.setItem('clivora_expediente_subtabs_order', JSON.stringify(currentOrder));
}

// --- LÓGICA DE SECCIONES DE HISTORIA CLÍNICA MOVIBLES (DRAG & DROP VERTICAL CON EMPUJE Y REENUMERACIÓN) ---
function initializeMovableHCSections() {
  const container = document.querySelector('.hc-sections-list');
  if (!container) return;

  const savedOrder = JSON.parse(localStorage.getItem('clivora_hc_sections_order') || '[]');
  if (savedOrder.length > 0) {
    const sectionsMap = {};
    const items = Array.from(container.querySelectorAll('.hc-section-item'));
    items.forEach(item => {
      if (item.dataset.hcSection) sectionsMap[item.dataset.hcSection] = item;
    });

    savedOrder.forEach(secId => {
      if (sectionsMap[secId]) {
        container.appendChild(sectionsMap[secId]);
      }
    });

    items.forEach(item => {
      if (!savedOrder.includes(item.dataset.hcSection)) {
        container.appendChild(item);
      }
    });
  }

  updateHCSectionNumbers();

  let draggedItem = null;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.hc-section-item');
    if (!item) return;
    draggedItem = item;
    setTimeout(() => {
      item.classList.add('dragging');
    }, 0);
    e.dataTransfer.effectAllowed = 'move';
    if (item.dataset.hcSection) {
      e.dataTransfer.setData('text/plain', item.dataset.hcSection);
    }
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest('.hc-section-item');
    if (item) item.classList.remove('dragging');
    container.querySelectorAll('.hc-section-item').forEach(t => t.classList.remove('dragging'));
    draggedItem = null;
    updateHCSectionNumbers();
    saveHCSectionsOrder();
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!draggedItem) return;

    const afterElement = getVerticalDragAfterElement(container, e.clientY);
    if (afterElement == null) {
      container.appendChild(draggedItem);
    } else {
      container.insertBefore(draggedItem, afterElement);
    }
    updateHCSectionNumbers();
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.querySelectorAll('.hc-section-item').forEach(t => t.classList.remove('dragging'));
    updateHCSectionNumbers();
    saveHCSectionsOrder();
  });
}

// El "X / N" de cada .editor-bottom-pagination venía escrito a mano en el
// HTML (ej. "11 / 14", "6 / 9") y no correspondía con las 9 secciones reales
// ni con su orden actual en el sidebar — nunca se actualizaba, ni al cargar
// ni al reordenar. Se recalcula aquí a partir del orden real de
// #hcSectionsList, que es la misma fuente que usa la navegación
// Anterior/Siguiente.
function updateHCPaginationCounters() {
  const items = Array.from(document.querySelectorAll('#hcSectionsList .hc-section-item'));
  const total = items.length;
  if (!total) return;
  items.forEach((item, index) => {
    const targetId = item.getAttribute('data-hc-section');
    const section = targetId && document.getElementById(targetId);
    if (!section) return;
    const counter = section.querySelector('.editor-bottom-pagination > div > div:first-child');
    if (counter) counter.textContent = `${index + 1} / ${total}`;
  });
}

function updateHCSectionNumbers() {
  const container = document.querySelector('.hc-sections-list');
  if (!container) return;
  const items = container.querySelectorAll('.hc-section-item');
  items.forEach((item, index) => {
    const firstSpan = item.querySelector('span:first-child');
    if (firstSpan) {
      firstSpan.textContent = firstSpan.textContent.replace(/^\d+\.\s*/, `${index + 1}. `);
    }
  });
}

function getVerticalDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.hc-section-item:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function saveHCSectionsOrder() {
  const container = document.querySelector('.hc-sections-list');
  if (!container) return;
  updateHCSectionNumbers();
  updateHCPaginationCounters();
  const currentOrder = Array.from(container.querySelectorAll('.hc-section-item'))
    .map(t => t.dataset.hcSection)
    .filter(Boolean);
  localStorage.setItem('clivora_hc_sections_order', JSON.stringify(currentOrder));
}

function removeTopNavButtons() {
  const topNavButtons = document.querySelectorAll('.editor-top-nav .btn-nav-page');
  topNavButtons.forEach(btn => {
    const container = btn.closest('div[style*="display: flex; gap: 8px"], div[style*="display:flex; gap:8px"]') || btn.parentElement;
    if (container && container !== btn.closest('.editor-top-nav')) {
      container.remove();
    } else {
      btn.remove();
    }
  });
}

// --- FUNCIONALIDADES DE HISTORIA CLÍNICA: TOGGLES, LIMPIAR, GUARDAR (BORRADOR/HECHO), IMPRIMIR Y DESCARTAR ---
// El botón "Inhabilitada/Habilitada (Clic para...)" que bloqueaba cada
// sección hasta darle clic se quitó del frontend en una revisión de
// producto (los doctores no quieren dar clics extra solo para poder
// escribir) — las secciones de Historia Clínica quedan siempre editables.
function initializeHCSectionStates() {
  removeTopNavButtons();
  initializeHCClearButtons();
  updateHCPaginationCounters();
}

function initializeHCClearButtons() {
  const sections = document.querySelectorAll('.hc-section-content');
  sections.forEach(section => {
    // Se parte de cada botón "Grabar" y se busca SU grupo más cercano, en
    // vez de recorrer los grupos de afuera hacia adentro: un grupo exterior
    // que contiene varios campos (ej. varias tarjetas de Antecedentes No
    // Patológicos: Humo, Alcoholismo, Gineco-obstétricos) tomaba el primer
    // "Grabar" que encontraba y los demás campos se quedaban sin "Limpiar".
    const recordButtons = Array.from(section.querySelectorAll('.btn-record-mic, .btn-hc-action'))
      .filter(btn => btn.textContent.trim().includes('Grabar') && !btn.classList.contains('btn-clear-hc-field'));
    recordButtons.forEach(recordBtn => {
      const group = recordBtn.closest('.form-group, .familiar-field-group, div:has(> textarea), .nopat-card');
      if (!group || !recordBtn.parentElement) return;
      if (recordBtn.parentElement.querySelector('.btn-clear-hc-field')) return;

      // El editor de texto enriquecido (Antecedentes, Motivo de Consulta,
      // etc.) es un div[contenteditable].rich-text-content, no un
      // input/textarea/select real — pero su propio toolbar SÍ trae un
      // <select> de fuente/tamaño antes que el contenido en el DOM. Sin
      // priorizar .rich-text-content aquí, "Limpiar" terminaba limpiando el
      // <select> de fuente del toolbar en vez del texto del editor, que se
      // quedaba intacto pasara lo que pasara.
      const targetInput = group.querySelector('.rich-text-content')
        || group.querySelector('input, textarea, select');
      if (!targetInput) return;

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn-clear-hc-field btn-record-mic';
      clearBtn.title = 'Limpiar este campo';
      clearBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">'
        + '<path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>'
        + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>Limpiar';

      clearBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEditableFieldValue(targetInput, '');
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      };

      // Agrupar Limpiar+Grabar en su propio contenedor en vez de insertar
      // Limpiar "suelto" junto al <label>: el contenedor original suele ser
      // "justify-content: space-between" con el label, y con 3 hijos el
      // espacio libre se reparte entre los tres — Limpiar quedaba a medio
      // camino entre el label y Grabar, muy separado de este último.
      const groupWrapper = document.createElement('div');
      groupWrapper.style.cssText = 'display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%;';
      recordBtn.parentElement.insertBefore(groupWrapper, recordBtn);
      groupWrapper.appendChild(clearBtn);
      groupWrapper.appendChild(recordBtn);
    });
  });
}

// Compartida entre el click de Anterior/Siguiente y el atajo de teclado
// Alt+flechas (ver keydown más abajo) — antes solo vivía dentro del click
// handler, y el atajo mostrado en el pie de página ("Alt + ← →") no hacía
// nada al presionarlo.
function navigateHCSection(isNext) {
  const container = document.querySelector('.hc-sections-list');
  if (!container) return;

  const currentActiveItem = container.querySelector('.hc-section-item.active') || container.querySelector('.hc-section-item');
  if (!currentActiveItem) return;

  let targetItem = isNext ? currentActiveItem.nextElementSibling : currentActiveItem.previousElementSibling;
  while (targetItem && targetItem.classList.contains('hc-section-item') && targetItem.style.display === 'none') {
    targetItem = isNext ? targetItem.nextElementSibling : targetItem.previousElementSibling;
  }
  if (targetItem && targetItem.classList.contains('hc-section-item')) {
    targetItem.click();
    targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Ctrl+flecha izquierda/derecha = Anterior/Siguiente sección de Historia
// Clínica, tal como ya lo indica el atajo dibujado en
// .editor-bottom-pagination. Antes era Alt+flecha, pero ese combo está
// reservado por el navegador para "Atrás/Adelante" del historial de
// navegación — en Windows/Chrome se intercepta a nivel del navegador antes
// de que la página reciba el evento, así que preventDefault() no lo podía
// bloquear de forma confiable. Solo actúa si la lista está realmente
// visible (Historia Clínica abierta).
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  const sectionsList = document.querySelector('.hc-sections-list');
  if (!sectionsList || sectionsList.offsetParent === null) return;
  event.preventDefault();
  navigateHCSection(event.key === 'ArrowRight');
});

document.addEventListener('click', (event) => {
  // --- BOTONES DE NAVEGACIÓN INFERIOR (ANTERIOR / SIGUIENTE) SEGÚN EL ORDEN REORDENADO ---
  // Único listener para .btn-nav-page: había otros dos escuchadores de click
  // duplicados en este archivo (uno genérico y otro idéntico dentro de un
  // DOMContentLoaded) que también reaccionaban al mismo clic. Cada uno
  // recalculaba el índice activo y llamaba a .click() sobre el siguiente
  // item, y como esa llamada dispara un nuevo evento de forma síncrona,
  // los tres listeners se disparaban en cascada uno tras otro: un solo
  // clic avanzaba 2 o 3 niveles en vez de 1, y al llegar cerca del final
  // los botones dejaban de responder. Se eliminaron los otros dos y solo
  // queda este.
  const btnBottomNav = event.target.closest('.editor-bottom-pagination .btn-nav-page');
  if (btnBottomNav) {
    event.preventDefault();
    const isNext = btnBottomNav.textContent.trim().toLowerCase().includes('siguiente');
    navigateHCSection(isNext);
    return;
  }

  // --- BOTÓN GUARDAR HISTORIA CLÍNICA ---
  // Antes se detectaba por clase (.btn-hc-action.blue-filled) — cualquier
  // otro botón que reutilizara ese mismo estilo en cualquier parte de la
  // página (ej. "+ Nueva Receta") disparaba también el guardado completo
  // de Historia Clínica sin querer. Ahora se apunta al botón real por id.
  const btnSaveHC = event.target.closest('#btnSaveHistoriaClinica');
  if (btnSaveHC) {
    event.preventDefault();
    checkHCSectionCompletion();
    return;
  }

  // --- BOTÓN IMPRIMIR HISTORIA CLÍNICA (blue-outline) ---
  const btnPrintHC = event.target.closest('.btn-hc-action.blue-outline');
  if (btnPrintHC) {
    event.preventDefault();
    printHistoriaClinica();
    return;
  }

  // --- BOTÓN DESCARTAR HISTORIA CLÍNICA (red-outline) ---
  const btnDiscardHC = event.target.closest('.btn-hc-action.red-outline');
  if (btnDiscardHC) {
    event.preventDefault();
    const modalDiscard = document.getElementById('modalHCDiscardConfirm');
    if (modalDiscard) modalDiscard.style.display = 'flex';
    return;
  }

  // Modal confirmación descarte
  const btnConfirmDiscard = event.target.closest('#btnConfirmHCDiscard');
  if (btnConfirmDiscard) {
    event.preventDefault();
    resetAllHCFields();
    const modalDiscard = document.getElementById('modalHCDiscardConfirm');
    if (modalDiscard) modalDiscard.style.display = 'none';
    return;
  }

  const btnCancelDiscard = event.target.closest('#btnCancelHCDiscardModal');
  if (btnCancelDiscard) {
    event.preventDefault();
    const modalDiscard = document.getElementById('modalHCDiscardConfirm');
    if (modalDiscard) modalDiscard.style.display = 'none';
    return;
  }

  // Modal alerta secciones faltantes
  const btnConfirmSaveAnyway = event.target.closest('#btnConfirmHCSaveAnyway');
  if (btnConfirmSaveAnyway) {
    event.preventDefault();
    executeHCSaveSuccess();
    const modalMissing = document.getElementById('modalHCMissingSections');
    if (modalMissing) modalMissing.style.display = 'none';
    return;
  }

  const btnCancelMissing = event.target.closest('#btnCancelHCMissingModal');
  if (btnCancelMissing) {
    event.preventDefault();
    const modalMissing = document.getElementById('modalHCMissingSections');
    if (modalMissing) modalMissing.style.display = 'none';
    return;
  }
});

// Al Guardar la Historia Clínica solo se advierte (sin bloquear: "Sí, guardar
// de todos modos") si faltan Motivo de Consulta, PEEA o Diagnóstico. Antes se
// revisaban todas las secciones (y el Motivo de Consulta bloqueaba el
// guardado); se pidió avisar únicamente por estos tres.
function checkHCSectionCompletion() {
  // Textos que la propia Historia Clínica pone sola ("VER PEEA" en Análisis)
  // no cuentan como capturados.
  const normalizeHcText = (text) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const autoDefaultTexts = new Set(['Interrogado y Negado', 'VER PEEA'].map(normalizeHcText));
  const hasRealText = (id) => {
    const el = document.getElementById(id);
    const normalized = normalizeHcText(el ? getEditableFieldValue(el) : '');
    return normalized !== '' && !autoDefaultTexts.has(normalized);
  };
  // Diagnóstico: al menos un diagnóstico CIE-11 elegido en "Análisis y
  // Diagnóstico", o el análisis escrito.
  const hasDiagnosis = Array.from(document.querySelectorAll('#diagnosisLinesContainer .diagnosis-line-input'))
    .some(input => input.dataset.selectedId && input.value.trim())
    || hasRealText('analysisText');

  const missingSections = [];
  if (!hasRealText('hcMotivoConsulta')) missingSections.push('Motivo de Consulta');
  if (!hasRealText('peeaDescription')) missingSections.push('PEEA');
  if (!hasDiagnosis) missingSections.push('Diagnóstico');

  if (missingSections.length > 0) {
    const listContainer = document.getElementById('hcMissingSectionsListContainer');
    if (listContainer) {
      listContainer.innerHTML = missingSections.map(sec => `<div style="padding: 3px 0;">• ${sec}</div>`).join('');
    }
    const modalMissing = document.getElementById('modalHCMissingSections');
    if (modalMissing) modalMissing.style.display = 'flex';
  } else {
    executeHCSaveSuccess();
  }
}

async function executeHCSaveSuccess() {
  // Cada save* devuelve true/false según response.ok — antes se ignoraba
  // el resultado y siempre se mostraba "Guardado con Éxito" aunque el
  // backend respondiera 403/500 (p.ej. por permisos), dejando al usuario
  // sin ninguna señal de que sus datos no se habían guardado.
  const results = await Promise.all([
    saveHistoriaClinica(),
    saveFamilyHistory(),
    savePatologicosSublists(),
    saveMedications(),
    saveDiagnosisLines(),
  ]);
  const allOk = results.every(Boolean);

  const toast = getOrCreateHCSaveToast();
  if (allOk) {
    const badges = document.querySelectorAll('.hc-section-content .badge-borrador, .hc-section-content .badge-hecho');
    badges.forEach(b => {
      b.className = 'badge-hecho';
      b.style.cssText = 'background: #ECFDF5; color: #065F46; border: 1px solid #A7F3D0; padding: 4px 10px; border-radius: 12px; font-weight: 800; font-size: 11px;';
      b.textContent = '¡Hecho!';
    });
    toast.style.cssText = 'position: fixed; bottom: 24px; right: 24px; background: #ECFDF5; border: 1px solid #10B981; color: #065F46; padding: 14px 20px; border-radius: 8px; font-weight: 800; font-size: 13px; z-index: 9999; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 8px;';
    toast.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"/></svg> ¡Datos de Historia Clínica Guardados con Éxito!';
  } else {
    toast.style.cssText = 'position: fixed; bottom: 24px; right: 24px; background: #FEF2F2; border: 1px solid #EF4444; color: #991B1B; padding: 14px 20px; border-radius: 8px; font-weight: 800; font-size: 13px; z-index: 9999; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 8px;';
    toast.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> No se pudieron guardar algunos datos. Intenta de nuevo.';
  }
  toast.style.display = 'flex';
  setTimeout(() => {
    toast.style.display = 'none';
  }, allOk ? 2500 : 4500);
}

function getOrCreateHCSaveToast() {
  let toast = document.getElementById('hcSaveSuccessToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'hcSaveSuccessToast';
    document.body.appendChild(toast);
  }
  return toast;
}

function resetAllHCFields() {
  const sections = document.querySelectorAll('.hc-section-content');
  sections.forEach(section => {
    const inputs = section.querySelectorAll('input, textarea, select');
    inputs.forEach(inp => {
      inp.value = '';
    });

    const badge = section.querySelector('.badge-hecho, .badge-borrador');
    if (badge) {
      badge.className = 'badge-borrador';
      badge.style.cssText = '';
      badge.textContent = 'Borrador';
    }
  });
}

// A diferencia de checkHCSectionCompletion (que solo advierte al Guardar y
// deja continuar de todos modos), estos 3 campos son obligatorios pero
// únicamente al momento de imprimir — el documento impreso no debería salir
// con "Plan de Tratamiento", "PEEA" o "Análisis y Diagnóstico" en blanco.
const HC_REQUIRED_FOR_PRINT = [
  { id: 'treatmentPlanDescription', label: 'Plan de Tratamiento' },
  { id: 'peeaDescription', label: 'PEEA' },
  { id: 'analysisText', label: 'Análisis y Diagnóstico' },
];

function printHistoriaClinica() {
  const patientId = window.clivoraCurrentPatientId;
  if (!patientId) return;

  const missing = HC_REQUIRED_FOR_PRINT.filter(f => {
    // Los 3 campos son div[contenteditable].rich-text-content, no
    // input/textarea — no tienen .value (es undefined), así que
    // "!el.value.trim()" tiraba un TypeError silencioso apenas se hacía
    // clic en "Imprimir" y el botón parecía "no hacer nada". Hay que leerlos
    // con getEditableFieldValue, igual que checkHCSectionCompletion.
    const el = document.getElementById(f.id);
    return !getEditableFieldValue(el).trim();
  });
  if (missing.length > 0) {
    showClivoraAlertModal(
      `Antes de imprimir, completa: ${missing.map(f => f.label).join(', ')}.`,
      'Faltan campos obligatorios'
    );
    return;
  }

  window.open(`/clivora/api/patients/${patientId}/historia_clinica/print`, '_blank');
}

  // --- INFORMACIÓN GENERAL EDIT LOGIC ---
  document.addEventListener('click', (event) => {
    const btnEdit = event.target.closest('#btnEditInfoGeneral');
    if (btnEdit) {
      event.preventDefault();
      event.stopPropagation();
      const isCurrentlyEditing = btnEdit.classList.contains('editing');
      toggleInfoGeneralEditMode(!isCurrentlyEditing);
      return;
    }

    const btnSave = event.target.closest('#btnSaveInfoGeneral');
    if (btnSave) {
      event.preventDefault();
      saveInfoGeneral();
      return;
    }

    const btnCancel = event.target.closest('#btnCancelInfoGeneral');
    if (btnCancel) {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (patientId) {
        fetch(`/clivora/api/patients/${patientId}`).then(r => r.json())
          .then(data => populatePatientInfoGeneral(data));
      }
      toggleInfoGeneralEditMode(false);
      return;
    }

    // --- PILL EDIT BUTTONS (LÁPIZ) LOGIC ---
    const btnNac = event.target.closest('#btnEditPillNacimiento');
    if (btnNac) {
      event.preventDefault();
      event.stopPropagation();
      toggleInfoGeneralEditMode(true);
      const input = document.getElementById('detailFechaNacimiento');
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    const btnCel = event.target.closest('#btnEditPillCelular');
    if (btnCel) {
      event.preventDefault();
      event.stopPropagation();
      toggleInfoGeneralEditMode(true);
      const input = document.getElementById('detailCelular');
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    const btnMed = event.target.closest('#btnEditPillMedico');
    if (btnMed) {
      event.preventDefault();
      event.stopPropagation();
      toggleInfoGeneralEditMode(true);
      const input = document.getElementById('detailDoctor');
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
  });

  // --- CUESTIONARIO DE INGRESO ---
  document.addEventListener('click', (event) => {
    const btnSave = event.target.closest('#btnSaveCuestionario');
    if (btnSave) {
      event.preventDefault();
      saveQuestionnaire();
    }
  });

  // --- ASEGURADORAS ---
  document.addEventListener('click', (event) => {
    const btnAdd = event.target.closest('#btnAddInsurance');
    if (btnAdd) {
      event.preventDefault();
      runClivoraSaveOnce('insurance', btnAdd, addPatientInsurance);
    }
  });

  // --- SOLICITUDES DE LABORATORIO / ÓRDENES MÉDICAS ---
  document.addEventListener('click', (event) => {
    const btnAddOrder = event.target.closest('#btnAddLabOrder');
    if (btnAddOrder) {
      event.preventDefault();
      runClivoraSaveOnce('labOrder', btnAddOrder, addPatientLabOrder);
      return;
    }
    const btnOpenOrden = event.target.closest('#btnOpenCrearOrdenMedica');
    if (btnOpenOrden) {
      event.preventDefault();
      // Entrada "independiente": abierta directo desde la pestaña
      // Laboratorio, sin ninguna Nota de Oncología Médica de por medio.
      openOrdenMedicaModal(null);
      return;
    }
    const btnDiscardOrden = event.target.closest('#btnDiscardCrearOrden');
    if (btnDiscardOrden) {
      clivoraActiveLabOrderSourceConsultationId = null;
      event.preventDefault();
      const modal = document.getElementById('modalCrearOrdenMedica');
      if (modal) modal.style.display = 'none';
      return;
    }
    const btnPrintOrden = event.target.closest('#btnPrintCrearOrden');
    if (btnPrintOrden) {
      event.preventDefault();
      window.print();
      return;
    }
    const orderItem = event.target.closest('.lab-order-item');
    if (orderItem) {
      event.preventDefault();
      clivoraSelectedLabOrderId = orderItem.dataset.id;
      renderLabOrdersList();
      return;
    }
    const btnDownloadLabOrder = event.target.closest('#btnDownloadLabOrderDetail');
    if (btnDownloadLabOrder) {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (clivoraSelectedLabOrderId && patientId) {
        clivoraDownloadPdf(`/clivora/api/patients/${patientId}/lab_orders/${clivoraSelectedLabOrderId}/print`);
      }
      return;
    }
    const btnPrintLabOrder = event.target.closest('#btnPrintLabOrderDetail');
    if (btnPrintLabOrder) {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (clivoraSelectedLabOrderId && patientId) {
        window.open(`/clivora/api/patients/${patientId}/lab_orders/${clivoraSelectedLabOrderId}/print`, '_blank');
      } else {
        window.print();
      }
      return;
    }
    const btnDeleteOrder = event.target.closest('#btnDeleteLabOrderDetail');
    if (btnDeleteOrder) {
      event.preventDefault();
      (async () => {
        const id = btnDeleteOrder.dataset.id;
        if (!id) return;
        if (!(await showClivoraConfirmModal('¿Eliminar esta orden médica?'))) return;
        try {
          await fetch(`/clivora/api/lab_orders/${id}/delete`, { method: 'POST' });
          clivoraSelectedLabOrderId = null;
          await loadPatientLabOrders(window.clivoraCurrentPatientId);
        } catch (error) {
          console.error('Error al eliminar orden médica:', error);
        }
      })();
    }
    const btnEditLabOrder = event.target.closest('#btnEditLabOrderDetail');
    if (btnEditLabOrder) {
      event.preventDefault();
      const order = clivoraPatientLabOrders.find(o => String(o.id) === String(clivoraSelectedLabOrderId));
      if (order) renderLabOrderDetail(order, true);
      return;
    }
    const btnDiscardLabOrder = event.target.closest('#btnDiscardLabOrderEdit');
    if (btnDiscardLabOrder) {
      event.preventDefault();
      const order = clivoraPatientLabOrders.find(o => String(o.id) === String(clivoraSelectedLabOrderId));
      renderLabOrderDetail(order || null, false);
      return;
    }
    const btnSaveLabOrder = event.target.closest('#btnSaveLabOrderEdit');
    if (btnSaveLabOrder) {
      event.preventDefault();
      (async () => {
        if (!clivoraSelectedLabOrderId) return;
        const payload = {
          hr_employee_id: document.getElementById('editLoEmployee')?.value || false,
          observations: getEditableFieldValue(document.getElementById('editLoObservations')),
        };
        try {
          await fetch(`/clivora/api/lab_orders/${clivoraSelectedLabOrderId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          await loadPatientLabOrders(window.clivoraCurrentPatientId);
        } catch (error) {
          console.error('Error al guardar orden médica:', error);
        }
      })();
    }
  });


  // --- COMPARTIR EXPEDIENTE ---
  document.addEventListener('click', (event) => {
    const btnAdd = event.target.closest('#btnAddShare');
    if (btnAdd) {
      event.preventDefault();
      runClivoraSaveOnce('share', btnAdd, addPatientShare);
    }
  });

  // --- RECALCULAR EDAD EN TIEMPO REAL ---
  // Fase de captura (true): el calendario de Clivora (enhanceCustomDatePicker)
  // frena la propagación del 'change' de sus <input> (stopPropagation), así
  // que un listener normal en document nunca se enteraba de la fecha elegida.
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'detailFechaNacimiento') {
      const edadEl = document.getElementById('detailEdad');
      if (edadEl) {
        edadEl.value = calculateAge(e.target.value);
      }
    }
  }, true);

  // --- DOMICILIO PERSONAL EDIT LOGIC ---
  document.addEventListener('click', (event) => {
    const btnEdit = event.target.closest('#btnEditDomicilioPersonal');
    if (btnEdit) {
      event.preventDefault();
      event.stopPropagation();
      const isCurrentlyEditing = btnEdit.classList.contains('editing');
      toggleDomicilioPersonalEditMode(!isCurrentlyEditing);
      return;
    }

    const btnSave = event.target.closest('#btnSaveDomicilioPersonal');
    if (btnSave) {
      event.preventDefault();
      saveDomicilioPersonal();
      return;
    }

    const btnCancel = event.target.closest('#btnCancelDomicilioPersonal');
    if (btnCancel) {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (patientId) {
        fetch(`/clivora/api/patients/${patientId}`).then(r => r.json())
          .then(data => { populatePatientDomicilioPersonal(data); populatePatientDomicilioFiscal(data); });
      }
      toggleDomicilioPersonalEditMode(false);
      return;
    }

    if (event.target.closest('#btnCopiarDomicilioFiscal')) {
      event.preventDefault();
      copiarDomicilioPersonalAFiscal();
    }
  });

  // --- FACTURACIÓN EDIT LOGIC ---
  document.addEventListener('click', (event) => {
    const btnEdit = event.target.closest('#btnEditFacturacion');
    if (btnEdit) {
      event.preventDefault();
      event.stopPropagation();
      const isCurrentlyEditing = btnEdit.classList.contains('editing');
      toggleFacturacionEditMode(!isCurrentlyEditing);
      return;
    }

    const btnSave = event.target.closest('#btnSaveFacturacion');
    if (btnSave) {
      event.preventDefault();
      saveFacturacion();
      return;
    }

    const btnCancel = event.target.closest('#btnCancelFacturacion');
    if (btnCancel) {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (patientId) {
        fetch(`/clivora/api/patients/${patientId}`).then(r => r.json())
          .then(data => populatePatientFacturacion(data));
      }
      toggleFacturacionEditMode(false);
      return;
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'detailOrigenReferencia') {
      updateDetailReferenceFields();
    }
  });


  // --- AGENDAR CITA DESDE LA FICHA DEL PACIENTE ---
  // Mismo modal que "Agendar Cita" de la Agenda, con el paciente y su
  // médico asignado ya cargados (la especialidad sale del médico).
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#agendarCitaPacienteBtn');
    if (!btn || typeof window.openCitaModal !== 'function') return;
    const patientId = window.clivoraCurrentPatientId;
    if (!patientId) return;
    btn.disabled = true;
    try {
      const response = await fetch(`/clivora/api/patients/${patientId}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const patient = await response.json();
      const info = patient.info_general || {};
      window.openCitaModal({
        pacienteId: patient.id,
        paciente: patient.name,
        doctorId: info.doctorId || null,
        especialidadId: info.doctorSpecialtyId || null,
      });
    } catch (error) {
      console.error('Error al cargar el paciente para agendar la cita:', error);
      showClivoraAlertModal('No se pudieron cargar los datos del paciente para agendar la cita.');
    } finally {
      btn.disabled = false;
    }
  });

  // --- FICHA DE INGRESO MODAL LOGIC ---
  document.addEventListener('click', async (event) => {
    const btnFicha = event.target.closest('#fichaIngresoBtn');
    if (btnFicha) {
      const modal = document.getElementById('fichaIngresoModal');
      if (modal) {
        // Set default today's date if empty
        const dateInput = document.getElementById('fichaFechaIngreso');
        if (dateInput && !dateInput.value) {
          dateInput.value = new Date().toISOString().split('T')[0];
        }

        // Datos reales del paciente actual (antes se leían de una caché de
        // localStorage que nunca se llenaba con datos reales).
        const patientId = window.clivoraCurrentPatientId;
        let patientData = null;
        if (patientId) {
          try {
            const response = await fetch(`/clivora/api/patients/${patientId}`, { cache: 'no-store' });
            if (response.ok) patientData = await response.json();
          } catch (error) {
            console.error('Error al cargar datos del paciente para la ficha de ingreso:', error);
          }
        }

        // Check if patient already has a price list selected
        const listaSelect = document.getElementById('fichaListaPrecios');
        if (listaSelect) {
          const existingPriceList = patientData?.facturacion?.listaPrecios || '';
          const matchedOption = existingPriceList
            ? Array.from(listaSelect.options).find(
                opt => opt.value.toLowerCase() === existingPriceList.toLowerCase())
            : null;

          if (matchedOption) {
            listaSelect.value = matchedOption.value;
            listaSelect.disabled = true;
            listaSelect.classList.add('is-readonly');
          } else {
            listaSelect.value = '';
            listaSelect.disabled = false;
            listaSelect.classList.remove('is-readonly');
          }
        }

        // Pre-fill Persona Responsable from Tutor Legal (always editable)
        const personaResponsableInput = document.getElementById('fichaPersonaResponsable');
        if (personaResponsableInput) {
          const tutorLegalVal = patientData?.info_general?.tutorLegal || '';
          if (tutorLegalVal) personaResponsableInput.value = tutorLegalVal;
          personaResponsableInput.disabled = false;
          personaResponsableInput.readOnly = false;
          personaResponsableInput.classList.remove('is-readonly');
        }

        modal.classList.add('open');
      }
      return;
    }

    const closeBtn = event.target.closest('#closeFichaIngresoModal');
    if (closeBtn) {
      const modal = document.getElementById('fichaIngresoModal');
      if (modal) modal.classList.remove('open');
      return;
    }

    if (event.target.classList.contains('modal-overlay') && event.target.id === 'fichaIngresoModal') {
      event.target.classList.remove('open');
      return;
    }

    const addAlergiaBtn = event.target.closest('#btnAddAlergia');
    if (addAlergiaBtn) {
      addAlergiaRow();
      return;
    }

    const deleteAlergiaBtn = event.target.closest('.btn-delete-alergia');
    if (deleteAlergiaBtn) {
      const card = deleteAlergiaBtn.closest('.alergia-card');
      if (card) card.remove();
      return;
    }

    const printBtn = event.target.closest('#btnImprimirFicha');
    if (printBtn) {
      imprimirFichaIngreso();
      return;
    }
  });

  // Restrict emergency phone to numeric input only & auto-calculate age on birthdate change
  document.addEventListener('input', (event) => {
    if (event.target && event.target.id === 'fichaTelEmergencia') {
      event.target.value = event.target.value.replace(/[^0-9]/g, '');
    }

    if (event.target && event.target.id === 'detailFechaNacimiento') {
      updateDetailAgeFromBirthdate(event.target.value);
    }
  });
  // El calendario de Clivora (enhanceCustomDatePicker) avisa con 'change', no
  // con 'input' (ese solo llega al escribir la fecha a mano): al elegir la
  // fecha en el calendario, Edad se quedaba con el valor anterior.
  // Fase de captura (true): el calendario de Clivora (enhanceCustomDatePicker)
  // frena la propagación del 'change' de sus <input> (stopPropagation), así
  // que un listener normal en document nunca se enteraba de la fecha elegida.
  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'detailFechaNacimiento') {
      updateDetailAgeFromBirthdate(event.target.value);
    }
  }, true);

  // Handle form submission
  document.addEventListener('submit', (event) => {
    if (event.target && event.target.id === 'fichaIngresoForm') {
      event.preventDefault();
      const modal = document.getElementById('fichaIngresoModal');
      if (modal) {
        const formData = {
          fechaIngreso: document.getElementById('fichaFechaIngreso')?.value,
          listaPrecios: document.getElementById('fichaListaPrecios')?.value,
          personaResponsable: document.getElementById('fichaPersonaResponsable')?.value,
          telEmergencia: document.getElementById('fichaTelEmergencia')?.value,
          parentesco: document.getElementById('fichaParentesco')?.value,
          personalAdmision: document.getElementById('fichaPersonalAdmision')?.value,
          puesto: document.getElementById('fichaPuesto')?.value,
          comentarios: getEditableFieldValue(document.getElementById('fichaComentarios')),
          alergias: Array.from(document.querySelectorAll('#alergiasContainer .alergia-card')).map(card => ({
            descripcion: card.querySelector('.alergia-desc')?.value || '',
            reaccion: card.querySelector('.alergia-reaccion')?.value || '',
            observaciones: card.querySelector('.alergia-obs')?.value || ''
          }))
        };

        console.log('Ficha de Ingreso guardada:', formData);
        const overlay = document.getElementById('fichaIngresoSuccessOverlay');
        if (overlay) {
          overlay.style.display = 'flex';
          setTimeout(() => {
            modal.classList.remove('open');
            overlay.style.display = 'none';
          }, 1400);
        }
      }
    }
  });

  // --- UPLOAD PATIENT FILE MODAL LOGIC & ARCHIVOS EVENT HANDLERS ---
  function getActivePatientExp() {
    return document.getElementById('detailPatientExp')?.textContent?.replace(/[^0-9]/g, '') || '00180';
  }

  document.addEventListener('click', (event) => {
    // El dropzone de "Archivos HC" (#hcDropzone) se quitó del HTML — la
    // subida estructurada solo se abre desde la pestaña ARCHIVOS.
    const btnOpen = event.target.closest('#btnOpenUploadFileModal');
    if (btnOpen) {
      event.preventDefault();
      const modal = document.getElementById('uploadPatientFileModal');
      const form = document.getElementById('uploadPatientFileForm');
      if (form) form.reset();
      // form.reset() no dispara 'change': el select personalizado de Tipo
      // de documento se quedaba mostrando el tipo anterior (ej. "Recetas")
      // mientras el <select> real ya estaba vacío, y como es required el
      // navegador bloqueaba el segundo guardado sin mostrar ningún aviso
      // (el <select> nativo está oculto) hasta recargar la página.
      document.getElementById('uploadFileType')?.dispatchEvent(new Event('change', { bubbles: true }));
      // form.reset() no limpia el div[contenteditable] de Comentarios.
      setEditableFieldValue(document.getElementById('uploadFileComments'), '');
      const nameDisplay = document.getElementById('uploadFileNameDisplay');
      if (nameDisplay) nameDisplay.textContent = 'Seleccionar o arrastrar archivo aquí';
      if (modal) modal.style.display = 'flex';
      return;
    }

    const btnCancel = event.target.closest('#btnCancelUploadPatientFile');
    if (btnCancel) {
      event.preventDefault();
      const modal = document.getElementById('uploadPatientFileModal');
      if (modal) modal.style.display = 'none';
      return;
    }

    if (event.target.classList.contains('modal-overlay') && event.target.id === 'uploadPatientFileModal') {
      event.target.style.display = 'none';
      return;
    }

    // Botones de Descarga por Selección y Descarga Total
    const btnDlSelected = event.target.closest('#btnDownloadSelectedArchivos');
    if (btnDlSelected) {
      event.preventDefault();
      const checkedBoxes = Array.from(document.querySelectorAll('.file-card-checkbox:checked'));
      if (checkedBoxes.length === 0) {
        showClivoraAlertModal('Por favor selecciona al menos un archivo con su casilla de verificación.');
        return;
      }
      const selectedFiles = checkedBoxes.map(cb => {
        const fileId = cb.dataset.fileId;
        return clivoraPatientFiles.find(f => String(f.id) === String(fileId));
      }).filter(Boolean);

      downloadMultipleFiles(selectedFiles);
      return;
    }

    const btnDlAll = event.target.closest('#btnDownloadAllArchivos');
    if (btnDlAll) {
      event.preventDefault();
      downloadMultipleFiles(clivoraPatientFiles);
      return;
    }

    const btnShareArchivos = event.target.closest('#btnShareSelectedArchivos');
    if (btnShareArchivos) {
      event.preventDefault();
      if (getArchivoFilesSeleccionados().length === 0) {
        showClivoraAlertModal('Por favor selecciona al menos un archivo con su casilla de verificación.');
        return;
      }
      // Antes esto mandaba a la pestaña interna "Compartir expediente"
      // (acceso de doctor, sin generar ningún link) — ahora abre el modal
      // de compartir por WhatsApp/Facebook (ver compartirPorPlataforma
      // y Mejoras/Modal Compartir archivo.txt). getArchivoFilesSeleccionados()
      // vuelve a leer las casillas marcadas al momento de compartir, así
      // que no hace falta guardar nada aquí.
      const shareStatusAlert = document.getElementById('shareStatusAlert');
      if (shareStatusAlert) shareStatusAlert.style.display = 'none';
      const modalCompartir = document.getElementById('modalCompartirArchivos');
      if (modalCompartir) modalCompartir.style.display = 'flex';
      return;
    }

    // El botón Cancelar de este modal ya cierra vía su onclick inline (ver
    // Mejoras/Modal Compartir archivo.txt) — aquí solo se cubre el
    // clic fuera de la tarjeta, igual que el resto de los modales de esta
    // página.
    if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalCompartirArchivos') {
      event.target.style.display = 'none';
      return;
    }
  });

  // Filtros de búsqueda en tiempo real e input de archivo
  document.addEventListener('input', (event) => {
    if (event.target && event.target.id === 'searchFileInput') {
      renderArchivosList();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'filterFileType') {
      renderArchivosList();
      return;
    }

    if (event.target && event.target.id === 'selectAllArchivosCheckbox') {
      const isChecked = event.target.checked;
      document.querySelectorAll('.file-card-checkbox').forEach(cb => {
        cb.checked = isChecked;
      });
      return;
    }

    if (event.target && event.target.id === 'uploadFileInput') {
      const file = event.target.files[0];
      const nameDisplay = document.getElementById('uploadFileNameDisplay');
      if (nameDisplay) {
        if (file) {
          const sizeKb = (file.size / 1024).toFixed(1);
          nameDisplay.textContent = `${file.name} (${sizeKb} KB)`;
        } else {
          nameDisplay.textContent = 'Seleccionar o arrastrar archivo aquí';
        }
      }
    }

    if (event.target && event.target.id === 'insFile') {
      const file = event.target.files[0];
      const nameDisplay = document.getElementById('insFileNameDisplay');
      if (nameDisplay) nameDisplay.textContent = file ? file.name : 'Seleccionar o arrastrar archivo';
    }
  });

  // Form submit: lee el archivo con FileReader (Data URL) y lo manda al
  // backend real, no a localStorage.
  document.addEventListener('submit', (event) => {
    if (event.target && event.target.id === 'uploadPatientFileForm') {
      event.preventDefault();
      const fileType = document.getElementById('uploadFileType')?.value || '';
      const title = document.getElementById('uploadFileTitle')?.value?.trim() || '';
      const comments = getEditableFieldValue(document.getElementById('uploadFileComments'));
      const cycle = document.getElementById('uploadFileCycle')?.value?.trim() || '';
      const dateCycle = document.getElementById('uploadFileDateCycle')?.value || '';
      const fee = document.getElementById('uploadFileFee')?.checked || false;
      const feeCycle = parseFloat(document.getElementById('uploadFileFeeCycle')?.value) || 0;
      const treatmentPrimary = document.getElementById('uploadFileTreatmentPrimary')?.checked || false;
      const sharePatient = document.getElementById('uploadFileSharePatient')?.checked || false;
      const fileInput = document.getElementById('uploadFileInput');
      const file = fileInput?.files[0];
      const patientId = window.clivoraCurrentPatientId;

      if (!fileType) {
        showClivoraAlertModal('Por favor seleccione un Tipo de documento.');
        return;
      }
      if (!title) {
        showClivoraAlertModal('Por favor ingrese el Título del documento.');
        return;
      }
      if (!patientId) {
        showClivoraAlertModal('No se pudo identificar al paciente activo.');
        return;
      }

      const saveRecord = async (dataUrl) => {
        const btnSave = document.getElementById('btnSaveUploadPatientFile');
        if (btnSave) btnSave.disabled = true;
        try {
          const response = await fetch(`/clivora/api/patients/${patientId}/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: fileType,
              type_document: fileType,
              title,
              comment: comments,
              cycle,
              date_cycle: dateCycle,
              fee,
              fee_cycle: feeCycle,
              treatment_primary: treatmentPrimary,
              share_patient: sharePatient,
              file: dataUrl || '',
            }),
          });
          if (!response.ok) throw new Error('save failed');
          await loadPatientFiles(patientId);
          const modal = document.getElementById('uploadPatientFileModal');
          if (modal) modal.style.display = 'none';
        } catch (error) {
          console.error('Error al guardar el archivo:', error);
          showClivoraAlertModal('No se pudo guardar el archivo. Intente de nuevo.');
        } finally {
          if (btnSave) btnSave.disabled = false;
        }
      };

      runClivoraSaveOnce('patientFile', document.getElementById('btnSaveUploadPatientFile'),
        async () => saveRecord(file ? await readFileAsDataUrl(file) : null));
    }
  });

  // --- NUEVA CONSULTA & SIGNOS VITALES MODAL LOGIC ---
  function updateSignosVitalesCalculations() {
    computeBsaImc('svPeso', 'svAltura', 'svSuperficieCorporal', 'svIMC');
  }

  document.addEventListener('input', (event) => {
    if (event.target && (event.target.id === 'svPeso' || event.target.id === 'svAltura')) {
      updateSignosVitalesCalculations();
    }
    // Misma fórmula, pero para la tarjeta de edición de Signos Vitales del
    // panel derecho (ids "edit*", independientes de los del modal de
    // creación "sv*").
    if (event.target && (event.target.id === 'editPeso' || event.target.id === 'editAltura')) {
      computeBsaImc('editPeso', 'editAltura', 'editBSA', 'editIMC');
    }
    // Registro Clínico de Enfermería: mismo cálculo, tarjeta de creación
    // (nc*) y de edición de una nota ya guardada (edNc*).
    if (event.target && (event.target.id === 'ncPeso' || event.target.id === 'ncTalla')) {
      computeBsaImc('ncPeso', 'ncTalla', 'ncBSA', 'ncIMC');
    }
    if (event.target && event.target.closest && (event.target.classList.contains('nc-vs-peso') || event.target.classList.contains('nc-vs-talla'))) {
      const vsRow = event.target.closest('.nc-vital-sign-row');
      if (vsRow) {
        const peso = parseFloat(vsRow.querySelector('.nc-vs-peso')?.value);
        const alturaCm = parseFloat(vsRow.querySelector('.nc-vs-talla')?.value);
        const bsaEl = vsRow.querySelector('.nc-vs-bsa');
        const imcEl = vsRow.querySelector('.nc-vs-imc');
        if (peso > 0 && alturaCm > 0) {
          bsaEl.value = (0.007184 * Math.pow(peso, 0.425) * Math.pow(alturaCm, 0.725)).toFixed(2) + ' m²';
          const alturaM = alturaCm > 3 ? alturaCm / 100 : alturaCm;
          imcEl.value = (peso / (alturaM * alturaM)).toFixed(2) + ' kg/m²';
        } else {
          bsaEl.value = '';
          imcEl.value = '';
        }
      }
    }
    if (event.target && (event.target.id === 'edNcPeso' || event.target.id === 'edNcTalla')) {
      computeBsaImc('edNcPeso', 'edNcTalla', 'edNcBSA', 'edNcIMC');
    }
    if (event.target && event.target.id === 'searchConsultaInput') {
      renderPatientConsultas(getActivePatientExp());
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'filterConsultaType') {
      renderPatientConsultas(getActivePatientExp());
    }
  });

  document.addEventListener('click', async (event) => {
    const btnOpenNueva = event.target.closest('#btnOpenNuevaConsultaModal');
    if (btnOpenNueva) {
      event.preventDefault();
      const modal = document.getElementById('nuevaConsultaModal');
      if (modal) modal.style.display = 'flex';
      return;
    }

    const btnCloseNueva = event.target.closest('#closeNuevaConsultaModal');
    if (btnCloseNueva) {
      event.preventDefault();
      const modal = document.getElementById('nuevaConsultaModal');
      if (modal) modal.style.display = 'none';
      return;
    }

    if (event.target.classList.contains('modal-overlay') && event.target.id === 'nuevaConsultaModal') {
      event.target.style.display = 'none';
      return;
    }

    const consultaBtn = event.target.closest('.consulta-type-btn');
    if (consultaBtn) {
      event.preventDefault();
      const type = consultaBtn.dataset.type || 'Consulta Médica';
      const nuevaModal = document.getElementById('nuevaConsultaModal');
      if (nuevaModal) nuevaModal.style.display = 'none';

      if (type === 'Signos vitales') {
        const modalSV = document.getElementById('modalSignosVitales');
        const formSV = document.getElementById('formSignosVitales');
        const successOverlay = document.getElementById('signosVitalesSuccessOverlay');
        if (successOverlay) successOverlay.style.display = 'none';
        if (formSV) formSV.reset();
        const bsaInput = document.getElementById('svSuperficieCorporal');
        const imcInput = document.getElementById('svIMC');
        if (bsaInput) bsaInput.value = '';
        if (imcInput) imcInput.value = '';
        // formSV.reset() no toca el div[contenteditable] de Comentarios (no
        // es un control de formulario nativo) — se limpia aparte.
        setEditableFieldValue(document.getElementById('svComentarios'), '');
        await populatePatientHeaderInfo('sv');
        if (modalSV) modalSV.style.display = 'flex';
      } else if (type === 'Nota de oncología médica') {
        openNotaOncologiaModal();
      } else if (type === 'Notas de enfermeria') {
        // Enfermería necesita el reporte de entrada (Evaluación Inicial) o
        // el de salida (Registro Clínico) — se elige el formato primero.
        const modalFormato = document.getElementById('modalSeleccionFormatoEnfermeria');
        if (modalFormato) modalFormato.style.display = 'flex';
      } else if (NOTA_CLINICA_TYPES[type]) {
        openNotaClinicaModal(type);
      } else {
        showClivoraAlertModal(`"${type}" todavía no tiene un formulario propio en esta página — estará disponible próximamente.`);
      }
      return;
    }

    // --- MANEJADORES DE LA NOTA DE ONCOLOGÍA MÉDICA ---
    // Acordeones Plegables
    const accHeader = event.target.closest('.onco-accordion-header');
    if (accHeader) {
      event.preventDefault();
      const targetId = accHeader.dataset.target;
      const content = document.getElementById(targetId);
      const chevron = accHeader.querySelector('.chevron');
      if (content) {
        const isCollapsed = accHeader.classList.contains('collapsed');
        if (isCollapsed) {
          accHeader.classList.remove('collapsed');
          content.style.display = 'block';
          if (chevron) chevron.style.transform = 'rotate(0deg)';
        } else {
          accHeader.classList.add('collapsed');
          content.style.display = 'none';
          if (chevron) chevron.style.transform = 'rotate(180deg)';
        }
      }
      return;
    }

    // Botones de Grabación de Audio
    const btnAudio = event.target.closest('.btn-record-audio');
    if (btnAudio) {
      event.preventDefault();
      const targetInputId = btnAudio.dataset.targetInput;
      const input = document.getElementById(targetInputId);
      const isRecording = btnAudio.classList.contains('recording');
      
      if (isRecording) {
        btnAudio.classList.remove('recording');
        btnAudio.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Grabar audio`;
      } else {
        btnAudio.classList.add('recording');
        btnAudio.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="color:#EF4444;"><circle cx="12" cy="12" r="10"/></svg> Grabando... Clic para finalizar`;
        setTimeout(() => {
          if (input && btnAudio.classList.contains('recording')) {
            btnAudio.classList.remove('recording');
            btnAudio.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Grabar audio`;
            const audioText = "[Dictado por voz]: Paciente evoluciona de manera satisfactoria sin complicaciones agudas.";
            const current = getEditableFieldValue(input);
            setEditableFieldValue(input, current ? current + '<br>' + audioText : audioText);
          }
        }, 3000);
      }
      return;
    }

    // Agregar Fila de Diagnóstico
    const btnAddDiag = event.target.closest('#btnAddOncoDiagRow');
    if (btnAddDiag) {
      event.preventDefault();
      const tbody = document.getElementById('tbodyOncoDiagnosticos');
      if (tbody) {
        tbody.insertAdjacentHTML('beforeend', buildEdOncoDiagRowHtml());
        const tr = tbody.lastElementChild;
        attachCie11Search(tr.querySelector('.onco-diag-codigo'));
        enhanceCustomSelect(tr.querySelector('select.custom-select'));
      }
      return;
    }

    // Eliminar Fila
    const btnRemoveRow = event.target.closest('.btn-remove-row');
    if (btnRemoveRow) {
      event.preventDefault();
      const tr = btnRemoveRow.closest('tr');
      if (tr) tr.remove();
      return;
    }

    // Botones "RECETA ONCOLÓGICA" / "NOTA ONCOLÓGICA" de la sección 13 (Plan
    // de Tratamiento y Pronóstico) — antes eran <button class="btn-add-repetable">
    // sin id ni listener, igual que el resto de esa clase en la página. El
    // segundo botón conserva el id "btnPlanTratamientoSolicitudLab" de
    // cuando decía "Solicitud de Laboratorio"; su label se cambió a "Nota
    // Oncológica" pero el listener se quedó mandando a Órdenes Médicas en
    // vez de abrir la Nota de Oncología Médica.
    const btnPlanReceta = event.target.closest('#btnPlanTratamientoReceta');
    if (btnPlanReceta) {
      event.preventDefault();
      goToExpedienteSubTab('tab-recetas');
      openRecetaOncologicaModal();
      return;
    }
    const btnPlanNotaOnco = event.target.closest('#btnPlanTratamientoSolicitudLab');
    if (btnPlanNotaOnco) {
      event.preventDefault();
      goToExpedienteSubTab('tab-consultas');
      openNotaOncologiaModal();
      return;
    }
    const btnClearForecast = event.target.closest('#btnClearTreatmentPlanForecast');
    if (btnClearForecast) {
      event.preventDefault();
      const select = document.getElementById('treatmentPlanForecast');
      if (select) {
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    // Botones de Acciones Especiales: Receta y Solicitud de Laboratorio
    // "Generar Receta Médica" (a diferencia de "+ Agregar Nueva Receta
    // Independiente", que sigue agregando una fila más a la tarjeta de
    // recetas EMBEBIDA en esta misma nota) abre el modal dedicado de Receta
    // Médica — mismo criterio que "Receta Oncológica" — y la deja vinculada
    // a esta Nota de Oncología Médica (ver ensureOncoNotaSaved).
    const btnAgregarReceta = event.target.closest('#btnAgregarRecetaOnco');
    if (btnAgregarReceta) {
      event.preventDefault();
      (async () => {
        const consultationId = await ensureOncoNotaSaved();
        if (!consultationId) return;
        openRecetaMedicaModal('create', null, consultationId);
      })();
      return;
    }
    const btnNuevaRecetaIndep = event.target.closest('#btnNuevaRecetaIndependiente');
    if (btnNuevaRecetaIndep) {
      event.preventDefault();
      agregarRecetaCardOnco();
      return;
    }

    // Antes mostraba un modal de confirmación ("¿Ir a Órdenes Médicas?") que
    // sacaba al médico de la nota hacia la pestaña Laboratorio sin dejar
    // ningún registro de que esa orden venía de esta nota. Ahora abre el
    // modal dedicado de Orden Médica directo (mismo criterio que Receta
    // Oncológica) y la deja vinculada a esta Nota de Oncología Médica.
    const btnSolicitudLab = event.target.closest('#btnOrdenesMedicasOnco');
    if (btnSolicitudLab) {
      event.preventDefault();
      (async () => {
        const consultationId = await ensureOncoNotaSaved();
        if (!consultationId) return;
        openOrdenMedicaModal(consultationId);
      })();
      return;
    }

    const btnLabSeguirEditando = event.target.closest('#btnLabSeguirEditando');
    if (btnLabSeguirEditando) {
      event.preventDefault();
      const modalConfirm = document.getElementById('modalLabConfirmOnco');
      if (modalConfirm) modalConfirm.style.display = 'none';
      return;
    }

    const btnGoToLab = event.target.closest('#btnGoToLabNow');
    if (btnGoToLab) {
      event.preventDefault();
      const modalConfirm = document.getElementById('modalLabConfirmOnco');
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      const successOverlay = document.getElementById('labConfirmSuccessOverlay');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalConfirm) modalConfirm.style.display = 'none';
      if (modalOnco) modalOnco.style.display = 'none';
      goToExpedienteSubTab('tab-laboratorio');
      return;
    }

    const btnLabGuardarYContinuar = event.target.closest('#btnLabGuardarYContinuar');
    if (btnLabGuardarYContinuar) {
      event.preventDefault();
      const formOnco = document.getElementById('formNotaOncologia');
      if (formOnco) {
        formOnco.requestSubmit();
      }

      // Desplegar pantalla de guardado con éxito
      const successOverlay = document.getElementById('labConfirmSuccessOverlay');
      if (successOverlay) {
        successOverlay.style.display = 'flex';
      }

      // Redirigir a solicitudes de laboratorio
      setTimeout(() => {
        const modalConfirm = document.getElementById('modalLabConfirmOnco');
        const modalOnco = document.getElementById('modalNotaOncologiaMedica');
        if (modalConfirm && modalConfirm.style.display !== 'none') {
          if (successOverlay) successOverlay.style.display = 'none';
          modalConfirm.style.display = 'none';
          if (modalOnco) modalOnco.style.display = 'none';
          goToExpedienteSubTab('tab-laboratorio');
        }
      }, 1300);
      return;
    }

    const btnLabIrSinGuardar = event.target.closest('#btnLabIrSinGuardar');
    if (btnLabIrSinGuardar) {
      event.preventDefault();
      const modalConfirm = document.getElementById('modalLabConfirmOnco');
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      if (modalConfirm) modalConfirm.style.display = 'none';
      if (modalOnco) modalOnco.style.display = 'none';
      goToExpedienteSubTab('tab-laboratorio');
      return;
    }

    // Botones Header Nota Oncología: Atrás, Descartar, Imprimir
    const btnBackOnco = event.target.closest('#btnBackNotaOnco');
    if (btnBackOnco) {
      event.preventDefault();
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      const nuevaModal = document.getElementById('nuevaConsultaModal');
      if (modalOnco) modalOnco.style.display = 'none';
      if (nuevaModal) nuevaModal.style.display = 'flex';
      return;
    }

    const btnDiscardOnco = event.target.closest('#btnDiscardNotaOnco');
    if (btnDiscardOnco) {
      event.preventDefault();
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      if (modalOnco) modalOnco.style.display = 'none';
      return;
    }

    const btnDownloadNotaOnco = event.target.closest('#btnDownloadNotaOnco');
    if (btnDownloadNotaOnco) {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (clivoraActiveOncoConsultationId && patientId) {
        clivoraDownloadPdf(`/clivora/api/patients/${patientId}/consultations/oncology/${clivoraActiveOncoConsultationId}/print`);
      } else {
        showClivoraAlertModal('Guarda la nota antes de descargar su PDF.');
      }
      return;
    }
    const btnPrintOnco = event.target.closest('#btnPrintNotaOnco');
    if (btnPrintOnco) {
      event.preventDefault();
      // Mismo criterio que btnPrintRecipeHeader: si la nota ya se guardó
      // (clivoraActiveOncoConsultationId viene de ensureOncoNotaSaved/
      // openNotaOncologiaModal al reabrir una nota existente), abre el PDF
      // real (reporte PDF de nota oncológica); si es una nota
      // nueva que todavía no existe en la BD, no hay registro que imprimir
      // todavía, así que se cae al window.print() de la página.
      const patientId = window.clivoraCurrentPatientId;
      if (clivoraActiveOncoConsultationId && patientId) {
        window.open(`/clivora/api/patients/${patientId}/consultations/oncology/${clivoraActiveOncoConsultationId}/print`, '_blank');
      } else {
        window.print();
      }
      return;
    }

    // Overlay de Éxito Nota Oncología
    const btnNextNewOnco = event.target.closest('#btnNextNewOnco');
    if (btnNextNewOnco) {
      event.preventDefault();
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      const successOverlay = document.getElementById('oncoSuccessOverlay');
      const nuevaModal = document.getElementById('nuevaConsultaModal');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalOnco) modalOnco.style.display = 'none';
      if (nuevaModal) nuevaModal.style.display = 'flex';
      return;
    }

    // "Crear otro registro" e "Ir a Órdenes Médicas" son los dos únicos
    // siguientes pasos que ofrecía este overlay — ninguno de los dos deja
    // simplemente cerrar y quedarse viendo la nota recién guardada (la otra
    // pestaña, "Notas", requiere salir del modal a mano). "Ver Nota" cierra
    // este modal y abre la nota ya guardada en su tarjeta de edición real
    // (mismo openConsultaCard que usa la pestaña Notas al hacer clic en
    // cualquier tarjeta), igual que "Ver receta médica" en el overlay de
    // Receta Médica.
    const btnNextViewNotaOnco = event.target.closest('#btnNextViewNotaOnco');
    if (btnNextViewNotaOnco) {
      event.preventDefault();
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      const successOverlay = document.getElementById('oncoSuccessOverlay');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalOnco) modalOnco.style.display = 'none';
      (async () => {
        goToExpedienteSubTab('tab-consultas');
        const patientId = window.clivoraCurrentPatientId;
        if (patientId) await loadPatientConsultas(patientId);
        const saved = clivoraPatientConsultas.find(
          c => c.source === 'consultation' && c.consultation_id === clivoraActiveOncoConsultationId);
        if (saved) openConsultaCard(saved);
      })();
      return;
    }

    const btnNextViewConsultasOnco = event.target.closest('#btnNextViewConsultasOnco');
    if (btnNextViewConsultasOnco) {
      event.preventDefault();
      const modalOnco = document.getElementById('modalNotaOncologiaMedica');
      const successOverlay = document.getElementById('oncoSuccessOverlay');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalOnco) modalOnco.style.display = 'none';
      goToExpedienteSubTab('tab-laboratorio');
      return;
    }

    // Botón Retroceder a Nueva Consulta desde Signos Vitales
    const btnBackSV = event.target.closest('#btnBackSignosVitales');
    if (btnBackSV) {
      event.preventDefault();
      const modalSV = document.getElementById('modalSignosVitales');
      const nuevaModal = document.getElementById('nuevaConsultaModal');
      if (modalSV) modalSV.style.display = 'none';
      if (nuevaModal) nuevaModal.style.display = 'flex';
      return;
    }

    // Botón Imprimir Signos Vitales
    const btnPrintSV = event.target.closest('#btnPrintSignosVitales');
    if (btnPrintSV) {
      event.preventDefault();
      window.print();
      return;
    }

    // Botones de Siguiente Paso en Overlay de Éxito
    const btnNextNew = event.target.closest('#btnNextNewConsulta');
    if (btnNextNew) {
      event.preventDefault();
      const modalSV = document.getElementById('modalSignosVitales');
      const successOverlay = document.getElementById('signosVitalesSuccessOverlay');
      const nuevaModal = document.getElementById('nuevaConsultaModal');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalSV) modalSV.style.display = 'none';
      if (nuevaModal) nuevaModal.style.display = 'flex';
      return;
    }

    const btnNextView = event.target.closest('#btnNextViewConsultas');
    if (btnNextView) {
      event.preventDefault();
      const modalSV = document.getElementById('modalSignosVitales');
      const successOverlay = document.getElementById('signosVitalesSuccessOverlay');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalSV) modalSV.style.display = 'none';
      renderPatientConsultas(getActivePatientExp());
      return;
    }

    const btnCancelSV = event.target.closest('#btnCancelSignosVitales');
    if (btnCancelSV) {
      event.preventDefault();
      const modalSV = document.getElementById('modalSignosVitales');
      const successOverlay = document.getElementById('signosVitalesSuccessOverlay');
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalSV) modalSV.style.display = 'none';
      return;
    }

    if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalSignosVitales') {
      const successOverlay = document.getElementById('signosVitalesSuccessOverlay');
      if (successOverlay) successOverlay.style.display = 'none';
      event.target.style.display = 'none';
      return;
    }

    // --- MODAL 4: NOTA CLÍNICA ---
    const btnSaveNC = event.target.closest('#btnSaveNotaClinica');
    if (btnSaveNC) {
      event.preventDefault();
      runClivoraSaveOnce('notaClinica', btnSaveNC, saveNotaClinica);
      return;
    }
    const btnCancelNC = event.target.closest('#btnCancelNotaClinica');
    if (btnCancelNC) {
      event.preventDefault();
      const modal = document.getElementById('modalNotaClinica');
      if (modal) modal.style.display = 'none';
      return;
    }
    const btnPrintNC = event.target.closest('#btnPrintNotaClinica');
    if (btnPrintNC) {
      event.preventDefault();
      window.print();
      return;
    }
    const btnBackNC = event.target.closest('#btnBackNotaClinica');
    if (btnBackNC) {
      event.preventDefault();
      const modal = document.getElementById('modalNotaClinica');
      // "Notas de enfermeria" no se abre desde Nueva Consulta directamente
      // como los otros 4 tipos de este mismo modal — pasa primero por
      // "Seleccionar Formato de Enfermería" (Evaluación Inicial / Registro
      // Clínico), así que Atrás debe volver ahí y no a Nueva Consulta.
      const isEnfermeria = modal?.dataset.noteType === 'Notas de enfermeria';
      const targetModal = document.getElementById(
        isEnfermeria ? 'modalSeleccionFormatoEnfermeria' : 'nuevaConsultaModal');
      if (modal) modal.style.display = 'none';
      if (targetModal) targetModal.style.display = 'flex';
      return;
    }
    if (event.target.classList.contains('modal-overlay') && event.target.id === 'modalNotaClinica') {
      if (Date.now() < clivoraSuppressOutsideCloseUntil) return;
      if (document.querySelector('.custom-date-container.is-open, .custom-select-container.is-open')) {
        return;
      }
      event.target.style.display = 'none';
      return;
    }
  });

  // --- NOTA DE ONCOLOGÍA MÉDICA FUNCIONES Y LÓGICA ---
  async function openNotaOncologiaModal() {
    const modalOnco = document.getElementById('modalNotaOncologiaMedica');
    const formOnco = document.getElementById('formNotaOncologia');
    const successOverlay = document.getElementById('oncoSuccessOverlay');

    // Nota nueva en blanco: cualquier vínculo de una nota anterior (creada
    // en una apertura previa de este mismo modal) queda descartado — ver
    // ensureOncoNotaSaved/clivoraActiveOncoConsultationId.
    clivoraActiveOncoConsultationId = null;
    renderOncoLinkedDocuments('oncoLinkedDocsContainer', []);

    if (successOverlay) successOverlay.style.display = 'none';
    if (formOnco) formOnco.reset();
    const tbodyDiag = document.getElementById('tbodyOncoDiagnosticos');
    if (tbodyDiag) tbodyDiag.innerHTML = '';
    // oncoIndicacionesMedicas/oncoComentario son <textarea> normales — sí
    // los limpia formOnco.reset() de arriba. oncoAnalisisClinico sigue
    // siendo un div[contenteditable] (no es un control de formulario
    // nativo), por eso ese sí necesita limpiarse aparte.
    setEditableFieldValue(document.getElementById('oncoAnalisisClinico'), '');

    // Se limpia acá (antes de precargar la Receta Médica de la nota anterior
    // más abajo) — antes este reset vivía al final de la función y borraba
    // las tarjetas recién precargadas.
    const recetasContainer = document.getElementById('recetasContainer');
    if (recetasContainer) recetasContainer.innerHTML = '';
    const btnIndepReset = document.getElementById('btnNuevaRecetaIndependiente');
    if (btnIndepReset) btnIndepReset.style.display = 'none';

    const currentExp = getActivePatientExp();
    const activePatientName = document.getElementById('detailPatientName')?.textContent?.trim() || 'Paciente';
    const subtitle = document.getElementById('oncoPatientSubtitle');
    if (subtitle) {
      subtitle.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -2px; margin-right: 4px;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Paciente: ${activePatientName} (Expediente: ${currentExp})`;
    }

    // Datos Generales del Paciente e Ingreso: mismo bloque/lógica compartida
    // con las Recetas Médica y Oncológica (ver populatePatientHeaderInfo).
    await populatePatientHeaderInfo('onco');

    // Signos Vitales Actuales: el registro real más reciente del paciente
    // (antes se leía de una caché de localStorage que nunca se llenaba con
    // datos reales, así que nunca se autocompletaba nada).
    const patientId = window.clivoraCurrentPatientId;
    let latestSV = null;
    if (patientId) {
      let lastNota = null;
      try {
        const response = await fetch(`/clivora/api/patients/${patientId}/consultations`, { cache: 'no-store' });
        if (response.ok) {
          const consultas = await response.json();
          latestSV = consultas.find(c => c.source === 'vitals') || null;
          // La lista ya viene ordenada de más reciente a más antigua (ver
          // clivora_patient_consultations) — la primera con
          // source==='consultation' es la última Nota de Oncología Médica.
          lastNota = consultas.find(c => c.source === 'consultation') || null;
        }
      } catch (error) {
        console.error('Error al cargar consultas para nota de oncología:', error);
      }

      // SOAP (PEEA): siempre se trae de la sección PEEA de la Historia
      // Clínica del paciente (peea_description), nunca de una Nota de
      // Oncología anterior — a diferencia del resto de este bloque
      // (diagnósticos, ciclo, Notas), la PEEA describe el estado ACTUAL del
      // paciente y vive en un solo lugar (Historia Clínica); traerla de una
      // nota vieja la dejaría desactualizada apenas alguien edite la PEEA
      // de Historia Clínica sin volver a abrir Oncología. Antes ni siquiera
      // leía el campo correcto: en la primera nota de un paciente (sin nota
      // previa) precargaba hc.hc_analysis ("Análisis y Diagnóstico", otra
      // sección de Historia Clínica) en vez de hc.peea_description.
      try {
        const responseHc = await fetch(`/clivora/api/patients/${patientId}`, { cache: 'no-store' });
        if (responseHc.ok) {
          const patientData = await responseHc.json();
          const hc = patientData.historia_clinica || {};
          setEditableFieldValue(document.getElementById('oncoAnalisisClinico'), hc.peea_description || '');
        }
      } catch (error) {
        console.error('Error al cargar la PEEA de historia clínica para nota de oncología:', error);
      }

      if (lastNota) {
        // Al crear una nota nueva, el resto de lo clínico (diagnósticos,
        // ciclo y Notas) se precarga igual que en la última Nota de
        // Oncología Médica del paciente — así el médico solo edita lo que
        // cambió en vez de volver a escribir todo. Signos Vitales y Datos
        // Generales del Paciente NO se tocan aquí: esos siempre reflejan la
        // información actual del paciente (ver mapSV y
        // populatePatientHeaderInfo más arriba).
        const oncoNotasCarryEl = document.getElementById('oncoIndicacionesMedicas');
        if (oncoNotasCarryEl) oncoNotasCarryEl.value = htmlToTextareaValue(lastNota.indicaciones);

        const oncoCicloEl = document.getElementById('oncoCiclo');
        if (oncoCicloEl) oncoCicloEl.value = lastNota.treatmentCycle || '';

        // Receta Médica de la nota anterior (Acciones Especiales): igual
        // criterio que el resto de este bloque — se precarga para que el
        // médico solo edite lo que cambió en vez de rehacer la receta.
        prefillRecetasFromLastNota(lastNota.recetas);
      }

      // Diagnósticos: siempre desde los de Historia Clínica (con su comentario), igual que la PEEA.
      try {
        const responseDiag = await fetch(`/clivora/api/patients/${patientId}/diagnosis_lines`, { cache: 'no-store' });
        if (responseDiag.ok) {
          const diagLines = await responseDiag.json();
          const tbodyDiagPrefill = document.getElementById('tbodyOncoDiagnosticos');
          if (tbodyDiagPrefill) {
            tbodyDiagPrefill.innerHTML = diagLines.map(d => buildEdOncoDiagRowHtml({
              codigo: d.diagnosis, cie11_diagnosis_id: d.cie11_diagnosis_id, comment: d.comment,
            })).join('');
            tbodyDiagPrefill.querySelectorAll('.onco-diag-codigo').forEach(attachCie11Search);
            tbodyDiagPrefill.querySelectorAll('select.custom-select').forEach(enhanceCustomSelect);
          }
        }
      } catch (error) {
        console.error('Error al cargar diagnósticos de historia clínica para nota de oncología:', error);
      }
    }

    const mapSV = [
      { id: 'oncoSistolica', val: latestSV?.sistolica || '' },
      { id: 'oncoDiastolica', val: latestSV?.diastolica || '' },
      { id: 'oncoFC', val: latestSV?.fc || '' },
      { id: 'oncoFR', val: latestSV?.fr || '' },
      { id: 'oncoTemp', val: latestSV?.temperatura || '' },
      { id: 'oncoSat', val: latestSV?.saturacion || '' },
      { id: 'oncoPeso', val: latestSV?.peso || '' },
      { id: 'oncoAltura', val: latestSV?.altura || '' },
      { id: 'oncoBSA', val: latestSV?.bsa || '' },
      { id: 'oncoIMC', val: latestSV?.imc || '' }
    ];

    mapSV.forEach(item => {
      const el = document.getElementById(item.id);
      if (el) {
        el.value = item.val;
        el.readOnly = !!item.val;
        if (item.val) {
          el.style.background = 'var(--bg-main)';
        } else {
          el.style.background = 'var(--bg-card)';
        }
      }
    });

    if (modalOnco) modalOnco.style.display = 'flex';
  }
  // Se expone en window: el modal "Seleccionar Tipo de Receta" (pestaña
  // Recetas Médicas) necesita abrir esta misma nota de oncología desde
  // fuera de este cierre (closure) — sin esto, la llamada de allá no
  // encuentra la función (queda como si "no hiciera nada").
  window.openNotaOncologiaModal = openNotaOncologiaModal;

  function agregarRecetaCardOnco() {
    const container = document.getElementById('recetasContainer');
    const btnIndep = document.getElementById('btnNuevaRecetaIndependiente');
    if (!container) return;

    const recetaId = 'receta-' + Date.now();
    const card = document.createElement('div');
    card.className = 'receta-card-block';
    card.style.cssText = 'background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;';
    card.id = recetaId;

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-size: 12px; font-weight: 800; color: var(--primary-blue); text-transform: uppercase; display: inline-flex; align-items: center; gap: 6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> Receta Médica</span>
        <button type="button" class="btn-remove-receta" style="background: transparent; border: none; color: #EF4444; cursor: pointer; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">Eliminar Receta <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>

      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 8px;">
        <thead>
          <tr style="background: var(--bg-card); text-align: left;">
            <th style="padding: 6px; border: 1px solid var(--border-color); width: 35%;">Medicamento</th>
            <th style="padding: 6px; border: 1px solid var(--border-color); width: 35%;">Indicaciones / Dosis</th>
            <th style="padding: 6px; border: 1px solid var(--border-color);">Notas Adicionales</th>
            <th style="padding: 6px; border: 1px solid var(--border-color); width: 40px; text-align: center;">Acción</th>
          </tr>
        </thead>
        <tbody class="tbody-receta-meds">
          <tr>
            <td style="padding: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="receta-med-nombre" placeholder="Ej: Paracetamol 500mg" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
            </td>
            <td style="padding: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="receta-med-indicaciones" placeholder="Ej: 1 tableta cada 8 horas por 5 días" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
            </td>
            <td style="padding: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="receta-med-notas" placeholder="Ej: Tomar después de los alimentos" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
            </td>
            <td style="padding: 6px; border: 1px solid var(--border-color); text-align: center;">
              <button type="button" class="btn-remove-row btn-anim-lift" style="background: transparent; border: none; color: #EF4444; cursor: pointer; font-size: 13px; display: inline-flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
            </td>
          </tr>
        </tbody>
      </table>

      <button type="button" class="btn-secondary btn-anim-lift btn-add-med-to-receta" style="font-size: 11px; padding: 4px 8px;">
        + Agregar medicamento a esta receta
      </button>
    `;

    const btnAddMedReceta = card.querySelector('.btn-add-med-to-receta');
    if (btnAddMedReceta) {
      btnAddMedReceta.onclick = (e) => {
        e.preventDefault();
        const tbody = card.querySelector('.tbody-receta-meds');
        if (tbody) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td style="padding: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="receta-med-nombre" placeholder="Ej: Dexametasona 4mg" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
            </td>
            <td style="padding: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="receta-med-indicaciones" placeholder="Ej: 1 tableta por la mañana" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
            </td>
            <td style="padding: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="receta-med-notas" placeholder="Ej: Vía oral" style="width: 100%; box-sizing: border-box; padding: 6px; font-size: 12px; color: var(--text-main); border-radius: 4px; border: 1px solid var(--border-color);">
            </td>
            <td style="padding: 6px; border: 1px solid var(--border-color); text-align: center;">
              <button type="button" class="btn-remove-row btn-anim-lift" style="background: transparent; border: none; color: #EF4444; cursor: pointer; font-size: 13px; display: inline-flex;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
            </td>
          `;
          tbody.appendChild(tr);
        }
      };
    }

    const btnRemoveReceta = card.querySelector('.btn-remove-receta');
    if (btnRemoveReceta) {
      btnRemoveReceta.onclick = (e) => {
        e.preventDefault();
        card.remove();
      };
    }

    container.appendChild(card);
    if (btnIndep) btnIndep.style.display = 'inline-block';
  }

  // Precarga la(s) tarjeta(s) de Receta Médica de la última Nota de
  // Oncología del paciente (ver 'recetas' en la consulta que manda el backend)
  // dentro de una sola tarjeta con una fila por medicamento — el modelo no
  // agrupa estas filas por "receta independiente" (a diferencia de
  // la receta), así que reconstruirlas como varias tarjetas
  // separadas no tendría con qué distinguirlas.
  function prefillRecetasFromLastNota(recetas) {
    if (!recetas || !recetas.length) return;
    agregarRecetaCardOnco();
    const container = document.getElementById('recetasContainer');
    const card = container ? container.lastElementChild : null;
    if (!card) return;
    const tbody = card.querySelector('.tbody-receta-meds');
    const btnAddMedReceta = card.querySelector('.btn-add-med-to-receta');
    if (!tbody) return;
    recetas.forEach((receta, index) => {
      if (index > 0 && btnAddMedReceta) btnAddMedReceta.click();
      const rows = tbody.querySelectorAll('tr');
      const row = rows[rows.length - 1];
      if (!row) return;
      const nombreEl = row.querySelector('.receta-med-nombre');
      const indicacionesEl = row.querySelector('.receta-med-indicaciones');
      const notasEl = row.querySelector('.receta-med-notas');
      if (nombreEl) nombreEl.value = receta.nombre || '';
      if (indicacionesEl) indicacionesEl.value = receta.indicaciones || '';
      if (notasEl) notasEl.value = receta.notas || '';
    });
  }

  document.addEventListener('submit', (event) => {
    if (event.target && event.target.id === 'formSignosVitales') {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (!patientId) return;

      const payload = {
        sistolica: document.getElementById('svSistolica')?.value || '',
        diastolica: document.getElementById('svDiastolica')?.value || '',
        fc: document.getElementById('svFC')?.value || '',
        fr: document.getElementById('svFR')?.value || '',
        temperatura: document.getElementById('svTemperatura')?.value || '',
        saturacion: document.getElementById('svSaturacion')?.value || '',
        peso: document.getElementById('svPeso')?.value || '',
        altura: document.getElementById('svAltura')?.value || '',
        comentarios: getEditableFieldValue(document.getElementById('svComentarios')),
      };

      const saveSignosVitales = async () => {
        try {
          await fetch(`/clivora/api/patients/${patientId}/consultations/vitals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          await loadPatientConsultas(patientId);
          const successOverlay = document.getElementById('signosVitalesSuccessOverlay');
          if (successOverlay) successOverlay.style.display = 'flex';
        } catch (error) {
          console.error('Error al guardar signos vitales:', error);
          showClivoraAlertModal('No se pudieron guardar los signos vitales.');
        }
      };
      runClivoraSaveOnce('signosVitales', event.submitter || event.target.querySelector('[type="submit"]'), saveSignosVitales);
    } else if (event.target && event.target.id === 'formNotaOncologia') {
      event.preventDefault();
      const patientId = window.clivoraCurrentPatientId;
      if (!patientId) return;

      // ensureOncoNotaSaved hace el create/update real (y ya sabe si esta
      // nota se guardó de antemano por un botón de Acciones Especiales —
      // Receta Oncológica/Médica u Órdenes Médicas — para actualizar ESE
      // mismo registro en vez de crear una nota duplicada al Guardar).
      runClivoraSaveOnce('oncoNota', event.submitter || document.querySelector('[form="formNotaOncologia"][type="submit"]'), async () => {
        const consultationId = await ensureOncoNotaSaved();
        if (!consultationId) return;
        const successOverlay = document.getElementById('oncoSuccessOverlay');
        if (successOverlay) successOverlay.style.display = 'flex';
      });
    }
  });

  const scrollToExpedienteBtn = document.getElementById('scrollToExpedienteBtn');
  if (scrollToExpedienteBtn) {
    scrollToExpedienteBtn.addEventListener('click', () => {
      const expSection = document.getElementById('expedienteSection');
      if (expSection) expSection.scrollIntoView({ behavior: 'smooth' });
    });
  }

  document.addEventListener('click', (event) => {
    const header = event.target.closest('.accordion-header');
    if (!header) return;
    if (event.target.closest('#btnEditInfoGeneral') ||
        event.target.closest('#btnEditDomicilioPersonal') ||
        event.target.closest('#btnEditFacturacion') ||
        event.target.closest('.btn-icon-edit')) return;
    const item = header.parentElement;
    if (item && item.classList.contains('accordion-item')) {
      item.classList.toggle('open');
    }
  });

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('.expediente-subtab');
    if (!tab) return;

    // Cada pestaña del expediente tiene un alto total distinto (ej. Notas
    // con 13 registros vs. Aseguradoras vacía) — si el usuario estaba
    // scrolleado hasta abajo en una pestaña larga y cambiaba a una más
    // corta, el navegador recorta el scroll de golpe al nuevo máximo,
    // sintiéndose como un brinco. Se vuelve a la barra de pestañas antes de
    // cambiar de contenido para que la vista siempre arranque desde el
    // mismo lugar, sin importar dónde quedó el scroll anterior.
    document.querySelector('.expediente-subtabs-bar')?.scrollIntoView({ block: 'start', behavior: 'auto' });

    document.querySelectorAll('.expediente-subtab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.querySelectorAll('.expediente-tab-content').forEach(c => c.style.display = 'none');

    const targetTabId = tab.getAttribute('data-tab');
    if (targetTabId) {
      const el = document.getElementById(targetTabId);
      if (el) el.style.display = 'block';
      localStorage.setItem('clivora_activeExpTab', targetTabId);
      // El sidebar de Notas mide 0 mientras la pestaña está en
      // display:none (offsetHeight no cuenta contenido oculto) — se
      // vuelve a sincronizar aquí, ya con el tab visible, para que
      // #consultaDetailCard no se quede con la altura vieja o en 0.
      if (targetTabId === 'tab-consultas' && typeof syncConsultaDetailCardHeight === 'function') {
        syncConsultaDetailCardHeight();
      }
      if (targetTabId === 'tab-archivos' && typeof syncArchivoPreviewCardHeight === 'function') {
        syncArchivoPreviewCardHeight();
      }
      if (targetTabId === 'tab-laboratorio' && typeof syncLabOrderDetailPanelHeight === 'function') {
        syncLabOrderDetailPanelHeight();
      }
      if (targetTabId === 'tab-recetas' && typeof syncRecipeDetailCardHeight === 'function') {
        syncRecipeDetailCardHeight();
      }
    }
  });

  document.addEventListener('click', (event) => {
    const item = event.target.closest('.hc-section-item');
    if (!item) return;

    // El selector de fecha/hora propio reubica su panel como hijo directo
    // de <body> mientras está abierto (ver el "portal" en openPanel, más
    // arriba) para que position:fixed sea siempre relativo al viewport real.
    // Antes de este cambio, un panel abierto en la sección que se abandona
    // quedaba oculto solo porque .hc-section-content pasaba a display:none
    // (ocultando también a sus descendientes); ahora, al vivir en <body>, ya
    // no depende de esa sección para ocultarse, así que hay que cerrarlo a
    // mano al cambiar de sección o quedaría flotando indefinidamente encima
    // de la sección nueva.
    if (typeof closeAllCustomDatePickers === 'function') closeAllCustomDatePickers();

    document.querySelectorAll('.hc-section-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    const targetId = item.getAttribute('data-hc-section');
    document.querySelectorAll('.hc-section-content').forEach(content => {
      content.style.display = 'none';
      content.classList.remove('hc-fade-in');
    });

    if (targetId) {
      const target = document.getElementById(targetId);
      if (target) {
        target.style.display = 'block';
        void target.offsetWidth;
        target.classList.add('hc-fade-in');
        // .hc-section-content (ver styles.css) ahora tiene altura fija con
        // scroll interno — el contenedor ya no cambia de tamaño según la
        // sección, así que no hace falta re-centrar la página. Solo se
        // reinicia el scroll interno de la sección para que no aparezca a
        // medio desplazar si se había dejado así la última vez.
        target.scrollTop = 0;
      }
      localStorage.setItem('clivora_activeHC', targetId);
    }
  });

  document.addEventListener('click', (event) => {
    const btnGridView = event.target.closest('#btnGridView');
    const btnListView = event.target.closest('#btnListView');
    const patientsGrid = document.getElementById('patientsGrid');

    if (!patientsGrid) return;

    if (btnGridView) {
      patientsGrid.classList.remove('list-view');
      const gridBtn = document.getElementById('btnGridView');
      const listBtn = document.getElementById('btnListView');
      if (gridBtn) gridBtn.classList.add('active');
      if (listBtn) listBtn.classList.remove('active');
    } else if (btnListView) {
      patientsGrid.classList.add('list-view');
      const gridBtn = document.getElementById('btnGridView');
      const listBtn = document.getElementById('btnListView');
      if (gridBtn) gridBtn.classList.remove('active');
      if (listBtn) listBtn.classList.add('active');
    }
  });


  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('#toggle-heredo');
    if (!toggle) return;
    setHeredoToggleState(!toggle.classList.contains('active'));
  });

  const heredoBtn = document.getElementById('btn-add-familiar');
  if (heredoBtn) {
    heredoBtn.addEventListener('click', () => {
      const dynamicList = document.getElementById('heredo-dynamic-list');
      if (!dynamicList) return;
      const familiarCount = dynamicList.querySelectorAll('.familiar-form-card').length + 1;
      const id = 'familiar-' + Date.now();
      dynamicList.insertAdjacentHTML('beforeend', buildFamiliarCardHtml({}, id, familiarCount));
    });
  }

  Object.entries(PATOLOGICOS_SUBLISTS).forEach(([key, cfg]) => {
    const btn = document.getElementById(cfg.addBtnId);
    if (btn) btn.addEventListener('click', () => addPatologicosSublistRow(key));
  });

  const btnAddMed = document.getElementById('btn-add-medicamento');
  if (btnAddMed) btnAddMed.addEventListener('click', () => addMedicationRow());

  // Expandir/colapsar "OBSERVACIONES DETALLADAS" de cada tarjeta de familiar
  document.addEventListener('click', (event) => {
    const header = event.target.closest('.familiar-expandable');
    if (!header) return;
    const obsBox = header.nextElementSibling;
    if (!obsBox || !obsBox.classList.contains('familiar-observations')) return;
    const isOpen = obsBox.style.display === 'flex';
    obsBox.style.display = isOpen ? 'none' : 'flex';
    header.classList.toggle('active', !isOpen);
  });

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('.toggle-switch');
    if (!toggle) return;
    const cfg = CLIVORA_HC_TOGGLES.find(item => item.id === toggle.id);
    if (!cfg) return;
    setClivoraToggleState(cfg, !toggle.classList.contains('active'));
  });

  document.addEventListener('click', (event) => {
    const accHeader = event.target.closest('#toggle-observaciones-btn');
    if (!accHeader) return;
    const accBody = document.getElementById('observaciones-panel');
    accHeader.classList.toggle('active');
    if (accBody) {
      accBody.style.display = accHeader.classList.contains('active') ? 'none' : 'block';
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // #loginShell ya no se llena: para llegar a esta página ya se autenticó
  // (la página /clivora exige sesión iniciada), así que
  // el login falso del prototipo standalone se quitó por completo — mostrarlo
  // aunque fuera un instante causaba un parpadeo en cada recarga.

  const pacientesShell = document.getElementById('pacientesShell');
  if (pacientesShell) {
    try {
      const pacientesResponse = await fetch('/clivora/static/modules/Pacientes/vista/pacientes.html', { cache: 'no-store' });
      if (pacientesResponse.ok) {
        pacientesShell.innerHTML = await pacientesResponse.text();
      }
    } catch (error) {
      console.error('Error al cargar la vista de pacientes:', error);
    }
  }

  const pacienteDetailShell = document.getElementById('pacienteDetailShell');
  if (pacienteDetailShell) {
    try {
      const detalleResponse = await fetch('/clivora/static/modules/Pacientes/vista/paciente-detail.html', { cache: 'no-store' });
      if (detalleResponse.ok) {
        pacienteDetailShell.innerHTML = await detalleResponse.text();
        initializeHcFilesDropzone();
        initializePatientPhotoUpload();
      }
    } catch (error) {
      console.error('Error al cargar el detalle de pacientes:', error);
    }
  }

  const nuevoPacienteShell = document.getElementById('nuevoPacienteShell');
  if (nuevoPacienteShell) {
    try {
      const nuevoResponse = await fetch('/clivora/static/modules/Pacientes/vista/nuevo-paciente.html', { cache: 'no-store' });
      if (nuevoResponse.ok) {
        nuevoPacienteShell.innerHTML = await nuevoResponse.text();
        initializeNewPatientModule();
      }
    } catch (error) {
      console.error('Error al cargar la vista de nuevo paciente:', error);
    }
  }

  loadPatientsList();
  loadCurrentUserProfile();
  initializePatientsModule();
  // initializeNewPatientModule() ya se llamó arriba justo después de
  // inyectar nuevo-paciente.html — llamarlo otra vez aquí agregaba un
  // segundo listener 'submit' a #newPatientForm (handleNewPatientSubmit
  // se declara dentro de esa función, así que cada llamada crea un closure
  // nuevo; addEventListener no los deduplica porque son referencias
  // distintas), causando que cada "Guardar Paciente" creara el contacto
  // duplicado.
});
// ============================================================


// ============================================================
// 1. SIDEBAR TOGGLE (colapsar/expandir menú lateral)
// ============================================================
const sidebar = document.getElementById('sidebar');
const mainWrapper = document.getElementById('mainWrapper');
document.getElementById('sidebarToggle').addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  mainWrapper.classList.toggle('sidebar-collapsed');
});


// ============================================================
// 2. MODO OSCURO — quitado del menú (Configuración) y de "Mi Perfil" a
// pedido; se fuerza siempre a claro para que nadie se quede atascado en
// oscuro por una preferencia guardada de antes, ahora que no hay botón
// para volver a cambiarla.
// ============================================================
localStorage.setItem('clivora_theme', 'light');
document.documentElement.setAttribute('data-theme', 'light');


// ============================================================
// 3. NAVEGACIÓN PRINCIPAL (page-views via sidebar)
// ============================================================
// Cada .nav-item tiene data-view que corresponde al ID del page-view sin "View".
// Ej: data-view="inicio" → muestra #inicioView
const pageViews = document.querySelectorAll('.page-view');
const navItems = document.querySelectorAll('.nav-item');

function switchView(targetViewId) {
  // Mismo motivo que en el click de .hc-section-item: el panel del selector
  // de fecha/hora vive en <body> mientras está abierto (portal, ver
  // openPanel), así que cambiar de vista ya no lo oculta solo — hay que
  // cerrarlo a mano o queda flotando encima de la vista nueva.
  if (typeof closeAllCustomDatePickers === 'function') closeAllCustomDatePickers();
  pageViews.forEach(view => {
    if (view.id === targetViewId + 'View') {
      view.classList.add('active-view');
    } else {
      view.classList.remove('active-view');
    }
  });

  navItems.forEach(item => {
    if (item.dataset.view === targetViewId) item.classList.add('active');
    else item.classList.remove('active');
  });
  if (targetViewId === 'inicio' || targetViewId === 'dashboard') {
    if (typeof updateDashboardMetrics === 'function') updateDashboardMetrics();
  }
  if (targetViewId === 'tratamientos' && typeof loadTratamientos === 'function') {
    loadTratamientos();
  }
  window.scrollTo(0, 0);
}

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    if (item.dataset.view) {
      e.preventDefault();
      switchView(item.dataset.view);
      // Guardar en localStorage
      localStorage.setItem('clivora_activeView', item.dataset.view);
    }
  });
});


// ============================================================
// 4. SUB-TABS DEL DASHBOARD DE INICIO
// ============================================================
// Botones [data-sub] cambian entre sub-dashboards dentro de inicioView
document.querySelectorAll('[data-sub]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-sub]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const targetSub = btn.dataset.sub;
    document.querySelectorAll('.sub-dashboard').forEach(sub => {
      if (sub.id === 'sub-' + targetSub) sub.classList.add('active-sub');
      else sub.classList.remove('active-sub');
    });

    if (targetSub === 'farmacia' && typeof loadFarmaciaSummary === 'function') loadFarmaciaSummary();
    if (targetSub === 'facturacion' && typeof loadFacturacionSummary === 'function') loadFacturacionSummary();
  });
});


// ============================================================
// 5. AGENDA / CALENDARIO — Cambio de modo (Día, Semana, Mes, Agenda)
// ============================================================
// El manejador real vive en initializeDynamicCalendarModule() más abajo
// (modeButtons.forEach + updateCalendarView, con datos reales de
// /clivora/api/citas). Aquí antes había un segundo listener sobre los
// mismos botones que solo escribía fechas/conteos de ejemplo quemados —
// inofensivo porque el real corría después y pisaba el valor en el mismo
// tick de clic, pero era código muerto; se quitó.


// ============================================================
// 6. ABRIR DETALLE DE PACIENTE (desde tarjeta o lista)
// ============================================================
// El manejador real vive arriba, por delegación en document (funciona con
// tarjetas creadas dinámicamente). Este bloque usaba querySelectorAll al
// cargar el script, antes de que existiera ninguna tarjeta — nunca
// encontraba nada y nunca corría; se quitó por muerto.


// ============================================================
// 7. SCROLL SUAVE AL EXPEDIENTE
// ============================================================
const scrollToExpedienteBtn = document.getElementById('scrollToExpedienteBtn');
if (scrollToExpedienteBtn) {
  scrollToExpedienteBtn.addEventListener('click', () => {
    const expSection = document.getElementById('expedienteSection');
    if (expSection) expSection.scrollIntoView({ behavior: 'smooth' });
  });
}


// ============================================================
// 8. ACCORDION TOGGLE (secciones colapsables en detalle de paciente)
// ============================================================
document.querySelectorAll('.accordion-header').forEach(header => {
  header.addEventListener('click', () => {
    header.parentElement.classList.toggle('open');
  });
});


// ============================================================
// 9. NAVEGACIÓN DE SECCIONES HC (Historia Clínica 1-14)
// ============================================================
// El listener real de .hc-section-item vive delegado en document (ver
// "click" más arriba, junto al de .expediente-subtab) — un
// document.querySelectorAll('.hc-section-item').forEach(...) que vivía
// aquí, a nivel top-level del script, se eliminó: se ejecutaba una sola
// vez al parsear app.js, ANTES de que paciente-detail.html (donde viven
// estos elementos) se inyectara vía fetch dentro de DOMContentLoaded, así
// que nunca encontraba nada y nunca enganchaba ningún click — quedaba como
// código muerto que aparentaba ser "el" listener sin serlo.

// ============================================================
// 10. SUBTABS DEL EXPEDIENTE (Historia Clínica, Archivos, Consultas, etc.)
// ============================================================
// Usa data-tab en cada .expediente-subtab para mapear al ID del
// .expediente-tab-content correspondiente. Esto es más robusto que
// comparar el texto visible.

// Navegación programática a una subtab (ej. desde botones de acceso rápido
// en otras secciones) — simula el click real en vez de duplicar la lógica
// de arriba/abajo. Varios botones llamaban a "switchExpedienteSubTab", una
// función que nunca se llegó a definir en ningún archivo (ReferenceError
// silencioso al hacer click, nunca navegaba a ningún lado).
function goToExpedienteSubTab(tabId) {
  document.querySelector(`.expediente-subtab[data-tab="${tabId}"]`)?.click();
}

// El manejador real vive arriba, delegado en document (ver "click" junto al
// de .hc-section-item) — un document.querySelectorAll('.expediente-subtab')
// .forEach(...) que vivía aquí, a nivel top-level del script, se eliminó:
// mismo bug que los otros bloques "muertos" de esta sección (#6, #9) —
// corría una sola vez al parsear app.js, antes de que paciente-detail.html
// se inyectara vía fetch, así que nunca encontraba ninguna .expediente-subtab
// real y nunca enganchaba ningún click.


// ============================================================
// 11. BÚSQUEDA DE PACIENTES (filtro en directorio)
// ============================================================
// Ver clivoraSearchPatients / renderPatientsGrid (arriba).


// ============================================================
// 12. TOGGLE GRID / LIST VIEW (pacientes)
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const btnGridView = document.getElementById("btnGridView");
  const btnListView = document.getElementById("btnListView");
  const patientsGrid = document.getElementById("patientsGrid");

  if (btnGridView) if (btnListView) if (patientsGrid) {
    btnGridView.addEventListener("click", () => {
      patientsGrid.classList.remove("list-view");
      btnGridView.classList.add("active");
      btnListView.classList.remove("active");
    });

    btnListView.addEventListener("click", () => {
      patientsGrid.classList.add("list-view");
      btnListView.classList.add("active");
      btnGridView.classList.remove("active");
    });
  }
});


// ============================================================
// MODAL & LÓGICA DE AGENDAR / EDITAR CITA
// ============================================================
let currentEditingCitaId = null;
let currentSelectedModalStatus = 'aprobado';
let currentCitaPacienteId = null;
let clivoraCitasCache = [];

// Citas del auto-agendado público sin match de paciente (ver
// solicitanteNombre/solicitanteTelefono/etc. en serialize, apps/agenda/compat.py)
// no tienen `paciente` — se muestra el nombre que escribió el solicitante
// marcado como "sin vincular" para que el personal sepa que falta ligarla
// a un paciente real al revisarla.
function citaDisplayName(cita) {
  if (cita.paciente) return cita.paciente;
  if (cita.solicitanteNombre) return `${cita.solicitanteNombre} (sin vincular)`;
  return 'Sin paciente';
}

// Tooltip nativo (title) con la info de creación de la cita — las tarjetas
// del calendario (event-pill-appointment) son demasiado chicas (10px, una
// sola línea por dato) para mostrar esto como texto visible sin romper el
// diseño compacto, así que se muestra solo al pasar el cursor.
function citaCreadoTooltip(cita) {
  const parts = [];
  if (cita.createdAt) parts.push(`Creado el: ${cita.createdAt}`);
  if (cita.createdBy) parts.push(`Creado por: ${cita.createdBy}`);
  return parts.join('\n');
}

// Viñeta flotante (no el "title" nativo del navegador, que aparece lento y
// no admite HTML/estilos) con el detalle completo de una cita — necesaria
// porque con varias citas en la misma hora las columnas de
// applyTimedPillLayout se angostan tanto que el texto de la pastilla se
// trunca o se compacta a solo 2-3 líneas, y así se puede leer todo sin
// tener que abrir la cita. Un solo elemento reusado (no uno por pastilla)
// para no ensuciar el DOM del calendario con decenas de tooltips ocultos.
let _eventHoverTooltipEl = null;

function getEventHoverTooltipEl() {
  if (!_eventHoverTooltipEl) {
    _eventHoverTooltipEl = document.createElement('div');
    _eventHoverTooltipEl.className = 'event-hover-tooltip';
    document.body.appendChild(_eventHoverTooltipEl);
  }
  return _eventHoverTooltipEl;
}

function buildEventHoverTooltipHtml(cita) {
  const stClass = (cita.estado || 'nuevo').toLowerCase();
  const label = (typeof CITA_ESTADO_LABELS !== 'undefined' && CITA_ESTADO_LABELS[stClass]) || 'Nuevo';
  const rows = [];
  const horaLine = cita.hora ? `${cita.hora}${cita.horaFin ? ' - ' + cita.horaFin : ''}` : '';
  if (horaLine) rows.push(`<div class="event-hover-tooltip-row"><strong>Hora:</strong> ${escapeHtml(horaLine)}</div>`);
  if (cita.doctor) rows.push(`<div class="event-hover-tooltip-row"><strong>Dr(a):</strong> ${escapeHtml(cita.doctor)}</div>`);
  if (cita.nurse) rows.push(`<div class="event-hover-tooltip-row"><strong>Enfermera:</strong> ${escapeHtml(cita.nurse)}</div>`);
  if (cita.tipo) rows.push(`<div class="event-hover-tooltip-row"><strong>Tipo:</strong> ${escapeHtml(cita.tipo)}</div>`);
  const salaLine = cita.sala ? `${cita.ubicacion} (${cita.sala})` : (cita.ubicacion || '');
  if (salaLine) rows.push(`<div class="event-hover-tooltip-row"><strong>Ubicación:</strong> ${escapeHtml(salaLine)}</div>`);
  if (cita.motivo) rows.push(`<div class="event-hover-tooltip-row"><strong>Motivo:</strong> ${escapeHtml(cita.motivo)}</div>`);
  // Aplicación de medicamento (solo citas de Tratamiento, mismo criterio que
  // renderCitaAplicacionBlock): estado manual o, en modo traslados, el
  // calculado desde la venta (solo si hay alguno).
  const tipoCita = (cita.tipo || '').toString().trim().toLowerCase();
  const aplicacion = cita.aplicacion || {};
  if (tipoCita && !tipoCita.startsWith('consulta') && (aplicacion.modo !== 'traslados' || aplicacion.estado)) {
    const estadoApl = [...CLIVORA_APLICACION_ESTADOS.manual, ...CLIVORA_APLICACION_ESTADOS.traslados].find(e => e.key === aplicacion.estado);
    const aplHtml = estadoApl
      ? `<span class="badge badge-${estadoApl.cls}">${escapeHtml(estadoApl.label)}</span>`
      : '<span style="color: var(--text-muted);">Sin estado</span>';
    rows.push(`<div class="event-hover-tooltip-row"><strong>Medicamento:</strong> ${aplHtml}</div>`);
    if (cita.stockAplicacion) {
      rows.push('<div class="event-hover-tooltip-row"><strong>Stock:</strong> <span class="badge badge-aplicacion-listo">✓ Listo</span></div>');
    }
  }
  // notaTexto: la nota sin etiquetas (cita.nota trae el HTML del texto
  // enriquecido para el editor de la cita).
  const notaTexto = cita.notaTexto !== undefined ? cita.notaTexto : cita.nota;
  if (notaTexto) rows.push(`<div class="event-hover-tooltip-row event-hover-tooltip-note"><strong>Nota:</strong> ${escapeHtml(String(notaTexto).trim())}</div>`);
  if (cita.createdAt) rows.push(`<div class="event-hover-tooltip-row event-hover-tooltip-muted">Creado el ${escapeHtml(cita.createdAt)}${cita.createdBy ? ' por ' + escapeHtml(cita.createdBy) : ''}</div>`);
  return `
    <div class="event-hover-tooltip-header">
      <span class="event-hover-tooltip-name">${escapeHtml(citaDisplayName(cita))}</span>
      <span class="badge badge-${stClass}">${label}</span>
    </div>
    ${rows.join('')}
  `;
}

function positionEventHoverTooltip(el, evt) {
  const OFFSET = 14;
  const rect = el.getBoundingClientRect();
  let left = evt.clientX + OFFSET;
  let top = evt.clientY + OFFSET;
  if (left + rect.width > window.innerWidth - 8) left = evt.clientX - rect.width - OFFSET;
  if (top + rect.height > window.innerHeight - 8) top = evt.clientY - rect.height - OFFSET;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showEventHoverTooltip(cita, evt) {
  const el = getEventHoverTooltipEl();
  el.innerHTML = buildEventHoverTooltipHtml(cita);
  el.style.display = 'block';
  positionEventHoverTooltip(el, evt);
}

function hideEventHoverTooltip() {
  if (_eventHoverTooltipEl) {
    _eventHoverTooltipEl.style.display = 'none';
    _eventHoverTooltipEl.classList.remove('event-hover-tooltip-wide');
  }
}

// Columna "Esquema" de la lista de Tratamientos: el texto se corta a 2
// líneas en la celda y el completo se ve en la misma viñeta flotante de las
// citas del calendario (antes era el "title" nativo del navegador, sin
// ningún diseño). A diferencia de la viñeta de las citas, esta NO sigue al
// mouse: queda anclada junto a la celda y acepta el puntero, para poder
// desplazar con scroll un esquema largo (alto limitado en el CSS). Se
// cierra al salir de la celda y de la viñeta, al tocar fuera (celular) o al
// desplazar la página.
let _esquemaTooltipCell = null;
let _esquemaTooltipHideTimer = null;

function positionEsquemaTooltip(el, cell) {
  const GAP = 6;
  const r = cell.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  let top = r.bottom + GAP;
  if (top + t.height > window.innerHeight - 8) top = r.top - t.height - GAP;
  if (top < 8) top = 8;
  let left = r.left;
  if (left + t.width > window.innerWidth - 8) left = window.innerWidth - t.width - 8;
  if (left < 8) left = 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showEsquemaHoverTooltip(trat, cell) {
  if (!trat || !trat.esquema) return;
  clearTimeout(_esquemaTooltipHideTimer);
  const el = getEventHoverTooltipEl();
  if (_esquemaTooltipCell === cell && el.style.display === 'block') return;
  _esquemaTooltipCell = cell;
  el.classList.add('event-hover-tooltip-wide');
  el.innerHTML = `
    <div class="event-hover-tooltip-header">
      <span class="event-hover-tooltip-name">Esquema de tratamiento</span>
    </div>
    ${trat.paciente ? `<div class="event-hover-tooltip-row"><strong>Paciente:</strong> ${escapeHtml(trat.paciente)}</div>` : ''}
    <div class="event-hover-tooltip-esquema">${escapeHtml(trat.esquema)}</div>
  `;
  el.style.display = 'block';
  el.querySelector('.event-hover-tooltip-esquema').scrollTop = 0;
  positionEsquemaTooltip(el, cell);
}

function hideEsquemaTooltip() {
  clearTimeout(_esquemaTooltipHideTimer);
  if (!_esquemaTooltipCell) return;
  _esquemaTooltipCell = null;
  hideEventHoverTooltip();
}

function findTratForEsquemaCell(cell) {
  return (typeof clivoraTratamientos !== 'undefined' ? clivoraTratamientos : [])
    .find(t => t.id === parseInt(cell.dataset.tratId, 10));
}

document.addEventListener('mouseover', (e) => {
  if (!e.target.closest) return;
  const cell = e.target.closest('#tratamientosTableBody .td-esquema');
  if (cell) {
    showEsquemaHoverTooltip(findTratForEsquemaCell(cell), cell);
    return;
  }
  // Sobre la propia viñeta: se mantiene abierta para poder hacer scroll.
  if (_esquemaTooltipCell && e.target.closest('.event-hover-tooltip-wide')) {
    clearTimeout(_esquemaTooltipHideTimer);
  }
});
document.addEventListener('mouseout', (e) => {
  if (!_esquemaTooltipCell || !e.target.closest) return;
  const fromZone = e.target.closest('#tratamientosTableBody .td-esquema, .event-hover-tooltip-wide');
  const toZone = e.relatedTarget && e.relatedTarget.closest
    && e.relatedTarget.closest('#tratamientosTableBody .td-esquema, .event-hover-tooltip-wide');
  if (fromZone && !toZone) {
    // Margen para cruzar el hueco entre la celda y la viñeta.
    _esquemaTooltipHideTimer = setTimeout(hideEsquemaTooltip, 200);
  }
});
// Celular (sin hover real): un toque en la celda la abre; tocar fuera de la
// celda y de la viñeta la cierra.
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const cell = e.target.closest('#tratamientosTableBody .td-esquema');
  if (cell) {
    showEsquemaHoverTooltip(findTratForEsquemaCell(cell), cell);
    return;
  }
  if (_esquemaTooltipCell && !e.target.closest('.event-hover-tooltip-wide')) hideEsquemaTooltip();
});
// La viñeta es position:fixed — al desplazar la página (o la tabla) quedaría
// flotando lejos de su celda. El scroll dentro de la propia viñeta no cuenta.
document.addEventListener('scroll', (e) => {
  if (!_esquemaTooltipCell) return;
  if (e.target && e.target.closest && e.target.closest('.event-hover-tooltip-wide')) return;
  hideEsquemaTooltip();
}, true);

function toggleRejectionReasonBlock(status) {
  const block = document.getElementById('citaRejectionReasonBlock');
  if (block) block.style.display = status === 'rechazado' ? 'block' : 'none';
}

async function populateCitaRejectionReasonSelect(selectEl, selectedId) {
  if (!selectEl) return;
  const catalogs = await ensureCitasCatalogs();
  selectEl.innerHTML = '<option value="">Seleccionar motivo...</option>';
  (catalogs.rejectionReasons || []).forEach(reason => {
    const opt = document.createElement('option');
    opt.value = String(reason.id);
    opt.textContent = reason.name;
    selectEl.appendChild(opt);
  });
  if (selectedId) selectEl.value = String(selectedId);
}

// Default de "fin" para una cita nueva (1 hora después del inicio) — mismo
// valor que antes calculaba el backend en automático para stop_dt, ahora
// solo sirve de punto de partida editable en el campo de finalización.
function addOneHourToDateTime(fechaStr, horaStr) {
  const dt = new Date(`${fechaStr}T${horaStr || '00:00'}:00`);
  if (Number.isNaN(dt.getTime())) return { fecha: fechaStr, hora: horaStr };
  dt.setHours(dt.getHours() + 1);
  const fecha = dt.toISOString().split('T')[0];
  const hora = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  return { fecha, hora };
}

// Lugares y salas: vienen de Configuración → Lugares y salas (catálogo
// "lugares" de /api/citas/catalogs, ver ensureCitasCatalogs). Cada sala es de
// tipo "tratamiento" (salas de tratamiento/infusión) o "consulta"
// (consultorios). En la cita se guardan los ids; en pantalla, los nombres.
let CLIVORA_LUGARES = [];

function clivoraIsConsultaTipo(tipo) {
  return (tipo || '').toString().trim().toLowerCase().startsWith('consulta');
}

function clivoraTipoSala(tipo) {
  return clivoraIsConsultaTipo(tipo) ? 'consulta' : 'tratamiento';
}

// Lugares que tienen al menos una sala del tipo pedido (todos si no se pide tipo).
function clivoraLugaresConSalas(tipoSala) {
  return CLIVORA_LUGARES.filter(l => !tipoSala || l.salas.some(s => s.tipo === tipoSala));
}

function clivoraSalasDeLugar(lugarId, tipoSala) {
  const lugar = CLIVORA_LUGARES.find(l => String(l.id) === String(lugarId));
  return lugar ? lugar.salas.filter(s => !tipoSala || s.tipo === tipoSala) : [];
}

// Llena Ubicación y Sala del modal de la cita según el tipo (Consulta o
// Tratamiento), conservando el lugar/sala dados (ids) si existen para ese tipo.
function populateCitaUbicacionSala(tipo, lugarId, salaId) {
  const ubicacionSelect = document.getElementById('citaUbicacion');
  const salaSelect = document.getElementById('citaSala');
  if (!ubicacionSelect || !salaSelect) return;
  if (!CLIVORA_LUGARES.length && !clivoraCitasCatalogsCache) {
    // Catálogo aún no cargado: se vuelve a llenar en cuanto llegue.
    ensureCitasCatalogs().then(() => populateCitaUbicacionSala(tipo, lugarId, salaId));
  }
  const tipoSala = clivoraTipoSala(tipo);
  const lugares = clivoraLugaresConSalas(tipoSala);
  if (!lugares.length) {
    ubicacionSelect.innerHTML = '<option value="">Sin lugares configurados</option>';
    salaSelect.innerHTML = `<option value="">${tipoSala === 'consulta' ? 'Sin consultorios' : 'Sin salas'}</option>`;
    return;
  }
  const lugarFinal = lugares.some(l => String(l.id) === String(lugarId)) ? String(lugarId) : String(lugares[0].id);
  ubicacionSelect.innerHTML = lugares.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
  ubicacionSelect.value = lugarFinal;
  const salas = clivoraSalasDeLugar(lugarFinal, tipoSala);
  salaSelect.innerHTML = salas.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  salaSelect.value = salas.some(s => String(s.id) === String(salaId)) ? String(salaId) : String(salas[0].id);
  [ubicacionSelect, salaSelect].forEach(el => el.dispatchEvent(new Event('change')));
}

// ── Archivos adjuntos de la cita (bloque Notas del modal) ─────────────────
// archivos de la cita, mismas rutas que "Archivos de la Cita"
// de la Agenda (/clivora/api/citas/<id>/files, máx. 8 por cita). Con la
// cita ya guardada se suben y se quitan al momento; en una cita nueva se
// quedan en espera (pending) y se suben en cuanto se guarda (ver
// uploadPendingCitaAdjuntos en el submit del modal).
const CLIVORA_MAX_CITA_ADJUNTOS = 8;
let clivoraCitaAdjuntos = { citaId: null, saved: [], pending: [] };

async function loadCitaAdjuntos(citaId) {
  clivoraCitaAdjuntos = { citaId: citaId || null, saved: [], pending: [] };
  renderCitaAdjuntos();
  if (!citaId) return;
  try {
    const response = await fetch(`/clivora/api/citas/${citaId}/files`, { cache: 'no-store' });
    // Otra cita pudo abrirse mientras llegaba la respuesta.
    if (response.ok && clivoraCitaAdjuntos.citaId === citaId) clivoraCitaAdjuntos.saved = await response.json();
  } catch (error) {
    console.error('Error al cargar los archivos de la cita:', error);
  }
  renderCitaAdjuntos();
}

function clivoraFileSizeLabel(bytes) {
  if (!bytes) return '';
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderCitaAdjuntos() {
  const list = document.getElementById('citaAdjuntosList');
  if (!list) return;
  const items = [
    ...clivoraCitaAdjuntos.saved.map(f => ({ kind: 'saved', id: f.id, name: f.name, size: f.fileSize, url: f.fileUrl })),
    ...clivoraCitaAdjuntos.pending.map((f, index) => ({ kind: 'pending', id: index, name: f.name, size: f.size })),
  ];
  const count = document.getElementById('citaAdjuntosCount');
  if (count) count.textContent = items.length ? `(${items.length}/${CLIVORA_MAX_CITA_ADJUNTOS})` : '';
  const addBtn = document.getElementById('citaAdjuntosAddBtn');
  if (addBtn) addBtn.disabled = items.length >= CLIVORA_MAX_CITA_ADJUNTOS;
  list.innerHTML = items.length ? items.map(item => {
    const name = escapeHtml(item.name || 'Archivo');
    const meta = [clivoraFileSizeLabel(item.size), item.kind === 'pending' ? 'se sube al guardar la cita' : '']
      .filter(Boolean).join(' · ');
    return `
      <div class="cita-adjunto-item${item.kind === 'pending' ? ' is-pending' : ''}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        ${item.url ? `<a class="cita-adjunto-name" href="${item.url}" target="_blank" rel="noopener" title="${name}">${name}</a>`
                   : `<span class="cita-adjunto-name" title="${name}">${name}</span>`}
        ${meta ? `<span class="cita-adjunto-meta">${meta}</span>` : ''}
        <button type="button" class="cita-adjunto-remove" data-kind="${item.kind}" data-id="${item.id}" title="Quitar archivo">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
  }).join('') : '<div class="cita-adjuntos-empty">Sin archivos adjuntos</div>';
}

function clivoraReadFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadCitaAdjuntos(citaId, files) {
  try {
    const encoded = await Promise.all(files.map(async file => ({
      name: file.name,
      dataUrl: await clivoraReadFileAsDataUrl(file),
    })));
    const response = await fetch(`/clivora/api/citas/${citaId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: encoded }),
    });
    if (!response.ok) {
      showClivoraAlertModal(await clivoraResponseErrorMessage(response, 'No se pudieron subir los archivos.'));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error al subir archivos de la cita:', error);
    showClivoraAlertModal('No se pudieron subir los archivos.');
    return false;
  }
}

async function uploadPendingCitaAdjuntos(citaId) {
  const pending = clivoraCitaAdjuntos.pending;
  if (!citaId || !pending.length) return;
  clivoraCitaAdjuntos.pending = [];
  await uploadCitaAdjuntos(citaId, pending);
}

document.addEventListener('click', async (event) => {
  if (event.target.closest('#citaAdjuntosAddBtn')) {
    const input = document.getElementById('citaAdjuntosInput');
    if (input) {
      input.value = '';
      input.click();
    }
    return;
  }
  const removeBtn = event.target.closest('.cita-adjunto-remove');
  if (!removeBtn) return;
  const id = Number(removeBtn.dataset.id);
  if (removeBtn.dataset.kind === 'pending') {
    clivoraCitaAdjuntos.pending.splice(id, 1);
    renderCitaAdjuntos();
    return;
  }
  const file = clivoraCitaAdjuntos.saved.find(f => f.id === id);
  if (!(await showClivoraConfirmModal(`¿Quitar el archivo "${file ? file.name : ''}" de la cita?`, 'Quitar archivo', { confirmLabel: 'Quitar' }))) return;
  try {
    const response = await fetch(`/clivora/api/cita_files/${id}/delete`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error('Error al quitar el archivo de la cita:', error);
    showClivoraAlertModal('No se pudo quitar el archivo.');
  }
  await loadCitaAdjuntos(clivoraCitaAdjuntos.citaId);
});

document.addEventListener('change', async (event) => {
  if (event.target.id !== 'citaAdjuntosInput') return;
  let files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  const available = CLIVORA_MAX_CITA_ADJUNTOS - clivoraCitaAdjuntos.saved.length - clivoraCitaAdjuntos.pending.length;
  if (available <= 0) {
    showClivoraAlertModal(`Se alcanzó el límite de ${CLIVORA_MAX_CITA_ADJUNTOS} archivos por cita.`);
    return;
  }
  if (files.length > available) {
    showClivoraAlertModal(`Solo se agregarán ${available} archivo(s) para no pasar el límite de ${CLIVORA_MAX_CITA_ADJUNTOS} por cita.`);
    files = files.slice(0, available);
  }
  const citaId = clivoraCitaAdjuntos.citaId;
  if (citaId) {
    await uploadCitaAdjuntos(citaId, files);
    await loadCitaAdjuntos(citaId);
  } else {
    clivoraCitaAdjuntos.pending.push(...files);
    renderCitaAdjuntos();
  }
});

// ── Aplicación de medicamento (modal de la cita) ──────────────────────────
// Solo para citas de Tratamiento, con o sin venta. Dos modos (ver
// la aplicación en apps/agenda/compat.py):
//   manual    — Solicitado / Preparación / Listo, se cambia a mano y se
//               guarda con la cita (aplicacionEstado en buildCitaPayload).
//   traslados — En proceso / Aplicado, solo lectura, calculado desde los
//               traslados de la venta (solo si la cita tiene venta).
const CLIVORA_APLICACION_ESTADOS = {
  manual: [
    { key: 'solicitado', label: 'Solicitado', cls: 'aplicacion-solicitado' },
    { key: 'preparacion', label: 'Preparación', cls: 'aplicacion-preparacion' },
    { key: 'listo', label: 'Listo', cls: 'aplicacion-listo' },
  ],
  traslados: [
    { key: 'en_proceso', label: 'En proceso', cls: 'aplicacion-en-proceso' },
    { key: 'aplicado', label: 'Aplicado', cls: 'aplicacion-aplicado' },
  ],
};
let clivoraCitaAplicacion = { modo: 'manual', estado: '', traslados: [], hasVenta: false };

function renderCitaAplicacionBlock() {
  const block = document.getElementById('citaAplicacionBlock');
  const group = document.getElementById('citaAplicacionBtnGroup');
  const status = document.getElementById('citaAplicacionStatus');
  if (!block || !group) return;
  const tipo = (document.getElementById('citaTipo')?.value || '').toString().trim().toLowerCase();
  const isTratamiento = !!tipo && !tipo.startsWith('consulta');
  const manual = clivoraCitaAplicacion.modo !== 'traslados';
  block.style.display = (isTratamiento && (manual || clivoraCitaAplicacion.hasVenta)) ? 'block' : 'none';
  group.innerHTML = CLIVORA_APLICACION_ESTADOS[manual ? 'manual' : 'traslados'].map(e => `
    <button type="button" class="status-choice-btn ${e.cls}${clivoraCitaAplicacion.estado === e.key ? ' active' : ''}"
      data-aplicacion="${e.key}" ${manual ? '' : 'disabled'}>● ${e.label}</button>`).join('');
  if (status) {
    const traslados = clivoraCitaAplicacion.traslados || [];
    status.textContent = (!manual && traslados.length) ? `Traslados: ${traslados.map(t => t.name).join(', ')}` : '';
    status.style.display = status.textContent ? 'block' : 'none';
  }
}

// Modo manual: un clic elige el estado; otro clic sobre el mismo lo quita.
document.addEventListener('click', (event) => {
  const btn = event.target.closest('#citaAplicacionBtnGroup [data-aplicacion]');
  if (!btn || btn.disabled) return;
  const key = btn.dataset.aplicacion;
  clivoraCitaAplicacion.estado = clivoraCitaAplicacion.estado === key ? '' : key;
  renderCitaAplicacionBlock();
});

async function toggleTipoCitaBlocks(tipoVal, preserveMotivoVal = null) {
  const doctorBlock = document.getElementById('citaDoctorBlock');
  const salaBlock = document.getElementById('citaSalaBlock');
  const cicloFrecuenciaBlock = document.getElementById('citaCicloFrecuenciaBlock');
  const esquemaBlock = document.getElementById('citaEsquemaBlock');
  const fechaHoraBlock = document.getElementById('citaFechaHoraBlock');
  const finBlock = document.getElementById('citaFinBlock');
  const motivoInput = document.getElementById('citaMotivo');

  const cleanTipo = (tipoVal || '').toString().trim().toLowerCase();
  const isConsulta = cleanTipo.startsWith('consulta');

  // Tratamiento necesita doctor, sala, ciclo/frecuencia y fecha/hora
  // (inicio y fin, para reservar la sala por toda la duración real).
  // Consulta también pide fecha/hora de inicio y fin (se precargan desde el
  // día/horario del calendario donde se abrió el modal, pero quedan
  // editables) — Sala y Ciclo/Frecuencia quedan fuera de Consulta (no
  // aplican: una consulta no tiene ciclos de tratamiento).
  if (doctorBlock) doctorBlock.style.display = 'block';
  // Ubicación & Sala: Tratamiento (salas 1–8 / Piso 15: 1–5) y Consulta
  // (consultorios A–E / A–D) — ver populateCitaUbicacionSala.
  if (salaBlock) salaBlock.style.display = 'block';
  populateCitaUbicacionSala(tipoVal, document.getElementById('citaUbicacion')?.value,
    document.getElementById('citaSala')?.value);
  if (cicloFrecuenciaBlock) cicloFrecuenciaBlock.style.display = isConsulta ? 'none' : 'block';
  if (esquemaBlock) esquemaBlock.style.display = isConsulta ? 'none' : 'block';
  if (fechaHoraBlock) fechaHoraBlock.style.display = 'block';
  if (finBlock) finBlock.style.display = 'block';
  renderCitaAplicacionBlock();

  if (motivoInput) {
    const catalogs = await ensureCitasCatalogs();
    const reasonType = isConsulta ? 'C' : 'T';
    const targetMotivos = catalogs.reasons.filter(r => r.type === reasonType).map(r => r.name);
    const activeVal = preserveMotivoVal !== null ? preserveMotivoVal : motivoInput.value;

    motivoInput.innerHTML = '';
    targetMotivos.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      motivoInput.appendChild(opt);
    });

    if (activeVal && targetMotivos.includes(activeVal)) {
      motivoInput.value = activeVal;
    } else if (targetMotivos.length) {
      motivoInput.value = targetMotivos[0];
    }
  }
}
window.toggleTipoCitaBlocks = toggleTipoCitaBlocks;

// Bloquea toda edición dentro de #addCitaModal: puede abrir y ver el
// detalle de la cita, pero ningún campo/botón de escritura queda
// disponible. Se deja fuera de la lista de bloqueo #closeAddCitaModal
// (cerrar el modal no modifica nada) y #citaVerPacienteBtn (navega al
// expediente del paciente, sección donde quien use esto puede seguir
// teniendo edición — no es una acción de escritura sobre la cita en sí).
// Compartida por el modo solo-lectura del rol Doctor (siempre) y por
// Recepción (solo cuando la cita abierta es de tipo Tratamiento, ver
// applyRecepcionAgendaRestrictions más abajo).
function lockCitaModalReadOnly(modal) {
  if (!modal) return;
  const keepEnabled = new Set(['closeAddCitaModal', 'citaVerPacienteBtn']);
  modal.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
  modal.querySelectorAll('button').forEach((btn) => {
    if (!keepEnabled.has(btn.id)) btn.disabled = true;
  });
  const saveBtn = document.getElementById('saveAddCitaBtn');
  if (saveBtn) saveBtn.style.display = 'none';
}

// Rol Doctor en modo solo lectura (ver isDoctorReadOnly en /api/me): la
// Agenda completa queda bloqueada, sin importar el tipo de cita.
function applyDoctorReadOnlyToCitaModal(modal) {
  if (!modal || !window.clivoraCurrentUser?.isDoctorReadOnly) return;
  lockCitaModalReadOnly(modal);
}

// Rol Admisiones/Recepción y Jefe de Admisiones/Recepción (ver
// isRecepcionLimited/isJefeRecepcionLimited en /api/me): ninguno de los dos
// crea Tratamientos, así que (a) la opción "Tratamiento" del <select> de
// tipo se deshabilita para que nunca puedan crear una cita de ese tipo ni
// convertir una Consulta existente en Tratamiento, y (b) si la cita que se
// está abriendo YA es de tipo Tratamiento (ej. la crearon desde otro rol),
// se bloquea en solo lectura — pueden verla pero no tocarla. Las citas tipo
// Consulta quedan con edición completa para ambos roles.
function applyRecepcionAgendaRestrictions(modal, tipoInput) {
  const user = window.clivoraCurrentUser;
  if (!modal || !(user?.isRecepcionLimited || user?.isJefeRecepcionLimited)) return;
  const tratamientoOption = tipoInput?.querySelector('option[value="Tratamiento"]');
  if (tratamientoOption) tratamientoOption.disabled = true;
  if (tipoInput && tipoInput.value === 'Tratamiento') {
    lockCitaModalReadOnly(modal);
  }
}

window.openCitaModal = function(preset = {}) {
  const modal = document.getElementById('addCitaModal');
  const modalTitle = document.getElementById('addCitaModalTitle');
  if (!modal) return;

  // clivoraPatientsCatalog/clivoraCitasCatalogsCache se cachean en memoria para
  // toda la sesión (ver ensurePatientsCatalog/ensureCitasCatalogs) — sin
  // invalidarlos aquí, un doctor asignado a un paciente (o un contacto recién
  // marcado is_doctor) DESPUÉS de la primera vez que se abrió este modal en
  // la sesión actual seguía sin aparecer, porque el buscador de pacientes y
  // el <select> de Doctor seguían leyendo el snapshot viejo. Se limpian al
  // abrir el modal para que la siguiente búsqueda/población traiga los datos
  // reales más recientes.
  clivoraPatientsCatalog = null;
  clivoraCitasCatalogsCache = null;

  const pacienteSearch = document.getElementById('citaPacienteSearch');
  const clearModalPatientSearchBtn = document.getElementById('clearModalPatientSearchBtn');
  const verPacienteBtn = document.getElementById('citaVerPacienteBtn');
  const especialidadSelect = document.getElementById('citaConEspecialidad');
  const doctorSelect = document.getElementById('citaDoctor');
  const enfermeraSelect = document.getElementById('citaEnfermera');
  const ubicacionSelect = document.getElementById('citaUbicacion');
  const salaSelect = document.getElementById('citaSala');
  // Cada ubicación tiene sus propias salas (y son distintas en Consulta y
  // Tratamiento) — al cambiar de ubicación se repuebla Sala para no dejar
  // elegir una que ahí no existe. Se engancha una sola vez (openCitaModal
  // corre en cada apertura).
  if (ubicacionSelect && !ubicacionSelect.dataset.salaSyncBound) {
    ubicacionSelect.dataset.salaSyncBound = '1';
    ubicacionSelect.addEventListener('change', (e) => {
      // populateCitaUbicacionSala despacha "change" para refrescar el selector
      // visual de Clivora; solo un cambio hecho por el usuario repuebla las salas.
      if (!e.isTrusted) return;
      populateCitaUbicacionSala(document.getElementById('citaTipo')?.value,
        ubicacionSelect.value, document.getElementById('citaSala')?.value);
    });
  }
  const fechaInput = document.getElementById('citaFecha');
  const horaInput = document.getElementById('citaHora');
  const fechaFinInput = document.getElementById('citaFechaFin');
  const horaFinInput = document.getElementById('citaHoraFin');
  const tipoInput = document.getElementById('citaTipo');
  const motivoInput = document.getElementById('citaMotivo');
  const cicloInput = document.getElementById('citaCiclo');
  const frecuenciaSelect = document.getElementById('citaFrecuencia');
  const notaTextarea = document.getElementById('citaNota');
  const creadoInfoBlock = document.getElementById('citaCreadoInfoBlock');
  const creadoElInfo = document.getElementById('citaCreadoElInfo');
  const creadoPorInfo = document.getElementById('citaCreadoPorInfo');
  const successOverlay = document.getElementById('addCitaSuccessOverlay');
  const fechaError = document.getElementById('citaFechaError');
  const horaError = document.getElementById('citaHoraError');
  const fechaFinError = document.getElementById('citaFechaFinError');
  const horaFinError = document.getElementById('citaHoraFinError');
  const patientListDropdown = document.getElementById('citaPatientList');
  const statusChoiceBtns = document.querySelectorAll('#citaStatusBtnGroup .status-choice-btn');

  const statusBlock = document.getElementById('citaStatusBlock');
  const checkBlock = document.getElementById('citaCheckBlock');
  const checkInBtn = document.getElementById('citaCheckInBtn');
  const checkOutBtn = document.getElementById('citaCheckOutBtn');
  const checkInStatus = document.getElementById('citaCheckInStatus');
  const checkOutStatus = document.getElementById('citaCheckOutStatus');
  const ventaBlock = document.getElementById('citaVentaBlock');
  const ventaList = document.getElementById('citaVentaList');

  function updateVentaBlock(data) {
    // El backend (clivora_tratamiento_order_save) crea la venta sobre
    // cualquier cita, sea Consulta o Tratamiento — no hay
    // restricción real de tipo. Visible en cualquier estado salvo
    // Rechazado/Pendiente (antes solo se mostraba en "aprobado" exacto, así
    // que desaparecía en cuanto la cita avanzaba a en_progreso/finalizado
    // vía check-in/check-out).
    const hiddenStatuses = ['rechazado', 'pendiente', 'desfasado'];
    const show = !!(currentEditingCitaId && !hiddenStatuses.includes(currentSelectedModalStatus));
    if (ventaBlock) ventaBlock.style.display = show ? 'block' : 'none';
    const orders = (data && data.saleOrders) || [];
    if (ventaList) {
      ventaList.innerHTML = orders.length
        ? orders.map(o => `<button type="button" class="btn-secondary venta-chip-btn btn-anim-lift" data-order-id="${o.id}" style="padding: 6px 14px; font-size: 12px;">${o.name}</button>`).join('')
        : `<span style="font-size: 13px; color: var(--text-muted); font-weight: 600;">Sin ventas registradas</span>`;
    }
    // Si la cita ya tiene una venta asignada no tiene sentido ofrecer crear
    // otra — el botón solo debe aparecer mientras "Sin ventas registradas".
    const ventaCreateBtnEl = document.getElementById('citaVentaCreateBtn');
    if (ventaCreateBtnEl) ventaCreateBtnEl.style.display = orders.length ? 'none' : '';
    updateAplicacionBlock(data);
  }
  window.updateCitaVentaBlock = () => updateVentaBlock(preset);

  function updateCheckButtons(data) {
    if (checkInBtn) {
      checkInBtn.classList.toggle('checked', !!(data && data.checkIn));
      checkInBtn.disabled = !!(data && data.checkIn);
    }
    if (checkOutBtn) {
      checkOutBtn.classList.toggle('checked', !!(data && data.checkOut));
      checkOutBtn.disabled = !!(data && data.checkOut);
    }
    if (checkInStatus) {
      checkInStatus.textContent = (data && data.checkIn)
        ? `Check-in: ${data.checkInAt}${data.checkInBy ? ' — ' + data.checkInBy : ''}`
        : '';
    }
    if (checkOutStatus) {
      checkOutStatus.textContent = (data && data.checkOut)
        ? `Check-out: ${data.checkOutAt}${data.checkOutBy ? ' — ' + data.checkOutBy : ''}`
        : '';
    }
  }
  window.updateCitaCheckButtons = updateCheckButtons;

  // Estado de "Aplicación de medicamento" de la cita abierta (ver
  // renderCitaAplicacionBlock). Una cita nueva todavía no trae "aplicacion":
  // el modo sale de los catálogos de citas.
  function updateAplicacionBlock(data) {
    const aplicacion = data && data.aplicacion;
    clivoraCitaAplicacion = {
      modo: (aplicacion && aplicacion.modo) || clivoraCitaAplicacion.modo || 'manual',
      estado: (aplicacion && aplicacion.estado) || '',
      traslados: (aplicacion && aplicacion.traslados) || [],
      hasVenta: !!(data && data.saleOrders && data.saleOrders.length),
    };
    // Casilla "Stock": solo el grupo Farmacia la cambia (canEditStock).
    const stockCheck = document.getElementById('citaStockCheck');
    if (stockCheck) {
      stockCheck.checked = !!(data && data.stockAplicacion);
      stockCheck.disabled = !window.clivoraCurrentUser?.canEditStock;
      const stockLabel = document.getElementById('citaStockLabel');
      if (stockLabel) {
        stockLabel.classList.toggle('is-disabled', stockCheck.disabled);
        stockLabel.title = stockCheck.disabled ? 'Solo el grupo Farmacia puede cambiar el stock' : '';
      }
    }
    renderCitaAplicacionBlock();
    if (!aplicacion) {
      ensureCitasCatalogs().then(catalogs => {
        if (catalogs && catalogs.aplicacionModo) clivoraCitaAplicacion.modo = catalogs.aplicacionModo;
        renderCitaAplicacionBlock();
      });
    }
  }

  // "Ver expediente" del bloque Paciente — antes la única forma de abrir el
  // expediente de un paciente en toda la app era el botón "Ver Paciente" de
  // la lista de Pacientes. Como este mismo modal de cita se reutiliza desde
  // la Agenda y desde el ícono de carpeta de Tratamientos ("Ver/confirmar
  // cita", ver openTratamientoCitaModal), agregar el enlace aquí cubre
  // ambos lugares con un solo cambio en vez de repetirlo en cada tarjeta.
  function updateVerPacienteBtn() {
    if (!verPacienteBtn) return;
    if (currentCitaPacienteId) {
      verPacienteBtn.dataset.id = currentCitaPacienteId;
      verPacienteBtn.dataset.name = pacienteSearch?.value || '';
      verPacienteBtn.dataset.exp = '';
      verPacienteBtn.style.display = 'inline-block';
    } else {
      verPacienteBtn.style.display = 'none';
    }
  }
  // initializeAgendarCitaModule() (más abajo, cablea los listeners fijos del
  // modal) es un closure totalmente aparte del de esta función — sin esto,
  // el click en un resultado del buscador de pacientes tiraba
  // "updateVerPacienteBtn is not defined" (no está en su scope).
  window.updateVerPacienteBtn = updateVerPacienteBtn;

  if (successOverlay) successOverlay.style.display = 'none';
  const createSaleBtn = document.getElementById('addCitaCreateSaleBtn');
  if (createSaleBtn) createSaleBtn.style.display = 'none';
  const closeSaleBtn = document.getElementById('addCitaCloseSaleBtn');
  if (closeSaleBtn) closeSaleBtn.style.display = 'none';
  if (fechaError) fechaError.style.display = 'none';
  if (horaError) horaError.style.display = 'none';
  if (fechaFinError) fechaFinError.style.display = 'none';
  if (horaFinError) horaFinError.style.display = 'none';
  if (patientListDropdown) patientListDropdown.style.display = 'none';
  const pacienteErrorEl = document.getElementById('citaPacienteError');
  if (pacienteErrorEl) pacienteErrorEl.style.display = 'none';
  const solicitanteInfoEl = document.getElementById('citaSolicitanteInfo');
  if (solicitanteInfoEl) solicitanteInfoEl.style.display = 'none';
  if (!preset.paciente && preset.solicitanteNombre && solicitanteInfoEl) {
    const partes = [`Solicitado por: ${preset.solicitanteNombre}`];
    if (preset.solicitanteTelefono) partes.push(`Tel: ${preset.solicitanteTelefono}`);
    if (preset.solicitanteExpediente) partes.push(`Expediente: ${preset.solicitanteExpediente}`);
    if (preset.solicitanteRfc) partes.push(`RFC: ${preset.solicitanteRfc}`);
    solicitanteInfoEl.textContent = `${partes.join(' · ')} — sin vincular a un paciente, búscalo arriba.`;
    solicitanteInfoEl.style.display = 'block';
  }

  function updateStatusButtons(targetStatus) {
    currentSelectedModalStatus = targetStatus || 'aprobado';
    statusChoiceBtns.forEach(btn => {
      if (btn.dataset.status === currentSelectedModalStatus) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    toggleRejectionReasonBlock(currentSelectedModalStatus);
    updateVentaBlock(preset);
  }

  // Archivos adjuntos del bloque Notas (vacío en una cita nueva).
  loadCitaAdjuntos(preset.id || null);

  if (preset.id) {
    currentEditingCitaId = preset.id;
    currentCitaPacienteId = preset.pacienteId || null;
    if (statusBlock) statusBlock.style.display = 'block';
    if (modalTitle) modalTitle.textContent = 'Editar Cita';
    if (tipoInput) tipoInput.value = preset.tipo || 'Consulta';
    if (motivoInput) motivoInput.value = preset.motivo || 'Consulta médica';
    populateCitaUbicacionSala(preset.tipo || 'Consulta', preset.lugarId, preset.salaId);
    if (pacienteSearch) {
      pacienteSearch.value = preset.paciente || '';
      if (clearModalPatientSearchBtn) clearModalPatientSearchBtn.style.display = preset.paciente ? 'flex' : 'none';
    }
    populateCitaEspecialidadAndDoctor(especialidadSelect, doctorSelect, preset.doctorId, preset.especialidadId);
    if (enfermeraSelect) populateCitaEnfermeraSelect(enfermeraSelect, preset.nurseId);
    const rejectionSelect = document.getElementById('citaRejectionReason');
    if (rejectionSelect) populateCitaRejectionReasonSelect(rejectionSelect, preset.rejectionReasonId);
    if (cicloInput) cicloInput.value = preset.ciclo || 'Ciclo 1';
    if (frecuenciaSelect) frecuenciaSelect.value = preset.frecuencia || 'Primera vez';
    if (fechaInput) {
      fechaInput.removeAttribute('min');
      fechaInput.value = preset.fecha || '';
      fechaInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (horaInput) {
      horaInput.value = preset.hora || '08:00';
      horaInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (fechaFinInput || horaFinInput) {
      const fallbackFin = addOneHourToDateTime(
        preset.fecha || fechaInput.value, preset.hora || horaInput.value);
      if (fechaFinInput) {
        fechaFinInput.removeAttribute('min');
        fechaFinInput.value = preset.fechaFin || fallbackFin.fecha;
        fechaFinInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (horaFinInput) {
        horaFinInput.value = preset.horaFin || fallbackFin.hora;
        horaFinInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (notaTextarea) {
      setEditableFieldValue(notaTextarea, preset.nota || '');
      autoResizeTextarea(notaTextarea);
    }
    setEditableFieldValue(document.getElementById('citaAnotacionesEnfermeria'), preset.anotacionesEnfermeria || '');
    const esquemaInput = document.getElementById('citaEsquemaTratamiento');
    if (esquemaInput) esquemaInput.value = preset.esquemaTratamiento || '';
    applyCitaAnotacionesPermission();
    if (creadoInfoBlock) {
      if (preset.createdAt || preset.createdBy) {
        creadoInfoBlock.style.display = 'block';
        if (creadoElInfo) creadoElInfo.textContent = preset.createdAt ? `Creado el: ${preset.createdAt}` : '';
        if (creadoPorInfo) creadoPorInfo.textContent = preset.createdBy ? `Creado por: ${preset.createdBy}` : '';
      } else {
        creadoInfoBlock.style.display = 'none';
      }
    }

    updateStatusButtons(preset.estado || 'aprobado');
    if (checkBlock) checkBlock.style.display = 'block';
    updateCheckButtons(preset);
  } else {
    currentEditingCitaId = null;
    currentCitaPacienteId = preset.pacienteId || null;
    if (statusBlock) statusBlock.style.display = 'none';
    if (checkBlock) checkBlock.style.display = 'none';
    if (modalTitle) modalTitle.textContent = 'Agendar Cita';
    if (tipoInput) tipoInput.value = preset.tipo || 'Consulta';
    if (motivoInput) motivoInput.value = preset.motivo || 'Consulta médica';
    populateCitaUbicacionSala(preset.tipo || 'Consulta', null, null);
    if (pacienteSearch) {
      pacienteSearch.value = preset.paciente || '';
      if (clearModalPatientSearchBtn) clearModalPatientSearchBtn.style.display = preset.paciente ? 'flex' : 'none';
    }
    populateCitaEspecialidadAndDoctor(especialidadSelect, doctorSelect, preset.doctorId, preset.especialidadId);
    if (enfermeraSelect) populateCitaEnfermeraSelect(enfermeraSelect, preset.nurseId);
    if (cicloInput) cicloInput.value = 'Ciclo 1';
    if (frecuenciaSelect) frecuenciaSelect.value = 'Primera vez';
    if (notaTextarea) {
      setEditableFieldValue(notaTextarea, '');
      autoResizeTextarea(notaTextarea);
    }
    setEditableFieldValue(document.getElementById('citaAnotacionesEnfermeria'), '');
    const esquemaInput = document.getElementById('citaEsquemaTratamiento');
    if (esquemaInput) esquemaInput.value = '';
    applyCitaAnotacionesPermission();
    if (creadoInfoBlock) creadoInfoBlock.style.display = 'none';

    const todayStr = new Date().toISOString().split('T')[0];
    if (fechaInput) {
      // OJO: antes se ponía fechaInput.min = todayStr aquí. Eso es una
      // restricción NATIVA del <input type="date"> — con eso puesto, el
      // navegador bloquea el evento "submit" completo en cuanto la fecha
      // queda antes de hoy, sin que corra ni un solo listener nuestro. Por
      // eso la advertencia de "esto ya pasó" del submit handler de abajo
      // nunca llegaba a mostrarse: el formulario ni siquiera se enviaba.
      fechaInput.value = preset.fecha || todayStr;
      fechaInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (horaInput) {
      horaInput.value = preset.hora || '08:00';
      horaInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (fechaFinInput || horaFinInput) {
      const fallbackFin = addOneHourToDateTime(
        preset.fecha || fechaInput.value || todayStr, preset.hora || horaInput.value || '08:00');
      if (fechaFinInput) {
        fechaFinInput.value = preset.fechaFin || fallbackFin.fecha;
        fechaFinInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (horaFinInput) {
        horaFinInput.value = preset.horaFin || fallbackFin.hora;
        horaFinInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    updateStatusButtons('aprobado');
  }

  updateVerPacienteBtn();

  if (tipoInput) {
    tipoInput.onchange = function() {
      toggleTipoCitaBlocks(this.value);
    };
    // citaTipo es un <select> envuelto por enhanceCustomSelect: su trigger
    // visual solo se refresca al recibir un evento 'change' real, así que
    // el "tipoInput.value = ..." de arriba (precarga del preset, o reseteo
    // a "Consulta" al abrir el modal en blanco) dejaba el trigger mostrando
    // la última opción elegida a mano en la apertura anterior — ej. seguía
    // diciendo "Tratamiento" de una cita previa aunque el <select> real ya
    // hubiera vuelto a "Consulta", con los bloques de Sala/Fecha-Hora ya
    // ocultos (correctos para Consulta) pese a que el trigger decía lo
    // contrario.
    tipoInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  toggleTipoCitaBlocks(tipoInput ? tipoInput.value : 'Consulta', preset.motivo || null);
  applyDoctorReadOnlyToCitaModal(modal);
  applyRecepcionAgendaRestrictions(modal, tipoInput);
  modal.classList.add('open');
  // Los cálculos de autoResizeTextarea hechos arriba miden scrollHeight
  // mientras el modal todavía estaba oculto (display:none), lo que da 0 y
  // deja la nota siempre al tamaño mínimo sin importar el contenido — se
  // repite aquí, ya con el modal visible, para que la medición sea real.
  if (notaTextarea) autoResizeTextarea(notaTextarea);
};

function initializeAgendarCitaModule() {
  const addCitaModal = document.getElementById('addCitaModal');
  const openAddCitaModal = document.getElementById('openAddCitaModal');
  const closeAddCitaModal = document.getElementById('closeAddCitaModal');
  const addCitaForm = document.getElementById('addCitaForm');
  const successOverlay = document.getElementById('addCitaSuccessOverlay');

  if (!addCitaModal) return;

  const pacienteSearch = document.getElementById('citaPacienteSearch');
  const clearModalPatientSearchBtn = document.getElementById('clearModalPatientSearchBtn');
  const patientListDropdown = document.getElementById('citaPatientList');
  const especialidadSelect = document.getElementById('citaConEspecialidad');
  const doctorSelect = document.getElementById('citaDoctor');
  const enfermeraSelect = document.getElementById('citaEnfermera');
  attachCitaSelectSearch(doctorSelect, 'Escriba para buscar doctor...');
  attachCitaSelectSearch(enfermeraSelect, 'Escriba para buscar enfermera...');
  const fechaInput = document.getElementById('citaFecha');
  const horaInput = document.getElementById('citaHora');
  const fechaFinInput = document.getElementById('citaFechaFin');
  const horaFinInput = document.getElementById('citaHoraFin');
  const fechaHoraBlock = document.getElementById('citaFechaHoraBlock');
  const finBlock = document.getElementById('citaFinBlock');
  const fechaError = document.getElementById('citaFechaError');
  const horaError = document.getElementById('citaHoraError');
  const fechaFinError = document.getElementById('citaFechaFinError');
  const horaFinError = document.getElementById('citaHoraFinError');
  const tipoInput = document.getElementById('citaTipo');
  const motivoInput = document.getElementById('citaMotivo');
  const cicloInput = document.getElementById('citaCiclo');
  const frecuenciaSelect = document.getElementById('citaFrecuencia');
  const notaTextarea = document.getElementById('citaNota');
  const statusChoiceBtns = document.querySelectorAll('#citaStatusBtnGroup .status-choice-btn');

  statusChoiceBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const st = btn.dataset.status;
      if (!st) return;
      currentSelectedModalStatus = st;
      statusChoiceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      toggleRejectionReasonBlock(st);
      if (st === 'rechazado') {
        const rejectionSelect = document.getElementById('citaRejectionReason');
        if (rejectionSelect && !rejectionSelect.options.length) populateCitaRejectionReasonSelect(rejectionSelect);
      }
      if (typeof window.updateCitaVentaBlock === 'function') window.updateCitaVentaBlock();
    });
  });

  async function doCitaCheck(tipo) {
    if (!currentEditingCitaId) return;
    try {
      const response = await fetch(`/clivora/api/citas/${currentEditingCitaId}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data && data.error === 'not_checked_in') {
          showClivoraAlertModal('Debes hacer check-in antes de check-out.', 'Check-in requerido');
        } else if (data && data.error === 'not_aprobado') {
          showClivoraAlertModal('Solo se puede hacer check-in a una cita aprobada.', 'Cita no aprobada');
        } else if (data && data.error === 'invalid_transition') {
          showClivoraAlertModal(data.message || 'No se pudo registrar el check.', 'Transición no permitida');
        } else {
          showClivoraAlertModal('No se pudo registrar el check.');
        }
        return;
      }
      if (typeof window.updateCitaCheckButtons === 'function') window.updateCitaCheckButtons(data);
      // El check-in/check-out avanza "estado" a en_progreso/finalizado en el
      // backend (ver _ESTADO_TRANSITIONS en clinic_appointment.py), pero
      // currentSelectedModalStatus se había quedado con el valor de cuando
      // se abrió el modal (p.ej. "aprobado") — si después el usuario le daba
      // "Guardar" sin tocar nada más, buildCitaPayload() reenviaba ese valor
      // viejo y el backend lo rechazaba ("no se puede cambiar de en_progreso
      // a aprobado"). Se resincroniza aquí con el estado real ya devuelto.
      if (data && data.estado) {
        currentSelectedModalStatus = data.estado;
        statusChoiceBtns.forEach(b => b.classList.toggle('active', b.dataset.status === data.estado));
      }
      if (window.refreshDynamicCalendar) await window.refreshDynamicCalendar();
      // clivoraTratamientos (Kanban/lista de Tratamientos) es un array cacheado
      // en memoria aparte del calendario — sin recargarlo aquí, el check-in/
      // check-out sí quedaba guardado pero la tarjeta se quedaba en
      // su columna vieja hasta refrescar el navegador a mano.
      if (typeof loadTratamientos === 'function') await loadTratamientos();
    } catch (error) {
      console.error('Error al registrar check-in/check-out:', error);
      showClivoraAlertModal('No se pudo registrar el check.');
    }
  }

  const checkInBtn = document.getElementById('citaCheckInBtn');
  const checkOutBtn = document.getElementById('citaCheckOutBtn');
  if (checkInBtn) checkInBtn.addEventListener('click', () => doCitaCheck('check_in'));
  if (checkOutBtn) checkOutBtn.addEventListener('click', () => doCitaCheck('check_out'));

  const ventaList = document.getElementById('citaVentaList');
  if (ventaList) {
    ventaList.addEventListener('click', (event) => {
      const chip = event.target.closest('.venta-chip-btn');
      if (!chip) return;
      openVentaViewModal(parseInt(chip.dataset.orderId, 10));
    });
  }

  // Payload completo de la cita — usado tanto por el submit normal del
  // formulario como por "+ Crear venta" (ver más abajo), que necesita
  // persistir el estado recién elegido (ej. Aprobado) antes de saltar al
  // modal de Modificar Tratamiento. El backend reconstruye TODOS los campos
  // de la cita a partir de este payload (ver _aplicar_payload en apps/agenda/compat.py
  // en el controlador), así que no se puede mandar solo {estado: ...} sin
  // borrar el resto de los campos de la cita.
  function buildCitaPayload() {
    const ubicacionSelect = document.getElementById('citaUbicacion');
    const salaSelect = document.getElementById('citaSala');
    // Ubicación + Sala aplican a los dos tipos: Tratamiento (salas 1–8) y
    // Consulta (consultorios A–E / A–D) — ver populateCitaUbicacionSala.
    return {
      tipo: tipoInput ? tipoInput.value : 'Consulta',
      motivo: motivoInput ? motivoInput.value : 'Consulta médica',
      pacienteId: currentCitaPacienteId,
      doctorId: doctorSelect && doctorSelect.value ? Number(doctorSelect.value) : false,
      nurseId: enfermeraSelect && enfermeraSelect.value ? Number(enfermeraSelect.value) : false,
      ubicacion: ubicacionSelect ? ubicacionSelect.value : '',
      sala: salaSelect ? salaSelect.value : '',
      ciclo: cicloInput ? cicloInput.value : '',
      frecuencia: frecuenciaSelect ? frecuenciaSelect.value : 'Primera vez',
      fecha: fechaInput.value,
      hora: horaInput.value,
      fechaFin: fechaFinInput ? fechaFinInput.value : '',
      horaFin: horaFinInput ? horaFinInput.value : '',
      nota: notaTextarea ? getEditableFieldValue(notaTextarea) : '',
      // Solo la manda quien puede modificarla (Enfermería, ver
      // applyCitaAnotacionesPermission).
      anotacionesEnfermeria: canEditCitaAnotaciones()
        ? getEditableFieldValue(document.getElementById('citaAnotacionesEnfermeria'))
        : undefined,
      esquemaTratamiento: canEditCitaAnotaciones()
        ? (document.getElementById('citaEsquemaTratamiento')?.value || '')
        : undefined,
      estado: currentEditingCitaId ? (currentSelectedModalStatus || 'aprobado') : 'pendiente',
      // Solo en modo manual (en modo traslados el estado no se captura).
      aplicacionEstado: clivoraCitaAplicacion.modo === 'traslados' ? undefined : (clivoraCitaAplicacion.estado || ''),
      // Casilla "Stock" (solo la manda quien puede cambiarla: grupo Farmacia).
      stockAplicacion: (() => {
        const el = document.getElementById('citaStockCheck');
        return (el && window.clivoraCurrentUser?.canEditStock) ? el.checked : undefined;
      })(),
      rejectionReasonId: (() => {
        const el = document.getElementById('citaRejectionReason');
        return el && el.value ? Number(el.value) : false;
      })(),
    };
  }

  const ventaCreateBtn = document.getElementById('citaVentaCreateBtn');
  if (ventaCreateBtn) {
    ventaCreateBtn.addEventListener('click', async () => {
      if (!currentEditingCitaId) return;
      const citaId = currentEditingCitaId;
      // Este botón saltaba directo al modal de Modificar Tratamiento sin
      // pasar por el submit del formulario de la cita — si el usuario acababa
      // de cambiar el estado a "Aprobado" en este mismo modal, ese cambio
      // nunca se guardaba. Se persiste aquí antes de continuar.
      try {
        const response = await fetch(`/clivora/api/citas/${citaId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildCitaPayload()),
        });
        if (!response.ok) {
          showClivoraAlertModal('No se pudo guardar el estado de la cita antes de crear la venta.');
          return;
        }
      } catch (error) {
        console.error('Error al guardar la cita antes de crear la venta:', error);
        showClivoraAlertModal('No se pudo guardar el estado de la cita antes de crear la venta.');
        return;
      }
      await loadTratamientos();
      // clivoraTratamientos solo trae citas de tipo Tratamiento (ver el
      // endpoint /api/tratamientos), así que una Consulta nunca aparece ahí
      // aunque la venta sí se pueda crear para ella — el backend
      // (clivora_tratamiento_order_save) no distingue tipo. Este
      // fallback arma los mismos datos que usa el wizard directamente desde
      // el formulario de la cita, para cuando openTratamientoOrderModal no
      // la encuentre en esa caché.
      const fallbackTrat = {
        id: citaId,
        paciente: pacienteSearch?.value || '',
        fechaInicio: `${fechaInput?.value || ''} ${horaInput?.value || ''}`.trim(),
        fechaFin: `${(fechaFinInput?.value || fechaInput?.value || '')} ${horaFinInput?.value || ''}`.trim(),
        sala: document.getElementById('citaSala')?.value || '',
        treatmentName: '',
      };
      addCitaModal.classList.remove('open');
      openTratamientoOrderModal(citaId, fallbackTrat);
    });
  }

  // La textarea de Nota vive en un panel chico dentro del modal de la cita
  // y se queda corta con notas largas (ej. las que llegan generadas por
  // Appointments con organizador/contacto). "Expandir" la copia a un modal
  // más grande para leerla/editarla completa; "Guardar" ahí copia el valor
  // de vuelta al campo de origen, "Cerrar" descarta los cambios hechos ahí.
  // El mismo modal sirve para la nota (Updates) y para las Anotaciones de
  // Enfermería: citaNotaExpandTarget es el campo que se está expandiendo.
  const btnExpandCitaNota = document.getElementById('btnExpandCitaNota');
  const btnExpandCitaAnotaciones = document.getElementById('btnExpandCitaAnotaciones');
  const anotacionesEditor = document.getElementById('citaAnotacionesEnfermeria');
  const modalCitaNotaExpandida = document.getElementById('modalCitaNotaExpandida');
  const citaNotaExpandida = document.getElementById('citaNotaExpandida');
  let citaNotaExpandTarget = null;
  const openCitaNotaExpandida = (target, title) => {
    if (!target || !modalCitaNotaExpandida || !citaNotaExpandida) return;
    citaNotaExpandTarget = target;
    const titleEl = document.getElementById('citaNotaExpandidaTitle');
    if (titleEl) titleEl.textContent = title;
    setEditableFieldValue(citaNotaExpandida, getEditableFieldValue(target));
    // Las anotaciones sin permiso se abren solo para leer.
    const readOnly = target === anotacionesEditor && !canEditCitaAnotaciones();
    citaNotaExpandida.setAttribute('contenteditable', readOnly ? 'false' : 'true');
    const toolbar = citaNotaExpandida.previousElementSibling;
    if (toolbar && toolbar.classList.contains('rich-text-toolbar')) toolbar.style.display = readOnly ? 'none' : '';
    const saveBtn = document.getElementById('btnSaveCitaNotaExpandida');
    if (saveBtn) saveBtn.style.display = readOnly ? 'none' : '';
    modalCitaNotaExpandida.style.display = 'flex';
    if (!readOnly) citaNotaExpandida.focus();
  };
  if (btnExpandCitaNota) {
    btnExpandCitaNota.addEventListener('click', () => openCitaNotaExpandida(notaTextarea, 'Nota de la Cita'));
  }
  if (btnExpandCitaAnotaciones) {
    btnExpandCitaAnotaciones.addEventListener('click', () => openCitaNotaExpandida(anotacionesEditor, 'Anotaciones de Enfermería'));
  }
  const btnSaveCitaNotaExpandida = document.getElementById('btnSaveCitaNotaExpandida');
  if (btnSaveCitaNotaExpandida) {
    btnSaveCitaNotaExpandida.addEventListener('click', () => {
      if (citaNotaExpandTarget) {
        setEditableFieldValue(citaNotaExpandTarget, getEditableFieldValue(citaNotaExpandida));
        if (citaNotaExpandTarget === notaTextarea) autoResizeTextarea(notaTextarea);
      }
      if (modalCitaNotaExpandida) modalCitaNotaExpandida.style.display = 'none';
    });
  }
  const closeCitaNotaExpandidaModal = document.getElementById('closeCitaNotaExpandidaModal');
  if (closeCitaNotaExpandidaModal) {
    closeCitaNotaExpandidaModal.addEventListener('click', () => {
      if (modalCitaNotaExpandida) modalCitaNotaExpandida.style.display = 'none';
    });
  }
  if (modalCitaNotaExpandida) {
    modalCitaNotaExpandida.addEventListener('click', (event) => {
      if (event.target === modalCitaNotaExpandida) modalCitaNotaExpandida.style.display = 'none';
    });
  }

  if (openAddCitaModal) {
    openAddCitaModal.addEventListener('click', () => {
      window.openCitaModal();
    });
  }

  if (closeAddCitaModal) {
    closeAddCitaModal.addEventListener('click', () => {
      addCitaModal.classList.remove('open');
    });
  }

  if (pacienteSearch && patientListDropdown) {
    async function renderPatientDropdown(filterText = '') {
      const allPatients = await ensurePatientsCatalog();
      // Mismo buscador que el directorio de Pacientes (clivoraSearchPatients):
      // sin acentos, en cualquier orden y con errores de escritura; los
      // parecidos van al final, debajo de "¿Quisiste decir…?".
      const { exact, suggestions } = clivoraSearchPatients(allPatients, filterText);
      const limited = exact.slice(0, 5);
      const limitedSuggestions = suggestions.slice(0, 5 - limited.length);

      patientListDropdown.innerHTML = '';
      if (limited.length === 0 && limitedSuggestions.length === 0) {
        patientListDropdown.innerHTML = `<div style="padding: 10px; font-size: 12px; color: var(--text-muted); text-align: center;">No se encontraron pacientes</div>`;
      } else {
        const rows = limited.map(patient => ({ patient }));
        if (limitedSuggestions.length) {
          rows.push({ heading: limited.length ? 'Nombres parecidos' : '¿Quisiste decir…?' });
          limitedSuggestions.forEach(patient => rows.push({ patient }));
        }
        rows.forEach(({ patient, heading }) => {
          if (heading) {
            const title = document.createElement('div');
            title.className = 'patient-search-suggestions-title is-dropdown';
            title.textContent = heading;
            patientListDropdown.appendChild(title);
            return;
          }
          const item = document.createElement('div');
          item.className = 'cita-patient-item';
          item.innerHTML = `
            <span>${patient.name}</span>
            <span class="patient-exp-badge">#${patient.exp || ''}</span>
          `;
          item.addEventListener('click', async () => {
            pacienteSearch.value = patient.name;
            currentCitaPacienteId = patient.id;
            if (clearModalPatientSearchBtn) clearModalPatientSearchBtn.style.display = 'flex';
            patientListDropdown.style.display = 'none';
            const pacienteError = document.getElementById('citaPacienteError');
            if (pacienteError) pacienteError.style.display = 'none';
            const solicitanteInfo = document.getElementById('citaSolicitanteInfo');
            if (solicitanteInfo) solicitanteInfo.style.display = 'none';
            if (typeof window.updateVerPacienteBtn === 'function') window.updateVerPacienteBtn();

            // Precarga el doctor/especialidad asignado al paciente (campo
            // "Médico/Doctor Asignado" de su ficha) — queda editable por si
            // ese médico está de vacaciones y hay que agendar con otro.
            const citaDoctorSelect = document.getElementById('citaDoctor');
            const citaEspecialidadSelect = document.getElementById('citaConEspecialidad');
            // Antes se emparejaba la especialidad por TEXTO visible contra
            // patient.doctorSpecialty (ej. "Cirujano") en vez de por id —
            // si existían 2 catálogos de especialidad con el mismo nombre
            // (o cualquier variación de mayúsculas/acentos), el match podía
            // resolver a un id DISTINTO del que realmente tiene el doctor
            // asignado.
            //
            // El orden importa: antes se ponía primero el 'change' de
            // especialidad (dispara el listener global de abajo, que repuebla
            // Doctor usando el doctorSelect.value VIEJO — vacío en un modal
            // recién abierto) y DESPUÉS esta misma llamada con el doctorId
            // correcto. Ambas llamadas son async y, con el catálogo de citas
            // todavía sin cachear (primer uso del modal en la sesión),
            // disparan dos fetch en paralelo al mismo endpoint — cuál de las
            // dos termina último gana el <select> final, así que la
            // repoblación "vieja" (sin selección) podía llegar después y
            // dejar el doctor sin preseleccionar aunque el paciente sí
            // tuviera uno asignado. Al hacer esta llamada primero y esperarla
            // (await) antes de tocar Especialidad, queda como única fuente de
            // verdad: fija Doctor Y lo filtra por la especialidad correcta en
            // un solo paso, sin ninguna llamada en paralelo con la que competir.
            if (citaDoctorSelect) {
              await populateCitaDoctorSelect(citaDoctorSelect, patient.doctorId || '', patient.doctorSpecialtyId || '', true);
            }
            if (citaEspecialidadSelect && patient.doctorSpecialtyId) {
              citaEspecialidadSelect.value = String(patient.doctorSpecialtyId);
              // doctorSelect.value ya quedó correcto arriba, así que el
              // listener global que este 'change' dispara (repuebla Doctor
              // con su valor actual) solo confirma la misma selección — deja
              // de ser una carrera contra la línea de arriba.
              citaEspecialidadSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          patientListDropdown.appendChild(item);
        });
      }
      patientListDropdown.style.display = 'block';
    }

    pacienteSearch.addEventListener('focus', () => {
      renderPatientDropdown(pacienteSearch.value);
    });

    pacienteSearch.addEventListener('input', () => {
      currentCitaPacienteId = null;
      if (clearModalPatientSearchBtn) {
        clearModalPatientSearchBtn.style.display = pacienteSearch.value ? 'flex' : 'none';
      }
      renderPatientDropdown(pacienteSearch.value);
      if (typeof window.updateVerPacienteBtn === 'function') window.updateVerPacienteBtn();
    });

    if (clearModalPatientSearchBtn) {
      clearModalPatientSearchBtn.addEventListener('click', () => {
        pacienteSearch.value = '';
        currentCitaPacienteId = null;
        clearModalPatientSearchBtn.style.display = 'none';
        patientListDropdown.style.display = 'none';
        pacienteSearch.focus();
        if (typeof window.updateVerPacienteBtn === 'function') window.updateVerPacienteBtn();
      });
    }

    document.addEventListener('click', (e) => {
      if (!pacienteSearch.contains(e.target) && !patientListDropdown.contains(e.target)) {
        patientListDropdown.style.display = 'none';
      }
    });
  }

  // Antes esta función (y los "change" de abajo) bloqueaban por completo
  // fechas/horas anteriores a la actual — pero los doctores frecuentemente
  // olvidan registrar en el momento una consulta o tratamiento y necesitan
  // capturarla después, con la fecha/hora real en que ocurrió (no la de
  // captura). Ya no se fuerza ni la fecha ni la hora a "ahora"; el rango de
  // horario de atención (06:00-23:59) se mantiene igual para todos los días.
  // La advertencia de "esto ya pasó" se muestra una sola vez, al guardar
  // (ver el "submit" de addCitaForm más abajo), en vez de pelear con el
  // campo mientras el usuario todavía está escribiendo.
  function updateTimeConstraints() {
    if (!fechaInput || !horaInput) return;
    horaInput.min = '06:00';
    horaInput.max = '23:59';
    if (!horaInput.value) {
      horaInput.value = '06:00';
    }
  }

  if (fechaInput) {
    fechaInput.addEventListener('change', () => {
      if (fechaError) fechaError.style.display = 'none';

      if (!fechaInput.value) return;

      const selectedDate = new Date(fechaInput.value + 'T00:00:00');
      const dayOfWeek = selectedDate.getDay();

      if (dayOfWeek === 0) {
        if (fechaError) {
          fechaError.textContent = 'Sólo se permiten citas de Lunes a Sábado. Seleccione otro día.';
          fechaError.style.display = 'block';
        }
        fechaInput.value = '';
        return;
      }

      updateTimeConstraints();
    });
  }

  if (horaInput) {
    horaInput.addEventListener('change', () => {
      if (horaError) horaError.style.display = 'none';

      if (horaInput.value < '06:00' || horaInput.value > '23:59') {
        if (horaError) {
          horaError.textContent = 'El horario debe ser entre las 6:00 AM y 11:59 PM.';
          horaError.style.display = 'block';
        }
        if (horaInput.value < '06:00') horaInput.value = '06:00';
      }
    });
  }

  if (fechaFinInput) {
    fechaFinInput.addEventListener('change', () => {
      if (fechaFinError) fechaFinError.style.display = 'none';
      if (horaFinError) horaFinError.style.display = 'none';
      if (fechaFinInput.value && fechaInput.value && fechaFinInput.value < fechaInput.value) {
        fechaFinInput.value = fechaInput.value;
      }
    });
  }

  if (horaFinInput) {
    horaFinInput.addEventListener('change', () => {
      if (horaFinError) horaFinError.style.display = 'none';
    });
  }

  if (tipoInput) {
    tipoInput.addEventListener('change', () => {
      toggleTipoCitaBlocks(tipoInput.value);
    });
  }

  if (addCitaForm) {
    // Candado del guardado de la cita: mientras se guarda (y hasta que el
    // modal termina de cerrarse) cualquier otro envío se ignora. Antes, un
    // segundo clic en Guardar creaba otra cita — y como currentEditingCitaId
    // se limpia en cuanto responde el servidor, al editar/aprobar una cita
    // existente el segundo clic creaba una cita NUEVA duplicada.
    let citaSaving = false;
    const saveCitaBtn = document.getElementById('saveAddCitaBtn');
    addCitaForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Un calendario/hora desplegado no debe quedarse flotando al guardar.
      closeAllCustomDatePickers();
      if (citaSaving) return;
      citaSaving = true;
      setClivoraButtonBusy(saveCitaBtn, true);
      let savedOk = false;
      try {
        savedOk = await handleCitaSubmit(e);
      } finally {
        const release = () => { citaSaving = false; setClivoraButtonBusy(saveCitaBtn, false); };
        if (savedOk) setTimeout(release, 1500); else release();
      }
    });
    const handleCitaSubmit = async (e) => {

      const fechaHoraBlockVisible = !!(fechaHoraBlock && fechaHoraBlock.style.display !== 'none');
      if (fechaHoraBlockVisible) {
        if (!fechaInput.value) {
          if (fechaError) {
            fechaError.textContent = 'Seleccione una fecha válida.';
            fechaError.style.display = 'block';
          }
          return;
        }

        const selectedDate = new Date(fechaInput.value + 'T00:00:00');
        if (selectedDate.getDay() === 0) {
          if (fechaError) {
            fechaError.textContent = 'Sólo se permiten citas de Lunes a Sábado.';
            fechaError.style.display = 'block';
          }
          return;
        }

        // Los doctores suelen olvidar registrar en el momento una consulta o
        // tratamiento y necesitan capturarla después con la fecha/hora real
        // en que ocurrió — ya no se bloquea, solo se advierte y se pide
        // confirmar antes de guardar una cita nueva con fecha/hora pasada.
        if (!currentEditingCitaId && horaInput.value) {
          const startDateTime = new Date(`${fechaInput.value}T${horaInput.value}:00`);
          if (startDateTime < new Date()) {
            const confirmedPastDate = await showClivoraConfirmModal(
              'La fecha y hora seleccionadas ya pasaron. ¿Desea continuar de todos modos y registrar la cita con esa fecha/hora anterior?',
              'Cita fuera de horario',
              { variant: 'warning', confirmLabel: 'Sí, continuar' },
            );
            if (!confirmedPastDate) return;
          }
        }
      }

      const finBlockVisible = !!(finBlock && finBlock.style.display !== 'none');
      if (finBlockVisible && fechaFinInput && horaFinInput) {
        if (fechaFinError) fechaFinError.style.display = 'none';
        if (horaFinError) horaFinError.style.display = 'none';
        if (!fechaFinInput.value || !horaFinInput.value) {
          if (fechaFinError) {
            fechaFinError.textContent = 'Seleccione la fecha y hora de finalización de la cita.';
            fechaFinError.style.display = 'block';
          }
          return;
        }
        const startDt = new Date(`${fechaInput.value}T${horaInput.value}:00`);
        const endDt = new Date(`${fechaFinInput.value}T${horaFinInput.value}:00`);
        if (endDt <= startDt) {
          if (horaFinError) {
            horaFinError.textContent = 'La finalización debe ser posterior al inicio de la cita.';
            horaFinError.style.display = 'block';
          }
          return;
        }
      }

      const pacienteError = document.getElementById('citaPacienteError');
      if (pacienteError) pacienteError.style.display = 'none';

      if (!currentCitaPacienteId && pacienteSearch && pacienteSearch.value.trim()) {
        const typedName = pacienteSearch.value.trim().toUpperCase();
        const allPatients = await ensurePatientsCatalog();
        const exactMatch = allPatients.find(p => (p.name || '').toUpperCase() === typedName);
        if (exactMatch) currentCitaPacienteId = exactMatch.id;
      }

      // Al crear una cita nueva siempre se exige paciente. Al editar una que
      // ya llegó sin paciente vinculado (solicitud pública sin match), se
      // permite guardar sin tocarlo (ej. solo aprobar/rechazar) — pero si el
      // personal sí escribió algo en el buscador, debe resolver a un
      // paciente real antes de guardar.
      const pacienteRequerido = !currentEditingCitaId || (pacienteSearch && pacienteSearch.value.trim());
      if (!currentCitaPacienteId && pacienteRequerido) {
        if (pacienteError) {
          pacienteError.textContent = 'Seleccione un paciente de la lista de resultados (haga clic en una sugerencia).';
          pacienteError.style.display = 'block';
        }
        return;
      }

      const payload = buildCitaPayload();

      const wasNewCita = !currentEditingCitaId;
      let saved = null;
      try {
        const url = currentEditingCitaId ? `/clivora/api/citas/${currentEditingCitaId}` : '/clivora/api/citas';
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
          if (data && data.error === 'cita_rechazada') {
            showClivoraAlertModal('Esta cita fue rechazada y ya no se puede modificar.', 'Cita rechazada');
          } else if (data && data.error === 'sala_ocupada') {
            showClivoraAlertModal(data.message || 'La sala seleccionada ya está ocupada en ese horario.', 'Sala no disponible');
          } else if (data && data.error === 'doctor_sin_usuario') {
            showClivoraAlertModal(data.message || 'El doctor seleccionado no tiene una cuenta de usuario vinculada en el sistema.', 'Doctor sin cuenta de usuario');
          } else if (data && data.error === 'invalid_transition') {
            showClivoraAlertModal(data.message || 'No se pudo guardar la cita.', 'Transición no permitida');
          } else {
            showClivoraAlertModal('No se pudo guardar la cita.');
          }
          return;
        }
        saved = data;
        // Archivos adjuntados antes de que la cita existiera.
        if (wasNewCita && saved && saved.id) await uploadPendingCitaAdjuntos(saved.id);
      } catch (error) {
        console.error('Error al guardar la cita:', error);
        showClivoraAlertModal('No se pudo guardar la cita.');
        return;
      }

      currentEditingCitaId = null;
      currentCitaPacienteId = null;

      if (window.refreshDynamicCalendar) {
        await window.refreshDynamicCalendar();
      }
      // Igual que en doCitaCheck: guardar un cambio de estado desde este
      // modal (ej. Rechazar, o el resync tras check-in/check-out) no tocaba
      // el array cacheado de Tratamientos — el Kanban/lista se veía
      // desactualizado hasta refrescar el navegador.
      if (typeof loadTratamientos === 'function') await loadTratamientos();
      if (typeof updateDashboardMetrics === 'function') updateDashboardMetrics();

      if (successOverlay) {
        successOverlay.style.display = 'flex';
      }

      // Solo se ofrece crear la venta al crear (no editar) una cita de
      // Tratamiento — Consulta no tiene concepto de venta en la UI.
      const createSaleBtn = document.getElementById('addCitaCreateSaleBtn');
      const closeSaleBtn = document.getElementById('addCitaCloseSaleBtn');
      const offerCreateSale = wasNewCita && saved && saved.tipo === 'Tratamiento';
      if (createSaleBtn) {
        createSaleBtn.style.display = offerCreateSale ? 'inline-block' : 'none';
        createSaleBtn.onclick = async () => {
          await loadTratamientos();
          addCitaModal.classList.remove('open');
          if (successOverlay) successOverlay.style.display = 'none';
          openTratamientoOrderModal(saved.id);
        };
      }
      // "Crear venta" no siempre se hace en el momento — antes este era el
      // único botón cuando offerCreateSale era true, así que no había forma
      // de cerrar el modal sin crear la venta.
      if (closeSaleBtn) {
        closeSaleBtn.style.display = offerCreateSale ? 'inline-block' : 'none';
        closeSaleBtn.onclick = async () => {
          await loadTratamientos();
          addCitaModal.classList.remove('open');
          if (successOverlay) successOverlay.style.display = 'none';
        };
      }

      if (!offerCreateSale) {
        setTimeout(() => {
          if (successOverlay) successOverlay.style.display = 'none';
          addCitaModal.classList.remove('open');
        }, 1300);
      }
      return true;
    };
  }
}

// Mismo diseño de tarjeta que ya usa la vista mensual (event-pill-appointment)
// — factorizado para poder reusarlo también dentro del modal "Ver más" del
// día (openDayAppointmentsModal) sin duplicar el markup.
// Constructor único de la "pastilla" de cita usada en las vistas Mes,
// Semana y Día del calendario — antes cada vista armaba su propio markup
// por separado (con inconsistencias entre ellas, ej. una decía "Doctor:" y
// las otras "Dr(a):", y ninguna mostraba doctor+sala a la vez) y con un
// diseño de pastilla de color sólido distinto al de las tarjetas de
// "Agenda de hoy"/"Citas de este mes" (ver citaCardSubtitle y las clases
// .event-pill-* en styles.css).
const CITA_ESTADO_LABELS = { aprobado: 'Aprobado', rechazado: 'Rechazado', pendiente: 'Pendiente', desfasado: 'Desfasado', nuevo: 'Nuevo', en_progreso: 'En progreso', finalizado: 'Finalizado' };

// Rango visible de la cuadrícula de Semana/Día (18 filas: "6 AM" a "11 PM",
// ver templates/index.html) — 6:00 a 24:00, mismo rango permitido al
// agendar una cita (ver updateTimeConstraints, 6:00 AM - 11:59 PM). Toda la
// posición/tamaño de una cita se calcula como % de este rango, así que no
// depende de ningún valor de altura en px hardcodeado (funciona igual si
// cambia el tamaño de fila en el CSS).
const CALENDAR_GRID_START_MIN = 6 * 60;
const CALENDAR_GRID_END_MIN = 24 * 60;

function parseHmToMinutes(value, fallback) {
  if (!value) return fallback;
  const [h, m] = value.split(':').map(Number);
  if (Number.isNaN(h)) return fallback;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

// Arma la posición (top/alto en px) y columna de cada cita de un solo día,
// igual que el algoritmo real de Outlook: el alto representa su duración
// real (hora de inicio a hora de fin) en vez de una pastilla de tamaño fijo
// metida en la celda de su hora de inicio, y las que se traslapan en
// horario se reparten en columnas de ancho parejo lado a lado — el ancho de
// cada columna se ajusta solo según cuántas citas coinciden en ese momento
// (con 4 citas donde 2 no se traslapan entre sí y comparten columna, salen
// 3 columnas, no 4), en vez de un número fijo de columnas o un tope que
// esconda las citas de más.
//
// maxCols: tope de columnas lado a lado antes de agrupar. Un racimo que
// necesitaría más columnas que esto ya no se reparte en columnas (quedaban
// tan angostas que no se leía nada): se parte por hora de inicio y cada hora
// con más de maxCols citas se pinta como una sola tarjeta de resumen
// ("15 citas · 8:00 AM", ver buildEventGroupCardEl) que abre el panel de
// detalle (openCitasGroupDrawer). Las horas con maxCols citas o menos siguen
// mostrando sus tarjetas normales. Esos elementos del layout llevan `group`
// en vez de `cita`.
function buildTimedEventLayout(dayCitas, containerHeightPx, maxCols = Infinity) {
  const gridStart = CALENDAR_GRID_START_MIN;
  const gridEnd = CALENDAR_GRID_END_MIN;
  const gridSpan = gridEnd - gridStart;
  const MIN_DURATION_MIN = 20; // alto mínimo legible para una cita muy corta

  const items = dayCitas.map(cita => {
    let start = parseHmToMinutes(cita.hora, CALENDAR_GRID_START_MIN);
    // Una cita que termina otro día (o sin horaFin real) se recorta al
    // límite visible del día en vez de tratarse como si durara 0 minutos.
    let end = (cita.fechaFin && cita.fechaFin !== cita.fecha)
      ? gridEnd
      : parseHmToMinutes(cita.horaFin, null);
    if (end === null || end <= start) end = start + 60;
    if (end - start < MIN_DURATION_MIN) end = start + MIN_DURATION_MIN;
    start = Math.min(Math.max(start, gridStart), gridEnd);
    end = Math.min(Math.max(end, gridStart), gridEnd);
    if (end <= start) end = Math.min(gridEnd, start + MIN_DURATION_MIN);
    return { cita, start, end };
  }).sort((a, b) => (a.start - b.start) || (a.end - b.end));

  // Agrupa en "racimos" de citas mutuamente traslapadas (transitivamente) —
  // cada racimo reparte sus propias columnas, independiente de los demás
  // racimos del día (ej. una cita de 9-10 y otra de 15-16 no deben achicarse
  // entre sí solo porque otras dos sí se traslapan a las 9).
  const clusters = [];
  let current = [];
  let currentEnd = -Infinity;
  items.forEach(item => {
    if (current.length && item.start >= currentEnd) {
      clusters.push(current);
      current = [];
      currentEnd = -Infinity;
    }
    current.push(item);
    currentEnd = Math.max(currentEnd, item.end);
  });
  if (current.length) clusters.push(current);

  const laidOut = [];
  clusters.forEach(cluster => {
    // Empaquetado "primer hueco libre": cada cita entra en la primera
    // columna cuya última cita ya haya terminado antes de que esta empiece
    // — así dos citas que NO se traslapan entre sí (aunque ambas caigan
    // dentro del mismo racimo por transitividad con una tercera) comparten
    // columna en vez de gastar una cada una, igual que en la captura de
    // Outlook (Prueba 1 y Prueba 3 en la misma columna, una debajo de la
    // otra, porque no chocan en horario).
    const columnsEnd = []; // fin (minutos) de la última cita puesta en cada columna
    cluster.forEach(item => {
      let colIdx = columnsEnd.findIndex(end => end <= item.start);
      if (colIdx === -1) {
        colIdx = columnsEnd.length;
        columnsEnd.push(item.end);
      } else {
        columnsEnd[colIdx] = item.end;
      }
      item.col = colIdx;
    });
    const totalCols = columnsEnd.length;
    if (totalCols > maxCols) {
      laidOut.push(...buildStackedClusterLayout(cluster, maxCols, containerHeightPx));
      return;
    }
    cluster.forEach(item => {
      laidOut.push({
        cita: item.cita,
        // En píxeles reales (medidos del contenedor, ver renderWeekMode/
        // renderDayMode) en vez de % — un % de alto en un hijo
        // position:absolute solo funciona si el contenedor (.day-events-col)
        // tiene una altura resuelta de verdad, y con CSS Grid + contenido
        // fuera de flujo (position:absolute) esa altura no siempre se
        // calculaba de forma confiable entre navegadores.
        topPx: ((item.start - gridStart) / gridSpan) * containerHeightPx,
        heightPx: ((item.end - item.start) / gridSpan) * containerHeightPx,
        col: item.col,
        totalCols,
      });
    });
  });
  return laidOut;
}

// Layout de un racimo saturado (ver maxCols en buildTimedEventLayout): una
// "cubeta" por hora de inicio. Cada cubeta va de su primera cita hasta su
// último fin, recortada al inicio de la siguiente cubeta — así las cubetas
// nunca se enciman entre sí y cada una usa el ancho completo del día.
function buildStackedClusterLayout(cluster, maxCols, containerHeightPx) {
  const gridStart = CALENDAR_GRID_START_MIN;
  const gridSpan = CALENDAR_GRID_END_MIN - gridStart;
  const MIN_BUCKET_MIN = 30; // alto mínimo para que la tarjeta se lea
  const toPx = (min) => (min / gridSpan) * containerHeightPx;

  const byHour = new Map();
  cluster.forEach(item => {
    const hour = Math.floor(item.start / 60);
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(item);
  });
  const buckets = [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, items]) => ({ hour, items, start: Math.min(...items.map(i => i.start)) }));

  const result = [];
  buckets.forEach((bucket, idx) => {
    const next = buckets[idx + 1];
    const capEnd = next ? next.start : CALENDAR_GRID_END_MIN;
    const realEnd = Math.max(...bucket.items.map(i => i.end));
    const end = Math.min(realEnd, capEnd);
    const height = Math.max(end - bucket.start, Math.min(MIN_BUCKET_MIN, capEnd - bucket.start));
    const topPx = toPx(bucket.start - gridStart);
    const heightPx = toPx(height);
    if (bucket.items.length > maxCols) {
      const citas = bucket.items.map(i => i.cita);
      result.push({ group: { citas, hour: bucket.hour, start: bucket.start, end: realEnd }, topPx, heightPx, col: 0, totalCols: 1 });
    } else {
      // Pocas citas en esta hora: tarjetas normales lado a lado, cada una en
      // su hora real, recortadas también al inicio de la siguiente cubeta.
      bucket.items.forEach((item, i) => {
        const itemEnd = Math.min(item.end, capEnd);
        result.push({
          cita: item.cita,
          topPx: toPx(item.start - gridStart),
          heightPx: toPx(Math.max(itemEnd - item.start, Math.min(MIN_BUCKET_MIN, capEnd - item.start))),
          col: i,
          totalCols: bucket.items.length,
        });
      });
    }
  });
  return result;
}

// Aplica el resultado de buildTimedEventLayout como posición absoluta real
// sobre la pastilla — separado de buildTimedEventLayout (que no toca el
// DOM) para poder calcular el layout de todo un día antes de crear ningún
// elemento. El ancho de cada cita sale de 100%/totalCols (columnas parejas,
// como Outlook) — con 1 sola columna (sin traslape) ocupa el 100%.
function applyTimedPillLayout(pill, layout) {
  pill.classList.add('event-pill-timed');
  const widthPct = 100 / layout.totalCols;
  const leftPct = layout.col * widthPct;
  pill.style.top = `${layout.topPx}px`;
  // Piso de 34px: una cita muy corta (o muy angosta, con varias columnas)
  // sigue necesitando espacio mínimo para sus 2-3 líneas de texto
  // (paciente, estado, doctor, hora).
  pill.style.height = `${Math.max(layout.heightPx - 3, 34)}px`;
  pill.style.left = `calc(${leftPct}% + 2px)`;
  pill.style.width = `calc(${widthPct}% - 4px)`;
  pill.style.zIndex = '1';
}

// Línea de "hora actual" (mismo detalle que Outlook/Google Calendar en sus
// vistas Día/Semana): una franja horizontal a través de la columna del día
// de hoy que marca dónde cae la hora real en este momento, para ubicar de
// un vistazo las citas ya pasadas de las que faltan. Se posiciona igual que
// cualquier cita (topPx en función de CALENDAR_GRID_START_MIN/END_MIN), pero
// sin alto/columna — es una línea de ancho completo, no una tarjeta.
function renderCurrentTimeLine(dayCol, containerHeightPx) {
  if (!dayCol) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const gridStart = CALENDAR_GRID_START_MIN;
  const gridEnd = CALENDAR_GRID_END_MIN;
  let line = dayCol.querySelector('.current-time-line');
  if (nowMin < gridStart || nowMin > gridEnd) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement('div');
    line.className = 'current-time-line';
    line.innerHTML = '<span class="current-time-dot"></span>';
    dayCol.appendChild(line);
  }
  line.style.top = `${((nowMin - gridStart) / (gridEnd - gridStart)) * containerHeightPx}px`;
}

function buildEventPillEl(cita, onBeforeOpen) {
  const pill = document.createElement('div');
  const stClass = (cita.estado || 'nuevo').toLowerCase();
  pill.className = `event-pill-appointment ${stClass}`;
  const label = CITA_ESTADO_LABELS[stClass] || 'Nuevo';
  const doctorLine = cita.doctor ? `Dr(a): ${cita.doctor}` : '';
  const salaLine = cita.sala ? `${cita.ubicacion} (${cita.sala})` : '';
  pill.innerHTML = `
    <div class="event-pill-row1">
      <span class="event-pill-name">${citaDisplayName(cita)}</span>
      <span class="badge badge-${stClass} event-pill-badge">${label}</span>
    </div>
    <div class="event-pill-row2">
      <span class="event-pill-doctor">${doctorLine}</span>
      ${cita.stockAplicacion ? '<span class="event-pill-stock" title="Stock listo"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="event-pill-stock-text">Stock</span></span>' : ''}
      <span class="event-pill-time">${cita.hora || ''}</span>
    </div>
    ${salaLine ? `<div class="event-pill-sala">${salaLine}</div>` : ''}
  `;
  // Viñeta flotante propia en vez del "title" nativo (ver
  // buildEventHoverTooltipHtml) — con varias citas en la misma hora las
  // columnas se angostan tanto (applyTimedPillLayout) que el texto de la
  // pastilla ya no es legible; la viñeta muestra el detalle completo sin
  // depender del ancho de la columna.
  pill.addEventListener('mouseenter', (e) => showEventHoverTooltip(cita, e));
  pill.addEventListener('mousemove', (e) => positionEventHoverTooltip(getEventHoverTooltipEl(), e));
  pill.addEventListener('mouseleave', hideEventHoverTooltip);
  pill.onclick = (e) => {
    e.stopPropagation();
    hideEventHoverTooltip();
    // Si esta tarjeta vive dentro de otro modal (ej. "Citas del día"), hay
    // que cerrarlo primero — si no, el modal "Editar Cita" que abre
    // openCitaModal termina apareciendo DEBAJO del modal que ya estaba
    // abierto (ambos quedan abiertos a la vez, y el de "Citas del día"
    // tiene mayor z-index).
    if (typeof onBeforeOpen === 'function') onBeforeOpen();
    window.openCitaModal(cita);
  };
  return pill;
}

// Tope de columnas lado a lado antes de agrupar en tarjeta de resumen (ver
// buildTimedEventLayout): 2 = hasta 2 citas empalmadas se ven lado a lado;
// a partir de 3 en la misma hora se agrupan, en Semana y en Día.
const CALENDAR_STACK_MAX_COLS = { semana: 2, dia: 2 };

function formatMinutesAmPm(totalMin) {
  const h24 = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Tarjeta de resumen de una hora saturada ("15 citas · 8:00 AM") — reemplaza
// a todas esas pastillas en Semana/Día; al hacer clic abre el panel de
// detalle con la lista completa.
function buildEventGroupCardEl(group, dateStr) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'event-group-card';
  const counts = {};
  group.citas.forEach(c => {
    const st = (c.estado || 'nuevo').toLowerCase();
    counts[st] = (counts[st] || 0) + 1;
  });
  const dots = Object.entries(counts)
    .map(([st, n]) => `<span class="event-group-dot ${st}" title="${CITA_ESTADO_LABELS[st] || st}: ${n}">${n}</span>`)
    .join('');
  const n = group.citas.length;
  card.innerHTML = `
    <span class="event-group-title">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span class="event-group-count">${n} citas</span>
      <span class="event-group-time">${formatMinutesAmPm(group.start)}</span>
    </span>
    <span class="event-group-dots">${dots}</span>
  `;
  card.title = `${n} citas desde las ${formatMinutesAmPm(group.start)} — ver detalle`;
  card.onclick = (e) => {
    e.stopPropagation();
    hideEventHoverTooltip();
    openCitasGroupDrawer(group, dateStr, card);
  };
  return card;
}

// Panel de detalle de una tarjeta de resumen: en escritorio/tablet es un
// menú flotante junto a la tarjeta en la que se hizo clic (.is-popover, ver
// positionCitasGroupPopover); en celular, bottom sheet (solo CSS, ver
// .citas-group-drawer en styles.css). Es position:fixed sobre el
// calendario, así que no mueve ni deforma la cuadrícula de abajo.
let citasGroupAnchorEl = null;
const CITAS_GROUP_POPOVER_MIN_WIDTH = 769;

function positionCitasGroupPopover() {
  const drawer = document.getElementById('citasGroupDrawer');
  if (!drawer || !drawer.classList.contains('is-popover') || !citasGroupAnchorEl) return;
  const rect = citasGroupAnchorEl.getBoundingClientRect();
  const gap = 8;
  const margin = 12;
  const width = drawer.offsetWidth;
  const height = drawer.offsetHeight;
  // A la derecha de la tarjeta; si no cabe, a la izquierda.
  let left = rect.right + gap;
  if (left + width > window.innerWidth - margin) left = rect.left - gap - width;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  // Alineado con la parte de arriba de la tarjeta, sin salirse de la pantalla.
  let top = rect.top;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  drawer.style.left = `${Math.round(left)}px`;
  drawer.style.top = `${Math.round(top)}px`;
}
window.addEventListener('resize', positionCitasGroupPopover);
window.addEventListener('scroll', positionCitasGroupPopover, true);

function openCitasGroupDrawer(group, dateStr, anchorEl = null) {
  const drawer = document.getElementById('citasGroupDrawer');
  const backdrop = document.getElementById('citasGroupDrawerBackdrop');
  const list = document.getElementById('citasGroupDrawerList');
  const title = document.getElementById('citasGroupDrawerTitle');
  const subtitle = document.getElementById('citasGroupDrawerSubtitle');
  if (!drawer || !list) return;

  const citas = group.citas.slice().sort((a, b) =>
    (a.hora || '').localeCompare(b.hora || '')
    || (a.horaFin || '').localeCompare(b.horaFin || '')
    || citaDisplayName(a).localeCompare(citaDisplayName(b)));
  if (title) title.textContent = `${citas.length} citas · ${formatMinutesAmPm(group.hour * 60)}`;
  if (subtitle) {
    const [y, m, d] = (dateStr || '').split('-');
    const fecha = d ? `${d}/${m}/${y}` : '';
    subtitle.textContent = `${fecha} · ${formatMinutesAmPm(group.start)} – ${formatMinutesAmPm(Math.min(group.end, 24 * 60 - 1))}`;
  }
  list.innerHTML = '';
  citas.forEach(cita => list.appendChild(buildEventPillEl(cita, closeCitasGroupDrawer)));
  list.scrollTop = 0;

  const asPopover = !!anchorEl && window.innerWidth >= CITAS_GROUP_POPOVER_MIN_WIDTH;
  citasGroupAnchorEl = asPopover ? anchorEl : null;
  drawer.classList.toggle('is-popover', asPopover);
  if (backdrop) backdrop.classList.toggle('is-popover', asPopover);
  if (!asPopover) {
    drawer.style.left = '';
    drawer.style.top = '';
  }
  positionCitasGroupPopover();

  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  if (backdrop) backdrop.classList.add('open');
  document.body.classList.add('citas-drawer-open');
  document.getElementById('closeCitasGroupDrawer')?.focus({ preventScroll: true });
}

function closeCitasGroupDrawer() {
  const drawer = document.getElementById('citasGroupDrawer');
  if (!drawer || !drawer.classList.contains('open')) return;
  hideEventHoverTooltip();
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.getElementById('citasGroupDrawerBackdrop')?.classList.remove('open');
  document.body.classList.remove('citas-drawer-open');
  citasGroupAnchorEl = null;
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#closeCitasGroupDrawer') || event.target.id === 'citasGroupDrawerBackdrop') {
    closeCitasGroupDrawer();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCitasGroupDrawer();
});

// Modal "Ver más" del día — se abre desde el botón "+N más" que reemplaza la
// 5ª tarjeta cuando un día tiene más de 5 citas (ver renderMonthMode). Antes
// esas citas de más ni se veían: .month-day-cell tiene overflow:hidden, así
// que simplemente se recortaban sin ninguna forma de acceder a ellas.
function openDayAppointmentsModal(dateStr, dayCitas) {
  const modal = document.getElementById('dayAppointmentsModal');
  const list = document.getElementById('dayAppointmentsList');
  const title = document.getElementById('dayAppointmentsModalDate');
  if (!modal || !list) return;

  if (title) {
    const [y, m, d] = dateStr.split('-');
    title.textContent = `${d}/${m}/${y}`;
  }
  list.innerHTML = '';
  const closeThisModal = () => {
    modal.classList.remove('open');
    modal.style.display = 'none';
  };
  dayCitas
    .slice()
    .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''))
    .forEach(cita => list.appendChild(buildEventPillEl(cita, closeThisModal)));

  modal.classList.add('open');
  modal.style.display = 'flex';
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#closeDayAppointmentsModal')) {
    const modal = document.getElementById('dayAppointmentsModal');
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
  }
});

// ============================================================
// CALENDARIO DINÁMICO, NAVEGACIÓN Y FILTROS REACTIVOS
// ============================================================
function initializeDynamicCalendarModule() {
  const agendaCard = document.querySelector('.agenda-card');
  if (!agendaCard) return;

  const calendarState = {
    currentDate: new Date(),
    currentMode: 'semana',
    activeStatuses: new Set(['nuevo', 'aprobado', 'rechazado', 'pendiente', 'desfasado', 'en_progreso', 'finalizado']),
    searchTerm: '',
    selectedTipo: 'todos',
    selectedSala: 'todas',
    selectedUbicacion: 'todas'
  };

  const prevBtn = document.getElementById('prevDateRange');
  const nextBtn = document.getElementById('nextDateRange');
  const dateRangeText = document.getElementById('dateRangeText');
  const headerMonth = document.getElementById('calendarHeaderMonth');
  const countLabel = document.getElementById('citasCountLabel');
  const dateBadgeNum = document.getElementById('currentCalDateNum');
  const monthBadgeSub = document.getElementById('currentCalMonthSub');
  const modeBadgeSub = document.getElementById('currentCalModeSub');

  const modeButtons = document.querySelectorAll('.mode-pill-btn');
  const statusTags = document.querySelectorAll('#statusPillsFilter .status-filter-tag');

  const tipoCitaFilterSelect = document.getElementById('agendaTipoCitaFilter');

  // Filtro "Sala" — deja ver de un vistazo qué horas están libres en una
  // sala en concreto (las citas de otras salas se ocultan del calendario).
  const salaFilterSelect = document.getElementById('agendaSalaFilter');
  if (salaFilterSelect) {
    salaFilterSelect.addEventListener('change', () => {
      calendarState.selectedSala = salaFilterSelect.value;
      updateCalendarView();
    });
  }

  // Filtros "Ubicación" y "Sala" — sus opciones dependen del tipo de cita
  // filtrado: Tratamiento usa las salas numeradas (Penthouse 2 / Penthouse 3 /
  // Piso 15, ver CLIVORA_SALAS_POR_UBICACION), Consulta los consultorios con letra
  // (Penthouse 2: A–E, Penthouse 3: A–D, ver CLIVORA_SALAS_CONSULTA) y "Todos los
  // tipos" ambos. Se conserva lo elegido mientras siga existiendo; si no, vuelve
  // a "Todas".
  const ubicacionFilterSelect = document.getElementById('agendaUbicacionFilter');
  function refreshAgendaUbicacionSalaFilters() {
    const tipo = tipoCitaFilterSelect ? tipoCitaFilterSelect.value : 'todos';
    const conConsulta = tipo !== 'Tratamiento';
    const conTratamiento = tipo !== 'Consulta';
    const setOptions = (selectEl, options, allLabel) => {
      if (!selectEl) return 'todas';
      const current = selectEl.value;
      selectEl.innerHTML = [`<option value="todas">${allLabel}</option>`]
        .concat(options.map(o => `<option value="${o.value}">${o.label}</option>`)).join('');
      selectEl.value = options.some(o => o.value === current) ? current : 'todas';
      return selectEl.value;
    };
    const tiposSala = [conTratamiento && 'tratamiento', conConsulta && 'consulta'].filter(Boolean);
    const lugares = CLIVORA_LUGARES.filter(l => l.salas.some(sa => tiposSala.includes(sa.tipo)));
    calendarState.selectedUbicacion = setOptions(ubicacionFilterSelect,
      lugares.map(l => ({ value: l.name, label: l.name })), 'Todas las ubicaciones');
    const ubicacion = calendarState.selectedUbicacion;
    const nombres = new Set();
    lugares.filter(l => ubicacion === 'todas' || l.name === ubicacion)
      .forEach(l => l.salas.filter(sa => tiposSala.includes(sa.tipo)).forEach(sa => nombres.add(sa.name)));
    const salas = [...nombres].map(n => ({ value: n, label: n }));
    calendarState.selectedSala = setOptions(salaFilterSelect, salas, 'Todas las salas');
  }
  // Se rearman al llegar el catálogo de lugares (Configuración).
  document.addEventListener('clivora:lugares', () => refreshAgendaUbicacionSalaFilters());
  ensureCitasCatalogs();
  if (ubicacionFilterSelect) {
    ubicacionFilterSelect.addEventListener('change', () => {
      calendarState.selectedUbicacion = ubicacionFilterSelect.value;
      refreshAgendaUbicacionSalaFilters();
      updateCalendarView();
    });
  }

  if (tipoCitaFilterSelect) {
    tipoCitaFilterSelect.addEventListener('change', () => {
      calendarState.selectedTipo = tipoCitaFilterSelect.value;
      refreshAgendaUbicacionSalaFilters();
      updateCalendarView();
    });
  }
  refreshAgendaUbicacionSalaFilters();

  const agendaSearchInput = document.getElementById('agendaSearchInput');
  const clearAgendaSearchBtn = document.getElementById('clearAgendaSearchBtn');

  const modeSemana = document.getElementById('mode-semana');
  const modeDia = document.getElementById('mode-dia');
  const modeMes = document.getElementById('mode-mes');
  const modeAgenda = document.getElementById('mode-agenda');

  const monthNamesEs = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthShortEs = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const dayNamesEs = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  statusTags.forEach(tag => {
    tag.addEventListener('click', () => {
      const status = tag.dataset.status;
      if (!status) return;

      if (calendarState.activeStatuses.has(status)) {
        if (calendarState.activeStatuses.size > 1) {
          calendarState.activeStatuses.delete(status);
          tag.classList.remove('active');
          tag.classList.add('inactive');
        }
      } else {
        calendarState.activeStatuses.add(status);
        tag.classList.add('active');
        tag.classList.remove('inactive');
      }
      updateCalendarView();
    });
  });

  // Un único buscador de texto libre (paciente, doctor, sala o tipo de
  // cita/consulta) — mismo patrón que tratamientosSearchInput en
  // Tratamientos (un solo input, sin autocomplete, filtrando por
  // coincidencia de subcadena sobre varios campos a la vez). Antes eran 2
  // cajas separadas (paciente y doctor) con su propio dropdown de
  // sugerencias, que no dejaban buscar por sala/consulta.
  if (agendaSearchInput) {
    agendaSearchInput.addEventListener('input', () => {
      calendarState.searchTerm = agendaSearchInput.value;
      if (clearAgendaSearchBtn) {
        clearAgendaSearchBtn.style.display = agendaSearchInput.value ? 'flex' : 'none';
      }
      updateCalendarView();
    });

    if (clearAgendaSearchBtn) {
      clearAgendaSearchBtn.addEventListener('click', () => {
        agendaSearchInput.value = '';
        calendarState.searchTerm = '';
        clearAgendaSearchBtn.style.display = 'none';
        updateCalendarView();
        agendaSearchInput.focus();
      });
    }
  }

  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode) return;
      calendarState.currentMode = mode;

      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (modeSemana) modeSemana.style.display = mode === 'semana' ? 'block' : 'none';
      if (modeDia) modeDia.style.display = mode === 'dia' ? 'block' : 'none';
      if (modeMes) modeMes.style.display = mode === 'mes' ? 'block' : 'none';
      if (modeAgenda) modeAgenda.style.display = mode === 'agenda' ? 'block' : 'none';

      updateCalendarView();
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      navigateDate(-1);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      navigateDate(1);
    });
  }

  function navigateDate(direction) {
    const d = new Date(calendarState.currentDate);
    if (calendarState.currentMode === 'dia') {
      d.setDate(d.getDate() + direction);
    } else if (calendarState.currentMode === 'semana') {
      d.setDate(d.getDate() + (direction * 7));
    } else if (calendarState.currentMode === 'mes' || calendarState.currentMode === 'agenda') {
      d.setMonth(d.getMonth() + direction);
    }
    calendarState.currentDate = d;
    updateCalendarView();
  }

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(date.setDate(diff));
  }

  function formatDateIso(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function updateCalendarView() {
    const cur = calendarState.currentDate;
    const mode = calendarState.currentMode;

    if (dateBadgeNum) dateBadgeNum.textContent = cur.getDate();
    if (monthBadgeSub) monthBadgeSub.textContent = monthShortEs[cur.getMonth()];
    if (modeBadgeSub) modeBadgeSub.textContent = mode.toUpperCase();
    if (headerMonth) headerMonth.textContent = `${monthNamesEs[cur.getMonth()]} ${cur.getFullYear()}`;

    if (dateRangeText) {
      if (mode === 'dia') {
        const dayStr = dayNamesEs[cur.getDay()];
        dateRangeText.textContent = `${dayStr}. ${cur.getDate()} ${monthShortEs[cur.getMonth()]}. ${cur.getFullYear()}`;
      } else if (mode === 'semana') {
        const mon = getMonday(cur);
        const sun = new Date(mon);
        sun.setDate(sun.getDate() + 6);
        dateRangeText.textContent = `${mon.getDate()} ${monthShortEs[mon.getMonth()]}. ${mon.getFullYear()} – ${sun.getDate()} ${monthShortEs[sun.getMonth()]}. ${sun.getFullYear()}`;
      } else if (mode === 'mes' || mode === 'agenda') {
        dateRangeText.textContent = `${monthNamesEs[cur.getMonth()]} ${cur.getFullYear()}`;
      }
    }

    const allCitas = clivoraCitasCache;

    const searchUpper = calendarState.searchTerm.trim().toUpperCase();
    const currentYear = cur.getFullYear();
    const currentMonth = cur.getMonth();

    const filteredCitas = allCitas.filter(c => {
      const status = (c.estado || 'nuevo').toLowerCase();
      if (!calendarState.activeStatuses.has(status)) return false;
      if (searchUpper) {
        // Mismo criterio que renderTratamientosTable: un solo término contra
        // varios campos a la vez (paciente, doctor, sala, ubicación, tipo de
        // cita/consulta), no un AND de 2 cajas separadas.
        const haystack = [
          citaDisplayName(c), c.doctor, c.sala ? `Sala ${c.sala}` : '', c.ubicacion, c.tipo,
        ].filter(Boolean).join(' ').toUpperCase();
        if (!haystack.includes(searchUpper)) return false;
      }

      if (calendarState.selectedTipo && calendarState.selectedTipo !== 'todos') {
        const citaTipo = (c.tipo || 'Consulta').toLowerCase();
        const selectedTipo = calendarState.selectedTipo.toLowerCase();
        if (citaTipo !== selectedTipo) return false;
      }

      if (calendarState.selectedSala && calendarState.selectedSala !== 'todas') {
        if ((c.sala || '') !== calendarState.selectedSala) return false;
      }

      if (calendarState.selectedUbicacion && calendarState.selectedUbicacion !== 'todas') {
        if ((c.ubicacion || '') !== calendarState.selectedUbicacion) return false;
      }

      if (mode === 'agenda') {
        if (c.fecha) {
          const parts = c.fecha.split('-');
          if (parts.length === 3) {
            const citaYear = parseInt(parts[0], 10);
            const citaMonth = parseInt(parts[1], 10) - 1;
            if (citaYear !== currentYear || citaMonth !== currentMonth) return false;
          }
        }
      }
      return true;
    });

    // Cualquier repintado del calendario (cambio de mes/semana/día, filtro,
    // refresh) puede destruir la pastilla sobre la que estaba el mouse sin
    // disparar su "mouseleave" — sin esto la viñeta se quedaba flotando en
    // pantalla, apuntando a una cita que ya no existe en el DOM.
    hideEventHoverTooltip();

    if (mode === 'semana') renderWeekMode(filteredCitas);
    else if (mode === 'dia') renderDayMode(filteredCitas);
    else if (mode === 'mes') renderMonthMode(filteredCitas);
    else if (mode === 'agenda') renderAgendaMode(filteredCitas);

    if (countLabel) {
      countLabel.textContent = `${filteredCitas.length} citas`;
    }
  }

  function renderWeekMode(citas) {
    if (!modeSemana) return;

    const monday = getMonday(calendarState.currentDate);
    const headerCols = modeSemana.querySelectorAll('.week-grid-header .week-day-col-header');
    const todayIso = formatDateIso(new Date());

    const daysOfWeek = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      daysOfWeek.push(d);
      if (headerCols[i + 1]) {
        const dayLabel = dayNamesEs[d.getDay()];
        headerCols[i + 1].innerHTML = `${dayLabel}. <strong>${d.getDate()}</strong>`;
        // Mismo criterio visual que Outlook: la columna del día de hoy se
        // distingue del resto en el encabezado (antes las 7 columnas se
        // veían idénticas, sin ninguna pista de en qué día real está parado
        // el usuario dentro de la semana visible).
        headerCols[i + 1].classList.toggle('is-today', formatDateIso(d) === todayIso);
      }
    }

    const rows = modeSemana.querySelectorAll('.timeline-rows-container .timeline-row');
    rows.forEach((row, rowIdx) => {
      const slots = row.querySelectorAll('.time-cell-slot');
      // La primera fila es la hora de inicio de la cuadrícula (6 AM, ver
      // CALENDAR_GRID_START_MIN) — antes estaba fijo en 7 y al dar clic en un
      // espacio la cita se abría con una hora de más.
      const hourNum = CALENDAR_GRID_START_MIN / 60 + rowIdx;
      const hourStr = String(hourNum).padStart(2, '0') + ':00';

      slots.forEach((slot, dayIdx) => {
        slot.onclick = (e) => {
          if (e.target === slot) {
            const dateStr = formatDateIso(daysOfWeek[dayIdx]);
            window.openCitaModal({ fecha: dateStr, hora: hourStr });
          }
        };
      });
    });

    // Citas de la semana: ya no se insertan dentro de la celda de su hora de
    // inicio (buildEventPillEl amontonado en un cuadrito de 1 hora) — se
    // posicionan en el overlay superpuesto según su duración real, con las
    // que se traslapan en el mismo día repartidas en columnas lado a lado
    // (ver buildTimedEventLayout).
    const overlay = document.getElementById('weekEventsOverlay');
    const dayCols = overlay ? overlay.querySelectorAll('.day-events-col') : [];
    dayCols.forEach(col => { col.innerHTML = ''; });

    // Alto real del contenedor (16 filas × su alto ya renderizado) — se mide
    // directo del DOM en vez de asumir un valor en px fijo, para no
    // depender de que la fila mida exactamente lo que dice el CSS en este
    // momento (ver buildTimedEventLayout).
    const rowsContainer = modeSemana.querySelector('.timeline-rows-container');
    const containerHeightPx = (rowsContainer && rowsContainer.getBoundingClientRect().height) || (rows.length * 68);

    daysOfWeek.forEach((day, dayIdx) => {
      const dateStr = formatDateIso(day);
      const dayCitas = citas.filter(c => c.fecha === dateStr);
      const col = dayCols[dayIdx];
      if (!col || !dayCitas.length) return;
      buildTimedEventLayout(dayCitas, containerHeightPx, CALENDAR_STACK_MAX_COLS.semana).forEach(layout => {
        const pill = layout.group
          ? buildEventGroupCardEl(layout.group, dateStr)
          : buildEventPillEl(layout.cita);
        applyTimedPillLayout(pill, layout);
        col.appendChild(pill);
      });
    });

    // Línea de "hora actual" (ver renderCurrentTimeLine) — solo tiene
    // sentido dibujarla en la columna del día de hoy, si esa fecha cae
    // dentro de la semana que se está viendo. Los demás días ya quedaron
    // limpios arriba (dayCols.forEach(col => col.innerHTML = '')).
    const todayIdx = daysOfWeek.findIndex(d => formatDateIso(d) === todayIso);
    if (todayIdx !== -1 && dayCols[todayIdx]) {
      renderCurrentTimeLine(dayCols[todayIdx], containerHeightPx);
    }

    // Celular: la semana se desplaza de lado (ver #mode-semana en
    // styles.css) — se lleva sola a la columna de hoy (o al lunes si la
    // semana visible no incluye hoy) al cambiar de semana.
    if (modeSemana.scrollWidth > modeSemana.clientWidth + 1) {
      const weekKey = formatDateIso(monday);
      if (modeSemana.dataset.scrolledWeek !== weekKey) {
        modeSemana.dataset.scrolledWeek = weekKey;
        const labelCol = modeSemana.querySelector('.week-grid-header .week-day-col-header');
        const dayHeader = headerCols[(todayIdx !== -1 ? todayIdx : 0) + 1];
        modeSemana.scrollLeft = 0;
        if (dayHeader && labelCol) {
          // Con el scroll en 0, distancia del día al borde derecho de la
          // columna de horas (fija), para que el día quede justo al lado.
          modeSemana.scrollLeft = Math.max(0,
            dayHeader.getBoundingClientRect().left - labelCol.getBoundingClientRect().right);
        }
      }
    }
  }

  function renderDayMode(citas) {
    if (!modeDia) return;

    const curIso = formatDateIso(calendarState.currentDate);
    const todayIso = formatDateIso(new Date());
    const isToday = curIso === todayIso;
    const dayHeader = modeDia.querySelector('.day-grid-header .week-day-col-header:last-child');
    if (dayHeader) {
      const d = calendarState.currentDate;
      dayHeader.innerHTML = `${dayNamesEs[d.getDay()]}. <strong>${d.getDate()}</strong>`;
      dayHeader.classList.toggle('is-today', isToday);
    }

    const rows = modeDia.querySelectorAll('.timeline-row-day');
    rows.forEach((row, rowIdx) => {
      const slot = row.querySelector('.time-cell-slot');
      if (slot) {
        // Ver el comentario equivalente en renderWeekMode.
        const hourNum = CALENDAR_GRID_START_MIN / 60 + rowIdx;
        const hourStr = String(hourNum).padStart(2, '0') + ':00';
        slot.onclick = (e) => {
          if (e.target === slot) {
            window.openCitaModal({ fecha: curIso, hora: hourStr });
          }
        };
      }
    });

    // Ver comentario equivalente en renderWeekMode.
    const overlay = document.getElementById('dayEventsOverlay');
    const col = overlay ? overlay.querySelector('.day-events-col') : null;
    if (col) {
      col.innerHTML = '';
      const rowsContainerDay = modeDia.querySelector('.timeline-rows-container');
      const containerHeightPx = (rowsContainerDay && rowsContainerDay.getBoundingClientRect().height) || (rows.length * 68);
      const dayCitas = citas.filter(c => c.fecha === curIso);
      buildTimedEventLayout(dayCitas, containerHeightPx, CALENDAR_STACK_MAX_COLS.dia).forEach(layout => {
        const pill = layout.group
          ? buildEventGroupCardEl(layout.group, curIso)
          : buildEventPillEl(layout.cita);
        applyTimedPillLayout(pill, layout);
        col.appendChild(pill);
      });
      if (isToday) renderCurrentTimeLine(col, containerHeightPx);
    }
  }

  function renderMonthMode(citas) {
    if (!modeMes) return;

    const monthGrid = modeMes.querySelector('.month-days-grid');
    if (!monthGrid) return;

    const cur = calendarState.currentDate;
    const year = cur.getFullYear();
    const month = cur.getMonth();

    const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
    const totalDaysMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    monthGrid.innerHTML = '';

    for (let x = firstDayIndex; x > 0; x--) {
      const dayNum = prevMonthDays - x + 1;
      const cell = document.createElement('div');
      cell.className = 'month-day-cell other-month';
      cell.innerHTML = `<span class="month-day-num" style="color: var(--text-subtle);">${dayNum}</span>`;
      monthGrid.appendChild(cell);
    }

    const todayIso = formatDateIso(new Date());
    for (let day = 1; day <= totalDaysMonth; day++) {
      const cellDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = cellDateStr === todayIso;

      const cell = document.createElement('div');
      cell.className = `month-day-cell ${isToday ? 'current-day' : ''}`;
      cell.innerHTML = `<span class="month-day-num">${day}</span>`;

      cell.onclick = (e) => {
        if (e.target === cell || e.target.classList.contains('month-day-num')) {
          window.openCitaModal({ fecha: cellDateStr });
        }
      };

      const dayCitas = citas.filter(c => c.fecha === cellDateStr);
      // Sin límite, un día con muchas citas (ej. 30) las amontonaba todas en
      // la celda — con overflow:hidden en .month-day-cell, la mayoría ni
      // siquiera se alcanzaban a ver, quedaban recortadas sin ninguna forma
      // de acceder a ellas. Se topa la celda a 5 elementos como máximo: si
      // hay más citas, la 5ª se reemplaza por un botón "+N más" que abre el
      // modal con el listado completo del día (ver openDayAppointmentsModal).
      const MAX_PILLS_PER_DAY_CELL = 5;
      const visibleCitas = dayCitas.length > MAX_PILLS_PER_DAY_CELL
        ? dayCitas.slice(0, MAX_PILLS_PER_DAY_CELL - 1)
        : dayCitas;
      visibleCitas.forEach(cita => {
        cell.appendChild(buildEventPillEl(cita));
      });
      if (dayCitas.length > MAX_PILLS_PER_DAY_CELL) {
        const moreBtn = document.createElement('div');
        const hiddenCount = dayCitas.length - visibleCitas.length;
        moreBtn.className = 'event-pill-more';
        moreBtn.textContent = `+${hiddenCount} más`;
        moreBtn.onclick = (e) => {
          e.stopPropagation();
          openDayAppointmentsModal(cellDateStr, dayCitas);
        };
        cell.appendChild(moreBtn);
      }

      monthGrid.appendChild(cell);
    }

    const totalCellsSoFar = firstDayIndex + totalDaysMonth;
    const remainingCells = 42 - totalCellsSoFar;
    for (let i = 1; i <= remainingCells; i++) {
      const cell = document.createElement('div');
      cell.className = 'month-day-cell other-month';
      cell.innerHTML = `<span class="month-day-num" style="color: var(--text-subtle);">${i}</span>`;
      monthGrid.appendChild(cell);
    }
  }

  const MAX_CITA_FILES = 8;

  // Antes vivían en IndexedDB del navegador (CLIVORA_CitaFilesDB) — se perdían
  // al cambiar de computadora/navegador y nadie más del personal podía
  // verlos. Ahora son archivos reales del lado del backend.
  async function getCitaFiles(citaId) {
    try {
      const response = await fetch(`/clivora/api/citas/${citaId}/files`, { cache: 'no-store' });
      return response.ok ? await response.json() : [];
    } catch (error) {
      console.error('Error al cargar archivos de la cita:', error);
      return [];
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function formatFileSize(bytes) {
    if (!bytes) return '0 KB';
    return bytes < 1024 * 1024
      ? (bytes / 1024).toFixed(1) + ' KB'
      : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function deleteCitaFile(fileId) {
    try {
      await fetch(`/clivora/api/cita_files/${fileId}/delete`, { method: 'POST' });
    } catch (error) {
      console.error('Error al eliminar archivo de la cita:', error);
    }
  }

  async function addFilesToCita(citaId, fileList, callback) {
    if (!fileList || fileList.length === 0) return;
    const currentFiles = await getCitaFiles(citaId);

    if (currentFiles.length >= MAX_CITA_FILES) {
      showClivoraAlertModal(`Se ha alcanzado el límite máximo de ${MAX_CITA_FILES} archivos por cita.`);
      return;
    }

    let filesArray = Array.from(fileList);
    const availableSlots = MAX_CITA_FILES - currentFiles.length;

    if (filesArray.length > availableSlots) {
      showClivoraAlertModal(`Solo se procesarán los primeros ${availableSlots} archivo(s) para no superar el límite de ${MAX_CITA_FILES} por cita.`);
      filesArray = filesArray.slice(0, availableSlots);
    }

    try {
      const encoded = await Promise.all(filesArray.map(async (file) => ({
        name: file.name,
        dataUrl: await readFileAsDataUrl(file),
      })));
      await fetch(`/clivora/api/citas/${citaId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: encoded }),
      });
    } catch (error) {
      console.error('Error al subir archivos de la cita:', error);
      showClivoraAlertModal('No se pudieron subir los archivos.');
    }

    if (callback) callback();
  }

  let activeCitaIdForUpload = null;

  // Los botones "Subir archivos"/"Ver archivos subidos" de la Agenda llevan
  // al expediente del paciente de la cita (pestaña ARCHIVOS) en vez de abrir
  // los archivos sueltos de la cita. Reutiliza el click de
  // .open-patient-detail para cargar el paciente igual que "Ver Paciente".
  // Devuelve false si la cita no tiene paciente, para que el llamador use el
  // flujo anterior de archivos de la cita.
  function openPatientFilesFromCita(citaId, openUpload) {
    const cita = clivoraCitasCache.find(c => String(c.id) === String(citaId));
    if (!cita || !cita.pacienteId) return false;

    const opener = document.createElement('button');
    opener.className = 'open-patient-detail';
    opener.style.display = 'none';
    opener.dataset.id = cita.pacienteId;
    opener.dataset.name = cita.paciente || '';
    opener.dataset.exp = cita.pacienteExp || '';
    document.body.appendChild(opener);
    opener.click();
    opener.remove();

    goToExpedienteSubTab('tab-archivos');
    if (openUpload) document.getElementById('btnOpenUploadFileModal')?.click();
    return true;
  }

  document.addEventListener('click', (e) => {
    const uploadBtn = e.target.closest('.btn-upload-cita-file');
    if (uploadBtn) {
      e.stopPropagation();
      if (openPatientFilesFromCita(uploadBtn.dataset.id, true)) return;
      activeCitaIdForUpload = uploadBtn.dataset.id;
      const fileInput = document.getElementById('agendaFileInput');
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
      return;
    }

    const viewBtn = e.target.closest('.btn-view-cita-files');
    if (viewBtn) {
      e.stopPropagation();
      if (openPatientFilesFromCita(viewBtn.dataset.id, false)) return;
      openViewCitaFilesModal(viewBtn.dataset.id);
      return;
    }

    const closeBtn = e.target.closest('#closeViewCitaFilesModal');
    if (closeBtn) {
      const modal = document.getElementById('viewCitaFilesModal');
      if (modal) modal.classList.remove('open');
      return;
    }

    if (e.target.classList.contains('modal-overlay') && e.target.id === 'viewCitaFilesModal') {
      e.target.classList.remove('open');
      return;
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'agendaFileInput') {
      if (activeCitaIdForUpload && e.target.files && e.target.files.length > 0) {
        await addFilesToCita(activeCitaIdForUpload, e.target.files, () => {
          updateCalendarView();
          openViewCitaFilesModal(activeCitaIdForUpload);
        });
      }
    }
  });

  async function openViewCitaFilesModal(citaId) {
    const modal = document.getElementById('viewCitaFilesModal');
    if (!modal) return;

    const allCitas = clivoraCitasCache;
    const cita = allCitas.find(c => String(c.id) === String(citaId)) || { id: citaId, paciente: 'Paciente' };

    const titleEl = document.getElementById('citaFilesModalTitle');
    const subtitleEl = document.getElementById('citaFilesModalSubtitle');
    const bodyEl = document.getElementById('citaFilesModalBody');
    const uploadMoreBtn = document.getElementById('btnUploadMoreCitaFiles');

    if (subtitleEl) subtitleEl.textContent = `${citaDisplayName(cita)} | ${cita.fecha || ''} ${cita.hora || ''}`;

    async function renderFileList() {
      const files = await getCitaFiles(citaId);
      const isMax = files.length >= MAX_CITA_FILES;

      if (titleEl) titleEl.textContent = `Archivos de la Cita (${files.length}/${MAX_CITA_FILES})`;

      if (uploadMoreBtn) {
        if (isMax) {
          uploadMoreBtn.style.opacity = '0.5';
          uploadMoreBtn.style.cursor = 'not-allowed';
          uploadMoreBtn.onclick = () => showClivoraAlertModal(`Se ha alcanzado el límite máximo de ${MAX_CITA_FILES} archivos por cita.`);
        } else {
          uploadMoreBtn.style.opacity = '1';
          uploadMoreBtn.style.cursor = 'pointer';
          uploadMoreBtn.onclick = () => {
            activeCitaIdForUpload = citaId;
            const fileInput = document.getElementById('agendaFileInput');
            if (fileInput) {
              fileInput.value = '';
              fileInput.click();
            }
          };
        }
      }

      bodyEl.innerHTML = `
        <div id="citaFilesDropzone" style="border: 2px dashed ${isMax ? 'var(--border-color)' : 'var(--primary-blue)'}; border-radius: 10px; padding: 18px; text-align: center; background: ${isMax ? 'var(--bg-main)' : 'var(--primary-blue-light)'}; cursor: ${isMax ? 'not-allowed' : 'pointer'}; margin-bottom: 16px; transition: all 0.2s ease;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="${isMax ? 'var(--text-muted)' : 'var(--primary-blue)'}" stroke-width="2" style="margin-bottom: 6px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <div style="font-weight: 700; font-size: 13px; color: ${isMax ? 'var(--text-muted)' : 'var(--primary-blue)'};">
            ${isMax ? `Límite de ${MAX_CITA_FILES} archivos alcanzado` : `Selecciona o arrastra varios archivos aquí (Hasta ${MAX_CITA_FILES} por cita)`}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
            ${isMax ? 'Elimina un archivo existente si deseas subir uno nuevo.' : `Archivos cargados: ${files.length} de ${MAX_CITA_FILES} permitidos`}
          </div>
        </div>
        <div id="citaFilesItemsList"></div>
      `;

      const dropzone = bodyEl.querySelector('#citaFilesDropzone');
      if (dropzone && !isMax) {
        dropzone.onclick = () => {
          activeCitaIdForUpload = citaId;
          const fileInput = document.getElementById('agendaFileInput');
          if (fileInput) {
            fileInput.value = '';
            fileInput.click();
          }
        };

        dropzone.ondragover = (e) => {
          e.preventDefault();
          dropzone.style.borderColor = 'var(--accent-green)';
        };

        dropzone.ondragleave = (e) => {
          e.preventDefault();
          dropzone.style.borderColor = 'var(--primary-blue)';
        };

        dropzone.ondrop = async (e) => {
          e.preventDefault();
          dropzone.style.borderColor = 'var(--primary-blue)';
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            activeCitaIdForUpload = citaId;
            await addFilesToCita(citaId, e.dataTransfer.files, () => {
              updateCalendarView();
              renderFileList();
            });
          }
        };
      }

      const itemsList = bodyEl.querySelector('#citaFilesItemsList');

      if (files.length === 0) {
        itemsList.innerHTML = `
          <div style="padding: 20px 10px; text-align: center; color: var(--text-muted);">
            <div style="font-weight: 600; font-size: 13px; color: var(--text-main);">Sin archivos subidos aún</div>
            <div style="font-size: 11px; margin-top: 2px;">Los archivos que selecciones aparecerán listados aquí (Límite: ${MAX_CITA_FILES} archivos).</div>
          </div>
        `;
        return;
      }

      const listContainer = document.createElement('div');
      listContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

      files.forEach((file) => {
        const fileRow = document.createElement('div');
        fileRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 8px; font-size: 13px;';

        const isImg = file.mimetype && file.mimetype.startsWith('image/');
        const iconSvg = isImg ? `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        ` : `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        `;

        fileRow.innerHTML = `
          <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
            ${iconSvg}
            <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              <div style="font-weight: 600; color: var(--text-main); font-size: 13px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${file.name}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${formatFileSize(file.fileSize)} • ${formatClivoraDateTime(file.createDate)}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-shrink: 0;">
            <a href="${file.fileUrl.replace('download=false', 'download=true')}" target="_blank" download="${file.name}" class="btn-agenda-action" style="text-decoration: none; padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Ver
            </a>
            <button type="button" class="btn-agenda-action btn-delete-file" style="color: var(--accent-red); border-color: rgba(239, 68, 68, 0.3); display: inline-flex; align-items: center; justify-content: center;" data-id="${file.id}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        `;

        fileRow.querySelector('.btn-delete-file').onclick = async () => {
          await deleteCitaFile(file.id);
          renderFileList();
          updateCalendarView();
        };

        listContainer.appendChild(fileRow);
      });

      itemsList.appendChild(listContainer);
    }

    await renderFileList();
    modal.classList.add('open');
  }

  async function renderAgendaMode(citas) {
    if (!modeAgenda) return;

    modeAgenda.innerHTML = '';

    if (citas.length === 0) {
      modeAgenda.innerHTML = `<div class="agenda-empty-view" style="padding: 40px; text-align: center; color: var(--text-muted);">No hay eventos para mostrar con los filtros seleccionados</div>`;
      return;
    }

    const agendaList = document.createElement('div');
    agendaList.className = 'agenda-items-container';
    agendaList.style.cssText = 'display: flex; flex-direction: column; gap: 12px; padding: 16px;';

    const borderColorByStatus = {
      aprobado: '#10b981',
      rechazado: '#ef4444',
      pendiente: '#f97316',
      desfasado: '#db2777',
      nuevo: '#2563eb',
      en_progreso: '#8b5cf6',
      finalizado: '#64748b'
    };

    for (const cita of citas) {
      const st = (cita.estado || 'nuevo').toLowerCase();
      const borderColor = borderColorByStatus[st] || '#2563eb';
      const item = document.createElement('div');
      item.style.cssText = `background: var(--bg-card); border-left: 4px solid ${borderColor}; padding: 14px 18px; border-radius: var(--radius-md); box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border-color); cursor: pointer; transition: transform 0.15s ease;`;

      const descDetail = cita.sala ? `${cita.tipo} - ${cita.motivo} | ${cita.ubicacion} (${cita.sala})` : `${cita.tipo} - ${cita.motivo} | ${cita.doctor || 'Doctor general'} (${cita.especialidad || 'General'})`;

      // Con paciente, los botones abren sus archivos de expediente: el
      // contador de archivos de la cita ya no aplica.
      const fileCount = cita.pacienteId ? 0 : (await getCitaFiles(cita.id)).length;

      item.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
          <div>
            <div style="font-weight: 700; font-size: 14px; color: var(--text-main);">${citaDisplayName(cita)}</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
              ${descDetail}
            </div>
            <div style="font-size: 11px; color: ${borderColor}; font-weight: 600; margin-top: 4px;">
              Frecuencia: ${cita.frecuencia || 'Primera vez'} | ${cita.ciclo || 'Ciclo 1'} | Estado: ${st.toUpperCase()}
            </div>
          </div>
          <div style="text-align: right;">
            <span style="background: rgba(37, 99, 235, 0.1); color: ${borderColor}; font-weight: 700; font-size: 12px; padding: 4px 10px; border-radius: 12px; display: inline-block;">
              ${cita.fecha} ${cita.hora}
            </span>
          </div>
        </div>

        <div class="agenda-item-actions" style="display: flex; gap: 10px; align-items: center; padding-top: 8px; border-top: 1px dashed var(--border-color);">
          <button type="button" class="btn-agenda-action btn-upload-cita-file" data-id="${cita.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Subir archivos
          </button>

          <button type="button" class="btn-agenda-action btn-view-cita-files" data-id="${cita.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            Ver archivos subidos ${fileCount > 0 ? `<span style="background: var(--primary-blue); color: white; border-radius: 10px; padding: 1px 7px; font-size: 10px; margin-left: 4px; font-weight: 700;">${fileCount}/${MAX_CITA_FILES}</span>` : ''}
          </button>
        </div>
      `;

      item.onclick = (e) => {
        if (!e.target.closest('.agenda-item-actions')) {
          window.openCitaModal(cita);
        }
      };

      agendaList.appendChild(item);
    }

    modeAgenda.appendChild(agendaList);
  }

  async function reloadCitasFromServer() {
    try {
      const response = await fetch('/clivora/api/citas', { cache: 'no-store' });
      clivoraCitasCache = response.ok ? await response.json() : [];
    } catch (error) {
      console.error('Error al cargar citas:', error);
      clivoraCitasCache = [];
    }
    updateCalendarView();
    if (typeof updateDashboardMetrics === 'function') updateDashboardMetrics();
  }

  window.refreshDynamicCalendar = reloadCitasFromServer;
  window.calendarState = calendarState;
  window.updateCalendarView = updateCalendarView;
  reloadCitasFromServer();

  // La línea de "hora actual" (ver renderCurrentTimeLine) se calcula al
  // renderizar Día/Semana, pero sin esto se quedaba congelada en la hora de
  // esa última renderización — un médico que deja la pestaña abierta varios
  // minutos vería la línea atrasada. Se reposiciona sola cada minuto sin
  // necesidad de un re-render completo (no toca las citas ya pintadas).
  setInterval(() => {
    const mode = calendarState.currentMode;
    if (mode !== 'dia' && mode !== 'semana') return;
    const overlayId = mode === 'dia' ? 'dayEventsOverlay' : 'weekEventsOverlay';
    const overlay = document.getElementById(overlayId);
    const modeContainer = mode === 'dia' ? modeDia : modeSemana;
    if (!overlay || !modeContainer) return;
    const rowsContainer = modeContainer.querySelector('.timeline-rows-container');
    const containerHeightPx = rowsContainer && rowsContainer.getBoundingClientRect().height;
    if (!containerHeightPx) return;
    const todayIso = formatDateIso(new Date());
    if (mode === 'dia') {
      if (formatDateIso(calendarState.currentDate) !== todayIso) return;
      renderCurrentTimeLine(overlay.querySelector('.day-events-col'), containerHeightPx);
    } else {
      const monday = getMonday(calendarState.currentDate);
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        if (formatDateIso(d) === todayIso) {
          renderCurrentTimeLine(overlay.querySelector(`.day-events-col[data-day-idx="${i}"]`), containerHeightPx);
          break;
        }
      }
    }
  }, 60000);
}

document.addEventListener('DOMContentLoaded', () => {
  initializeAgendarCitaModule();
  initializeDynamicCalendarModule();
});
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  initializeAgendarCitaModule();
  initializeDynamicCalendarModule();
}




// Botón "+ Agregar Tratamiento": el modal addTratamientoModal era un stub
// sin ningún fetch (solo cerraba al enviar) — se reutiliza el modal real de
// Agenda (openCitaModal), que ya soporta tipo "Tratamiento" (muestra
// Sala/Ubicación) y sí guarda contra el backend.
const openAddTratamiento = document.getElementById('openAddTratamiento');
const openAddCitaTratamiento = document.getElementById('openAddCitaTratamiento');
[openAddTratamiento, openAddCitaTratamiento].forEach(btn => {
  if (btn) btn.addEventListener('click', () => {
    if (typeof window.openCitaModal === 'function') window.openCitaModal({ tipo: 'Tratamiento' });
  });
});

// Antes la tarjeta del sidebar y el modal "Mi Perfil" mostraban texto fijo
// ("Héctor Arellano Ramírez", "Gerente de IT", correo "admin"...) sin
// importar quién hubiera iniciado sesión. Esto trae los datos reales del
// usuario actual (/api/me) y los deja guardados en window.clivoraCurrentUser
// para que el modal los use también al abrirse.
window.clivoraCurrentUser = null;

async function loadCurrentUserProfile() {
  let data;
  try {
    const response = await fetch('/clivora/api/me', { cache: 'no-store' });
    data = response.ok ? await response.json() : null;
  } catch (error) {
    console.error('Error al cargar el perfil del usuario:', error);
    data = null;
  }
  if (!data) return;
  window.clivoraCurrentUser = data;

  // Helpers compartidos por los bloques de permisos de rol de más abajo.
  const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  const lockReadOnly = (root) => {
    if (!root) return;
    root.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
    root.querySelectorAll('[contenteditable="true"]').forEach((el) => el.setAttribute('contenteditable', 'false'));
    root.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
  };

  const sidebarUserName = document.getElementById('sidebarUserName');
  const sidebarUserRole = document.getElementById('sidebarUserRole');
  const sidebarUserDept = document.getElementById('sidebarUserDept');
  if (sidebarUserName) sidebarUserName.textContent = data.name || 'Usuario';
  if (sidebarUserRole) sidebarUserRole.textContent = data.function || '';
  if (sidebarUserDept) sidebarUserDept.textContent = data.department || '';

  const headerWelcomeTitle = document.getElementById('headerWelcomeTitle');
  if (headerWelcomeTitle) {
    const firstName = (data.name || '').trim().split(' ').slice(0, 2).join(' ');
    headerWelcomeTitle.textContent = firstName ? `Bienvenido, ${firstName}` : 'Bienvenido';
  }

  // Sección "Clínica" del sidebar (Tratamientos + Médicos):
  // solo para Médicos/Enfermería (ver canSeeClinicMenu en /api/me). Un
  // administrador siempre la ve porque base.group_system implica ambos
  // grupos.
  const clinicaNavSection = document.getElementById('clinicaNavSection');
  if (clinicaNavSection) clinicaNavSection.style.display = data.canSeeClinicMenu ? '' : 'none';

  // Doctor en modo solo lectura (ver isDoctorReadOnly en /api/me): oculta
  // los botones de creación de Agenda/Tratamientos. El resto del bloqueo
  // (editar/cambiar estado sobre un registro ya existente) se aplica en
  // openCitaModal y openTratamientoOrderModal, los puntos donde convergen
  // todas las formas de abrir esas pantallas.
  if (data.isDoctorReadOnly) {
    const openAddCitaModalBtn = document.getElementById('openAddCitaModal');
    if (openAddCitaModalBtn) openAddCitaModalBtn.style.display = 'none';
    hide('agendarCitaPacienteBtn');
    const openAddTratamientoBtn = document.getElementById('openAddTratamiento');
    if (openAddTratamientoBtn) openAddTratamientoBtn.style.display = 'none';

    // Datos del Paciente: mismo bloqueo que Enfermería (ver isEnfermeriaLimited
    // más abajo) — un Doctor puro puede CONSULTAR el expediente pero no debe
    // poder editar Información General/Domicilio/Facturación ni la foto/pills
    // de nacimiento, celular o médico asignado.
    hide('detailPatientPhotoBtn');
    ['btnEditPillNacimiento', 'btnEditPillCelular', 'btnEditPillMedico'].forEach(hide);
    lockReadOnly(document.querySelector('.accordion-list'));
  }

  // Enfermería en modo restringido (ver isEnfermeriaLimited en /api/me):
  // edición completa en Agenda, Tratamiento, Órdenes médicas, Signos
  // Vitales, Notas de Enfermería y Archivos; solo lectura (puede ver el
  // detalle pero no editar ni crear) en Datos del Paciente, Historia
  // Clínica, Notas de Oncología y Recetas Médicas; no puede crear pacientes
  // nuevos. El HTML de paciente-detail.html ya está inyectado en
  // #pacienteDetailShell en este punto (se hizo más arriba en este mismo
  // handler) y es un formulario estático único que se reutiliza para
  // cualquier paciente (solo se le rellenan los campos al abrir cada
  // expediente) — alcanza con bloquearlo una sola vez aquí.
  if (data.isEnfermeriaLimited) {
    // Activa las reglas CSS de .clivora-enfermeria-limited (ver styles.css):
    // ocultan Editar/Eliminar en el detalle de una receta ya guardada, que
    // se reconstruye por completo (innerHTML) cada vez que se selecciona
    // una de la lista — un disable de una sola vez en JS no sobreviviría a
    // ese re-render, pero una regla CSS sí, porque aplica sin importar
    // cuándo se generen esos botones.
    document.body.classList.add('clivora-enfermeria-limited');

    hide('openNuevoPacienteView');

    // Datos del Paciente: foto, las 3 "pills" editables (nacimiento/celular/
    // médico) y los acordeones de Información General/Domicilio/Facturación.
    // El toggle de abrir/cerrar cada acordeón (.accordion-header, un <div>,
    // no un <button>) no se toca, así que enfermería sigue pudiendo
    // expandirlos para CONSULTAR los datos.
    hide('detailPatientPhotoBtn');
    ['btnEditPillNacimiento', 'btnEditPillCelular', 'btnEditPillMedico'].forEach(hide);
    lockReadOnly(document.querySelector('.accordion-list'));

    // Historia Clínica: todo el tab queda de solo lectura; se ocultan
    // "Descartar" y "Guardar", se deja "Imprimir" (no modifica datos).
    const historiaTab = document.getElementById('tab-historia-clinica');
    if (historiaTab) {
      lockReadOnly(historiaTab);
      historiaTab.querySelectorAll('.expediente-sidebar-actions .btn-hc-action').forEach((btn) => {
        if (!btn.classList.contains('blue-outline')) btn.style.display = 'none';
      });
    }

    // Recetas Médicas: no se pueden crear nuevas; Editar/Eliminar sobre una
    // ya guardada se ocultan por la clase .clivora-enfermeria-limited (CSS).
    hide('btnOpenNuevaRecetaForm');

    // Notas de Oncología: se crean desde el selector "Nueva Nota"
    // (nuevaConsultaModal) — se oculta solo esa opción; "Signos Vitales" y
    // "Notas de Enfermería" del mismo selector quedan intactas.
    hide('btnTypeNotaOnco');
  }

  // Admisiones/Recepción en modo restringido (ver isRecepcionLimited en
  // /api/me): edición completa en Pacientes, Archivos y Agenda (solo citas
  // tipo Consulta — no crean Tratamientos, ver applyRecepcionAgendaRestrictions
  // dentro de openCitaModal); solo lectura en Historial Clínico, Órdenes
  // Médicas, Recetas Médicas y Notas. No ven el apartado "Clínica" (ya
  // resuelto arriba por canSeeClinicMenu, sin flag aparte).
  if (data.isRecepcionLimited) {
    // Activa en styles.css las reglas .clivora-recepcion-limited que ocultan
    // Editar/Eliminar en el detalle de una orden médica o receta ya
    // guardada — esos detalles se reconstruyen por completo (innerHTML)
    // cada vez que se selecciona un registro distinto de la lista, así que
    // un disable de una sola vez en JS no sobreviviría a ese re-render.
    document.body.classList.add('clivora-recepcion-limited');

    // Historia Clínica: mismo candado que usa Enfermería — es un formulario
    // estático que solo se rellena por paciente, no se reconstruye.
    const historiaTab = document.getElementById('tab-historia-clinica');
    if (historiaTab) {
      lockReadOnly(historiaTab);
      historiaTab.querySelectorAll('.expediente-sidebar-actions .btn-hc-action').forEach((btn) => {
        if (!btn.classList.contains('blue-outline')) btn.style.display = 'none';
      });
    }

    // Órdenes Médicas: no se pueden crear (Editar/Eliminar del detalle vía
    // CSS, ver arriba).
    hide('btnOpenCrearOrdenMedica');

    // Recetas Médicas: no se pueden crear (Editar/Eliminar del detalle vía
    // CSS, ver arriba).
    hide('btnOpenNuevaRecetaForm');

    // Notas: no se pueden crear de ningún tipo (a diferencia de Enfermería,
    // que sí puede crear Signos Vitales/Notas de Enfermería) — se oculta el
    // botón "+ Nueva Consulta" completo en vez de cada opción del selector.
    hide('btnOpenNuevaConsultaModal');
  }

  // Jefe de Admisiones/Recepción (ver isJefeRecepcionLimited en /api/me):
  // todo lo de Recepción (Pacientes, Agenda solo Consulta —ver
  // applyRecepcionAgendaRestrictions—, Archivos) más edición completa de
  // Historia Clínica, Órdenes Médicas y Recetas Médicas: a diferencia del
  // bloque isRecepcionLimited de arriba, aquí NO se agrega la clase
  // .clivora-recepcion-limited (que ocultaría Editar/Eliminar de una orden/
  // receta ya guardada) ni se bloquea tab-historia-clinica ni se ocultan
  // btnOpenCrearOrdenMedica/btnOpenNuevaRecetaForm — todo eso queda
  // habilitado. La única restricción que conserva es no poder crear Signos
  // Vitales ni Notas de Enfermería (sí puede crear Notas de Oncología), así
  // que se ocultan solo esas dos opciones del selector "+ Nueva Consulta",
  // dejando el botón principal y "Nota de Oncología Médica" intactos.
  // Signos Vitales y Notas de Enfermería en solo lectura (Recepción y Jefe de
  // Recepción, ver canEditNursingVitals en /api/me): la clase oculta sus
  // botones Editar/Eliminar (ver .clivora-no-nursing-edit en styles.css).
  document.body.classList.toggle('clivora-no-nursing-edit', data.canEditNursingVitals === false);

  if (data.isJefeRecepcionLimited) {
    hide('btnTypeSignosVitales');
    const btnTypeNotaEnfermeria = document.querySelector('#nuevaConsultaModal [data-type="Notas de enfermeria"]');
    if (btnTypeNotaEnfermeria) btnTypeNotaEnfermeria.style.display = 'none';
  }
}

// Encabezado persistente (fecha/hora en vivo) que vive arriba de todas las
// vistas — antes solo existía la versión vieja del dashboard, sin reloj.
function updateHeaderLiveClock() {
  const timeEl = document.getElementById('headerLiveTime');
  const dateEl = document.getElementById('headerLiveDate');
  const now = new Date();

  if (timeEl) {
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'p. m.' : 'a. m.';
    hours = hours % 12;
    hours = hours ? hours : 12;
    timeEl.textContent = `${hours}:${minutes}:${seconds} ${ampm}`;
  }

  if (dateEl) {
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    dateEl.textContent = `${days[now.getDay()]}, ${now.getDate()} de ${months[now.getMonth()]} de ${now.getFullYear()}`;
  }
}
updateHeaderLiveClock();
setInterval(updateHeaderLiveClock, 1000);

// Fondo de partículas animadas detrás de toda la app (antes solo existía
// en la pantalla de login) — canvas fijo con partículas que suben desde
// abajo y se repelen del mouse.
function initParticlesBackground() {
  const canvas = document.getElementById('particlesBg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let width = canvas.width = window.innerWidth;
  let height = canvas.height = window.innerHeight;

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const particles = [];
  const particleCount = 60;

  const mouse = { x: null, y: null, radius: 110 };
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  window.addEventListener('mouseleave', () => {
    mouse.x = null;
    mouse.y = null;
  });

  class Particle {
    constructor() {
      this.reset();
      this.y = Math.random() * height;
    }
    reset() {
      this.x = Math.random() * width;
      this.y = height + Math.random() * 20;
      this.size = Math.random() * 5 + 2;
      this.speedX = Math.random() * 0.4 - 0.2;
      this.speedY = -(Math.random() * 0.7 + 0.3);
      this.opacity = Math.random() * 0.4 + 0.1;
      this.color = `rgba(47, 76, 138, ${this.opacity})`;
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      if (mouse.x !== null && mouse.y !== null) {
        const dx = this.x - mouse.x;
        const dy = this.y - mouse.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < mouse.radius) {
          const force = (mouse.radius - distance) / mouse.radius;
          const angle = Math.atan2(dy, dx);
          this.x += Math.cos(angle) * force * 4;
          this.y += Math.sin(angle) * force * 4;
        }
      }
      if (this.y < -10 || this.x < -10 || this.x > width + 10) this.reset();
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
  }

  for (let i = 0; i < particleCount; i++) particles.push(new Particle());

  function animate() {
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < particles.length; i++) {
      particles[i].update();
      particles[i].draw();
    }
    requestAnimationFrame(animate);
  }
  animate();
}
initParticlesBackground();

document.addEventListener('click', (event) => {
  if (event.target.closest('#headerProfileAvatar')) {
    document.getElementById('userProfileBtn')?.click();
  }
});

// ============================================================
// 13b. MODAL — PERFIL DE USUARIO + CERRAR SESIÓN
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const userProfileBtn = document.getElementById('userProfileBtn');
  const userProfileModal = document.getElementById('userProfileModal');
  const closeUserProfile = document.getElementById('closeUserProfile');
  const cancelUserProfile = document.getElementById('cancelUserProfile');
  const userProfileForm = document.getElementById('userProfileForm');
  const btnLogout = document.getElementById('btnLogout');
  const togglePasswordSection = document.getElementById('togglePasswordSection');
  const passwordFields = document.getElementById('passwordFields');
  const passwordChevron = document.getElementById('passwordChevron');

  // Abrir modal de perfil
  function populateProfileModalFields() {
    const data = window.clivoraCurrentUser;
    if (!data) return;
    const displayName = document.getElementById('profileDisplayName');
    const displayRole = document.getElementById('profileDisplayRole');
    const nameInput = document.getElementById('profileName');
    const emailInput = document.getElementById('profileEmail');
    const roleInput = document.getElementById('profileRole');
    const deptInput = document.getElementById('profileDept');
    if (displayName) displayName.textContent = data.name || 'Usuario';
    if (displayRole) displayRole.textContent = data.function || '';
    if (nameInput) nameInput.value = data.name || '';
    if (emailInput) emailInput.value = data.email || '';
    if (roleInput) roleInput.value = data.function || '';
    if (deptInput) deptInput.value = data.department || '';
  }
  if (userProfileBtn) {
    userProfileBtn.addEventListener('click', async () => {
      if (!window.clivoraCurrentUser) await loadCurrentUserProfile();
      populateProfileModalFields();
      userProfileModal.classList.add('open');
    });
  }

  // Cerrar modal
  function closeProfileModal() {
    userProfileModal.classList.remove('open');
    // Reset password fields
    if (passwordFields) {
      passwordFields.style.display = 'none';
      passwordChevron.style.transform = '';
    }
  }
  if (closeUserProfile) closeUserProfile.addEventListener('click', closeProfileModal);
  if (cancelUserProfile) cancelUserProfile.addEventListener('click', closeProfileModal);

  // Toggle sección de contraseña
  if (togglePasswordSection) {
    togglePasswordSection.addEventListener('click', () => {
      const isOpen = passwordFields.style.display === 'flex';
      passwordFields.style.display = isOpen ? 'none' : 'flex';
      passwordChevron.style.transform = isOpen ? '' : 'rotate(180deg)';
    });
  }

  // Guardar cambios del perfil
  if (userProfileForm) {
    userProfileForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('profileName').value.trim();
      const role = document.getElementById('profileRole').value.trim();
      const dept = document.getElementById('profileDept').value.trim();

      // Actualizar sidebar con los nuevos datos
      const sidebarName = document.querySelector('.user-name');
      const sidebarRole = document.querySelector('.user-role');
      const sidebarDept = document.querySelector('.user-dept');
      const profileDisplayName = document.getElementById('profileDisplayName');

      if (sidebarName) if (name) sidebarName.textContent = name;
      if (sidebarRole) if (role) sidebarRole.textContent = role;
      if (sidebarDept) if (dept) sidebarDept.textContent = dept;
      if (profileDisplayName) if (name) profileDisplayName.textContent = name;

      // Actualizar welcome title
      const welcomeTitle = document.querySelector('.welcome-title');
      if (welcomeTitle) if (name) {
        welcomeTitle.textContent = 'Bienvenido, ' + name;
      }

      closeProfileModal();
    });
  }

  // Cerrar sesión — termina la sesión y regresa a /clivora, que va a pedir
  // login de nuevo.
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      closeProfileModal();
      window.location.href = '/clivora/logout';
    });
  }
});

// ============================================================
// 15. CHART.JS — Gráfica de Facturación
// ============================================================
const facturacionChartElement = document.getElementById('facturacionChart');
if (facturacionChartElement) {
  const ctx2 = facturacionChartElement.getContext('2d');
  window.facturacionChart = new Chart(ctx2, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'Facturado', data: [], borderColor: '#2563EB', backgroundColor: '#2563EB', borderWidth: 3, tension: 0.2 },
    ]
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'bottom' } } }
  });
}

// ============================================================
// FARMACIA Y FACTURACIÓN (tab de Inicio) — datos reales
// ============================================================
function formatMoneyMXN(amount) {
  return (amount || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
}

async function loadFarmaciaSummary() {
  let data;
  try {
    const response = await fetch('/clivora/api/farmacia/summary', { cache: 'no-store' });
    data = response.ok ? await response.json() : null;
  } catch (error) {
    console.error('Error al cargar resumen de farmacia:', error);
  }
  if (!data) return;

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('metricEntradasMesValue', data.entradasMes);
  setText('metricSalidasMesValue', data.salidasMes);
  setText('metricEntradasPendientesValue', data.entradasPendientes);
  setText('metricSalidasPendientesValue', data.salidasPendientes);
  setText('metricExistenciasValue', data.existenciasConStock);

  const body = document.getElementById('farmaciaMovimientosBody');
  if (!body) return;
  if (!data.movimientos || data.movimientos.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Sin movimientos de inventario registrados.</td></tr>';
    return;
  }
  const badgeClass = { 'Entrada': 'listo', 'Salida': 'salida', 'Interno': 'listo' };
  body.innerHTML = data.movimientos.map(m => `
    <tr>
      <td><span class="badge-pill ${badgeClass[m.tipo] || 'listo'}">${escapeHtml(m.tipo)}</span></td>
      <td><strong>${escapeHtml(m.referencia)}</strong></td>
      <td>${escapeHtml(m.contacto || '—')}</td>
      <td>${escapeHtml(m.fecha)}</td>
      <td>${escapeHtml(m.estado)}</td>
    </tr>
  `).join('');
}

async function loadFacturacionSummary() {
  let data;
  try {
    const response = await fetch('/clivora/api/facturacion/summary', { cache: 'no-store' });
    data = response.ok ? await response.json() : null;
  } catch (error) {
    console.error('Error al cargar resumen de facturación:', error);
  }
  if (!data) return;

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('metricFacturadoMesValue', formatMoneyMXN(data.facturadoMes));
  setText('metricPagadoMesValue', formatMoneyMXN(data.pagadoMes));
  setText('metricPorCobrarValue', formatMoneyMXN(data.porCobrar));
  setText('metricFacturasPendientesValue', data.facturasPendientesCount);

  if (window.facturacionChart) {
    window.facturacionChart.data.labels = data.chartLabels || [];
    window.facturacionChart.data.datasets[0].data = data.chartData || [];
    window.facturacionChart.update();
  }

  const body = document.getElementById('facturacionPendientesBody');
  if (!body) return;
  if (!data.facturas || data.facturas.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Sin facturas pendientes de cobro.</td></tr>';
    return;
  }
  body.innerHTML = data.facturas.map(f => `
    <tr>
      <td><strong>${escapeHtml(f.name)}</strong></td>
      <td>${escapeHtml(f.partner || '—')}</td>
      <td>${escapeHtml(f.fecha)}</td>
      <td>${formatMoneyMXN(f.total)}</td>
      <td>${formatMoneyMXN(f.pendiente)}</td>
    </tr>
  `).join('');
}

// ============================================================
// 20. LOCAL STORAGE — Restaurar estado al cargar
// ============================================================
// Restaura la vista activa, tab de expediente y sección HC desde localStorage
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    // Restaurar vista principal
    const savedView = localStorage.getItem('clivora_activeView');
    if (savedView) {
      const navItem = document.querySelector(`.nav-item[data-view="${savedView}"]`);
      if (navItem) navItem.click();
    }

    // Restaurar subtab del expediente (usa data-tab)
    const savedTab = localStorage.getItem('clivora_activeExpTab');
    if (savedTab) {
      const subtab = document.querySelector(`.expediente-subtab[data-tab="${savedTab}"]`);
      if (subtab) subtab.click();
    }

    // Restaurar sección HC activa
    const savedHC = localStorage.getItem('clivora_activeHC');
    if (savedHC) {
      const hcItem = document.querySelector(`.hc-section-item[data-hc-section="${savedHC}"]`);
      if (hcItem) hcItem.click();
    }
  }, 100);
});


// ============================================================
// 21. MOBILE SIDEBAR TOGGLE
// ============================================================
// Hamburger button opens sidebar on mobile. Overlay + nav items close it.
document.addEventListener("DOMContentLoaded", () => {
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileCloseSidebarBtn = document.getElementById('mobileCloseSidebarBtn');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const sidebar = document.getElementById('sidebar');

  function openMobileSidebar() {
    sidebar.classList.add('mobile-open');
    sidebarOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeMobileSidebar() {
    sidebar.classList.remove('mobile-open');
    sidebarOverlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', openMobileSidebar);
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeMobileSidebar);
  }
  if (mobileCloseSidebarBtn) {
    mobileCloseSidebarBtn.addEventListener('click', closeMobileSidebar);
  }

  // Close sidebar when a nav item is clicked on mobile
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (768 >= window.innerWidth) {
        closeMobileSidebar();
      }
    });
  });
});

function addAlergiaRow(desc = '', reaccion = '', obs = '') {
  const container = document.getElementById('alergiasContainer');
  if (!container) return;

  const card = document.createElement('div');
  card.className = 'alergia-card';
  card.innerHTML = `
    <div class="form-group">
      <label style="font-size: 11px;">Descripción</label>
      <input type="text" class="alergia-desc" placeholder="Ej. Penicilina" value="${desc}">
    </div>
    <div class="form-group">
      <label style="font-size: 11px;">Reacción</label>
      <input type="text" class="alergia-reaccion" placeholder="Ej. Rash / Urticaria" value="${reaccion}">
    </div>
    <div class="form-group">
      <label style="font-size: 11px;">Observaciones</label>
      <input type="text" class="alergia-obs" placeholder="Ej. Moderada" value="${obs}">
    </div>
    <button type="button" class="btn-delete-alergia" title="Eliminar alergia">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
    </button>
  `;
  container.appendChild(card);
}

function imprimirFichaIngreso() {
  const patientName = document.getElementById('detailPatientName')?.textContent || 'Paciente';
  const exp = document.getElementById('detailPatientExp')?.textContent || '';
  const fechaIngreso = document.getElementById('fichaFechaIngreso')?.value || 'N/A';
  const listaPrecios = document.getElementById('fichaListaPrecios')?.value || 'N/A';
  const personaResp = document.getElementById('fichaPersonaResponsable')?.value || 'N/A';
  const telEmergencia = document.getElementById('fichaTelEmergencia')?.value || 'N/A';
  const parentesco = document.getElementById('fichaParentesco')?.value || 'N/A';
  const personalAdmision = document.getElementById('fichaPersonalAdmision')?.value || 'N/A';
  const puesto = document.getElementById('fichaPuesto')?.value || 'N/A';
  const comentarios = getEditableFieldValue(document.getElementById('fichaComentarios')) || 'Sin comentarios';

  const alergiasCards = Array.from(document.querySelectorAll('#alergiasContainer .alergia-card'));
  let alergiasHTML = '';
  if (alergiasCards.length > 0) {
    alergiasHTML = `
      <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
        <thead>
          <tr style="background: #F1F5F9; text-align: left;">
            <th style="padding: 8px; border: 1px solid #CBD5E1;">Descripción</th>
            <th style="padding: 8px; border: 1px solid #CBD5E1;">Reacción</th>
            <th style="padding: 8px; border: 1px solid #CBD5E1;">Observaciones</th>
          </tr>
        </thead>
        <tbody>
          ${alergiasCards.map(c => `
            <tr>
              <td style="padding: 8px; border: 1px solid #CBD5E1;">${c.querySelector('.alergia-desc')?.value || 'N/A'}</td>
              <td style="padding: 8px; border: 1px solid #CBD5E1;">${c.querySelector('.alergia-reaccion')?.value || 'N/A'}</td>
              <td style="padding: 8px; border: 1px solid #CBD5E1;">${c.querySelector('.alergia-obs')?.value || 'N/A'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else {
    alergiasHTML = '<p style="color: #64748B; font-style: italic;">No se registraron alergias.</p>';
  }

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Ficha de Ingreso - ${patientName}</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 30px; color: #1E293B; line-height: 1.5; }
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #2563EB; padding-bottom: 15px; margin-bottom: 20px; }
        .title { font-size: 24px; font-weight: bold; color: #2563EB; }
        .subtitle { font-size: 14px; color: #64748B; }
        .section { margin-bottom: 20px; }
        .section-title { font-size: 16px; font-weight: bold; color: #1E293B; border-bottom: 1px solid #E2E8F0; padding-bottom: 5px; margin-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
        .item { font-size: 14px; }
        .label { font-weight: bold; color: #475569; font-size: 12px; text-transform: uppercase; }
        .value { color: #0F172A; font-size: 14px; margin-top: 2px; }
        @media print {
          body { padding: 0; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <div class="title">FICHA DE INGRESO</div>
          <div class="subtitle">${patientName} | ${exp}</div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 12px; color: #64748B;">Fecha de Impresión</div>
          <div style="font-weight: bold;">${new Date().toLocaleDateString('es-MX')}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Datos del Ingreso</div>
        <div class="grid">
          <div class="item"><div class="label">Fecha de Ingreso</div><div class="value">${fechaIngreso}</div></div>
          <div class="item"><div class="label">Seguros (lista de precios)</div><div class="value">${listaPrecios}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Persona Responsable & Contacto de Emergencia</div>
        <div class="grid">
          <div class="item"><div class="label">Persona Responsable</div><div class="value">${personaResp}</div></div>
          <div class="item"><div class="label">Teléfono de Emergencia</div><div class="value">${telEmergencia}</div></div>
          <div class="item"><div class="label">Parentesco</div><div class="value">${parentesco}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Personal de Admisión</div>
        <div class="grid">
          <div class="item"><div class="label">Personal de Admisión</div><div class="value">${personalAdmision}</div></div>
          <div class="item"><div class="label">Puesto</div><div class="value">${puesto}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Alergias</div>
        ${alergiasHTML}
      </div>

      <div class="section">
        <div class="section-title">Comentarios</div>
        <div class="value" style="background: #F8FAFC; padding: 12px; border-radius: 6px; border: 1px solid #E2E8F0;">${comentarios}</div>
      </div>
    </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
  }, 300);
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof updateDashboardMetrics === 'function') {
    updateDashboardMetrics();
  }

  const metricCitasHoyCard = document.getElementById('metricCitasHoyCard');
  if (metricCitasHoyCard) {
    metricCitasHoyCard.addEventListener('click', () => {
      if (typeof switchView === 'function') switchView('agenda');
      const statusPillBtns = document.querySelectorAll('#statusPillsFilter .status-pill-btn');
      statusPillBtns.forEach(btn => {
        if (btn.dataset.status === 'nuevo') {
          btn.click();
        }
      });
    });
  }

  const metricTotalPacientesCard = document.getElementById('metricTotalPacientesCard');
  if (metricTotalPacientesCard) {
    metricTotalPacientesCard.addEventListener('click', () => {
      if (typeof switchView === 'function') switchView('pacientes');
      const searchInput = document.getElementById('patientSearchInput');
      if (searchInput) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
      }
    });
  }

  const metricNuevosMesCard = document.getElementById('metricNuevosMesCard');
  if (metricNuevosMesCard) {
    metricNuevosMesCard.addEventListener('click', () => {
      if (typeof switchView === 'function') switchView('pacientes');
      const searchInput = document.getElementById('patientSearchInput');
      const currentMonthStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
      const newThisMonth = clivoraPatientsCache.filter(p => (p.createDate || '').slice(0, 7) === currentMonthStr);

      if (searchInput) {
        if (newThisMonth.length > 0) {
          searchInput.value = newThisMonth[0].name || '';
        } else {
          searchInput.value = '';
        }
        searchInput.dispatchEvent(new Event('input'));
      }
    });
  }
});

let dashboard7DaysChartInstance = null;

function renderCitas7DaysChart(citas, todayIso) {
  const canvas = document.getElementById('citasChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const todayDate = new Date(todayIso + 'T00:00:00');
  const daysData = [];
  const dayShortEs = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + i);
    const dIso = formatDateIso(d);
    const dayName = dayShortEs[d.getDay()];
    const count = citas.filter(c => c.fecha === dIso).length;

    daysData.push({
      dateIso: dIso,
      dateObj: d,
      label: `${dayName} ${d.getDate()}`,
      count: count
    });
  }

  const existingChart = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existingChart) {
    existingChart.destroy();
  }
  if (dashboard7DaysChartInstance) {
    try { dashboard7DaysChartInstance.destroy(); } catch (e) {}
    dashboard7DaysChartInstance = null;
  }

  const ctx = canvas.getContext('2d');
  try {
    dashboard7DaysChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: daysData.map(d => d.label),
      datasets: [{
        label: 'Citas',
        data: daysData.map(d => d.count),
        backgroundColor: '#2563eb',
        borderRadius: 4,
        hoverBackgroundColor: '#1d4ed8'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 10 } },
          grid: { color: 'rgba(0, 0, 0, 0.05)' }
        },
        x: {
          ticks: { font: { size: 10 } },
          grid: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.raw} citas (Clic para abrir en Agenda)`
          }
        }
      },
      onClick: (e, activeElements) => {
        if (activeElements && activeElements.length > 0) {
          const index = activeElements[0].index;
          const selectedDayObj = daysData[index];
          if (selectedDayObj) {
            if (typeof switchView === 'function') switchView('agenda');
            if (window.calendarState) {
              window.calendarState.currentDate = new Date(selectedDayObj.dateIso + 'T00:00:00');
              if (typeof window.updateCalendarView === 'function') {
                window.updateCalendarView();
              }
            }
          }
        }
      }
    }
  });
  } catch (err) {
    console.error('Error al inicializar la gráfica 7 días:', err);
  }
}

// Dona "Estado de citas hoy" — desglose de las citas de hoy por los 6
// estados posibles (nuevo/aprobado/rechazado/en_progreso/pendiente/
// finalizado), con los mismos colores que el resto de la app.
let dashboardEstadoHoyChartInstance = null;
function renderEstadoCitasHoyChart(citasHoy) {
  const canvas = document.getElementById('estadoCitasHoyChart');
  const totalEl = document.getElementById('estadoCitasHoyTotal');
  if (!canvas || typeof Chart === 'undefined') return;

  const counts = {
    nuevo: citasHoy.filter(c => (c.estado || 'nuevo').toLowerCase() === 'nuevo').length,
    aprobado: citasHoy.filter(c => (c.estado || '').toLowerCase() === 'aprobado').length,
    rechazado: citasHoy.filter(c => (c.estado || '').toLowerCase() === 'rechazado').length,
    en_progreso: citasHoy.filter(c => (c.estado || '').toLowerCase() === 'en_progreso').length,
    pendiente: citasHoy.filter(c => (c.estado || '').toLowerCase() === 'pendiente').length,
    desfasado: citasHoy.filter(c => (c.estado || '').toLowerCase() === 'desfasado').length,
    finalizado: citasHoy.filter(c => (c.estado || '').toLowerCase() === 'finalizado').length,
  };
  const total = counts.nuevo + counts.aprobado + counts.rechazado + counts.en_progreso + counts.pendiente + counts.desfasado + counts.finalizado;
  if (totalEl) totalEl.textContent = total;

  const existingChart = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existingChart) existingChart.destroy();
  if (dashboardEstadoHoyChartInstance) {
    try { dashboardEstadoHoyChartInstance.destroy(); } catch (e) {}
    dashboardEstadoHoyChartInstance = null;
  }

  const ctx = canvas.getContext('2d');
  try {
    dashboardEstadoHoyChartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Nuevas', 'Aprobadas', 'Rechazadas', 'En proceso', 'Pendientes', 'Desfasadas', 'Finalizadas'],
        datasets: [{
          data: [counts.nuevo, counts.aprobado, counts.rechazado, counts.en_progreso, counts.pendiente, counts.desfasado, counts.finalizado],
          backgroundColor: ['#2563EB', '#10B981', '#EF4444', '#8B5CF6', '#D97706', '#DB2777', '#475569'],
          borderWidth: 0,
          hoverOffset: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${ctx.raw}`,
            },
          },
        },
      },
    });
  } catch (err) {
    console.error('Error al inicializar la gráfica de estado de citas:', err);
  }
}

// ============================================================
// DASHBOARD DE INICIO — Métricas en Tiempo Real & Actividad
// ============================================================
// "En protocolo" y 3 de las 4 cajas de "Actividad clínica del mes" eran
// números fijos sin conectar a datos reales, y ninguna de las tarjetas de
// esta sección hacía nada al hacer clic. Esto trae los conteos reales y
// deja cada tarjeta lista para filtrar el listado de Pacientes.
async function loadDashboardPatientActivity() {
  let data;
  try {
    const response = await fetch('/clivora/api/dashboard/patient_activity', { cache: 'no-store' });
    data = response.ok ? await response.json() : null;
  } catch (error) {
    console.error('Error al cargar actividad clínica del mes:', error);
    data = null;
  }
  if (!data) return;

  const oncoIds = data.oncologyPatientIds || [];
  const vitalsIds = data.vitalsPatientIds || [];
  const nursingIds = data.nursingPatientIds || [];
  const protocolIds = data.protocolPatientIds || [];

  const oncoNum = document.getElementById('actividadClinicaNotasOncoNum');
  const vitalsNum = document.getElementById('actividadClinicaSignosNum');
  const nursingNum = document.getElementById('actividadClinicaNotasEnfNum');
  const protocoloValue = document.getElementById('metricProtocoloValue');
  if (oncoNum) oncoNum.textContent = oncoIds.length;
  if (vitalsNum) vitalsNum.textContent = vitalsIds.length;
  if (nursingNum) nursingNum.textContent = nursingIds.length;
  if (protocoloValue) protocoloValue.textContent = protocolIds.length;

  const wire = (elId, label, ids) => {
    const el = document.getElementById(elId);
    if (el) el.onclick = () => applyPacientesFilter(label, ids);
  };
  wire('actividadClinicaNotasOncoBox', 'Nota de oncología médica este mes', oncoIds);
  wire('actividadClinicaSignosBox', 'Signos vitales este mes', vitalsIds);
  wire('actividadClinicaNotasEnfBox', 'Nota de Enfermería este mes', nursingIds);
  wire('metricProtocoloCard', 'En protocolo', protocolIds);
}

// Sala (Tratamiento) y doctor (Consulta) se trataban como mutuamente
// excluyentes ("si hay sala, no se muestra el doctor") — pero un Tratamiento
// también tiene doctor asignado y antes quedaba oculto en las tarjetas de
// cita. Se muestran ambos datos cuando están presentes.
function citaCardSubtitle(c) {
  const parts = [];
  if (c.sala) parts.push(`${c.ubicacion} (${c.sala})`);
  if (c.doctor) parts.push(`Dr(a): ${c.doctor}`);
  return parts.join(' · ');
}

// Lista de citas del mes (tarjeta "Consultas este mes" del Dashboard) — a
// diferencia de las otras tarjetas de esta sección, esta muestra las citas
// directamente en vez de filtrar el listado de Pacientes. Paginada de a
// CITAS_MES_PAGE_SIZE igual que "Agenda de hoy" — con varias decenas de
// citas en el mes, listarlas todas de un tirón hacía crecer el modal sin
// control.
const CITAS_MES_PAGE_SIZE = 4;
let citasMesOrdenadas = [];
let citasMesPage = 0;

function renderCitasMesPage() {
  const body = document.getElementById('citasMesModalBody');
  const pagination = document.getElementById('citasMesPagination');
  const pageIndicator = document.getElementById('citasMesPageIndicator');
  const prevBtn = document.getElementById('citasMesPrevBtn');
  const nextBtn = document.getElementById('citasMesNextBtn');
  if (!body) return;

  if (citasMesOrdenadas.length === 0) {
    body.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0;">No hay citas registradas este mes.</p>';
    if (pagination) pagination.style.display = 'none';
    return;
  }

  const labelBySt = { aprobado: 'Aprobado', rechazado: 'Rechazado', pendiente: 'Pendiente', desfasado: 'Desfasado', nuevo: 'Nuevo', en_progreso: 'En progreso', finalizado: 'Finalizado' };
  const colorBySt = { aprobado: '#10b981', rechazado: '#ef4444', pendiente: '#f97316', desfasado: '#db2777', nuevo: '#2563eb', en_progreso: '#8b5cf6', finalizado: '#64748b' };

  const totalPages = Math.max(1, Math.ceil(citasMesOrdenadas.length / CITAS_MES_PAGE_SIZE));
  if (citasMesPage >= totalPages) citasMesPage = totalPages - 1;
  if (citasMesPage < 0) citasMesPage = 0;
  const pageStart = citasMesPage * CITAS_MES_PAGE_SIZE;
  const pageItems = citasMesOrdenadas.slice(pageStart, pageStart + CITAS_MES_PAGE_SIZE);

  if (pagination) {
    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    if (pageIndicator) pageIndicator.textContent = `${citasMesPage + 1} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = citasMesPage === 0;
    if (nextBtn) nextBtn.disabled = citasMesPage >= totalPages - 1;
  }

  body.innerHTML = pageItems.map((c, idx) => {
    const st = (c.estado || 'nuevo').toLowerCase();
    const color = colorBySt[st] || '#2563eb';
    const label = labelBySt[st] || 'Nuevo';
    const sub = citaCardSubtitle(c);
    return `
      <div class="cita-mes-item" data-id="${c.id}" style="background: var(--bg-card); border-left: 4px solid ${color}; padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; cursor: pointer; animation-delay: ${idx * 40}ms;">
        <div>
          <div style="font-weight: 700; font-size: 13px; color: var(--text-main);">${citaDisplayName(c)}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${sub}</div>
        </div>
        <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
          <span class="badge badge-${st}">${label}</span>
          <span style="font-size: 11px; font-weight: 700; color: ${color};">${formatDateDMY ? formatDateDMY(c.fecha) : c.fecha} · ${c.hora || '08:00'}</span>
        </div>
      </div>`;
  }).join('');

  body.querySelectorAll('.cita-mes-item').forEach(item => {
    item.onclick = () => {
      const cita = citasMesOrdenadas.find(c => String(c.id) === item.dataset.id);
      document.getElementById('citasMesModal')?.classList.remove('open');
      if (typeof switchView === 'function') switchView('agenda');
      if (cita && typeof window.openCitaModal === 'function') window.openCitaModal(cita);
    };
  });
}

function openCitasMesModal(citasDelMes) {
  const modal = document.getElementById('citasMesModal');
  const subtitle = document.getElementById('citasMesModalSubtitle');
  if (!modal) return;

  citasMesOrdenadas = [...(citasDelMes || [])].sort((a, b) => {
    const da = `${a.fecha || ''} ${a.hora || ''}`;
    const db = `${b.fecha || ''} ${b.hora || ''}`;
    return da.localeCompare(db);
  });
  citasMesPage = 0;

  if (subtitle) subtitle.textContent = `${citasMesOrdenadas.length} cita(s)`;

  renderCitasMesPage();
  modal.classList.add('open');
}

document.addEventListener('DOMContentLoaded', () => {
  const prevBtn = document.getElementById('citasMesPrevBtn');
  const nextBtn = document.getElementById('citasMesNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => { citasMesPage -= 1; renderCitasMesPage(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { citasMesPage += 1; renderCitasMesPage(); });
});

document.addEventListener('click', (event) => {
  if (event.target.closest('#closeCitasMesModal')) {
    document.getElementById('citasMesModal')?.classList.remove('open');
  }
  if (event.target.id === 'citasMesModal') {
    event.target.classList.remove('open');
  }
});

// Tarjetas de métricas del dashboard (Citas Hoy/Confirmadas/Pendientes/
// Canceladas) funcionan como filtro de la lista "Agenda de hoy" — antes eran
// solo números sin acción, cada tarjeta ahora filtra la lista de abajo por
// el estado correspondiente ('todas' = sin filtrar).
let dashboardAgendaFilter = 'todas';

// "Agenda de hoy" mostraba TODAS las citas del día apiladas — con muchas
// citas la tarjeta crecía sin límite. Se pagina de a AGENDA_HOY_PAGE_SIZE,
// con flechas prev/next que reciclan la misma tarjeta en vez de seguir
// creciendo verticalmente; dashboardAgendaPage se resetea a 0 cada vez que
// cambia el filtro o llegan datos nuevos para no quedar apuntando a una
// página que ya no existe.
const AGENDA_HOY_PAGE_SIZE = 4;
let dashboardAgendaPage = 0;

function renderAgendaHoyList() {
  const agendaHoyBody = document.getElementById('agendaHoyBody');
  const agendaHoyBadge = document.getElementById('agendaHoyCountBadge');
  const pagination = document.getElementById('agendaHoyPagination');
  const pageIndicator = document.getElementById('agendaHoyPageIndicator');
  const prevBtn = document.getElementById('agendaHoyPrevBtn');
  const nextBtn = document.getElementById('agendaHoyNextBtn');
  if (!agendaHoyBody) return;

  const todayIso = formatDateIso(new Date());
  const citasHoy = clivoraCitasCache.filter(c => c.fecha === todayIso);
  const filtered = dashboardAgendaFilter === 'todas'
    ? citasHoy
    : citasHoy.filter(c => (c.estado || '').toLowerCase() === dashboardAgendaFilter);
  const ordered = [...filtered].sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

  if (agendaHoyBadge) agendaHoyBadge.textContent = ordered.length;

  agendaHoyBody.innerHTML = '';
  if (ordered.length === 0) {
    const emptyLabelByFilter = {
      todas: 'No hay citas para hoy',
      aprobado: 'No hay citas confirmadas hoy',
      pendiente: 'No hay citas pendientes hoy',
      en_progreso: 'No hay citas en progreso hoy',
      rechazado: 'No hay citas canceladas hoy',
    };
    agendaHoyBody.innerHTML = `<span style="color:var(--text-subtle); text-align: center; margin: auto; padding: 20px;">${emptyLabelByFilter[dashboardAgendaFilter] || 'No hay citas para hoy'}</span>`;
    if (pagination) pagination.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(ordered.length / AGENDA_HOY_PAGE_SIZE));
  if (dashboardAgendaPage >= totalPages) dashboardAgendaPage = totalPages - 1;
  if (dashboardAgendaPage < 0) dashboardAgendaPage = 0;
  const pageStart = dashboardAgendaPage * AGENDA_HOY_PAGE_SIZE;
  const pageItems = ordered.slice(pageStart, pageStart + AGENDA_HOY_PAGE_SIZE);

  if (pagination) {
    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    if (pageIndicator) pageIndicator.textContent = `${dashboardAgendaPage + 1} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = dashboardAgendaPage === 0;
    if (nextBtn) nextBtn.disabled = dashboardAgendaPage >= totalPages - 1;
  }

  const borderBySt = { aprobado: '#10b981', rechazado: '#ef4444', pendiente: '#f97316', desfasado: '#db2777', nuevo: '#2563eb', en_progreso: '#8b5cf6', finalizado: '#64748b' };
  const labelBySt = { aprobado: 'Aprobado', rechazado: 'Rechazado', pendiente: 'Pendiente', desfasado: 'Desfasado', nuevo: 'Nuevo', en_progreso: 'En progreso', finalizado: 'Finalizado' };
  pageItems.forEach((c, idx) => {
    const st = (c.estado || 'nuevo').toLowerCase();
    const color = borderBySt[st] || '#2563eb';
    const label = labelBySt[st] || 'Nuevo';
    const item = document.createElement('div');
    item.className = 'agenda-hoy-item';
    // La transition se quitó del inline-style y se movió a la clase CSS
    // .agenda-hoy-item para que no interfiera con la animation del selector
    // #agendaHoyBody > * (ver comentario en styles.css). Se define la
    // animation completa inline para garantizar el stagger escalonado.
    item.style.cssText = `background: var(--bg-card); border-left: 4px solid ${color}; padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; cursor: pointer; animation: agendaHoySlideIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) ${idx * 80}ms both;`;
    // animation-fill-mode "both" deja el transform de la animación de entrada
    // "sosteniéndose" para siempre sobre el elemento (así nunca se quita el
    // efecto de entrada si el usuario navega rápido). El problema es que ese
    // transform sostenido por la animation gana sobre el transform que
    // dispara la transition de :hover, así que la tarjeta nunca se veía
    // "saltar". En cuanto termina la animación (animationend) se apaga por
    // completo (animation: none inline, con mayor prioridad que la regla
    // #agendaHoyBody > * del CSS) para devolver el control del transform a
    // la transition normal y que el hover funcione igual que en los botones.
    item.addEventListener('animationend', () => { item.style.animation = 'none'; }, { once: true });
    const tooltip = citaCreadoTooltip(c);
    if (tooltip) item.title = tooltip;
    const sub = citaCardSubtitle(c);
    item.innerHTML = `
      <div>
        <div style="font-weight: 700; font-size: 13px; color: var(--text-main);">${citaDisplayName(c)}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${sub}</div>
      </div>
      <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
        <span class="badge badge-${st}">${label}</span>
        <span style="font-size: 11px; font-weight: 700; color: ${color};">${c.hora || '08:00'}</span>
      </div>
    `;
    item.onclick = () => {
      if (typeof switchView === 'function') switchView('agenda');
      if (typeof window.openCitaModal === 'function') window.openCitaModal(c);
    };
    agendaHoyBody.appendChild(item);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const prevBtn = document.getElementById('agendaHoyPrevBtn');
  const nextBtn = document.getElementById('agendaHoyNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => { dashboardAgendaPage -= 1; renderAgendaHoyList(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { dashboardAgendaPage += 1; renderAgendaHoyList(); });
});

document.addEventListener('click', (event) => {
  const filterCard = event.target.closest('.metric-card-filter');
  if (!filterCard) return;
  dashboardAgendaFilter = filterCard.dataset.filter || 'todas';
  dashboardAgendaPage = 0;
  document.querySelectorAll('.metric-card-filter').forEach(c => c.classList.remove('metric-card-active'));
  filterCard.classList.add('metric-card-active');
  renderAgendaHoyList();
});

function updateDashboardMetrics() {
  loadDashboardPatientActivity();
  const citas = clivoraCitasCache;

  const now = new Date();
  const todayIso = formatDateIso(now);
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

  // 1. CITAS DE HOY
  const citasHoy = citas.filter(c => c.fecha === todayIso);
  const citasHoyCount = citasHoy.length;

  const citasNuevasHoy = citasHoy.filter(c => (c.estado || 'nuevo').toLowerCase() === 'nuevo').length;
  const citasAprobadasHoy = citasHoy.filter(c => (c.estado || '').toLowerCase() === 'aprobado').length;
  const citasPendientesHoy = citasHoy.filter(c => (c.estado || '').toLowerCase() === 'pendiente').length;
  // En progreso: ya hicieron check-in y aún no check-out.
  const citasEnProgresoHoy = citasHoy.filter(c => (c.estado || '').toLowerCase() === 'en_progreso').length;
  // "Canceladas" reutiliza el estado "rechazado" — no existe un estado
  // dedicado "cancelado" en el modelo, y rechazado es el más cercano
  // conceptualmente (la cita no se llevó a cabo).
  const citasCanceladasHoy = citasHoy.filter(c => (c.estado || '').toLowerCase() === 'rechazado').length;

  const metricCitasHoyValue = document.getElementById('metricCitasHoyValue');
  const metricCitasHoyPill = document.getElementById('metricCitasHoyPill');
  const metricConfirmadasValue = document.getElementById('metricConfirmadasValue');
  const metricConfirmadasPill = document.getElementById('metricConfirmadasPill');
  const metricPendientesValue = document.getElementById('metricPendientesValue');
  const metricCanceladasValue = document.getElementById('metricCanceladasValue');
  const metricEnProgresoValue = document.getElementById('metricEnProgresoValue');

  if (metricCitasHoyValue) metricCitasHoyValue.textContent = citasHoyCount;
  if (metricCitasHoyPill) metricCitasHoyPill.textContent = `${citasNuevasHoy} nuevas`;
  if (metricConfirmadasValue) metricConfirmadasValue.textContent = citasAprobadasHoy;
  if (metricConfirmadasPill) metricConfirmadasPill.textContent = `de ${citasHoyCount} programadas`;
  if (metricPendientesValue) metricPendientesValue.textContent = citasPendientesHoy;
  if (metricCanceladasValue) metricCanceladasValue.textContent = citasCanceladasHoy;
  if (metricEnProgresoValue) metricEnProgresoValue.textContent = citasEnProgresoHoy;

  renderEstadoCitasHoyChart(citasHoy);
  renderAgendaHoyList();

  // 2. CITAS 7 DÍAS
  const todayStart = new Date(todayIso + 'T00:00:00');
  const next7DaysEnd = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const citas7Days = citas.filter(c => {
    if (!c.fecha) return false;
    const cDate = new Date(c.fecha + 'T00:00:00');
    return cDate >= todayStart && cDate <= next7DaysEnd;
  });

  const citas7DaysBadge = document.getElementById('citas7DaysBadge');
  if (citas7DaysBadge) citas7DaysBadge.textContent = citas7Days.length;

  renderCitas7DaysChart(citas, todayIso);

  // 3. PACIENTES STATS REALES
  const allPatientsList = clivoraPatientsCache;
  const totalPacientesCount = allPatientsList.length;

  const nuevosMesActual = allPatientsList.filter(p => (p.createDate || '').slice(0, 7) === currentMonthStr).length;
  const nuevosMesAnterior = allPatientsList.filter(p => (p.createDate || '').slice(0, 7) === prevMonthStr).length;

  const diffNuevos = nuevosMesActual - nuevosMesAnterior;
  const pctVar = nuevosMesAnterior > 0 ? Math.round(((nuevosMesActual - nuevosMesAnterior) / nuevosMesAnterior) * 100) : 0;
  const varSymbol = diffNuevos >= 0 ? '↗ +' : '↘ ';
  const varClass = diffNuevos >= 0 ? 'green' : 'red';

  const metricTotalPacientesValue = document.getElementById('metricTotalPacientesValue');
  const metricTotalPacientesPill = document.getElementById('metricTotalPacientesPill');
  const metricNuevosMesValue = document.getElementById('metricNuevosMesValue');
  const metricNuevosMesPill = document.getElementById('metricNuevosMesPill');
  const metricConsultasMesValue = document.getElementById('metricConsultasMesValue');
  const actividadClinicaCitasNum = document.getElementById('actividadClinicaCitasNum');

  if (metricTotalPacientesValue) metricTotalPacientesValue.textContent = totalPacientesCount;
  if (metricTotalPacientesPill) metricTotalPacientesPill.textContent = `↗ +${nuevosMesActual} este mes`;
  if (metricNuevosMesValue) metricNuevosMesValue.textContent = nuevosMesActual;
  if (metricNuevosMesPill) {
    metricNuevosMesPill.className = `metric-pill ${varClass}`;
    metricNuevosMesPill.textContent = `${varSymbol}${diffNuevos} (${pctVar}%) vs mes ant.`;
  }

  const citasMesActual = citas.filter(c => c.fecha && c.fecha.startsWith(currentMonthStr));
  const citasMesActualCount = citasMesActual.length;
  const pacienteIdsConCitaMes = [...new Set(citasMesActual.map(c => c.pacienteId).filter(Boolean))];
  if (metricConsultasMesValue) metricConsultasMesValue.textContent = citasMesActualCount;
  if (actividadClinicaCitasNum) actividadClinicaCitasNum.textContent = citasMesActualCount;
  const metricConsultasMesCard = document.getElementById('metricConsultasMesCard');
  const actividadClinicaCitasBox = document.getElementById('actividadClinicaCitasBox');
  if (metricConsultasMesCard) metricConsultasMesCard.onclick = () => openCitasMesModal(citasMesActual);
  if (actividadClinicaCitasBox) actividadClinicaCitasBox.onclick = () => applyPacientesFilter('Citas este mes', pacienteIdsConCitaMes);

  // 4. ACTIVIDAD RECIENTE
  const actividadRecienteList = document.getElementById('actividadRecienteList');
  if (actividadRecienteList) {
    actividadRecienteList.innerHTML = '';
    const activities = [];

    citas.forEach(c => {
      const st = (c.estado || 'nuevo').toLowerCase();
      let title = 'Cita registrada';
      let iconColor = 'blue';
      if (st === 'aprobado') { title = 'Cita aprobada'; iconColor = 'green'; }
      else if (st === 'rechazado') { title = 'Cita rechazada'; iconColor = 'red'; }
      else if (st === 'pendiente') { title = 'Cita en espera de aprobación'; iconColor = 'orange'; }
      else if (st === 'desfasado') { title = 'Cita desfasada'; iconColor = 'pink'; }
      else if (st === 'en_progreso') { title = 'Cita en progreso (check-in)'; iconColor = 'purple'; }
      else if (st === 'finalizado') { title = 'Cita finalizada (check-out)'; iconColor = 'gray'; }

      activities.push({
        title: title,
        sub: `${citaDisplayName(c)} · ${c.fecha || todayIso} ${c.hora || ''}`,
        time: c.fecha === todayIso ? 'Hoy' : c.fecha,
        iconColor: iconColor,
        rawTime: c.id || Date.now()
      });
    });

    allPatientsList.forEach(p => {
      const createDateOnly = (p.createDate || '').slice(0, 10);
      activities.push({
        title: 'Paciente nuevo registrado',
        sub: `${p.name} · #${p.exp}`,
        time: createDateOnly === todayIso ? 'Hoy' : (createDateOnly || 'Reciente'),
        iconColor: 'blue',
        rawTime: p.createDate ? new Date(p.createDate).getTime() : 0
      });
    });

    activities.sort((a, b) => b.rawTime - a.rawTime);
    const recent5 = activities.slice(0, 5);

    if (recent5.length === 0) {
      actividadRecienteList.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">Sin actividad reciente</div>`;
    } else {
      recent5.forEach(act => {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        item.innerHTML = `
          <div class="timeline-left">
            <div class="timeline-icon ${act.iconColor}">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div class="timeline-details">
              <span class="timeline-title">${act.title}</span>
              <span class="timeline-sub">${act.sub}</span>
            </div>
          </div>
          <span class="timeline-time">${act.time}</span>
        `;
        actividadRecienteList.appendChild(item);
      });
    }
  }
}

// ============================================================
// TRATAMIENTOS — lista (reutiliza la misma cita de Agenda) + wizard de
// productos/cotización. La vista tratamientosView/addTratamientoModal ya existía como
// maqueta estática (tabla comentada, datos de relleno, sin ningún fetch).
// ============================================================
let clivoraTratamientos = [];
let clivoraTratOrderProducts = [];
let clivoraTratOrderCart = [];
let clivoraTratOrderCurrentTratId = null;
// Set solo cuando el wizard "Nueva Venta"/"Modificar Tratamiento" se abre
// directo desde la pestaña Ventas del expediente (sin cita de por medio) —
// ver openNuevaVentaPacienteModal. Mutuamente excluyente con
// clivoraTratOrderCurrentTratId: cuando este tiene valor, ese debe ser null.
let clivoraTratOrderPatientId = null;
let clivoraTratOrderQuotations = [];

async function loadTratamientos() {
  try {
    const response = await fetch('/clivora/api/tratamientos', { cache: 'no-store' });
    clivoraTratamientos = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar tratamientos:', error);
    clivoraTratamientos = [];
  }
  updateTratamientosFilterOptions();
  applyTratVistaMode(clivoraTratVistaMode);
  renderTratamientosTable();
}

// Mismo criterio que updateFileTypeFilterOptions/updateConsultaTypeFilterOptions:
// solo se listan las salas/doctores que sí aparecen en los tratamientos
// cargados, no un catálogo fijo con opciones que nunca van a traer resultados.
//
// Sala además se acota a la Ubicación elegida (si hay una) — antes listaba
// las salas de TODOS los tratamientos sin importar la ubicación filtrada,
// así que en "Penthouse 2" aparecían salas que en realidad son de otro
// penthouse y que ese filtro nunca iba a encontrar ahí. Se vuelve a llamar
// cada vez que cambia Ubicación (ver el listener de 'change' más abajo),
// no solo al cargar la tabla una vez.
// El catálogo de lugares puede llegar después de pintar la tabla.
document.addEventListener('clivora:lugares', () => {
  if (typeof clivoraTratamientos !== 'undefined' && document.getElementById('tratamientosUbicacionFilter')) {
    updateTratamientosFilterOptions();
  }
});

function updateTratamientosFilterOptions() {
  const ubicacionSelect = document.getElementById('tratamientosUbicacionFilter');
  if (ubicacionSelect) {
    const current = ubicacionSelect.value;
    const nombres = Array.from(new Set([...CLIVORA_LUGARES.map(l => l.name), ...clivoraTratamientos.map(t => t.ubicacion)].filter(Boolean))).sort();
    ubicacionSelect.innerHTML = ['<option value="">Todas las ubicaciones</option>']
      .concat(nombres.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)).join('');
    ubicacionSelect.value = nombres.includes(current) ? current : '';
  }
  const salaSelect = document.getElementById('tratamientosSalaFilter');
  const doctorSelect = document.getElementById('tratamientosDoctorFilter');
  const ubicacionFilter = document.getElementById('tratamientosUbicacionFilter')?.value || '';

  if (salaSelect) {
    const currentValue = salaSelect.value;
    const tratamientosEnUbicacion = ubicacionFilter
      ? clivoraTratamientos.filter(t => t.ubicacion === ubicacionFilter)
      : clivoraTratamientos;
    const salas = Array.from(new Set(tratamientosEnUbicacion.map(t => t.sala).filter(Boolean))).sort();
    salaSelect.innerHTML = ['<option value="">Todas las salas</option>']
      .concat(salas.map(s => `<option value="${s}">${s}</option>`))
      .join('');
    salaSelect.value = salas.includes(currentValue) ? currentValue : '';
  }

  if (doctorSelect) {
    const currentValue = doctorSelect.value;
    const doctores = Array.from(new Set(clivoraTratamientos.map(t => t.doctor).filter(Boolean))).sort();
    doctorSelect.innerHTML = ['<option value="">Todos los doctores</option>']
      .concat(doctores.map(d => `<option value="${d}">${d}</option>`))
      .join('');
    doctorSelect.value = doctores.includes(currentValue) ? currentValue : '';
  }
}

function formatTratFechaHora(value) {
  if (!value) return '';
  const [datePart, timePart] = value.split(/[T ]/);
  const [y, m, d] = (datePart || '').split('-');
  return d && m && y ? `${d}/${m}/${y}${timePart ? ' ' + timePart.slice(0, 5) : ''}` : value;
}

function tratEstadoBadgeHtml(estado) {
  const map = {
    nuevo: ['badge-nuevo', 'NUEVO'],
    aprobado: ['badge-aprobado', 'APROBADO'],
    rechazado: ['badge-rechazado', 'RECHAZADO'],
    pendiente: ['badge-pendiente', 'PENDIENTE'],
    desfasado: ['badge-desfasado', 'DESFASADO'],
    en_progreso: ['badge-en_progreso', 'EN PROGRESO'],
    finalizado: ['badge-finalizado', 'FINALIZADO'],
  };
  const [cls, label] = map[estado] || map.pendiente;
  return `<span class="badge ${cls}">${label}</span>`;
}

const TRAT_VISTA_STORAGE_KEY = 'clivoraTratVistaMode';
let clivoraTratVistaMode = localStorage.getItem(TRAT_VISTA_STORAGE_KEY) === 'kanban' ? 'kanban' : 'lista';

// Sincroniza botones activos + visibilidad de los contenedores lista/kanban
// con clivoraTratVistaMode, y lo persiste — sin esto, cada vez que se
// recargaba la página (o se volvía a entrar a Tratamientos) la vista
// volvía a "Lista" aunque el usuario hubiera dejado Kanban seleccionado.
function applyTratVistaMode(mode) {
  clivoraTratVistaMode = mode;
  localStorage.setItem(TRAT_VISTA_STORAGE_KEY, mode);
  document.getElementById('btnTratamientosVistaLista')?.classList.toggle('active', mode === 'lista');
  document.getElementById('btnTratamientosVistaKanban')?.classList.toggle('active', mode === 'kanban');
  const listView = document.getElementById('tratamientosListView');
  const kanbanView = document.getElementById('tratamientosKanbanView');
  if (listView) listView.style.display = mode === 'kanban' ? 'none' : '';
  if (kanbanView) kanbanView.style.display = mode === 'kanban' ? 'flex' : 'none';
}

// Las columnas siguen el ciclo de la cita (Cita.TRANSICIONES en
// apps/agenda/models.py): pendiente -> aprobado -> en_progreso (check-in)
// -> finalizado (check-out); desfasado y rechazado son desvíos y van al
// final. "nuevo" se funde con "pendiente" (mismo significado: aún sin
// aprobar; toda cita de Clivora nace pendiente). Mismo orden y nombres que
// los chips de Estado del filtro.
const TRAT_KANBAN_STAGES = [
  { key: 'pendiente', label: 'Pendiente' },
  { key: 'aprobado', label: 'Aprobado' },
  { key: 'en_progreso', label: 'En progreso' },
  { key: 'finalizado', label: 'Finalizado' },
  { key: 'desfasado', label: 'Desfasado' },
  { key: 'rechazado', label: 'Rechazado' },
];

function getTratamientoStage(t) {
  const estado = t.estado || 'pendiente';
  if (estado === 'aprobado') return 'aprobado';
  if (estado === 'rechazado') return 'rechazado';
  if (estado === 'desfasado') return 'desfasado';
  if (estado === 'en_progreso') return 'en_progreso';
  if (estado === 'finalizado') return 'finalizado';
  return 'pendiente';
}

function renderTratamientosTable() {
  const countLabel = document.getElementById('tratamientosCountLabel');

  const searchTerm = (document.getElementById('tratamientosSearchInput')?.value || '').toLowerCase().trim();
  const fechaFilter = document.getElementById('tratamientosFechaInput')?.value || '';
  const ubicacionFilter = document.getElementById('tratamientosUbicacionFilter')?.value || '';
  const salaFilter = document.getElementById('tratamientosSalaFilter')?.value || '';
  const doctorFilter = document.getElementById('tratamientosDoctorFilter')?.value || '';
  const estadosOn = Array.from(document.querySelectorAll('.trat-filter-estado:checked')).map(el => el.value);
  const checkinFilter = document.querySelector('.trat-filter-checkin:checked')?.value || '';

  // Todos los filtros menos Estado: de aquí salen los conteos de cada chip,
  // para que digan cuántos hay en ese estado con los demás filtros puestos.
  const sinFiltroEstado = clivoraTratamientos.filter(t => {
    if (searchTerm) {
      const haystack = [t.paciente, t.doctor, t.motivo, t.sala, t.ubicacion, t.validadoPor, t.saleOrderName]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    if (fechaFilter && !(t.fechaInicio || '').startsWith(fechaFilter)) return false;
    if (ubicacionFilter && t.ubicacion !== ubicacionFilter) return false;
    if (salaFilter && t.sala !== salaFilter) return false;
    if (doctorFilter && t.doctor !== doctorFilter) return false;
    if (checkinFilter && checkinFilter !== (t.checkIn ? 'con' : 'sin')) return false;
    return true;
  });
  const porEstado = {};
  sinFiltroEstado.forEach(t => {
    const stage = getTratamientoStage(t);
    porEstado[stage] = (porEstado[stage] || 0) + 1;
  });
  document.querySelectorAll('[data-estado-count]').forEach(el => {
    el.textContent = String(porEstado[el.dataset.estadoCount] || 0);
  });
  // Sin ningún chip marcado no se filtra por estado (se ven todos).
  const filtered = estadosOn.length
    ? sinFiltroEstado.filter(t => estadosOn.includes(getTratamientoStage(t)))
    : sinFiltroEstado;

  if (countLabel) countLabel.textContent = String(filtered.length);

  if (clivoraTratVistaMode === 'kanban') {
    renderTratamientosKanban(filtered);
  } else {
    renderTratamientosListRows(filtered);
  }
}

function renderTratamientosListRows(filtered) {
  const tbody = document.getElementById('tratamientosTableBody');
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 24px; color: var(--text-muted);">No hay tratamientos que coincidan con los filtros.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const badges = [tratEstadoBadgeHtml(t.estado)];
    badges.push(t.checkIn
      ? '<span class="badge badge-checkin">CHECK-IN</span>'
      : '<span class="badge badge-nocheckin">SIN CHECK-IN</span>');
    if (t.medicamentoPreparado) badges.push('<span class="badge badge-preparado">PREPARADO</span>');
    // Aplicación de medicamento (ver _get_aplicacion en el controlador):
    // manual (Solicitado / Preparación / Listo) o desde traslados (En
    // proceso / Aplicado).
    const aplicacionBadges = {
      solicitado: '<span class="badge badge-aplicacion-solicitado">SOLICITADO</span>',
      preparacion: '<span class="badge badge-aplicacion-preparacion">PREPARACIÓN</span>',
      listo: '<span class="badge badge-aplicacion-listo">LISTO</span>',
      en_proceso: '<span class="badge badge-aplicacion-en-proceso">EN PROCESO</span>',
      aplicado: '<span class="badge badge-aplicacion-aplicado">APLICADO</span>',
    };
    if (aplicacionBadges[t.aplicacionEstado]) badges.push(aplicacionBadges[t.aplicacionEstado]);
    if (t.stockAplicacion) badges.push('<span class="badge badge-stock">STOCK</span>');

    const actions = [
      `<div class="folder-icon" data-trat-id="${t.id}" title="Ver / confirmar cita"></div>`,
      `<div class="eye-icon" data-trat-id="${t.id}" title="Agregar productos a la orden"></div>`,
    ];

    const ventaCell = t.saleOrderId
      ? `<span class="venta-link" data-order-id="${t.saleOrderId}" title="Ver venta" style="color: var(--primary-blue); cursor: pointer; font-weight: 600;">${t.saleOrderName || ''}</span>`
      : `<span style="color: var(--text-muted);">Sin venta</span>`;

    return `
      <tr>
        <td class="td-id">${t.id}</td>
        <td class="td-paciente">${t.paciente || ''}</td>
        <td class="td-doctor">${t.doctor || ''}</td>
        <td>${formatTratFechaHora(t.fechaInicio)}</td>
        <td>${formatTratFechaHora(t.fechaFin)}</td>
        <td>${t.sala || ''}</td>
        <td>${t.motivo || ''}</td>
        <td><div class="td-esquema" data-trat-id="${t.id}">${escapeHtml(t.esquema || '')}</div></td>
        <td>${t.validadoPor || ''}</td>
        <td><div class="status-stack">${badges.join('')}</div></td>
        <td class="${t.saleOrderId ? '' : 'trat-sin-venta'}">${ventaCell}</td>
        <td class="td-actions"><div style="display: flex; gap: 8px; justify-content: flex-end;">${actions.join('')}</div></td>
      </tr>
    `;
  }).join('');
}

function renderTratamientosKanban(filtered) {
  const wrapper = document.getElementById('tratamientosKanbanView');
  if (!wrapper) return;

  const byStage = {};
  TRAT_KANBAN_STAGES.forEach(stage => { byStage[stage.key] = []; });
  filtered.forEach(t => { byStage[getTratamientoStage(t)].push(t); });

  wrapper.innerHTML = TRAT_KANBAN_STAGES.map(stage => {
    const items = byStage[stage.key];
    const cards = items.length
      ? items.map(t => {
        const meta = [formatTratFechaHora(t.fechaInicio), t.sala].filter(Boolean).join(' · ');
        return `
          <div class="trat-kanban-card" data-trat-id="${t.id}" title="Ver / confirmar cita">
            <div class="trat-kanban-card-paciente">${t.paciente || ''}</div>
            <div class="trat-kanban-card-doctor">${t.doctor || ''}</div>
            <div class="trat-kanban-card-meta">${meta}</div>
            <div class="trat-kanban-card-footer">
              ${tratEstadoBadgeHtml(t.estado)}
              ${t.saleOrderId ? `<span class="venta-link" data-order-id="${t.saleOrderId}" title="Ver venta" style="color: var(--primary-blue); font-weight: 600; font-size: 11px;">${t.saleOrderName || ''}</span>` : ''}
            </div>
          </div>
        `;
      }).join('')
      : '<div class="trat-kanban-empty">Sin tratamientos en esta etapa.</div>';

    return `
      <div class="trat-kanban-column">
        <div class="trat-kanban-column-header">
          <span class="trat-kanban-column-title">${stage.label}</span>
          <span class="trat-kanban-column-count">${items.length}</span>
        </div>
        <div class="trat-kanban-column-body">${cards}</div>
      </div>
    `;
  }).join('');
}

// Antes descargaba la lista COMPLETA de citas (/api/citas, cientos de KB)
// solo para buscar una — en celular con datos móviles tardaba varios
// segundos sin ninguna señal y parecía que el botón no hacía nada. Ahora
// pide solo esa cita (mismo serializador que la lista), marca el botón
// como "cargando" mientras tanto, ignora toques repetidos y avisa si falla.
let clivoraTratCitaLoadingId = null;
async function openTratamientoCitaModal(tratId, triggerEl) {
  if (clivoraTratCitaLoadingId === tratId) return;
  clivoraTratCitaLoadingId = tratId;
  if (triggerEl) triggerEl.classList.add('is-loading');
  try {
    const response = await fetch(`/clivora/api/citas/${tratId}`, { cache: 'no-store' });
    const cita = response.ok ? await response.json() : null;
    if (cita && cita.id && typeof window.openCitaModal === 'function') {
      window.openCitaModal(cita);
    } else {
      showClivoraAlertModal('No se pudo abrir la cita de este tratamiento. Actualiza la página e intenta de nuevo.');
    }
  } catch (error) {
    console.error('Error al abrir la cita del tratamiento:', error);
    showClivoraAlertModal('No se pudo abrir la cita. Revisa tu conexión e intenta de nuevo.');
  } finally {
    clivoraTratCitaLoadingId = null;
    if (triggerEl) triggerEl.classList.remove('is-loading');
  }
}

// ── Wizard "Modificar Tratamiento": productos + carrito + cotización ──

async function openTratamientoOrderModal(tratId, fallbackTrat) {
  // Este wizard es 100% de escritura (agregar/quitar productos y guardar la
  // orden) — para el rol Doctor en modo solo lectura no tiene sentido
  // abrirlo ni con sus campos deshabilitados, se bloquea de raíz. Ver
  // isDoctorReadOnly en /api/me.
  if (window.clivoraCurrentUser?.isDoctorReadOnly) {
    showClivoraAlertModal('No tienes permisos para modificar tratamientos.');
    return;
  }
  // clivoraTratamientos solo incluye citas de tipo Tratamiento — una Consulta
  // (para la que la venta también se puede crear, el backend no distingue
  // tipo) nunca aparece ahí, así que se usa fallbackTrat con los mismos
  // datos tomados directo del formulario de la cita (ver citaVentaCreateBtn).
  const trat = clivoraTratamientos.find(t => t.id === tratId) || fallbackTrat;
  const modal = document.getElementById('tratamientoOrderModal');
  if (!modal) return;
  if (!trat) {
    showClivoraAlertModal('No se pudo abrir el asistente de venta para esta cita. Actualiza la página e intenta de nuevo.');
    return;
  }

  clivoraTratOrderCurrentTratId = tratId;
  clivoraTratOrderPatientId = null;
  clivoraTratOrderCart = [];

  const modalTitle = document.getElementById('tratOrderModalTitle');
  if (modalTitle) modalTitle.textContent = 'Modificar Tratamiento';
  const nameField = document.getElementById('tratOrderNameField');
  if (nameField) nameField.style.display = '';
  const nameLabel = document.getElementById('tratOrderNameLabel');
  if (nameLabel) nameLabel.textContent = 'Nombre del tratamiento';

  const subtitle = document.getElementById('tratOrderSubtitle');
  if (subtitle) {
    const timeOnly = (v) => (v || '').split(/[T ]/)[1] || '';
    const timeRange = [timeOnly(trat.fechaInicio), timeOnly(trat.fechaFin)].filter(Boolean);
    const parts = [trat.paciente || ''];
    if (trat.sala) parts.push(trat.sala);
    if (timeRange.length) parts.push(timeRange.join(' – '));
    subtitle.textContent = parts.join('   ');
  }

  const nameInput = document.getElementById('tratOrderName');
  if (nameInput) nameInput.value = trat.treatmentName || `APT/${trat.id}`;

  const quotationSelect = document.getElementById('tratOrderQuotationSearch');
  if (quotationSelect) quotationSelect.value = '';

  modal.classList.add('open');
  modal.style.display = 'flex';

  await Promise.all([
    loadTratOrderProducts(''),
    loadTratOrderQuotations(trat.id),
  ]);
  renderTratOrderCart();
}

// Botón "+ Nueva Venta" de la pestaña Ventas del expediente — reutiliza el
// mismo wizard/modal de "Modificar Tratamiento" (carrito de productos +
// cotización) pero sin ninguna cita de por medio: no hay tratamiento ni
// receta que crear, solo una venta ligada directo al paciente.
async function openNuevaVentaPacienteModal(patientId, patientName) {
  const modal = document.getElementById('tratamientoOrderModal');
  if (!modal || !patientId) return;

  clivoraTratOrderCurrentTratId = null;
  clivoraTratOrderPatientId = patientId;
  clivoraTratOrderCart = [];

  const modalTitle = document.getElementById('tratOrderModalTitle');
  if (modalTitle) modalTitle.textContent = 'Nueva Venta';
  // El campo "Nombre del tratamiento" no aplica a una venta directa (no hay
  // tratamiento que nombrar) — se oculta en vez de reetiquetarlo para
  // no mandar un "name" que el backend de todas formas ignora.
  const nameField = document.getElementById('tratOrderNameField');
  if (nameField) nameField.style.display = 'none';

  const subtitle = document.getElementById('tratOrderSubtitle');
  if (subtitle) subtitle.textContent = patientName || '';

  const quotationSelect = document.getElementById('tratOrderQuotationSearch');
  if (quotationSelect) quotationSelect.value = '';

  modal.classList.add('open');
  modal.style.display = 'flex';

  await Promise.all([
    loadTratOrderProducts(''),
    loadTratOrderQuotationsForPatient(patientId),
  ]);
  renderTratOrderCart();
}
window.openNuevaVentaPacienteModal = openNuevaVentaPacienteModal;

async function loadTratOrderProducts(q) {
  try {
    const response = await fetch(`/clivora/api/products/stock?q=${encodeURIComponent(q || '')}`, { cache: 'no-store' });
    clivoraTratOrderProducts = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar productos:', error);
    clivoraTratOrderProducts = [];
  }
  renderTratOrderProductGrid();
}

function renderTratOrderProductGrid() {
  const grid = document.getElementById('tratOrderProductGrid');
  if (!grid) return;
  grid.innerHTML = clivoraTratOrderProducts.map(p => {
    const cartItem = clivoraTratOrderCart.find(c => c.product_id === p.id);
    const safeName = String(p.name || '').replace(/"/g, '&quot;');
    return `
      <div class="trat-product-card ${cartItem ? 'selected' : ''}" data-product-id="${p.id}" data-product-name="${safeName}">
        ${cartItem ? `<span class="trat-product-qty-badge">${cartItem.qty}</span>` : ''}
        ${p.code ? `<div style="font-size: 10px; color: var(--text-muted); font-weight: 700;">${p.code}</div>` : ''}
        <div class="trat-product-name">${p.name || ''}</div>
      </div>
    `;
  }).join('') || '<div style="padding: 20px; color: var(--text-muted); font-size: 12px;">Sin productos.</div>';
}

async function loadTratOrderQuotations(appointmentId) {
  // Si la cita ya tiene ligada una cotización sin confirmar (se guardó antes
  // desde este wizard, "linked" en el controlador), arranca seleccionada y
  // con sus productos en el carrito; si no, vacío: se crea una cotización
  // nueva al guardar o el usuario elige una existente.
  try {
    const response = await fetch(`/clivora/api/tratamientos/${appointmentId}/quotations`, { cache: 'no-store' });
    clivoraTratOrderQuotations = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar cotizaciones:', error);
    clivoraTratOrderQuotations = [];
  }
  const select = document.getElementById('tratOrderQuotationSearch');
  if (select) {
    select.innerHTML = '<option value="">Sin cotización (se crea una nueva)</option>' +
      clivoraTratOrderQuotations.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
    const linked = clivoraTratOrderQuotations.find(o => o.linked);
    if (linked) {
      select.value = String(linked.id);
      selectTratOrderQuotation(linked.id);
    }
  }
}

// Misma idea que loadTratOrderQuotations pero para el modo "Nueva Venta"
// desde la pestaña Ventas del expediente (sin cita), ver
// clivora_patient_sale_order_quotations en el controlador.
async function loadTratOrderQuotationsForPatient(patientId) {
  try {
    const response = await fetch(`/clivora/api/patients/${patientId}/sale_order_quotations`, { cache: 'no-store' });
    clivoraTratOrderQuotations = response.ok ? await response.json() : [];
  } catch (error) {
    console.error('Error al cargar cotizaciones del paciente:', error);
    clivoraTratOrderQuotations = [];
  }
  const select = document.getElementById('tratOrderQuotationSearch');
  if (select) {
    select.innerHTML = '<option value="">Sin cotización (se crea una nueva)</option>' +
      clivoraTratOrderQuotations.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
  }
}

function selectTratOrderQuotation(orderId) {
  const order = clivoraTratOrderQuotations.find(o => o.id === orderId);
  clivoraTratOrderCart = (order?.lines || []).map(line => ({
    product_id: line.product_id,
    name: line.name,
    qty: line.qty || 1,
  }));
  renderTratOrderCart();
  renderTratOrderProductGrid();
}

function addProductToTratOrderCart(productId, productName) {
  const existing = clivoraTratOrderCart.find(c => c.product_id === productId);
  if (existing) {
    existing.qty += 1;
  } else {
    clivoraTratOrderCart.push({ product_id: productId, name: productName, qty: 1 });
  }
  renderTratOrderCart();
  renderTratOrderProductGrid();
}

function renderTratOrderCart() {
  const list = document.getElementById('tratOrderCartList');
  const countEl = document.getElementById('tratOrderCartCount');
  if (countEl) countEl.textContent = String(clivoraTratOrderCart.length);
  if (!list) return;
  list.innerHTML = clivoraTratOrderCart.map(item => {
    const safeName = String(item.name || '').replace(/"/g, '&quot;');
    return `
    <div class="trat-cart-item" data-product-id="${item.product_id}">
      <span class="trat-cart-name" title="${safeName}">${item.name || ''}</span>
      <div class="trat-cart-qty">
        <button type="button" class="trat-cart-minus btn-anim-lift">−</button>
        <span>${item.qty}</span>
        <button type="button" class="trat-cart-plus btn-anim-lift">+</button>
        <button type="button" class="trat-cart-remove btn-anim-lift"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>
    </div>
  `;
  }).join('') || '<div style="padding: 12px; color: var(--text-muted); font-size: 12px;">Sin medicamentos agregados.</div>';
}

function showTratOrderToast(message, isSuccess) {
  // Reemplaza los diálogos nativos del navegador — en toda la app esos
  // diálogos daban la sensación de "no pasó nada" (o de falso error) aunque
  // el cambio sí se hubiera guardado; un toast visible que sí distingue
  // éxito de error es más confiable.
  let toast = document.getElementById('tratOrderToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tratOrderToast';
    document.body.appendChild(toast);
  }
  toast.style.cssText = isSuccess
    ? 'position: fixed; bottom: 24px; right: 24px; background: #ECFDF5; border: 1px solid #10B981; color: #065F46; padding: 14px 20px; border-radius: 8px; font-weight: 800; font-size: 13px; z-index: 9999; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 8px; max-width: 360px;'
    : 'position: fixed; bottom: 24px; right: 24px; background: #FEF2F2; border: 1px solid #EF4444; color: #991B1B; padding: 14px 20px; border-radius: 8px; font-weight: 800; font-size: 13px; z-index: 9999; box-shadow: 0 10px 25px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 8px; max-width: 360px;';
  const icon = isSuccess
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  toast.innerHTML = icon + escapeHtml(message);
  toast.style.display = 'flex';
  setTimeout(() => { toast.style.display = 'none'; }, isSuccess ? 2500 : 5000);
}

async function saveTratamientoOrder(shouldConfirm) {
  const isPatientMode = !!clivoraTratOrderPatientId;
  if (!clivoraTratOrderCurrentTratId && !isPatientMode) return;
  const quotationSelect = document.getElementById('tratOrderQuotationSearch');
  const nameInput = document.getElementById('tratOrderName');
  const payload = {
    name: nameInput?.value?.trim() || '',
    order_id: quotationSelect?.value ? parseInt(quotationSelect.value, 10) : false,
    confirm: !!shouldConfirm,
    lines: clivoraTratOrderCart.map(item => ({ product_id: item.product_id, qty: item.qty })),
  };
  const url = isPatientMode
    ? `/clivora/api/patients/${clivoraTratOrderPatientId}/sale_order`
    : `/clivora/api/tratamientos/${clivoraTratOrderCurrentTratId}/order`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let message = 'No se pudo guardar la orden.';
      try {
        const errorData = await response.json();
        if (errorData?.message) message = errorData.message;
      } catch (parseError) { /* respuesta sin JSON, se queda el mensaje genérico */ }
      showTratOrderToast(message, false);
      return;
    }
    const modal = document.getElementById('tratamientoOrderModal');
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
    showTratOrderToast(shouldConfirm ? 'Orden de venta confirmada' : 'Cambios guardados', true);
    if (isPatientMode) {
      await loadPatientSaleOrders(clivoraTratOrderPatientId);
    } else {
      await loadTratamientos();
      if (window.refreshDynamicCalendar) await window.refreshDynamicCalendar();
    }
  } catch (error) {
    console.error('Error al guardar la orden del tratamiento:', error);
    showTratOrderToast('No se pudo guardar la orden.', false);
  }
}

const VENTA_STATE_LABELS = {
  draft: 'Cotización', sent: 'Cotización enviada', sale: 'Confirmada',
  done: 'Bloqueada', cancel: 'Cancelada',
};

// Columna "Stock" del modal "Ver venta": el grupo Farmacia la marca/desmarca
// a mano con un clic (ver clivora_sale_order_line_stock en el
// controlador); para los demás es solo lectura (readOnly).
function ventaStockToggleStyle(stock, readOnly = false) {
  return `display: inline-block; padding: 2px 10px; border-radius: var(--radius-full); font-size: 11px; font-weight: 700; cursor: ${readOnly ? 'default' : 'pointer'}; font-family: inherit; `
    + (stock
      ? 'background: rgba(16, 185, 129, 0.15); color: #047857; border: 1px solid #10b981;'
      : 'background: var(--bg-card); color: var(--text-muted); border: 1px solid var(--border-color);');
}

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('#ventaViewLinesBody .venta-stock-toggle');
  if (!btn || btn.disabled) return;
  const stock = btn.dataset.stock !== '1';
  btn.disabled = true;
  try {
    const response = await fetch(`/clivora/api/sale_orders/${btn.dataset.orderId}/lines/${btn.dataset.lineId}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock }),
    });
    if (!response.ok) throw new Error('save_failed');
    const data = await response.json();
    btn.dataset.stock = data.stock ? '1' : '0';
    btn.textContent = data.stock ? 'Sí' : 'No';
    btn.setAttribute('style', ventaStockToggleStyle(data.stock));
  } catch (error) {
    console.error('Error al guardar el stock de la línea:', error);
    showClivoraAlertModal('No se pudo guardar el stock del producto.');
  } finally {
    btn.disabled = false;
  }
});

async function openVentaViewModal(orderId) {
  if (!orderId) return;
  const modal = document.getElementById('ventaViewModal');
  if (!modal) return;
  try {
    const response = await fetch(`/clivora/api/sale_orders/${orderId}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('load_failed');
    const data = await response.json();

    const nameEl = document.getElementById('ventaViewName');
    if (nameEl) nameEl.textContent = data.name || 'Venta';
    const subtitleEl = document.getElementById('ventaViewSubtitle');
    if (subtitleEl) {
      subtitleEl.textContent = data.stateLabel || VENTA_STATE_LABELS[data.state] || data.state || '';
    }
    const clientEl = document.getElementById('ventaViewClient');
    if (clientEl) clientEl.textContent = data.clientName || '—';
    const doctorEl = document.getElementById('ventaViewDoctor');
    if (doctorEl) doctorEl.textContent = data.doctorName || '—';
    const createDateEl = document.getElementById('ventaViewCreateDate');
    if (createDateEl) createDateEl.textContent = data.createDate || '—';
    const dateEl = document.getElementById('ventaViewDate');
    if (dateEl) dateEl.textContent = data.dateOrder || '—';

    const body = document.getElementById('ventaViewLinesBody');
    // Solo el grupo Farmacia cambia el Stock (canEditStock en /api/me); los
    // demás lo ven de solo lectura.
    const canEditStock = !!window.clivoraCurrentUser?.canEditStock;
    if (body) {
      body.innerHTML = (data.lines || []).map(line => `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 10px 12px; color: var(--text-main);">${line.name || ''}</td>
          <td style="text-align: right; padding: 10px 12px; color: var(--text-main);">${line.qty}</td>
          <td style="text-align: center; padding: 10px 12px;">
            ${canEditStock
              ? `<button type="button" class="venta-stock-toggle" data-order-id="${data.id}" data-line-id="${line.id}" data-stock="${line.stock ? '1' : '0'}"
              title="Clic para cambiar el stock" style="${ventaStockToggleStyle(line.stock)}">${line.stock ? 'Sí' : 'No'}</button>`
              : `<span style="${ventaStockToggleStyle(line.stock, true)}">${line.stock ? 'Sí' : 'No'}</span>`}
          </td>
          <td style="text-align: right; padding: 10px 12px; color: var(--text-main);">$${(line.priceUnit || 0).toFixed(2)}</td>
          <td style="text-align: right; padding: 10px 12px; color: var(--text-main); font-weight: 700;">$${(line.priceSubtotal || 0).toFixed(2)}</td>
        </tr>
      `).join('') || '<tr><td colspan="5" style="padding: 16px 12px; color: var(--text-muted); text-align: center;">Sin productos.</td></tr>';
    }
    const totalEl = document.getElementById('ventaViewTotal');
    if (totalEl) totalEl.textContent = `Total: $${(data.amountTotal || 0).toFixed(2)}`;

    const printBtn = document.getElementById('btnPrintVentaView');
    if (printBtn) printBtn.onclick = () => window.open(`/clivora/api/sale_orders/${orderId}/print`, '_blank');

    modal.classList.add('open');
    modal.style.display = 'flex';
  } catch (error) {
    console.error('Error al cargar la venta:', error);
    showClivoraAlertModal('No se pudo cargar la información de la venta.');
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#closeVentaViewModal')) {
    const modal = document.getElementById('ventaViewModal');
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
    return;
  }
  const folderIcon = event.target.closest('#tratamientosTableBody .folder-icon');
  if (folderIcon) {
    openTratamientoCitaModal(parseInt(folderIcon.dataset.tratId, 10), folderIcon);
    return;
  }
  const eyeIcon = event.target.closest('#tratamientosTableBody .eye-icon');
  if (eyeIcon) {
    openTratamientoOrderModal(parseInt(eyeIcon.dataset.tratId, 10));
    return;
  }
  const kanbanVentaLink = event.target.closest('#tratamientosKanbanView .venta-link');
  if (kanbanVentaLink) {
    openVentaViewModal(parseInt(kanbanVentaLink.dataset.orderId, 10));
    return;
  }
  const kanbanCard = event.target.closest('#tratamientosKanbanView .trat-kanban-card');
  if (kanbanCard) {
    openTratamientoCitaModal(parseInt(kanbanCard.dataset.tratId, 10), kanbanCard);
    return;
  }
  const btnVistaLista = event.target.closest('#btnTratamientosVistaLista');
  if (btnVistaLista) {
    applyTratVistaMode('lista');
    renderTratamientosTable();
    return;
  }
  const btnVistaKanban = event.target.closest('#btnTratamientosVistaKanban');
  if (btnVistaKanban) {
    applyTratVistaMode('kanban');
    renderTratamientosTable();
    return;
  }
  const ventaLink = event.target.closest('#tratamientosTableBody .venta-link');
  if (ventaLink) {
    openVentaViewModal(parseInt(ventaLink.dataset.orderId, 10));
    return;
  }

  const productCard = event.target.closest('#tratOrderProductGrid .trat-product-card');
  if (productCard) {
    addProductToTratOrderCart(parseInt(productCard.dataset.productId, 10), productCard.dataset.productName);
    return;
  }

  const cartItem = event.target.closest('.trat-cart-item');
  if (cartItem) {
    const productId = parseInt(cartItem.dataset.productId, 10);
    const item = clivoraTratOrderCart.find(c => c.product_id === productId);
    if (item) {
      if (event.target.closest('.trat-cart-plus')) {
        item.qty += 1;
      } else if (event.target.closest('.trat-cart-minus')) {
        item.qty = Math.max(1, item.qty - 1);
      } else if (event.target.closest('.trat-cart-remove')) {
        clivoraTratOrderCart = clivoraTratOrderCart.filter(c => c.product_id !== productId);
      } else {
        return;
      }
      renderTratOrderCart();
      renderTratOrderProductGrid();
    }
    return;
  }

  if (event.target.closest('#closeTratamientoOrderModal')) {
    const modal = document.getElementById('tratamientoOrderModal');
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
    return;
  }
  if (event.target.closest('#btnGuardarTratamientoOrder')) {
    runClivoraSaveOnce('tratamientoOrder', event.target.closest('#btnGuardarTratamientoOrder'), () => saveTratamientoOrder(false));
    return;
  }
  if (event.target.closest('#btnConfirmarOrdenTratamiento')) {
    // Sin diálogo nativo de confirmación — el propio botón "Confirmar
    // Orden" ya es la acción explícita del usuario; el confirm() nativo
    // solo agregaba un paso extra sin dar ninguna señal real de éxito/error.
    runClivoraSaveOnce('tratamientoOrder', event.target.closest('#btnConfirmarOrdenTratamiento'), () => saveTratamientoOrder(true));
    return;
  }
});

// "Limpiar filtros" de Tratamientos: vuelve a los valores iniciales del HTML
// (todos los estados menos Rechazado, check-in "Todos"). Los selectores y la
// fecha reciben 'change' para que el widget de Clivora refresque lo que muestra.
document.addEventListener('click', (event) => {
  if (!event.target.closest('#tratamientosLimpiarFiltros')) return;
  const search = document.getElementById('tratamientosSearchInput');
  if (search) search.value = '';
  ['tratamientosUbicacionFilter', 'tratamientosSalaFilter', 'tratamientosDoctorFilter', 'tratamientosFechaInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) { el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  document.querySelectorAll('.trat-filter-estado').forEach(el => { el.checked = el.defaultChecked; });
  document.querySelectorAll('.trat-filter-checkin').forEach(el => { el.checked = el.defaultChecked; });
  updateTratamientosFilterOptions();
  renderTratamientosTable();
});

// Filtro de Fecha de Tratamientos: en fase de captura (true) porque el
// calendario de Clivora (enhanceCustomDatePicker) frena la propagación del
// 'change' de su <input> — el listener general de abajo nunca se enteraba de
// la fecha elegida y la lista no se filtraba.
document.addEventListener('change', (event) => {
  if (event.target && event.target.id === 'tratamientosFechaInput') renderTratamientosTable();
}, true);

document.addEventListener('change', (event) => {
  if (event.target.matches('.trat-filter-ubicacion')) {
    // Repuebla Sala acotada a la nueva Ubicación (ver
    // updateTratamientosFilterOptions) antes de refiltrar la tabla — si no,
    // el <select> de Sala se quedaba mostrando salas de la ubicación
    // anterior (o de todas) hasta el siguiente loadTratamientos().
    updateTratamientosFilterOptions();
  }
  if (event.target.matches('.trat-filter-estado, .trat-filter-checkin, .trat-filter-ubicacion, .trat-filter-sala, .trat-filter-doctor')) {
    renderTratamientosTable();
  }
  if (event.target.id === 'tratOrderQuotationSearch') {
    // Al elegir una cotización existente, el carrito se reemplaza por sus
    // líneas actuales — así se ven las cantidades ya cargadas y se pueden
    // modificar o agregar más productos, en vez de partir vacío. Si elige
    // "Sin cotización" el carrito se vacía (se va a crear una nueva).
    const orderId = event.target.value ? parseInt(event.target.value, 10) : false;
    if (orderId) {
      selectTratOrderQuotation(orderId);
    } else {
      clivoraTratOrderCart = [];
      renderTratOrderCart();
      renderTratOrderProductGrid();
    }
  }
});

let clivoraTratProductSearchTimer = null;
document.addEventListener('input', (event) => {
  if (event.target.id === 'tratOrderProductSearch') {
    clearTimeout(clivoraTratProductSearchTimer);
    const q = event.target.value;
    clivoraTratProductSearchTimer = setTimeout(() => loadTratOrderProducts(q), 300);
  }
  // Búsqueda de Tratamientos: filtra en vivo mientras se escribe — todo el
  // filtrado ya corre en el cliente (clivoraTratamientos.filter en
  // renderTratamientosTable), así que no hace falta el botón "Buscar" que
  // había antes ni esperar a un evento aparte.
  if (event.target.id === 'tratamientosSearchInput') {
    renderTratamientosTable();
  }
});

// ============================================================
// WIDGET DE SELECT PERSONALIZADO — portado de la versión anterior del diseño
// ============================================================
// Reemplaza visualmente cada <select> nativo (que se oculta con
// display:none pero se conserva como fuente de verdad del valor — el resto
// del código sigue leyendo/escribiendo select.value normalmente) por un
// trigger + menú flotante con el mismo look en toda la app. Idempotente vía
// dataset.customEnhanced, así que puede llamarse repetidas veces sin crear
// duplicados; el MutationObserver de más abajo se encarga de detectar los
// <select> que la SPA agrega dinámicamente (modales, filas de familiares,
// catálogos cargados por fetch, etc.) sin tener que tocar cada punto donde
// se inyecta HTML nuevo.
// Versión compacta del select personalizado, solo para .rt-cmd-select
// (fuente/tamaño de la barra de texto enriquecido) — enhanceCustomSelect se
// excluye a propósito para estos (ver ahí: su trigger a tamaño de campo de
// formulario normal no cabía en una barra de 30px de alto). Mismo lenguaje
// visual (morado, bordes redondeados, opción resaltada) que .custom-select,
// pero a la escala del toolbar, y con dos diferencias clave frente a ese
// widget genérico: 1) usa mousedown+preventDefault (igual que los botones
// N/K/S del mismo toolbar) en vez de click, para que elegir una opción
// nunca le robe el foco/selección al contenteditable — el <select> nativo
// SÍ se lo robaba, que era la causa real de que fuente/tamaño no se
// aplicaran (ver el fix de execCommand/restoreRichTextSelection más
// arriba); 2) sigue escribiendo/leyendo el <select> real oculto y
// disparando "change" sobre él, así que ese mismo listener de execCommand
// no necesita saber que existe este widget.
function enhanceRichTextSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customEnhanced === 'true') return;
  selectEl.dataset.customEnhanced = 'true';
  selectEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'rt-select-container';
  wrapper.dataset.cmd = selectEl.dataset.cmd || '';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'rt-select-trigger';
  trigger.title = selectEl.title || '';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'rt-select-label';

  const arrowSpan = document.createElement('span');
  arrowSpan.className = 'rt-select-arrow';
  arrowSpan.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  trigger.appendChild(labelSpan);
  trigger.appendChild(arrowSpan);
  wrapper.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'rt-select-menu';
  wrapper.appendChild(menu);

  const containerClasses = ['nopat-card', 'form-group', 'accordion-content', 'accordion-item', 'onco-accordion-content', 'onco-accordion-item', 'patient-create-section', 'card-aparato'];

  function updateTriggerText() {
    const opt = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
    labelSpan.textContent = opt ? opt.textContent : '';
  }
  updateTriggerText();
  selectEl.addEventListener('change', updateTriggerText);

  function buildMenuOptions() {
    menu.innerHTML = '';
    Array.from(selectEl.options).forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'rt-select-option';
      if (opt.value === selectEl.value) item.classList.add('selected');
      item.textContent = opt.textContent;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectEl.value = opt.value;
        updateTriggerText();
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu();
      });
      menu.appendChild(item);
    });
  }

  function openMenu() {
    closeAllRichTextSelects(wrapper);
    closeAllCustomSelects();
    buildMenuOptions();
    wrapper.classList.add('is-open');
    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        p.classList.add('has-open-select');
        p.style.overflow = 'visible';
      }
      p = p.parentElement;
    }
  }

  function closeMenu() {
    wrapper.classList.remove('is-open');

    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        if (!p.querySelector('.custom-select-container.is-open, .custom-date-container.is-open, .rt-select-container.is-open')) {
          p.classList.remove('has-open-select');
          p.style.overflow = '';
        }
      }
      p = p.parentElement;
    }
  }

  trigger.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (wrapper.classList.contains('is-open')) closeMenu(); else openMenu();
  });

  wrapper.__closeRichTextSelect = closeMenu;

  if (selectEl.parentNode) {
    selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);
  }
}

function closeAllRichTextSelects(exceptWrapper = null) {
  document.querySelectorAll('.rt-select-container.is-open').forEach((el) => {
    if (el !== exceptWrapper && typeof el.__closeRichTextSelect === 'function') el.__closeRichTextSelect();
  });
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.rt-select-container')) closeAllRichTextSelects();
});

function enhanceCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customEnhanced === 'true') return;
  if (selectEl.type === 'hidden') return;
  // Los selects de fuente/tamaño de la barra de herramientas de texto
  // enriquecido (.rich-text-toolbar) usan enhanceRichTextSelect en vez de
  // este widget genérico — ver esa función para el porqué (tamaño y, sobre
  // todo, que el <select> nativo le robaba el foco al contenteditable).
  if (selectEl.classList.contains('rt-cmd-select')) {
    enhanceRichTextSelect(selectEl);
    return;
  }

  selectEl.dataset.customEnhanced = 'true';
  selectEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select-container';
  if (selectEl.disabled) wrapper.classList.add('disabled');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.tabIndex = 0;
  if (selectEl.disabled) trigger.disabled = true;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-select-label';

  function updateTriggerText() {
    const selectedOpt = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
    const textVal = selectedOpt ? selectedOpt.textContent : 'Seleccionar';
    labelSpan.textContent = textVal;
    if (!selectEl.value || textVal.toLowerCase().includes('selecciona')) {
      trigger.classList.add('is-placeholder');
    } else {
      trigger.classList.remove('is-placeholder');
    }
    if (selectEl.disabled) {
      wrapper.classList.add('disabled');
      trigger.disabled = true;
    } else {
      wrapper.classList.remove('disabled');
      trigger.disabled = false;
    }
  }
  updateTriggerText();

  const attrObserver = new MutationObserver(() => {
    updateTriggerText();
  });
  attrObserver.observe(selectEl, { attributes: true, attributeFilter: ['disabled'] });

  // A diferencia del original: aquí también se observa childList/subtree,
  // porque en esta app muchos <select> se enhance-an vacíos y sus <option>
  // llegan después por fetch (catálogos, médicos, familiares) — sin esto el
  // trigger se quedaba mostrando "Seleccionar..." aunque el <select> ya
  // tuviera opciones y hasta un valor cargado.
  const optionsObserver = new MutationObserver(() => {
    updateTriggerText();
  });
  optionsObserver.observe(selectEl, { childList: true });

  const arrowSpan = document.createElement('span');
  arrowSpan.className = 'custom-select-arrow';
  arrowSpan.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

  trigger.appendChild(labelSpan);
  trigger.appendChild(arrowSpan);
  wrapper.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';

  function buildMenuOptions() {
    menu.innerHTML = '';
    Array.from(selectEl.options).forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      if (opt.disabled) item.classList.add('disabled');
      if (opt.value === selectEl.value) item.classList.add('selected');

      const text = document.createElement('span');
      text.textContent = opt.textContent;
      item.appendChild(text);

      if (opt.value === selectEl.value && opt.value !== '') {
        const check = document.createElement('span');
        check.className = 'option-check-icon';
        check.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        item.appendChild(check);
      }

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (opt.disabled) return;
        selectEl.value = opt.value;
        updateTriggerText();
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu();
      });

      menu.appendChild(item);
    });
  }

  wrapper.appendChild(menu);

  if (selectEl.parentNode) {
    selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);
  }

  function openMenu() {
    if (selectEl.disabled) return;
    closeAllCustomSelects(menu);
    // Los selects de hora/minuto/AM-PM del widget de fecha+hora viven
    // DENTRO de un .custom-date-container (ver enhanceCustomDatePicker) —
    // cerrar "todos" los date pickers de golpe se cerraba también el que
    // contiene a este mismo select, tumbando el panel debajo de los pies
    // del usuario justo al abrir el desplegable de hora (confirmado con
    // grabación de pantalla: el panel entero desaparece en el mismo frame
    // en el que se toca el selector de Hora, sin que su propia lista
    // llegue a pintarse — señal de que esto se ejecuta de forma síncrona
    // dentro del mismo openMenu). Un intento anterior resolvía el
    // contenedor dueño vía panel.__ownerContainer (wrapper.closest
    // ('.custom-date-container') ya no sirve una vez que el panel se porta
    // a <body>) para EXCLUIRLO de closeAllCustomDatePickers, pero esa
    // resolución seguía fallando en la práctica. En vez de seguir
    // dependiendo de identificar y excluir correctamente al dueño, se
    // evita el problema de raíz: si este select vive dentro de un panel de
    // fecha+hora ya abierto, no hay ningún OTRO date-picker que deba
    // cerrarse en este momento (la atención del usuario ya está aquí), así
    // que directamente no se llama a closeAllCustomDatePickers en ese
    // caso — nunca puede cerrarse a sí mismo si nunca se le da la
    // oportunidad de intentar excluirse.
    const ownerPanel = wrapper.closest('.custom-date-panel');
    if (!ownerPanel && typeof closeAllCustomDatePickers === 'function') {
      closeAllCustomDatePickers();
    }
    buildMenuOptions();
    // fixed-menu ANTES de is-open: la regla de styles.css que le pone
    // overflow:visible al .modal-body dispara apenas existe is-open, así que
    // la clase que la excluye tiene que estar ya puesta.
    if (wrapper.closest('.modal-body')) wrapper.classList.add('fixed-menu');
    wrapper.classList.add('is-open');

    // Voltear hacia arriba si no cabe hacia abajo — .custom-select-menu
    // siempre abre debajo de su trigger (top: 100%) sin ninguna noción del
    // borde de la pantalla, a diferencia del panel de fecha+hora (que sí
    // calcula esto en positionPanelFixed). Con Hora/Minuto/a.m.-p.m. ahora
    // debajo del calendario (a pedido), su trigger puede quedar pegado al
    // borde inferior del panel/pantalla, y el desplegable de opciones se
    // salía de la vista sin ninguna forma de tocarlo. offsetHeight se puede
    // leer aunque el menú todavía esté invisible (opacity/visibility, no
    // display:none, así que sí tiene layout calculado).
    const triggerRect = trigger.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 240;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    wrapper.classList.toggle('opens-upward', spaceBelow < menuHeight + 10);

    // Dentro de un .modal-body con scroll propio, abrir el menú
    // absoluto obligaba a ponerle overflow:visible al modal-body (ver
    // styles.css), y ese cambio de overflow reseteaba su scrollTop a 0 —
    // el modal "saltaba hasta arriba" y las opciones quedaban fuera de
    // vista. Ahí el menú se posiciona en fixed contra el viewport y el
    // modal-body no se toca.
    if (wrapper.classList.contains('fixed-menu')) {
      menu.style.position = 'fixed';
      menu.style.left = triggerRect.left + 'px';
      menu.style.right = 'auto';
      menu.style.width = triggerRect.width + 'px';
      if (spaceBelow < menuHeight + 10) {
        menu.style.top = 'auto';
        menu.style.bottom = (window.innerHeight - triggerRect.top + 6) + 'px';
      } else {
        menu.style.bottom = 'auto';
        menu.style.top = (triggerRect.bottom + 6) + 'px';
      }
    }

    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (p.classList.contains('nopat-card') || p.classList.contains('form-group') || p.classList.contains('accordion-content') || p.classList.contains('accordion-item') || p.classList.contains('onco-accordion-content') || p.classList.contains('onco-accordion-item') || p.classList.contains('patient-create-section') || p.classList.contains('custom-date-panel')) {
        p.classList.add('has-open-select');
        p.style.overflow = 'visible';
      }
      p = p.parentElement;
    }
  }

  function closeMenu() {
    wrapper.classList.remove('is-open');
    wrapper.classList.remove('fixed-menu');

    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (p.classList.contains('nopat-card') || p.classList.contains('form-group') || p.classList.contains('accordion-content') || p.classList.contains('accordion-item') || p.classList.contains('onco-accordion-content') || p.classList.contains('onco-accordion-item') || p.classList.contains('patient-create-section') || p.classList.contains('custom-date-panel')) {
        p.classList.remove('has-open-select');
        p.style.overflow = '';
      }
      p = p.parentElement;
    }
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (wrapper.classList.contains('is-open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  selectEl.addEventListener('change', () => {
    updateTriggerText();
  });
}

function closeAllCustomSelects(exceptMenu = null) {
  document.querySelectorAll('.custom-select-container.is-open').forEach((container) => {
    const menu = container.querySelector('.custom-select-menu');
    if (menu !== exceptMenu) {
      container.classList.remove('is-open');
      container.classList.remove('fixed-menu');
    }
  });
  document.querySelectorAll('.has-open-select').forEach((el) => {
    const hasOpenChild = el.querySelector('.custom-select-container.is-open');
    if (!hasOpenChild) {
      el.classList.remove('has-open-select');
    }
  });
}

document.addEventListener('click', () => closeAllCustomSelects());

// Un menú en position:fixed (ver openMenu) no se mueve con el scroll de su
// modal-body — se cierra al hacer scroll fuera de la propia lista.
window.addEventListener('scroll', (e) => {
  if (e.target && e.target.closest && e.target.closest('.custom-select-menu')) return;
  if (document.querySelector('.custom-select-container.fixed-menu.is-open')) closeAllCustomSelects();
}, true);

document.addEventListener('keyup', (e) => {
  if (e.key === 'Escape') closeAllCustomSelects();
});

function initAllCustomSelects() {
  document.querySelectorAll('select').forEach((sel) => {
    enhanceCustomSelect(sel);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initAllCustomSelects();
});

setTimeout(() => {
  initAllCustomSelects();
}, 300);

const clivoraSelectObserver = new MutationObserver(() => {
  initAllCustomSelects();
});

document.addEventListener('DOMContentLoaded', () => {
  if (document.body) {
    clivoraSelectObserver.observe(document.body, { childList: true, subtree: true });
  }
});

// ============================================================
// WIDGET DE FECHA PERSONALIZADO (input[type=date])
// Mismo patrón que enhanceCustomSelect de arriba: oculta el <input> real
// (queda como fuente de verdad del valor, formato ISO yyyy-mm-dd) y lo
// envuelve con un trigger + panel flotante con el mismo lenguaje visual
// morado que el resto de la app en vez del popup nativo del navegador
// (que además se ve distinto entre Chrome/Firefox/Safari/Edge).
//
// El panel tiene 3 vistas encadenadas — días → meses → años — para poder
// llegar a un año lejano (fecha de nacimiento de un paciente adulto o
// mayor) en un par de clics en vez de darle "mes anterior" decenas de
// veces como obliga el calendario nativo.
// ============================================================
const CUSTOM_DATE_WEEKDAYS = ['do', 'lu', 'ma', 'mi', 'ju', 'vi', 'sá'];
const CUSTOM_DATE_MONTHS_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const CUSTOM_DATE_MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function pad2CustomDate(n) {
  return String(n).padStart(2, '0');
}

function parseIsoCustomDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// Igual que parseIsoCustomDate pero para el value de <input type="datetime-
// local"> ("YYYY-MM-DDTHH:MM") — hour/minute quedan null si el <input> es
// type="date" puro (sin componente de hora).
function parseIsoCustomDateTime(value) {
  const v = value || '';
  const mDateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (mDateTime) {
    return {
      year: Number(mDateTime[1]), month: Number(mDateTime[2]), day: Number(mDateTime[3]),
      hour: Number(mDateTime[4]), minute: Number(mDateTime[5]),
    };
  }
  const parsed = parseIsoCustomDate(v);
  return parsed ? { ...parsed, hour: null, minute: null } : null;
}

function formatIsoCustomDate(year, month, day) {
  return `${year}-${pad2CustomDate(month)}-${pad2CustomDate(day)}`;
}

function formatIsoCustomDateTime(year, month, day, hour, minute) {
  return `${formatIsoCustomDate(year, month, day)}T${pad2CustomDate(hour)}:${pad2CustomDate(minute)}`;
}

// Hora 24h (la que guarda datetime-local) <-> hora 12h + AM/PM (la que se
// muestra/edita en el widget, más natural para el usuario).
function to12HourCustomDate(hour24) {
  const isPM = hour24 >= 12;
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, isPM };
}

function to24HourCustomDate(hour12, isPM) {
  let hour24 = hour12 % 12;
  if (isPM) hour24 += 12;
  return hour24;
}

function formatCustomDateLabel(parsed) {
  if (!parsed) return '';
  let label = `${parsed.day} de ${CUSTOM_DATE_MONTHS_FULL[parsed.month - 1]} de ${parsed.year}`;
  if (parsed.hour != null && parsed.minute != null) {
    const { hour12, isPM } = to12HourCustomDate(parsed.hour);
    label += `, ${pad2CustomDate(hour12)}:${pad2CustomDate(parsed.minute)} ${isPM ? 'p.m.' : 'a.m.'}`;
  }
  return label;
}

function enhanceCustomDatePicker(inputEl) {
  if (!inputEl || inputEl.dataset.customEnhanced === 'true') return;
  const isDateTime = inputEl.type === 'datetime-local';
  if (inputEl.tagName !== 'INPUT' || (inputEl.type !== 'date' && !isDateTime)) return;

  inputEl.dataset.customEnhanced = 'true';
  inputEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-date-container';
  // El label con hora ("25 de agosto de 2026, 10:56 p.m.") es bastante más
  // largo que uno de solo fecha — en columnas angostas (grillas de 3+
  // columnas) se recortaba con "..." en vez de acomodarse. Este marcador
  // deja que el trigger crezca a 2 líneas solo cuando hace falta, sin
  // tocar la altura fija de los triggers de solo fecha (que sí caben bien
  // en una línea casi siempre).
  if (isDateTime) wrapper.classList.add('is-datetime');
  if (inputEl.disabled) wrapper.classList.add('disabled');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-date-trigger';
  trigger.tabIndex = 0;
  if (inputEl.disabled) trigger.disabled = true;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'custom-date-icon';
  iconSpan.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-date-label';

  const clearBtn = document.createElement('span');
  clearBtn.className = 'custom-date-clear btn-anim-lift';
  clearBtn.title = 'Borrar fecha';
  clearBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function updateTriggerText() {
    const parsed = isDateTime ? parseIsoCustomDateTime(inputEl.value) : parseIsoCustomDate(inputEl.value);
    if (parsed) {
      // data-date-format="short" (p. ej. filtro de Fecha de Tratamientos):
      // dd/mm/aaaa en vez de "20 de octubre de 2026", para que el campo no
      // cambie de ancho al elegir una fecha.
      labelSpan.textContent = (!isDateTime && inputEl.dataset.dateFormat === 'short')
        ? `${String(parsed.day).padStart(2, '0')}/${String(parsed.month).padStart(2, '0')}/${parsed.year}`
        : formatCustomDateLabel(parsed);
      trigger.classList.remove('is-placeholder');
      clearBtn.style.display = 'flex';
    } else {
      labelSpan.textContent = inputEl.placeholder || 'dd/mm/aaaa';
      trigger.classList.add('is-placeholder');
      clearBtn.style.display = 'none';
    }
    if (inputEl.disabled) {
      wrapper.classList.add('disabled');
      trigger.disabled = true;
    } else {
      wrapper.classList.remove('disabled');
      trigger.disabled = false;
    }
  }

  trigger.appendChild(iconSpan);
  trigger.appendChild(labelSpan);
  trigger.appendChild(clearBtn);
  wrapper.appendChild(trigger);

  // Refuerzo contra el listener global de "clic afuera" (ver
  // document.addEventListener('click', ...) más abajo en este archivo): por
  // alguna razón que no se pudo aislar de forma determinística (probable
  // interacción entre el portal a <body> y el re-render del calendario en
  // medio del gesto de clic), un clic apuntado al selector de Hora/Minuto/
  // a.m.-p.m. de este mismo panel a veces llegaba a ese listener con un
  // e.target que ya no calzaba ni con .custom-date-container ni con
  // .custom-date-panel, cerrando el panel entero a media interacción (ver
  // conversación/video de soporte). mousedown ocurre ANTES que click, así
  // que refrescar aquí la misma ventana de supresión que ya usa
  // clivoraMarkRecentNativeSelectInteraction cubre a tiempo al click que le
  // sigue, sin importar dónde termine "cayendo" según el navegador.
  const __refreshOutsideCloseSuppression = () => { clivoraSuppressOutsideCloseUntil = Date.now() + 2000; };
  wrapper.addEventListener('mousedown', __refreshOutsideCloseSuppression);

  const panel = document.createElement('div');
  panel.className = 'custom-date-panel';
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', __refreshOutsideCloseSuppression);
  // Ver el comentario equivalente en enhanceCustomDatePicker: el panel se
  // porta a <body> al abrirse, así que su .custom-date-container original
  // deja de ser su ancestro — esta referencia de vuelta es lo único que le
  // permite a enhanceCustomSelect (selector de Hora/Minuto/a.m.-p.m. de
  // este mismo panel) ubicarlo para no cerrarse a sí mismo al abrir su
  // propio menú.
  panel.__ownerContainer = wrapper;
  wrapper.appendChild(panel);

  if (inputEl.parentNode) {
    inputEl.parentNode.insertBefore(wrapper, inputEl.nextSibling);
  }

  updateTriggerText();

  const attrObserver = new MutationObserver(() => updateTriggerText());
  attrObserver.observe(inputEl, { attributes: true, attributeFilter: ['disabled'] });

  // form.reset() no dispara 'change' en el input nativo — sin esto el
  // trigger se quedaba mostrando la última fecha elegida aunque el valor
  // ya se hubiera limpiado.
  if (inputEl.form) {
    inputEl.form.addEventListener('reset', () => setTimeout(updateTriggerText, 0));
  }
  // stopPropagation: mismo motivo que en hourSelect/minuteSelect/ampmSelect
  // (ver renderTimeSection más abajo) — a diferencia de esos, este listener
  // vivía sin frenar la propagación. inputEl es el <input> ORIGINAL en su
  // posición real dentro del modal (no vive en el panel portado a <body>),
  // así que un 'change' disparado aquí (ej. por commitTimeChange al elegir
  // hora/minuto/am-pm) seguía subiendo por el DOM real del campo — modal,
  // formulario, document — en vez de quedarse contenido en este widget.
  inputEl.addEventListener('change', (e) => { e.stopPropagation(); updateTriggerText(); });

  const now = new Date();
  const todayParsed = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };

  let view = 'days';
  let viewYear = todayParsed.year;
  let viewMonth = todayParsed.month;
  let yearsPageStart = viewYear - (viewYear % 12);

  const containerClasses = ['nopat-card', 'form-group', 'accordion-content', 'accordion-item', 'onco-accordion-content', 'onco-accordion-item', 'patient-create-section', 'nc-block-card'];

  // Hora actualmente elegida en el panel (solo aplica si isDateTime) — se
  // sincroniza contra el value real cada vez que se abre el panel
  // (syncTimeFromValue) y se usa para no perder la hora ya puesta al picar
  // un día distinto en la grilla.
  let selectedHour24 = now.getHours();
  let selectedMinute = now.getMinutes();

  function syncTimeFromValue() {
    const parsed = currentSelected();
    if (parsed && parsed.hour != null) {
      selectedHour24 = parsed.hour;
      selectedMinute = parsed.minute;
    } else {
      const now = new Date();
      selectedHour24 = now.getHours();
      selectedMinute = now.getMinutes();
    }
  }

  function currentSelected() {
    return isDateTime ? parseIsoCustomDateTime(inputEl.value) : parseIsoCustomDate(inputEl.value);
  }

  function isDisabledIso(iso) {
    // min/max de un datetime-local también vienen en formato con hora —
    // para deshabilitar días en la grilla solo importa la parte de fecha.
    const isoDate = iso.slice(0, 10);
    if (inputEl.min && isoDate < inputEl.min.slice(0, 10)) return true;
    if (inputEl.max && isoDate > inputEl.max.slice(0, 10)) return true;
    return false;
  }

  // Clic en un día de la grilla: en modo solo-fecha selecciona y cierra
  // (como antes). En modo fecha+hora, fija la fecha conservando la hora ya
  // elegida y deja el panel abierto para poder ajustar la hora — cerrar de
  // inmediato no dejaría tiempo de tocar el selector de hora.
  function selectDate(year, month, day) {
    if (isDateTime) {
      inputEl.value = formatIsoCustomDateTime(year, month, day, selectedHour24, selectedMinute);
      updateTriggerText();
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      renderCurrentView();
    } else {
      inputEl.value = formatIsoCustomDate(year, month, day);
      updateTriggerText();
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      closePanel();
    }
  }

  // Cambio en hora/minuto/AM-PM: conserva la fecha ya elegida (o hoy, si
  // el campo estaba vacío) y actualiza solo la parte de hora.
  function commitTimeChange() {
    const parsed = currentSelected() || todayParsed;
    inputEl.value = formatIsoCustomDateTime(parsed.year, parsed.month, parsed.day, selectedHour24, selectedMinute);
    updateTriggerText();
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderTimeSection() {
    if (!isDateTime) return null;

    const section = document.createElement('div');
    section.className = 'custom-date-time-section';

    const label = document.createElement('div');
    label.className = 'custom-date-time-label';
    label.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Hora';
    section.appendChild(label);

    const row = document.createElement('div');
    row.className = 'custom-date-time-row';

    const { hour12, isPM } = to12HourCustomDate(selectedHour24);

    const hourSelect = document.createElement('select');
    hourSelect.className = 'custom-date-time-select';
    hourSelect.setAttribute('aria-label', 'Hora');
    for (let h = 1; h <= 12; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = pad2CustomDate(h);
      if (h === hour12) opt.selected = true;
      hourSelect.appendChild(opt);
    }

    const minuteSelect = document.createElement('select');
    minuteSelect.className = 'custom-date-time-select';
    minuteSelect.setAttribute('aria-label', 'Minuto');
    for (let m = 0; m < 60; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = pad2CustomDate(m);
      if (m === selectedMinute) opt.selected = true;
      minuteSelect.appendChild(opt);
    }

    const ampmSelect = document.createElement('select');
    ampmSelect.className = 'custom-date-time-select';
    ampmSelect.setAttribute('aria-label', 'a.m. / p.m.');
    [['AM', 'a.m.'], ['PM', 'p.m.']].forEach(([value, text]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if ((value === 'PM') === isPM) opt.selected = true;
      ampmSelect.appendChild(opt);
    });

    const onTimeChange = () => {
      const h12 = parseInt(hourSelect.value, 10);
      selectedHour24 = to24HourCustomDate(h12, ampmSelect.value === 'PM');
      selectedMinute = parseInt(minuteSelect.value, 10);
      commitTimeChange();
    };
    hourSelect.addEventListener('change', (e) => { e.stopPropagation(); onTimeChange(); });
    minuteSelect.addEventListener('change', (e) => { e.stopPropagation(); onTimeChange(); });
    ampmSelect.addEventListener('change', (e) => { e.stopPropagation(); onTimeChange(); });
    [hourSelect, minuteSelect, ampmSelect].forEach((sel) => {
      sel.addEventListener('mousedown', clivoraMarkRecentNativeSelectInteraction);
      sel.addEventListener('change', clivoraMarkRecentNativeSelectInteraction);
    });

    const sep = document.createElement('span');
    sep.className = 'custom-date-time-sep';
    sep.textContent = ':';

    row.appendChild(hourSelect);
    row.appendChild(sep);
    row.appendChild(minuteSelect);
    row.appendChild(ampmSelect);
    section.appendChild(row);

    // Ver el comentario equivalente en enhanceCustomTimePicker: un <select>
    // nativo aquí genera, al elegir una opción, un click "fantasma" sin
    // relación real con el panel, que ningún listener de "click afuera"
    // puede filtrar por su destino. Se reemplaza por el menú propio de
    // enhanceCustomSelect (sin desplegable nativo) para quitar el problema
    // de raíz.
    if (typeof enhanceCustomSelect === 'function') {
      enhanceCustomSelect(hourSelect);
      enhanceCustomSelect(minuteSelect);
      enhanceCustomSelect(ampmSelect);
    }
    return section;
  }

  function renderHeader(titleText, onPrev, onNext, onTitleClick) {
    const header = document.createElement('div');
    header.className = 'custom-date-header';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'custom-date-nav-btn';
    prevBtn.title = 'Anterior';
    prevBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    prevBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPrev(); });

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'custom-date-title-btn';
    titleBtn.textContent = titleText;
    if (onTitleClick) {
      titleBtn.title = 'Ver más años';
      titleBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onTitleClick(); });
    } else {
      titleBtn.disabled = true;
    }

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'custom-date-nav-btn';
    nextBtn.title = 'Siguiente';
    nextBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    nextBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onNext(); });

    header.appendChild(prevBtn);
    header.appendChild(titleBtn);
    header.appendChild(nextBtn);
    return header;
  }

  function renderFooter() {
    const footer = document.createElement('div');
    footer.className = 'custom-date-footer';

    const clearFooterBtn = document.createElement('button');
    clearFooterBtn.type = 'button';
    clearFooterBtn.className = 'custom-date-footer-btn is-clear';
    clearFooterBtn.textContent = 'Borrar';
    clearFooterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      inputEl.value = '';
      updateTriggerText();
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      closePanel();
    });

    const todayFooterBtn = document.createElement('button');
    todayFooterBtn.type = 'button';
    todayFooterBtn.className = 'custom-date-footer-btn is-today';
    todayFooterBtn.textContent = 'Hoy';
    todayFooterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const iso = formatIsoCustomDate(todayParsed.year, todayParsed.month, todayParsed.day);
      if (isDisabledIso(iso)) return;
      if (isDateTime) {
        // "Hoy" en modo fecha+hora es una acción decisiva completa: fecha
        // Y hora actuales, y cierra — a diferencia de picar un día suelto
        // en la grilla, que deja el panel abierto para ajustar la hora.
        const rightNow = new Date();
        selectedHour24 = rightNow.getHours();
        selectedMinute = rightNow.getMinutes();
      }
      selectDate(todayParsed.year, todayParsed.month, todayParsed.day);
      if (isDateTime) closePanel();
    });

    footer.appendChild(clearFooterBtn);
    footer.appendChild(todayFooterBtn);

    if (isDateTime) {
      const acceptFooterBtn = document.createElement('button');
      acceptFooterBtn.type = 'button';
      acceptFooterBtn.className = 'custom-date-footer-btn is-accept';
      acceptFooterBtn.textContent = 'Aceptar';
      acceptFooterBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      });
      footer.appendChild(acceptFooterBtn);
    }
    return footer;
  }

  function renderDaysView() {
    panel.innerHTML = '';
    const titleText = `${CUSTOM_DATE_MONTHS_FULL[viewMonth - 1]} de ${viewYear}`;
    panel.appendChild(renderHeader(titleText, () => {
      viewMonth -= 1;
      if (viewMonth < 1) { viewMonth = 12; viewYear -= 1; }
      renderDaysView();
    }, () => {
      viewMonth += 1;
      if (viewMonth > 12) { viewMonth = 1; viewYear += 1; }
      renderDaysView();
    }, () => {
      view = 'months';
      renderMonthsView();
    }));

    const weekdaysRow = document.createElement('div');
    weekdaysRow.className = 'custom-date-weekdays';
    CUSTOM_DATE_WEEKDAYS.forEach((d) => {
      const span = document.createElement('span');
      span.textContent = d;
      weekdaysRow.appendChild(span);
    });
    panel.appendChild(weekdaysRow);

    const grid = document.createElement('div');
    grid.className = 'custom-date-days-grid';

    const startOffset = new Date(viewYear, viewMonth - 1, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
    const prevMonthDays = new Date(viewYear, viewMonth - 1, 0).getDate();

    const selected = currentSelected();
    const cells = [];
    for (let i = 0; i < startOffset; i++) {
      const day = prevMonthDays - startOffset + 1 + i;
      let y = viewYear, m = viewMonth - 1;
      if (m < 1) { m = 12; y -= 1; }
      cells.push({ year: y, month: m, day, otherMonth: true });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({ year: viewYear, month: viewMonth, day, otherMonth: false });
    }
    let nextDay = 1;
    while (cells.length < 42) {
      let y = viewYear, m = viewMonth + 1;
      if (m > 12) { m = 1; y += 1; }
      cells.push({ year: y, month: m, day: nextDay, otherMonth: true });
      nextDay++;
    }

    cells.forEach((cell) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'custom-date-day';
      btn.textContent = String(cell.day);
      if (cell.otherMonth) btn.classList.add('is-other-month');

      const iso = formatIsoCustomDate(cell.year, cell.month, cell.day);
      const disabled = isDisabledIso(iso);
      if (disabled) btn.classList.add('is-disabled');

      if (cell.year === todayParsed.year && cell.month === todayParsed.month && cell.day === todayParsed.day) {
        btn.classList.add('is-today');
      }
      if (selected && cell.year === selected.year && cell.month === selected.month && cell.day === selected.day) {
        btn.classList.add('is-selected');
      }

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        if (cell.otherMonth) {
          viewYear = cell.year;
          viewMonth = cell.month;
        }
        selectDate(cell.year, cell.month, cell.day);
      });

      grid.appendChild(btn);
    });

    panel.appendChild(grid);

    // Hora se dibuja DEBAJO del calendario a pedido — OJO: antes vivía acá
    // mismo y se movió arriba del calendario porque, con el panel a su
    // altura máxima (max-height, ver CSS) y la grilla completa de 6 semanas
    // encima, Hora quedaba fuera de la vista inicial sin hacer scroll; sin
    // verla, el usuario volvía a hacer clic sobre el propio campo (el
    // trigger) pensando que ahí se cambiaba la hora, y como ya estaba
    // abierto ese clic lo cerraba (toggle normal) — se sentía como "el
    // panel se cierra solo al tocar la hora". Si vuelve a pasar eso en
    // pantallas bajas, revisar aquí primero.
    const timeSectionBottom = renderTimeSection();
    if (timeSectionBottom) panel.appendChild(timeSectionBottom);

    panel.appendChild(renderFooter());
  }

  function renderMonthsView() {
    panel.innerHTML = '';
    panel.appendChild(renderHeader(String(viewYear), () => {
      viewYear -= 1;
      renderMonthsView();
    }, () => {
      viewYear += 1;
      renderMonthsView();
    }, () => {
      view = 'years';
      yearsPageStart = viewYear - (viewYear % 12);
      renderYearsView();
    }));

    const grid = document.createElement('div');
    grid.className = 'custom-date-months-grid';
    const selected = currentSelected();

    CUSTOM_DATE_MONTHS_SHORT.forEach((label, idx) => {
      const monthNum = idx + 1;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'custom-date-cell';
      btn.textContent = label;

      if (viewYear === todayParsed.year && monthNum === todayParsed.month) {
        btn.classList.add('is-today');
      }
      if (selected && viewYear === selected.year && monthNum === selected.month) {
        btn.classList.add('is-selected');
      }

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        viewMonth = monthNum;
        view = 'days';
        renderDaysView();
      });

      grid.appendChild(btn);
    });

    panel.appendChild(grid);
  }

  // Vista de años: 12 por página — pensada para llegar rápido a un año
  // lejano (paciente adulto/mayor) sin depender de retroceder mes a mes.
  function renderYearsView() {
    panel.innerHTML = '';
    const rangeLabel = `${yearsPageStart} - ${yearsPageStart + 11}`;
    panel.appendChild(renderHeader(rangeLabel, () => {
      yearsPageStart -= 12;
      renderYearsView();
    }, () => {
      yearsPageStart += 12;
      renderYearsView();
    }, null));

    const grid = document.createElement('div');
    grid.className = 'custom-date-years-grid';
    const selected = currentSelected();

    for (let i = 0; i < 12; i++) {
      const yearNum = yearsPageStart + i;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'custom-date-cell';
      btn.textContent = String(yearNum);

      if (yearNum === todayParsed.year) btn.classList.add('is-today');
      if (selected && yearNum === selected.year) btn.classList.add('is-selected');

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        viewYear = yearNum;
        view = 'months';
        renderMonthsView();
      });

      grid.appendChild(btn);
    }

    panel.appendChild(grid);
  }

  function renderCurrentView() {
    if (view === 'months') renderMonthsView();
    else if (view === 'years') renderYearsView();
    else renderDaysView();
  }

  // Ancla el panel junto al trigger en coordenadas de viewport
  // (position:fixed), a partir de su rect real — abre hacia abajo por
  // default, o hacia arriba si no cabe abajo pero sí arriba. Sin ningún
  // ajuste de scroll: eso provocaba saltos de página no deseados. Si no
  // hay espacio ni arriba ni abajo, se acomoda lo mejor posible (puede
  // tapar contenido cercano) en vez de mover la página sola.
  function positionPanelFixed() {
    const rect = trigger.getBoundingClientRect();
    const panelWidth = 300;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - panelWidth - 8);
    panel.style.position = 'fixed';
    panel.style.left = `${left}px`;
    const panelHeight = panel.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    let top;
    if (spaceBelow < panelHeight + 10 && spaceAbove > spaceBelow) {
      top = Math.max(8, rect.top - panelHeight - 6);
    } else {
      top = rect.bottom + 6;
    }
    top = Math.min(top, Math.max(8, window.innerHeight - panelHeight - 8));
    panel.style.top = `${top}px`;
  }

  function openPanel() {
    if (inputEl.disabled) return;
    closeAllCustomDatePickers(wrapper);
    closeAllCustomSelects();

    if (isDateTime) syncTimeFromValue();
    const selected = currentSelected();
    if (selected) {
      viewYear = selected.year;
      viewMonth = selected.month;
    } else {
      viewYear = todayParsed.year;
      viewMonth = todayParsed.month;
    }
    view = 'days';
    yearsPageStart = viewYear - (viewYear % 12);
    renderCurrentView();

    wrapper.classList.add('is-open');
    // Portal: se reubica el panel como hijo directo de <body> ANTES de
    // hacerlo visible (is-open-self más abajo) — esta nota se abre dentro
    // de un modal con su propio scroll (.modal-body). Si el panel se hace
    // visible/300px ANTES de sacarlo de ahí, aunque sea position:absolute
    // (fuera del flujo normal), su aparición dentro de .modal-body le
    // reseteaba el scrollTop a 0 (confirmado con logs: saltaba de 434 a 0
    // justo al agregar la clase, antes de este appendChild). Portando
    // primero y volviéndolo visible ya afuera, nunca llega a tocar el
    // layout/scroll del modal.
    document.body.appendChild(panel);
    panel.classList.add('is-open-self');
    // Se posiciona en coordenadas de viewport (position:fixed) a partir del
    // rect real del trigger — una vez ya (para no depender de scroll) y
    // otra vez un frame después (la transición CSS de apertura todavía no
    // arrancó en este mismo tick, así que la altura medida podía salir mal
    // la primera vez). Sin ningún scrollIntoView.
    positionPanelFixed();
    requestAnimationFrame(() => positionPanelFixed());

    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        p.classList.add('has-open-select');
        p.style.overflow = 'visible';
      }
      p = p.parentElement;
    }
  }

  function closePanel() {
    wrapper.classList.remove('is-open');
    panel.classList.remove('is-open-self');
    wrapper.appendChild(panel);
    panel.style.position = '';
    panel.style.top = '';
    panel.style.left = '';

    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        if (!p.querySelector('.custom-select-container.is-open, .custom-date-container.is-open')) {
          p.classList.remove('has-open-select');
          p.style.overflow = '';
        }
      }
      p = p.parentElement;
    }
  }

  // Solo abre — nunca cierra por sí mismo. Antes hacía toggle (abrir/cerrar
  // con el mismo botón), pero en un campo fecha+hora, con el panel abierto
  // justo debajo/encima de este trigger, un clic destinado al selector de
  // Hora del panel (ej. apuntando a la parte de la hora que ya se muestra
  // en el propio texto del trigger, como "...11:11 p.m.") caía de vuelta
  // sobre este mismo botón y lo cerraba de golpe — dando la sensación de
  // "se cierra solo al tocar la hora". Cerrar sigue funcionando por las
  // otras vías: clic afuera (listener global), Escape, elegir un día (modo
  // solo fecha) o "Aceptar" (modo fecha+hora).
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!wrapper.classList.contains('is-open')) {
      openPanel();
    }
  });

  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // openPanel() ya se niega a abrir el calendario si inputEl.disabled —
    // pero este botón "x" es un <span>, no un control de formulario, así
    // que nada bloqueaba nativamente su click: con la sección bloqueada
    // (ej. "Información General" antes de tocar "Editar"), se podía borrar
    // la fecha con un solo clic sin habilitar nada.
    if (inputEl.disabled) return;
    inputEl.value = '';
    updateTriggerText();
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  });

  wrapper.__closeCustomDatePicker = closePanel;
}

function parseIsoCustomTimeOnly(value) {
  const m = /^(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

// Elegir una opción de los <select> nativos de hora/minuto/a.m.-p.m. de
// este panel (ver renderPanel en enhanceCustomTimePicker) genera, al
// cerrarse el propio desplegable nativo del navegador, un evento "click"
// cuyo target termina siendo un elemento sin ninguna relación real con el
// picker (no un descendiente de .custom-date-container ni del modal) — así
// que ningún chequeo basado en el target del click (closest(), etc.) puede
// distinguirlo de un click genuino "fuera" del picker. Se usa una bandera
// por tiempo en su lugar: cualquier listener de "click afuera cierra esto"
// (el propio picker, el modal de Registro Clínico, etc.) debe revisar esta
// marca de tiempo y no cerrar nada mientras siga vigente.
let clivoraSuppressOutsideCloseUntil = 0;
function clivoraMarkRecentNativeSelectInteraction() {
  clivoraSuppressOutsideCloseUntil = Date.now() + 400;
}

function enhanceCustomTimePicker(inputEl) {
  if (!inputEl || inputEl.dataset.customEnhanced === 'true') return;
  if (inputEl.tagName !== 'INPUT' || inputEl.type !== 'time') return;

  inputEl.dataset.customEnhanced = 'true';
  inputEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-date-container';
  if (inputEl.disabled) wrapper.classList.add('disabled');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-date-trigger';
  trigger.tabIndex = 0;
  if (inputEl.disabled) trigger.disabled = true;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'custom-date-icon';
  iconSpan.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-date-label';

  const clearBtn = document.createElement('span');
  clearBtn.className = 'custom-date-clear btn-anim-lift';
  clearBtn.title = 'Borrar hora';
  clearBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function currentSelected() {
    return parseIsoCustomTimeOnly(inputEl.value);
  }

  function updateTriggerText() {
    const parsed = currentSelected();
    if (parsed) {
      const { hour12, isPM } = to12HourCustomDate(parsed.hour);
      labelSpan.textContent = `${pad2CustomDate(hour12)}:${pad2CustomDate(parsed.minute)} ${isPM ? 'p.m.' : 'a.m.'}`;
      trigger.classList.remove('is-placeholder');
      clearBtn.style.display = 'flex';
    } else {
      labelSpan.textContent = inputEl.placeholder || '--:-- -----';
      trigger.classList.add('is-placeholder');
      clearBtn.style.display = 'none';
    }
    if (inputEl.disabled) {
      wrapper.classList.add('disabled');
      trigger.disabled = true;
    } else {
      wrapper.classList.remove('disabled');
      trigger.disabled = false;
    }
  }

  trigger.appendChild(iconSpan);
  trigger.appendChild(labelSpan);
  trigger.appendChild(clearBtn);
  wrapper.appendChild(trigger);

  // Refuerzo contra el listener global de "clic afuera" (ver
  // document.addEventListener('click', ...) más abajo en este archivo): por
  // alguna razón que no se pudo aislar de forma determinística (probable
  // interacción entre el portal a <body> y el re-render del calendario en
  // medio del gesto de clic), un clic apuntado al selector de Hora/Minuto/
  // a.m.-p.m. de este mismo panel a veces llegaba a ese listener con un
  // e.target que ya no calzaba ni con .custom-date-container ni con
  // .custom-date-panel, cerrando el panel entero a media interacción (ver
  // conversación/video de soporte). mousedown ocurre ANTES que click, así
  // que refrescar aquí la misma ventana de supresión que ya usa
  // clivoraMarkRecentNativeSelectInteraction cubre a tiempo al click que le
  // sigue, sin importar dónde termine "cayendo" según el navegador.
  const __refreshOutsideCloseSuppression = () => { clivoraSuppressOutsideCloseUntil = Date.now() + 2000; };
  wrapper.addEventListener('mousedown', __refreshOutsideCloseSuppression);

  const panel = document.createElement('div');
  panel.className = 'custom-date-panel';
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', __refreshOutsideCloseSuppression);
  // Ver el comentario equivalente en enhanceCustomDatePicker: el panel se
  // porta a <body> al abrirse, así que su .custom-date-container original
  // deja de ser su ancestro — esta referencia de vuelta es lo único que le
  // permite a enhanceCustomSelect (selector de Hora/Minuto/a.m.-p.m. de
  // este mismo panel) ubicarlo para no cerrarse a sí mismo al abrir su
  // propio menú.
  panel.__ownerContainer = wrapper;
  wrapper.appendChild(panel);

  if (inputEl.parentNode) {
    inputEl.parentNode.insertBefore(wrapper, inputEl.nextSibling);
  }

  updateTriggerText();

  const attrObserver = new MutationObserver(() => updateTriggerText());
  attrObserver.observe(inputEl, { attributes: true, attributeFilter: ['disabled'] });

  if (inputEl.form) {
    inputEl.form.addEventListener('reset', () => setTimeout(updateTriggerText, 0));
  }
  // stopPropagation: ver el comentario equivalente en enhanceCustomDatePicker.
  inputEl.addEventListener('change', (e) => { e.stopPropagation(); updateTriggerText(); });

  let selectedHour24 = new Date().getHours();
  let selectedMinute = new Date().getMinutes();

  function syncFromValue() {
    const parsed = currentSelected();
    const rightNow = new Date();
    selectedHour24 = parsed ? parsed.hour : rightNow.getHours();
    selectedMinute = parsed ? parsed.minute : rightNow.getMinutes();
  }

  function commitTime() {
    inputEl.value = `${pad2CustomDate(selectedHour24)}:${pad2CustomDate(selectedMinute)}`;
    updateTriggerText();
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const containerClasses = ['nopat-card', 'form-group', 'accordion-content', 'accordion-item', 'onco-accordion-content', 'onco-accordion-item', 'patient-create-section', 'nc-block-card'];

  function renderPanel() {
    panel.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'custom-date-time-row';

    const { hour12, isPM } = to12HourCustomDate(selectedHour24);

    // Antes hourSelect/minuteSelect/ampmSelect eran <select> (nativos o,
    // en un intento posterior, reemplazados por el menú de
    // enhanceCustomSelect) — cualquiera de los dos abre un popup ANIDADO
    // DENTRO de este panel, que ya de por sí flota con position:fixed sobre
    // un modal. Esa combinación (popup dentro de popup dentro de modal)
    // terminaba con los clics del popup interno aterrizando en el fondo del
    // modal en vez de en la opción elegida — nunca se pudo aislar la causa
    // exacta pese a varios intentos, así que se quita el problema de raíz
    // evitando cualquier popup anidado: hora y minuto son inputs numéricos
    // normales (con flechitas nativas del navegador) y a.m./p.m. son dos
    // botones simples, nada de esto abre ningún desplegable propio.
    const hourInput = document.createElement('input');
    hourInput.type = 'number';
    hourInput.min = '1';
    hourInput.max = '12';
    hourInput.className = 'custom-date-time-input';
    hourInput.setAttribute('aria-label', 'Hora');
    hourInput.value = String(hour12);

    const minuteInput = document.createElement('input');
    minuteInput.type = 'number';
    minuteInput.min = '0';
    minuteInput.max = '59';
    minuteInput.className = 'custom-date-time-input';
    minuteInput.setAttribute('aria-label', 'Minuto');
    minuteInput.value = pad2CustomDate(selectedMinute);

    const ampmToggle = document.createElement('div');
    ampmToggle.className = 'custom-date-ampm-toggle';
    let currentIsPM = isPM;
    const amBtn = document.createElement('button');
    amBtn.type = 'button';
    amBtn.textContent = 'a.m.';
    amBtn.className = 'custom-date-ampm-btn btn-anim-lift' + (currentIsPM ? '' : ' active');
    const pmBtn = document.createElement('button');
    pmBtn.type = 'button';
    pmBtn.textContent = 'p.m.';
    pmBtn.className = 'custom-date-ampm-btn btn-anim-lift' + (currentIsPM ? ' active' : '');
    ampmToggle.appendChild(amBtn);
    ampmToggle.appendChild(pmBtn);

    const onTimeChange = () => {
      let h12 = parseInt(hourInput.value, 10);
      if (Number.isNaN(h12) || h12 < 1) h12 = 1;
      if (h12 > 12) h12 = 12;
      hourInput.value = String(h12);
      let m = parseInt(minuteInput.value, 10);
      if (Number.isNaN(m) || m < 0) m = 0;
      if (m > 59) m = 59;
      minuteInput.value = pad2CustomDate(m);
      selectedHour24 = to24HourCustomDate(h12, currentIsPM);
      selectedMinute = m;
      commitTime();
    };
    hourInput.addEventListener('change', (e) => { e.stopPropagation(); onTimeChange(); });
    minuteInput.addEventListener('change', (e) => { e.stopPropagation(); onTimeChange(); });
    amBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      currentIsPM = false;
      amBtn.classList.add('active');
      pmBtn.classList.remove('active');
      onTimeChange();
    });
    pmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      currentIsPM = true;
      pmBtn.classList.add('active');
      amBtn.classList.remove('active');
      onTimeChange();
    });

    const sep = document.createElement('span');
    sep.className = 'custom-date-time-sep';
    sep.textContent = ':';

    row.appendChild(hourInput);
    row.appendChild(sep);
    row.appendChild(minuteInput);
    row.appendChild(ampmToggle);
    panel.appendChild(row);

    const footer = document.createElement('div');
    footer.className = 'custom-date-footer';

    const clearFooterBtn = document.createElement('button');
    clearFooterBtn.type = 'button';
    clearFooterBtn.className = 'custom-date-footer-btn is-clear btn-anim-lift';
    clearFooterBtn.textContent = 'Borrar';
    clearFooterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      inputEl.value = '';
      updateTriggerText();
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      closePanel();
    });

    const nowFooterBtn = document.createElement('button');
    nowFooterBtn.type = 'button';
    nowFooterBtn.className = 'custom-date-footer-btn is-today btn-anim-lift';
    nowFooterBtn.textContent = 'Ahora';
    nowFooterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rightNow = new Date();
      selectedHour24 = rightNow.getHours();
      selectedMinute = rightNow.getMinutes();
      commitTime();
      closePanel();
    });

    // El cambio de hora/minuto/am-pm ya guarda en vivo (commitTime en cada
    // "change"), pero el panel se quedaba abierto hasta hacer clic afuera —
    // este botón deja explícito "ya elegí la hora que quería" y cierra el
    // panel, igual que Borrar/Ahora.
    const confirmFooterBtn = document.createElement('button');
    confirmFooterBtn.type = 'button';
    confirmFooterBtn.className = 'custom-date-footer-btn is-accept btn-anim-lift';
    confirmFooterBtn.textContent = 'Confirmar';
    confirmFooterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      commitTime();
      closePanel();
    });

    footer.appendChild(clearFooterBtn);
    footer.appendChild(nowFooterBtn);
    footer.appendChild(confirmFooterBtn);
    panel.appendChild(footer);
  }

  // Ancla el panel junto al trigger en coordenadas de viewport
  // (position:fixed), a partir de su rect real — abre hacia abajo por
  // default, o hacia arriba si no cabe abajo pero sí arriba. Sin ningún
  // ajuste de scroll: eso provocaba saltos de página no deseados. Si no
  // hay espacio ni arriba ni abajo, se acomoda lo mejor posible (puede
  // tapar contenido cercano) en vez de mover la página sola.
  function positionPanelFixed() {
    const rect = trigger.getBoundingClientRect();
    const panelWidth = 300;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - panelWidth - 8);
    panel.style.position = 'fixed';
    panel.style.left = `${left}px`;
    const panelHeight = panel.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    let top;
    if (spaceBelow < panelHeight + 10 && spaceAbove > spaceBelow) {
      top = Math.max(8, rect.top - panelHeight - 6);
    } else {
      top = rect.bottom + 6;
    }
    top = Math.min(top, Math.max(8, window.innerHeight - panelHeight - 8));
    panel.style.top = `${top}px`;
  }

  function openPanel() {
    if (inputEl.disabled) return;
    closeAllCustomDatePickers(wrapper);
    closeAllCustomSelects();
    syncFromValue();
    renderPanel();
    wrapper.classList.add('is-open');
    // Portal: se reubica el panel como hijo directo de <body> ANTES de
    // hacerlo visible (is-open-self más abajo) — esta nota se abre dentro
    // de un modal con su propio scroll (.modal-body). Si el panel se hace
    // visible/300px ANTES de sacarlo de ahí, aunque sea position:absolute
    // (fuera del flujo normal), su aparición dentro de .modal-body le
    // reseteaba el scrollTop a 0 (confirmado con logs: saltaba de 434 a 0
    // justo al agregar la clase, antes de este appendChild). Portando
    // primero y volviéndolo visible ya afuera, nunca llega a tocar el
    // layout/scroll del modal.
    document.body.appendChild(panel);
    panel.classList.add('is-open-self');
    // Se posiciona en coordenadas de viewport (position:fixed) a partir del
    // rect real del trigger — una vez ya (para no depender de scroll) y
    // otra vez un frame después (la transición CSS de apertura todavía no
    // arrancó en este mismo tick, así que la altura medida podía salir mal
    // la primera vez). Sin ningún scrollIntoView.
    positionPanelFixed();
    requestAnimationFrame(() => positionPanelFixed());

    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        p.classList.add('has-open-select');
        p.style.overflow = 'visible';
      }
      p = p.parentElement;
    }
  }

  function closePanel() {
    wrapper.classList.remove('is-open');
    panel.classList.remove('is-open-self');
    wrapper.appendChild(panel);
    panel.style.position = '';
    panel.style.top = '';
    panel.style.left = '';
    let p = wrapper.parentElement;
    while (p && p !== document.body) {
      if (containerClasses.some((cls) => p.classList.contains(cls))) {
        if (!p.querySelector('.custom-select-container.is-open, .custom-date-container.is-open')) {
          p.classList.remove('has-open-select');
          p.style.overflow = '';
        }
      }
      p = p.parentElement;
    }
  }

  // Solo abre — nunca cierra por sí mismo. Antes hacía toggle (abrir/cerrar
  // con el mismo botón), pero en un campo fecha+hora, con el panel abierto
  // justo debajo/encima de este trigger, un clic destinado al selector de
  // Hora del panel (ej. apuntando a la parte de la hora que ya se muestra
  // en el propio texto del trigger, como "...11:11 p.m.") caía de vuelta
  // sobre este mismo botón y lo cerraba de golpe — dando la sensación de
  // "se cierra solo al tocar la hora". Cerrar sigue funcionando por las
  // otras vías: clic afuera (listener global), Escape, elegir un día (modo
  // solo fecha) o "Aceptar" (modo fecha+hora).
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!wrapper.classList.contains('is-open')) {
      openPanel();
    }
  });

  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // openPanel() ya se niega a abrir el calendario si inputEl.disabled —
    // pero este botón "x" es un <span>, no un control de formulario, así
    // que nada bloqueaba nativamente su click: con la sección bloqueada
    // (ej. "Información General" antes de tocar "Editar"), se podía borrar
    // la fecha con un solo clic sin habilitar nada.
    if (inputEl.disabled) return;
    inputEl.value = '';
    updateTriggerText();
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  });

  wrapper.__closeCustomDatePicker = closePanel;
}

function closeAllCustomDatePickers(exceptWrapper = null) {
  document.querySelectorAll('.custom-date-container.is-open').forEach((container) => {
    if (container !== exceptWrapper && typeof container.__closeCustomDatePicker === 'function') {
      container.__closeCustomDatePicker();
    }
  });
}

// Antes cerraba con CUALQUIER click en el documento, confiando en que
// panel.addEventListener('click', stopPropagation) detuviera los clics de
// adentro — pero elegir una opción de un <select> nativo (hora/minuto/
// am-pm dentro del panel) no siempre dispara ese click de forma confiable
// a través de ese mismo elemento en todos los navegadores, así que el
// panel se cerraba solo con elegir un valor. Ahora se revisa directamente
// si el click cayó dentro de algún .custom-date-container (trigger, panel
// o sus selects) antes de cerrar nada.
document.addEventListener('click', (e) => {
  if (Date.now() < clivoraSuppressOutsideCloseUntil) return;
  if (e.target.closest('.custom-date-container') || e.target.closest('.custom-date-panel')) return;
  closeAllCustomDatePickers();
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Escape') closeAllCustomDatePickers();
});

// El panel del calendario/hora se "porta" a <body> (fuera del modal), así que
// si un modal se cierra con el panel abierto (p. ej. guardar la cita con la
// hora desplegada) el panel se quedaba flotando sobre la pantalla. Cuando un
// modal deja de verse, se cierran los selectores que quedaron abiertos y ya
// no están visibles.
function closeHiddenCustomDatePickers() {
  document.querySelectorAll('.custom-date-container.is-open').forEach((container) => {
    if (container.offsetParent === null && typeof container.__closeCustomDatePicker === 'function') {
      container.__closeCustomDatePicker();
    }
  });
}
new MutationObserver((mutations) => {
  if (!document.querySelector('.custom-date-container.is-open')) return;
  if (mutations.some(m => m.target.classList && (m.target.classList.contains('modal-overlay') || m.target.classList.contains('modal')))) {
    requestAnimationFrame(closeHiddenCustomDatePickers);
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

function initAllCustomDatePickers() {
  document.querySelectorAll('input[type="date"], input[type="datetime-local"]').forEach((inp) => {
    enhanceCustomDatePicker(inp);
  });
  document.querySelectorAll('input[type="time"]').forEach((inp) => {
    enhanceCustomTimePicker(inp);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initAllCustomDatePickers();
});

setTimeout(() => {
  initAllCustomDatePickers();
}, 300);

const clivoraDatePickerObserver = new MutationObserver(() => {
  initAllCustomDatePickers();
});

document.addEventListener('DOMContentLoaded', () => {
  if (document.body) {
    clivoraDatePickerObserver.observe(document.body, { childList: true, subtree: true });
  }
});

