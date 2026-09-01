// static/js/renew.js
//
// Cart pre-fill and quota for /renew.
//
// The page opens with the renewer's OWN seats already in the cart — the
// renewal question is "keep these?", not "pick from scratch". generic-view.js
// used to do that itself (buildRowsFromData) by treating every seat the API
// returned as a cart line, which worked while /s/renew only ever returned the
// token's seats. Now that seat swapping means it returns the whole venue, that
// would put the entire stadium in the cart, so the route sets
// buildRowsFromData:false and the pre-fill happens here instead — over
// `previousSeats` only. Everything else in the venue stays merely selectable.
//
// Standing-zone entries are pre-filled by the same pass, and for them it is
// the only way in: a renewal JWT's seatIds can include virtual zone seat ids
// (e.g. "FAN_ZONE-Z001", built by import-subscription-orders.js's
// buildVirtualSeatId), but the venue SVG has one hotspot for the whole zone
// rather than one per slot, so generic-view.js's click-the-SVG-seat model
// (findSeatElement) never finds an element to wire up. Nothing is lost by not
// requiring a click there — a standing entry is already fully determined,
// there is nothing to pick out. Any pre-filled line can still be removed via
// the row's trash button (e.g. to decline one zone in a multi-line group).
(function () {
  const isVirtualZoneSeatId = (sid) => /^.+-Z\d{3,}$/i.test(String(sid || ''));
  const zoneKeyFromSeatId = (sid) => String(sid || '').split('-')[0] || '';
  // Same defaults as generic-view.js's CLASSES.
  const SEAT_CLASS = { booked: 'seat-booked', busy: 'seat-busy', available: 'seat-available', allowed: 'seat-allowed' };
  const cssEscape = (s) => String(s).replace(/(["\\])/g, '\\$1');

  function cartSeatIds() {
    return new Set(
      Array.from(document.querySelectorAll('#cartRows .cart-row')).map((row) => row.dataset.seatId)
    );
  }

  function rowForSeat(seatId) {
    return document.querySelector(`#cartRows .cart-row[data-seat-id="${cssEscape(seatId)}"]`);
  }

  // Status per seat as the API sees it — the renewer's own provisioned seats
  // are already rewritten to 'available' server-side, everyone else's stay
  // 'provisioned' and must not be selectable.
  const seatStatus = new Map();

  // Standing zones. An extra place can be taken in a zone rather than on a
  // numbered seat, so /renew needs the zone picker the subscription flow has:
  // zones have no per-slot Seat to click, only a hotspot and a quota.
  const normZoneKey = (k) => String(k || '').trim().toUpperCase();
  let zones = [];                 // [{ key, name, remaining, svgSelector }]
  const zoneLabels = new Map();
  const zoneButtons = new Map();
  const zoneRemaining = new Map(); // server remaining, minus what's in the cart

  // Virtual ids must not collide with the ones already in the cart (the
  // renewer's own zone slot from the token is "<ZONE>-Z001").
  function nextZoneSeatId(zoneKey) {
    const key = normZoneKey(zoneKey);
    let max = 0;
    document.querySelectorAll('#cartRows .cart-row').forEach((row) => {
      if (normZoneKey(row.dataset.zoneKey) !== key) return;
      const m = String(row.dataset.seatId || '').match(/-Z(\d{3,})$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `${key}-Z${String(max + 1).padStart(3, '0')}`;
  }

  function recomputeZoneRemaining() {
    const inCart = new Map();
    document.querySelectorAll('#cartRows .cart-row').forEach((row) => {
      const z = normZoneKey(row.dataset.zoneKey);
      if (!z) return;
      inCart.set(z, (inCart.get(z) || 0) + 1);
    });
    for (const z of zones) {
      const key = normZoneKey(z.key);
      // The renewer's own token zone slot is already counted in the server's
      // `remaining` (as a provisional claim), so re-subtracting it here would
      // double-count it. Only seats added beyond the pre-filled ones reduce it.
      const prefilled = Number(z.prefilledInCart || 0);
      const taken = Math.max(0, (inCart.get(key) || 0) - prefilled);
      zoneRemaining.set(key, Math.max(0, Number(z.remaining || 0) - taken));
    }
    updateZoneButtons();
  }

  function updateZoneButtons() {
    zoneButtons.forEach((btn, key) => {
      const left = Math.max(0, Number(zoneRemaining.get(key) ?? 0));
      btn.textContent = `${zoneLabels.get(key) || key} (${left})`;
      btn.disabled = left <= 0 || quotaReached();
    });
  }

  function addZonePlace(zoneKey) {
    const key = normZoneKey(zoneKey);
    if (quotaReached()) {
      window.BTS_VIEW.setFeedback?.(
        'error',
        `Votre renouvellement est limité à ${quota} place${quota > 1 ? 's' : ''}.`,
        ['Retirez une place du panier avant d’en choisir une autre.']
      );
      return;
    }
    if ((zoneRemaining.get(key) ?? 0) <= 0) {
      window.BTS_VIEW.setFeedback?.('error', `Plus de place disponible en ${zoneLabels.get(key) || key}.`);
      return;
    }
    const api = window.BTS_VIEW.api;
    api.addRowForSeat({ seatId: nextZoneSeatId(key), zoneKey: key, label: zoneLabels.get(key) || key });
    api.recomputeTotals();
  }

  function renderZoneButtons() {
    const container = document.querySelector('#zoneButtons');
    if (!container) return;
    container.innerHTML = '';
    zoneButtons.clear();
    zoneLabels.clear();
    for (const z of zones) {
      const key = normZoneKey(z.key);
      if (!key) continue;
      zoneLabels.set(key, z.name || z.key || key);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zone-btn';
      btn.dataset.zoneKey = key;
      btn.addEventListener('click', () => addZonePlace(key));
      container.appendChild(btn);
      zoneButtons.set(key, btn);
    }
    container.classList.toggle('hidden', zoneButtons.size === 0);
    updateZoneButtons();
  }

  // Clicking the zone area on the plan does the same as its button.
  function wireZoneHotspots(svgDoc) {
    if (!svgDoc) return;
    for (const z of zones) {
      const sel = String(z.svgSelector || '').trim();
      if (!sel) continue;
      let nodes = [];
      try { nodes = Array.from(svgDoc.querySelectorAll(sel)); } catch { continue; }
      for (const node of nodes) {
        node.dataset.zoneKey = normZoneKey(z.key);
        node.style.cursor = 'pointer';
        node.style.pointerEvents = 'auto';
        node.addEventListener('click', (ev) => {
          // A numbered seat drawn on top of the zone wins the click.
          if (ev.target?.closest?.('[data-seat-id],[data-seat]')) return;
          addZonePlace(z.key);
        });
      }
    }
  }

  function prefillPreviousSeats(ctx, data) {
    const api = window.BTS_VIEW.api;
    const inCart = cartSeatIds();
    // previousSeats is what this renewer actually held; tokenSeats is the same
    // list and covers links issued before the field existed.
    const previous = Array.isArray(data?.previousSeats) && data.previousSeats.length
      ? data.previousSeats
      : (Array.isArray(ctx?.tokenSeats) ? ctx.tokenSeats : []);
    // A previous seat that is no longer theirs (resold, or a standing slot
    // already covered by a paid order) must not come back as a cart line.
    const blocked = new Set(Array.isArray(data?.blockedSeats) ? data.blockedSeats : []);

    for (const seatId of previous) {
      if (!seatId || inCart.has(seatId) || blocked.has(seatId)) continue;
      const zoneKey = zoneKeyFromSeatId(seatId);
      api.addRowForSeat(isVirtualZoneSeatId(seatId)
        ? { seatId, zoneKey, label: zoneKey.replace(/_/g, ' ') }
        : { seatId, zoneKey });
    }
  }

  // Seat swapping (see src/routes/renew.js): the token is a QUOTA, not a fixed
  // seat list — the renewer may move anywhere free and take `extra` more seats
  // than last season. Nothing in the shared view caps cart size, so without
  // this the only feedback for going over quota would be POST /s/renew's 403.
  // Server-side stays authoritative; this is just so the limit is felt as it's
  // reached rather than at payment time.
  let quota = Infinity;
  let trimming = false;

  function enforceQuota() {
    const rows = Array.from(document.querySelectorAll('#cartRows .cart-row'));
    // recomputeTotals() below re-emits cartChanged, which lands back here.
    if (trimming || !Number.isFinite(quota) || rows.length <= quota) return;

    // Drop the most recently added rows back out of the cart, releasing their
    // seat on the plan so the renewer can pick a different one.
    const api = window.BTS_VIEW.api;
    trimming = true;
    try {
      for (const row of rows.slice(quota)) {
        const seatId = row.dataset.seatId;
        row.remove();
        if (seatId) api.setSeatState(seatId, 'available');
      }
      api.recomputeTotals();
    } finally {
      trimming = false;
    }
    window.BTS_VIEW.setFeedback?.(
      'error',
      `Votre renouvellement est limité à ${quota} place${quota > 1 ? 's' : ''}.`,
      ['Retirez une place du panier avant d’en choisir une autre.']
    );
  }

  function quotaReached() {
    return document.querySelectorAll('#cartRows .cart-row').length >= quota;
  }

  // The plan (<object> load) and the API response race each other, and
  // generic-view.js only paints seat states from whichever it has when the
  // plan becomes ready. Re-painting from both hooks means the venue is
  // correctly coloured — hence correctly clickable — in either order.
  let planDoc = null;
  function paintSeatStates() {
    if (!planDoc || !seatStatus.size) return;
    const api = window.BTS_VIEW.api;
    for (const [seatId, status] of seatStatus) api.setSeatState(seatId, status);
    api.recomputeTotals(); // restores the "selected" highlight on cart rows
  }

  // Seat picking on the plan. generic-view.js deliberately wires no seat
  // clicks — each view owns its own selection rules (cf. event.js,
  // subscription.js) — and /renew never needed any: the cart was built
  // wholesale from the token's seats and the plan was read-only. Swapping
  // makes the plan interactive for the first time here.
  function wireSeatPicking(svgDoc) {
    if (!svgDoc) return;

    // Without this the cursor never signals that anything is clickable.
    try {
      const style = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = `
        .${SEAT_CLASS.booked}, .${SEAT_CLASS.busy} { pointer-events: none; cursor: not-allowed; }
        .${SEAT_CLASS.available}, .${SEAT_CLASS.allowed} { cursor: pointer; }
      `;
      svgDoc.documentElement.appendChild(style);
    } catch { /* styling is a nicety — picking still works without it */ }

    svgDoc.addEventListener('click', (e) => {
      const node = e.target?.closest?.('[data-seat-id],[data-seat]');
      if (!node) return;
      const seatId = String(node.getAttribute('data-seat-id') || node.getAttribute('data-seat') || '').trim();
      if (!seatId) return;

      const api = window.BTS_VIEW.api;

      // Clicking a seat already in the cart gives it up (same as its trash
      // button) — that's how a renewer swaps: drop one, pick another.
      const existing = rowForSeat(seatId);
      if (existing) {
        existing.remove();
        api.setSeatState(seatId, 'available');
        api.recomputeTotals();
        return;
      }

      if ((seatStatus.get(seatId) || '').toLowerCase() !== 'available') return;
      const el = api.findSeatElement(seatId);
      if (!el || el.classList.contains(SEAT_CLASS.booked) || el.classList.contains(SEAT_CLASS.busy)) return;

      if (quotaReached()) {
        window.BTS_VIEW.setFeedback?.(
          'error',
          `Votre renouvellement est limité à ${quota} place${quota > 1 ? 's' : ''}.`,
          ['Retirez une place du panier avant d’en choisir une autre.']
        );
        return;
      }

      api.addRowForSeat({ seatId, zoneKey: zoneKeyFromSeatId(seatId) });
      api.recomputeTotals();
    });
  }

  // Zone hotspots must be wired exactly once: the zone list and the plan
  // arrive independently, and wiring twice would add a place per click twice.
  let zoneHotspotsWired = false;
  function maybeWireZoneHotspots() {
    if (zoneHotspotsWired || !planDoc || !zones.length) return;
    wireZoneHotspots(planDoc);
    zoneHotspotsWired = true;
  }

  window.BTS_VIEW.on('afterData', ({ ctx, data }) => {
    const q = Number(data?.quota);
    if (Number.isFinite(q) && q > 0) quota = q;
    seatStatus.clear();
    for (const s of (Array.isArray(data?.seats) ? data.seats : [])) {
      if (s?.seatId) seatStatus.set(String(s.seatId).trim(), String(s.status || ''));
    }
    paintSeatStates();
    prefillPreviousSeats(ctx, data);

    zones = (Array.isArray(data?.zones) ? data.zones : []).map(z => ({ ...z, key: normZoneKey(z.key) }));
    // The renewer's own zone slot is already deducted from the server's
    // `remaining` (it counts as an outstanding claim), so the copy sitting in
    // the cart from the pre-fill must not be deducted a second time.
    const prefilled = new Map();
    for (const sid of (Array.isArray(data?.previousSeats) ? data.previousSeats : [])) {
      if (!isVirtualZoneSeatId(sid) || !rowForSeat(sid)) continue;
      const k = normZoneKey(zoneKeyFromSeatId(sid));
      prefilled.set(k, (prefilled.get(k) || 0) + 1);
    }
    for (const z of zones) z.prefilledInCart = prefilled.get(normZoneKey(z.key)) || 0;

    renderZoneButtons();
    recomputeZoneRemaining();
    maybeWireZoneHotspots();
  });
  window.BTS_VIEW.on('planReady', ({ svgDoc }) => {
    planDoc = svgDoc || null;
    wireSeatPicking(planDoc);
    paintSeatStates();
    maybeWireZoneHotspots();
  });
  window.BTS_VIEW.on('cartChanged', () => {
    enforceQuota();
    recomputeZoneRemaining();
  });
})();
