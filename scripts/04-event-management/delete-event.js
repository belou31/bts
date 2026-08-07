#!/usr/bin/env node
/**
 * Permanently deletes an event and its directly-owned data.
 *
 * Usage:
 *   node scripts/04-event-management/delete-event.js --event=<slug|id> --force [--dry-run]
 *     [--allow-paid-orders] [--keep-tariffs] [--keep-custo]
 *
 * Always prints a full report of what would be deleted before doing anything
 * — with --dry-run, that's all it does. --force is required for the actual
 * deletion (same convention as reset-db.js).
 *
 * What gets deleted:
 *   - Ticket (matching this event, by ObjectId-string and by slug)
 *   - SeatHold (this event)
 *   - ScanLog (audit trail for this event)
 *   - Order (matching this event, by eventId ObjectId and by meta.eventId/meta.eventSlug)
 *   - Tariff / TariffPrice for this event's priceTableKey — ONLY if no other
 *     event shares that priceTableKey (a shared/custom price table is left alone)
 *   - Event itself
 *   - data/customization/events/<slug>.json (unless --keep-custo)
 *
 * What is deliberately NEVER touched (shared infrastructure, not event-scoped):
 *   - Seat / Zone (keyed by season+venue, shared across every event at that venue)
 *   - SeatCatalog / ZoneCatalog (venue-wide templates)
 *   - TariffPriceCatalog (read-only source template)
 *
 * Safety gate: if any Order for this event has status paid/tobepaid/refunded,
 * or any Ticket has scannedAt set (already used at the gate), deletion is
 * refused unless --allow-paid-orders is also given — deleting real financial/
 * attendance records needs a deliberate, separate acknowledgement from just
 * --force. QrBankCode entries consumed by this event's tickets are reset
 * (used:false, ticketId:null) so the codes return to the pool rather than
 * being permanently burned.
 */
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Ticket } from '../../src/models/Ticket.js';
import { SeatHold } from '../../src/models/SeatHold.js';
import { ScanLog } from '../../src/models/ScanLog.js';
import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';
import { QrBankCode } from '../../src/models/QrBankCode.js';

