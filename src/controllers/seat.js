
import { Seat } from '../models/Seat.js';
import { SeatHold } from '../models/SeatHold.js';


async function holdSeat({ seatId, seasonCode, orderId, ttlMinutes = 10, subscriberId = null }) {
  const seat = await Seat.findOne({ seatId, seasonCode });
  if (!seat) throw Object.assign(new Error(`Seat ${seatId} not found`), { status: 404 });

  const ok =
    seat.status === 'available' ||
    (seat.status === 'provisioned' && subscriberId && String(seat.provisionedFor) === String(subscriberId));

  if (!ok) {
    throw Object.assign(new Error(`Seat ${seatId} not available`), { status: 409 });
  }

  // Passe en held
  seat.status = 'held';
  await seat.save();

  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await SeatHold.create({ seatId, orderId, expiresAt });
  return true;
}

exports default holdSeat;
