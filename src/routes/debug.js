// src/routes/debug.js
import express from 'express';
import { Tariff, TariffPrice, Seat } from '../models/index.js';

const router = express.Router();

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

// --- renew scan
router.get('/debug/renew-scan', async (req, res) => {
  try {
    const seasonCode = req.query.season || '2025-2026';
    const venueSlug  = req.query.venue  || 'patinoire-blagnac';
    const f = seasonVenueFilter({ seasonCode, venueSlug });

    const [tariffs, tpCount, tpOne, seatCount, seatOne] = await Promise.all([
      Tariff.find({ active: { $ne: false } }).sort({ sortOrder: 1, code: 1 }).lean(),
      TariffPrice.countDocuments(f),
      TariffPrice.findOne(f).lean(),
      Seat.countDocuments(f),
      Seat.findOne(f, { seatId:1, zoneKey:1, status:1, season:1, seasonCode:1, venue:1, venueSlug:1 }).lean()
    ]);

    res.json({
      input: { seasonCode, venueSlug },
      filter: f,
      tariffs: { count: tariffs.length, sample: tariffs[0] || null },
      tariffprices: { count: tpCount, sample: tpOne || null },
      seats: { count: seatCount, sample: seatOne || null }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'error' });
  }
});

// --- helloasso config (sans secrets)
router.get('/debug/ha-config', (req, res) => {
  const haEnv = (process.env.HELLOASSO_ENV || 'sandbox').toLowerCase();
  const apiHost = (process.env.HELLOASSO_API_URL || '').trim()
    || (haEnv === 'production'
        ? 'https://api.helloasso.com'
        : 'https://api.helloasso-sandbox.com');
  const mask = (s) => s ? `${s.slice(0,4)}…${s.slice(-4)}` : '(unset)';
  res.json({
    env: process.env.APP_ENV || 'development',
    haEnv,
    apiHost,
    orgSlug: process.env.HELLOASSO_ORG_SLUG || '(unset)',
    returnUrl: process.env.HELLOASSO_RETURN_URL || '(unset)',
    clientId: mask(process.env.HELLOASSO_CLIENT_ID || ''),
    hasClientSecret: !!(process.env.HELLOASSO_CLIENT_SECRET && process.env.HELLOASSO_CLIENT_SECRET.length)
  });
});

export default router;
