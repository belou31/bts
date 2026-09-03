// src/services/exports.js
import { Order }  from '../models/Order.js';
import { Seat }   from '../models/Seat.js';
import { Ticket } from '../models/Ticket.js';
import { Event }  from '../models/Event.js';
import { Tariff } from '../models/Tariff.js';
import { isZoneUnit, resolveUnitType } from '../utils/seat-id.js';

const csvEscape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};

const normalizeTariffCode = (value) => String(value || '').trim().toUpperCase();

function chooseTariffForEvent(tariffDocs = [], eventDoc = null) {
  if (!Array.isArray(tariffDocs) || !tariffDocs.length) return null;

  const priceTableKey = eventDoc?.priceTableKey ? String(eventDoc.priceTableKey) : null;
  if (priceTableKey) {
    const fromPriceTable = tariffDocs.find((doc) => String(doc?.priceTableKey || '') === priceTableKey);
    if (fromPriceTable) return fromPriceTable;
  }

  if (eventDoc?.seasonCode && eventDoc?.venueSlug) {
    const season = String(eventDoc.seasonCode || '').toLowerCase();
    const venue = String(eventDoc.venueSlug || '').toLowerCase();
    const fromSeasonVenue = tariffDocs.find((doc) =>
      String(doc?.seasonCode || '').toLowerCase() === season &&
      String(doc?.venueSlug || '').toLowerCase() === venue
    );
    if (fromSeasonVenue) return fromSeasonVenue;
  }

  const globalTariff = tariffDocs.find((doc) => !doc?.priceTableKey);
  return globalTariff || tariffDocs[0] || null;
}

function normalizeRequiresField(value) {
  if (value === false || value == null) return null;
  const txt = String(value).trim();
  if (!txt) return null;
  const lowered = txt.toLowerCase();
  if (lowered === 'false' || lowered === '0' || lowered === 'no' || lowered === 'non' || lowered === 'null') {
    return null;
  }
  return txt;
}

function resolveRequiresValue(line = null, metaTicket = null) {
  for (const raw of [
    line?.justif,
    line?.justificationField,
    metaTicket?.note,
    line?.info,
    metaTicket?.info
  ]) {
    const txt = String(raw ?? '').trim();
    if (txt) return txt;
  }
  return '';
}

function formatRequiresField({ requiresField, fieldLabel, value }) {
  const fieldKey = normalizeRequiresField(requiresField);
  if (!fieldKey) return '';
  const label = String(fieldLabel || '').trim() || fieldKey;
  return `${label}=${String(value ?? '').trim()}`;
}

