// scripts/verify-models.mjs
import mongoose from 'mongoose';
import * as Models from '../src/models/index.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';

async function main() {
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  const registered = Object.keys(mongoose.models);
  console.log('Mongoose models enregistrés:', registered.sort());
  const exported = Object.keys(Models);
  console.log('Exports agrégateur:', exported.sort());
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

