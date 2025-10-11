// src/models/ZoneCatalog.js
import mongoose from 'mongoose';

const ZoneCatalogSchema = new mongoose.Schema({
  venueSlug:   { type: String, required: true, index: true },
  key:         { type: String, required: true },
  name:        { type: String, default: '' },
  type:        { type: String, enum: ['seated', 'standing', 'fanclub'], default: 'seated' },
  access:      { type: String, enum: ['PUBLIC', 'VIP', 'FANCLUB', 'HIDDEN'], default: 'PUBLIC' },
  capacity:    { type: Number, default: 0 },
  quota:       { type: Number, default: 0 },
  svgSelector: { type: String, default: null },
  isActive:    { type: Boolean, default: true }
}, { timestamps: true });

ZoneCatalogSchema.index({ venueSlug: 1, key: 1 }, { unique: true });

export const ZoneCatalog = mongoose.models.ZoneCatalog || mongoose.model('ZoneCatalog', ZoneCatalogSchema);
