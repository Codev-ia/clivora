// Utilidades comunes de las pantallas nuevas de Clivora (Farmacia y
// Configuración): llamadas a la API con CSRF, modales, formularios, formatos
// y permisos del usuario (/api/me). Expuestas en window.ClivoraUI.
(function () {
  'use strict';

  const API = '/api/v1';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? ''));

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function errorMessage(data, fallback) {
    if (!data) return fallback;
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) return data.map((d) => errorMessage(d, '')).filter(Boolean).join(' ');
    if (data.detail) return errorMessage(data.detail, fallback);
    return Object.entries(data)
      .map(([field, msg]) => (field === 'non_field_errors' ? '' : `${field}: `) + errorMessage(msg, ''))
      .join(' · ') || fallback;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const options = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    if (method !== 'GET') options.headers['X-CSRFToken'] = csrfToken();
    const response = await fetch(path.startsWith('/') ? path : `${API}/${path}`, options);
    if (response.status === 204) return null;
    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok) {
      const msg = response.status === 403
        ? 'No tienes permiso para realizar esta acción.'
        : errorMessage(data, `Error ${response.status}`);
      throw new Error(msg);
    }
    return data;
  }

  function alertError(error, title) {
    console.error(error);
    if (typeof showClivoraAlertModal === 'function') showClivoraAlertModal(error.message || String(error), title);
    else window.alert(error.message || String(error));
  }

  function query(params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) qs.set(k, v); });
    return qs.toString();
  }

  // Siempre con centavos (formatMoneyMXN de app.js redondea a pesos enteros,
  // pensado para los totales del Inicio).
  function money(value) {
    return Number(value || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  function qty(value) {
    return Number(value || 0).toLocaleString('es-MX', { maximumFractionDigits: 4 });
  }

  function dateShort(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }

  function dateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function debounce(fn, ms = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function openModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.add('open');
    m.style.display = 'flex';
  }

  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.remove('open');
    m.style.display = 'none';
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = label || 'Guardando…';
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  function emptyRow(colspan, text) {
    return `<tr class="inv-empty"><td colspan="${colspan}">${esc(text)}</td></tr>`;
  }

  function fillSelect(select, items, { value = 'id', label = 'name', placeholder = null, selected = '' } = {}) {
    if (!select) return;
    const opts = placeholder !== null ? [`<option value="">${esc(placeholder)}</option>`] : [];
    items.forEach((it) => {
      const v = typeof value === 'function' ? value(it) : it[value];
      const l = typeof label === 'function' ? label(it) : it[label];
      opts.push(`<option value="${esc(v)}">${esc(l)}</option>`);
    });
    select.innerHTML = opts.join('');
    const hasSelected = selected !== null && selected !== undefined && selected !== '';
    // Sin opción vacía ni valor pedido, se queda con la primera opción.
    if (hasSelected) select.value = String(selected);
    else if (placeholder !== null) select.value = '';
  }

  // Lee/llena un <form> con nombres de campo iguales a los de la API.
  function formValues(form) {
    const data = {};
    form.querySelectorAll('[name]').forEach((el) => {
      if (el.type === 'checkbox') data[el.name] = el.checked;
      else if (el.type === 'number') data[el.name] = el.value === '' ? null : el.value;
      else if (el.tagName === 'SELECT' || el.type === 'hidden') data[el.name] = el.value === '' ? null : el.value;
      else data[el.name] = el.value;
    });
    return data;
  }

  function fillForm(form, data) {
    form.querySelectorAll('[name]').forEach((el) => {
      const v = data[el.name];
      // Casillas con varios valores (roles, clínicas): marcada solo si su
      // value está en la lista. Antes cualquier lista contaba como "true" y
      // se marcaban todas.
      if (el.type === 'checkbox' && Array.isArray(v)) el.checked = v.map(String).includes(el.value);
      else if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'date') el.value = v ? String(v).slice(0, 10) : '';
      else el.value = v === null || v === undefined ? '' : v;
      // Los selectores y fechas de Clivora (enhanceCustomSelect /
      // enhanceCustomDatePicker en app.js) solo refrescan lo que muestran al
      // recibir "change"; asignar .value por código no lo dispara.
      if (el.tagName === 'SELECT' || el.type === 'date') el.dispatchEvent(new Event('change'));
    });
  }

  function setPager(prefix, page, count, pageSize) {
    const pager = $(`${prefix}Pager`);
    const label = $(`${prefix}PagerLabel`);
    if (!pager) return;
    const pages = Math.max(1, Math.ceil(count / pageSize));
    pager.style.display = pages > 1 ? 'flex' : 'none';
    if (label) label.textContent = `Página ${page} de ${pages}`;
    pager.dataset.pages = pages;
  }


  // Perfil y permisos del usuario (/clivora/api/me), pedido una sola vez.
  let mePromise = null;
  function loadMe() {
    if (!mePromise) mePromise = api('/clivora/api/me').catch(() => ({}));
    return mePromise;
  }

  async function confirmDialog(message, title) {
    if (typeof showClivoraConfirmModal === 'function') return showClivoraConfirmModal(message, title);
    return window.confirm(message);
  }

  // Ejecuta loader la primera vez que la pantalla (#id) se vuelve visible
  // y cada vez que se regresa a ella.
  function watchView(id, loader) {
    const view = $(id);
    if (!view) return;
    let wasActive = false;
    const check = () => {
      const active = view.classList.contains('active-view');
      if (active && !wasActive) loader();
      wasActive = active;
    };
    new MutationObserver(check).observe(view, { attributes: true, attributeFilter: ['class'] });
    check();
  }

  window.ClivoraUI = {
    API, $, esc, api, alertError, query, money, qty, dateShort, dateTime, debounce, openModal, closeModal,
    setBusy, emptyRow, fillSelect, formValues, fillForm, setPager, loadMe, confirmDialog, watchView,
  };
}());
