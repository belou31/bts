
import { Order } from '../models/Order';
import { Seat } from '../models/Seat';
import { SeatHold } from '../models/SeatHold';
import { Subscriber } from '../models/Subscriber';

async function markOrderPaid({ orderNo, haOrderId, checkoutIntentId }) {
  const order = await Order.findOne({ orderNo });
  if (!order) throw Object.assign(new Error(`order ${orderNo} not found`), { status: 404 });

  if (['paid', 'completed'].includes(order.status)) return order; // idempotent

  order.status = 'paid';
  order.paidAt = new Date();
  order.paymentProvider = { name: 'helloasso', haOrderId, checkoutIntentId };
  await order.save();

  // Book seats & clear holds
  for (const it of order.items) {
    if (it.kind === 'SEAT' && it.seatId) {
      await Seat.findOneAndUpdate(
        { seatId: it.seatId, seasonCode: order.seasonCode },
        { status: 'booked' }
      );
      await SeatHold.deleteMany({ seatId: it.seatId });
    }
    // Standing: gestion des quotas à faire plus tard (todo)
  }

  // Option: activer l'abonné si on avait subscriberId dans metadata (géré côté import/renew)
  // Ici, on ne touche pas au Subscriber sans lien explicite dans Order.

  return order;
}

export { markOrderPaid };
