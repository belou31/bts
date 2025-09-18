#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import crypto from 'crypto';
import { connectMongo, loadModels, readCsv, logDryRun } from './_utils.js';
import { buildTicketsPdfBuffer } from '../src/services/tickets-pdf.js';
import { sendOrderConfirmationEmail } from '../src/services/mailer.js'; // adapte si besoin

const argv = yargs(hideBin(process.argv))
  .option('file',  { type: 'string', demandOption: true, desc: 'CSV à importer' })
  .option('send',  { type: 'boolean', default: false, desc: 'Envoyer confirmation' })
  .option('commit',{ type: 'boolean', default: false, desc: 'Écrire en base' })
  .argv;

(async () => {
  await connectMongo();
  const { Order, Event } = loadModels();
  logDryRun(argv.commit);

  const rows = await readCsv(argv.file);
  console.log(`➡️  ${rows.length} ligne(s) à traiter.`);

  let created = 0;
  for (const row of rows) {
    const qty = Number(row.quantity || 1);
    const evId = row.eventId?.trim();
    if (!evId) { console.warn('⏭️  ligne sans eventId, skip'); continue; }

    const orderDoc = {
      payerFirstName: row.payerFirstName?.trim(),
      payerLastName:  row.payerLastName?.trim(),
      payerEmail:     row.payerEmail?.trim(),
      status: (row.status || 'paid').toLowerCase(),
      meta: {
        eventId: evId,
        tickets: []
      }
    };

    for (let i = 0; i < qty; i++) {
      orderDoc.meta.tickets.push({
        seatId:    row.seatId?.trim() || undefined,
        zoneKey:   row.zoneKey?.trim() || undefined,
        tariff:    row.tariffCode || 'NORMAL',
        tariffCode: row.tariffCode || 'NORMAL',
        hex: crypto.randomBytes(16).toString('hex'),
        status: 'issued'
      });
    }

    if (!argv.commit) {
      console.log('🧪 Order (dry):', orderDoc.payerEmail, 'x', qty);
      continue;
    }

    const order = await Order.create(orderDoc);
    created++;

    if (argv.send) {
      const pdf = await buildTicketsPdfBuffer(order);
      await sendOrderConfirmationEmail(order, pdf).catch(err => {
        console.error('✉️  send fail:', order._id, err.message);
      });
    }
  }

  console.log(`✅ Terminé. Créées: ${created}.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
