// scripts/sync-indexes.mjs
import mongoose from 'mongoose';
import * as Models from '../src/models/index.js';

const APP_ENV = (process.env.APP_ENV || 'development').toLowerCase();
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';

async function main() {
  console.log(`[sync-indexes] env=${APP_ENV} uri=${MONGO_URI}`);
  await mongoose.connect(MONGO_URI, { autoIndex: true });

  // pour chaque modèle exporté nommément par l'agrégateur
  const names = Object.keys(Models);
  for (const name of names) {
    const Model = Models[name];
    if (!Model?.syncIndexes) continue;
    console.log(`→ ${name}.syncIndexes()`);
    await Model.syncIndexes();
  }

  await mongoose.disconnect();
  console.log('✔ indexes synchronisés');
}

main().catch(err => {
  console.error('sync-indexes FAILED:', err);
  process.exit(1);
});
