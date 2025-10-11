#!/usr/bin/env node
/**
 * Reset MongoDB database
 *
 * Drops the MongoDB database referenced by MONGO_URI. The --force flag is required
 * to avoid mistakes.
 *
 * Usage:
 *   node scripts/00-baseline-reset/reset-db.js --force
 *
 * Environment:
 *   - MONGO_URI: full MongoDB connection string (required)
 *
 * Template:
 *   - data/templates/env/.env.template
 */
import mongoose from 'mongoose';

import dotenv from 'dotenv';
dotenv.config();

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('Missing MONGO_URI in .env'); process.exit(1); }

  // sécurité : exiger --force
  if (!process.argv.includes('--force')) {
    console.error('Refusé: ajoute --force pour confirmer la suppression de la base.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const dbName = mongoose.connection.name;
  console.warn(`⚠️  Suppression de la base "${dbName}" sur ${mongoose.connection.host} …`);
  await mongoose.connection.dropDatabase();
  console.log('✓ Base supprimée');
  await mongoose.disconnect();
})();
