// src/models/ScanLog.js
import mongoose from 'mongoose';

const ScanLogSchema = new mongoose.Schema({
  when:      { type: Date, default: Date.now, index: true },
  eventId:   { type: String, index: true },
  ticketId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', index: true },
  qrValue:   { type: String, index: true },
  gate:      { type: String },
  deviceId:  { type: String },
  ok:        { type: Boolean, index: true },
  reason:    { type: String },  // ex: already_scanned, invalid, event_mismatch
}, { timestamps: true });

export const ScanLog = mongoose.model('ScanLog', ScanLogSchema);
