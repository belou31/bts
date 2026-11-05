// src/models/AdCampaignCatalog.js
// Reusable placement rules — WHERE an AdCampaign (by slug, soft reference)
// shows up: which slot, WHAT KIND of content (contentType), filtered by
// tariffCode/zoneKey/zoneType. Same role as TariffPriceCatalog: authored via
// CSV/import script, never read directly at render time.
// instantiate-ad-campaigns.js (season or event) copies rows from here into
// AdCampaignPlacement.
import mongoose from 'mongoose';

const AdCampaignCatalogSchema = new mongoose.Schema({
  catalogSlug: { type: String, required: true, trim: true, lowercase: true },
  venueSlug:   { type: String, default: null, index: true },

  // Soft reference to AdCampaign.slug — not a Mongoose ref/ObjectId, same
  // style as TariffPriceCatalog.tariffCode referencing Tariff.code.
  campaignSlug: { type: String, required: true, trim: true, lowercase: true },

  // What this row injects, and correspondingly what `slot` means:
  //   image -> <rect id="slot"> gets the campaign's asset (AdCampaign.assetPaths)
  //   qr    -> <rect id="slot"> gets a QR: this row's own qrValue if set
  //            (raw content, no tracking), else the campaign's targetUrl as
  //            a trackable /promo/ redirect
  //   text  -> the literal token {{slot}} gets replaced with this row's text
  // Explicit per row — no naming convention (e.g. no auto "<slot>Qr") ties
  // these together; two rows in the same slot namespace are just two rows.
  contentType: { type: String, enum: ['image', 'qr', 'text'], required: true },
  slot: { type: String, required: true, trim: true },

  // contentType='qr' only: raw value to encode as-is. Leave unset to fall
  // back to the campaign's targetUrl (trackable). Varies per placement so
  // the same sponsor can hand out a different code per zone/event.
  qrValue: { type: String, default: null, trim: true },
  // contentType='text' only: the literal copy for this placement.
  text: { type: String, default: null },

  // Applicability filters — a ticket matches when every non-null field here
  // equals the ticket's own value; null/absent = wildcard (matches anything).
  tariffCode: { type: String, default: null, trim: true, uppercase: true },
  zoneKey:    { type: String, default: null, trim: true, uppercase: true },
  zoneType:   { type: String, enum: ['seated', 'standing', null], default: null },

  // When several placements match the same ticket/slot, highest priority wins.
  priority: { type: Number, default: 100 },

  startsAt: { type: Date, default: null },
  endsAt:   { type: Date, default: null },

  active: { type: Boolean, default: true }
}, { timestamps: true });

AdCampaignCatalogSchema.index(
  { catalogSlug: 1, venueSlug: 1, campaignSlug: 1, slot: 1, tariffCode: 1, zoneKey: 1, zoneType: 1 },
  { unique: true, name: 'uniq_ad_campaign_catalog_entry' }
);

export const AdCampaignCatalog = mongoose.models.AdCampaignCatalog
  || mongoose.model('AdCampaignCatalog', AdCampaignCatalogSchema);
