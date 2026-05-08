// src/models/Seat.js
import mongoose from 'mongoose';

// Sous-document pour gérer un "hold" (blocage temporaire pendant un checkout)
const HoldSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.Mixed }, // ObjectId (string) ou autre identifiant
  until:   { type: Date, index: true },           // date d’expiration du hold
  reason:  { type: String }                       // ex: 'checkout'
}, { _id: false });

const SeatSchema = new mongoose.Schema({
  // Identifiant fonctionnel du siège, ex: "A1-001"
  seatId: { type: String, required: true },

  // Zone tarifaire/tribune (clé courte), ex: "A", "B", "DEBOUT"
  zoneKey: { type: String, index: true },

  // Contexte saisonnier
  seasonCode: { type: String, index: true },

  // 🔗 Lieu (venue) auquel appartient ce siège pour cette saison
  venueSlug: { type: String, index: true },

  // État de réservation pour la saison
  status: {
    type: String,
    // 'busy' = blocage temporaire (hold) pendant un checkout
    enum: ['available', 'busy', 'held', 'booked', 'provisioned'],
    default: 'available',
    index: true
  },

  // Métadonnées extensibles (dont le hold temporaire)
  meta: {
    hold: { type: HoldSchema, default: undefined },
    // déjà utilisés par certains exports/outils d’admin :
    provisionTags: { type: [String], default: undefined },
    provisionNote: { type: String, default: undefined }
  },

  // Siège provisionné pour un abonné (renouvellement)
  provisionedFor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscriber',
    default: null,
    index: true
  }
}, { timestamps: true });

/**
 * ⚠️ Important :
 * - On NE met plus "unique: true" sur seatId tout seul.
 * - On garantit l'unicité PAR saison + lieu + seatId.
 */
SeatSchema.index(
  { seasonCode: 1, venueSlug: 1, seatId: 1 },
  { unique: true, name: 'uniq_seat_per_season_venue' }
);

// Index utiles pour les filtres fréquents
SeatSchema.index({ seasonCode: 1, zoneKey: 1 });
SeatSchema.index({ seasonCode: 1, status: 1 });
// Index pour le ménage automatique des holds
SeatSchema.index({ 'meta.hold.until': 1 }, { name: 'idx_hold_until', sparse: true });
SeatSchema.index({ 'meta.hold.orderId': 1 }, { name: 'idx_hold_order', sparse: true });

export const Seat = mongoose.models.Seat || mongoose.model('Seat', SeatSchema);
