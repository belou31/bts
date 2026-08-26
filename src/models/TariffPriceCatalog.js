// src/models/TariffPriceCatalog.js
import mongoose from 'mongoose';
import { serializeChannelList } from '../utils/channel-scopes.js';

const TariffPriceCatalogSchema = new mongoose.Schema({
  catalogSlug: { type: String, required: true, trim: true, lowercase: true },
  venueSlug:   { type: String, default: null, index: true },
  // Comme TariffPrice : une entrée vise SOIT une zone, SOIT une méta-zone
  // tarifaire. La méta-zone traverse ensuite l'instanciation telle quelle.
  zoneKey:     { type: String, default: null, trim: true, uppercase: true },
  metaZone: { type: String, default: null, trim: true, uppercase: true, index: true },
  tariffCode:  { type: String, required: true, trim: true, uppercase: true },
  priceCents:  { type: Number, required: true },
  partnerPriceCents: { type: Number, default: null },
  currency:    { type: String, default: 'EUR' },
  channels: {
    type: [String],
    default: undefined,
    set: serializeChannelList
  }
}, { timestamps: true });

TariffPriceCatalogSchema.index(
  { catalogSlug: 1, venueSlug: 1, zoneKey: 1, metaZone: 1, tariffCode: 1 },
  { unique: true, name: 'uniq_tariff_price_catalog_entry' }
);

export const TariffPriceCatalog = mongoose.models.TariffPriceCatalog
  || mongoose.model('TariffPriceCatalog', TariffPriceCatalogSchema);
