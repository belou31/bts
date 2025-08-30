// src/models/PaymentIntent.js
import mongoose from 'mongoose';

const PaymentIntentSchema = new mongoose.Schema({
  seasonCode: { type: String, index: true },
  venueSlug:  { type: String, index: true },
  groupKey:   { type: String, index: true },
  payerEmail: String,
  lines: [{ type: Object }],
  totalCents: Number,
  provider: { type: String, default: 'helloasso' },
  installments: { type: Number, default: 1 },
  status: { type: String, default: 'created' },
  providerRef: String
}, { timestamps: true });

export const PaymentIntent = mongoose.models.PaymentIntent || mongoose.model('PaymentIntent', PaymentIntentSchema);
