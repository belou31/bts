#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs';
import mongoose from 'mongoose';

import { connectMongo } from '../_utils.js';
import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { resolveLinePlacement } from '../../src/utils/event-attendance.js';

const argv = yargs(hideBin(process.argv))
  .option('event', {
    type: 'string',
    demandOption: true,
    describe: 'Slug ou ObjectId de l\'événement'
  })
  .option('statuses', {
    type: 'string',
    default: 'released,moved',
    describe: 'Liste CSV des statuts à inclure (kept,released,moved)'
  })
  .option('format', {
    type: 'string',
    choices: ['csv', 'json'],
    default: 'csv',
    describe: 'Format de sortie'
  })
  .option('out', {
    type: 'string',
    describe: 'Chemin du fichier de sortie (stdout si omis)'
  })
  .option('include-header', {
    type: 'boolean',
    default: true,
    describe: 'Inclure l\'en-tête CSV lorsque format=csv'
  })
  .help()
  .alias('h', 'help')
  .strict()
  .argv;

async function findEvent(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;
  if (mongoose.isValidObjectId(trimmed)) {
    const byId = await Event.findById(trimmed).lean();
    if (byId) return byId;
  }
  return await Event.findOne({ slug: trimmed }).lean();
}

function toCsvValue(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function main() {
  await connectMongo();

  const eventDoc = await findEvent(argv.event);
  if (!eventDoc) {
    throw new Error(`Événement introuvable pour "${argv.event}"`);
  }

  const statusesRaw = String(argv.statuses || '').trim();
  const allowedStatuses = statusesRaw
    ? new Set(statusesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
    : null;

  const eventIdStr = String(eventDoc._id);
  const orders = await Order.find({
    status: { $nin: ['canceled', 'failed'] },
    $or: [
      { eventId: eventDoc._id },
      { 'meta.eventId': eventIdStr }
    ]
  }).lean();

  const rows = [];
  for (const order of orders) {
    const lines = Array.isArray(order.lines) ? order.lines : [];
    lines.forEach((line, idx) => {
      const attRaw = String(line?.attendance?.status || 'kept').toLowerCase();
      const status = ['released', 'moved'].includes(attRaw) ? attRaw : 'kept';
      if (allowedStatuses && !allowedStatuses.has(status)) return;

      const placement = resolveLinePlacement(line);
      rows.push({
        eventSlug: eventDoc.slug,
        eventId: eventIdStr,
        orderId: String(order._id),
        parentOrderId: order.parentOrderId ? String(order.parentOrderId) : '',
        lineIndex: idx,
        sourceLineId: line?.sourceLineId || '',
        status,
        seatFinal: placement.seatId || '',
        zoneFinal: placement.zoneKey || '',
        overrideSeat: line?.attendance?.overrideSeatId || '',
        overrideZone: line?.attendance?.overrideZoneKey || '',
        note: line?.attendance?.note || '',
        payerEmail: order.payerEmail || '',
        holderFirstName: line?.holderFirstName || '',
        holderLastName: line?.holderLastName || '',
        createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : '',
        updatedAt: order.updatedAt ? new Date(order.updatedAt).toISOString() : ''
      });
    });
  }

  if (!rows.length) {
    console.log(`# Aucun enregistrement pour ${eventDoc.slug} avec statuses=${statusesRaw || 'all'}`);
    return;
  }

  if (argv.format === 'json') {
    const json = JSON.stringify(rows, null, 2);
    if (argv.out) {
      const dest = path.resolve(argv.out);
      await fs.writeFile(dest, json, 'utf8');
      console.log(`✔ Export JSON -> ${dest}`);
    } else {
      process.stdout.write(json + '\n');
    }
    return;
  }

  const header = [
    'eventSlug','eventId','orderId','parentOrderId','lineIndex','sourceLineId',
    'status','seatFinal','zoneFinal','overrideSeat','overrideZone','note',
    'payerEmail','holderFirstName','holderLastName','createdAt','updatedAt'
  ];
  const csvLines = [];
  if (argv['include-header']) {
    csvLines.push(header.map(toCsvValue).join(','));
  }
  for (const row of rows) {
    const line = header.map(key => toCsvValue(row[key] ?? ''));
    csvLines.push(line.join(','));
  }
  const csvOutput = csvLines.join('\n');
  if (argv.out) {
    const dest = path.resolve(argv.out);
    await fs.writeFile(dest, csvOutput, 'utf8');
    console.log(`✔ Export CSV -> ${dest}`);
  } else {
    process.stdout.write(csvOutput + '\n');
  }
}

main()
  .then(() => mongoose.disconnect())
  .catch(err => {
    console.error('❌', err?.message || err);
    mongoose.disconnect().finally(() => process.exit(1));
  });
