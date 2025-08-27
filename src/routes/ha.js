// src/routes/ha.js
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Order, Seat, Tariff } from '../models/index.js';
import { createCheckoutIntent } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TEMPLATE_PATH = path.resolve(__dirname, '../templates/email/renew-confirmation.html');

function seasonVenueFilter({ seasonCode, venueSlug }) {
  const season = String(seasonCode || '').trim();
  const venue  = String(venueSlug  || '').trim();
  const clauses = [];
  if (season && venue) {
    clauses.push(
      { seasonCode: season, venueSlug: venue },
      { seasonCode: season, venue: venue },
      { season: season,     venueSlug: venue },
      { season: season,     venue: venue },
    );
  } else if (season) {
    clauses.push({ seasonCode: season }, { season: season });
  } else if (venue) {
    clauses.push({ venueSlug: venue }, { venue: venue });
  }
  return clauses.length ? { $or: clauses } : {};
}

function extractDisplayName(fromEmailEnv) {
  // ex: FROM_EMAIL="Billetterie des Bélougas <billetterie@tbhc.fr>"
  const m = String(fromEmailEnv || '').match(/"([^"]+)"/);
  return (m && m[1]) || 'Billetterie des Bélougas';
}

async function renderConfirmationEmail({ order, lines, tariffMap }) {
  const tpl = await fs.readFile(TEMPLATE_PATH, 'utf8');
  const clubName = extractDisplayName(process.env.FROM_EMAIL);
  const totalEuros = (Number(order.totalCents || 0) / 100).toFixed(2);

  // Construit le <tr>…</tr> pour chaque ligne
  const rowsHtml = lines.map(l => {
    const label = tariffMap.get(String(l.tariffCode || '').toUpperCase()) || String(l.tariffCode || '');
    const conds = [
      l.justificationField ? `Justif.: ${l.justificationField}` : null,
      l.info ? `Info: ${l.info}` : null
    ].filter(Boolean).join(' — ');
    const price = (Number(l.priceCents || 0) / 100).toFixed(2) + ' €';
    return `<tr>
      <td>${l.seatId || ''}</td>
      <td>${l.holderLastName || ''}</td>
      <td>${l.holderFirstName || ''}</td>
      <td>${label}</td>
      <td>${conds || '-'}</td>
      <td>${price}</td>
    </tr>`;
  }).join('\n');

  let html = tpl
    .replaceAll('{{clubName}}', clubName)
    .replaceAll('{{orderId}}', String(order._id))
    .replaceAll('{{payerFirstName}}', order.payerFirstName || '')
    .replaceAll('{{payerLastName}}',  order.payerLastName  || '')
    .replaceAll('{{payerEmail}}',     order.payerEmail     || '')
    .replaceAll('{{seasonCode}}',     order.seasonCode     || '')
    .replaceAll('{{paymentSplit}}',   String(order.paymentSplit || 1))
    .replaceAll('{{totalEuros}}',     totalEuros)
    .replace('{{LINES}}', rowsHtml);

  // Version texte simple
  const textLines = lines.map(l => {
    const label = tariffMap.get(String(l.tariffCode || '').toUpperCase()) || String(l.tariffCode || '');
    const price = (Number(l.priceCents || 0) / 100).toFixed(2) + ' €';
    const extra = [l.justificationField, l.info].filter(Boolean).join(' | ');
    return `- ${l.seatId} — ${l.holderLastName} ${l.holderFirstName} — ${label} — ${price}${extra ? ' — ' + extra : ''}`;
  }).join('\n');

  const text =
`Confirmation de paiement — ${clubName}
Commande ${order._id}
Saison ${order.seasonCode}
Payer: ${order.payerFirstName || ''} ${order.payerLastName || ''} <${order.payerEmail || ''}>
Montant: ${totalEuros} € — Échéancier: ${order.paymentSplit || 1} fois

Places:
${textLines}

Les billets avec QR code seront envoyés par email avant chaque match.`;

  return { html, text, subject: `Confirmation de paiement — ${order.seasonCode} — ${clubName}` };
}

/**
 * GET /ha/return
 * Query: ?oid=<orderId>&ci=<intentId> (&stub=1&result=success|failure)
 */
router.get('/ha/return', async (req, res) => {
  try {
    const { oid, ci, stub, result } = req.query;
    const order = await Order.findById(oid);
    if (!order) return res.status(404).send('Order not found');

    // Idempotence
    if (/paid|authorized/i.test(order.status)) {
      return res.send(`<h1>Paiement déjà confirmé ✅</h1><p>Commande ${order._id}</p>`);
    }

    let status;
    if (stub === '1' || result) {
      status = (String(result || 'success').toLowerCase() === 'success') ? 'Paid' : 'Failed';
    } else {
      status = await getCheckoutStatus(ci);
    }

    if (/paid|authorized|ok|success/i.test(status)) {
      // 1) Marquer payée
      order.status = 'paid';
      await order.save();

      // 2) MAJ sièges
      const baseFilter = seasonVenueFilter({ seasonCode: order.seasonCode, venueSlug: order.venueSlug });
      const ops = [];
      for (const l of (order.lines || [])) {
        ops.push({
          updateOne: {
            filter: { ...baseFilter, seatId: l.seatId },
            update: {
              $set: {
                status: 'sold',
                provisionedFor: null,
                holderFirstName: l.holderFirstName || '',
                holderLastName:  l.holderLastName  || '',
                lastTariffCode:  (l.tariffCode || null)
              }
            }
          }
        });
      }
      if (ops.length) await Seat.bulkWrite(ops, { ordered: false });

      // 3) Email HTML basé sur template
      //    - on récupère les libellés de tarifs (fallback code)
      const tariffs = await Tariff.find({}, { code:1, label:1 }).lean();
      const tariffMap = new Map((tariffs||[]).map(t => [String(t.code||'').toUpperCase(), t.label || String(t.code||'')]));

      // enrichir order avec nom/prénom payeur (si reçus lors du POST /s/renew)
      // (optionnel : si ton modèle Order n’a pas ces champs, tu peux les ajouter)
      order.payerFirstName = order.payerFirstName || req.query.pfn || '';
      order.payerLastName  = order.payerLastName  || req.query.pln || '';

      const { html, text, subject } = await renderConfirmationEmail({
        order,
        lines: order.lines || [],
        tariffMap
      });

      try {
        await sendMail({
          to: order.payerEmail,
          subject,
          text,
          html
        });
      } catch (e) {
        console.warn('sendMail failed:', e.message);
      }

      return res.send(`<h1>Paiement confirmé ✅</h1><p>Commande ${order._id}</p>`);
    } else {
      order.status = 'failed';
      await order.save();
      return res.send(`<h1>Paiement non confirmé ❌</h1><p>Commande ${order._id} — statut: ${status}</p>`);
    }
  } catch (e) {
    console.error('/ha/return error', e);
    res.status(500).send('Erreur interne');
  }
});

router.get('/ha/back', (_req, res) => {
  res.send('<h1>Paiement abandonné</h1><p>Vous pouvez reprendre votre commande ultérieurement.</p>');
});

router.get('/ha/error', (_req, res) => {
  res.status(400).send('<h1>Erreur de paiement</h1><p>Une erreur est survenue. Réessayez plus tard.</p>');
});

export default router;
