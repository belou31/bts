// src/models/Subscriber.js
import mongoose from 'mongoose';

const SubscriberSchema = new mongoose.Schema({
  // numéro d'abonné final (attribué après paiement/attestation)
  subscriberNo: { type: String },

  // identité de la personne pour CE siège
  firstName: String,
  lastName: String,

  // contact
  email: { type: String, index: true },
  phone: String,

  // regroupement (famille, commande…) — clé logique
  groupKey: { type: String, index: true, default: null },

  // (legacy) ancien champ "group" — conservé pour compat éventuelle
  group: { type: String, default: null, select: false },

  // siège “préféré” / ciblé sur la ligne (renouvellement)
  prefSeatId: { type: String, index: true },

  // historique sièges
  previousSeasonSeats: { type: [String], default: [] },

  // places supplémentaires accordées à ce renouveleur, au-delà de ses sièges
  // précédents (quota du lien = previousSeasonSeats + extra). Agrégé par MAX
  // sur le groupKey à l'export du token — voir export-renew-groups.js.
  extra: { type: Number, default: 0, min: 0 },

  // contexte
  seasonCode: { type: String, index: true },
  venueSlug:  { type: String, index: true },

  status: {
    type: String,
    enum: ['none', 'invited', 'pending', 'active', 'partial', 'canceled'],
    default: 'none'
  },

  // annotation libre admin (déjà attendue par subscribers-export.template.csv)
  notes: { type: String, default: '' },

  // dernier envoi de l'invitation de renouvellement (admin/renewers)
  lastInviteSentAt: { type: Date, default: null }
}, {
  timestamps: true,
  strict: true
});

// subscriberNo unique seulement s'il est présent
SubscriberSchema.index(
  { subscriberNo: 1 },
  { unique: true, partialFilterExpression: { subscriberNo: { $exists: true, $type: 'string' } } }
);

export const Subscriber = mongoose.models.Subscriber || mongoose.model('Subscriber', SubscriberSchema);
