// src/routes/ha.js
import express from 'express';
import { Order } from '../models/index.js';
import { getCheckoutStatus } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';

const router = express.Router();

/**
 * GET /ha/return
 * Query: ?oid=<orderId>&ci=<intentId> (&stub=1&result=success|failure)
 */
router.get('/ha/return', async (req, res) => {
  try {
    const { oid, ci, stub, result } = req.query;
    const order = await Order.findById(oid);
    if (!order) return res.status(404).send('Order not found');

    let status;
    if (stub === '1' || result) {
      status = (String(result || 'success').toLowerCase() === 'success') ? 'Paid' : 'Failed';
    } else {
      status = await getCheckoutStatus(ci);
    }

    if (/paid|authorized|ok|success/i.test(status)) {
      order.status = 'paid';
      await order.save();

      // Email attestation (STUB écrit un .eml si EMAIL_STUB=true)
      try {
        await sendMail({
          to: order.payerEmail || order.email,
          subject: 'Confirmation de paiement - Abonnement',
          text: `Votre commande ${order._id} a été confirmée.`,
          html: `<p>Bonjour,</p><p>Votre commande <b>${order._id}</b> a été confirmée ✅.</p>`
        });
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
    console.error('/ha/return error', e);
    res.status(500).send('Erreur interne');
  }
});

router.get('/ha/back', (_req, res) => {
  res.send('<h1>Paiement abandonné</h1><p>Vous pouvez reprendre votre commande ultérieurement.</p>');
});

router.get('/ha/error', (_req, res) => {
  res.status(400).send('<h1>Erreur de paiement</h1><p>Une erreur est survenue. Réessayez plus tard.</p>');
});

export default router;
