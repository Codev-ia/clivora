// Pantallas de Farmacia: Productos, Inventario y Listas de precios.
//
// Mismo diseño que el resto de Clivora (clases de styles.css, modales,
// showClivoraAlertModal/showClivoraConfirmModal de app.js) sobre la API de la
// plataforma nueva (/api/v1/...). Se carga después de app.js; cada pantalla
// pide sus datos la primera vez que se muestra (ver watchView).
(function () {
  'use strict';

  let me = null;
  let catalogsPromise = null;
  const catalogs = { categories: [], uoms: [], clinicas: [], locations: [], aseguradoras: [] };

  const {
    $, esc, api, alertError, query, money, qty, dateShort, dateTime, debounce, openModal, closeModal,
    setBusy, emptyRow, fillSelect, formValues, fillForm, setPager, confirmDialog,
  } = window.ClivoraUI;

  // ── permisos y catálogos ────────────────────────────────────────────────
  async function loadMe() {
    me = await window.ClivoraUI.loadMe();
    const nav = $('farmaciaNavSection');
    if (nav) nav.style.display = me.canSeeInventory ? '' : 'none';
    document.querySelectorAll('.inv-manage-products').forEach((el) => el.classList.toggle('inv-hidden', !me.canManageProducts));
    document.querySelectorAll('.inv-manage-inventory').forEach((el) => el.classList.toggle('inv-hidden', !me.canManageInventory));
    document.querySelectorAll('.inv-manage-pricelists').forEach((el) => el.classList.toggle('inv-hidden', !me.canManagePricelists));
    // Sin permiso para la pantalla guardada como "última vista", regresa al Inicio.
    const active = document.querySelector('.page-view.active-view');
    if (!me.canSeeInventory && active && ['productosView', 'inventarioView', 'preciosView'].includes(active.id)
        && typeof switchView === 'function') {
      switchView('dashboard');
    }
  }

  function loadCatalogs() {
    if (!catalogsPromise) {
      catalogsPromise = Promise.all([
        api('inventario/categorias/'), api('inventario/unidades/'),
        api('inventario/ubicaciones/'), api('precios/aseguradoras/'),
      ]).then(([categories, uoms, locations, aseguradoras]) => {
        // Clínicas: las permitidas al usuario (de /api/me).
        Object.assign(catalogs, { categories, uoms, locations, aseguradoras, clinicas: me.clinicas || [] });
        return catalogs;
      }).catch((e) => { catalogsPromise = null; throw e; });
    }
    return catalogsPromise;
  }

  const internalLocations = () => catalogs.locations.filter((l) => l.usage === 'internal');
  const locationsBy = (usage) => catalogs.locations.filter((l) => l.usage === usage);

  // ── selector de producto (input + datalist con búsqueda en la API) ─────
  const pickerCache = new Map(); // etiqueta mostrada -> producto
  function productLabel(p) { return p.code ? `[${p.code}] ${p.name}` : p.name; }

  const searchProducts = debounce(async (term) => {
    try {
      const data = await api(`inventario/productos/?${query({ q: term, page_size: 20 })}`);
      const list = $('invProductOptions');
      list.innerHTML = data.results.map((p) => {
        pickerCache.set(productLabel(p), p);
        return `<option value="${esc(productLabel(p))}"></option>`;
      }).join('');
    } catch (e) { console.error(e); }
  }, 250);

  function setupPicker(input) {
    input.setAttribute('list', 'invProductOptions');
    input.addEventListener('input', () => {
      const hidden = $(input.dataset.target);
      const product = pickerCache.get(input.value);
      if (product) {
        hidden.value = product.id;
        input.dispatchEvent(new CustomEvent('inv:product', { detail: product, bubbles: true }));
      } else {
        hidden.value = '';
        if (input.value.trim().length >= 2) searchProducts(input.value.trim());
        input.dispatchEvent(new CustomEvent('inv:product', { detail: null, bubbles: true }));
      }
    });
  }

  function resetPicker(target, product) {
    const input = document.querySelector(`.inv-product-picker[data-target="${target}"]`);
    const hidden = $(target);
    if (product) {
      pickerCache.set(productLabel(product), product);
      input.value = productLabel(product);
      hidden.value = product.id;
    } else {
      input.value = '';
      hidden.value = '';
    }
  }

  // ── PRODUCTOS ───────────────────────────────────────────────────────────
  const prod = { page: 1, pageSize: 50, current: null };

  async function loadProducts() {
    const body = $('invProdBody');
    body.innerHTML = emptyRow(9, 'Cargando…');
    try {
      await loadCatalogs();
      const data = await api(`inventario/productos/?${query({
        q: $('invProdSearch').value.trim(), type: $('invProdType').value, category: $('invProdCategory').value,
        active: $('invProdActive').value, track_inventory: $('invProdOnlyStock').checked ? 1 : '',
        page: prod.page, page_size: prod.pageSize,
      })}`);
      $('invProdCount').textContent = data.count.toLocaleString('es-MX');
      setPager('invProd', prod.page, data.count, prod.pageSize);
      body.innerHTML = data.results.length ? data.results.map((p) => `
        <tr class="inv-clickable" data-product-id="${p.id}">
          <td class="inv-code">${esc(p.code)}</td>
          <td class="inv-name">${esc(p.name)}</td>
          <td><span class="badge ${p.type === 'service' ? 'badge-en_progreso' : 'badge-nuevo'}">${p.type === 'service' ? 'SERVICIO' : 'BIEN'}</span></td>
          <td class="inv-muted">${esc(p.category_name)}</td>
          <td class="inv-muted">${esc(p.uom_name)}</td>
          <td class="inv-num">${money(p.list_price)}</td>
          <td class="inv-num inv-muted">${money(p.standard_price)}</td>
          <td class="inv-num ${Number(p.qty_available) < 0 ? 'inv-negative' : ''}">${p.track_inventory ? qty(p.qty_available) : '<span class="inv-muted">—</span>'}</td>
          <td><div class="inv-actions"><button type="button" class="inv-icon-btn edit" title="Ver / editar" data-product-id="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button></div></td>
        </tr>`).join('') : emptyRow(9, 'No hay productos que coincidan con los filtros.');
    } catch (e) {
      body.innerHTML = emptyRow(9, e.message);
    }
  }

  function applyProductTypeRules(form) {
    const isService = form.type.value === 'service';
    form.track_inventory.disabled = isService;
    form.track_lots.disabled = isService || !form.track_inventory.checked;
    if (isService) { form.track_inventory.checked = false; form.track_lots.checked = false; }
    if (!form.track_inventory.checked) form.track_lots.checked = false;
  }

  async function openProduct(id) {
    try {
      await loadCatalogs();
      const form = $('invProductForm');
      fillSelect(form.category, catalogs.categories, { label: 'complete_name', placeholder: 'Sin categoría' });
      fillSelect(form.uom, catalogs.uoms, { placeholder: '—' });
      fillSelect(form.clinica, catalogs.clinicas, { placeholder: 'Todas las clínicas' });
      const p = id ? await api(`inventario/productos/${id}/`) : {
        name: '', code: '', barcode: '', type: 'goods', track_inventory: true, track_lots: false,
        sale_ok: true, active: true, list_price: '0', standard_price: '0', description: '',
      };
      prod.current = p;
      fillForm(form, p);
      applyProductTypeRules(form);
      form.classList.toggle('inv-readonly', Boolean(!me.canManageProducts));
      $('invProductModalTitle').textContent = id ? p.name : 'Nuevo producto';
      $('invProductModalSubtitle').textContent = id
        ? [p.code && `Código ${p.code}`, p.track_inventory && `Existencia: ${qty(p.qty_available)}`].filter(Boolean).join(' · ')
        : '';
      const stockBlock = $('invProductStockBlock');
      stockBlock.style.display = id && p.track_inventory ? '' : 'none';
      if (id && p.track_inventory) {
        const stock = await api(`inventario/existencias/?${query({ product: id, page_size: 200 })}`);
        $('invProductStockBody').innerHTML = stock.results.length ? stock.results.map((q) => `
          <tr><td>${esc(q.location_name)}</td><td class="inv-muted">${esc(q.lot_name)}</td>
          <td class="inv-muted">${dateShort(q.expiration_date)}</td><td class="inv-num">${qty(q.quantity)}</td></tr>`).join('')
          : emptyRow(4, 'Sin existencias.');
      }
      openModal('invProductModal');
    } catch (e) { alertError(e); }
  }

  async function saveProduct() {
    const form = $('invProductForm');
    if (!form.reportValidity()) return;
    const btn = $('invProductSaveBtn');
    const data = formValues(form);
    data.track_inventory = form.track_inventory.checked && data.type === 'goods';
    data.track_lots = form.track_lots.checked && data.track_inventory;
    setBusy(btn, true);
    try {
      const id = prod.current && prod.current.id;
      await api(id ? `inventario/productos/${id}/` : 'inventario/productos/', { method: id ? 'PATCH' : 'POST', body: data });
      closeModal('invProductModal');
      loadProducts();
    } catch (e) { alertError(e, 'No se pudo guardar el producto'); } finally { setBusy(btn, false); }
  }

  // ── INVENTARIO ──────────────────────────────────────────────────────────
  const inv = { tab: 'stock', page: 1, pageSize: 50, moveKind: 'in', moveProduct: null };

  async function loadInventoryMetrics() {
    try {
      const [summary, pending] = await Promise.all([
        api('/clivora/api/farmacia/summary'),
        api(`inventario/movimientos/?${query({ state: 'draft', page_size: 1 })}`),
      ]);
      $('invMetricIn').textContent = summary.entradasMes;
      $('invMetricOut').textContent = summary.salidasMes;
      $('invMetricStock').textContent = summary.existenciasConStock;
      $('invMetricPending').textContent = pending.count;
    } catch (e) { console.error(e); }
  }

  function setInventoryTab(tab) {
    inv.tab = tab;
    inv.page = 1;
    $('invTabStock').classList.toggle('active', tab === 'stock');
    $('invTabMoves').classList.toggle('active', tab === 'moves');
    $('invStockTable').style.display = tab === 'stock' ? '' : 'none';
    $('invMovesTable').style.display = tab === 'moves' ? '' : 'none';
    document.querySelectorAll('.inv-tab-stock').forEach((el) => { el.style.display = tab === 'stock' ? '' : 'none'; });
    document.querySelectorAll('.inv-tab-moves').forEach((el) => { el.style.display = tab === 'moves' ? '' : 'none'; });
    $('invCountLabel').textContent = tab === 'stock' ? 'existencias' : 'movimientos';
    loadInventoryList();
  }

  function expiryClass(iso) {
    if (!iso) return 'inv-muted';
    const days = (new Date(iso) - new Date()) / 86400000;
    if (days < 0) return 'inv-expired';
    if (days <= 30) return 'inv-expiring';
    return 'inv-muted';
  }

  const MOVE_BADGE = { in: 'badge-aprobado', out: 'badge-en_progreso', internal: 'badge-nuevo', adjustment: 'badge-pendiente' };
  const STATE_BADGE = { draft: 'badge-pendiente', done: 'badge-finalizado', cancel: 'badge-rechazado' };

  async function loadInventoryList() {
    await loadCatalogs().catch(() => {});
    const search = $('invSearch').value.trim();
    if (inv.tab === 'stock') {
      const body = $('invStockBody');
      body.innerHTML = emptyRow(6, 'Cargando…');
      let expiring = '';
      if ($('invStockExpiring').value) {
        const d = new Date();
        d.setDate(d.getDate() + Number($('invStockExpiring').value));
        expiring = d.toISOString().slice(0, 10);
      }
      try {
        const data = await api(`inventario/existencias/?${query({
          q: search, location: $('invStockLocation').value, expiring_before: expiring, page: inv.page, page_size: inv.pageSize,
        })}`);
        $('invCount').textContent = data.count.toLocaleString('es-MX');
        setPager('inv', inv.page, data.count, inv.pageSize);
        body.innerHTML = data.results.length ? data.results.map((q) => `
          <tr>
            <td class="inv-code">${esc(q.product_code || '')}</td>
            <td class="inv-name">${esc(q.product_name)}</td>
            <td>${esc(q.location_name)}</td>
            <td class="inv-muted">${esc(q.lot_name)}</td>
            <td class="${expiryClass(q.expiration_date)}">${dateShort(q.expiration_date)}</td>
            <td class="inv-num ${Number(q.quantity) < 0 ? 'inv-negative' : ''}">${qty(q.quantity)}</td>
          </tr>`).join('') : emptyRow(6, 'No hay existencias registradas. Registra una entrada para empezar.');
      } catch (e) { body.innerHTML = emptyRow(6, e.message); }
    } else {
      const body = $('invMovesBody');
      body.innerHTML = emptyRow(8, 'Cargando…');
      try {
        const data = await api(`inventario/movimientos/?${query({
          q: search, kind: $('invMoveKind').value, state: $('invMoveState').value, page: inv.page, page_size: inv.pageSize,
        })}`);
        $('invCount').textContent = data.count.toLocaleString('es-MX');
        setPager('inv', inv.page, data.count, inv.pageSize);
        body.innerHTML = data.results.length ? data.results.map((m) => `
          <tr>
            <td class="inv-muted" style="white-space: nowrap;">${dateTime(m.date || m.created_at)}</td>
            <td><span class="badge ${MOVE_BADGE[m.kind] || 'badge-nuevo'}">${esc(m.kind_label).toUpperCase()}</span></td>
            <td>${esc(m.reference) || '<span class="inv-muted">—</span>'}${m.partner_name ? `<div class="inv-muted" style="font-size: 11px;">${esc(m.partner_name)}</div>` : ''}</td>
            <td class="inv-name">${esc(m.product_name)}${m.lot_name ? `<div class="inv-muted" style="font-size: 11px; font-weight: 500;">Lote ${esc(m.lot_name)}</div>` : ''}</td>
            <td class="inv-num">${qty(m.quantity)}</td>
            <td class="inv-muted">${esc(m.location_from_name)} → ${esc(m.location_to_name)}</td>
            <td><span class="badge ${STATE_BADGE[m.state] || ''}" ${m.done_by_name ? `title="Confirmado por ${esc(m.done_by_name)}"` : ''}>${esc(m.state_label).toUpperCase()}</span></td>
            <td>${m.state === 'draft' && me.canManageInventory ? `<div class="inv-actions">
              <button type="button" class="inv-icon-btn ok" title="Confirmar" data-move-confirm="${m.id}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></button>
              <button type="button" class="inv-icon-btn cancel" title="Cancelar" data-move-cancel="${m.id}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>` : ''}</td>
          </tr>`).join('') : emptyRow(8, 'No hay movimientos que coincidan con los filtros.');
      } catch (e) { body.innerHTML = emptyRow(8, e.message); }
    }
  }

  function refreshInventory() {
    loadInventoryMetrics();
    loadInventoryList();
  }

  const MOVE_TITLES = { in: 'Nueva entrada', out: 'Nueva salida', internal: 'Nuevo traslado' };

  async function openMove(kind) {
    try {
      await loadCatalogs();
      inv.moveKind = kind;
      inv.moveProduct = null;
      const form = $('invMoveForm');
      form.reset();
      resetPicker('invMoveProduct', null);
      $('invMoveProductHint').textContent = '';
      $('invMoveLotField').style.display = 'none';
      document.querySelectorAll('.inv-new-lot').forEach((el) => { el.style.display = 'none'; });
      const internal = internalLocations();
      const all = catalogs.locations;
      const label = (l) => `${l.display_name}${l.usage !== 'internal' ? ` (${l.usage_label.split(' (')[0]})` : ''}`;
      let from = all, to = all, fromSel = '', toSel = '';
      if (kind === 'in') {
        from = all.filter((l) => l.usage !== 'internal'); to = internal;
        fromSel = (locationsBy('supplier')[0] || {}).id; toSel = (internal[0] || {}).id;
      } else if (kind === 'out') {
        from = internal; to = all.filter((l) => l.usage !== 'internal');
        fromSel = (internal[0] || {}).id; toSel = (locationsBy('patient')[0] || {}).id;
      } else {
        from = internal; to = internal;
        fromSel = (internal[0] || {}).id; toSel = (internal[1] || internal[0] || {}).id;
      }
      fillSelect(form.location_from, from, { label, selected: fromSel });
      fillSelect(form.location_to, to, { label, selected: toSel });
      $('invMoveModalTitle').textContent = MOVE_TITLES[kind];
      openModal('invMoveModal');
    } catch (e) { alertError(e); }
  }

  async function onMoveProduct(product) {
    inv.moveProduct = product;
    const hint = $('invMoveProductHint');
    const lotField = $('invMoveLotField');
    const form = $('invMoveForm');
    document.querySelectorAll('.inv-new-lot').forEach((el) => { el.style.display = 'none'; });
    if (!product) { hint.textContent = ''; lotField.style.display = 'none'; return; }
    if (product.type === 'service' || !product.track_inventory) {
      hint.textContent = 'Este producto no controla inventario. Actívalo en Productos para poder moverlo.';
    } else {
      hint.textContent = `Existencia actual: ${qty(product.qty_available)}`;
      hint.style.color = 'var(--text-muted)';
    }
    if (product.track_lots) {
      const lots = await api(`inventario/lotes/?${query({ product: product.id })}`);
      const opts = lots.map((l) => ({ id: l.id, name: l.expiration_date ? `${l.name} (cad. ${dateShort(l.expiration_date)})` : l.name }));
      if (inv.moveKind === 'in') opts.push({ id: '__new__', name: '+ Nuevo lote…' });
      fillSelect(form.lot, opts, { placeholder: 'Selecciona un lote' });
      lotField.style.display = '';
    } else {
      lotField.style.display = 'none';
      form.lot.innerHTML = '';
    }
  }

  async function saveMove(confirm) {
    const form = $('invMoveForm');
    const data = formValues(form);
    if (!data.product) { alertError(new Error('Selecciona un producto de la lista.')); return; }
    if (!form.reportValidity()) return;
    const btn = confirm ? $('invMoveSaveConfirmBtn') : $('invMoveSaveDraftBtn');
    setBusy(btn, true);
    try {
      if (data.lot === '__new__') {
        const name = $('invMoveNewLotName').value.trim();
        if (!name) throw new Error('Escribe el número del nuevo lote.');
        const lot = await api('inventario/lotes/', { method: 'POST', body: {
          product: data.product, name, expiration_date: $('invMoveNewLotExp').value || null,
        } });
        data.lot = lot.id;
      }
      const move = await api('inventario/movimientos/', { method: 'POST', body: data });
      if (confirm) {
        try {
          await api(`inventario/movimientos/${move.id}/confirmar/`, { method: 'POST' });
        } catch (e) {
          closeModal('invMoveModal');
          refreshInventory();
          alertError(new Error(`Se guardó como pendiente, pero no se pudo confirmar: ${e.message}`), 'Movimiento pendiente');
          return;
        }
      }
      closeModal('invMoveModal');
      if (inv.tab !== 'moves' && !confirm) setInventoryTab('moves'); else refreshInventory();
    } catch (e) { alertError(e, 'No se pudo guardar el movimiento'); } finally { setBusy(btn, false); }
  }

  async function confirmMove(id, button) {
    button.disabled = true;
    try {
      await api(`inventario/movimientos/${id}/confirmar/`, { method: 'POST' });
      refreshInventory();
    } catch (e) { button.disabled = false; alertError(e, 'No se pudo confirmar el movimiento'); }
  }

  async function cancelMove(id, button) {
    const ok = typeof showClivoraConfirmModal === 'function'
      ? await showClivoraConfirmModal('¿Cancelar este movimiento pendiente? No afecta el inventario.', 'Cancelar movimiento')
      : window.confirm('¿Cancelar este movimiento?');
    if (!ok) return;
    button.disabled = true;
    try {
      await api(`inventario/movimientos/${id}/cancelar/`, { method: 'POST' });
      refreshInventory();
    } catch (e) { button.disabled = false; alertError(e); }
  }

  async function openAdjust() {
    try {
      await loadCatalogs();
      const form = $('invAdjustForm');
      form.reset();
      resetPicker('invAdjustProduct', null);
      fillSelect(form.location, internalLocations(), { label: 'display_name' });
      $('invAdjustLotField').style.display = 'none';
      $('invAdjustCurrent').value = '—';
      openModal('invAdjustModal');
    } catch (e) { alertError(e); }
  }

  async function refreshAdjustCurrent() {
    const form = $('invAdjustForm');
    const product = form.product.value;
    if (!product || !form.location.value) { $('invAdjustCurrent').value = '—'; return; }
    const data = await api(`inventario/existencias/?${query({ product, location: form.location.value, page_size: 200 })}`);
    const lot = form.lot.value;
    const total = data.results.filter((q) => !lot || String(q.lot) === lot).reduce((s, q) => s + Number(q.quantity), 0);
    $('invAdjustCurrent').value = qty(total);
  }

  async function onAdjustProduct(product) {
    const form = $('invAdjustForm');
    if (product && product.track_lots) {
      const lots = await api(`inventario/lotes/?${query({ product: product.id })}`);
      fillSelect(form.lot, lots, { label: (l) => (l.expiration_date ? `${l.name} (cad. ${dateShort(l.expiration_date)})` : l.name), placeholder: 'Sin lote' });
      $('invAdjustLotField').style.display = '';
    } else {
      $('invAdjustLotField').style.display = 'none';
      form.lot.innerHTML = '';
    }
    refreshAdjustCurrent();
  }

  async function saveAdjust() {
    const form = $('invAdjustForm');
    const data = formValues(form);
    if (!data.product) { alertError(new Error('Selecciona un producto de la lista.')); return; }
    if (!form.reportValidity()) return;
    const btn = $('invAdjustSaveBtn');
    setBusy(btn, true, 'Aplicando…');
    try {
      const result = await api('inventario/movimientos/ajuste/', { method: 'POST', body: data });
      closeModal('invAdjustModal');
      refreshInventory();
      if (result && result.detail && typeof showClivoraAlertModal === 'function') showClivoraAlertModal(result.detail, 'Sin cambios');
    } catch (e) { alertError(e, 'No se pudo aplicar el ajuste'); } finally { setBusy(btn, false); }
  }

  // ── LISTAS DE PRECIOS ───────────────────────────────────────────────────
  // Una lista = precios fijos por producto + (opcional) una lista base con %
  // de descuento para los productos sin precio propio. Ver apps/precios.
  const pl = { page: 1, pageSize: 50, current: null, rulesPage: 1, rulesPageSize: 25 };
  const plCache = new Map(); // nombre mostrado en el selector de lista base -> id

  async function loadPricelistFilters() {
    await loadCatalogs();
    if ($('invPlAseguradora').options.length <= 1) {
      fillSelect($('invPlAseguradora'), catalogs.aseguradoras, { placeholder: 'Todas las aseguradoras' });
    }
  }

  async function loadPricelists() {
    const body = $('invPlBody');
    body.innerHTML = emptyRow(6, 'Cargando…');
    try {
      await loadPricelistFilters();
      const data = await api(`precios/listas/?${query({
        q: $('invPlSearch').value.trim(), aseguradora: $('invPlAseguradora').value,
        active: $('invPlActive').value, page: pl.page, page_size: pl.pageSize,
      })}`);
      $('invPlCount').textContent = data.count.toLocaleString('es-MX');
      setPager('invPl', pl.page, data.count, pl.pageSize);
      body.innerHTML = data.results.length ? data.results.map((p) => `
        <tr class="inv-clickable" data-pricelist-id="${p.id}">
          <td class="inv-name">${esc(p.name)}</td>
          <td class="inv-muted">${esc(p.clinica_name) || 'Todas'}</td>
          <td>${esc(p.aseguradora_name) || '<span class="inv-muted">—</span>'}</td>
          <td class="inv-muted">${p.base_pricelist_name ? `${esc(p.base_pricelist_name)}${Number(p.base_discount) ? ` (−${qty(p.base_discount)}%)` : ''}` : '—'}</td>
          <td class="inv-num">${p.items_count.toLocaleString('es-MX')}</td>
          <td><div class="inv-actions"><button type="button" class="inv-icon-btn edit" title="Ver / editar" data-pricelist-id="${p.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button></div></td>
        </tr>`).join('') : emptyRow(6, 'No hay listas que coincidan con los filtros.');
    } catch (e) { body.innerHTML = emptyRow(6, e.message); }
  }

  // Selector de lista base (input + datalist con búsqueda).
  const searchBasePricelists = debounce(async (term) => {
    try {
      const data = await api(`precios/listas/?${query({ q: term, page_size: 20 })}`);
      $('invPricelistOptions').innerHTML = data.results
        .filter((p) => !pl.current || p.id !== pl.current.id)
        .map((p) => { plCache.set(p.name, p.id); return `<option value="${esc(p.name)}"></option>`; }).join('');
    } catch (e) { console.error(e); }
  }, 250);

  function onBasePickerInput() {
    const input = $('invPlBasePicker');
    const value = input.value.trim();
    if (!value) { $('invPlBase').value = ''; return; }
    if (plCache.has(value)) { $('invPlBase').value = plCache.get(value); return; }
    $('invPlBase').value = '';
    if (value.length >= 2) searchBasePricelists(value);
  }

  async function openPricelist(id) {
    try {
      await loadCatalogs();
      const form = $('invPricelistForm');
      fillSelect(form.clinica, catalogs.clinicas, { placeholder: 'Todas las clínicas' });
      fillSelect(form.aseguradora, catalogs.aseguradoras, { placeholder: 'Ninguna' });
      const active = me.clinicaActiva ? me.clinicaActiva.id : '';
      const p = id ? await api(`precios/listas/${id}/`) : {
        name: '', clinica: active, aseguradora: '', base_pricelist: '', base_discount: '0', active: true,
      };
      pl.current = p;
      fillForm(form, p);
      $('invPlBasePicker').value = p.base_pricelist_name || '';
      if (p.base_pricelist) plCache.set(p.base_pricelist_name, p.base_pricelist);
      form.classList.toggle('inv-readonly', Boolean(!me.canManagePricelists));
      $('invPricelistModalTitle').textContent = id ? p.name : 'Nueva lista de precios';
      $('invPricelistModalSubtitle').textContent = id ? [p.clinica_name || 'Todas las clínicas', p.aseguradora_name].filter(Boolean).join(' · ') : '';
      $('invPricelistRulesBlock').style.display = id ? '' : 'none';
      $('invTestResult').textContent = '';
      resetPicker('invTestProduct', null);
      resetPicker('invRuleProduct', null);
      $('invRuleForm').price.value = '';
      if (id) { pl.rulesPage = 1; $('invRulesSearch').value = ''; loadRules(); }
      openModal('invPricelistModal');
    } catch (e) { alertError(e); }
  }

  async function savePricelist() {
    const form = $('invPricelistForm');
    if (!form.reportValidity()) return;
    if ($('invPlBasePicker').value.trim() && !$('invPlBase').value) {
      alertError(new Error('Elige la lista base de las opciones sugeridas (o deja el campo vacío).'));
      return;
    }
    const btn = $('invPricelistSaveBtn');
    setBusy(btn, true);
    try {
      const id = pl.current && pl.current.id;
      const data = formValues(form);
      data.base_discount = data.base_discount || '0';
      const saved = await api(id ? `precios/listas/${id}/` : 'precios/listas/', { method: id ? 'PATCH' : 'POST', body: data });
      loadPricelists();
      if (!id) openPricelist(saved.id); // recién creada: abre sus precios
      else { pl.current = saved; $('invPricelistModalTitle').textContent = saved.name; }
    } catch (e) { alertError(e, 'No se pudo guardar la lista'); } finally { setBusy(btn, false); }
  }

  async function loadRules() {
    if (!pl.current || !pl.current.id) return;
    const body = $('invRulesBody');
    body.innerHTML = emptyRow(5, 'Cargando…');
    try {
      const data = await api(`precios/productos/?${query({
        pricelist: pl.current.id, q: $('invRulesSearch').value.trim(), page: pl.rulesPage, page_size: pl.rulesPageSize,
      })}`);
      $('invRulesCount').textContent = data.count.toLocaleString('es-MX');
      setPager('invRules', pl.rulesPage, data.count, pl.rulesPageSize);
      const canEdit = me.canManagePricelists;
      body.innerHTML = data.results.length ? data.results.map((r) => `
        <tr data-item-id="${r.id}">
          <td class="inv-code">${esc(r.product_code)}</td>
          <td class="inv-name">${esc(r.product_name)}</td>
          <td class="inv-num inv-muted">${money(r.list_price)}</td>
          <td class="inv-num">${canEdit
            ? `<input type="number" class="search-input inv-price-input" value="${esc(r.price)}" step="0.01" min="0" data-item-price="${r.id}">`
            : money(r.price)}</td>
          <td>${canEdit ? `<div class="inv-actions">
            <button type="button" class="inv-icon-btn cancel" title="Quitar precio" data-item-delete="${r.id}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
          </div>` : ''}</td>
        </tr>`).join('') : emptyRow(5, pl.current.base_pricelist_name
          ? `Sin precios propios: se usan los de "${pl.current.base_pricelist_name}".`
          : 'Sin precios propios: se usa el precio de venta de cada producto.');
    } catch (e) { body.innerHTML = emptyRow(5, e.message); }
  }

  async function addRule() {
    const form = $('invRuleForm');
    const product = form.product.value;
    const price = form.price.value;
    if (!product) { alertError(new Error('Selecciona un producto de la lista.')); return; }
    if (price === '') { alertError(new Error('Escribe el precio.')); return; }
    const btn = $('invRuleSaveBtn');
    setBusy(btn, true, 'Agregando…');
    try {
      await api('precios/productos/', { method: 'POST', body: { pricelist: pl.current.id, product, price } });
      resetPicker('invRuleProduct', null);
      form.price.value = '';
      loadRules();
      loadPricelists();
      testPrice();
    } catch (e) { alertError(e, 'No se pudo agregar el precio'); } finally { setBusy(btn, false); }
  }

  async function updateRulePrice(input) {
    const value = input.value;
    if (value === '' || Number(value) < 0) { input.classList.add('inv-input-error'); return; }
    input.classList.remove('inv-input-error');
    try {
      await api(`precios/productos/${input.dataset.itemPrice}/`, { method: 'PATCH', body: { price: value } });
      input.classList.add('inv-input-saved');
      setTimeout(() => input.classList.remove('inv-input-saved'), 900);
      testPrice();
    } catch (e) { alertError(e, 'No se pudo cambiar el precio'); }
  }

  async function deleteRule(id) {
    if (!(await confirmDialog('¿Quitar el precio de este producto en la lista? Se usará el de la lista base o el precio de venta.', 'Quitar precio'))) return;
    try {
      await api(`precios/productos/${id}/`, { method: 'DELETE' });
      loadRules();
      loadPricelists();
      testPrice();
    } catch (e) { alertError(e); }
  }

  const testPrice = debounce(async () => {
    const product = $('invTestProduct').value;
    const out = $('invTestResult');
    if (!product || !pl.current || !pl.current.id) { out.textContent = ''; return; }
    try {
      const result = await api(`precios/calcular/?${query({ pricelist: pl.current.id, product })}`);
      out.innerHTML = `Precio en esta lista: <strong>${money(result.price)}</strong>
        <span style="margin-left: 10px;">· Precio de venta ${money(result.list_price)}</span>`;
    } catch (e) { out.textContent = e.message; }
  }, 250);

  // ── carga perezosa por pantalla ─────────────────────────────────────────
  const loaders = {
    productosView: () => { loadCatalogs().then(() => {
      if ($('invProdCategory').options.length <= 1) fillSelect($('invProdCategory'), catalogs.categories, { label: 'complete_name', placeholder: 'Todas las categorías' });
    }).catch(() => {}); loadProducts(); },
    inventarioView: () => { loadCatalogs().then(() => {
      if ($('invStockLocation').options.length <= 1) fillSelect($('invStockLocation'), internalLocations(), { label: 'display_name', placeholder: 'Todas las ubicaciones' });
    }).catch(() => {}); refreshInventory(); },
    preciosView: () => loadPricelists(),
  };

  // ── eventos ─────────────────────────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll('.inv-product-picker').forEach(setupPicker);

    // Productos
    const reloadProducts = () => { prod.page = 1; loadProducts(); };
    $('invProdSearch').addEventListener('input', debounce(reloadProducts));
    ['invProdType', 'invProdCategory', 'invProdActive', 'invProdOnlyStock'].forEach((id) => $(id).addEventListener('change', reloadProducts));
    $('invNewProductBtn').addEventListener('click', () => openProduct(null));
    $('invProdBody').addEventListener('click', (e) => {
      const row = e.target.closest('[data-product-id]');
      if (row) openProduct(row.dataset.productId);
    });
    $('invProductSaveBtn').addEventListener('click', saveProduct);
    const productForm = $('invProductForm');
    productForm.type.addEventListener('change', () => applyProductTypeRules(productForm));
    productForm.track_inventory.addEventListener('change', () => applyProductTypeRules(productForm));
    productForm.addEventListener('submit', (e) => { e.preventDefault(); saveProduct(); });

    // Inventario
    const reloadInventory = () => { inv.page = 1; loadInventoryList(); };
    $('invSearch').addEventListener('input', debounce(reloadInventory));
    ['invStockLocation', 'invStockExpiring', 'invMoveKind', 'invMoveState'].forEach((id) => $(id).addEventListener('change', reloadInventory));
    $('invTabStock').addEventListener('click', () => setInventoryTab('stock'));
    $('invTabMoves').addEventListener('click', () => setInventoryTab('moves'));
    document.querySelectorAll('[data-new-move]').forEach((b) => b.addEventListener('click', () => openMove(b.dataset.newMove)));
    $('invAdjustBtn').addEventListener('click', openAdjust);
    $('invMovesBody').addEventListener('click', (e) => {
      const ok = e.target.closest('[data-move-confirm]');
      if (ok) { confirmMove(ok.dataset.moveConfirm, ok); return; }
      const cancel = e.target.closest('[data-move-cancel]');
      if (cancel) cancelMove(cancel.dataset.moveCancel, cancel);
    });
    $('invMoveForm').addEventListener('inv:product', (e) => onMoveProduct(e.detail));
    $('invMoveForm').lot.addEventListener('change', (e) => {
      document.querySelectorAll('.inv-new-lot').forEach((el) => { el.style.display = e.target.value === '__new__' ? '' : 'none'; });
    });
    $('invMoveSaveDraftBtn').addEventListener('click', () => saveMove(false));
    $('invMoveSaveConfirmBtn').addEventListener('click', () => saveMove(true));
    $('invAdjustForm').addEventListener('inv:product', (e) => onAdjustProduct(e.detail));
    $('invAdjustForm').location.addEventListener('change', refreshAdjustCurrent);
    $('invAdjustForm').lot.addEventListener('change', refreshAdjustCurrent);
    $('invAdjustSaveBtn').addEventListener('click', saveAdjust);

    // Listas de precios
    const reloadPricelists = () => { pl.page = 1; loadPricelists(); };
    $('invPlSearch').addEventListener('input', debounce(reloadPricelists));
    ['invPlAseguradora', 'invPlActive'].forEach((id) => $(id).addEventListener('change', reloadPricelists));
    $('invNewPricelistBtn').addEventListener('click', () => openPricelist(null));
    $('invPlBody').addEventListener('click', (e) => {
      const row = e.target.closest('[data-pricelist-id]');
      if (row) openPricelist(row.dataset.pricelistId);
    });
    $('invPricelistSaveBtn').addEventListener('click', savePricelist);
    $('invPlBasePicker').addEventListener('input', onBasePickerInput);
    $('invRulesSearch').addEventListener('input', debounce(() => { pl.rulesPage = 1; loadRules(); }));
    $('invRuleSaveBtn').addEventListener('click', addRule);
    $('invRuleForm').addEventListener('submit', (e) => { e.preventDefault(); addRule(); });
    $('invRulesBody').addEventListener('change', (e) => {
      const input = e.target.closest('[data-item-price]');
      if (input) updateRulePrice(input);
    });
    $('invRulesBody').addEventListener('click', (e) => {
      const del = e.target.closest('[data-item-delete]');
      if (del) deleteRule(del.dataset.itemDelete);
    });
    document.querySelector('.inv-tester').addEventListener('inv:product', testPrice);

    // Paginadores y botones "Cerrar"
    document.addEventListener('click', (e) => {
      const pagerBtn = e.target.closest('[data-pager]');
      if (pagerBtn) {
        const which = pagerBtn.dataset.pager;
        const dir = Number(pagerBtn.dataset.dir);
        const pages = Number($(`${which}Pager`).dataset.pages || 1);
        const stateFor = { invProd: [prod, 'page', loadProducts], inv: [inv, 'page', loadInventoryList],
          invPl: [pl, 'page', loadPricelists], invRules: [pl, 'rulesPage', loadRules] }[which];
        if (!stateFor) return;
        const [obj, key, reload] = stateFor;
        const next = Math.min(pages, Math.max(1, obj[key] + dir));
        if (next !== obj[key]) { obj[key] = next; reload(); }
        return;
      }
      const close = e.target.closest('[data-inv-close]');
      if (close) closeModal(close.dataset.invClose);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!$('productosView')) return;
    bindEvents();
    await loadMe();
    Object.entries(loaders).forEach(([id, loader]) => window.ClivoraUI.watchView(id, loader));
  });
}());