const CUSTOM_EVENTS_DIR = path.resolve(process.cwd(), 'data', 'customization', 'events');
const SENSITIVE_ORDER_STATUSES = ['paid', 'tobepaid', 'refunded'];

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement' })
  .option('force', { type: 'boolean', default: false, desc: 'Requis pour effectuer la suppression réelle' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Rapporte ce qui serait supprimé, sans écrire' })
  .option('allow-paid-orders', { type: 'boolean', default: false, desc: 'Autorise la suppression même si des commandes payées/facturées existent' })
  .option('keep-tariffs', { type: 'boolean', default: false, desc: 'Ne pas supprimer les Tariff/TariffPrice de cet événement' })
  .option('keep-custo', { type: 'boolean', default: false, desc: 'Ne pas supprimer data/customization/events/<slug>.json' })
  .help()
  .argv;

function resolveEventQuery(ref) {
  return /^[0-9a-f]{24}$/i.test(ref) ? { _id: ref } : { slug: ref };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const ev = await Event.findOne(resolveEventQuery(String(argv.event).trim())).lean();
  if (!ev) throw new Error(`Événement introuvable: ${argv.event}`);

  const idStr = String(ev._id);
  const orderMatch = { $or: [{ eventId: ev._id }, { 'meta.eventId': idStr }, { 'meta.eventSlug': ev.slug }] };
  const ticketMatch = { eventId: { $in: [idStr, ev.slug] } };

  const orders = await Order.find(orderMatch).select({ status: 1 }).lean();
  const tickets = await Ticket.find(ticketMatch).select({ scannedAt: 1 }).lean();
  const seatHoldCount = await SeatHold.countDocuments({ eventId: ev._id });
  const scanLogCount = await ScanLog.countDocuments({ eventId: { $in: [idStr, ev.slug] } });

  const sensitiveOrders = orders.filter(o => SENSITIVE_ORDER_STATUSES.includes(o.status));
  const scannedTickets = tickets.filter(t => t.scannedAt);

  let tariffCount = 0, priceCount = 0, tariffShared = false;
  if (ev.priceTableKey) {
    const sharingEventCount = await Event.countDocuments({ priceTableKey: ev.priceTableKey, _id: { $ne: ev._id } });
    tariffShared = sharingEventCount > 0;
    if (!tariffShared) {
      tariffCount = await Tariff.countDocuments({ priceTableKey: ev.priceTableKey });
      priceCount = await TariffPrice.countDocuments({ priceTableKey: ev.priceTableKey });
    }
  }

  const custoPath = path.join(CUSTOM_EVENTS_DIR, `${ev.slug}.json`);
  const hasCusto = fs.existsSync(custoPath);

  console.log(`→ Event: ${ev.slug} (${ev._id}) · venue=${ev.venueSlug || '—'} · season=${ev.seasonCode} · priceTableKey=${ev.priceTableKey || '—'}`);
  console.log(`  Orders: ${orders.length} total, ${sensitiveOrders.length} paid/tobepaid/refunded`);
  console.log(`  Tickets: ${tickets.length} total, ${scannedTickets.length} already scanned`);
  console.log(`  SeatHold: ${seatHoldCount} · ScanLog: ${scanLogCount}`);
  console.log(ev.priceTableKey
    ? (tariffShared
      ? `  Tariff/TariffPrice: priceTableKey is shared with another event — will NOT be deleted`
      : `  Tariff/TariffPrice: ${tariffCount} Tariff + ${priceCount} TariffPrice would be deleted`)
    : `  Tariff/TariffPrice: no priceTableKey on this event`);
  console.log(`  Customization file: ${hasCusto ? `data/customization/events/${ev.slug}.json` : '(none)'}`);
  console.log(`  NOT touched (shared infrastructure): Seat, Zone, SeatCatalog, ZoneCatalog, TariffPriceCatalog`);

  if (argv['dry-run']) {
    console.log('\n🧪 Dry-run — rien n\'est supprimé.');
    await mongoose.disconnect();
    return;
  }

  if (!argv.force) {
    console.error('\n❌ Refusé: ajoutez --force pour confirmer la suppression.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if ((sensitiveOrders.length || scannedTickets.length) && !argv['allow-paid-orders']) {
    console.error(`\n❌ Refusé: ${sensitiveOrders.length} commande(s) payée(s)/facturée(s) et/ou ${scannedTickets.length} billet(s) déjà scanné(s) existent pour cet événement.`);
    console.error('   Ajoutez --allow-paid-orders pour confirmer explicitement leur suppression.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const ticketIds = tickets.map(t => t._id);
  if (ticketIds.length) {
    const resetRes = await QrBankCode.updateMany(
      { ticketId: { $in: ticketIds } },
      { $set: { used: false }, $unset: { ticketId: '', usedAt: '' } }
    ).catch(() => null);
    if (resetRes) console.log(`✓ QrBankCode réinitialisés: ${resetRes.modifiedCount ?? 0}`);
  }

  const ticketDel = await Ticket.deleteMany(ticketMatch);
  console.log(`✓ Tickets supprimés: ${ticketDel.deletedCount}`);

  const holdDel = await SeatHold.deleteMany({ eventId: ev._id });
  console.log(`✓ SeatHold supprimés: ${holdDel.deletedCount}`);

  const scanDel = await ScanLog.deleteMany({ eventId: { $in: [idStr, ev.slug] } });
  console.log(`✓ ScanLog supprimés: ${scanDel.deletedCount}`);

  const orderDel = await Order.deleteMany(orderMatch);
  console.log(`✓ Orders supprimés: ${orderDel.deletedCount}`);

  if (!argv['keep-tariffs'] && ev.priceTableKey && !tariffShared) {
    const tarDel = await Tariff.deleteMany({ priceTableKey: ev.priceTableKey });
    const priceDel = await TariffPrice.deleteMany({ priceTableKey: ev.priceTableKey });
    console.log(`✓ Tariff supprimés: ${tarDel.deletedCount} · TariffPrice supprimés: ${priceDel.deletedCount}`);
  }

  await Event.deleteOne({ _id: ev._id });
  console.log(`✓ Event supprimé: ${ev.slug}`);

  if (!argv['keep-custo'] && hasCusto) {
    fs.unlinkSync(custoPath);
    console.log(`✓ Personnalisation supprimée: data/customization/events/${ev.slug}.json`);
  }

  console.log('\n✅ Suppression terminée.');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
