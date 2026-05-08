#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, loadModels, readCsv, logDryRun } from './_utils.js';

const argv = yargs(hideBin(process.argv))
  .option('file',  { type: 'string', demandOption: true })
  .option('commit',{ type: 'boolean', default: false })
  .argv;

(async () => {
  await connectMongo();
  const { Order, Ticket } = loadModels();
  logDryRun(argv.commit);

  const rows = await readCsv(argv.file);
  let soft = 0, hard = 0, miss = 0;

  for (const row of rows) {
    const id = (row.orderId || '').trim();
    const mode = (row.mode || 'soft').toLowerCase();
    if (!id) continue;

    const order = await Order.findById(id);
    if (!order) { console.warn('❓ introuvable', id); miss++; continue; }

    if (!argv.commit) {
      console.log(`🧪 ${mode.toUpperCase()} delete ${id}`);
      continue;
    }

    if (mode === 'hard') {
      await Ticket.updateMany({ 'orderId': id }, { $set: { status: 'void' } });
      await Order.deleteOne({ _id: id });
      hard++;
    } else {
      order.status = 'cancelled';
      order.meta = order.meta || {};
      order.meta.cancelledAt = new Date();
      // invalider tickets “dans” l’order.meta.tickets si tu stockes ici
      if (Array.isArray(order.meta.tickets)) {
        order.meta.tickets = order.meta.tickets.map(t => ({ ...t, status: 'void' }));
      }
      await order.save();
      await Ticket.updateMany({ 'orderId': id }, { $set: { status: 'void' } });
      soft++;
    }
  }

  console.log(`✅ Soft: ${soft} | Hard: ${hard} | Manquants: ${miss}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
