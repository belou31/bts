(() => {
  const ready = (fn) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  };

  const emitFeedback = (kind, title, details) => {
    const fn = window.BTS_VIEW?.setFeedback;
    if (typeof fn === 'function') {
      fn(kind, title, details);
    } else if (kind === 'error') {
      console.error(title, details);
    } else {
      console.log(title, details);
    }
  };

  function removeDefaultPayHandler(btn) {
    if (!btn) return;
    const handler = window.BTS_VIEW?.submitPayment;
    if (typeof handler === 'function') {
      btn.removeEventListener('click', handler);
    }
  }

  function updateButtonLabel(btn, label) {
    if (!btn || !label) return;
    btn.textContent = label;
  }

  function clearCart() {
    const rows = document.querySelectorAll('#cartRows .cart-row');
    rows.forEach((row) => row.remove());
    window.BTS_VIEW?.api?.recomputeTotals?.();
  }

  function resolveReserveEndpoint(cfg) {
    return cfg?.reserveApi ||
      cfg?.apiReserve ||
      window.BTS_VIEW_CONFIG?.api?.reserve ||
      window.BTS_VIEW_CONFIG?.api?.checkout;
  }

  async function submitReservation(cfg) {
    const buildPayload = window.BTS_VIEW?.collectCheckoutPayload;
    if (typeof buildPayload !== 'function') {
      console.warn('[partner] collectCheckoutPayload unavailable');
      return;
    }
    const payload = buildPayload();
    if (!payload) return;

    const btn = document.getElementById('payBtn');
    if (btn) btn.disabled = true;

    const endpoint = resolveReserveEndpoint(cfg);
    if (!endpoint) {
      emitFeedback('error', 'Réservation indisponible (endpoint manquant).');
      if (btn) btn.disabled = false;
      return;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        const msg = body?.error || cfg?.errorMessage || 'Impossible d’enregistrer votre demande. Réessayez.';
        emitFeedback('error', msg);
        if (btn) btn.disabled = false;
        return;
      }
      const success = cfg?.successMessage || 'Demande envoyée. Vous recevrez vos billets par email.';
      emitFeedback('ok', success);
      clearCart();
    } catch (err) {
      console.error('[partner] reservation error:', err);
      emitFeedback('error', 'Impossible d’enregistrer votre demande pour le moment. Réessayez plus tard.');
      if (btn) btn.disabled = false;
    }
  }

  function setupInvoiceMode(cfg) {
    const btn = document.getElementById('payBtn');
    if (!btn) return;
    removeDefaultPayHandler(btn);
    if (cfg?.payButtonLabel) {
      updateButtonLabel(btn, cfg.payButtonLabel);
    }
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      submitReservation(cfg);
    });
  }

  ready(() => {
    const partnerCfg = window.BTS_VIEW_CONFIG?.partner;
    if (!partnerCfg) return;
    if (partnerCfg.invoiceMode === 'invoice') {
      setupInvoiceMode(partnerCfg);
    }
  });
})();
