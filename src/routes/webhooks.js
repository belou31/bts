
import express from 'express';
import { PaymentIntent } from '../models/PaymentIntent.js';
import { verifyHaSignature } from '../services/helloasso.js';
import { markOrderPaid } from '../controllers/order.js';

const router = express.Router();

// raw body uniquement pour ce webhook
router.post('/helloasso', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.get('x-ha-signature') || '';
    if (!verifyHaSignature(req.body, signature)) {
      console.warn('[HA] signature invalide');
      return res.sendStatus(400);
    }

    const event = JSON.parse(req.body.toString('utf8'));
    const type = event?.eventType;
    const data = event?.data || {};
    const meta = event?.metadata || {};

    if (type === 'Order') {
      const checkoutIntentId = data?.checkoutIntentId;
      const haOrderId = data?.id;

      // tracer l'intent
      if (checkoutIntentId) {
        await PaymentIntent.findOneAndUpdate(
          { checkoutIntentId },
          { status: 'succeeded', orderId: haOrderId },
          { upsert: false }
        );
      }

      // finaliser la commande si on a l'orderNo en metadata
      if (meta?.orderNo) {
        try {
          await markOrderPaid({ orderNo: meta.orderNo, haOrderId, checkoutIntentId });
        } catch (e) {
          console.error('[BTS] markOrderPaid failed:', e);
          // on répond tout de même 200 pour éviter des retries infinis en DEV
        }
      }

      return res.sendStatus(200);
    }

    // autres événements : OK
    res.sendStatus(200);
  } catch (e) {
    console.error('[HA webhook]', e);
    res.sendStatus(200); // éviter retries en DEV
  }
});

export default router;
