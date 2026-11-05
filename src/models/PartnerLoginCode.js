// src/models/PartnerLoginCode.js
//
// Code de connexion envoyé par e-mail à un ayant droit de l'annuaire local
// (services/partner-directory.js). Seul son haché est conservé ; usage
// unique, nombre d'essais borné, effacé par MongoDB à expiration (index TTL).
import mongoose from 'mongoose';

const PartnerLoginCodeSchema = new mongoose.Schema({
  partnerSlug: { type: String, required: true, lowercase: true, trim: true },
  identifier:  { type: String, required: true, trim: true },
  email:       { type: String, required: true, lowercase: true, trim: true },
  codeHash:    { type: String, required: true },
  attempts:    { type: Number, default: 0 },
  usedAt:      { type: Date, default: null },
  expiresAt:   { type: Date, required: true }
}, { timestamps: true });

PartnerLoginCodeSchema.index({ partnerSlug: 1, identifier: 1, createdAt: -1 }, { name: 'idx_partner_identifier_recent' });
PartnerLoginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expiresAt' });

export const PartnerLoginCode = mongoose.models.PartnerLoginCode || mongoose.model('PartnerLoginCode', PartnerLoginCodeSchema);
