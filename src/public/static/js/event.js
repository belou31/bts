// src/public/static/js/event.js
(() => {
  const { on, api } = window.BTS_VIEW;
  on('afterData', ({ data }) => {
    const seats = Array.isArray(data?.seats) ? data.seats : [];
    window.SEAT_STATUS = new Map(seats.map(s => [String(s.seatId), String(s.status||'').toLowerCase()]));
    api.recomputeTotals();
  });

  on('planReady', ({ svgDoc }) => {
    if (!svgDoc) return;
    const data = window.BTS_VIEW.getData?.() || {};
    const seats = Array.isArray(data?.seats) ? data.seats : [];
    for (const s of seats) api.setSeatState(s.seatId, s.status);

    svgDoc.addEventListener('click', (e) => {
      const node = e.target?.closest?.('[data-seat-id],[data-seat],[id]');
      if (!node) return;
      const sid = (node.getAttribute('data-seat-id') || node.getAttribute('data-seat') || node.id || '').trim();
      if (!sid) return;
      const row = document.querySelector(`#cartRows [data-seat-id="${CSS.escape(sid)}"]`);
      if (row) row.remove();
      else api.addRowForSeat({ seatId: sid, zoneKey: sid.split('-')[0] });
      api.recomputeTotals();
    });
  });

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (s,r=document)=>r.querySelector(s);
    const fb = $('#feedback'), btn = $('#payBtn'), sched = $('#paySchedule');
    const email = $('#payerEmail'), last = $('#payerLast'), first = $('#payerFirst');

    const setFb = (ok, msg) => {
      fb.style.display = 'flex';
      fb.className = 'feedback ' + (ok?'ok':'err');
      fb.innerHTML = `<span class="fb-icon">${ok?'✅':'❌'}</span><span class="fb-text">${msg||''}</span>`;
    };

    on('cartChanged', () => {
      // Active/désactive le bouton selon le panier et validations
      const items = document.querySelectorAll('#cartRows .cart-row');
      btn.disabled = items.length === 0;
    });

    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const cfg = window.BTS_VIEW_CONFIG;
        const items = Array.from(document.querySelectorAll('#cartRows .cart-row')).map(row => ({
          seatId: row.dataset.seatId,
          zoneKey: String(row.dataset.zoneKey || '').toUpperCase(),
          tariffCode: row.querySelector('select[name="tariff"]')?.value || 'NORMAL'
        }));
        if (!items.length) throw new Error('Panier vide.');
        const fn = String(first?.value||'').trim();
        const ln = String(last?.value||'').trim();
        const em = String(email?.value||'').trim();
        if (!em) throw new Error('Email requis.');
        if (!fn && !ln) throw new Error('Nom ou prénom requis.');
        if (fn && ln && fn.toLowerCase() === ln.toLowerCase()) throw new Error('Nom et prénom ne peuvent pas être identiques.');

        const resp = await fetch(cfg.api.checkout, {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ payer:{ firstName:fn, lastName:ln, email:em }, items, schedule: Number(sched?.value||1) })
        }).then(r=>r.json());

        if (!resp?.ok) throw new Error(resp?.error || 'Erreur checkout');
        const url = resp?.checkout?.redirectUrl || resp?.checkout?.url || null;
        if (url) location.href = url;
        else setFb(true, "Intent de paiement créé. Suivez les instructions.");
      } catch (e) {
        setFb(false, e.message || 'Erreur.');
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
