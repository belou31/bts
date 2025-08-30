
import mongoose from 'mongoose';

import { SeatHold } from '../../src/models/SeatHold.js';

import dotenv from 'dotenv';
dotenv.config();


(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  await mongoose.connect(uri);
  console.log('[migrate] Connected');

  const idxs = await SeatHold.collection.indexes();
  console.log('[migrate] Current indexes:', idxs.map(i => i.name));

  if (idxs.find(i => i.name === 'expiresAt_1')) {
    await SeatHold.collection.dropIndex('expiresAt_1');
    console.log('[migrate] Dropped duplicate index expiresAt_1');
  }

  await SeatHold.syncIndexes();
  const after = await SeatHold.collection.indexes();
  console.log('[migrate] After sync:', after.map(i => i.name));

  await mongoose.disconnect();
  console.log('[migrate] Done');
})().catch(e => { console.error(e); process.exit(1); });
