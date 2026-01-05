#!/usr/bin/env node

import mongoose from 'mongoose';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs';

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { buildTicketsPdfBuffer } from '../../src/services/tickets-pdf.js';
import { renderOrderEmail, subjectForOrder, attachQrFromBank } from '../../src/services/mailer.js';
import { sendMail } from '../../src/loaders/mailer.js';
import { ensureTicketsForEventOrder, generateTicketHex } from '../../src/services/order-finalization.js';

import dotenv from 'dotenv';
dotenv.config();

const argv = yargs(hideBin(process.argv))
  .option('event', {
    type: 'string',
    demandOption: true,
    describe: 'Slug ou ObjectId de l\'évènement'
  })
  .option('limit', {
    type: 'number',
    default: 0,
    describe: 'Nombre maximal d’envois (0 = illimité)'
  })
  .option('dry-run', {
    type: 'boolean',
    default: false,
    describe: 'Ne fait que journaliser sans envoyer d’email'
  })
  .option('force', {
    type: 'boolean',
    default: false,
    describe: 'Réexpédie même si les billets ont déjà été envoyés'
  })
  .help()
  .alias('h', 'help')
  .strict()
  .argv;

function isObjectId(input) {
  return /^[0-9a-fA-F]{24}$/.test(String(input || ''));
}

async function resolveEvent(key) {
  if (!key) return null;
  const trimmed = String(key).trim();
  if (!trimmed) return null;
  if (isObjectId(trimmed)) {
    const byId = await Event.findById(trimmed).lean();
    if (byId) return byId;
  }
  return await Event.findOne({ slug: trimmed }).lean();
}

