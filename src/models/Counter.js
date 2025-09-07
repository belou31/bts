// src/models/Counter.js
import mongoose from 'mongoose';

const CounterSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  seq: { type: Number, default: 0 }
}, { timestamps: true });

export const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);
