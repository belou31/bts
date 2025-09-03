// scripts/_db.js
import mongoose from 'mongoose';

export async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI manquant');
  // timeouts raisonnables
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  return mongoose;
}

export async function disconnect() {
  try { await mongoose.disconnect(); } catch {}
}

export async function withDb(fn) {
  await connect();
  try { return await fn(); }
  finally { await disconnect(); }
}
