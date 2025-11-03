// src/models/TariffPriceCatalog.js
import mongoose from 'mongoose';

const TariffPriceCatalogSchema = new mongoose.Schema({
  catalogSlug: { type: String, required: true, trim: true, lowercase: true },
  venueSlug:   { type: String, default: null, index: true },
  zoneKey:     { type: String, required: true, trim: true, uppercase: true },
  tariffCode:  { type: String, required: true, trim: true, uppercase: true },
  priceCents:  { type: Number, required: true },
  currency:    { type: String, default: 'EUR' }
}, { timestamps: true });

TariffPriceCatalogSchema.index(
  { catalogSlug: 1, venueSlug: 1, zoneKey: 1, tariffCode: 1 },
  { unique: true, name: 'uniq_tariff_price_catalog_entry' }
);

export const TariffPriceCatalog = mongoose.models.TariffPriceCatalog
  || mongoose.model('TariffPriceCatalog', TariffPriceCatalogSchema);
