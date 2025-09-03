// scripts/migrations/migrate-zone-index.js
import mongoose from 'mongoose';
import { Zone } from '../../src/models/Zone.js';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bts';

(async () => {
  try {
    await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
    const coll = Zone.collection;

    const indexes = await coll.indexes();
    // Cherche un index unique sur le champ "key" (souvent nommé "key_1")
    const keyUnique = indexes.find(ix =>
      ix.unique === true &&
      ix.key &&
      Object.keys(ix.key).length === 1 &&
      ix.key.key === 1
    );

    if (keyUnique) {
      console.log('Dropping legacy unique index:', keyUnique.name);
      await coll.dropIndex(keyUnique.name);
    } else {
      console.log('No legacy unique index on "key" found — nothing to drop.');
    }

    // Aligne les index de la collection sur ceux du schéma (création + suppression si besoin)
    await Zone.syncIndexes();

    console.log('Zone indexes after sync:', await coll.indexes());
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[migrate-zone-index] error:', err);
    process.exit(1);
  }
})();
