// src/loaders/mongoose.js
import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI manquant dans .env');

  mongoose.set('strictQuery', true);

  const isDev = (process.env.APP_ENV || '').toLowerCase() === 'development';
  await mongoose.connect(uri, {
    autoIndex: isDev,
    serverSelectionTimeoutMS: 5000,
    retryWrites: false,
    directConnection: true
  });

  const db = mongoose.connection;
  console.log(`[mongo] connected to "${db.name}" at ${db.host}:${db.port}`);
}

export default { connectDB };
