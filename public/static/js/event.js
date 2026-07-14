// static/js/event.js — commande "match"
(() => {
  const { on, api } = window.BTS_VIEW;
  const VIEW_CONFIG = window.BTS_VIEW_CONFIG || {};
  const IS_PARTNER_VIEW = !!VIEW_CONFIG.partner;

  // ── Gestion des holds pre-checkout ─────────────────────────────────────────

  function getOrCreateSessionToken() {
    const key = 'bts_session_token';
    let token = sessionStorage.getItem(key);
    if (!token) {
      token = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, token);
    }
    return token;
  }

  const SESSION_TOKEN = getOrCreateSessionToken();

  // Dérive l'URL hold à partir de l'URL status (remplace /status par /hold)
  const holdBase = (VIEW_CONFIG.api?.status || '').replace(/\/status(\?.*)?$/, '/hold');

  // Injecte sessionToken dans les appels status et checkout
  if (VIEW_CONFIG.api?.status) {
    const sep = VIEW_CONFIG.api.status.includes('?') ? '&' : '?';
    VIEW_CONFIG.api.status += `${sep}sessionToken=${encodeURIComponent(SESSION_TOKEN)}`;
  }
  if (VIEW_CONFIG.api?.checkout) {
    const sep = VIEW_CONFIG.api.checkout.includes('?') ? '&' : '?';
    VIEW_CONFIG.api.checkout += `${sep}sessionToken=${encodeURIComponent(SESSION_TOKEN)}`;
  }

  const heldSeats = new Set();
  let holdTtlSec = 3 * 60;
  let holdExpiryTime = null;
  let holdTimerInterval = null;
  let paymentStarted = false;
  const WARN_THRESHOLD_SEC = 60;

  // Dérive l'URL seats à partir de l'URL status (remplace /status par /seats)
  const seatsUrl = (VIEW_CONFIG.api?.status || '').replace(/\/status(\?|$)/, '/seats$1');

  async function holdSeats(seatIds) {
    const ids = seatIds.filter(Boolean);
    if (!ids.length || !holdBase) return { held: [], conflicts: [] };
    try {
      const res = await fetch(holdBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ seatIds: ids, sessionToken: SESSION_TOKEN })
      });
      const data = await res.json();
      if (data.held) data.held.forEach(id => heldSeats.add(id));
      if (data.holdTtlSec) holdTtlSec = data.holdTtlSec;
      if (data.held?.length) resetHoldTimer();
      return data;
    } catch (e) {
      console.warn('[BTS hold] POST failed:', e?.message);
      return { held: [], conflicts: [] };
    }
  }

  async function releaseSeats(seatIds) {
    const ids = seatIds.filter(Boolean);
    if (!ids.length || !holdBase) return;
    try {
      await fetch(holdBase, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ seatIds: ids, sessionToken: SESSION_TOKEN })
      });
      ids.forEach(id => heldSeats.delete(id));
    } catch (e) {
      console.warn('[BTS hold] DELETE failed:', e?.message);
    }
  }

  // ── Timer de réservation ────────────────────────────────────────────────

  function resetHoldTimer() {
    if (paymentStarted) return;
    if (!heldSeats.size) { stopHoldTimer(); return; }
    holdExpiryTime = Date.now() + holdTtlSec * 1000;
    if (!holdTimerInterval) holdTimerInterval = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
  }

  function stopHoldTimer() {
    if (holdTimerInterval) clearInterval(holdTimerInterval);
    holdTimerInterval = null;
    holdExpiryTime = null;
    const el = document.querySelector('#holdTimer');
    if (el) el.hidden = true;
  }

  function updateTimerDisplay() {
    const el = document.querySelector('#holdTimer');
    if (!el) return;
    if (!holdExpiryTime || !heldSeats.size) { el.hidden = true; return; }

    const remainSec = Math.max(0, Math.ceil((holdExpiryTime - Date.now()) / 1000));
    const min = Math.floor(remainSec / 60);
    const sec = remainSec % 60;
    const display = `${min}:${String(sec).padStart(2, '0')}`;

    el.hidden = false;
    const bookingPanel = document.getElementById('bookingStatus');
    if (bookingPanel) bookingPanel.hidden = false;
    const txt = el.querySelector('.timer-text');
    if (txt) txt.textContent = display;

    const warning = remainSec <= WARN_THRESHOLD_SEC && remainSec > 0;
    el.classList.toggle('timer-warning', warning);
    const btn = el.querySelector('#holdExtendBtn');
    if (btn) btn.hidden = !warning;

    if (remainSec <= 0) handleHoldExpiry();
  }

  async function handleHoldExpiry() {
    stopHoldTimer();
    const allSeats = Array.from(heldSeats);
    if (allSeats.length) await releaseSeats(allSeats);
    document.querySelectorAll('#cartRows .cart-row').forEach(row => row.remove());
    api.recomputeTotals?.();
    showFeedback(false, 'Votre sélection a expiré. Les places ont été libérées.');
  }

  function extendHold() {
    const allSeats = Array.from(heldSeats);
    if (allSeats.length) holdSeats(allSeats);
  }

  // ──────────────────────────────────────────────────────────────────────────

  const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const normZoneKey = (key) => String(key || '').trim().toUpperCase(); // trim to avoid duplicates like "DEBOUT "

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

  function cssAttrSelector(attr, value) {
    const escaped = cssEscape(value);
    return `[${attr}="${escaped}"]`;
  }

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

    const hasTariffs = (key) => {
      const list = state.allowedTariffsByZone[key] || [];
      if (Array.isArray(list) && list.length) return true;
      const star = state.allowedTariffsByZone['*'] || [];
      return Array.isArray(star) && star.length > 0;
    };

    const standingInfo = Array.isArray(state.lastData?.standingZones)
      ? state.lastData.standingZones
      : [];

    if (standingInfo.length) {
      const seen = new Set();
      standingInfo.forEach(info => {
        const key = normZoneKey(info.key || info.zoneKey);
        if (!key || seen.has(key)) return;
        if (!hasTariffs(key)) return; // ignore standing zones with no tariff price
        seen.add(key);
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

    const seen = new Set();
    standingZones.forEach(z => {
      const key = normZoneKey(z);
      if (!key || seen.has(key)) return;
      if (!hasTariffs(key)) return; // no available tariff → no button
      seen.add(key);
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

  function wireZoneHotspots() {
    if (!state.svgDoc || !state.zoneBaseCounts.size) return;
    const svgDoc = state.svgDoc;
    state.zoneBaseCounts.forEach((_remaining, key) => {
      const selectors = [
        cssAttrSelector('data-zone-id', key),
        cssAttrSelector('data-zone-key', key),
        cssAttrSelector('data-zone', key)
      ];
      const nodes = svgDoc.querySelectorAll(selectors.join(','));
      nodes.forEach(node => {
        if (node.__btsZoneWired) return;
        node.__btsZoneWired = true;
        node.dataset.zoneKey = key;
        node.classList.add('zone-hotspot');
        node.style.cursor = 'pointer';
        node.style.pointerEvents = 'auto';
        node.addEventListener('click', (ev) => {
          // évite double-add (le handler global sur svgDoc écoute aussi)
          ev.stopPropagation();
          ev.stopImmediatePropagation?.();
          if (ev.target?.closest?.('[data-seat-id],[data-seat]')) return;
          handleZoneButton(key);
        });
      });
    });
  }

  function initIfReady() {
    if (!state.svgDoc || !state.lastData) return;
    const svgDoc = state.svgDoc;
    const seats = Array.isArray(state.lastData?.seats) ? state.lastData.seats : [];

    // Ne pas écraser l'état visuel des sièges déjà dans le panier (sélectionnés par cet utilisateur)
    const cartSeatIds = new Set(
      Array.from(document.querySelectorAll('#cartRows .cart-row[data-seat-id]'))
        .map(row => String(row.dataset.seatId || '').trim()).filter(Boolean)
    );
    seats.forEach(s => {
      if (cartSeatIds.has(String(s.seatId))) return;
      api.setSeatState(s.seatId, s.status);
    });
    seats.forEach(s => {
      const el = api.findSeatElement?.(s.seatId) || svgDoc.getElementById(String(s.seatId));
      if (!el) return;
      if (s.allowed) el.classList.add('seat-allowed'); else el.classList.remove('seat-allowed');
    });

    if (!svgDoc.__btsClickBound) {
      svgDoc.__btsClickBound = true;
      svgDoc.addEventListener('click', async (e) => {
        const el = e.target?.closest?.('[data-zone-key],[data-zone-id],[data-seat-id]');
        if (!el) return;

        const zkey = normZoneKey(
          el.getAttribute('data-zone-key') || el.getAttribute('data-zone-id')
        );
        if (zkey) {
          if (!state.allowedZones.has(zkey)) return;
          if ((state.zonesKind[zkey] || '').toLowerCase() !== 'standing') return;
          addZoneLine(zkey);
          return;
        }

        const sid = (el.getAttribute('data-seat-id') || el.getAttribute('data-seat') || '').trim();
        if (!sid || !state.seatIds.has(sid)) return;
        const rec = state.seatsById.get(sid) || {};
        if (!rec.allowed) return;
        if (String(rec.status || '').toLowerCase() !== 'available') return;
        if (el.classList?.contains?.('seat-booked') || el.classList?.contains?.('seat-busy')) return;

        const existing = document.querySelector(`#cartRows [data-seat-id="${cssEscape(sid)}"]`);
        if (existing) {
          existing.remove();
          api.recomputeTotals();
          recomputeRemainingFromCart();
          applyFallbackLabels();
        } else {
          const result = await holdSeats([sid]);
          if (result.conflicts?.includes(sid)) {
            api.setSeatState(sid, 'busy');
            showFeedback(false, `Place ${sid} déjà sélectionnée par un autre utilisateur.`);
            return;
          }
          api.addRowForSeat({ seatId: sid, zoneKey: rec.zoneKey });
          api.recomputeTotals();
          recomputeRemainingFromCart();
          applyFallbackLabels();
        }
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

  function updateSaleStatusBadge(raw) {
    const badge = document.querySelector('#saleStatus');
    if (!badge) return;
    const ev = (raw && typeof raw === 'object') ? (raw.event || raw) : null;
    const presale = raw?.presale && typeof raw.presale === 'object' ? raw.presale : null;
    const saleStatus = String(raw?.saleStatus || ev?.saleStatus || '').toLowerCase();
    const onSale  = saleStatus === 'sale_opened' || ev?.isOnSale === true || ev?.onSale === true || String(ev?.status || '').toLowerCase() === 'on_sale';
    const offSale = saleStatus === 'sale_closed' || ev?.isOnSale === false || ev?.onSale === false || String(ev?.status || '').toLowerCase() === 'off_sale';
    const presaleAllowed = presale?.allowed === true;
    const presaleRemaining = typeof presale?.remaining === 'number' ? presale.remaining : null;
    const presaleQuota = typeof presale?.quota === 'number' ? presale.quota : null;
    const presaleDepleted = presaleAllowed && presaleRemaining !== null && presaleRemaining <= 0;

    let main = 'STATUT EN COURS';
    let sub  = 'Chargement du statut…';
    let stateClass = 'pending';

    if (saleStatus === 'presale_quota_reached' || (presaleAllowed && !onSale && presaleDepleted)) {
      main = 'PRESALE QUOTA REACHED';
      sub  = `Quota utilisé (${presaleQuota ?? 0})`;
      stateClass = 'quota';
    }
    else if (saleStatus === 'presale_opened' || (presaleAllowed && !onSale)) {
      main = 'PRESALE OPENED';
      sub  = presaleRemaining !== null ? `Places restantes : ${presaleRemaining}` : 'Prévente partenaire';
      stateClass = 'presale';
    }
    else if (saleStatus === 'sale_opened' || onSale) {
      main = 'SALE OPENED';
      sub  = 'Tickets on sale';
      stateClass = 'open';
    }
    else if (saleStatus === 'sale_closed' || offSale) {
      main = 'SALE CLOSED';
      sub  = 'Ventes fermées';
      stateClass = 'closed';
    }
    else if (presaleAllowed && !onSale) {
      if (presaleDepleted) {
        main = 'PRESALE QUOTA REACHED';
        sub  = `Quota utilisé (${presaleQuota ?? 0})`;
        stateClass = 'quota';
      } else {
        main = 'PRESALE OPENED';
        sub  = presaleRemaining !== null ? `Places restantes : ${presaleRemaining}` : 'Prévente partenaire';
        stateClass = 'presale';
      }
    } else if (onSale || offSale) {
      const open = onSale && !offSale;
      main = open ? 'SALE OPENED' : 'SALE CLOSED';
      sub  = open ? 'Tickets on sale' : 'Ventes fermées';
      stateClass = open ? 'open' : 'closed';
    }

    badge.hidden = false;
    badge.className = `sale-chip ${stateClass}`;
    badge.innerHTML = `<span class="sale-main">${main}</span><span class="sale-sub">${sub}</span>`;
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
    wireZoneHotspots();
    initIfReady();

    const evtTitle = formatEventTitle(data?.event);
    if (evtTitle && !VIEW_CONFIG.headingCustom) {
      const brandTitle = document.querySelector('#pageTitle');
      if (brandTitle && !IS_PARTNER_VIEW) brandTitle.textContent = evtTitle;
      if (!IS_PARTNER_VIEW) document.title = `${evtTitle} — BTS`;
    }

    if (data.holdTtlSec) holdTtlSec = data.holdTtlSec;

    updateSaleStatusBadge(data?.event || data);
  });

  on('planReady', ({ svgDoc }) => {
    if (!svgDoc) return;
    state.svgDoc = svgDoc;
    ensureAddRowForZone();
    wireZoneHotspots();
    initIfReady();
  });

  on('cartChanged', () => {
    const items = document.querySelectorAll('#cartRows .cart-row');
    const payBtn = document.querySelector('#payBtn');
    if (payBtn) payBtn.disabled = items.length === 0;

    // Sync holds: re-hold ALL cart seats (renew TTL), release removed
    if (holdBase) {
      const cartSeatIds = new Set(
        Array.from(document.querySelectorAll('#cartRows .cart-row[data-seat-id]'))
          .map(row => String(row.dataset.seatId || '').trim()).filter(Boolean)
      );
      const toRelease = [...heldSeats].filter(id => !cartSeatIds.has(id));
      if (toRelease.length) releaseSeats(toRelease);
      const allCart = [...cartSeatIds];
      if (allCart.length) holdSeats(allCart);
      if (!cartSeatIds.size) stopHoldTimer();
    }

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

    updateSaleStatusBadge({});

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

    // Polling léger : rafraîchit uniquement les seat states (pas tarifs/prix/zones)
    const pollMs = Number(VIEW_CONFIG.seatPollIntervalMs) || 5000;
    let pollActive = true;
    const doPoll = async () => {
      if (!pollActive || !seatsUrl) return;
      try {
        const res = await fetch(seatsUrl, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.seats)) return;
        const cartSeatIds = new Set(
          Array.from(document.querySelectorAll('#cartRows .cart-row[data-seat-id]'))
            .map(row => String(row.dataset.seatId || '').trim()).filter(Boolean)
        );
        data.seats.forEach(s => {
          const sid = String(s.seatId || '').trim();
          state.seatsById.set(sid, { ...state.seatsById.get(sid), ...s });
          if (cartSeatIds.has(sid)) return;
          api.setSeatState(sid, s.status);
        });
      } catch { /* silencieux */ }
    };
    const pollTimer = setInterval(doPoll, pollMs);
    document.querySelector('#payBtn')?.addEventListener('click', () => {
      paymentStarted = true;
      pollActive = false;
      clearInterval(pollTimer);
      stopHoldTimer();
    }, { once: true });

    // Bouton "Prolonger"
    document.querySelector('#holdExtendBtn')?.addEventListener('click', extendHold);

    // Libère tous les holds à la fermeture de l'onglet
    if (holdBase) {
      window.addEventListener('beforeunload', () => {
        if (!heldSeats.size) return;
        const body = JSON.stringify({ seatIds: [], sessionToken: SESSION_TOKEN });
        fetch(holdBase, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body,
          keepalive: true
        }).catch(() => {});
      });
    }
  });
})();
