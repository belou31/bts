// src/models/Tariff.js
import mongoose from 'mongoose';

const TariffSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  label: { type: String, required: true },
  // Champ additionnel à fournir par l’utilisateur (optionnel)
  // ex: "ine", "licence", "justification", etc. (on ne contraint pas la valeur)
  requiresField: { type: String, default: null },
  fieldLabel: { type: String, default: null },   // libellé à afficher pour requiresField
  requiresInfo: { type: String, default: null }, // texte d’info (ex: "carte étudiante à présenter")
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 100 },     // ordre d’affichage
  /**
   * Table de prix dédiée (événement) :
   * - null => tarif "global" (abonnement/historique)
   * - "ev:<slug>" => table propre à l’événement
   */
  priceTableKey: { type: String, default: null, index: true }
}, { timestamps: true });

TariffSchema.index({ active: 1, sortOrder: 1 });

// --- Indexes d'unicité "mutuellement exclusifs" via filtres partiels ---
// 1) Cas historique (abonnement) : pas de priceTableKey => code unique global
TariffSchema.index(
  { code: 1 },
  {
    unique: true,
    name: 'uniq_code_global_when_no_priceTableKey',
    partialFilterExpression: { priceTableKey: { $exists: false } }
  }
);
TariffSchema.index(
  { code: 1 },
  {
    unique: true,
    name: 'uniq_code_global_when_priceTableKey_null',
    partialFilterExpression: { priceTableKey: null }
  }
);

// 2) Cas événement : unicité par (priceTableKey, code) quand priceTableKey est défini
TariffSchema.index(
  { priceTableKey: 1, code: 1 },
  {
    unique: true,
    name: 'uniq_code_per_priceTableKey',
    partialFilterExpression: { priceTableKey: { $type: 'string' } }
  }
);


export const Tariff = mongoose.models.Tariff || mongoose.model('Tariff', TariffSchema);
