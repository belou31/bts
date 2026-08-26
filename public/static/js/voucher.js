// static/js/voucher.js
//
// Retrait d'un bon cadeau, greffé sur la vue de commande partagée
// (order/index.ejs + generic-view.js) pour bénéficier du plan zoomable et
// déplaçable — choisir une place sans pouvoir zoomer n'est pas praticable.
//
// generic-view charge le plan et peint l'état des sièges ; ce module gère ce
// qui est propre au bon : le solde, la sélection dans le périmètre autorisé,
// et l'envoi.

(function () {
  const $ = (sel) => document.querySelector(sel);
  const CFG = window.BTS_VIEW_CONFIG || {};
  const API = CFG?.voucher || {};

  const state = {
    seats: new Map(),        // seatId -> { zoneKey, status, outOfScope }
    allowedZones: null,      // null = pas de restriction
    allowance: 0,
    picked: [],              // seatIds choisis
    voucher: null,
    svgDoc: null
  };

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  function msg(kind, text) {
    const el = $('#vcMsg');
    if (!el) return;
    el.className = 'feedback' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  function seatEl(seatId) {
    if (!state.svgDoc) return null;
    return state.svgDoc.querySelector(`[data-seat-id="${cssEscape(seatId)}"]`)
        || state.svgDoc.querySelector(`[data-seat="${cssEscape(seatId)}"]`);
  }

  const inScope = (rec) => !state.allowedZones
    || state.allowedZones.has(String(rec.zoneKey || '').toUpperCase());

  function paintOverlay() {
    if (!state.svgDoc) return;
    const chosen = new Set(state.picked);
    for (const [seatId, rec] of state.seats) {
      const el = seatEl(seatId);
      if (!el) continue;
      el.classList.remove('seat-selected', 'seat-allowed');
      el.style.cursor = '';
      if (chosen.has(seatId)) { el.classList.add('seat-selected'); el.style.cursor = 'pointer'; continue; }
      if (rec.status !== 'available' || !inScope(rec)) continue;
      el.classList.add('seat-allowed');
      el.style.cursor = 'pointer';
    }
  }

  function renderPanel() {
    const box = $('#vcSeats');
    const bal = $('#vcBalance');
    if (bal) {
      const left = Math.max(0, state.allowance - state.picked.length);
      bal.textContent = state.picked.length
        ? `${state.picked.length} place(s) choisie(s) — ${left} encore disponible(s)`
        : `Vous pouvez choisir jusqu'à ${state.allowance} place(s)`;
    }
    if (box) {
      box.innerHTML = '';
      if (!state.picked.length) {
        const hint = document.createElement('p');
        hint.className = 'vc-hint';
        hint.textContent = 'Cliquez vos places sur le plan.';
        box.appendChild(hint);
      }
      for (const seatId of state.picked) {
        const row = document.createElement('div');
        row.className = 'vc-seat';
        row.innerHTML = `<span class="vc-seat-id">${seatId}</span>`;
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'vc-drop';
        drop.title = 'Retirer cette place';
        drop.textContent = '✕';
        drop.addEventListener('click', () => {
          state.picked = state.picked.filter(s => s !== seatId);
          msg('', '');
          renderPanel(); paintOverlay();
        });
        row.appendChild(drop);
        box.appendChild(row);
      }
    }
    const btn = $('#vcConfirm');
    if (btn) btn.disabled = state.picked.length === 0;
  }

  function onSeatClick(ev) {
    const node = ev.target?.closest?.('[data-seat-id],[data-seat]');
    if (!node) return;
    const seatId = String(node.getAttribute('data-seat-id') || node.getAttribute('data-seat') || '').trim();
    if (!seatId) return;

    if (state.picked.includes(seatId)) {
      state.picked = state.picked.filter(s => s !== seatId);
      msg('', ''); renderPanel(); paintOverlay();
      return;
    }

    const rec = state.seats.get(seatId);
    if (!rec) return;
    if (!inScope(rec)) { msg('err', 'Cette place n’est pas comprise dans votre invitation.'); return; }
    if (rec.status !== 'available') { msg('err', 'Cette place n’est pas disponible.'); return; }
    if (state.picked.length >= state.allowance) {
      msg('err', `Votre invitation donne droit à ${state.allowance} place(s) pour ce match.`);
      return;
    }

    state.picked.push(seatId);
    msg('', '');
    renderPanel(); paintOverlay();
  }

  function errorText(code) {
    switch (code) {
      case 'voucher_expired':   return 'Ce bon a expiré.';
      case 'voucher_spent':     return 'Ce bon a déjà été entièrement utilisé.';
      case 'voucher_suspended': return 'Ce bon est momentanément suspendu. Contactez le club.';
      case 'voucher_canceled':  return 'Ce bon a été annulé.';
      case 'event_not_eligible':return 'Ce match n’est pas compris dans votre invitation.';
      case 'allowance_exceeded':return 'Vous avez choisi plus de places que votre invitation ne permet.';
      case 'zone_not_allowed':  return 'Une des places choisies n’est pas comprise dans votre invitation.';
      case 'seat_unavailable':  return 'Une des places vient d’être prise. Choisissez-en une autre.';
      case 'email_required':    return 'Indiquez un email valide pour recevoir vos billets.';
      case 'missing_or_invalid_token': return 'Lien invalide ou expiré.';
      default: return 'Une erreur est survenue. Réessayez.';
    }
  }

  async function confirm() {
    if (!state.picked.length) return;
    const btn = $('#vcConfirm');
    if (btn) btn.disabled = true;

    let data = {};
    try {
      const res = await fetch(API.redeem, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventSlug: API.eventSlug,
          seatIds: state.picked,
          holder: {
            firstName: $('#vcFirstName')?.value || '',
            lastName: $('#vcLastName')?.value || '',
            email: $('#vcEmail')?.value || ''
          }
        })
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed');
    } catch (err) {
      msg('err', errorText(data.error || String(err.message || '')));
      if (btn) btn.disabled = false;
      state.picked = [];
      window.BTS_VIEW.refresh?.();
      return;
    }

    state.picked = [];
    msg('ok', data.ticketsSent
      ? 'C’est fait ! Vos billets viennent de vous être envoyés par email.'
      : 'C’est fait ! Vos billets vous seront envoyés par email sous peu.');
    window.BTS_VIEW.refresh?.();
  }

  window.BTS_VIEW.on('afterData', ({ data }) => {
    if (!data?.ok) { msg('err', errorText(data?.error)); return; }

    state.seats = new Map((data.seats || []).map(s => [s.seatId, s]));
    state.allowedZones = Array.isArray(data.allowedZones) ? new Set(data.allowedZones) : null;
    state.allowance = Number(data.allowance || 0);
    state.voucher = data.voucher || null;

    const when = data.event?.startsAt ? new Date(data.event.startsAt) : null;
    const lead = $('#vcLead');
    if (lead) lead.textContent = `${data.event?.name || ''}${when ? ' — ' + when.toLocaleString() : ''}`;

    renderPanel();
    paintOverlay();
  });

  window.BTS_VIEW.on('planReady', ({ svgDoc }) => {
    state.svgDoc = svgDoc || null;
    if (!state.svgDoc) return;
    try {
      const style = state.svgDoc.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = '.seat-allowed { stroke: #1abc63; stroke-width: 2px; }';
      state.svgDoc.documentElement.appendChild(style);
    } catch { /* cosmétique */ }
    state.svgDoc.addEventListener('click', onSeatClick);
    paintOverlay();
  });

  document.addEventListener('DOMContentLoaded', () => {
    $('#vcConfirm')?.addEventListener('click', confirm);
    $('#vcReset')?.addEventListener('click', () => {
      state.picked = [];
      msg('', '');
      renderPanel(); paintOverlay();
    });
  });
})();