function resolveOrderLineMetaForTicket(ticket = null, orderDoc = null) {
  if (!ticket || !orderDoc) return { line: null, metaTicket: null };
  const lines = Array.isArray(orderDoc.lines) ? orderDoc.lines : [];
  const metaTickets = Array.isArray(orderDoc?.meta?.tickets) ? orderDoc.meta.tickets : [];

  const qrValue = String(ticket?.qr?.value || '').trim();
  if (qrValue && metaTickets.length) {
    const idx = metaTickets.findIndex((metaTicket) => String(metaTicket?.hex || metaTicket?.value || '').trim() === qrValue);
    if (idx >= 0) {
      return { line: lines[idx] || null, metaTicket: metaTickets[idx] || null };
    }
  }

  const seatId = String(ticket?.seatId || '').trim();
  const ticketTariffCode = normalizeTariffCode(ticket?.tariffCode);
  if (seatId && lines.length) {
    let fallbackIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] || {};
      if (String(line?.seatId || '').trim() !== seatId) continue;
      const lineTariffCode = normalizeTariffCode(line?.tariffCode);
      if (ticketTariffCode && lineTariffCode && lineTariffCode !== ticketTariffCode) {
        if (fallbackIdx < 0) fallbackIdx = i;
        continue;
      }
      return { line: lines[i] || null, metaTicket: metaTickets[i] || null };
    }
    if (fallbackIdx >= 0) {
      return { line: lines[fallbackIdx] || null, metaTicket: metaTickets[fallbackIdx] || null };
    }
  }

  if (ticketTariffCode && lines.length) {
    const idx = lines.findIndex((line) => normalizeTariffCode(line?.tariffCode) === ticketTariffCode);
    if (idx >= 0) return { line: lines[idx] || null, metaTicket: metaTickets[idx] || null };
  }

  return { line: null, metaTicket: null };
}

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
      'checkoutReference','providerOrderId','transactionCode','transactionId',
      'providerStatusApi','providerStatusWebhook','providerStatusReturn','providerStatusCheckedAt','paidConfirmedAt','forcedFinalize',
    'lineIndex','seatId','zoneKey','tariffCode','priceCents','holderFirstName','holderLastName',
    'justif','justificationField','info'
  ].join(',');
  if (includeHeader) out.write(header + '\n');

  const q = { ...(filter || {}) };
  const cursor = Order.find(q).sort({ createdAt: 1 }).lean().cursor();

  for await (const o of cursor) {
    // ⚠️ Garder un TABLEAU jusqu'au join final (sinon toute la base devient une seule cellule)
    const baseFields = [
      o._id,
      o.createdAt?.toISOString?.() || '',
      // The Order model has no top-level `phase` field (strict:true, only
      // `origin.flow` exists) — `o.phase` was always undefined here.
      o.origin?.flow || '',
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
      o.paymentProviderMeta?.attestationSentAt ? new Date(o.paymentProviderMeta.attestationSentAt).toISOString() : '',
      // Clés de rapprochement avec le relevé du prestataire. checkoutReference
      // (`bts-<orderId>`) est la seule qui porte l'identifiant BTS ; les autres
      // sont les identifiants côté prestataire.
      o.paymentProviderMeta?.checkoutReference || '',
      o.paymentProviderMeta?.providerOrderId || o.paymentProviderMeta?.haOrderId || '',
      o.paymentProviderMeta?.transactionCode || '',
      o.paymentProviderMeta?.transactionId || '',
      // Statut renvoyé par le prestataire, par canal : API (polling /pay/status
      // ou check-order-payment), webhook, page de retour. C'est cette valeur —
      // et non `status` — qui dit ce que SumUp/HelloAsso a réellement répondu.
      o.paymentProviderMeta?.lastStatusFromApi || '',
      o.paymentProviderMeta?.lastWebhookStatus || '',
      o.paymentProviderMeta?.lastStatusFromReturn || o.paymentProviderMeta?.lastReturnProviderStatus || '',
      o.paymentProviderMeta?.lastStatusCheckedAt ? new Date(o.paymentProviderMeta.lastStatusCheckedAt).toISOString() : '',
      o.paymentProviderMeta?.lastSuccessfulFinalizeAt ? new Date(o.paymentProviderMeta.lastSuccessfulFinalizeAt).toISOString() : '',
      o.paymentProviderMeta?.forcedFinalize ? 'yes' : ''
    ];

    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (!lines.length) {
      // 10 colonnes ligne: lineIndex..info → valeurs vides
      const rowFields = [...baseFields, 0, '', '', '', 0, '', '', '', '', ''];
      out.write(rowFields.map(csvEscape).join(',') + '\n');

      continue;
    }
    let j = 0;
    for (const l of lines) {
      const rowFields = [
        ...baseFields,
        j,
        l.seatId || '',
        l.zoneKey || '',
        l.tariffCode || '',
        l.priceCents || 0,
        l.holderFirstName || '',
        l.holderLastName  || '',
        l.justif || '',
        l.justificationField || '',
        l.info || ''
      ];
      out.write(rowFields.map(csvEscape).join(',') + '\n');

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

/**
 * Exporte les billets d’un évènement en CSV vers un Writable.
 * Inclut les informations QR et l’état de scan.
 * @param {Object} opts
 * @param {import('stream').Writable} opts.out
 * @param {string|Object} [opts.eventId]         // ObjectId string attendu dans Ticket.eventId
 * @param {string}        [opts.eventSlug]       // Peut remplacer eventId (résolution automatique)
 * @param {Object}        [opts.event]           // Document évènement déjà chargé (lean ou mongoose doc)
 * @param {boolean}       [opts.includeHeader=true]
 * @param {boolean}       [opts.includeScanHistory=false] // Ajoute la colonne scanHistory (pipe-separated)
 */
export async function exportEventTicketsCsv({
  out,
  eventId,
  eventSlug,
  event,
  includeHeader = true,
  includeScanHistory = false
} = {}) {
  if (!out || typeof out.write !== 'function') {
    throw new Error('exportEventTicketsCsv: writable "out" stream requis');
  }

  let resolvedEvent = event || null;
  let matchEventId = eventId ? String(eventId) : '';

  if (!matchEventId && eventSlug) {
    resolvedEvent = await Event.findOne({ slug: eventSlug }).lean();
    if (!resolvedEvent) {
      throw new Error(`exportEventTicketsCsv: event introuvable pour le slug "${eventSlug}"`);
    }
    matchEventId = String(resolvedEvent._id);
  }

  if (resolvedEvent && !matchEventId && resolvedEvent._id) {
    matchEventId = String(resolvedEvent._id);
  }

  if (!matchEventId) {
    throw new Error('exportEventTicketsCsv: fournir eventId (ObjectId string) ou eventSlug/event');
  }

  if (!resolvedEvent) {
    resolvedEvent = await Event.findById(matchEventId).lean().catch(() => null);
  }

  const header = [
    'ticketId',
    'orderId',
    'orderStatus',
    'orderPhase',
    'payerFirstName',
    'payerLastName',
    'payerEmail',
    'eventId',
    'eventSlug',
    'eventName',
    'eventStartsAt',
    'seasonCode',
    'venueSlug',
    'seatId',
    'zoneKey',
    'isVirtualSeat',
    'tariffCode',
    'requires',
    'holderFirstName',
    'holderLastName',
    'holderEmail',
    'qrValue',
    'qrKind',
    'qrCreatedAt',
    'qrBankId',
    'scanStatus',
    'scanCount',
    'scannedAt',
    'scannedBy',
    'lastScanAction',
    'lastScanAt',
    includeScanHistory ? 'scanHistory' : null,
    'createdAt',
    'updatedAt'
  ].filter(Boolean).join(',');

  if (includeHeader) out.write(header + '\n');

  const orderCache = new Map();
  const tariffCache = new Map();

  const loadTariff = async (codeRaw) => {
    const code = normalizeTariffCode(codeRaw);
    if (!code) return null;
    if (tariffCache.has(code)) return tariffCache.get(code);

    const docs = await Tariff.find({ code })
      .select('code label requiresField fieldLabel requiresInfo priceTableKey seasonCode venueSlug')
      .lean();
    const chosen = chooseTariffForEvent(docs, resolvedEvent || event || null) || null;
    tariffCache.set(code, chosen);
    return chosen;
  };

  const loadOrderMeta = async (orderIdRaw) => {
    if (!orderIdRaw) return null;
    const key = String(orderIdRaw);
    if (orderCache.has(key)) return orderCache.get(key);

    const orderDoc = await Order.findById(orderIdRaw)
      .select('_id status phase payerFirstName payerLastName payerEmail lines meta')
      .lean();
    orderCache.set(key, orderDoc || null);
    return orderDoc || null;
  };

  const zoneFromSeatId = (seatId) => {
    if (!seatId) return '';
    const parts = String(seatId).split('-');
    return parts.length ? String(parts[0] || '').toUpperCase() : '';
  };

  const eventSlugOut = resolvedEvent?.slug || eventSlug || '';
  const eventNameOut = resolvedEvent?.name || event?.name || '';
  const eventStartsAtOut = resolvedEvent?.startsAt
    ? new Date(resolvedEvent.startsAt).toISOString()
    : (event?.startsAt ? new Date(event.startsAt).toISOString() : '');

  const qrSeen = new Set();

  const cursor = Ticket.find({ eventId: matchEventId })
    .sort({ seatId: 1, _id: 1 })
    .lean()
    .cursor();

  for await (const ticket of cursor) {
    const orderMeta = await loadOrderMeta(ticket.orderId);
    const { line, metaTicket } = resolveOrderLineMetaForTicket(ticket, orderMeta);
    const holder = ticket.holder || {};
    const qr = ticket.qr || {};
    const tariffCode = normalizeTariffCode(ticket.tariffCode || line?.tariffCode || metaTicket?.tariff || metaTicket?.tariffCode);
    const tariffDoc = await loadTariff(tariffCode);
    const requiresValue = resolveRequiresValue(line, metaTicket);
    const requiresOut = formatRequiresField({
      requiresField: tariffDoc?.requiresField ?? metaTicket?.requiresField ?? null,
      fieldLabel: tariffDoc?.fieldLabel ?? metaTicket?.fieldLabel ?? '',
      value: requiresValue
    });

    const historyRaw = Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [];
    const history = historyRaw
      .map((entry) => ({
        when: entry?.when ? new Date(entry.when) : null,
        by: entry?.by || '',
        action: entry?.action || ''
      }))
      .sort((a, b) => {
        const at = a.when ? a.when.getTime() : 0;
        const bt = b.when ? b.when.getTime() : 0;
        return at - bt;
      });
    const lastHistory = history.length ? history[history.length - 1] : null;

    const scanCount = Number.isFinite(ticket.scanCount) ? ticket.scanCount : Number(ticket.scanCount) || 0;
    const scannedAtIso = ticket.scannedAt ? new Date(ticket.scannedAt).toISOString() : '';
    const lastAction = lastHistory?.action || '';
    const lastActionAt = lastHistory?.when ? lastHistory.when.toISOString() : (scannedAtIso || '');
    let scanStatus = 'not_scanned';
    if (scanCount > 0 || scannedAtIso) {
      if (lastAction === 'exit') {
        scanStatus = 'exit';
      } else if (scanCount > 1) {
        scanStatus = 'multi';
      } else if (lastAction === 'force') {
        scanStatus = 'forced';
      } else if (lastAction === 'auto') {
        scanStatus = 'auto';
      } else {
        scanStatus = 'scanned';
      }
    }

    const scanHistoryStr = includeScanHistory
      ? history.map(h => `${h.when ? h.when.toISOString() : ''}:${h.action}:${h.by}`).join('|')
      : '';

    const row = [
      csvEscape(ticket._id),
      csvEscape(ticket.orderId || ''),
      csvEscape(orderMeta?.status || ''),
      csvEscape(orderMeta?.phase || ''),
      csvEscape(orderMeta?.payerFirstName || ''),
      csvEscape(orderMeta?.payerLastName || ''),
      csvEscape(orderMeta?.payerEmail || ''),
      csvEscape(ticket.eventId || ''),
      csvEscape(eventSlugOut),
      csvEscape(eventNameOut),
      csvEscape(eventStartsAtOut),
      csvEscape(ticket.seasonCode || ''),
      csvEscape(ticket.venueSlug || ''),
      csvEscape(ticket.seatId || ''),
      csvEscape(zoneFromSeatId(ticket.seatId || '')),
      csvEscape(isZoneUnit({ unitType: ticket.unitType, seatId: ticket.seatId }) ? '1' : '0'),
      csvEscape(tariffCode),
      csvEscape(requiresOut),
      csvEscape(holder.firstName || ''),
      csvEscape(holder.lastName || ''),
      csvEscape(holder.email || ''),
      csvEscape(qr.value || ''),
      csvEscape(qr.kind || ''),
      csvEscape(qr.createdAt ? new Date(qr.createdAt).toISOString() : ''),
      csvEscape(qr.bankId || ''),
      csvEscape(scanStatus),
      csvEscape(scanCount),
      csvEscape(scannedAtIso),
      csvEscape(ticket.scannedBy || ''),
      csvEscape(lastAction),
      csvEscape(lastActionAt),
      includeScanHistory ? csvEscape(scanHistoryStr) : null,
      csvEscape(ticket.createdAt ? new Date(ticket.createdAt).toISOString() : ''),
      csvEscape(ticket.updatedAt ? new Date(ticket.updatedAt).toISOString() : '')
    ].filter(v => v !== null).join(',');

    out.write(row + '\n');
    if (qr.value) qrSeen.add(qr.value);
  }

  // Complement with meta tickets stored on orders but missing Ticket documents
  const extraOrders = await Order.find({ 'meta.eventId': matchEventId })
    .select('_id status phase payerFirstName payerLastName payerEmail seasonCode venueSlug lines meta createdAt updatedAt')
    .lean();

  for (const orderDoc of extraOrders) {
    const metaTickets = Array.isArray(orderDoc?.meta?.tickets) ? orderDoc.meta.tickets : [];
    if (!metaTickets.length) continue;
    const lines = Array.isArray(orderDoc.lines) ? orderDoc.lines : [];

    for (let i = 0; i < metaTickets.length; i++) {
      const metaTicket = metaTickets[i] || {};
      const qrValue = String(metaTicket.hex || metaTicket.value || '').trim();
      if (!qrValue || qrSeen.has(qrValue)) continue;

      const line = lines[i] || {};
      const zoneRaw = String(metaTicket.zoneKey || line.zoneKey || '').trim().toUpperCase();
      const holderFirst = String(
        line.holderFirstName ||
        metaTicket.holderFirstName ||
        metaTicket.holder?.firstName ||
        ''
      ).trim();
      const holderLast = String(
        line.holderLastName ||
        metaTicket.holderLastName ||
        metaTicket.holder?.lastName ||
        ''
      ).trim();
      const holderEmail = String(
        line.holderEmail ||
        metaTicket.holderEmail ||
        metaTicket.holder?.email ||
        orderDoc.payerEmail ||
        ''
      ).trim();
      const seatCandidate = String(metaTicket.seatId || line.seatId || '').trim();
      const fallbackSeat = (() => {
        const zone = zoneRaw || 'ZONE';
        const suffix = String(orderDoc._id || '').slice(-6).toUpperCase();
        const index = String(i + 1).padStart(2, '0');
        return `${zone}-GA-${suffix}-${index}`;
      })();
      const seatId = seatCandidate || fallbackSeat;
      const unitType = resolveUnitType({ unitType: line.unitType, seatId: seatCandidate });
      const tariffCode = normalizeTariffCode(line.tariffCode || metaTicket.tariff || metaTicket.tariffCode);
      const createdAtOut = metaTicket.createdAt ? new Date(metaTicket.createdAt).toISOString()
        : (orderDoc.createdAt ? new Date(orderDoc.createdAt).toISOString() : '');
      const updatedAtOut = orderDoc.updatedAt ? new Date(orderDoc.updatedAt).toISOString() : createdAtOut;
      const qrKindOut = String(metaTicket.kind || 'text');
      const bankIdOut = metaTicket.bankId ? String(metaTicket.bankId) : '';
      const tariffDoc = await loadTariff(tariffCode);
      const requiresOut = formatRequiresField({
        requiresField: tariffDoc?.requiresField ?? metaTicket?.requiresField ?? null,
        fieldLabel: tariffDoc?.fieldLabel ?? metaTicket?.fieldLabel ?? '',
        value: resolveRequiresValue(line, metaTicket)
      });

      const row = [
        csvEscape(metaTicket.ticketId || ''),
        csvEscape(orderDoc._id || ''),
        csvEscape(orderDoc.status || ''),
        csvEscape(orderDoc.phase || ''),
        csvEscape(orderDoc.payerFirstName || ''),
        csvEscape(orderDoc.payerLastName || ''),
        csvEscape(orderDoc.payerEmail || ''),
        csvEscape(matchEventId),
        csvEscape(eventSlugOut),
        csvEscape(eventNameOut),
        csvEscape(eventStartsAtOut),
        csvEscape(orderDoc.seasonCode || ''),
        csvEscape(orderDoc.venueSlug || ''),
        csvEscape(seatId),
        csvEscape(zoneFromSeatId(seatId)),
        csvEscape(unitType === 'zone' ? '1' : '0'),
        csvEscape(tariffCode),
        csvEscape(requiresOut),
        csvEscape(holderFirst),
        csvEscape(holderLast),
        csvEscape(holderEmail),
        csvEscape(qrValue),
        csvEscape(qrKindOut),
        csvEscape(createdAtOut),
        csvEscape(bankIdOut),
        csvEscape('not_scanned'),
        csvEscape(0),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        includeScanHistory ? csvEscape('') : null,
        csvEscape(createdAtOut),
        csvEscape(updatedAtOut)
      ].filter(v => v !== null).join(',');

      out.write(row + '\n');
      qrSeen.add(qrValue);
    }
  }
}
