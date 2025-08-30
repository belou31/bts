// src/models/Order.js
import mongoose from 'mongoose';

const LineSchema = new mongoose.Schema({
  seatId: String,
  tariffCode: String,
  priceCents: Number,            // optionnel si tu stockes le détail
  holderFirstName: String,       // optionnel (porteur de la place)
  holderLastName: String,
  justificationField: String,    // ex: Numéro INE / licence
  info: String                   // info complémentaire
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  seasonCode: { type: String, index: true },
  venueSlug:  { type: String, index: true },
  groupKey:   { type: String, index: true },
payerFirstName: String,
payerLastName:  String,
paymentSplit:   { type: Number, default: 1 },
  payerEmail: String,
  lines: [LineSchema],
  totalCents: Number,
  status: { type: String, enum: ['pending','paid','failed'], default: 'pending', index: true },
  paymentProvider: { type: String, default: 'helloasso' },
  providerRef: String
}, { timestamps: true });

// Unicité logique : un seul "paid" par (season, venue, groupKey)
OrderSchema.index(
  { seasonCode: 1, venueSlug: 1, groupKey: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'paid' }, name: 'uniq_paid_per_group' }
);

export const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
