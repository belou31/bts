// scripts/renewal/close-renewal-phase.js
// Usage: node scripts/renewal/close-renewal-phase.js <seasonCode> [--venue=slug]
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Seat, Season } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function arg(name, def=null) {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=').slice(1).join('=') : def;
}

async function main() {
  const seasonCode = process.argv[2];
  if (!seasonCode) {
    console.error('Usage: node scripts/renewal/close-renewal-phase.js <seasonCode> [--venue=slug]');
    process.exit(1);
  }
  const venueSlug = arg('venue', null);

  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';
  await mongoose.connect(uri, {});

  // 1) Clôture de la saison (flag)
  const s = await Season.findOneAndUpdate(
    { code: seasonCode },
    { $set: { enableRenewal: false, renewalClosedAt: new Date() } },
    { new: true }
  );
  console.log('Season updated:', s?.code, 'enableRenewal=', s?.enableRenewal, 'renewalClosedAt=', s?.renewalClosedAt?.toISOString());

  // 2) Libération des sièges non renouvelés
  const filter = { seasonCode, status: 'provisioned' };
  if (venueSlug) filter.venueSlug = venueSlug;

  const res = await Seat.updateMany(filter, { $set: { status: 'available', provisionedFor: null } });
  console.log('Seats released:', res.modifiedCount);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

