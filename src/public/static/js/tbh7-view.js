// static/js/tbh7-view.js
(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  function start() {
    const { on, api } = window.BTS_VIEW;

    const counters = new Map(); // zoneKey -> compteur max vu
    let remaining = new Map();  // zoneKey -> restant (serveur - panier)
    let zones = [];             // [{ key, name, remaining, svgSelector }, ...]

    /* --------- Génération d'ID lisible TBH7-Z001 --------- */
    function nextIndexFor(zoneKey) {
      let max = (counters.get(zoneKey) || 0);
      document.querySelectorAll('.cart-row').forEach(row => {
        const z = (row.dataset.zoneKey || '').toUpperCase();
        if (z === String(zoneKey).toUpperCase()) {
          const m = String(row.dataset.seatId || '').match(/-Z(\d{3,})$/i);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
      });
      return max + 1;
    }
    function seatIdFor(zoneKey) {
      const n = nextIndexFor(zoneKey);
      counters.set(zoneKey, n);
      return `${zoneKey}-Z${String(n).padStart(3, '0')}`;
    }

    /* --------- Quotas restants (UI) --------- */
    function recomputeRemainingFromCart() {
      remaining = new Map(zones.map(z => [z.key, Number(z.remaining || 0)]));
      $$('.cart-row').forEach(row => {
        const z = row.dataset.zoneKey || String(row.dataset.seatId || '').split('-')[0];
        if (z && remaining.has(z)) remaining.set(z, Math.max(0, remaining.get(z) - 1));
      });
      refreshRemainUI();
    }

    function refreshRemainUI() {
      const sel = $('#zoneSelect'); if (!sel) return;
      const lab = $('#zoneRemain');
      const z = sel.value;
      if (z) {
        const r = remaining.get(z) ?? 0;
        lab.textContent = r > 0 ? `Restant: ${r}` : `Complet`;
      } else {
        lab.textContent = '';
      }
      for (const opt of sel.options) {
        const r = remaining.get(opt.value) ?? 0;
        opt.disabled = (r <= 0);
      }
    }

    function populateZoneSelect() {
      const sel = $('#zoneSelect'); if (!sel) return;
      sel.innerHTML = '';
      for (const z of zones) {
        const opt = document.createElement('option');
        opt.value = z.key;
        opt.textContent = z.name || z.key;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', refreshRemainUI);
      refreshRemainUI();
    }

    /* --------- Ajout de ligne TBH7 --------- */
    function addOne(zoneKey) {
      const r = remaining.get(zoneKey) ?? 0;
      if (r <= 0) {
        const fb = $('#feedback'); if (fb) { fb.className = 'feedback err'; fb.textContent = `Quota atteint pour ${zoneKey}.`; }
        return;
      }

      const id = seatIdFor(zoneKey);
      api.addRowForSeat({ seatId: id, zoneKey, label: zoneKey });
      
      remaining.set(zoneKey, r - 1);
      refreshRemainUI();
    }

    function wireToolbar() {
      const btn = $('#addZoneBtn');
      if (btn) btn.addEventListener('click', () => {
        const sel = $('#zoneSelect'); if (!sel) return;
        if (sel.value) addOne(sel.value);
      });
    }

    /* --------- Clics sur le plan --------- */
    function wirePlanClicks(svgDoc) {
      zones.forEach(z => {
        const sel = String(z.svgSelector || '').trim();
        if (!sel) return;
        $$(sel, svgDoc).forEach(node => {
          node.style.cursor = 'pointer';
          node.addEventListener('click', () => addOne(z.key));
        });
      });
    }

    /* --------- Hooks exposés par generic-view --------- */
    on('afterData', ({ data }) => {
      zones = Array.isArray(data?.zones) ? data.zones : [];
      remaining = new Map(zones.map(z => [z.key, Number(z.remaining || 0)]));
      populateZoneSelect();
      wireToolbar();
      recomputeRemainingFromCart(); // au cas où des lignes existent déjà
    });

    on('planReady', ({ svgDoc }) => {
      wirePlanClicks(svgDoc);
    });

    on('cartChanged', () => {
      recomputeRemainingFromCart(); // suite à suppression/ajout de lignes
    });
  }

  // Attendre que generic-view ait créé window.BTS_VIEW
  if (window.BTS_VIEW && window.BTS_VIEW.api) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.BTS_VIEW && window.BTS_VIEW.api) start();
    });
    const iv = setInterval(() => {
      if (window.BTS_VIEW && window.BTS_VIEW.api) { clearInterval(iv); start(); }
    }, 25);
    setTimeout(() => clearInterval(iv), 5000);
  }
})();
