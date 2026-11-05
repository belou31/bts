// src/models/Voucher.js
//
// Bon cadeau / invitation : un droit à N places, échangeable soi-même contre
// de vrais billets. Remplace les contremarques papier qu'il fallait rapporter
// au club pour être converties à la main.
//
// Pourquoi un document et pas seulement un jeton signé (comme /renew) : un bon
// est un objet physique remis à un tiers. Il faut pouvoir l'annuler après
// impression, prolonger une échéance, et répondre au guichet à « ce bon a-t-il
// déjà servi ? ». Rien de tout cela n'est possible si les règles ne vivent que
// dans le jeton.

import mongoose from 'mongoose';

const RedemptionSchema = new mongoose.Schema({
  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  eventSlug: { type: String },
  qty:       { type: Number, default: 0 },
  seatIds:   { type: [String], default: [] },
  at:        { type: Date, default: Date.now },
  by:        { type: String, default: '' }   // email saisi au retrait, si demandé
}, { _id: false });

const VoucherSchema = new mongoose.Schema({
  // Code court et lisible, imprimé sur la carte : c'est lui qu'on cherche au
  // guichet. Le QR encode un JWT qui le porte (voir services/vouchers.js), ce
  // qui empêche d'énumérer les bons en devinant des codes.
  code:  { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  label: { type: String, default: '' },       // « École Jean Moulin », « Cadeau Dupont »

  // — Solde (Q1) : un pool global, plus un plafond facultatif par match.
  balance: {
    total: { type: Number, required: true, min: 1 },
    used:  { type: Number, default: 0, min: 0 }
  },
  maxPerEvent: { type: Number, default: 0 },  // 0 = pas de plafond par match

  // — Éligibilité (Q2). Les règles décrivent la fenêtre (une saison à venir
  // dont le calendrier n'existe pas encore, une période, des étiquettes) ;
  // la liste, quand elle est non vide, la RESTREINT. Pour un titre au porteur,
  // une éligibilité trop large coûte plus cher qu'une trop étroite.
  eligibility: {
    events: { type: [String], default: [] },          // slugs explicites
    rules: {
      seasonCodes: { type: [String], default: [] },
      tags:        { type: [String], default: [] },   // Event.tags : "regular", …
      from:        { type: Date, default: null },
      to:          { type: Date, default: null }
    }
  },

  // — Périmètre de placement (Q3). Contient des clés de zone AUJOURD'HUI, mais
  // est résolu via resolveAllowedZoneKeys() : le jour où les zones porteront
  // une méta-zone, une étiquette de méta-zone sera acceptée ici sans
  // migration ni reprise des bons déjà émis.
  allowedZones:   { type: [String], default: [] },    // vide = toutes les zones
  allowedTariffs: { type: [String], default: [] },    // vide = tarif par défaut du bon

  // Tarif appliqué aux lignes créées. Le montant reste 0 : un bon ne fabrique
  // pas de chiffre d'affaires (voir origin.flow='voucher' côté Order).
  tariffCode: { type: String, default: 'INVITATION', uppercase: true, trim: true },

  expiresAt: { type: Date, default: null, index: true },
  status:    { type: String, enum: ['active', 'suspended', 'spent', 'canceled'], default: 'active', index: true },

  // — Multi-visites (Q4) : le solde autorise plusieurs retraits, ce journal dit
  // qui a pris quoi et quand.
  redemptions: { type: [RedemptionSchema], default: [] },

  // — Provenance (Q5). Le retrait est identique dans les deux cas ; seule
  // l'émission diffère (don décidé par le club vs bon acheté).
  origin: {
    kind:    { type: String, enum: ['donation', 'purchase'], default: 'donation' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    note:    { type: String, default: '' }
  },

  seasonCode: { type: String, default: null, index: true },  // informatif / filtrage admin
  venueSlug:  { type: String, default: null },
  meta:       { type: Object, default: {} }
}, { timestamps: true });

VoucherSchema.virtual('remaining').get(function remaining() {
  return Math.max(0, Number(this.balance?.total || 0) - Number(this.balance?.used || 0));
});

export const Voucher = mongoose.models.Voucher || mongoose.model('Voucher', VoucherSchema);
