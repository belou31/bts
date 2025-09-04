// scripts/seed-zones.js
import mongoose from 'mongoose';
import { Zone } from '../src/models/Zone.js';
import { Season } from '../src/models/Season.js';

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;

async function getSeasonCode() {
  if (process.env.SEASON) return process.env.SEASON;
  const s = await Season.findOne({ active: true }).lean();
  if (!s?.code) throw new Error('No active season and no SEASON env provided');
  return s.code;
}

(async () => {
  try {
    await mongoose.connect(uri);
  
    const seasonCode = await getSeasonCode();

    const zones = [
      {
        key: 'TBH7',
        name: 'TBH7',
        type: 'fanclub',
        capacity: 0,
        quota: Number(process.env.TBH7_QUOTA || 55),
        svgSelector: '#zone-tbh7',
        seasonCode,
        isActive: true
      },
      {
        key: 'TBH7-VIRAGE',
        name: 'TBH7 Virage',
        type: 'fanclub',
        capacity: 0,
        quota: Number(process.env.TBH7_VIRAGE_QUOTA || 48),
        svgSelector: '#zone-tbh7-virage',
        seasonCode,
        isActive: true
      },
      {
        key: 'DEBOUT',
        name: 'Zone Debout',
        type: 'standing',
        capacity: Number(process.env.DEBOUT_CAPACITY || 300),
        quota: Number(process.env.DEBOUT_QUOTA || 300),
        svgSelector: '#zone-debout',
        seasonCode,
        isActive: true
      }
    ];

    for (const z of zones) {
      await Zone.updateOne(
        { key: z.key, seasonCode },
        { $set: z },
        { upsert: true }
      );
      console.log(`✓ Upserted zone ${z.key} (${seasonCode})`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[seed-zones] error:', err);
    process.exit(1);
  }
})();
