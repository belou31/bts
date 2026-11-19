import mongoose from 'mongoose';

const SeatHoldSchema = new mongoose.Schema({
  eventId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Event', index: true },
  seasonCode: { type: String, index: true },
  venueSlug:  { type: String, index: true },
  seatId:     { type: String, index: true },
  zoneKey:    { type: String, uppercase: true, trim: true, index: true },
  orderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  sessionToken: { type: String, index: true, default: '' },
  reason:     { type: String, default: '' },
  // Motif d'un blocage posé à la main depuis admin/plan (invitation, siège
  // cassé, rangée neutralisée pour ce match). Déclaré, sans quoi `strict`
  // l'écarterait en silence et le blocage serait sans explication.
  note:       { type: String, default: '' },
  forced:     { type: Boolean, default: false },
  // IMPORTANT: pas d'index inline ici pour éviter le doublon
  expiresAt:  { type: Date }
}, { timestamps: true });

SeatHoldSchema.index({ eventId: 1, seatId: 1 }, { unique: true, name: 'idx_event_seat' });
SeatHoldSchema.index({ eventId: 1, zoneKey: 1 }, { name: 'idx_event_zone' });

// Index TTL unique (supprime le doc quand expiresAt est atteint)
SeatHoldSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expiresAt' });

export const SeatHold = mongoose.models.SeatHold || mongoose.model('SeatHold', SeatHoldSchema);
