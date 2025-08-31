#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

// importe les modèles depuis le code app
import { Order } from '../../src/models/Order.js';

function die(msg, code=1){ console.error(msg); process.exit(code); }

function esc(v){ const s=String(v ?? ''); return `"${s.replace(/"/g,'""')}"`; }
function toISO(d){ try{ return new Date(d).toISOString(); }catch{ return ''; } }

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) die('MONGO_URI manquant dans .env');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { directConnection:true, serverSelectionTimeoutMS:5000, retryWrites:false });
}

function parseArgs(argv){
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
  }
  return args;
}

async function exportCsv({from, to, status, season, venue, out, onlyPaid=true}){
  const q = {};
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to)   q.createdAt.$lte = new Date(to);
  }
  if (season) q.seasonCode = season;
  if (venue)  q.venueSlug  = venue;
  if (status) q.status     = status;
  else if (onlyPaid) q.status = { $in: ['paid','completed'] };

  const orders = await Order.find(q).sort({ createdAt:1 }).lean();

  const headers = [
    'orderId','orderNo','createdAt','status','seasonCode','venueSlug',
    'payerFirstName','payerLastName','payerEmail',
    'installments','totalCents','paymentProvider','haOrderId','checkoutIntentId',
    'seatId','zoneKey','tariffCode','priceCents','justification','info'
  ];

  const rows = [];
  for (const o of orders) {
    const base = {
      orderId:          o._id ?? '',
      orderNo:          o.orderNo ?? '',
      createdAt:        toISO(o.createdAt),
      status:           o.status ?? '',
      seasonCode:       o.seasonCode ?? '',
      venueSlug:        o.venueSlug ?? '',
      payerFirstName:   o.payerFirstName ?? '',
      payerLastName:    o.payerLastName ?? '',
      payerEmail:       o.payerEmail ?? '',
      installments:     o.installments ?? o.paymentSplit ?? '',
      totalCents:       o.totalCents ?? '',
      paymentProvider:  o.paymentProvider?.name ?? '',
      haOrderId:        o.paymentProvider?.haOrderId ?? o.paymentProviderOrderId ?? '',
      checkoutIntentId: o.paymentProvider?.checkoutIntentId ?? o.checkoutIntentId ?? '',
    };

    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (!lines.length) {
      rows.push({...base, seatId:'', zoneKey:'', tariffCode:'', priceCents:'', justification:'', info:''});
      continue;
    }
    for (const ln of lines) {
      rows.push({
        ...base,
        seatId:        ln.seatId ?? '',
        zoneKey:       ln.zoneKey ?? '',
        tariffCode:    ln.tariffCode ?? '',
        priceCents:    ln.priceCents ?? '',
        justification: ln.justification ?? ln.requiredField ?? '',
        info:          ln.info ?? ln.requiredInfo ?? '',
      });
    }
  }

  const csv = [ headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(',')) ].join('\n');

  if (out) {
    fs.writeFileSync(path.resolve(out), csv, 'utf8');
    console.log(`OK: ${rows.length} ligne(s) -> ${out}`);
  } else {
    process.stdout.write(csv);
  }
}

(async function main(){
  try {
    const args = parseArgs(process.argv);
    await connect();
    await exportCsv({
      from: args.from, to: args.to,
      status: args.status,
      season: args.season, venue: args.venue,
      out: args.out,
      onlyPaid: args.onlyPaid !== 'false'
    });
    await mongoose.disconnect();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
