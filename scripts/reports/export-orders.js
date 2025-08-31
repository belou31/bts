// src/reports/export-orders.js
import { Order } from '../models/index.js';

/**
 * Exporte les commandes en CSV (1 ligne par "line" d'une commande).
 *
 * @param {Object} opts
 * @param {Date|String} [opts.from]         - Début d'intervalle (createdAt >=)
 * @param {Date|String} [opts.to]           - Fin d'intervalle   (createdAt <=)
 * @param {String}      [opts.status]       - Filtre status ('paid','completed', etc.)
 * @param {String}      [opts.seasonCode]   - Filtre saison
 * @param {String}      [opts.venueSlug]    - Filtre lieu
 * @param {Boolean}     [opts.onlyPaid=true]- Si true et !status, force paid/completed
 * @returns {Promise<string>}               - Contenu CSV
 */
export async function exportOrdersToCsv(opts = {}) {
  const {
    from,
    to,
    status,
    seasonCode,
    venueSlug,
    onlyPaid = true,
  } = opts;

  const q = {};
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to)   q.createdAt.$lte = new Date(to);
  }
  if (seasonCode) q.seasonCode = seasonCode;
  if (venueSlug)  q.venueSlug  = venueSlug;
  if (status)     q.status     = status;
  else if (onlyPaid) q.status  = { $in: ['paid', 'completed'] };

  const orders = await Order.find(q).sort({ createdAt: 1 }).lean();

  const rows = [];
  for (const o of orders) {
    const base = {
      orderId:            o._id ?? '',
      orderNo:            o.orderNo ?? '',                 // si présent
      createdAt:          o.createdAt ? new Date(o.createdAt).toISOString() : '',
      status:             o.status ?? '',
      seasonCode:         o.seasonCode ?? '',
      venueSlug:          o.venueSlug ?? '',
      payerFirstName:     o.payerFirstName ?? '',
      payerLastName:      o.payerLastName ?? '',
      payerEmail:         o.payerEmail ?? '',
      installments:       o.installments ?? '',
      totalCents:         o.totalCents ?? '',
      haOrderId:          o.paymentProvider?.haOrderId ?? o.haPaymentRef ?? '',
      checkoutIntentId:   o.paymentProvider?.checkoutIntentId ?? o.checkoutIntentId ?? '',
    };

    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (!lines.length) {
      // ligne "commande" seule si pas de détail
      rows.push({
        ...base,
        seatId: '', zoneKey: '', tariffCode: '',
        priceCents: '', justification: '', info: ''
      });
      continue;
    }

    for (const ln of lines) {
      rows.push({
        ...base,
        seatId:        ln.seatId ?? '',
        zoneKey:       ln.zoneKey ?? '',
        tariffCode:    ln.tariffCode ?? '',
        priceCents:    ln.priceCents ?? '',
        justification: ln.justification ?? '',
        info:          ln.info ?? '',
      });
    }
  }

  // CSV
  const headers = [
    'orderId','orderNo','createdAt','status','seasonCode','venueSlug',
    'payerFirstName','payerLastName','payerEmail',
    'installments','totalCents','haOrderId','checkoutIntentId',
    'seatId','zoneKey','tariffCode','priceCents','justification','info'
  ];

  const esc = (v) => {
    const s = String(v ?? '');
    return `"${s.replace(/"/g, '""')}"`;
    // toujours delimiter par " pour simplicité
  };

  const lines = [
    headers.join(','), // header
    ...rows.map(r => headers.map(h => esc(r[h])).join(','))
  ];

  return lines.join('\n');
}

export default { exportOrdersToCsv };
