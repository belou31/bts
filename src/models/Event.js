import mongoose from 'mongoose';

const EventSchema = new mongoose.Schema({
  slug:       { type: String, unique: true, index: true },     // ex: "match-2025-09-15-bts-vs-xxx"
  name:       { type: String, required: true },
  startsAt:   { type: Date, required: true },
  seasonCode: { type: String, index: true, required: true },
  venueSlug:  { type: String, index: true, required: true },
  priceTableKey: { type: String, default: null },              // table tarifs dédiée
  isOnSale:   { type: Boolean, default: false }
}, { timestamps: true });

export const Event = mongoose.models.Event || mongoose.model('Event', EventSchema);
