// src/models/Season.js
import mongoose from 'mongoose';

const SeasonSchema = new mongoose.Schema({
  code: { type: String, unique: true }, // ex: 2025-2026
  name: String,
  active: { type: Boolean, default: true },
  // — Cycle de vie explicite, sur le modèle de Event.sale / Event.activity.
  //
  // Une saison n'a pas UNE porte de vente mais plusieurs, qui ne s'ouvrent ni
  // ne se ferment ensemble : on ferme couramment le renouvellement pendant que
  // la vente publique tourne. Un seul état ordonné ne saurait pas l'exprimer,
  // d'où un état par porte — explicite, et lisible sans table de conversion.
  //
  // Remplace trois mécanismes qui ne gardaient rien, tous supprimés depuis :
  // `phases` + set-season-phases.js (le middleware checkPhase n'a jamais été
  // monté), `enableRenewal` (écrit, jamais lu) et la recherche
  // `{ isActive: true }` (champ inexistant, filtre supprimé silencieusement
  // par strictQuery — voir docs/operations-runbook.md).
  activity:  { type: String, enum: ['draft', 'active', 'archived'], default: 'draft', index: true },
  renew:     { type: String, enum: ['notopen', 'open', 'closed'], default: 'notopen', index: true },
  subscribe: { type: String, enum: ['notopen', 'open', 'closed'], default: 'notopen', index: true },

  // 🔴 Nouveau : associe la saison à un lieu (plan SVG, zones, tarifs)
  venueSlug: { type: String, default: null }, // ex: "patinoire-blagnac"
  // Same role as Event.templateTheme, for subscription/public orders that
  // aren't tied to one event — see that field's comment for the full contract.
  templateTheme: { type: String, default: null, trim: true }
}, { timestamps: true });

export const Season = mongoose.models.Season || mongoose.model('Season', SeasonSchema);
