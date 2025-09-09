// scripts/export-orders.js
import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';

import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI manquant'); process.exit(1); }

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1]  || null;

const q = {};
if (season) q.seasonCode = season;
if (venue)  q.venueSlug  = venue;

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};

(async () => {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  const cursor = Order.find(q).lean().cursor();

  const header = [
    'orderId','createdAt','phase','status',
    'payerFirstName','payerLastName','payerEmail',
    'seasonCode','venueSlug','paymentSplit','totalCents',
    'lineIndex','seatId','zoneKey','tariffCode','priceCents','holderFirstName','holderLastName'
  ].join(',');
  process.stdout.write(header + '\n');

  for await (const o of cursor) {
    // ⚠️ NE PAS JOIN ICI : on conserve les champs dans un tableau
    const baseFields = [
      (o._id ? String(o._id) : ''),
      (o.createdAt?.toISOString?.() || ''),
      (o.phase || ''),
      (o.status || ''),
      (o.payerFirstName || ''),
      (o.payerLastName  || ''),
      (o.payerEmail     || ''),
      (o.seasonCode || ''),
      (o.venueSlug  || ''),
      (o.paymentSplit ?? ''),
      (o.totalCents ?? 0)
    ];
    
    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (!lines.length) {
      // 7 colonnes vides pour: lineIndex, seatId, zoneKey, tariffCode, priceCents, holderFirstName, holderLastName
      const rowFields = [...baseFields, '', '', '', '', '', '', ''];
      const row = rowFields.map(csvEscape).join(',');
      process.stdout.write(row + '\n');
      continue;
    }
    let j=0;
    for (const l of lines) {
      const rowFields = [
        ...baseFields,
        j,
        (l.seatId || ''),
        (l.zoneKey || ''),
        (l.tariffCode || ''),
        (l.priceCents ?? 0),
        (l.holderFirstName || ''),
        (l.holderLastName  || '')
      ];
      const row = rowFields.map(csvEscape).join(',');
      process.stdout.write(row + '\n');
      j++;
    }
  }
  await mongoose.disconnect();
})();
