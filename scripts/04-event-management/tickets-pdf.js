// scripts/04-event-management/events/tickets-pdf.js
import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { connectMongo, loadModels } from '../_utils.js';
import { attachQrFromBank } from '../../src/services/mailer.js';
import { ensureTicketsForEventOrder } from '../../src/services/order-finalization.js';
import { buildTicketsPdfBuffer } from '../../src/services/tickets-pdf.js';

const OUTPUT_DIR = path.resolve(process.cwd(), 'data', 'outputs');
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ID de l’événement' })
  .option('id', { type: 'string', demandOption: true, desc: 'Order ID' })
  .option('out', { type: 'string', desc: 'Chemin du PDF (par défaut data/outputs/<order>.pdf)' })
  .help()
  .argv;

function resolveOutPath(outArg, orderId, eventSlug) {
  const file = outArg || `tickets-${eventSlug || orderId}.pdf`;
  const abs = path.isAbsolute(file) ? file : path.join(OUTPUT_DIR, file);
  return path.resolve(abs);
}

function withinOutputDir(absPath) {
  const rel = path.relative(OUTPUT_DIR, absPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : null;
}

function buildReturnUrl(outPath) {
  const rel = withinOutputDir(outPath);
  if (!rel) return null;
  const url = `/admin/outputs/download?file=${encodeURIComponent(rel)}`;
  if (!BASE_PATH) return url;
  const normalizedBase = BASE_PATH.startsWith('/') ? BASE_PATH : `/${BASE_PATH}`;
  const cleanBase = normalizedBase.replace(/\/+$/, '');
  return `${cleanBase}${url}`;
}

async function main() {
  const { event: eventKey, id: orderId } = argv;

  await connectMongo();
  const { Event, Order } = loadModels();

  const eventDoc = await (async () => {
    const key = String(eventKey || '').trim();
    if (!key) return null;
    if (mongoose.isValidObjectId(key)) {
      const byId = await Event.findById(key).lean();
      if (byId) return byId;
    }
    return await Event.findOne({ slug: key }).lean();
  })();
  if (!eventDoc) throw new Error('Événement introuvable');

  const outPath = resolveOutPath(argv.out, orderId, eventDoc.slug);

  const ord = await Order.findById(orderId);
  if (!ord) throw new Error('Order introuvable');

  const evId = String(eventDoc._id);
  const evSlug = String(eventDoc.slug || '');
  const orderEventId = ord.meta?.eventId ? String(ord.meta.eventId) : null;
  const orderEventSlug = ord.meta?.eventSlug ? String(ord.meta.eventSlug) : null;

  if (orderEventId && orderEventId !== evId) {
    throw new Error(`Order lié à un autre événement (${orderEventId})`);
  }
  if (!orderEventId && orderEventSlug && orderEventSlug !== evSlug) {
    throw new Error(`Order lié à l'événement ${orderEventSlug}, attendu ${evSlug}`);
  }
  if (!orderEventId && !orderEventSlug) {
    throw new Error('Order non-event (pas de meta.eventId)');
  }

  let needsMetaSave = false;
  if (!orderEventId) {
    ord.meta = { ...(ord.meta || {}), eventId: evId };
    needsMetaSave = true;
  }
  if (!orderEventSlug) {
    ord.meta = { ...(ord.meta || {}), eventSlug: evSlug };
    needsMetaSave = true;
  }
  if (needsMetaSave) {
    ord.markModified('meta');
    await ord.save();
  }

  // Assure des tickets si besoin (banque QR + normalisation)
  const metaTickets = Array.isArray(ord?.meta?.tickets) ? ord.meta.tickets : [];
  const hasQr = metaTickets.some(t => !!String(t?.hex || t?.value || '').trim());
  if (!hasQr) {
    const r = await attachQrFromBank(mongoose.connection.db, ord);
    if (r?.ok && Array.isArray(r.tickets) && r.tickets.length) {
      ord.meta = { ...(ord.meta || {}), tickets: r.tickets };
      await ord.save();
    } else {
      const extra = r?.detail
        ? ` (${Object.entries(r.detail).map(([k, v]) => `${k}=${v}`).join(', ')})`
        : '';
      console.warn(`[tickets-pdf] attachQrFromBank failed or empty: ${r?.reason || 'unknown'}${extra}`);
    }
  }

  await ensureTicketsForEventOrder(ord);

  const pdf = await buildTicketsPdfBuffer(ord);
  if (!pdf || !pdf.length) throw new Error('PDF vide');

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, pdf);

  const returnUrl = buildReturnUrl(outPath);
  console.log('✅ PDF écrit:', outPath);
  if (returnUrl) console.log('returnUrl:', returnUrl);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch {}
});
