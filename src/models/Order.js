// src/models/Order.js
import mongoose from 'mongoose';

/* ----- Line items ----- */
const AttendanceSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['kept', 'released', 'moved'],
    default: 'kept'
  },
  overrideSeatId: { type: String, default: '' },
  overrideZoneKey: { type: String, default: '' },
  note: { type: String, default: '' },
  updatedAt: { type: Date, default: null },
  updatedBy: { type: String, default: '' }
}, { _id: false, minimize: false });

const LineSchema = new mongoose.Schema({
  seatId:          { type: String, default: '' },
  zoneKey:         { type: String, default: '' },   // ← needed for TBH7 / standing zones
  tariffCode:      { type: String, index: true },
  priceCents:      { type: Number, default: 0 },

  // Saison -> évènement : permet d'identifier la ligne d'origine
  sourceLineId:    { type: String, default: '' },

  attendance:      { type: AttendanceSchema, default: undefined },

  holderFirstName: { type: String, default: '' },
  holderLastName:  { type: String, default: '' },

  // Front posts `justif`; your older code used `justificationField`
  justif:             { type: String, default: '' },
  justificationField: { type: String, default: '' },

  info:            { type: String, default: '' }
}, { _id: false, strict: true });

/* ----- Optional sub-schema for origin ----- */
const OriginSchema = new mongoose.Schema({
  flow:   { type: String, enum: ['renew','tbh7','vip','subscription','vip'], default: null },
  uiPath: { type: String, default: null },
  apiPath:{ type: String, default: null }
}, { _id:false });

/* ----- Order ----- */
const OrderSchema = new mongoose.Schema({
  seasonCode: { type: String, index: true },
  venueSlug:  { type: String, index: true },

  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', index: true, default: null },
  parentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true, default: null },

  groupKey:   { type: String, index: true },

  itemName:   { type: String, index: true },

  payerFirstName: { type: String, default: '' },
  payerLastName:  { type: String, default: '' },
  payerEmail:     { type: String, index: true, default: '' },

  // number of installments (aka schedule in UI)
  paymentSplit:   { type: Number, default: 1 },

  lines:      { type: [LineSchema], default: [] },
  totalCents: { type: Number, default: 0 },

  status: { type: String, enum: ['pending','paid','failed','canceled','refunded'], default: 'pending', index: true },

  paymentProvider:     { type: String, default: process.env.PAYMENT_PROVIDER || 'helloasso' },

  // ✅ New canonical provider meta bag (used by renew/tbh7 routes & pay.js)
  paymentProviderMeta: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ⬅ Legacy (keep for compatibility with older data/logic if any)
  providerRef: { type: String, default: '' },
  meta:        { type: Object, default: {} },

  // Email/template routing
   origin: {
    // ajout de "event" pour distinguer le flux billetterie évènement
    flow:   { type:String, enum:['renew','subscription','public','event'], default:'subscription', index:true },
     uiPath: { type:String },
     apiPath:{ type:String }
   },

  // ajout de "event" pour les emails de match
  mailTemplateKind: { type:String, enum:['renew','subscription','public','event'], default:'subscription', index:true },

}, { timestamps: true, strict: true });

/* ----- Indexes ----- */

// (1) Unique: only one PAID per (season, venue, groupKey)
// Index non-unique pour filtrer/rapporter par groupe+statut
OrderSchema.index(
  { seasonCode:1, venueSlug:1, groupKey:1, status:1 },
  { name:'idx_group_status' }
);
OrderSchema.index(
  { seasonCode:1, venueSlug:1, groupKey:1, payerEmail:1, status:1 },
  { name:'uniq_paid_per_payer', unique:true, partialFilterExpression:{ status:'paid' } }
);

OrderSchema.index(
  { eventId:1, parentOrderId:1, status:1 },
  { name:'idx_event_parent_status' }
);

// (2) Lookup by payment provider intent / token (canonical)
OrderSchema.index({ 'paymentProviderMeta.checkoutIntentId': 1 }, { sparse: true, name: 'idx_provider_intent' });
OrderSchema.index({ 'paymentProviderMeta.tokenHash': 1 },        { sparse: true, name: 'idx_provider_tokenhash' });

// (3) Legacy lookups (if older orders used meta.*)
OrderSchema.index({ 'meta.checkoutIntentId': 1 }, { sparse: true, name: 'idx_legacy_intent' });
OrderSchema.index({ 'meta.tokenHash': 1 },        { sparse: true, name: 'idx_legacy_tokenhash' });

 // (optionnel) garde-fou: normaliser en minuscules
OrderSchema.pre('validate', function(next){
   if (this.mailTemplateKind) this.mailTemplateKind = String(this.mailTemplateKind).toLowerCase();
   if (this.origin && this.origin.flow) this.origin.flow = String(this.origin.flow).toLowerCase();
   next();
 });


export const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
