// src/payments/helloasso.js
// STUB HelloAsso pour DEV + garde-fou "déjà renouvelé".
// En PROD/SANDBOX: on laisse un fallback "not_implemented_here" (à remplacer par ton vrai flux HA).

import { Order } from '../models/Order.js';
import { Seat } from '../models/Seat.js';
import { Subscriber } from '../models/Subscriber.js';
import { PaymentIntent } from '../models/PaymentIntent.js';

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');
}

async function markSuccess({ seasonCode, venueSlug, groupKey, email, lines, totalCents, providerRef }) {
  // Idempotence: si un order paid existe déjà, on renvoie ce "paid"
  const exists = await Order.findOne({ seasonCode, venueSlug, groupKey, status: 'paid' }).lean();
  if (exists) return exists;

  const order = await Order.create({
    seasonCode, venueSlug, groupKey, payerEmail: email,
    lines, totalCents, status: 'paid',
    paymentProvider: 'helloasso', providerRef
  });

  // Book seats + clear provision
  const seatIds = lines.map(l => l.seatId);
  await Seat.updateMany(
    { seasonCode, venueSlug, seatId: { $in: seatIds } },
    { $set: { status: 'booked', provisionedFor: null } }
  );

  // Activer les subscribers du groupe
  await Subscriber.updateMany(
    { seasonCode, venueSlug, groupKey },
    { $set: { status: 'active' } }
  );

  return order;
}

async function markFailure({ seasonCode, venueSlug, groupKey, email, lines, totalCents, providerRef }) {
  return Order.create({
    seasonCode, venueSlug, groupKey, payerEmail: email,
    lines, totalCents, status: 'failed',
    paymentProvider: 'helloasso', providerRef
  });
}

async function checkout(payload) {
  const {
    seasonCode, venueSlug, groupKey, email,
    lines, totalCents, installments = 1
  } = payload;

  // Anti double-commande côté paiement aussi
  const already = await Order.exists({ seasonCode, venueSlug, groupKey, status: 'paid' });
  if (already) return { error: 'already_renewed' };

  const isStub = String(process.env.HELLOASSO_STUB || '').toLowerCase() === 'true';

  // Enregistre un intent (utile aussi en stub pour logs)
  const intent = await PaymentIntent.create({
    seasonCode, venueSlug, groupKey, payerEmail: email,
    lines, totalCents, provider: 'helloasso', installments,
  });

  if (isStub) {
    const result = (process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();
    if (result === 'success') {
      await markSuccess({ seasonCode, venueSlug, groupKey, email, lines, totalCents, providerRef: `stub:${intent._id}` });
      return {
        checkoutIntentId: String(intent._id),
        redirectUrl: `${appUrl()}/ha/return?status=success&ref=${intent._id}`
      };
    } else {
      await markFailure({ seasonCode, venueSlug, groupKey, email, lines, totalCents, providerRef: `stub:${intent._id}` });
      return {
        checkoutIntentId: String(intent._id),
        redirectUrl: `${appUrl()}/ha/return?status=failure&ref=${intent._id}`
      };
    }
  }

  // VRAI HelloAsso (à brancher ici si besoin)
  return { error: 'not_implemented_here' };
}

export { checkout };
