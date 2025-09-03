// src/models/Tariff.js
import mongoose from 'mongoose';

const TariffSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  label: { type: String, required: true },
  // Champ additionnel à fournir par l’utilisateur (optionnel)
  // ex: "ine", "licence", "justification", etc. (on ne contraint pas la valeur)
  requiresField: { type: String, default: null },
  fieldLabel: { type: String, default: null },   // libellé à afficher pour requiresField
  requiresInfo: { type: String, default: null }, // texte d’info (ex: "carte étudiante à présenter")
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 100 }      // ordre d’affichage
}, { timestamps: true });

TariffSchema.index({ active: 1, sortOrder: 1 });

export const Tariff = mongoose.models.Tariff || mongoose.model('Tariff', TariffSchema);
