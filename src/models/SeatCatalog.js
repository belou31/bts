import mongoose from 'mongoose';

const SeatCatalogSchema = new mongoose.Schema({
  venueSlug: { type: String, index: true, required: true },
  seatId:    { type: String, required: true },            // ex: "A1-001"
  zoneKey:   { type: String, required: true },
  row:       { type: String, default: '' },               // optionnel
  number:    { type: String, default: '' },               // optionnel
  svgSelector:{ type: String, default: null }             // ex: [data-seat-id="A1-001"]
}, { timestamps: true });

SeatCatalogSchema.index({ venueSlug:1, seatId:1 }, { unique:true });

export const SeatCatalog = mongoose.models.SeatCatalog || mongoose.model('SeatCatalog', SeatCatalogSchema);
