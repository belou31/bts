// src/models/TariffPrice.js
import mongoose from 'mongoose';
import { serializeChannelList } from '../utils/channel-scopes.js';

const TariffPriceSchema = new mongoose.Schema({
  // Abonnement/historique
  seasonCode: { type: String, index: true, default: null },   // ex: "2025-2026"
  venueSlug:  { type: String, index: true, default: null },   // ex: "patinoire-blagnac"

  zoneKey:    { type: String, index: true, required: true },   // ex: "N1", "S1", "DEBOUT"
  tariffCode: { type: String, required: true },                 // ex: "NORMAL", "ETUDIANT"
  priceCents: { type: Number, required: true },                 // ex: 18000
  // Optional partner billing price (what the partner pays/subsidizes)
  partnerPriceCents: { type: Number, default: null },
  currency: { type: String, default: 'EUR' },
  // Événement : clé de table dédiée
  priceTableKey: { type: String, index: true, default: null },
  channels: {
    type: [String],
    default: undefined,
    set: serializeChannelList
  }
}, { timestamps: true });

TariffPriceSchema.index(
  { seasonCode: 1, venueSlug: 1, zoneKey: 1, tariffCode: 1 },
  {
    unique: true,
    name: 'uniq_season_venue_zone_tariff',
    partialFilterExpression: {
      seasonCode: { $type: 'string' },
      venueSlug:  { $type: 'string' }
    }
  }
);

// Unicité par table événementielle : (priceTableKey, zoneKey, tariffCode)
TariffPriceSchema.index(
  { priceTableKey: 1, zoneKey: 1, tariffCode: 1 },
  {
    unique: true,
    name: 'uniq_priceTable_zone_tariff',
    partialFilterExpression: { priceTableKey: { $type: 'string' } }
  }
);


export const TariffPrice = mongoose.models.TariffPrice || mongoose.model('TariffPrice', TariffPriceSchema);
