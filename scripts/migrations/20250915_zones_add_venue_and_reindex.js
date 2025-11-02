// Usage: node scripts/migrations/20250915_zones_add_venue_and_reindex.js --venue patinoire-blagnac
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

const { venue } = yargs(hideBin(process.argv))
  .option('venue', { type:'string', demandOption:true })
  .help().argv;

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGO_URI/MONGODB_URI manquant');
  process.exit(1);
}

async function run(){
  await mongoose.connect(uri, process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {});
  const db = mongoose.connection.db;
  const coll = db.collection('zones');

  // 1) Audit doublons
  const dups = await coll.aggregate([
    { $group: { _id: { seasonCode:"$seasonCode", key:"$key" }, ids:{ $push:"$_id"}, n:{ $sum:1 } } },
    { $match: { n: { $gt: 1 } } }
  ]).toArray();
  if (dups.length) {
    console.error('🚫 Doublons détectés sur (seasonCode,key) — corrigez avant migration:', JSON.stringify(dups, null, 2));
    process.exit(2);
  }

  // 2) Backfill venueSlug si manquant
  const up = await coll.updateMany(
    { venueSlug: { $exists:false } },
    { $set: { venueSlug: venue } }
  );
  console.log(`✓ Backfill venueSlug="${venue}" sur ${up.modifiedCount} doc(s)`);

  // 3) Crée le NOUVEL index unique
  try {
    await coll.createIndex(
      { seasonCode:1, venueSlug:1, key:1 },
      { name:'uniq_zone_season_venue_key', unique:true }
    );
    console.log('✓ Index uniq_zone_season_venue_key créé');
  } catch (e) {
    console.error('🚫 Echec createIndex uniq_zone_season_venue_key:', e.message);
    process.exit(3);
  }

  // 4) Drop ANCIEN index
  try {
    await coll.dropIndex('uniq_zone_key_season');
    console.log('✓ Ancien index uniq_zone_key_season supprimé');
  } catch (e) {
    console.warn('ℹ️ dropIndex ancien a échoué (peut-être déjà supprimé):', e.message);
  }

  await mongoose.disconnect();
  console.log('✅ Migration terminée');
}

run().catch(async (e)=>{ console.error('❌', e); try{await mongoose.disconnect();}catch{}; process.exit(1); });
