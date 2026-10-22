// src/models/PartnerMember.js
//
// Annuaire local d'un partenaire sans fournisseur d'identité : un ayant droit
// par identifiant, avec les adresses e-mail auxquelles un code de connexion
// peut être envoyé. Alimenté par import CSV (/partner/<slug>/admin/directory),
// qui remplace l'annuaire entier du partenaire. Voir services/partner-directory.js.
import mongoose from 'mongoose';

const PartnerMemberSchema = new mongoose.Schema({
  partnerSlug:   { type: String, required: true, lowercase: true, trim: true },
  identifier:    { type: String, required: true, trim: true },
  lastName:      { type: String, default: '' },
  firstName:     { type: String, default: '' },
  // En minuscules : la comparaison à la connexion ignore la casse.
  emails:        { type: [String], default: [] },
  // Nombre de places au titre des droits (attribut « beneficiaries »).
  beneficiaries: { type: Number, default: null },
  importedAt:    { type: Date, default: Date.now }
}, { timestamps: true });

PartnerMemberSchema.index({ partnerSlug: 1, identifier: 1 }, { unique: true, name: 'uniq_partner_identifier' });

export const PartnerMember = mongoose.models.PartnerMember || mongoose.model('PartnerMember', PartnerMemberSchema);
