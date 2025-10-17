// scripts/04-event-management/send-season-tickets-for-event.js
// Usage:
//  node scripts/04-event-management/send-season-tickets-for-event.js --event 2025-09-20-belougas-vs-vipers-123456 [--limit 200] [--dry-run] [--fallback-zone SAME|N4|DEBOUT]

import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Seat }  from '../../src/models/Seat.js';
import { Subscriber } from '../../src/models/Subscriber.js';
import { buildTicketsPdfBuffer } from '../../src/services/tickets-pdf.js';
import { sendMail } from '../../src/loaders/mailer.js';

import dotenv from 'dotenv';
dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function argval(name, def = '') {
  const i = process.argv.findIndex(a => a === `--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const kv = process.argv.find(a => a.startsWith(`--${name}=`));
  if (kv) return kv.split('=').slice(1).join('=');
  return def;
}
const EVENT_KEY     = argval('event', '').trim();
const LIMIT         = Number(argval('limit', '0')) || 0;
const DRY_RUN       = process.argv.includes('--dry-run');
const FALLBACK_ZONE = (argval('fallback-zone', 'SAME') || 'SAME').toUpperCase();

if (!EVENT_KEY) {
  console.error('Missing --event <slug|ObjectId>');
  process.exit(1);
}

function fmtDateFR(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  } catch { return ''; }
}

function zoneFromSeatId(seatId) {
  const s = String(seatId || '').trim();
  if (!s) return '';
  const parts = s.split('-');
  return parts.length ? parts[0].toUpperCase() : '';
}

// HEX pour contrôle d’accès
// - billet siège: base64("E:<eventId>:S:<seatId>")
// - billet fallback zone: base64("E:<eventId>:Z:<zoneKey>:O:<orderId>:S:<origSeatId>")
function hexSeat(evId, seatId) {
  return Buffer.from(`E:${evId}:S:${seatId}`, 'utf8').toString('base64');
}
function hexZone(evId, zoneKey, orderId, origSeatId='') {
  return Buffer.from(`E:${evId}:Z:${zoneKey}:O:${orderId}:S:${origSeatId}`, 'utf8').toString('base64');
}

async function main() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/bts';
  await mongoose.connect(mongoUri);

  // 1) Evènement
  const ev = await (async () => {
    const bySlug = await Event.findOne({ slug: EVENT_KEY }).lean();
    if (bySlug) return bySlug;
    if (mongoose.isValidObjectId(EVENT_KEY)) {
      const byId = await Event.findById(EVENT_KEY).lean();
      if (byId) return byId;
    }
    throw new Error(`Event not found: ${EVENT_KEY}`);
  })();

  // 2) Index des sièges réels + leur statut pour ce match
  const seats = await Seat.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug })
                          .select('seatId zoneKey status -_id').lean();
  const realSeatIds = new Set(seats.map(s => String(s.seatId)));
  const seatStatus  = new Map(seats.map(s => [String(s.seatId), String(s.status || 'available').toLowerCase()]));
  const seatZone    = new Map(seats.map(s => [String(s.seatId), String(s.zoneKey || '').toUpperCase()]));

  async function deliverVirtualOrder(orderDoc) {
    const tickets = Array.isArray(orderDoc?.meta?.tickets) ? orderDoc.meta.tickets : [];
    try {
      const pdf = await buildTicketsPdfBuffer(orderDoc);
      if (!pdf || !pdf.length) {
        console.warn('[warn] no PDF produced for order', String(orderDoc._id));
        return { ok: false, reason: 'nopdf' };
      }

      const hasFallback = tickets.some(t => t.fallback);
      const fallbackMsg = hasFallback
        ? `<p style="margin:.75rem 0;background:#FFF6E5;border:1px solid #F6C15C;padding:12px;border-radius:8px">
             <strong>Note :</strong> au moins un de vos sièges d’abonné est <em>indisponible</em> sur ce match.
             Votre <strong>accès est garanti</strong> ; un <strong>siège vous sera attribué</strong> par l’organisation à l’entrée.
           </p>`
        : '';

      const subject = `Vos billets — ${ev.name} — ${fmtDateFR(ev.startsAt)}`;
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
          <h2 style="margin:0 0 .5rem">Billets pour ${ev.name}</h2>
          <p style="margin:.25rem 0;color:#444">
            Date : <strong>${fmtDateFR(ev.startsAt)}</strong>
          </p>
          ${fallbackMsg}
          <p style="margin:.75rem 0">
            Retrouvez vos billets en pièce jointe (PDF). Présentez le QR à l'entrée.
          </p>
          <p style="margin:.75rem 0;color:#666">
            Cet envoi concerne votre abonnement (${orderDoc.payerFirstName || ''} ${orderDoc.payerLastName || ''}).
          </p>
        </div>`;

      if (DRY_RUN) {
        console.log(`[dry-run] to=${orderDoc.payerEmail} order=${orderDoc._id} seats=${orderDoc.lines?.length || 0} fallback=${hasFallback}`);
        return { ok: true, dryRun: true };
      }

      await sendMail({
        to: orderDoc.payerEmail,
        subject,
        html,
        attachments: [{
          filename: `Billets_${ev.slug}_${String(orderDoc._id).slice(-6)}.pdf`,
          contentType: 'application/pdf',
          content: pdf
        }]
      });
      return { ok: true };
    } catch (err) {
      errors++;
      console.error('[error] send failed for order', String(orderDoc._id), err?.message || err);
      return { ok: false, error: err };
    }
  }

  // 3) Orders d’abonnement payés (source)
  const q = {
    phase:  'subscription',
    status: 'paid',
    seasonCode: ev.seasonCode,
    venueSlug:  ev.venueSlug,
    payerEmail: { $ne: null }
  };
  const processedEmails = new Set();
  const cursor = Order.find(q).sort({ createdAt: 1 }).cursor();

  let sent = 0, scanned = 0, skipped = 0, fallbackCount = 0, errors = 0;

  for await (const sub of cursor) {
    scanned++;
    if (LIMIT && sent >= LIMIT) break;
    if (!sub?.payerEmail) { skipped++; continue; }

    // Lignes d’abonnement mappées -> lignes “billets” pour CE match
    const pseudoOrderId = new mongoose.Types.ObjectId();
    const lines = [];
    const tickets = [];

    for (const ln of (sub.lines || [])) {
      const origSeatId = String(ln.seatId || '');
      if (!origSeatId) continue;

      const seatKnown = realSeatIds.has(origSeatId);
      const status = seatKnown ? (seatStatus.get(origSeatId) || 'available') : 'missing';
      const origZone = seatKnown
        ? (seatZone.get(origSeatId) || ln.zoneKey || zoneFromSeatId(origSeatId) || '').toUpperCase()
        : (ln.zoneKey || zoneFromSeatId(origSeatId) || FALLBACK_ZONE).toUpperCase();

      if (status === 'available') {
        // billet normal (siège garanti)
        const tar = String(ln.tariffCode || '').toUpperCase();
        const priceCents = Number(ln.priceCents || 0);
        lines.push({
          seatId: origSeatId,
          zoneKey: origZone,
          tariffCode: tar,
          priceCents,
          holderFirstName: String(ln.holderFirstName || ''),
          holderLastName:  String(ln.holderLastName  || '')
        });
        tickets.push({
          seatId: origSeatId,
          zoneKey: origZone,
          tariff:  tar,
          hex:     hexSeat(ev._id, origSeatId),
          fallback: false
        });
      } else {
        fallbackCount++;
        const zoneKey = (FALLBACK_ZONE === 'SAME' ? origZone : FALLBACK_ZONE);
        const priceCents = Number(ln.priceCents || 0);

        if (cref) {
          lines.push({
            seatId: origSeatId,
            zoneKey: origZone,
            tariffCode: 'SUBSCRIPTION',
            priceCents,
            holderFirstName: String(ln.holderFirstName || ''),
            holderLastName:  String(ln.holderLastName  || '')
          });
          tickets.push({
            seatId: origZone,
            zoneKey: origZone,
            tariff: 'ABONNÉ (ACCÈS SANS SIÈGE)',
            hex: hexZone(ev._id, origZone, sub._id, origSeatId),
            fallback: true,
            note: `Siège d’origine indisponible (${origSeatId}). Accès garanti, siège attribué par l’organisation.`
          });
        } else {
          lines.push({
            seatId: origSeatId,
            zoneKey: origZone,
            tariffCode: 'SUBSCRIPTION',
            priceCents,
            holderFirstName: String(ln.holderFirstName || ''),
            holderLastName:  String(ln.holderLastName  || '')
          });
          tickets.push({
            seatId: origSeatId,
            zoneKey: origZone,
            tariff: 'ABONNÉ (ACCÈS SANS SIÈGE)',
            hex: hexZone(ev._id, zoneKey, sub._id, origSeatId),
            fallback: true,
            note: `Siège d’origine indisponible (${origSeatId}). Accès garanti, siège attribué par l’organisation.`
          });
        }
      }
    }

    if (!lines.length) { skipped++; continue; }

    // Order “virtuel” pour CE match (format attendu par tickets-pdf.js)
    const virtualOrder = {
      _id: sub._id, // peu importe, c’est pour la trace
      mailTemplateKind: 'event',
      lines,
      seasonCode: ev.seasonCode,
      venueSlug: ev.venueSlug,
      payerFirstName: sub.payerFirstName || sub.payer?.firstName || '',
      payerLastName:  sub.payerLastName  || sub.payer?.lastName  || '',
      payerEmail:     sub.payerEmail     || sub.payer?.email     || '',
      meta: {
        provider: 'season',
        eventId:      String(ev._id),
        eventSlug:    ev.slug,
        eventName:    ev.name,
        eventStartsAt: ev.startsAt,
        tickets
      }
    };

    const payEmailNorm = String(virtualOrder.payerEmail || '').trim().toLowerCase();
    if (payEmailNorm) processedEmails.add(payEmailNorm);

    const res = await deliverVirtualOrder(virtualOrder);
    if (res.ok) sent++;
    else skipped++;
  }

  async function processSubscribersFallback(alreadyProcessed) {
    const subs = await Subscriber.find({
      seasonCode: ev.seasonCode,
      venueSlug: ev.venueSlug,
      email: { $ne: null },
      status: { $in: ['active', 'pending'] }
    }).lean();
    if (!subs.length) return;

    const byEmail = new Map();
    for (const record of subs) {
      const email = String(record.email || '').trim().toLowerCase();
      const seatId = String(record.prefSeatId || '').trim();
      if (!email || !seatId) continue;
      if (alreadyProcessed.has(email)) continue;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(record);
    }

    for (const [email, records] of byEmail.entries()) {
      if (LIMIT && sent >= LIMIT) break;

      const uniqueSeats = new Map();
      for (const rec of records) {
        const seatId = String(rec.prefSeatId || '').trim();
        if (!seatId || uniqueSeats.has(seatId)) continue;
        uniqueSeats.set(seatId, rec);
      }

      const pseudoOrderId = new mongoose.Types.ObjectId();
      const lines = [];
      const tickets = [];

      for (const [seatId, rec] of uniqueSeats.entries()) {
        const seatKnown = realSeatIds.has(seatId);
        const statusSeat = seatKnown ? (seatStatus.get(seatId) || 'available') : 'missing';
        const origZone = seatKnown
          ? (seatZone.get(seatId) || '').toUpperCase()
          : zoneFromSeatId(seatId) || FALLBACK_ZONE;
        const holderFirstName = rec.firstName || '';
        const holderLastName  = rec.lastName  || '';

        if (statusSeat === 'available') {
          lines.push({
            seatId,
            zoneKey: origZone,
            tariffCode: 'SUBSCRIPTION',
            priceCents: 0,
            holderFirstName,
            holderLastName
          });
          tickets.push({
            seatId,
            zoneKey: origZone,
            tariff: 'ABONNÉ',
            hex: hexSeat(ev._id, seatId),
            fallback: false
          });
        } else {
          fallbackCount++;
          const zoneKey = (FALLBACK_ZONE === 'SAME' ? origZone : FALLBACK_ZONE);
          lines.push({
            seatId: '',
            zoneKey,
            tariffCode: 'SUBSCRIPTION',
            priceCents: 0,
            holderFirstName,
            holderLastName
          });
          tickets.push({
            seatId: '',
            zoneKey,
            tariff: 'ABONNÉ (ACCÈS SANS SIÈGE)',
            hex: hexZone(ev._id, zoneKey, pseudoOrderId, seatId),
            fallback: true,
            note: `Siège d’origine indisponible (${seatId}). Accès garanti, siège attribué par l’organisation.`
          });
        }
      }

      if (!lines.length) {
        skipped++;
        continue;
      }

      alreadyProcessed.add(email);
      scanned++;
      const primary = records.find(r => r.firstName || r.lastName) || records[0];
      const virtualOrder = {
        _id: pseudoOrderId,
        mailTemplateKind: 'event',
        lines,
        seasonCode: ev.seasonCode,
        venueSlug: ev.venueSlug,
        payerFirstName: primary?.firstName || '',
        payerLastName:  primary?.lastName  || '',
        payerEmail: email,
        meta: {
          provider: 'season',
          eventId: String(ev._id),
          eventSlug: ev.slug,
          eventName: ev.name,
          eventStartsAt: ev.startsAt,
          tickets
        }
      };

      const res = await deliverVirtualOrder(virtualOrder);
      if (res.ok) sent++;
      else skipped++;
    }
  }

  await processSubscribersFallback(processedEmails);

  await mongoose.disconnect();
  console.log(JSON.stringify({ ok: true, scanned, sent, skipped, fallbackCount, errors }, null, 2));
}

main().catch(async (e) => {
  console.error('[fatal]', e?.message || e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
