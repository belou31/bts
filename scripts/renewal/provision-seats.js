// scripts/renewal/provision-seats.js
// Usage: node scripts/renewal/provision-seats.js <seasonCode> [--venue=patinoire-blagnac] [--dry-run] [--verbose]

import mongoose from 'mongoose';

import { Season } from '../../src/models/Season.js';
import { Subscriber } from '../../src/models/Subscriber.js';
import { Seat } from '../../src/models/Seat.js';

import dotenv from 'dotenv';
dotenv.config();

function arg(name, def=null){ const m=process.argv.find(a=>a.startsWith(`--${name}=`)); return m?m.split('=')[1]:def; }
(async()=>{
  const seasonCode = process.argv[2];
  if(!seasonCode){ console.error('Usage: node scripts/renewal/provision-seats.js <seasonCode> [--venue=slug] [--dry-run] [--verbose]'); process.exit(1); }
  const dry = !!process.argv.find(a=>a==='--dry-run');
  const verbose = !!process.argv.find(a=>a==='--verbose');
  let venueSlug = arg('venue', null);

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);

  if(!venueSlug){
    const s = await Season.findOne({code:seasonCode}, {venueSlug:1}); venueSlug = s?.venueSlug || null;
  }
  let total=0, setProv=0, skippedBooked=0, notFound=0;

  const cur = Subscriber.find({}, {previousSeasonSeats:1}).cursor();
  for await (const sub of cur) {
    const seats = Array.from(new Set((sub.previousSeasonSeats||[]).map(x=>String(x).trim().toUpperCase()).filter(Boolean)));
    for (const seatId of seats) {
      total++;
      const q = { seasonCode, seatId };
      if (venueSlug) q.venueSlug = venueSlug;
      const seat = await Seat.findOne(q);
      if (!seat) { notFound++; if(verbose) console.warn(`[NF] ${seatId}`); continue; }
      if (seat.status === 'booked') { skippedBooked++; continue; }
      if (!dry) {
        seat.status = 'provisioned';
        seat.provisionedFor = sub._id;
        await seat.save();
      }
      setProv++;
      if(verbose) console.log(`[P] ${seatId} -> provisioned for ${sub._id}`);
    }
  }
  console.log(`Done. scanned=${total} provisioned=${setProv} booked_skipped=${skippedBooked} not_found=${notFound} dry=${dry}`);
  await mongoose.disconnect(); process.exit(0);
})().catch(async e=>{console.error(e);try{await mongoose.disconnect();}catch{}process.exit(1);});
