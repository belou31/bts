// scripts/events/send-season-tickets-for-event.js
// Usage:
//  node scripts/events/send-season-tickets-for-event.js --event 2025-09-20-belougas-vs-vipers-123456 [--limit 200] [--dry-run] [--fallback-zone SAME|N4|DEBOUT]

import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Seat }  from '../../src/models/Seat.js';
import { buildTicketsPdfBuffer } from '../../src/services/tickets-pdf.js';
import { sendMail } from '../../src/loaders/mailer.js';

import dotenv from 'dotenv';
dotenv.config();

if (!uri || !dbn) throw new Error('MONGO_URI / MONGODB_DB requis');


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
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/bts';
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

  // 3) Orders d’abonnement payés (source)
  const q = {
    phase:  'subscription',
    status: 'paid',
    seasonCode: ev.seasonCode,
    venueSlug:  ev.venueSlug,
    payerEmail: { $ne: null }
  };
  const cursor = Order.find(q).sort({ createdAt: 1 }).cursor();

  let sent = 0, scanned = 0, skipped = 0, fallbackCount = 0, errors = 0;

  for await (const sub of cursor) {
    scanned++;
    if (LIMIT && sent >= LIMIT) break;
    if (!sub?.payerEmail) { skipped++; continue; }

    // Lignes d’abonnement mappées -> lignes “billets” pour CE match
    const lines = [];
    const tickets = [];

    for (const ln of (sub.lines || [])) {
      const origSeatId = String(ln.seatId || '');
      if (!origSeatId || !realSeatIds.has(origSeatId)) continue; // on ignore les non-sièges

      const status = seatStatus.get(origSeatId) || 'available';
      const origZone = (seatZone.get(origSeatId) || ln.zoneKey || '').toUpperCase();

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
          tariff:  tar,                    // buildTicketsPdfBuffer lit d’abord ticket.tariff
          hex:     hexSeat(ev._id, origSeatId),
          fallback: false
        });
      } else {
        // billet fallback (accès sans siège garanti)
        fallbackCount++;
        const zoneKey = (FALLBACK_ZONE === 'SAME' ? origZone : FALLBACK_ZONE);
        const tar     = 'ABO_ACC_SANS_SIEGE'; // code lisible côté PDF si tu gardes l’affichage du code
        const priceCents = Number(ln.priceCents || 0);

        // Pour compat PDF + e-mails, on conserve une “ligne” avec seatId vide
        lines.push({
          seatId: '',                     // pas de siège : entrée en zone
          zoneKey,
          tariffCode: tar,
          priceCents,
          holderFirstName: String(ln.holderFirstName || ''),
          holderLastName:  String(ln.holderLastName  || '')
        });
        tickets.push({
          seatId: '',                     // => le PDF affichera la zone (seatOrZone)
          zoneKey,
          // on force un libellé explicite qui sera visible sur le PDF
          tariff: 'ABONNÉ (ACCÈS SANS SIÈGE)',
          hex:    hexZone(ev._id, zoneKey, sub._id, origSeatId),
          fallback: true,
          note: `Siège d’origine indisponible (${origSeatId}). Accès garanti, siège attribué par l’organisation.`
        });
      }
    }

    if (!lines.length) { skipped++; continue; }

    // Order “virtuel” pour CE match (format attendu par tickets-pdf.js)
    const virtualOrder = {
      _id: sub._id, // peu importe, c’est pour la trace
      mailTemplateKind: 'event',
      lines,
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

    try {
      const pdf = await buildTicketsPdfBuffer(virtualOrder);
      if (!pdf || !pdf.length) {
        console.warn('[warn] no PDF produced for order', String(sub._id));
        skipped++; continue;
      }

      // Email
      const subject = `Vos billets — ${ev.name} — ${fmtDateFR(ev.startsAt)}`;
      const fallbackMsg = tickets.some(t => t.fallback)
        ? `<p style="margin:.75rem 0;background:#FFF6E5;border:1px solid #F6C15C;padding:12px;border-radius:8px">
             <strong>Note :</strong> au moins un de vos sièges d’abonné est <em>indisponible</em> sur ce match.
             Votre <strong>accès est garanti</strong> ; un <strong>siège vous sera attribué</strong> par l’organisation à l’entrée.
           </p>`
        : '';

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
            Cet envoi concerne votre abonnement (${sub.payerFirstName || ''} ${sub.payerLastName || ''}).
          </p>
        </div>`;

      if (DRY_RUN) {
        console.log(`[dry-run] to=${virtualOrder.payerEmail} order=${sub._id} seats=${lines.length} fallback=${tickets.some(t=>t.fallback)}`);
      } else {
        await sendMail({
          to: virtualOrder.payerEmail,
          subject,
          html,
          attachments: [{
            filename: `Billets_${ev.slug}_${String(sub._id).slice(-6)}.pdf`,
            contentType: 'application/pdf',
            content: pdf
          }]
        });
      }
      sent++;
    } catch (e) {
      errors++;
      console.error('[error] send failed for order', String(sub._id), e?.message || e);
    }
  }

  await mongoose.disconnect();
  console.log(JSON.stringify({ ok: true, scanned, sent, skipped, fallbackCount, errors }, null, 2));
}

main().catch(async (e) => {
  console.error('[fatal]', e?.message || e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
