// src/models/AdCampaignPlacement.js
// Live/instantiated placement rules, resolved per ticket at PDF-render time
// (see buildTicketsPdfBuffer in src/services/tickets-pdf.js). Same lifecycle
// AND same dual addressing as TariffPrice:
//   - season-level: seasonCode + venueSlug set, priceTableKey: null
//   - event-level:  priceTableKey: "ev:<slug>", seasonCode/venueSlug unset
// Created by copying AdCampaignCatalog rows via
// scripts/03-season-management/instantiate-ad-campaigns.js (season) or
// scripts/04-event-management/instantiate-ad-campaigns.js (event) — never
// authored directly. campaignSlug is a soft reference to AdCampaign, which
// holds the actual asset/targetUrl (see AdCampaign.js for why they're split).
import mongoose from 'mongoose';

const AdCampaignPlacementSchema = new mongoose.Schema({
  seasonCode: { type: String, default: null, index: true },
  venueSlug:  { type: String, default: null, index: true },
  priceTableKey: { type: String, default: null, index: true },

  campaignSlug: { type: String, required: true, trim: true, lowercase: true },

  // See AdCampaignCatalog.js for the full contentType/slot/qrValue/text contract.
  contentType: { type: String, enum: ['image', 'qr', 'text'], required: true },
  slot: { type: String, required: true, trim: true },
  qrValue: { type: String, default: null, trim: true },
  text: { type: String, default: null },

  tariffCode: { type: String, default: null, trim: true, uppercase: true },
  zoneKey:    { type: String, default: null, trim: true, uppercase: true },
  zoneType:   { type: String, enum: ['seated', 'standing', null], default: null },

  priority: { type: Number, default: 100 },
  startsAt: { type: Date, default: null },
  endsAt:   { type: Date, default: null },

  active: { type: Boolean, default: true }
}, { timestamps: true });

// Event-level uniqueness (priceTableKey set).
AdCampaignPlacementSchema.index(
  { priceTableKey: 1, campaignSlug: 1, slot: 1, tariffCode: 1, zoneKey: 1, zoneType: 1 },
  { unique: true, name: 'uniq_ad_campaign_placement_per_priceTableKey', partialFilterExpression: { priceTableKey: { $type: 'string' } } }
);
// Season-level uniqueness (priceTableKey null).
AdCampaignPlacementSchema.index(
  { seasonCode: 1, venueSlug: 1, campaignSlug: 1, slot: 1, tariffCode: 1, zoneKey: 1, zoneType: 1 },
  { unique: true, name: 'uniq_ad_campaign_placement_per_season', partialFilterExpression: { priceTableKey: null } }
);
// Hot path for buildTicketsPdfBuffer's per-ticket resolution.
AdCampaignPlacementSchema.index({ priceTableKey: 1, slot: 1, active: 1 });
AdCampaignPlacementSchema.index({ seasonCode: 1, venueSlug: 1, slot: 1, active: 1 });

export const AdCampaignPlacement = mongoose.models.AdCampaignPlacement
  || mongoose.model('AdCampaignPlacement', AdCampaignPlacementSchema);
