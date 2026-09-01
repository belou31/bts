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

  // Nombre de places que représente CETTE ligne.
  //
  // Un siège numéroté vaut toujours 1 : il est identifié, donc une ligne = une
  // place. Une place en ZONE n'est pas identifiable — « TBH7 » désigne la zone,
  // pas un siège précis — si bien que deux places dans la même zone pour le
  // même abonné produisaient deux lignes CSV rigoureusement identiques, donc
  // une seule ligne en base (la clé d'upsert contient prefSeatId) et un quota
  // amputé d'autant. C'est ce compte qui porte la quantité, pas le nombre de
  // documents.
  places: { type: Number, default: 1, min: 1 },

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
