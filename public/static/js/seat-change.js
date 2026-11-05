// static/js/seat-change.js
//
// Changement de place d'un abonné pour UN match, greffé sur la vue de commande
// partagée (order/index.ejs + generic-view.js).
//
// Pourquoi s'appuyer dessus plutôt que sur une page autonome : choisir un siège
// suppose de pouvoir zoomer et déplacer le plan, ce que generic-view.js fait
// déjà (onPlanReady installe molette + glisser, plus plein écran et bascule de
// disposition). Le refaire à côté aurait dupliqué cette mécanique.
//
// Ce module ne s'occupe donc que de ce qui est propre au changement de place :
// le panneau latéral, le clic sur un siège cible, et l'envoi. generic-view
// charge le plan et peint l'état des sièges à partir du même payload.

(function () {
  const $ = (sel) => document.querySelector(sel);
  const CFG = window.BTS_VIEW_CONFIG || {};
  const API = CFG?.seatChange?.api || CFG?.api?.status || '';

  const state = {
    lines: [],
    seats: new Map(),      // seatId -> { zoneKey, status, mine }
    selectedLineId: null,
    moves: new Map(),      // sourceLineId -> toSeatId
    svgDoc: null
  };

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  function msg(kind, text) {
    const el = $('#scMsg');
    if (!el) return;
    el.className = 'feedback' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  const currentSeatFor = (line) => state.moves.get(line.sourceLineId) || line.seatId;

  function seatEl(seatId) {
    if (!state.svgDoc) return null;
    return state.svgDoc.querySelector(`[data-seat-id="${cssEscape(seatId)}"]`)
        || state.svgDoc.querySelector(`[data-seat="${cssEscape(seatId)}"]`);
  }

  // generic-view peint booked/busy/available depuis le payload ; on ajoute
  // seulement ce qui est propre à cet écran : mes places, ma cible choisie, et
  // les places cliquables de ma zone.
  function paintOverlay() {
    if (!state.svgDoc) return;
    const api = window.BTS_VIEW.api;
    const line = state.lines.find(l => l.sourceLineId === state.selectedLineId);
    const chosen = new Set(state.moves.values());

    for (const [seatId, rec] of state.seats) {
      const el = seatEl(seatId);
      if (!el) continue;
      el.classList.remove('seat-selected', 'seat-allowed');
      el.style.cursor = '';

      const mine = state.lines.some(l => currentSeatFor(l) === seatId);
      if (mine || chosen.has(seatId)) {
        el.classList.add('seat-selected');
        continue;
      }
      if (rec.status !== 'available') continue;
      if (line && rec.zoneKey === line.zoneKey) {
        el.classList.add('seat-allowed');
        el.style.cursor = 'pointer';
      }
    }
    if (api?.syncSelectedHighlights) { /* piloté ici, pas par le panier */ }
  }

  function renderLines() {
    const box = $('#scLines');
    if (!box) return;
    box.innerHTML = '';

    for (const line of state.lines) {
      const locked = !line.changeable;
      const row = document.createElement('div');
      row.className = 'sc-line' + (locked ? ' locked' : '');
      row.setAttribute('aria-selected', String(state.selectedLineId === line.sourceLineId));

      const moved = state.moves.get(line.sourceLineId);
      const right = line.alreadyMoved
        ? '<span class="sc-badge">déjà changée</span>'
        : (moved ? `<span class="sc-new">→ ${moved}</span>` : '<span class="sc-badge">changer</span>');

      row.innerHTML = `
        <span>
          <span class="sc-seat">${line.seatId || '—'}</span>
          ${line.holder ? `<br><span class="sc-holder">${line.holder}</span>` : ''}
        </span>
        ${right}`;

      if (!locked) {
        row.addEventListener('click', () => {
          state.selectedLineId = state.selectedLineId === line.sourceLineId ? null : line.sourceLineId;
          msg('', '');
          renderLines();
          paintOverlay();
        });
      }
      box.appendChild(row);
    }

    const btn = $('#scConfirm');
    if (btn) btn.disabled = state.moves.size === 0;
  }

  function onSeatClick(ev) {
    const node = ev.target?.closest?.('[data-seat-id],[data-seat]');
    if (!node) return;
    const seatId = String(node.getAttribute('data-seat-id') || node.getAttribute('data-seat') || '').trim();
    if (!seatId) return;

    const line = state.lines.find(l => l.sourceLineId === state.selectedLineId);
    if (!line) { msg('err', 'Choisissez d’abord la place à changer, à droite.'); return; }

    // Recliquer la place déjà choisie pour cette ligne annule le choix.
    if (state.moves.get(line.sourceLineId) === seatId) {
      state.moves.delete(line.sourceLineId);
      renderLines(); paintOverlay();
      return;
    }

    const rec = state.seats.get(seatId);
    if (!rec) return;
    if (rec.zoneKey !== line.zoneKey) {
      msg('err', `Le changement est limité à votre zone (${line.zoneKey}).`);
      return;
    }
    if (rec.status !== 'available' || state.lines.some(l => currentSeatFor(l) === seatId)) {
      msg('err', 'Cette place n’est pas disponible.');
      return;
    }
    if ([...state.moves.values()].includes(seatId)) { msg('err', 'Place déjà choisie.'); return; }

    state.moves.set(line.sourceLineId, seatId);
    msg('', '');
    renderLines();
    paintOverlay();
  }

  function errorText(code) {
    switch (code) {
      case 'window_closed':    return 'Le match a commencé : le changement de place n’est plus possible.';
      case 'already_moved':    return 'Cette place a déjà été changée une fois.';
      case 'different_zone':   return 'Le changement est limité à votre zone.';
      case 'seat_unavailable': return 'Cette place vient d’être prise. Choisissez-en une autre.';
      case 'missing_or_invalid_token': return 'Lien invalide ou expiré.';
      default: return 'Une erreur est survenue. Réessayez.';
    }
  }

  async function confirmChanges() {
    const changes = [...state.moves.entries()].map(([sourceLineId, toSeatId]) => ({ sourceLineId, toSeatId }));
    if (!changes.length) return;
    const btn = $('#scConfirm');
    if (btn) btn.disabled = true;

    let data = {};
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes })
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed');
    } catch (err) {
      msg('err', errorText(data.error || String(err.message || '')));
      state.moves.clear();
      if (btn) btn.disabled = false;
      // Le plan a pu bouger entre-temps : on repart de l'état serveur.
      window.BTS_VIEW.refresh?.();
      return;
    }

    state.moves.clear();
    msg('ok', data.ticketResent
      ? 'Changement enregistré. Votre nouveau billet vient de vous être envoyé par email.'
      : 'Changement enregistré. Votre billet mis à jour vous sera envoyé sous peu.');
    window.BTS_VIEW.refresh?.();
  }

  window.BTS_VIEW.on('afterData', ({ data }) => {
    if (!data?.ok) { msg('err', errorText(data?.error)); return; }

    state.lines = Array.isArray(data.lines) ? data.lines : [];
    state.seats = new Map((data.seats || []).map(s => [s.seatId, s]));

    const when = data.event?.startsAt ? new Date(data.event.startsAt) : null;
    const lead = $('#scLead');
    if (lead) lead.textContent = `${data.event?.name || ''}${when ? ' — ' + when.toLocaleString() : ''}`;

    renderLines();
    paintOverlay();
  });

  window.BTS_VIEW.on('planReady', ({ svgDoc }) => {
    state.svgDoc = svgDoc || null;
    if (!state.svgDoc) return;
    try {
      const style = state.svgDoc.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = '.seat-allowed { stroke: #1abc63; stroke-width: 2px; }';
      state.svgDoc.documentElement.appendChild(style);
    } catch { /* purement cosmétique */ }
    state.svgDoc.addEventListener('click', onSeatClick);
    paintOverlay();
  });

  document.addEventListener('DOMContentLoaded', () => {
    $('#scConfirm')?.addEventListener('click', confirmChanges);
    $('#scReset')?.addEventListener('click', () => {
      state.moves.clear();
      state.selectedLineId = null;
      msg('', '');
      renderLines();
      paintOverlay();
    });
  });
})();
