// src/models/Ticket.js (ESM)
import mongoose from 'mongoose';

const TicketSchema = new mongoose.Schema({
  seasonCode:   { type: String, index: true, required: true },
  venueSlug:    { type: String, index: true, required: true },
  eventId:      { type: String, index: true, required: true }, // ex: "2025-09-20-belougas-vs-vipers"
  orderId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
  seatId:       { type: String, required: true, index: true }, // ex: "S2-F-013"
  // Set once at issuance from the source line; see src/utils/seat-id.js.
  // No default, same reasoning as Order.LineSchema.unitType.
  unitType:     { type: String, enum: ['seat', 'zone'] },
  // Mirrors Order.LineSchema.zoneType — the zone's physical seating
  // character, independent of unitType. Use this for display/i18n labels.
  zoneType:     { type: String, enum: ['seated', 'standing'] },
  tariffCode:   { type: String },
  holder: {
    firstName:  String,
    lastName:   String,
    email:      String,
  },
  // QR
  qr: {
    // valeur imprimée/encodée (OPAQUE). On peut choisir texte/hex selon QR_CODE_FORMAT
    value:     { type: String, unique: true, sparse: true, index: true },
    kind:      { type: String, enum: ['hex', 'text'], default: 'hex' },
    createdAt: { type: Date },
    bankId:    { type: mongoose.Schema.Types.ObjectId, ref: 'QrBankCode' } // si tiré de la banque
  },
  // Statuts contrôle d'accès
  scannedAt: { type: Date, index: true },
  scannedBy: { type: String }, // gate/device
  scanCount: { type: Number, default: 0 },
  scanHistory: [{
    when: { type: Date, default: Date.now },
    by: { type: String, default: '' },
    action: { type: String, enum: ['accept', 'force', 'auto', 'exit'], default: 'accept' }
  }],
}, { timestamps: true });

export const Ticket = mongoose.models.Ticket || mongoose.model('Ticket', TicketSchema);
