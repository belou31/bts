import mongoose from 'mongoose';

const EventSchema = new mongoose.Schema({
  slug:       { type: String, unique: true, index: true },     // ex: "match-2025-09-15-bts-vs-xxx"
  name:       { type: String, required: true },
  startsAt:   { type: Date, required: true },
  seasonCode: { type: String, index: true, required: true },
  venueSlug:  { type: String, index: true, default: null },
  priceTableKey: { type: String, default: null },              // table tarifs dédiée
  // Sale lifecycle (replaces the old isOnSale boolean): notopen -> presale -> onsale -> [soldout] -> closed.
  sale:       { type: String, enum: ['notopen', 'presale', 'onsale', 'soldout', 'closed'], default: 'notopen', index: true },
  // Publication lifecycle, independent of sale: draft -> active -> archived.
  activity:   { type: String, enum: ['draft', 'active', 'archived'], default: 'draft', index: true },
  // Banque de QR pré-générés (phase 1) : { provider:"bank", codes:[hex...] }
  qrBank: {
    provider: { type: String, default: 'bank' },
    buckets:  { type: mongoose.Schema.Types.Mixed, default: undefined },
    codes:    { type: [String], default: [] }
  },
  // Vue spécifique du plan (ex: variante partenaire)
  venueView: { type: String, default: null },
  // Optionnel : description courte affichable côté front
  description: { type: String, default: '' }
}, { timestamps: true });

export const Event = mongoose.models.Event || mongoose.model('Event', EventSchema);
