// static/js/event.js — commande "match"
(() => {
  const { on, api } = window.BTS_VIEW;

  const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const normZoneKey = (key) => String(key || '').toUpperCase();

  const state = {
    seatsById: new Map(),
    seatIds: new Set(),
    allowedZones: new Set(),
    allowedTariffsByZone: {},
    zonesMeta: {},
    zonesKind: {},
    zoneBaseCounts: new Map(),
    zoneRemaining: new Map(),
    svgDoc: null,
    lastData: null
  };

  const zoneButtons = new Map();
  const zoneLabels = new Map();
  let buttonsContainer = null;
  let showFeedback = () => {};

  // Ajoute label lorsqu’un siège n’a pas de libellé explicite
  function applyFallbackLabels() {
    document.querySelectorAll('#cartRows .cart-row').forEach(row => {
      const placeCell =
        row.querySelector('.cell-place') ||
        row.querySelector('[data-cell="place"]') ||
        row.querySelector('div:nth-child(2)');
      if (!placeCell) return;
      const current = String(placeCell.textContent || '').trim();
      const zoneKey = normZoneKey(row.dataset.zoneKey);
      const seatId = String(row.dataset.seatId || '').trim();
      const pretty = seatId.replace(/-Z\d{3,}$/i, '');
      const label = (pretty || zoneLabels.get(zoneKey) || zoneKey || '').toUpperCase();
      if (label && current !== label) placeCell.textContent = label;
    });
  }

  function ensureAddRowForZone() {
    if (typeof api.addRowForZone === 'function') return;
    api.addRowForZone = function ({ zoneKey, qty = 1 } = {}) {
      const key = normZoneKey(zoneKey);
      if (!key) return;
      const label = zoneLabels.get(key) || state.zonesMeta[key] || key;
      for (let i = 0; i < qty; i++) {
        api.addRowForSeat({ seatId: '', zoneKey: key, label });
      }
      api.recomputeTotals?.();
    };
  }

  function computeZoneBases() {
    state.zoneBaseCounts.clear();
    state.zoneRemaining.clear();
    zoneLabels.clear();

    const standingInfo = Array.isArray(state.lastData?.standingZones)
      ? state.lastData.standingZones
      : [];

    if (standingInfo.length) {
      standingInfo.forEach(info => {
        const key = normZoneKey(info.key || info.zoneKey);
        if (!key) return;
        const label = info.label || state.zonesMeta[key] || key;
        const remaining = Number(info.remaining ?? 0);
        zoneLabels.set(key, label);
        state.zoneBaseCounts.set(key, remaining);
        state.zoneRemaining.set(key, remaining);
      });
      return;
    }

    const standingZones = Array.from(state.allowedZones)
      .filter(z => (state.zonesKind[z] || '').toLowerCase() === 'standing');

    standingZones.forEach(z => {
      const key = normZoneKey(z);
      zoneLabels.set(key, state.zonesMeta[key] || key);
      state.zoneBaseCounts.set(key, 0);
      state.zoneRemaining.set(key, 0);
    });
  }

  function updateZoneButtons() {
    zoneButtons.forEach((btn, key) => {
      const base = state.zoneBaseCounts.get(key) ?? 0;
      const remaining = Math.max(0, Number(state.zoneRemaining.get(key) ?? base));
      const label = zoneLabels.get(key) || key;
      btn.textContent = `${label} (${remaining})`;
      btn.disabled = remaining <= 0;
    });
  }

  function renderZoneButtons() {
    if (!buttonsContainer) return;
    buttonsContainer.innerHTML = '';
    zoneButtons.clear();

    const zones = Array.from(state.zoneBaseCounts.keys()).sort();
    zones.forEach(key => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zone-btn';
      btn.dataset.zoneKey = key;
      btn.addEventListener('click', () => handleZoneButton(key));
      buttonsContainer.appendChild(btn);
      zoneButtons.set(key, btn);
    });

    buttonsContainer.classList.toggle('hidden', zones.length === 0);
    updateZoneButtons();
  }

  function recomputeRemainingFromCart() {
    if (!state.zoneBaseCounts.size) return;
    const base = new Map(state.zoneBaseCounts);
    document.querySelectorAll('#cartRows .cart-row').forEach(row => {
      const key = normZoneKey(row.dataset.zoneKey);
      if (!base.has(key)) return;
      base.set(key, Math.max(0, (base.get(key) || 0) - 1));
    });
    state.zoneRemaining.clear();
    base.forEach((value, key) => state.zoneRemaining.set(key, value));
    updateZoneButtons();
  }

  function addZoneLine(zoneKey) {
    const key = normZoneKey(zoneKey);
    const remaining = state.zoneRemaining.get(key);
    if (typeof remaining === 'number' && remaining <= 0) return false;

    ensureAddRowForZone();
    api.addRowForZone({ zoneKey: key, qty: 1 });
    api.recomputeTotals();
    applyFallbackLabels();

    recomputeRemainingFromCart();
    return true;
  }

  function handleZoneButton(zoneKey) {
    const ok = addZoneLine(zoneKey);
    if (!ok) {
      const label = zoneLabels.get(normZoneKey(zoneKey)) || zoneKey;
      showFeedback(false, `Quota atteint pour ${label}`);
    }
  }

  function initIfReady() {
    if (!state.svgDoc || !state.lastData) return;
    const svgDoc = state.svgDoc;
    const seats = Array.isArray(state.lastData?.seats) ? state.lastData.seats : [];

    seats.forEach(s => api.setSeatState(s.seatId, s.status));
    seats.forEach(s => {
      const el = api.findSeatElement?.(s.seatId) || svgDoc.getElementById(String(s.seatId));
      if (!el) return;
      if (s.allowed) el.classList.add('seat-allowed'); else el.classList.remove('seat-allowed');
    });

    if (!svgDoc.__btsClickBound) {
      svgDoc.__btsClickBound = true;
      svgDoc.addEventListener('click', (e) => {
        const el = e.target?.closest?.('[data-zone-key],[data-seat-id],[id]');
        if (!el) return;

        const zkey = normZoneKey(el.getAttribute('data-zone-key'));
        if (zkey) {
          if (!state.allowedZones.has(zkey)) return;
          if ((state.zonesKind[zkey] || '').toLowerCase() !== 'standing') return;
          addZoneLine(zkey);
          return;
        }

        const sid = (el.getAttribute('data-seat-id') || el.id || '').trim();
        if (!sid || !state.seatIds.has(sid)) return;
        const rec = state.seatsById.get(sid) || {};
        if (!rec.allowed) return;
        if (String(rec.status || '').toLowerCase() !== 'available') return;
        if (el.classList?.contains?.('seat-booked') || el.classList?.contains?.('seat-busy')) return;

        const existing = document.querySelector(`#cartRows [data-seat-id="${cssEscape(sid)}"]`);
        if (existing) existing.remove();
        else api.addRowForSeat({ seatId: sid, zoneKey: rec.zoneKey || sid.split('-')[0] });
        api.recomputeTotals();
        recomputeRemainingFromCart();
        applyFallbackLabels();
      });
    }
  }

  function formatEventTitle(ev) {
    if (!ev?.name) return null;
    const dt = ev?.startsAt ? new Date(ev.startsAt) : null;
    let suffix = '';
    if (dt && !isNaN(dt.getTime())) {
      try {
        suffix = ` — ${dt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}`;
      } catch {
        // ignore Intl failures
      }
    }
    return `Billetterie match — ${ev.name}${suffix}`;
  }

  on('afterData', ({ data }) => {
    state.lastData = data || {};
    const seats = Array.isArray(state.lastData?.seats) ? state.lastData.seats : [];
    state.seatsById = new Map(seats.map(s => [String(s.seatId), s]));
    state.seatIds = new Set(seats.map(s => String(s.seatId)));
    state.allowedZones = new Set((data?.allowedZones || []).map(normZoneKey));
    state.allowedTariffsByZone = {};
    Object.entries(data?.allowedTariffsByZone || {}).forEach(([key, list]) => {
      state.allowedTariffsByZone[normZoneKey(key)] = list;
    });
    state.zonesMeta = Object.fromEntries(Object.entries(data?.zonesMeta || {}).map(([k,v]) => [normZoneKey(k), v]));
    state.zonesKind = Object.fromEntries(Object.entries(data?.zonesKind || {}).map(([k,v]) => [normZoneKey(k), v]));

    api.recomputeTotals();
    ensureAddRowForZone();
    computeZoneBases();
    renderZoneButtons();
    recomputeRemainingFromCart();
    initIfReady();

    const evtTitle = formatEventTitle(data?.event);
    if (evtTitle) {
      const brandTitle = document.querySelector('#pageTitle');
      if (brandTitle) brandTitle.textContent = evtTitle;
      document.title = `${evtTitle} — BTS`;
    }
  });

  on('planReady', ({ svgDoc }) => {
    if (!svgDoc) return;
    state.svgDoc = svgDoc;
    ensureAddRowForZone();
    initIfReady();
  });

  on('cartChanged', () => {
    const items = document.querySelectorAll('#cartRows .cart-row');
    const payBtn = document.querySelector('#payBtn');
    if (payBtn) payBtn.disabled = items.length === 0;

    items.forEach(row => {
      const zone = normZoneKey(row.dataset.zoneKey);
      const select = row.querySelector('select[name="tariff"]');
      if (!select) return;
      const list = state.allowedTariffsByZone[zone] || [];
      if (!Array.isArray(list) || !list.length) {
        [...select.options].forEach(opt => opt.disabled = false);
        return;
      }
      const allowed = new Set(list.map(t => String(t).toUpperCase()));
      [...select.options].forEach(opt => {
        const value = String(opt.value || '').toUpperCase();
        opt.disabled = !allowed.has(value);
      });
      if (select.options.length && select.options[select.selectedIndex]?.disabled) {
        const firstValid = [...select.options].find(o => !o.disabled);
        if (firstValid) select.value = firstValid.value;
      }
    });

    recomputeRemainingFromCart();
    applyFallbackLabels();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const fbNode = document.querySelector('#feedback');
    const payBtn = document.querySelector('#payBtn');
    const payerEmail = document.querySelector('#payerEmail');
    const payerLast = document.querySelector('#payerLast');
    const payerFirst = document.querySelector('#payerFirst');

    buttonsContainer = document.querySelector('#zoneButtons');

    showFeedback = (ok, msg) => {
      if (!fbNode) return;
      fbNode.style.display = 'flex';
      fbNode.className = `feedback ${ok ? 'ok' : 'err'}`;
      fbNode.innerHTML = `<span class="fb-icon">${ok ? '✅' : '❌'}</span><span class="fb-text">${msg || ''}</span>`;
    };

    on('cartChanged', () => {
      if (!payBtn) return;
      const items = document.querySelectorAll('#cartRows .cart-row');
      payBtn.disabled = items.length === 0;
    });

    ensureAddRowForZone();
    applyFallbackLabels();

    // focus payer email par défaut
    if (payerEmail && !payerEmail.value) payerEmail.focus();
    if (payerLast && !payerLast.value && payerFirst && payerFirst.value) payerLast.focus();
  });
})();
