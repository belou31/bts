// src/models/ZoneHold.js
import mongoose from 'mongoose';

const ZoneHoldSchema = new mongoose.Schema({
  seasonCode: { type: String, index: true, required: true },
  venueSlug:  { type: String, index: true, required: true },
  zoneKey:    { type: String, index: true, required: true },
  qty:        { type: Number, default: 1, min: 1 },
  orderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  expiresAt:  { type: Date } // TTL
}, { timestamps: true });

// TTL (document supprimé quand expiresAt est atteint)
ZoneHoldSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_zonehold_expiresAt' });

export const ZoneHold = mongoose.models.ZoneHold || mongoose.model('ZoneHold', ZoneHoldSchema);
