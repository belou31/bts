// scripts/export-renew-seats.js
// Usage:
//   node scripts/export-renew-seats.js <seasonCode> [--base=http://localhost:8080] [--expires=30d] [--out=renew-seats.csv] [--sort=group|email] [--email=...] [--group=...]

import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { Subscriber } from '../src/models/Subscriber.js';

import dotenv from 'dotenv';
dotenv.config();

const csvEsc = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const arg = (name, def=null) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};

(async()=>{
  const seasonCode = process.argv[2];
  if (!seasonCode) { console.error('Usage: node scripts/export-renew-seats.js <seasonCode> [--base=...] [--expires=30d] [--out=renew-seats.csv] [--sort=group|email] [--email=...] [--group=...]'); process.exit(1); }
  const base = arg('base', process.env.APP_URL || 'http://localhost:8080');
  const expiresIn = arg('expires', '30d');
  const out = arg('out', 'renew-seats.csv');
  const sortKey = arg('sort', 'group'); // group|email
  const filterEmail = arg('email', null);
  const filterGroup = arg('group', null);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const jwtSecret = process.env.JWT_SECRET;
  if (!mongoUri || !jwtSecret) { console.error('Missing MONGO_URI/JWT_SECRET'); process.exit(1); }

  await mongoose.connect(mongoUri);

  const q = { previousSeasonSeats: { $exists: true, $ne: [] } };
  if (filterEmail) q.email = filterEmail;
  if (filterGroup) q.groupKey = filterGroup;

  const subs = await Subscriber.find(
    q,
    { firstName:1, lastName:1, email:1, groupKey:1, previousSeasonSeats:1 }
  ).lean();

  let rows = [];
  for (const s of subs) {
    const token = jwt.sign({ subscriberId: s._id.toString(), seasonCode, phase: 'renewal' }, jwtSecret, { expiresIn });
    for (const seatId of s.previousSeasonSeats) {
      const renewUrl = `${base.replace(/\/$/,'')}/s/renew?id=${encodeURIComponent(token)}&seat=${encodeURIComponent(seatId)}`;
      rows.push({
        group: s.groupKey || s.email,
        email: s.email,
        firstName: s.firstName || '',
        lastName: s.lastName || '',
        seatId,
        renewUrl
      });
    }
  }

  rows.sort((a,b) => {
    if (sortKey === 'email') return a.email.localeCompare(b.email) || a.seatId.localeCompare(b.seatId);
    return (a.group || '').localeCompare(b.group || '') ||
           a.email.localeCompare(b.email) ||
           a.seatId.localeCompare(b.seatId);
  });

  const header = 'group,email,firstName,lastName,seatId,renewUrl\n';
  const body = rows.map(r => [r.group, r.email, r.firstName, r.lastName, r.seatId, r.renewUrl].map(csvEsc).join(',')).join('\n') + '\n';
  const outPath = path.resolve(out);
  fs.writeFileSync(outPath, header + body, 'utf8');
  console.log(`Wrote ${outPath} (${rows.length} rows) using base=${base}`);
  await mongoose.disconnect();
})();

