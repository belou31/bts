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

  // Fin de la fenêtre pendant laquelle les places sont tenues pour cette
  // commande. Les trois flux d'achat écrivaient déjà `hold: { until }` à la
  // création — sans ce champ, `strict: true` le jetait en silence et la
  // durée n'existait nulle part sur la commande.
  hold: {
    until: { type: Date, default: null }
  },

  // Corrections faites à la main depuis admin/orders. L'adresse d'origine est
  // conservée : c'est elle qui figure sur l'attestation déjà envoyée et dans
  // le relevé du prestataire, et la corriger l'effacerait sans trace.
  // (Le schéma est `strict: true` : sans ce champ, l'historique serait
  // silencieusement jeté à l'enregistrement.)
  adminEdits: {
    type: [new mongoose.Schema({
      at:            { type: Date },
      by:            { type: String, default: '' },
      kind:          { type: String, default: '' },
      previousEmail: { type: String, default: '' },
      changes:       { type: [String], default: [] }
    }, { _id: false, strict: true })],
    default: []
  },

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

// Index non-unique pour filtrer/rapporter par groupe+statut
OrderSchema.index(
  { seasonCode:1, venueSlug:1, groupKey:1, status:1 },
  { name:'idx_group_status' }
);

// `uniq_paid_per_payer` — unique sur (saison, lieu, groupKey, payeur) parmi les
// commandes payées — a été retiré (scripts/06-misc/drop-uniq-paid-per-payer.js).
//
// Il visait le double paiement mais ne l'exprimait pas : combiné au groupKey
// constant par saison de l'époque, il signifiait « un seul paiement abouti par
// personne et par saison » et refusait la deuxième commande légitime d'un même
// acheteur — après réservation des sièges. Depuis que subscription.js et
// renew.js émettent un groupKey unique par commande, il ne pouvait plus
// déclencher que sur des faux positifs hérités.
//
// Ce qu'il prétendait protéger l'est déjà, et au bon niveau : `Seat` porte
// l'index unique `uniq_seat_per_season_venue` (un document par siège), et
// finalizePaidIfNoConflict fait passer les sièges à `booked` par un updateMany
// conditionnel — un siège déjà `booked` ne satisfait plus le filtre, la
// commande est rejetée. C'est atomique, et cela porte sur la place plutôt que
// sur le payeur.
//
// Pas de remplaçant côté commande : un index unique sur `lines.seatId` n'est
// pas praticable, les lignes ZONE ayant un seatId virtuel vide ou partagé —
// vérifié, la création échoue en E11000 sur ces lignes-là.

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
