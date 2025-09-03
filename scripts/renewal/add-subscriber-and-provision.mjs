#!/usr/bin/env node
// scripts/renew/add-subscriber-and-provision.mjs
import 'dotenv/config';
import mongoose from 'mongoose';
import minimist from 'minimist';
import jwt from 'jsonwebtoken';
import { Season, Subscriber, Seat } from '../../src/models/index.js';

const args = minimist(process.argv.slice(2), {
  string: ['season','venue','email','first','last','seat','group'],
  alias:  { s:'season', v:'venue', e:'email', f:'first', l:'last', g:'group' }
});

const seasonCode = args.season;
let   venueSlug  = args.venue || null;
const email      = String(args.email || '').trim().toLowerCase();
const firstName  = String(args.first || '').trim();
const lastName   = String(args.last || '').trim();
const groupKey   = String(args.group || '').trim() || email;
const seats      = String(args.seat || '').split(',').map(s => s.trim()).filter(Boolean);

if (!seasonCode || !email || !seats.length) {
  console.error('Usage: node scripts/renew/add-subscriber-and-provision.mjs --season 2025-2026 --venue patinoire-blagnac --email foo@bar --first Jean --last Dupont --seat A1-001[,A1-002] [--group FAMILLE-1]');
  process.exit(1);
}

const MONGO_URI   = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';
const JWT_SECRET  = process.env.JWT_SECRET || '';
const APP_URL     = (process.env.APP_URL || '').replace(/\/$/, '');

(async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  try {
    if (!venueSlug) {
      const sev = await Season.findOne({ code: seasonCode }).lean();
      if (!sev?.venueSlug) throw new Error('venueSlug introuvable : passe --venue ou renseigne Season.venueSlug');
      venueSlug = sev.venueSlug;
    }

    const created = [];
    const ensured = [];

    for (const seatId of seats) {
      // upsert Subscriber pour ce seat
      let sub = await Subscriber.findOne({ seasonCode, venueSlug, email, prefSeatId: seatId });
      if (!sub) {
        sub = await Subscriber.create({
          seasonCode, venueSlug,
          email, firstName, lastName,
          groupKey,
          prefSeatId: seatId,
          previousSeasonSeats: [seatId],
          status: 'invited'
        });
        created.push(sub._id.toString());
      } else {
        // alimente previousSeasonSeats si nécessaire
        const set = new Set([...(sub.previousSeasonSeats || []), seatId]);
        sub.previousSeasonSeats = Array.from(set);
        sub.groupKey = sub.groupKey || groupKey;
        if (!sub.prefSeatId) sub.prefSeatId = seatId;
        await sub.save();
        ensured.push(sub._id.toString());
      }

      // Provisionner le siège
      const upd = await Seat.updateOne(
        { seasonCode, venueSlug, seatId },
        { $set: { status: 'provisioned', provisionedFor: sub._id } }
      );
      if (upd.matchedCount === 0) {
        console.warn(`[warn] Seat ${seatId} introuvable pour ${seasonCode}/${venueSlug} (vérifie le catalog Seat).`);
      }
    }

    // Générer le token Renew pour ce lot de sièges
    if (!JWT_SECRET) {
      console.warn('[warn] JWT_SECRET manquant : token non généré.');
    }
    const payload = {
      seasonCode,
      venueSlug,
      email,
      groupKey,
      seatIds: seats,
      iat: Math.floor(Date.now()/1000),
      exp: Math.floor(Date.now()/1000) + 60*60*24*30 // 30 jours
    };
    const token = JWT_SECRET ? jwt.sign(payload, JWT_SECRET) : null;

    const urlRenew = token
      ? `${APP_URL || ''}/renew?id=${encodeURIComponent(token)}`
      : '(définis APP_URL & JWT_SECRET pour obtenir l’URL)';

    console.log('[ok] Subscribers:', { created, ensured });
    console.log('[ok] Seats provisioned:', seats);
    console.log('[ok] Renew URL:', urlRenew);
    console.log('[tip] Tu peux aussi ouvrir /s/renew?id=<token> si le routeur est monté sous /s.');
  } catch (e) {
    console.error('[error]', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