async function deliverOrder({ order, eventDoc, dryRun }) {
  const ticketsMeta = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!ticketsMeta.length) {
    return { ok: false, reason: 'no_tickets' };
  }

  const pdf = await buildTicketsPdfBuffer(order);
  if (!pdf || !pdf.length) {
    return { ok: false, reason: 'nopdf' };
  }

  const eventDate = eventDoc.startsAt ? new Date(eventDoc.startsAt) : null;
  const eventDateLabel = eventDate ? eventDate.toLocaleString('fr-FR') : '';
  const defaultSubject = `Vos billets — ${eventDoc.name}${eventDateLabel ? ` — ${eventDateLabel}` : ''}`;
  const subject = await subjectForOrder(order) || defaultSubject;

  let html;
  try {
    html = await renderOrderEmail(order);
  } catch {
    html = '';
  }

  if (!html) {
    const whenLabel = eventDateLabel || 'Date à confirmer';
    html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
        <h2 style="margin:0 0 .5rem">Billets pour ${eventDoc.name}</h2>
        <p style="margin:.25rem 0;color:#444">
          Date : <strong>${whenLabel}</strong>
        </p>
        <p style="margin:.75rem 0">
          Retrouvez vos billets en pièce jointe (PDF). Présentez le QR à l'entrée.
        </p>
        <p style="margin:.75rem 0;color:#666">
          Cet envoi concerne votre abonnement (${order.payerFirstName || ''} ${order.payerLastName || ''}).
        </p>
      </div>`;
  }

  if (dryRun) {
    return { ok: true, dryRun: true };
  }

  await sendMail({
    to: order.payerEmail,
    subject,
    html,
    attachments: [{
      filename: `Billets_${eventDoc.slug}_${String(order._id).slice(-6)}.pdf`,
      contentType: 'application/pdf',
      content: pdf
    }]
  });

  return { ok: true };
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/bts';
  await mongoose.connect(mongoUri);

  const eventDoc = await resolveEvent(argv.event);
  if (!eventDoc) {
    throw new Error(`Évènement introuvable pour "${argv.event}"`);
  }

  const eventIdStr = String(eventDoc._id);
  const query = {
    status: 'paid',
    payerEmail: { $ne: null },
    $or: [
      { eventId: eventDoc._id },
      { 'meta.eventId': eventIdStr }
    ]
  };

  const cursor = Order.find(query).sort({ createdAt: 1 }).cursor();

const stats = {
  scanned: 0,
  sent: 0,
  dryRun: argv['dry-run'] ? 0 : null,
  skipped: 0,
  errors: 0,
  alreadySent: 0
};

  const processedRecipients = new Set();
  let limitRemaining = Number(argv.limit || 0);

  for await (const order of cursor) {
    stats.scanned += 1;
    if (limitRemaining > 0 && stats.sent >= limitRemaining) break;

    const key = `${String(order.payerEmail || '').trim().toLowerCase()}::${order.groupKey || ''}`;
    if (processedRecipients.has(key)) {
      stats.skipped += 1;
      continue;
    }

    const alreadySentAt = order?.meta?.seasonTickets?.lastSentAt;
    if (alreadySentAt && !argv.force) {
      stats.alreadySent += 1;
      continue;
    }

    try {
      const bankResult = await attachQrFromBank(mongoose.connection.db, order);
      if (bankResult?.ok && Array.isArray(bankResult.tickets) && bankResult.tickets.length) {
        order.meta = { ...(order.meta || {}), tickets: bankResult.tickets };
        order.markModified('meta.tickets');
        await order.save();
      } else if (bankResult?.ok === false && bankResult?.reason && bankResult.reason !== 'no-event') {
        console.warn(`[warn] QR bank attach failed for order ${order._id}: ${bankResult.reason}`);
      }

      await ensureTicketsForEventOrder(order);
      let fresh = await Order.findById(order._id);
      if (!fresh?.meta?.tickets || !fresh.meta.tickets.length) {
        const tickets = [];
        const lines = Array.isArray(fresh?.lines) ? fresh.lines : [];
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx];
          const seatId = String(line?.seatId || '').trim();
          const zoneKey = String(line?.zoneKey || '').trim().toUpperCase();
          const tariff = String(line?.tariffCode || '').trim().toUpperCase();
          const hex = generateTicketHex(fresh._id, idx, seatId, zoneKey, tariff);
          tickets.push({
            seatId,
            zoneKey,
            tariff,
            hex,
            holderFirstName: line?.holderFirstName || '',
            holderLastName: line?.holderLastName || ''
          });
        }
        fresh.meta = { ...(fresh.meta || {}), tickets };
        await fresh.save();
        await ensureTicketsForEventOrder(fresh);
        fresh = await Order.findById(fresh._id).lean();
      } else {
        fresh = fresh.toObject();
      }

      if (!fresh?.meta?.tickets || !fresh.meta.tickets.length) {
        stats.skipped += 1;
        console.warn(`[warn] order ${order._id} has no tickets after attach/ensure (${bankResult?.reason || 'no-meta'})`);
        continue;
      }

      const result = await deliverOrder({ order: fresh, eventDoc, dryRun: argv['dry-run'] });
      if (result.ok) {
        stats.sent += 1;
        processedRecipients.add(key);
        await Order.updateOne(
          { _id: fresh._id },
          {
            $set: {
              'meta.seasonTickets': {
                lastSentAt: new Date(),
                lastSentMode: result.dryRun ? 'dry-run' : 'send',
                lastSentBy: 'send-all-season-tickets-script'
              }
            }
          }
        );
      } else if (result.dryRun) {
        stats.sent += 1;
        stats.dryRun = (stats.dryRun ?? 0) + 1;
        processedRecipients.add(key);
        console.log(`[dry-run] order=${fresh._id} email=${fresh.payerEmail}`);
      } else {
        stats.skipped += 1;
        console.warn(`[warn] order ${fresh._id} skipped (${result.reason || 'unknown'})`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error('[send-season-tickets] order failed', String(order._id), err?.message || err);
    }
  }

  console.log('--- Résumé ---');
  console.log(`Event: ${eventDoc.slug} (${eventIdStr})`);
  console.log(`Scannés : ${stats.scanned}`);
  console.log(`Envoyés : ${stats.sent}${argv['dry-run'] ? ' (dry-run)' : ''}`);
  console.log(`Ignorés : ${stats.skipped}`);
  console.log(`Déjà envoyés : ${stats.alreadySent}`);
  console.log(`Erreurs : ${stats.errors}`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(err => {
    console.error('❌', err?.message || err);
    mongoose.disconnect().finally(() => process.exit(1));
  });
