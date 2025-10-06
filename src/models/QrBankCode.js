// src/models/QrBankCode.js
import mongoose from 'mongoose';

const QrBankCodeSchema = new mongoose.Schema({
  value:    { type: String, unique: true, index: true }, // hex opaque
  used:     { type: Boolean, default: false, index: true },
  usedAt:   { type: Date },
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' },
  tag:      { type: String }, // option (tarif/zone)
}, { timestamps: true });

export const QrBankCode = mongoose.model('QrBankCode', QrBankCodeSchema);
