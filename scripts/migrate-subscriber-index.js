// scripts/migrate-subscriber-index.js

import mongoose from 'mongoose';

import { Subscriber } from '../../src/models/Subscriber.js';

import dotenv from 'dotenv';
dotenv.config();


(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  await mongoose.connect(uri);
  console.log('[migrate] Connected');

  // 1) Drop ancien index si présent
  try {
    await Subscriber.collection.dropIndex('subscriberNo_1');
    console.log('[migrate] Dropped old index subscriberNo_1');
  } catch (e) {
    if (e.codeName === 'IndexNotFound') {
      console.log('[migrate] Old index not found (ok)');
    } else {
      console.warn('[migrate] dropIndex warning:', e.message);
    }
  }

  // 2) Nettoyer les valeurs null (unset le champ)
  const r = await Subscriber.updateMany({ subscriberNo: null }, { $unset: { subscriberNo: 1 } });
  console.log(`[migrate] Unset subscriberNo where null: matched=${r.matchedCount} modified=${r.modifiedCount}`);

  // 3) Recréer les index d’après le schéma (incl. l’index partiel)
  await Subscriber.syncIndexes();
  console.log('[migrate] syncIndexes done');

  await mongoose.disconnect();
  console.log('[migrate] Done');
})().catch(e => { console.error(e); process.exit(1); });
