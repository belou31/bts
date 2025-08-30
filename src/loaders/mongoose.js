// src/loaders/mongoose.js
import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI manquant dans .env');
  }

  // Réduire l’attente côté driver si la DB est inaccessible
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  const { name, host, port } = mongoose.connection;
  console.log(`[mongo] connected to "${name}" at ${host}:${port}`);
  return mongoose;
}
