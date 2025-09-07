// src/models/Campaign.js
import mongoose from 'mongoose';

const CampaignSchema = new mongoose.Schema({
  code: { type: String, unique: true },      // ex: RENEW-2025 ou TBH7-2025
  phase: { type: String, enum: ['renewal','tbh7'] },
  seasonCode: String,
  // "tokens" pour liens personnalisés (renouvellement) ou code partagé (TBH7)
  // pour TBH7 on peut générer un lien avec ?id=TBH7-2025 et contrôler les quotas
  maxUses: { type: Number, default: 0 },  // 0 = illimité
  used: { type: Number, default: 0 },
  meta: Object
},{timestamps:true});

export const Campaign = mongoose.models.Campaign || mongoose.model('Campaign', CampaignSchema);
