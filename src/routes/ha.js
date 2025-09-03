// src/routes/ha.js
import express from 'express';
import { Order, Seat } from '../models/index.js';
import { getCheckoutStatus } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';
import { renderEmailTemplate } from '../utils/email-template.js';

const router = express.Router();

// Helpers
const isStub = () => String(process.env.HELLOASSO_STUB || '').toLowerCase() === 'true';
const stubResultEnv = () => String(process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();

async function markSeatsReserved(order) {
  try {
    const seatIds = (order?.lines || []).map(l => l.seatId).filter(Boolean);
    if (!seatIds.length) return;
    await Seat.updateMany(
      { _id: { $in: seatIds } },
      { $set: { status: 'reserved' } }
    );
  } catch (e) {
    console.warn('[ha/return] seat update failed:', e.message);
  }
}

function isPaidLike(status) {
  return /^(paid|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(status || '').trim());
}

/**
 * GET /ha/return
 * Scénarios:
 *  - STUB (HELLOASSO_STUB=true OU ?stub=1): pas d’appel réseau, succès/échec via result/env.
 *  - SANDBOX/PROD: vérif via HelloAsso (getCheckoutStatus).
 *
 * Query attendue (selon le flow):
 *   - STUB:   ?oid=<OrderId>&ci=<intentId>&stub=1&result=success|failure
 *   - HA:     ?checkoutIntentId=<id>&code=succeeded|canceled&orderId=<haOrderId>
 */
router.get('/ha/return', async (req, res) => {
  try {
    const {
      oid, ci, stub, result,
      checkoutIntentId, code, orderId
    } = req.query;

    const inStub = isStub() || String(stub) === '1' || typeof result !== 'undefined';
    let order = null;

    // Récupère la commande
    if (oid) {
      order = await Order.findById(oid);
    } else if (checkoutIntentId) {
      order = await Order.findOne({ 'paymentProviderMeta.checkoutIntentId': checkoutIntentId });
    } else if (ci) {
      order = await Order.findOne({ 'paymentProviderMeta.checkoutIntentId': ci });
    }

    if (!order) {
      return res.status(404).send('<h1>Order not found</h1>');
    }

    if (order.status === 'paid') {
      return res.send(`<h1>Paiement déjà confirmé ✅</h1><p>Commande ${order._id}</p>`);
    }

    let status;

    if (inStub) {
      // 🔒 STUB: pas d’appel HelloAsso, on décide localement
      const desired = String(result || stubResultEnv());
      status = (desired === 'success') ? 'success' : 'failure';

      // trace minimale “provider”
      order.paymentProvider = 'helloasso'; // on garde helloasso pour homogénéité
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: 'stub',
        checkoutIntentId: ci || `stub-${Date.now()}`,
        stubResult: status
      };
    } else {
      // 🌐 PROD/SANDBOX: on vérifie via l’API (nécessite les creds)
      const resolvedIntentId = checkoutIntentId || ci;
      if (!resolvedIntentId) {
        return res.status(400).send('<h1>Bad Request</h1><p>checkoutIntentId manquant</p>');
      }
      try {
        status = await getCheckoutStatus(resolvedIntentId); // doit renvoyer 'succeeded' / 'failed' / ...
      } catch (e) {
        console.error('[ha/return] getCheckoutIntent failed:', e.message || e);
        return res.status(500).send('<h1>Erreur interne</h1>');
      }

      // enrichit la commande avec les infos HelloAsso
      order.paymentProvider = 'helloasso';
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: 'helloasso',
        haOrderId: orderId || order.paymentProviderMeta?.haOrderId || null,
        checkoutIntentId: resolvedIntentId,
        code: code || null
      };
    }

    if (isPaidLike(status)) {
      order.status = 'paid';
      await order.save();
      await markSeatsReserved(order);

      // Email de confirmation
      try {

const TEMPLATE_BY_KIND = {
  renew:   process.env.EMAIL_TEMPLATE_RENEW_CONFIRM   || 'renew-confirmation',
  fanclub: process.env.EMAIL_TEMPLATE_TBH7_CONFIRM || 'tbh7-confirmation',
  public:  process.env.EMAIL_TEMPLATE_PUBLIC_CONFIRM  || 'public-confirmation',
  unknown: process.env.EMAIL_TEMPLATE_DEFAULT         || 'renew-confirmation'
};

const SUBJECT_BY_KIND = {
  renew:   process.env.EMAIL_SUBJECT_RENEW_CONFIRM   || 'Confirmation de paiement – Abonnement (Renouvellement)',
  fanclub: process.env.EMAIL_SUBJECT_TBH7_CONFIRM    || 'Confirmation de paiement – Fan Club TBH7',
  public:  process.env.EMAIL_SUBJECT_PUBLIC_CONFIRM  || 'Confirmation de paiement – Abonnement (Grand public)',
  unknown: process.env.EMAIL_SUBJECT_DEFAULT         || 'Confirmation de paiement – Abonnement'
};

function resolveOrderKind(order) {
  // priorité aux champs persistés
  if (order.mailTemplateKind) return String(order.mailTemplateKind).toLowerCase();
  if (order.origin?.flow)     return String(order.origin.flow).toLowerCase();

  // fallback doux (au cas où)
  const phase = String(order.phase || '').toLowerCase();
  if (['renew','fanclub','public','tbh7','grandpublic'].includes(phase)) {
    return phase === 'tbh7' ? 'fanclub' : (phase === 'grandpublic' ? 'public' : phase);
  }
  return 'unknown';
}
        
// ...
const kind    = resolveOrderKind(order);
const tplName = TEMPLATE_BY_KIND[kind];
const subject = SUBJECT_BY_KIND[kind];

const linesRows = (Array.isArray(order.lines) ? order.lines : [])
  .map(l => `<tr><td>${l.seatId || l.zoneKey || ''}</td><td>${l.tariffCode || ''}</td><td>${(Number(l.priceCents||0)/100).toFixed(2)} €</td></tr>`)
  .join('');

const ctx = {
  order,
  orderId: String(order._id),
  seasonCode: order.seasonCode || '',
  venueSlug: order.venueSlug || '',
  payerFirstName: order.payerFirstName || '',
  payerLastName:  order.payerLastName  || '',
  payerEmail:     order.payerEmail     || '',
  totalEuro: ((Number(order.totalCents || 0) / 100).toFixed(2)),
  installmentsInfo: (Number(order.installments || order.paymentSplit || 1) > 1)
    ? `Règlement en ${Number(order.installments || order.paymentSplit)} échéances.`
    : `Règlement en une fois.`,
  linesRows,
  haOrderBlock: order.paymentProviderOrderId ? `<p>Référence HelloAsso : <b>${order.paymentProviderOrderId}</b></p>` : '',
  clubName: process.env.CLUB_NAME || 'Les Bélougas',
  extraInfo: ''
};

const html = await renderEmailTemplate(tplName, ctx);
console.log(html);

await sendMail({ to: order.payerEmail, subject, html });

      } catch (e) {
        console.warn('sendMail failed:', e.message);
      }

      return res.send(`<h1>Paiement confirmé ✅</h1><p>Commande ${order._id}</p>`);
    } else {
      order.status = 'failed';
      await order.save();
      return res.send(`<h1>Paiement non confirmé ❌</h1><p>Commande ${order._id} — statut: ${status}</p>`);
    }
  } catch (e) {
    console.error('[GET /ha/return] error:', e);
    res.status(500).send('<h1>Erreur interne</h1>');
  }
});

router.get('/ha/back', (_req, res) => {
  res.send('<h1>Paiement abandonné</h1><p>Vous pouvez reprendre votre commande ultérieurement.</p>');
});

router.get('/ha/error', (_req, res) => {
  res.status(400).send('<h1>Erreur de paiement</h1><p>Une erreur est survenue. Réessayez plus tard.</p>');
});

export default router;
