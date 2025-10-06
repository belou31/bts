// static/js/subscription.js
(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const cssEscape = (s) =>
    (window.CSS?.escape ? window.CSS.escape(String(s)) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const normZoneKey = (key) => String(key || '').toUpperCase();

  function start() {

    const { on, api } = window.BTS_VIEW;
    const CTX = api.getCTX(); // contexte générique

    // Classes sièges/zone (mappées par generic-view)
    const SEAT_CLASSES = Object.assign({
      allowed:   'seat-allowed',
      selected:  'seat-selected',
      booked:    'seat-booked',
      busy:      'seat-busy',
      available: 'seat-available',
    }, window.BTS_VIEW?.CLASSES || {});
    // Si allowed === available, on utilise une classe distincte pour l'indication de quota
    const ALLOWED_CLASS = (SEAT_CLASSES.allowed && SEAT_CLASSES.allowed !== SEAT_CLASSES.available)
      ? SEAT_CLASSES.allowed
      : 'seat-allowed';
    const ZONE_CLASSES = {
      allowed:   'zone-allowed',
      selected:  'zone-selected',
      booked:    'zone-booked',
      busy:      'zone-busy',
      available: 'zone-available',
    };    

    // 🔧 Découplage : impose une classe "allowed" dédiée (≠ available). Le générique n'utilise pas "allowed" pour sélectionner.
    if (window.BTS_VIEW?.CLASSES) {
      window.BTS_VIEW.CLASSES.allowed = ALLOWED_CLASS; // 'seat-allowed' par défaut
    }    

    const counters   = new Map(); // zoneKey -> max index seen for virtual ids
    const zoneLabels = new Map();
    const zoneButtons = new Map();
    let zones        = [];        // [{ key, name, remaining, svgSelector }, ...] from /api/sub/status
    let remaining    = new Map(); // zoneKey -> remaining server quota (minus cart)
    // Gestion des SIÈGES
    let seats       = [];        // [{ seatId, status, zoneKey }]
    let bySeatId    = new Map();
    let svgDoc      = null;

    /* ---------- Virtual seat id helpers (TBH7 style) ---------- */
    function nextIndexFor(zoneKey) {
      const key = normZoneKey(zoneKey);
      let max = counters.get(key) || 0;
      document.querySelectorAll('.cart-row').forEach(row => {
        const z = (row.dataset.zoneKey || '').toUpperCase();
        if (z === key) {
          const m = String(row.dataset.seatId || '').match(/-Z(\d{3,})$/i);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
      });
      return max + 1;
    }
    function seatIdFor(zoneKey) {
      const key = normZoneKey(zoneKey);
      const n = nextIndexFor(key);
      counters.set(key, n);
      return `${key}-Z${String(n).padStart(3, '0')}`;
    }

    /* ---------- UI: boutons de zone ---------- */
    const buttonsContainer = $('#zoneButtons');

    function renderZoneButtons() {
      if (!buttonsContainer) {
        zoneButtons.clear();
        zoneLabels.clear();
        return;
      }
      buttonsContainer.innerHTML = '';
      zoneButtons.clear();
      zoneLabels.clear();
      zones.forEach(z => {
        const key = normZoneKey(z.key);
        zoneLabels.set(key, z.name || z.key || key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'zone-btn';
        btn.dataset.zoneKey = key;
        btn.addEventListener('click', () => addOne(key));
        buttonsContainer.appendChild(btn);
        zoneButtons.set(key, btn);
      });
      buttonsContainer.classList.toggle('hidden', zoneButtons.size === 0);
      updateZoneButtons();
    }

    function updateZoneButtons() {
      zoneButtons.forEach((btn, key) => {
        const remainingCount = Math.max(0, Number(remaining.get(key) ?? 0));
        const label = zoneLabels.get(key) || key;
        btn.textContent = `${label} (${remainingCount})`;
        btn.disabled = remainingCount <= 0;
      });
    }

    /* ---------- Add one virtual line for a zone ---------- */
    function addOne(zoneKey) {
      const key = normZoneKey(zoneKey);
      const r = remaining.get(key) ?? 0;
      if (r <= 0) {
        const fb = $('#feedback');
        if (fb) { fb.className = 'feedback err'; fb.textContent = `Quota atteint pour ${key}.`; }
        return;
      }

      // Create a virtual seat id and delegate the row creation to generic-view
      const id = seatIdFor(key);
      api.addRowForSeat({ seatId: id, zoneKey: key, label: zoneLabels.get(key) || key }); // generic attache dataset.zoneKey & wire la ligne

      remaining.set(key, Math.max(0, r - 1));
      updateZoneButtons();
      syncSeatAllowedClasses(); // hint visuel sur sièges selon quota zone
    }

    /* ---------- Clickable zones in the SVG ---------- */
    function wirePlanClicks(svgDoc) {
      let wired = 0;
      zones.forEach(z => {
        const sel = String(z.svgSelector || '').trim();
        if (!sel) return;
        const nodes = $$(sel, svgDoc);
        nodes.forEach(node => {
          // Marquage explicite pour la délégation
          node.dataset.zoneKey = z.key;
          node.classList.add('zone-hotspot');
          // Assure la cliquabilité visuelle + technique
          node.style.cursor = 'pointer';
          node.style.pointerEvents = 'auto';
          // Si on clique SUR la zone (et pas sur un siège), on ajoute une ligne
          node.addEventListener('click', (ev) => {
            if (ev.target?.closest?.('[data-seat-id],[data-seat]')) return; // priorité aux sièges
            addOne(z.key);
          });
          wired++;
        });
      });
      if (window.BTS_VIEW?.dlog) window.BTS_VIEW.dlog('zones wired:', wired);
    }

    /* ---------- Keep “remaining” in sync with the cart ---------- */
    function recomputeRemainingFromCart() {
      // Start from server ‘remaining’ values
      const base = new Map(zones.map(z => [normZoneKey(z.key), Number(z.remaining || 0)]));

      // Subtract the count currently in the cart, grouped by row.dataset.zoneKey
      const cartCount = new Map();
      document.querySelectorAll('.cart-row').forEach(row => {
        const z = normZoneKey(row.dataset.zoneKey);
        if (!z) return;
        cartCount.set(z, (cartCount.get(z) || 0) + 1);
      });

      for (const [key, r0] of base) {
        const used = cartCount.get(key) || 0;
        base.set(key, Math.max(0, r0 - used));
      }

      remaining = base;
      updateZoneButtons();
    }

    /* ---------- Hooks from generic-view ---------- */
    on('afterData', ({ data }) => {
      // ⛔ Empêche le pré-remplissage du panier par generic-view
      const rows = document.getElementById('cartRows');
      //if (rows) rows.innerHTML = '';
      //if (CTX && Array.isArray(CTX.seats)) CTX.seats.length = 0;
      //if (CTX && Array.isArray(CTX.cart))  CTX.cart.length  = 0;
      api.recomputeTotals();

      // Sièges issus du backend (statuts BD)
      seats    = Array.isArray(data?.seats) ? data.seats : [];
      bySeatId = new Map(seats.map(s => [String(s.seatId), s]));

      // data.zones must be provided by /api/sub/status
      zones = Array.isArray(data?.zones)
        ? data.zones.map(z => ({ ...z, key: normZoneKey(z.key) }))
        : [];
      remaining = new Map(zones.map(z => [z.key, Number(z.remaining || 0)]));

      renderZoneButtons();
      recomputeRemainingFromCart(); // handle restored rows
    });

    on('planReady', ({ svgDoc: doc }) => {
      svgDoc = doc || null;
      if (!svgDoc) return;

      // Styles d'interactivité dans le SVG
      injectInteractivityStyles(svgDoc, SEAT_CLASSES, ZONE_CLASSES, ALLOWED_CLASS);

      // Applique l'état BD à TOUS les sièges (booked/busy/available)
      for (const s of seats) api.setSeatState(s.seatId, s.status);

      // Clic SIÈGE : seulement si statut BD = 'available' et non busy/booked visuellement
      svgDoc.addEventListener('click', (e) => {
        const node = e.target?.closest?.('[data-seat-id],[data-seat],[id]');
        if (!node) return;
        let sid = node.getAttribute('data-seat-id') || node.getAttribute('data-seat') || node.id || '';
        sid = String(sid).trim();
        if (!sid) return;
        const rec = bySeatId.get(sid);
        if (!rec) return; // pas un siège -> géré côté zone
        if ((rec.status || '').toLowerCase() !== 'available') return;
        const el = api.findSeatElement(sid);
        if (!el) return;
        if (el.classList.contains(SEAT_CLASSES.booked) || el.classList.contains(SEAT_CLASSES.busy)) return;

        if (hasRowForSeat(sid)) removeRowForSeat(sid);
        else api.addRowForSeat({ seatId: sid, zoneKey: rec.zoneKey });

        api.recomputeTotals();
        recomputeRemainingFromCart();
        syncSeatAllowedClasses();
      });

      // Zones cliquables
      wirePlanClicks(svgDoc);
      // Hint initial sièges "allowed" selon quotas zones
      syncSeatAllowedClasses();
    });

    on('cartChanged', () => {
      recomputeRemainingFromCart();
    });


    /* ---------- Helpers sièges ---------- */
    function hasRowForSeat(seatId) {
      return !!document.querySelector(`#cartRows [data-seat-id="${cssEscape(seatId)}"]`);
    }
    function removeRowForSeat(seatId) {
      const el = document.querySelector(`#cartRows [data-seat-id="${cssEscape(seatId)}"]`);
      if (el) el.remove();
    }
    function syncSeatAllowedClasses() {
      if (!svgDoc) return;
      for (const s of seats) {
        if ((s.status || '').toLowerCase() !== 'available') continue;
        const el = api.findSeatElement(s.seatId);
        if (!el) continue;
        // Si la zone du siège est suivie et qu'il reste du quota, on marque "allowed"
        const left = remaining.get(normZoneKey(s.zoneKey)) ?? null;
        if (left === null) continue; // zone non suivie : ne rien imposer
        if (left > 0) el.classList.add(ALLOWED_CLASS);
        else el.classList.remove(ALLOWED_CLASS);
      }
    }
    function injectInteractivityStyles(svg, SEAT, ZONE, ALLOWED) {
      try {
        const style = svg.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = `
          .${SEAT.booked}, .${SEAT.busy} { pointer-events: none; cursor: not-allowed; }
          .${SEAT.available}, .${ALLOWED} { cursor: pointer; }
          .${ZONE.booked}, .${ZONE.busy} { pointer-events: none; cursor: not-allowed; }
          .${ZONE.available}, .${ZONE.allowed} { cursor: pointer; }
        `;
        svg.documentElement.appendChild(style);
      } catch {}
    }


  }

  // Wait until generic-view has created window.BTS_VIEW
  if (window.BTS_VIEW && window.BTS_VIEW.api) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.BTS_VIEW && window.BTS_VIEW.api) start();
    });
  }
})();
