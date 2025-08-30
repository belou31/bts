
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { Subscriber } from '../../src/models/Subscriber.js';
import { Seat } from '../../src/models/Seat.js';

import dotenv from 'dotenv';
dotenv.config();


(async () => {
  const seasonCode = process.argv[2];
  if (!seasonCode) throw new Error('usage: node scripts/provision-renewal.js <seasonCode>');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const subs = await Subscriber.find({ previousSeasonSeats: { $exists: true, $ne: [] } });
  let count = 0;
  for (const s of subs) {
    for (const seatId of s.previousSeasonSeats) {
      const r = await Seat.findOneAndUpdate(
        { seatId, seasonCode },
        { $set: { status: 'provisioned', provisionedFor: s._id } },
        { upsert: false }
      );
      if (r) count++;
    }
  }
  console.log(`Provisioned seats: ${count}`);
  await mongoose.disconnect();
})();

