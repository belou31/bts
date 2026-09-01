// src/models/AdCampaign.js
// Global campaign identity — the sponsor's actual creative asset(s) + click
// target, defined ONCE and independent of any event/season. Exactly the
// same role Tariff plays for pricing: Tariff.code is the stable identity
// (label, requirements), while TariffPrice/TariffPriceCatalog decide WHERE
// and at WHAT PRICE it applies per event/season. Here, AdCampaign is the
// identity/creative; AdCampaignCatalog + AdCampaignPlacement decide WHERE
// (which slot, filtered by tariffCode/zoneKey/zoneType), WHEN, and WHAT KIND
// of content (image/qr/text — see contentType there) is shown.
//
// Edit a campaign's asset or targetUrl here and every event/season it's
// placed in picks up the change immediately — no re-instantiation needed.
//
// Flat text and raw QR values are NOT here — they vary per placement (e.g.
// different coupon copy for VIP vs family zone, same sponsor), so they live
// on AdCampaignCatalog/AdCampaignPlacement instead.
import mongoose from 'mongoose';

const AdCampaignSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  label: { type: String, default: null },

  // Optional on purpose: set-ad-campaign.js can register a campaign's
  // identity (label/targetUrl) before its creative is ready.
  // import-ad-campaign-asset.js attaches/replaces the asset whenever it's
  // available — neither script is a prerequisite for the other. A campaign
  // with no asset yet simply renders no image on tickets (see
  // buildTicketsPdfBuffer in src/services/tickets-pdf.js).
  assetKind: { type: String, enum: ['svg', 'raster', null], default: null },
  // Relative to data/assets/ads/ — staged there by
  // scripts/02-ticket-ad-management/import-ad-campaign-asset.js. More than
  // one entry = a "carousel": tickets rotate through them by their position
  // within the order (ticket 1 -> assetPaths[0], ticket 2 -> assetPaths[1],
  // wrapping around) — deterministic, so a resent/regenerated ticket always
  // shows the same one. A .zip upload stages every image inside as one
  // family (all sharing this one assetKind — mixed svg+raster is rejected).
  assetPaths: { type: [String], default: [] },

  // Trackable fallback for 'qr' placements that don't set their own
  // qrValue — looked up live at click time (see /promo/:token), so it can
  // change without touching any ticket already printed.
  targetUrl: { type: String, default: null, trim: true },

  active: { type: Boolean, default: true }
}, { timestamps: true });

export const AdCampaign = mongoose.models.AdCampaign || mongoose.model('AdCampaign', AdCampaignSchema);
