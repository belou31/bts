// static/js/voucher-buy.js — achat d'un bon cadeau (amont).
//
// Page autonome : contrairement au retrait, il n'y a ici ni plan ni sièges à
// choisir, donc rien à tirer de generic-view.js. Un compteur, un total, et un
// passage au paiement.

(function () {
  const CFG = window.VOUCHER_BUY || {};
  const $ = (sel) => document.querySelector(sel);

  let qty = Number(CFG.min || 1);

  const fmt = (cents) => {
    try {
      return new Intl.NumberFormat(CFG.locale === 'en' ? 'en-GB' : 'fr-FR',
        { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);
    } catch {
      return ((cents || 0) / 100).toFixed(2) + ' €';
    }
  };

  function msg(kind, text) {
    const el = $('#buyMsg');
    if (!el) return;
    el.className = 'feedback buy-msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  function render() {
    const out = $('#qtyOut');
    const tot = $('#totalOut');
    if (out) out.textContent = String(qty);
    if (tot) tot.textContent = fmt(qty * Number(CFG.unitCents || 0));
    const minus = $('#qtyMinus');
    const plus = $('#qtyPlus');
    if (minus) minus.disabled = qty <= Number(CFG.min || 1);
    if (plus) plus.disabled = qty >= Number(CFG.max || 10);
  }

  function errorText(code) {
    switch (code) {
      case 'purchase_disabled':   return 'La vente de bons n’est pas ouverte pour le moment.';
      case 'invalid_places':      return 'Nombre de places invalide.';
      case 'email_required':      return 'Indiquez un email valide.';
      case 'price_not_configured':return 'Tarif non configuré. Contactez le club.';
      case 'payment_unavailable': return 'Le paiement est momentanément indisponible. Réessayez.';
      default: return 'Une erreur est survenue. Réessayez.';
    }
  }

  async function submit(ev) {
    ev.preventDefault();
    const btn = $('#buyBtn');
    if (btn) btn.disabled = true;
    msg('', '');

    let data = {};
    try {
      const res = await fetch(CFG.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          places: qty,
          recipient: $('#recipient')?.value || '',
          message: $('#message')?.value || '',
          buyer: {
            firstName: $('#buyerFirst')?.value || '',
            lastName: $('#buyerLast')?.value || '',
            email: $('#buyerEmail')?.value || ''
          }
        })
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed');
    } catch (err) {
      msg('err', errorText(data.error || String(err.message || '')));
      if (btn) btn.disabled = false;
      return;
    }

    if (data.providerUrl) {
      msg('ok', 'Redirection vers le paiement…');
      window.location.href = data.providerUrl;
      return;
    }
    // Sans URL fournisseur il n'y a rien à faire côté client : le dire plutôt
    // que laisser l'acheteur devant un bouton inerte.
    msg('err', 'Impossible de démarrer le paiement. Réessayez dans quelques instants.');
    if (btn) btn.disabled = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#qtyMinus')?.addEventListener('click', () => { qty = Math.max(Number(CFG.min || 1), qty - 1); render(); });
    $('#qtyPlus')?.addEventListener('click', () => { qty = Math.min(Number(CFG.max || 10), qty + 1); render(); });
    $('#buyForm')?.addEventListener('submit', submit);
    render();
  });
})();
