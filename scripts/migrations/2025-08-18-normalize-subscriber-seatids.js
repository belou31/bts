#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const Subscriber = require('../../src/models/Subscriber');
const Seat = require('../../src/models/Seat');

function arg(name, def=null) {
  const hit = process.argv.find(x => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

(async () => {
  const [,, seasonCode] = process.argv;
  const venueSlug = arg('venue');
  if (!seasonCode || !venueSlug) {
    console.error('Usage: node scripts/migrations/2025-08-18-normalize-subscriber-seatids.js <seasonCode> --venue=<slug>');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('Missing MONGO_URI in .env'); process.exit(1); }
  await mongoose.connect(uri);

  const allSeats = await Seat.find({ seasonCode, venueSlug }, { seatId:1 }).lean();
  const byExact = new Set(allSeats.map(s => s.seatId));
  const bySuffix = new Map(); // "A-001" -> canon "S1-A-001"
  for (const s of allSeats) {
    const parts = s.seatId.split('-');
    if (parts.length >= 2) {
      const suf = parts.slice(1).join('-');
      if (!bySuffix.has(suf)) bySuffix.set(suf, s.seatId);
    }
  }

  let scanned=0, fixed=0, prevFixed=0;
  const cur = Subscriber.find({ seasonCode, venueSlug }, { prefSeatId:1, previousSeasonSeats:1 }).cursor();
  for await (const sub of cur) {
    scanned++;
    let changed = false;

    // prefSeatId
    if (sub.prefSeatId) {
      if (!byExact.has(sub.prefSeatId)) {
        const parts = sub.prefSeatId.split('-');
        const suf = parts.length >= 2 ? parts.slice(1).join('-') : null;
        const mapped = suf ? bySuffix.get(suf) : null;
        if (mapped) {
          await Subscriber.updateOne({ _id: sub._id }, { $set: { prefSeatId: mapped } });
          fixed++;
          changed = true;
        }
      }
    }

    // previousSeasonSeats
    const prev = Array.isArray(sub.previousSeasonSeats) ? sub.previousSeasonSeats : [];
    const repaired = prev.map(p => {
      if (byExact.has(p)) return p;
      const parts = String(p).split('-');
      const suf = parts.length >= 2 ? parts.slice(1).join('-') : null;
      return suf && bySuffix.has(suf) ? bySuffix.get(suf) : p;
    });
    if (JSON.stringify(repaired) !== JSON.stringify(prev)) {
      await Subscriber.updateOne({ _id: sub._id }, { $set: { previousSeasonSeats: repaired } });
      prevFixed++;
      changed = true;
    }
  }

  console.log(`scanned=${scanned} fixed_pref=${fixed} fixed_prev=${prevFixed}`);
  await mongoose.disconnect();
})();
