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
  // Allocation mechanism: 'seat' = individually locked against the Seat
  // collection; 'zone' = zone-quota-tracked (standing AND seated-but-
  // zone-allocated zones like VIP both use this — see src/utils/seat-id.js).
  // Deliberately no default: lines created before this field existed must
  // read back as unset (not silently 'seat') so resolveUnitType() falls
  // back to its seatId-shape heuristic instead of trusting a fabricated value.
  unitType:        { type: String, enum: ['seat', 'zone'] },
  // The zone's own physical seating character at booking time (mirrors
  // Zone.type). This is what display/i18n code should key off for labeling
  // — never `unitType`, which only reflects the allocation mechanism.
  zoneType:        { type: String, enum: ['seated', 'standing'] },
  tariffCode:      { type: String, index: true },
  priceCents:      { type: Number, default: 0 },
  // Partner billing override (what the partner pays/subsidizes)
  partnerPriceCents: { type: Number, default: null },
  // Total cost line (display + partner portion)
  partnerTotalCents: { type: Number, default: null },

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
  flow:   { type: String, enum: ['renew','vip','subscription','partner','public','event','voucher','voucher-purchase'], default: null },
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

  // 'torelocate' : l'abonnement est payé mais la place de ce match n'a pas pu
  // être attribuée (siège déjà pris). La commande existe pour que l'abonné
  // soit joignable et puisse choisir une autre place ; elle n'occupe aucun
  // siège tant qu'elle n'est pas passée 'paid' (voir event-seat-states.js, qui
  // ne compte que paid/tobepaid).
  status: { type: String, enum: ['pending','tobepaid','paid','failed','canceled','refunded','torelocate'], default: 'pending', index: true },

  paymentProvider:     { type: String, default: process.env.PAYMENT_PROVIDER || 'helloasso' },

  // ✅ New canonical provider meta bag (used by renew/subscription routes & pay.js)
  paymentProviderMeta: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ⬅ Legacy (keep for compatibility with older data/logic if any)
  providerRef: { type: String, default: '' },
  meta:        { type: Object, default: {} },

  // Email/template routing
   origin: {
    // ajout de "event" pour distinguer le flux billetterie évènement
    flow:   { type:String, enum:['renew','subscription','public','event','partner','vip','voucher','voucher-purchase'], default:'subscription', index:true },
     uiPath: { type:String },
     apiPath:{ type:String }
   },

  // ajout de "event" pour les emails de match
  mailTemplateKind: { type:String, enum:['renew','subscription','public','event'], default:'subscription', index:true },

  // Locale captured at checkout time (see src/middlewares/locale.js) so
  // confirmation emails/tickets render in the language the buyer actually
  // used, even on a later resend/regeneration. Defaults to 'fr': every
  // order predating this field genuinely was placed in French, so — unlike
  // unitType/zoneType — a schema default here reflects real history rather
  // than fabricating an unknown value.
  locale: { type: String, enum: ['fr', 'en'], default: 'fr' },

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
