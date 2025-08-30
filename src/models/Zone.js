// src/models/Zone.js
import mongoose from 'mongoose';

const ZoneSchema = new mongoose.Schema({
  key: { type: String, unique: true }, // ex: A1, B3, DEBOUT, TBH7_NORD, TBH7_SUD
  name: String,
  type: { type: String, enum: ['seated','standing','fanclub'], default:'seated' },
  capacity: { type: Number, default: 0 }, // standing/fanclub
  svgSelector: String, // pour mapper l’ID des <g>/<path> dans le SVG
  quota: { type: Number, default: 0 }, // plafond abonnés
  basePriceCents: Number,
  fanclubDiscountPct: { type: Number, default: 0 }, // 0.30 pour TBH7
  seasonCode: String,
  isActive: { type: Boolean, default: true }
}, { timestamps:true });

export const Zone = mongoose.models.Zone || mongoose.model('Zone', ZoneSchema);
