// src/models/TariffPrice.js
import mongoose from 'mongoose';

const TariffPriceSchema = new mongoose.Schema({
  seasonCode: { type: String, index: true, required: true },   // ex: "2025-2026"
  venueSlug:  { type: String, index: true, required: true },   // ex: "patinoire-blagnac"
  zoneKey:    { type: String, index: true, required: true },   // ex: "N1", "S1", "DEBOUT"
  tariffCode: { type: String, required: true },                 // ex: "NORMAL", "ETUDIANT"
  priceCents: { type: Number, required: true }                  // ex: 18000
}, { timestamps: true });

TariffPriceSchema.index(
  { seasonCode: 1, venueSlug: 1, zoneKey: 1, tariffCode: 1 },
  { unique: true, name: 'uniq_season_venue_zone_tariff' }
);

export const TariffPrice = mongoose.models.TariffPrice || mongoose.model('TariffPrice', TariffPriceSchema);
