// src/models/Zone.js
import mongoose from 'mongoose';

const ZoneSchema = new mongoose.Schema({
  // ex: A1, B3, DEBOUT, TBH7_NORD, TBH7_SUD
  // IMPORTANT: on enlève "unique: true" pour passer à un index composé (key+seasonCode)
  key: { type: String, index: true },

  name: { type: String },
  type: { type: String, enum: ['seated', 'standing'], default: 'seated' },

  // standing : info de capacité "physique" indicative
  capacity: { type: Number, default: 0 },

  // pour mapper l’ID / sélecteur CSS dans le SVG (ex: "#zone-nord")
  svgSelector: { type: String },

  // plafond d'abonnés pour la saison (anti-survente)
  quota: { type: Number, default: 0 },

  // prix de base éventuel (non utilisé si TariffPrice est la source de vérité)
  // Méta-zone tarifaire : plusieurs zones au même prix la partagent (ex. S1,
  // S3 et N en « CAT2 »). Une grille peut alors être écrite UNE fois pour la
  // méta-zone au lieu d'être recopiée par zone — et une zone ajoutée plus
  // tard à la méta-zone hérite du prix sans reprise de la grille.
  metaZone: { type: String, uppercase: true, trim: true, default: null, index: true },
  basePriceCents: { type: Number },

  // ATTENTION: unique par saison désormais
  seasonCode: { type: String, required: true, index: true },

  // Lieu (patinoire). Permet de distinguer les mêmes clés de zones selon la salle
  venueSlug:  { type: String, required: true, index: true },

  // Contrôle d'accès à la billetterie publique du match
  // PUBLIC: visible si tarif-zone event existe ; VIP/HIDDEN: invisibles en public
  access:     { type: String, enum: ['PUBLIC','VIP','HIDDEN'], default: 'PUBLIC', index: true },

  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// ---- Index composé unique par saison/lieu/clé ----
ZoneSchema.index(
  { seasonCode: 1, venueSlug: 1, key: 1 },
  { unique: true, name: 'uniq_zone_season_venue_key' }
);
 

export const Zone = mongoose.models.Zone || mongoose.model('Zone', ZoneSchema);
