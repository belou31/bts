#!/usr/bin/env node
/**
 * Send season tickets for selected subscription orders.
 *
 * Usage:
 *   node scripts/04-event-management/send-season-ticket-by-order.js \
 *     --event=<slug|ObjectId> --order=<orderId[,orderId2]> [--dry-run] [--fallback-zone=SAME]
 */

import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { Order } from '../../src/models/Order.js';
import { Seat } from '../../src/models/Seat.js';
import { buildTicketsPdfBuffer } from '../../src/services/tickets-pdf.js';
import { renderOrderEmail, subjectForOrder } from '../../src/services/mailer.js';
import { sendMail } from '../../src/loaders/mailer.js';

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement' })
  .option('order', { type: 'string', demandOption: true, desc: 'Un ou plusieurs orderId (séparés par des virgules)' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Ne pas envoyer d\'email' })
  .option('fallback-zone', { type: 'string', default: 'SAME', desc: 'Zone fallback lorsque le siège n\'est pas disponible' })
  .help()
  .argv;

const EVENT_KEY = String(argv.event || '').trim();
const ORDER_KEYS = String(argv.order || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const DRY_RUN = argv['dry-run'] === true;
const FALLBACK_ZONE = String(argv['fallback-zone'] || 'SAME').toUpperCase();

if (!EVENT_KEY) {
  console.error('❌ Paramètre --event requis');
  process.exit(1);
}
if (!ORDER_KEYS.length) {
  console.error('❌ Paramètre --order requis (un ou plusieurs orderId)');
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

const hexSeat = (evId, seatId) => Buffer.from(`E:${evId}:S:${seatId}`, 'utf8').toString('base64');
const hexZone = (evId, zoneKey, orderId, origSeatId = '') =>
  Buffer.from(`E:${evId}:Z:${zoneKey}:O:${orderId}:S:${origSeatId}`, 'utf8').toString('base64');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGO_URI/MONGODB_URI manquant');
    process.exit(1);
  }

  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  try {
    const ev = await (async () => {
      if (/^[0-9a-f]{24}$/i.test(EVENT_KEY)) return Event.findById(EVENT_KEY).lean();
      return Event.findOne({ slug: EVENT_KEY }).lean();
    })();
    if (!ev) throw new Error('Événement introuvable');

    console.log(`→ Event ${ev.slug || ev._id} (${fmtDateFR(ev.startsAt)})`);

    const seats = await Seat.find({ seasonCode: ev.seasonCode, venueSlug: ev.venueSlug })
      .select('seatId zoneKey status -_id')
      .lean();

    const realSeatIds = new Set(seats.map(s => String(s.seatId)));
    const seatStatus = new Map(seats.map(s => [String(s.seatId), String(s.status || 'available').toLowerCase()]));
    const seatZone = new Map(seats.map(s => [String(s.seatId), String(s.zoneKey || '').toUpperCase()]));

    let processed = 0;
    let delivered = 0;
    let skipped = 0;
    let errors = 0;
    let notFound = 0;

    for (const rawId of ORDER_KEYS) {
      if (!rawId) continue;
      processed++;
      let order = null;
      try {
        if (/^[0-9a-f]{24}$/i.test(rawId)) {
          order = await Order.findById(rawId);
        }
        if (!order) {
          order = await Order.findOne({ 'paymentProviderMeta.legacyOrderId': rawId });
        }
        if (!order) {
          console.warn(`⚠️  Order introuvable: ${rawId}`);
          notFound++;
          continue;
        }

        const result = await sendTicketsForOrder({
          event: ev,
          order,
          seatMaps: { realSeatIds, seatStatus, seatZone },
          fallbackZone: FALLBACK_ZONE,
          dryRun: DRY_RUN
        });

        if (result === 'ok') delivered++;
        else if (result === 'skip') skipped++;
        else errors++;
      } catch (err) {
        errors++;
        console.error('❌', rawId, err?.message || err);
      }
    }

    await mongoose.disconnect();
    console.log(JSON.stringify({ ok: true, processed, delivered, skipped, errors, notFound, dryRun: DRY_RUN }, null, 2));
  } catch (err) {
    console.error('❌', err?.message || err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
}

async function sendTicketsForOrder({ event, order, seatMaps, fallbackZone, dryRun }) {
  const { realSeatIds, seatStatus, seatZone } = seatMaps;
  const pseudoOrderId = new mongoose.Types.ObjectId();
  const lines = [];
  const tickets = [];
  const fallbackZoneUpper = String(fallbackZone || 'ZONE').toUpperCase();

  const buildFallbackSeatId = (zoneKey, index) => {
    const zoneLabel = String(zoneKey || fallbackZoneUpper || 'ZONE').toUpperCase();
    const suffix = String(order._id || pseudoOrderId).slice(-6).toUpperCase();
    const seq = String(index + 1).padStart(2, '0');
    return `${zoneLabel}-GA-${suffix}-${seq}`;
  };

  for (const ln of (order.lines || [])) {
    const rawSeatId = String(ln.seatId || '').trim();
    const zoneFromOrder = String(ln.zoneKey || '').trim().toUpperCase();
    const seatKnown = rawSeatId ? realSeatIds.has(rawSeatId) : false;
    const status = seatKnown ? (seatStatus.get(rawSeatId) || 'available') : 'missing';
    const seatUsable = seatKnown && ['available', 'booked', 'provisioned'].includes(status);
    const zoneComputed = seatKnown
      ? (seatZone.get(rawSeatId) || zoneFromOrder || zoneFromSeatId(rawSeatId) || '').toUpperCase()
      : (zoneFromOrder || zoneFromSeatId(rawSeatId) || fallbackZone || '').toUpperCase();
    const zoneForTicket = zoneComputed || fallbackZoneUpper;
    const seatIdForTickets = seatUsable ? rawSeatId : buildFallbackSeatId(zoneForTicket, lines.length);
    const priceCents = Number(ln.priceCents || 0);
    const holderFirstName = String(ln.holderFirstName || '');
    const holderLastName  = String(ln.holderLastName  || '');
    const tariffCode = String(ln.tariffCode || 'SUBSCRIPTION').toUpperCase();

    if (seatUsable) {
      lines.push({
        seatId: rawSeatId,
        zoneKey: zoneForTicket,
        tariffCode,
        priceCents,
        holderFirstName,
        holderLastName
      });
      tickets.push({
        seatId: rawSeatId,
        zoneKey: zoneForTicket,
        tariff: tariffCode,
        hex: hexSeat(event._id, rawSeatId),
        fallback: false
      });
    } else {
      const note = seatKnown
        ? `Siège d’origine indisponible (${rawSeatId}). Accès garanti, siège attribué par l’organisation.`
        : `Zone ${zoneForTicket} en accès libre (aucun siège numéroté).`;

      lines.push({
        seatId: seatIdForTickets,
        zoneKey: zoneForTicket,
        tariffCode: 'SUBSCRIPTION',
        priceCents,
        holderFirstName,
        holderLastName
      });
      tickets.push({
        seatId: seatIdForTickets,
        zoneKey: zoneForTicket,
      tariff: 'ABONNÉ',
        hex: hexZone(event._id, zoneForTicket || fallbackZoneUpper, order._id || pseudoOrderId, seatIdForTickets),
        fallback: true,
        note
      });
    }
  }

  if (!lines.length) {
    console.warn(`⚠️  Order ${order._id} sans lignes exploitables (skip)`);
    return 'skip';
  }

  const orderGroupKey = String(order.groupKey || '');
  const virtualOrder = {
    _id: order._id || pseudoOrderId,
    mailTemplateKind: 'event',
    lines,
    seasonCode: event.seasonCode,
    venueSlug: event.venueSlug,
    groupKey: orderGroupKey,
    payerFirstName: order.payerFirstName || order.payer?.firstName || '',
    payerLastName:  order.payerLastName  || order.payer?.lastName  || '',
    payerEmail:     order.payerEmail     || order.payer?.email     || '',
    meta: {
      provider: 'season',
      eventId: String(event._id),
      eventSlug: event.slug,
      eventName: event.name,
      eventStartsAt: event.startsAt,
      tickets
    }
  };

  const hasFallback = tickets.some(t => t.fallback);
  const fallbackMsg = hasFallback
    ? `<p style="margin:.75rem 0;background:#FFF6E5;border:1px solid #F6C15C;padding:12px;border-radius:8px">
         <strong>Note :</strong> certaines places donnent accès à une zone libre (aucun siège numéroté). Présentez-vous à l’entrée pour être orienté.
       </p>`
    : '';

  const defaultSubject = `Vos billets — ${event.name} — ${fmtDateFR(event.startsAt)}`;
  const subject = subjectForOrder(virtualOrder) || defaultSubject;

  let html;
  try {
    html = await renderOrderEmail(virtualOrder);
  } catch {
    html = '';
  }

  if (!html) {
    html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
        <h2 style="margin:0 0 .5rem">Billets pour ${event.name}</h2>
        <p style="margin:.25rem 0;color:#444">
          Date : <strong>${fmtDateFR(event.startsAt)}</strong>
        </p>
        ${fallbackMsg}
        <p style="margin:.75rem 0">
          Retrouvez vos billets en pièce jointe (PDF). Présentez le QR à l'entrée.
        </p>
        <p style="margin:.75rem 0;color:#666">
          Cet envoi concerne votre abonnement (${virtualOrder.payerFirstName || ''} ${virtualOrder.payerLastName || ''}).
        </p>
      </div>`;
  } else if (fallbackMsg) {
    if (html.includes('<!--FALLBACK_NOTE-->')) {
      html = html.replace('<!--FALLBACK_NOTE-->', fallbackMsg);
    } else if (html.includes('</h2>')) {
      html = html.replace('</h2>', `</h2>${fallbackMsg}`);
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', `${fallbackMsg}</body>`);
    } else {
      html = fallbackMsg + html;
    }
  }

  if (dryRun) {
    console.log(`[dry-run] order=${order._id} email=${virtualOrder.payerEmail} lines=${lines.length} fallback=${hasFallback}`);
    return 'ok';
  }

  try {
    const pdf = await buildTicketsPdfBuffer(virtualOrder);
    if (!pdf || !pdf.length) {
      console.warn(`[warn] PDF vide pour ${order._id}`);
      return 'skip';
    }

    await sendMail({
      to: virtualOrder.payerEmail,
      subject,
      html,
      attachments: [{
        filename: `Billets_${event.slug}_${String(order._id).slice(-6)}.pdf`,
        contentType: 'application/pdf',
        content: pdf
      }]
    });
    return 'ok';
  } catch (err) {
    console.error('[error] envoi impossible pour', String(order._id), err?.message || err);
    return 'error';
  }
}

main();
