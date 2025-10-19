// scripts/04-event-management/events/tickets-pdf.js
import fs from 'fs/promises';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Order } from '../../src/models/Order.js';
import { attachQrFromBank, buildTicketsPdfBuffer } from '../../src/services/mailer.js';

async function main(){
  const { id, out = 'tickets.pdf' } = yargs(hideBin(process.argv))
    .option('id',  { type:'string', demandOption:true, desc:'Order ID' })
    .option('out', { type:'string', default:'tickets.pdf', desc:'Output PDF path' })
    .help().argv;

  const uri = process.env.MONGO_URI;
  const dbn = 'bts';
  if (!uri) throw new Error('MONGO_URI manquant');
  await mongoose.connect(uri, { dbName: dbn });

  const ord = await Order.findById(id);
  if (!ord) throw new Error('Order introuvable');
  if (!ord?.meta?.eventId) throw new Error('Order non-event (pas de meta.eventId)');

  // Assure des tickets si besoin
  if (!Array.isArray(ord?.meta?.tickets) || ord.meta.tickets.length === 0) {
    const r = await attachQrFromBank(mongoose.connection.db, ord);
    if (r?.ok) {
      ord.meta = { ...(ord.meta||{}), tickets: r.tickets };
      await ord.save();
    } else {
      const extra = r?.detail
        ? ` (${Object.entries(r.detail).map(([k,v])=>`${k}=${v}`).join(', ')})`
        : '';
      throw new Error(`attachQrFromBank: ${r?.reason||'unknown'}${extra}`);
    }
  }

  const pdf = await buildTicketsPdfBuffer(ord);
  if (!pdf) throw new Error('PDF vide');
  await fs.writeFile(out, pdf);
  console.log('✅ PDF écrit:', out);
  await mongoose.disconnect();
}

main().catch(async (e)=>{ console.error('❌', e.message); process.exitCode=1; try{await mongoose.disconnect();}catch{} });
