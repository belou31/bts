// src/routes/ha.js
import express from 'express';
import { Order, Seat } from '../models/index.js';
import { getCheckoutStatus } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';
import { renderOrderEmail, subjectForOrder } from '../services/mailer.js';

const router = express.Router();

// Helpers
const isStub = () => String(process.env.HELLOASSO_STUB || '').toLowerCase() === 'true';
const stubResultEnv = () => String(process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();

// Marque en "booked" tous les SIÈGES réels de la commande (renew/subscription).
// - Ignore les lignes "zone" (ex: TBH7-Z001)
// - Idempotent: on remet "booked" même si l'état précédent n'était pas "available"
async function markSeatsBooked(order) {
  try {
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    const realSeatIds = Array.from(new Set(
      lines.map(l => String(l.seatId || '').trim())
           // Ignore les pseudo-IDs de zone (ex: TBH7-Z001)
           .filter(s => s && !/-Z\d{3,}$/i.test(s))
    ));

    if (!realSeatIds.length) return;
    // ⚙️ Mise à jour inconditionnelle par seatId (sans filtre d'état) pour couvrir "Provisioned", "Held", etc.
    const r = await Seat.updateMany(
      { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: realSeatIds } },
      { $set: { status: 'booked' } },
      { runValidators: false }
    );
    console.log('[ha/return] seats → booked',
      { count: realSeatIds.length, matched: r.matchedCount ?? r.n ?? 0, modified: r.modifiedCount ?? r.nModified ?? 0, ids: realSeatIds });
    
  } catch (e) {
    console.warn('[ha/return] seat update failed:', e.message);
  }
}

function isPaidLike(status) {
  return /^(paid|authorized|authorized_ok|ok|success|succeeded)$/i.test(String(status || '').trim());
}

/**
 * GET /ha/return
 * STUB:   ?oid=<OrderId>&ci=<intentId>&stub=1&result=success|failure
 * HA:     ?checkoutIntentId=<id>&code=succeeded|canceled&orderId=<haOrderId>
 */
router.get('/ha/return', async (req, res) => {
  try {
    const {
      oid, ci, stub, result,
      checkoutIntentId, code, orderId
    } = req.query;

    const inStub = isStub() || String(stub) === '1' || typeof result !== 'undefined';
    let order = null;

    // Find order
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
      const desired = String(result || stubResultEnv());
      status = (desired === 'success') ? 'success' : 'failure';

      // trace minimale “provider”
      order.paymentProvider = 'helloasso';
      order.paymentProviderMeta = {
        ...(order.paymentProviderMeta || {}),
        name: 'stub',
        checkoutIntentId: ci || `stub-${Date.now()}`,
        stubResult: status
      };
    } else {
      // PROD/SANDBOX: verify via HelloAsso
      const resolvedIntentId = checkoutIntentId || ci;
      if (!resolvedIntentId) {
        return res.status(400).send('<h1>Bad Request</h1><p>checkoutIntentId manquant</p>');
      }
      try {
        status = await getCheckoutStatus(resolvedIntentId); // 'succeeded' / 'failed' / ...
      } catch (e) {
        console.error('[ha/return] getCheckoutIntent failed:', e.message || e);
        return res.status(500).send('<h1>Erreur interne</h1>');
      }

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
      await markSeatsBooked(order);
      // --- EMAIL ---
      try {
        const html    = await renderOrderEmail(order);
        const subject = subjectForOrder(order);
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
