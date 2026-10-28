// Estructura visual de Clivora: menú principal en pastillas, usuario en la
// barra superior y ficha del paciente a dos columnas.
//
// El menú lateral (#sidebar) se queda en la página, oculto: app.js y
// config.js deciden ahí qué opciones ve cada rol (style.display /
// .inv-hidden) y cuál está activa (.active), y sus clics cambian de vista.
// Este archivo solo refleja ese estado en las pastillas y les pasa los clics.
(function () {
  'use strict';

  // Orden y agrupación del menú. "items" agrupa varias vistas en un menú
  // desplegable; la etiqueta de cada opción es la del menú lateral.
  const NAV = [
    { view: 'dashboard', label: 'Inicio' },
    { view: 'pacientes', label: 'Pacientes' },
    { view: 'agenda', label: 'Agenda' },
    { view: 'tratamientos', label: 'Tratamientos' },
    { view: 'inventario', label: 'Farmacia' },
    // Oculto por ahora (la vista sigue existiendo): quitar "hidden" para mostrarlo.
    { view: 'medico', label: 'Información del Médico', hidden: true },
    { label: 'Configuración', items: ['clinicas', 'lugares', 'usuarios', 'productos', 'precios', 'sistema'] },
  ];
  // Vistas a las que se llega desde otra (no tienen pastilla propia) y la
  // pastilla que debe verse activa mientras están abiertas.
  const PARENT_VIEW = { pacienteDetail: 'pacientes', nuevoPaciente: 'pacientes' };

  const sidebar = () => document.getElementById('sidebar');
  const sidebarItem = (view) => sidebar()?.querySelector(`.nav-item[data-view="${view}"]`);

  // Visible para el rol si ni la opción ni su sección están ocultas.
  function isAllowed(item) {
    const root = sidebar();
    for (let el = item; el && el !== root; el = el.parentElement) {
      if (el.style.display === 'none' || el.classList.contains('inv-hidden')) return false;
    }
    return Boolean(item);
  }

  function activeView() {
    const activeItem = sidebar()?.querySelector('.nav-item.active');
    if (activeItem) return activeItem.dataset.view;
    const activePage = document.querySelector('.page-view.active-view');
    const id = activePage ? activePage.id.replace(/View$/, '') : '';
    return PARENT_VIEW[id] || id;
  }

  function go(view) {
    const item = sidebarItem(view);
    if (item) item.click();
  }

  function labelOf(view) {
    return sidebarItem(view)?.querySelector('span')?.textContent.trim() || view;
  }

  function closeMenus(except) {
    document.querySelectorAll('.cv-nav-group.open').forEach((g) => { if (g !== except) g.classList.remove('open'); });
  }

  function renderNav() {
    const nav = document.getElementById('cvNav');
    if (!nav) return;
    const current = activeView();
    const html = [];
    NAV.forEach((entry) => {
      if (entry.hidden) return;
      if (entry.items) {
        const allowed = entry.items.filter((v) => isAllowed(sidebarItem(v)));
        if (!allowed.length) return;
        const isActive = allowed.includes(current);
        html.push(`<div class="cv-nav-group">
          <button type="button" class="cv-nav-pill${isActive ? ' active' : ''}" data-cv-menu aria-haspopup="true">${entry.label}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="cv-nav-menu" role="menu">${allowed.map((v) =>
            `<button type="button" role="menuitem" class="cv-nav-menu-item${v === current ? ' active' : ''}" data-cv-view="${v}">${labelOf(v)}</button>`).join('')}</div>
        </div>`);
        return;
      }
      if (!isAllowed(sidebarItem(entry.view))) return;
      html.push(`<button type="button" class="cv-nav-pill${entry.view === current ? ' active' : ''}" data-cv-view="${entry.view}">${entry.label}</button>`);
    });
    const markup = html.join('');
    if (nav.dataset.markup !== markup) {
      nav.innerHTML = markup;
      nav.dataset.markup = markup;
      // En celular el menú se desplaza de lado: deja visible la opción activa.
      if (nav.scrollWidth > nav.clientWidth) {
        const active = nav.querySelector('.cv-nav-pill.active');
        if (active) nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
      }
    }
  }

  let pending = false;
  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderNav(); syncUser(); });
  }

  function syncUser() {
    const name = document.getElementById('sidebarUserName')?.textContent.trim() || '';
    const role = document.getElementById('sidebarUserRole')?.textContent.trim() || '';
    const nameEl = document.getElementById('cvUserName');
    const roleEl = document.getElementById('cvUserRole');
    if (nameEl && nameEl.textContent !== name) nameEl.textContent = name === '…' ? '' : name;
    if (roleEl && roleEl.textContent !== role) roleEl.textContent = role;
  }

  // ── Ficha del paciente a dos columnas ───────────────────────────────────
  // Izquierda: encabezado (foto, nombre, expediente), datos rápidos y
  // acciones. Derecha: datos del paciente (acordeones) y expediente. Se
  // mueven los nodos ya cargados (conservan sus ids y eventos).
  function arrangePatientDetail(shell) {
    if (!shell || shell.querySelector('.cv-patient-layout')) return;
    const header = shell.querySelector(':scope > .patient-sticky-header');
    const pills = shell.querySelector(':scope > .patient-info-pills-row');
    const actions = shell.querySelector(':scope > .patient-actions-row');
    const data = shell.querySelector(':scope > .accordion-list');
    const expediente = shell.querySelector(':scope > #expedienteSection');
    if (!header || !data || !expediente) return;
    const layout = document.createElement('div');
    layout.className = 'cv-patient-layout';
    const aside = document.createElement('aside');
    aside.className = 'cv-patient-aside';
    const main = document.createElement('div');
    main.className = 'cv-patient-main';
    [header, pills, actions].forEach((el) => el && aside.appendChild(el));
    [data, expediente].forEach((el) => main.appendChild(el));
    layout.append(aside, main);
    shell.insertBefore(layout, shell.firstChild);
  }

  document.addEventListener('click', (event) => {
    const menuBtn = event.target.closest('[data-cv-menu]');
    if (menuBtn) {
      event.preventDefault();
      const group = menuBtn.closest('.cv-nav-group');
      closeMenus(group);
      group.classList.toggle('open');
      return;
    }
    const target = event.target.closest('[data-cv-view]');
    if (target) {
      event.preventDefault();
      closeMenus();
      go(target.dataset.cvView);
      return;
    }
    if (!event.target.closest('.cv-nav-group')) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const root = sidebar();
    if (root) {
      new MutationObserver(scheduleRender).observe(root, {
        subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true, characterData: true,
      });
    }
    // Vistas internas (ficha, alta de paciente) no cambian el menú lateral.
    document.querySelectorAll('.page-view').forEach((view) => {
      new MutationObserver(scheduleRender).observe(view, { attributes: true, attributeFilter: ['class'] });
    });
    const shell = document.getElementById('pacienteDetailShell');
    if (shell) {
      arrangePatientDetail(shell);
      new MutationObserver(() => arrangePatientDetail(shell)).observe(shell, { childList: true });
    }
    scheduleRender();
  });
})();
