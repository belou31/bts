import mongoose from 'mongoose';

const VenueZoneSchema = new mongoose.Schema({
  key: { type: String, required: true },              // ex: "A", "B", "DEBOUT"
  name: { type: String, required: true },
  type: { type: String, enum: ['seated','standing'], default: 'seated' },
  standingQuota: { type: Number, default: 0 },        // utile si type=standing
  svgSelector: { type: String, default: null }        // ex: [data-zone="A"]
}, { _id: false });

const VenueSchema = new mongoose.Schema({
  slug:   { type: String, unique: true, index: true }, // ex: "patinoire-bdl"
  name:   { type: String, required: true },
  svgPath:{ type: String, required: true },            // ex: /public/venues/patinoire-bdl/plan.svg
  zones:  { type: [VenueZoneSchema], default: [] }
}, { timestamps: true });

export const Venue = mongoose.models.Venue || mongoose.model('Venue', VenueSchema);
