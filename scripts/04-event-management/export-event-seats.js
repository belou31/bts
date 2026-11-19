#!/usr/bin/env node
/**
 * Exporte l'état des sièges POUR UN MATCH, et qui occupe chaque place.
 *
 * Ce n'est pas la même chose que l'export de saison : un siège vendu à
 * l'abonnement est `booked` dans Seat pour toute la saison, alors que pour un
 * match donné il peut être rendu (place libérée par l'abonné), déplacé, ou
 * retenu par une sélection en cours. L'état exporté ici est celui que voit
 * réellement l'acheteur, calculé par computeEventSeatStates — la même fonction
 * que la billetterie.
 *
 * Origine de chaque place :
 *   season  — occupée par un abonnement, sans commande propre à ce match
 *   event   — occupée par une commande de ce match
 *   hold    — sélection en cours (panier d'un autre visiteur)
 *   —       — libre, ou bloquée sans commande (VIP, blocage manuel)
 *
 * Écrit par défaut dans data/outputs/. --stdout pour un enchaînement en pipe.
 *
 * Usage:
 *   node scripts/04-event-management/export-event-seats.js --event=<slug|id> [--zone=<key>] [--status=<état>] [--out=<fichier.csv>] [--stdout]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Event, Order, Seat } from '../../src/models/index.js';
import { computeEventSeatStates } from '../../src/services/event-seat-states.js';
import { resolveLinePlacement } from '../../src/utils/event-attendance.js';
import { writeCsvFile, explainWriteFailure } from '../lib/csv-output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || null;
const eventRef = arg('event');
const zone     = arg('zone');
const statusF  = arg('status');
const outArg   = arg('out');
const toStdout = process.argv.includes('--stdout');

if (!eventRef) {
  console.error('Usage: node scripts/04-event-management/export-event-seats.js --event=<slug|id> [--zone=<key>] [--status=<état>] [--out=<fichier.csv>] [--stdout]');
  process.exit(1);
}

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function buildRows(ev) {
  const states = await computeEventSeatStates(ev);
  const list = Array.isArray(states) ? states : Array.from(states?.values?.() || []);

  // Qui occupe la place : commande de CE match d'abord, abonnement ensuite.
  // L'ordre compte — une place d'abonné reprise pour ce match doit être
  // attribuée à la commande du match, pas à l'abonnement.
  const eventOrders = await Order.find(
    { status: { $in: ['paid', 'tobepaid'] }, $or: [{ eventId: ev._id }, { 'meta.eventId': String(ev._id) }] },
    { lines: 1, payerFirstName: 1, payerLastName: 1, payerEmail: 1, origin: 1, createdAt: 1 }
  ).lean();
  const seasonOrders = await Order.find(
    { status: 'paid', seasonCode: ev.seasonCode, venueSlug: ev.venueSlug,
      'origin.flow': { $in: ['subscription', 'renew'] } },
    { lines: 1, payerFirstName: 1, payerLastName: 1, payerEmail: 1, origin: 1, createdAt: 1 }
  ).lean();

  const holder = new Map();
  const index = (orders, source) => {
    for (const o of orders) {
      for (const ln of (o.lines || [])) {
        const placement = resolveLinePlacement(ln);
        if (placement.released) continue;
        const sid = String(placement.seatId || '').trim();
        if (!sid || holder.has(sid)) continue;
        holder.set(sid, {
          source,
          orderId: String(o._id),
          payer: `${o.payerFirstName || ''} ${o.payerLastName || ''}`.trim(),
          email: o.payerEmail || '',
          flow: o.origin?.flow || '',
          tariff: ln.tariffCode || '',
          priceCents: ln.priceCents ?? ''
        });
      }
    }
  };
  index(eventOrders, 'event');
  index(seasonOrders, 'season');

  // row/num ne sont pas portés par computeEventSeatStates : on les relit.
  const geom = new Map((await Seat.find(
    { seasonCode: ev.seasonCode, venueSlug: ev.venueSlug },
    { seatId: 1, row: 1, num: 1, _id: 0 }
  ).lean()).map(s => [String(s.seatId), s]));

  return list
    .filter(s => !zone || String(s.zoneKey || '').toUpperCase() === zone.toUpperCase())
    .filter(s => !statusF || String(s.status || '') === statusF)
    .sort((a, b) => String(a.zoneKey).localeCompare(String(b.zoneKey))
      || String(a.seatId).localeCompare(String(b.seatId)))
    .map(s => {
      const h = holder.get(String(s.seatId));
      const g = geom.get(String(s.seatId)) || {};
      // Une place occupée sans commande retrouvée est signalée plutôt que
      // laissée vide : c'est le symptôme d'un blocage manuel ou d'un écart.
      const origin = h ? h.source : (s.status === 'booked' ? 'sans-commande' : '');
      return [
        s.seatId || '', s.zoneKey || '', g.row || '', g.num || '', s.status || '',
        origin, h?.orderId || '', h?.flow || '', h?.payer || '', h?.email || '',
        h?.tariff || '', h?.priceCents ?? ''
      ];
    });
}

try {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });

  const ev = /^[0-9a-f]{24}$/i.test(eventRef)
    ? await Event.findById(eventRef).lean()
    : await Event.findOne({ slug: eventRef }).lean();
  if (!ev) throw new Error(`Événement introuvable : ${eventRef}`);

  const header = [
    'seatId', 'zoneKey', 'row', 'num', 'status',
    'origin', 'orderId', 'flow', 'holder', 'email', 'tariffCode', 'priceCents'
  ].join(',');
  const rows = await buildRows(ev);
  const emit = (stream) => {
    stream.write(header + '\n');
    for (const r of rows) stream.write(r.map(csvEscape).join(',') + '\n');
  };

  if (toStdout) {
    emit(process.stdout);
  } else {
    const defaultName = ['event-seats', ev.slug, zone || null, statusF || null]
      .filter(Boolean).join('-') + '.csv';
    const { path: outPath } = await writeCsvFile({ outArg, defaultName, writer: async (s) => emit(s) });
    const occupied = rows.filter(r => r[4] === 'booked').length;
    console.log(`OK: ${rows.length} siège(s) — ${occupied} occupé(s) -> ${outPath}`);
  }

  await mongoose.disconnect();
} catch (err) {
  explainWriteFailure(err);
  try { await mongoose.disconnect(); } catch { /* rien de mieux à faire */ }
  process.exit(1);
}
