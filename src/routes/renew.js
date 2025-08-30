// src/routes/renew.js
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Subscriber }  from '../models/Subscriber.js';
import { Seat }        from '../models/Seat.js';
import { Tariff }      from '../models/Tariff.js';
import { TariffPrice } from '../models/TariffPrice.js';
import { Order }       from '../models/Order.js';
import { createCheckoutIntent } from '../services/helloasso.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = process.env.APP_URL || '';
const HELLOASSO_STUB = String(process.env.HELLOASSO_STUB || 'false').toLowerCase() === 'true';
const STUB_RESULT = (process.env.HELLOASSO_STUB_RESULT || 'success').toLowerCase();

const HA_RETURN_URL = process.env.HELLOASSO_RETURN_URL || (APP_URL ? `${APP_URL}/ha/return` : '/ha/return');
const HA_BACK_URL   = HA_RETURN_URL.replace(/\/ha\/return(?:\/)?$/, '/ha/back');
const HA_ERR_URL    = HA_RETURN_URL.replace(/\/ha\/return(?:\/)?$/, '/ha/error');

function zoneKeyFromSeatId(seatId) {
  const s = String(seatId || '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}
function decodeToken(id) {
  if (!JWT_SECRET) { console.error('[renew] JWT_SECRET manquant'); return null; }
  if (!id || id === 'ping') return null;
  try {
    const p = jwt.verify(id, JWT_SECRET);
    return {
      seasonCode: p.seasonCode || p.season,
      venueSlug : p.venueSlug  || p.venue,
      email     : (p.email || '').trim(),
      groupKey  : p.groupKey || p.email || null,
      seatIds   : Array.isArray(p.seatIds) ? p.seatIds.map(x => String(x).trim()) : [],
    };
  } catch (e) {
    console.error('[renew] jwt.verify failed:', e.message);
    return null;
  }
}
function hashToken(id) {
  return crypto.createHash('sha256').update(String(id || ''), 'utf8').digest('hex');
}
function buildPricesIndex(prices) {
  const idx = new Map();
  for (const p of (prices || [])) {
    const z = p.zoneKey;
    const t = String(p.tariffCode || '').toUpperCase();
    if (!idx.has(z)) idx.set(z, new Map());
    idx.get(z).set(t, Number(p.priceCents) || 0);
  }
  return idx;
}


async function findNotProvisionedSeats({ seasonCode, venueSlug, seatIds }) {
  if (!seatIds?.length) return [];
  const rows = await Seat.find(
    { seasonCode, venueSlug, seatId: { $in: seatIds } },
    { seatId: 1, status: 1, _id: 0 }
  ).lean();
  return rows.filter(r => String(r.status) !== 'provisioned');
}


function computePriceCents(pricesIdx, zoneKey, tariffCode) {
  const t = String(tariffCode || '').toUpperCase();
  const zMap = pricesIdx.get(zoneKey);
  if (zMap && zMap.has(t)) return zMap.get(t);
  const star = pricesIdx.get('*');
  if (star && star.has(t)) return star.get(t);
  return 0;
}


/** GET /s/renew?id=<jwt> -> JSON */
router.get('/renew', async (req, res) => {
  try {
    const { id } = req.query;
    if (id === 'ping') return res.json({ ok: true, route: '/s/renew', ts: new Date().toISOString() });

    const tok = decodeToken(id);
    if (!tok || !tok.seasonCode || !tok.venueSlug || !tok.seatIds?.length) {
      return res.status(400).json({ error: 'missing_or_invalid_token' });
    }
    const { seasonCode, venueSlug, seatIds } = tok;

    const [tariffs, prices] = await Promise.all([
      Tariff.find({}).lean().exec(),
      TariffPrice.find({ seasonCode, venueSlug }).lean().exec(),
    ]);

    const seats = await Seat.find({
      seasonCode, venueSlug, seatId: { $in: seatIds },
    }).lean().exec();

    const subs = await Subscriber.find({
      seasonCode,
      $or: [
        { prefSeatId: { $in: seatIds } },
        { previousSeasonSeats: { $in: seatIds } },
      ],
    }).lean().exec();

    const seatSubscribers = {};
    for (const sid of seatIds) {
      let rec = subs.find(s => String(s.prefSeatId || '').trim() === sid);
      if (!rec) rec = subs.find(s => Array.isArray(s.previousSeasonSeats) && s.previousSeasonSeats.includes(sid));
      if (rec) {
        seatSubscribers[sid] = {
          firstName: rec.firstName || '',
          lastName : rec.lastName  || '',
          email    : rec.email     || '',
        };
      }
    }

    const tokenEmail = (tok.email || '').toLowerCase();
    let payer = { firstName:'', lastName:'', email: tok.email || '' };
    if (subs.length) {
      const match = tokenEmail ? subs.find(s => (s.email || '').toLowerCase() === tokenEmail) : null;
      const pick = match || subs[0];
      payer.firstName = payer.firstName || pick.firstName || '';
      payer.lastName  = payer.lastName  || pick.lastName  || '';
      payer.email     = payer.email     || pick.email     || '';
    }



// tokenSeats contient les sièges autorisés par le lien
const blocked = await findNotProvisionedSeats({
  seasonCode, venueSlug, seatIds: seatIds
});

// expose au front
const blockedSeats = blocked.map(b => ({ seatId: b.seatId, status: b.status }));
const blockedAny = blockedSeats.length > 0;




    return res.json({
      ok: true,
      season: seasonCode, seasonCode,
      venue : venueSlug,  venueSlug,
      tariffs, prices, seats,
      tokenSeats: seatIds,
      seatSubscribers,
      payer,
      blockedAny,
      blockedSeats
    });
  } catch (e) {
    console.error('[GET /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** POST /s/renew?id=<jwt> -> { redirectUrl } */
router.post('/renew', async (req, res) => {
  try {
    const id = req.query.id || '';
    const tok = decodeToken(id);
    if (!tok || !tok.seasonCode || !tok.venueSlug || !tok.seatIds?.length) {
      return res.status(400).json({ error: 'missing_or_invalid_token' });
    }

    const tokenHash = hashToken(id);
    const { seasonCode, venueSlug, seatIds: allowedSeatIds } = tok;

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const payer = req.body.payer || {};
    const schedule = Number(req.body.schedule || 1);

    if (!items.length) return res.status(400).json({ error: 'empty_items' });
    if (!payer?.email) return res.status(400).json({ error: 'payer_email_required' });
    if (![1,2,3].includes(schedule)) return res.status(400).json({ error: 'invalid_schedule' });

    for (const it of items) {
      if (!allowedSeatIds.includes(String(it.seatId))) {
        return res.status(403).json({ error: 'seat_not_in_token', seatId: it.seatId });
      }
    }


// Sièges réellement demandés au POST
const seatIdsAsked = [...new Set((req.body.items || []).map(i => i.seatId))];

// Re-vérification “atomique” des statuts
const badNow = await findNotProvisionedSeats({
  seasonCode, venueSlug, seatIds: seatIdsAsked
});
if (badNow.length) {
  return res.status(409).json({
    error: 'seats_not_available',
    blockedSeats: badNow.map(b => ({ seatId: b.seatId, status: b.status }))
  });
}


    const prices = await TariffPrice.find({ seasonCode, venueSlug }).lean().exec();
    const pricesIdx = buildPricesIndex(prices);

    const valuedLines = items.map(it => {
      const zoneKey = it.zoneKey || zoneKeyFromSeatId(it.seatId);
      const tariff = String(it.tariffCode || '').toUpperCase();
      const amount = computePriceCents(pricesIdx, zoneKey, tariff);
      return {
        seatId: String(it.seatId),
        tariffCode: tariff,
        priceCents: amount,
        holderFirstName: it.firstName || '',
        holderLastName:  it.lastName  || '',
        justificationField: it.justification || '',
        info: it.info || ''
      };
    });

    const totalAmount = valuedLines.reduce((s, l) => s + (l.priceCents || 0), 0);
    if (totalAmount <= 0) return res.status(400).json({ error: 'invalid_total' });

    const existingPaid = await Order.findOne({ 'meta.tokenHash': tokenHash, status: { $in: ['paid','authorized'] } }).lean().exec();
    if (existingPaid) return res.status(409).json({ error: 'already_paid' });

    const order = await Order.create({
      seasonCode,
      venueSlug,
      groupKey: tok.groupKey || tok.email || null,
      payerEmail: String(payer.email || '').trim(),
      payerFirstName: payer.firstName || '',
      payerLastName:  payer.lastName  || '',
      paymentSplit: schedule,
      lines: valuedLines,
      totalCents: totalAmount,
      status: 'pending',
      paymentProvider: 'helloasso',
      meta: { tokenHash }
    });

    if (HELLOASSO_STUB) {
      const intentId = `stub-${Date.now()}`;
      const result = (STUB_RESULT === 'failure') ? 'failure' : 'success';
      const redirectUrl = `${HA_RETURN_URL}?oid=${order._id}&ci=${intentId}&stub=1&result=${result}`;
      return res.json({ redirectUrl });
    }

    const intent = await createCheckoutIntent({
      orderId: order._id,
      order,
      itemName: `Abonnement ${seasonCode} — ${order.lines.length} place(s)`,
      returnUrl: HA_RETURN_URL,
      backUrl:   HA_BACK_URL,
      errorUrl:  HA_ERR_URL,
    });
    if (!intent?.redirectUrl) {
      console.error('[renew] createCheckoutIntent returned:', intent);
      return res.status(502).json({ error: 'checkout_intent_failed' });
    }
    return res.json({ redirectUrl: intent.redirectUrl });

  } catch (e) {
    console.error('[POST /s/renew] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
