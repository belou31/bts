// src/services/exports.js
import { Order } from '../models/Order.js';
import { Seat }  from '../models/Seat.js';

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};

const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));

/**
 * Exporte les commandes en CSV vers un Writable (res, process.stdout, …)
 * @param {Object} opts
 * @param {import('stream').Writable} opts.out
 * @param {Object} [opts.filter]     // ex: { seasonCode, venueSlug, status }
 * @param {boolean} [opts.includeHeader=true]
 */
export async function exportOrdersCsv({ out, filter = {}, includeHeader = true } = {}) {
  const header = [
    'orderId','createdAt','phase','status',
    'payerFirstName','payerLastName','payerEmail',
    'seasonCode','venueSlug','paymentSplit','totalCents',
    'providerName','haOrderId','checkoutIntentId','lastReturnCode','lastWebhookEvent','attestationSentAt',
    'lineIndex','seatId','zoneKey','tariffCode','priceCents','holderFirstName','holderLastName'
  ].join(',');
  if (includeHeader) out.write(header + '\n');

  const q = { ...(filter || {}) };
  const cursor = Order.find(q).sort({ createdAt: 1 }).lean().cursor();

  for await (const o of cursor) {
    const base = [
      o._id,
      o.createdAt?.toISOString?.() || '',
      o.phase || '',
      o.status || '',
      o.payerFirstName || '',
      o.payerLastName  || '',
      o.payerEmail     || '',
      o.seasonCode || '',
      o.venueSlug  || '',
      o.paymentSplit || '',
      o.totalCents || 0,
      o.paymentProviderMeta?.name || o.paymentProvider || '',
      o.paymentProviderMeta?.haOrderId || '',
      o.paymentProviderMeta?.checkoutIntentId || '',
      o.paymentProviderMeta?.lastReturnCode || '',
      o.paymentProviderMeta?.lastWebhookEvent || '',
      o.paymentProviderMeta?.attestationSentAt ? new Date(o.paymentProviderMeta.attestationSentAt).toISOString() : ''
    ].map(csvEscape).join(',');

    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (!lines.length) {
      // 7 colonnes ligne: lineIndex..holderLastName
      out.write(base + ',' + ['','','','','','',''].join(',') + '\n');
      continue;
    }
    let j = 0;
    for (const l of lines) {
      const row = [
        base,
        j,
        l.seatId || '',
        l.zoneKey || '',
        l.tariffCode || '',
        l.priceCents || 0,
        l.holderFirstName || '',
        l.holderLastName  || ''
      ].map(csvEscape).join(',');
      out.write(row + '\n');
      j++;
    }
  }
}

/**
 * Exporte les sièges en CSV vers un Writable.
 * Enrichi avec tags/note de provision et, si réservé, info commande (paid).
 * @param {Object} opts
 * @param {import('stream').Writable} opts.out
 * @param {Object} [opts.filterSeat]   // ex: { zoneKey, seasonCode, venueSlug }
 * @param {Object} [opts.filterOrder]  // ex: { seasonCode, venueSlug }
 * @param {boolean} [opts.includeHeader=true]
 */
export async function exportSeatsCsv({ out, filterSeat = {}, filterOrder = {}, includeHeader = true } = {}) {
  const header = [
    'seatId','zoneKey','row','num','status',
    'provisionTags','provisionNote',
    'reservedByOrderId','reservedAt','reservedPhase','reservedPayer','reservedEmail','reservedTariff','reservedPriceCents'
  ].join(',');
  if (includeHeader) out.write(header + '\n');

  // Map seatId -> dernière ligne d’un order "paid"
  const matchOrder = { status: 'paid', ...(filterOrder || {}) };
  const booked = await Order.aggregate([
    { $match: matchOrder },
    { $sort: { createdAt: -1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.seatId': { $ne: null } } },
    { $group: {
      _id: '$lines.seatId',
      orderId: { $first: '$_id' },
      createdAt: { $first: '$createdAt' },
      phase: { $first: '$phase' },
      payerFirstName: { $first: '$payerFirstName' },
      payerLastName:  { $first: '$payerLastName'  },
      payerEmail:     { $first: '$payerEmail'     },
      tariffCode:     { $first: '$lines.tariffCode' },
      priceCents:     { $first: '$lines.priceCents' }
    } }
  ]);
  const bookedMap = new Map(booked.map(x => [String(x._id), x]));

  const seatQ = { ...(filterSeat || {}) };
  const cursor = Seat.find(seatQ).sort({ zoneKey:1, row:1, num:1, seatId:1 }).lean().cursor();
  for await (const s of cursor) {
    const meta = s.meta || {};
    const tags = Array.isArray(meta.provisionTags) ? meta.provisionTags.join('|') : '';
    const note = meta.provisionNote || '';
    const b = bookedMap.get(String(s.seatId));

    const row = [
      s.seatId || '', s.zoneKey || '', s.row || '', s.num || '', s.status || '',
      tags, note,
      b?.orderId || '',
      b?.createdAt?.toISOString?.() || '',
      b?.phase || '',
      (b ? `${b.payerFirstName||''} ${b.payerLastName||''}`.trim() : ''),
      b?.payerEmail || '',
      b?.tariffCode || '',
      b?.priceCents || 0
    ].map(csvEscape).join(',');
    out.write(row + '\n');
  }
}
