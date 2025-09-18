#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, loadModels, readCsv, logDryRun } from './_utils.js';
import { buildTicketsPdfBuffer } from '../src/services/tickets-pdf.js';
import { sendOrderConfirmationEmail } from '../src/services/mailer.js'; // adapte si besoin

const argv = yargs(hideBin(process.argv))
  .option('file',  { type: 'string', demandOption: true })
  .option('commit',{ type: 'boolean', default: false })
  .argv;

(async () => {
  await connectMongo();
  const { Order } = loadModels();
  logDryRun(argv.commit);

  const rows = await readCsv(argv.file);
  let sent = 0, miss = 0;

  for (const row of rows) {
    const id = (row.orderId || '').trim();
    if (!id) continue;
    const order = await Order.findById(id).lean();
    if (!order) { console.warn('❓ introuvable', id); miss++; continue; }

    const pdf = await buildTicketsPdfBuffer(order);
    if (!argv.commit) {
      console.log(`🧪 Resend ${id} → ${order.payerEmail}`);
      continue;
    }
    await sendOrderConfirmationEmail(order, pdf)
      .then(() => { sent++; })
      .catch(e => console.error('✉️  fail', id, e.message));
  }

  console.log(`✅ Envoyés: ${sent} | Manquants: ${miss}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
