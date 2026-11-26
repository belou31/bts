#!/usr/bin/env node
/**
 * Repairs the partner contribution stored on a partner's orders.
 *
 * Bug fixed in event-flow.factory.js: a tariff WITHOUT a partner price
 * (partnerPriceCents null/absent) was recorded with a partner contribution
 * equal to the display price, so partnerTotalCents was twice the price. The
 * correct contribution is 0.
 *
 * A line is repaired only when BOTH hold:
 *   - its stored partnerPriceCents equals its priceCents (what the bug wrote);
 *   - no TariffPrice with this tariffCode, sold to this partner or to the
 *     public, carries a partner price (so a real contribution that happens to
 *     equal the price is never touched).
 * Repaired line: partnerPriceCents = 0, partnerTotalCents = priceCents. The
 * order totals meta.partner.{displayTotalCents, partnerContributionCents,
 * partnerTotalCents} are recomputed from its lines.
 *
 * Usage:
 *   node scripts/05-partner-management/repair-partner-contribution.js --partner=<slug> [--event=<slug>] [--commit]
 *
 * Dry-run by default: nothing is written without --commit.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { connectMongo, logDryRun } from '../_utils.js';
import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

const argv = yargs(hideBin(process.argv))
  .option('partner', { type: 'string', demandOption: true, desc: 'Partner slug (meta.partner.slug)' })
  .option('event', { type: 'string', desc: 'Limit to one event slug' })
  .option('commit', { type: 'boolean', default: false })
  .help()
  .argv;

const partner = String(argv.partner || '').trim();
const fmt = (c) => (Number(c || 0) / 100).toFixed(2);

async function main() {
  await connectMongo();
  logDryRun(argv.commit);

  const match = { 'meta.partner.slug': partner };
  if (argv.event) {
    const ev = await Event.findOne({ slug: String(argv.event).trim() }, { _id: 1 }).lean();
    if (!ev) throw new Error(`Événement introuvable : ${argv.event}`);
    match.eventId = ev._id;
  }

  // Tarifs qui portent une part partenaire, pour ce partenaire ou le public.
  const withPartnerPrice = new Set(
    (await TariffPrice.find(
      { partnerPriceCents: { $type: 'number' }, channels: { $in: [`partner:${partner}`, 'public'] } },
      { tariffCode: 1 }
    ).lean()).map(t => String(t.tariffCode || '').toUpperCase())
  );
  console.log(`Tarifs avec part partenaire (laissés tels quels) : ${[...withPartnerPrice].sort().join(', ') || 'aucun'}`);

  const orders = await Order.find(match).sort({ createdAt: 1 });
  let ordersFixed = 0;
  let linesFixed = 0;
  let skippedEqual = 0;
  for (const order of orders) {
    let changed = false;
    for (const ln of order.lines || []) {
      const price = Number(ln.priceCents) || 0;
      if (ln.partnerPriceCents == null || Number(ln.partnerPriceCents) !== price || price === 0) continue;
      const code = String(ln.tariffCode || '').toUpperCase();
      if (withPartnerPrice.has(code)) { skippedEqual++; continue; }
      console.log(`  ${order._id} [${order.status}] ${code} ${ln.seatId || ln.zoneKey || ''} : part ${fmt(ln.partnerPriceCents)} → 0.00, total ${fmt(ln.partnerTotalCents)} → ${fmt(price)}`);
      ln.partnerPriceCents = 0;
      ln.partnerTotalCents = price;
      linesFixed++;
      changed = true;
    }
    if (!changed) continue;
    ordersFixed++;
    const p = order.meta?.partner;
    if (p && (p.partnerTotalCents != null || p.partnerContributionCents != null)) {
      const totals = (order.lines || []).reduce((acc, l) => {
        const d = Number(l.priceCents) || 0;
        const c = Number(l.partnerPriceCents) || 0;
        acc.displayTotalCents += d;
        acc.partnerContributionCents += c;
        acc.partnerTotalCents += d + c;
        return acc;
      }, { displayTotalCents: 0, partnerContributionCents: 0, partnerTotalCents: 0 });
      console.log(`    totaux commande : part ${fmt(p.partnerContributionCents)} → ${fmt(totals.partnerContributionCents)}, total ${fmt(p.partnerTotalCents)} → ${fmt(totals.partnerTotalCents)}`);
      order.meta.partner = { ...p, ...totals };
    }
    order.markModified('lines');
    order.markModified('meta');
    if (argv.commit) await order.save();
  }

  console.log(`${argv.commit ? '✓' : 'Dry-run :'} ${linesFixed} ligne(s) dans ${ordersFixed} commande(s) sur ${orders.length}${argv.commit ? ' corrigée(s)' : ' à corriger, rien d’écrit'}.`);
  if (skippedEqual) console.log(`${skippedEqual} ligne(s) où part = prix laissées : leur tarif a une vraie part partenaire.`);
}

main()
  .catch((err) => { console.error('❌', err?.message || err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
