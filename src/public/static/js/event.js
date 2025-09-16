// src/public/static/js/event.js
(() => {
  const { on, api } = window.BTS_VIEW;
  // Index et caches
  let SEATS_BY_ID = new Map();      // seatId -> { seatId, zoneKey, status, allowed }
  let SEAT_IDS    = new Set();
  let ALLOWED_ZONES = new Set();    // zones sélectionnables (ex. DEBOUT)
  let ALLOWED_TARIFFS_BY_ZONE = {}; // { zoneKey: [TARIFF...] }
  let ZONES_META = {};              // { ZONEKEY: "Libellé" }
  let ZONES_KIND = {};              // { ZONEKEY: "seated"|"standing"|"fanclub" }

  // Compteurs pour IDs virtuels (DEBOUT-Z001, ...)
  const VIRTUAL_COUNTERS = new Map(); // zoneKey -> max index
  function nextIndexFor(zoneKey){
    const Z = String(zoneKey||'').toUpperCase();
    let max = VIRTUAL_COUNTERS.get(Z) || 0;
    document.querySelectorAll('#cartRows .cart-row').forEach(row => {
      const z = String(row.dataset.zoneKey||'').toUpperCase();
      if (z === Z) {
        const m = String(row.dataset.seatId||'').match(/-Z(\d{3,})$/i);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    });
    return max + 1;
  }
  function virtualSeatId(zoneKey){
    const Z = String(zoneKey||'').toUpperCase();
    const n = nextIndexFor(Z);
    VIRTUAL_COUNTERS.set(Z, n);
    return `${Z}-Z${String(n).padStart(3,'0')}`;
  }


  // caches pour synchroniser planReady et afterData
  let svgDocRef = null;
  let lastData  = null;
  // refs DOM (remplies après DOMContentLoaded)
  let zoneSelectRef = null;
  let addZoneBtnRef = null;


  // Si la cellule "Place" est vide (ex. rang zone), on met seatId || zoneKey
  function applyFallbackLabels() {
    const rows = document.querySelectorAll('#cartRows .cart-row');
    rows.forEach(row => {
      const placeCell =
        row.querySelector('.cell-place') ||
        row.querySelector('[data-cell="place"]') ||
        row.querySelector('div:nth-child(2)'); // fallback pour nos layouts
      if (!placeCell) return;
      const current = String(placeCell.textContent || '').trim();
      const z = String(row.dataset.zoneKey||'').toUpperCase();
      const sid = String(row.dataset.seatId||'').trim();
      // 👉 pour DEBOUT-Z001 on n’affiche que "DEBOUT"
      const pretty = sid.replace(/-Z\d{3,}$/i, '');
      const val = (pretty || z || (ZONES_META[z] || z) || '').toUpperCase();
      if (current === val) return;
      if (val) placeCell.textContent = val;
    });
  }

  // === Implémentation locale: addRowForZone -> addRowForSeat avec ID virtuel ===
  function ensureAddRowForZone(){
    if (typeof api.addRowForZone === 'function') return;
    api.addRowForZone = function({ zoneKey, qty = 1 } = {}){
      const Z = String(zoneKey||'').toUpperCase();
      if (!Z) return;
      const label = ZONES_META[Z] || Z;
      for (let i=0;i<qty;i++) api.addRowForSeat({ seatId:'', zoneKey: Z, label });
        api.recomputeTotals?.();
      };
  }

  // Remplit le <select id="zoneSelect"> avec allowedZones + libellés
  function populateZoneSelect(){
    if (!zoneSelectRef) zoneSelectRef = document.querySelector('#zoneSelect');
    if (!zoneSelectRef) return;
    zoneSelectRef.innerHTML = '';
    // 👉 ne proposer que les zones de type "standing"
    const zones = Array.from(ALLOWED_ZONES)
      .filter(z => (ZONES_KIND[z] || '').toLowerCase() === 'standing')
      .sort();
    for (const z of zones) {
      const opt = document.createElement('option');
      opt.value = z;
      // libellé affiché dans le menu = nom lisible si dispo, sinon clé
      opt.textContent = ZONES_META[z] || z;
      zoneSelectRef.appendChild(opt);
    }
  }


  function initIfReady(){
    if (!svgDocRef || !lastData) return; // attendre que plan ET data soient prêts
    const svgDoc = svgDocRef;
    const data   = lastData;
    const seats  = Array.isArray(data?.seats) ? data.seats : [];

    // état visuel des sièges (déjà prévu dans ta version)
    for (const s of seats) api.setSeatState(s.seatId, s.status);

    // (facultatif) marquage visuel sélectionnable si fourni par l’API
    for (const s of seats) {
      const el = api.findSeatElement?.(s.seatId) || svgDoc.getElementById(String(s.seatId));
      if (!el) continue;
      if (s.allowed) el.classList.add('seat-allowed'); else el.classList.remove('seat-allowed');
    }


    // Écouteur délégué unique (installé une seule fois)
    if (!svgDoc.__btsClickBound) {
      svgDoc.__btsClickBound = true;
      svgDoc.addEventListener('click', (e) => {
        const el = e.target?.closest?.('[data-zone-key],[data-seat-id],[id]');
        if (!el) return; // ignorer tout le reste du SVG

        // 1) ZONE prioritaire (ex: DEBOUT) → chaque clic = +1
        const zkey = (el.getAttribute('data-zone-key') || '').trim().toUpperCase();
        if (zkey) {
          if (!ALLOWED_ZONES.has(zkey)) return;
          if ((ZONES_KIND[zkey] || '').toLowerCase() !== 'standing') return;
          ensureAddRowForZone();
          api.addRowForZone({ zoneKey: zkey, qty: 1 });
          api.recomputeTotals();
          applyFallbackLabels();
          return;
        }

        // 2) SIÈGE (uniquement si seatId connu & allowed & available)
        const sid = (el.getAttribute('data-seat-id') || el.id || '').trim();
        if (!sid || !SEAT_IDS.has(sid)) return;
        const rec = SEATS_BY_ID.get(sid) || {};
        if (!rec.allowed) return;
        if (String(rec.status||'').toLowerCase() !== 'available') return;
        // petite vérif visuelle (si classes posées côté SVG)
        if (el.classList?.contains?.('seat-booked') || el.classList?.contains?.('seat-busy')) return;

        const row = document.querySelector(`#cartRows [data-seat-id="${CSS.escape(sid)}"]`);
        if (row) row.remove();
        else api.addRowForSeat({ seatId: sid, zoneKey: rec.zoneKey || sid.split('-')[0] });
        api.recomputeTotals();
      });
    }
  }

  on('afterData', ({ data }) => {
    lastData = data || {};
    const seats = Array.isArray(lastData?.seats) ? lastData.seats : [];
    window.SEAT_STATUS = new Map(seats.map(s => [String(s.seatId), String(s.status||'').toLowerCase()]));
    SEATS_BY_ID = new Map(seats.map(s => [String(s.seatId), s]));
    SEAT_IDS    = new Set(seats.map(s => String(s.seatId)));
    ALLOWED_ZONES = new Set((data?.allowedZones || []).map(z=>String(z).toUpperCase()));
    ALLOWED_TARIFFS_BY_ZONE = data?.allowedTariffsByZone || {};
    ZONES_META = data?.zonesMeta || {};
    ZONES_KIND = data?.zonesKind || {};
    api.recomputeTotals();
    populateZoneSelect();
    ensureAddRowForZone();
     initIfReady();    
  });

  on('planReady', ({ svgDoc }) => {
    if (!svgDoc) return;
    svgDocRef = svgDoc;
    // s’assurer que l’API zone est prête AVANT binding
    ensureAddRowForZone();
    // Écouteur délégué unique (installé une seule fois)
    if (!svgDoc.__btsClickBound) {
      svgDoc.__btsClickBound = true;
      svgDoc.addEventListener('click', (e) => {
        const el = e.target?.closest?.('[data-zone-key],[data-seat-id],[id]');
        if (!el) return; // ignorer tout le reste du SVG

        // 1) ZONE prioritaire (ex: DEBOUT) → chaque clic = +1
        const zkey = (el.getAttribute('data-zone-key') || '').trim().toUpperCase();
        if (zkey) {
          if (!ALLOWED_ZONES.has(zkey)) return;
          // n’accepter que les zones standing (ex: DEBOUT)
          if ((ZONES_KIND[zkey] || '').toLowerCase() !== 'standing') return;
          ensureAddRowForZone();
          api.addRowForZone({ zoneKey: zkey, qty: 1 });          
          api.recomputeTotals();
          return;
        }

        // 2) SIÈGE (uniquement si seatId connu & allowed & available)
        const sid = (el.getAttribute('data-seat-id') || el.id || '').trim();
        if (!sid || !SEAT_IDS.has(sid)) return;
        const rec = SEATS_BY_ID.get(sid) || {};
        if (!rec.allowed) return;
        if (String(rec.status||'').toLowerCase() !== 'available') return;
        // petite vérif visuelle (si classes posées côté SVG)
        if (el.classList?.contains?.('seat-booked') || el.classList?.contains?.('seat-busy')) return;

        const row = document.querySelector(`#cartRows [data-seat-id="${CSS.escape(sid)}"]`);
        if (row) row.remove();
        else api.addRowForSeat({ seatId: sid, zoneKey: rec.zoneKey || sid.split('-')[0] });
        api.recomputeTotals();
      });
    };
    initIfReady();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (s,r=document)=>r.querySelector(s);
    const fb = $('#feedback'), btn = $('#payBtn'), sched = $('#paySchedule');
    const email = $('#payerEmail'), last = $('#payerLast'), first = $('#payerFirst');
    zoneSelectRef = $('#zoneSelect');
    addZoneBtnRef = $('#addZoneBtn');
    // garantir l’API zone dès que possible (utile pour le bouton "Ajouter")
    ensureAddRowForZone();

    const setFb = (ok, msg) => {
      fb.style.display = 'flex';
      fb.className = 'feedback ' + (ok?'ok':'err');
      fb.innerHTML = `<span class="fb-icon">${ok?'✅':'❌'}</span><span class="fb-text">${msg||''}</span>`;
    };

    on('cartChanged', () => {
      // Active/désactive le bouton selon le panier et validations
      const items = document.querySelectorAll('#cartRows .cart-row');
      btn.disabled = items.length === 0;
      // Filtrer les tarifs disponibles selon la zone
      items.forEach(row => {
        const zone = String(row.dataset.zoneKey||'').toUpperCase();
        const sel  = row.querySelector('select[name="tariff"]');
        if (!sel) return;
        const list = ALLOWED_TARIFFS_BY_ZONE[zone] || [];
        // ⚠️ si on n’a pas de liste pour la zone, on ne filtre pas (sinon tout paraît vide)
        if (!Array.isArray(list) || list.length === 0) {
          [...sel.options].forEach(opt => opt.disabled = false);
          return;
        }
        const allowedTariffs = new Set(list.map(t => String(t).toUpperCase()));
        [...sel.options].forEach(opt => {
          const t = String(opt.value||'').toUpperCase();
          opt.disabled = !allowedTariffs.has(t);
        });
        if (sel.options.length && sel.options[sel.selectedIndex]?.disabled) {
          const firstValid = [...sel.options].find(o => !o.disabled);
          if (firstValid) sel.value = firstValid.value;
        }
      });
        // Remplit les labels vides après filtrage
        applyFallbackLabels();
    });

    // Bouton "Ajouter" (zone)
    addZoneBtnRef?.addEventListener('click', () => {
      const z = String(zoneSelectRef?.value||'').toUpperCase();
      if (!z || !ALLOWED_ZONES.has(z)) return;
      if ((ZONES_KIND[z] || '').toLowerCase() !== 'standing') return;            
      ensureAddRowForZone();
      api.addRowForZone({ zoneKey: z, qty: 1 });
      api.recomputeTotals();
      applyFallbackLabels();
    });

    // ⚠️ Ne pas binder ici : on laisse generic-view.js gérer #payBtn
  });
})();
