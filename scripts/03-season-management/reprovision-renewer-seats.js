#!/usr/bin/env node
/**
 * Re-provisionne les sièges d'UN renouveleur déjà existant.
 *
 * `renewal-provision-seats.js` balaie toute la saison : il ne sait pas ce qui
 * a changé, ne rend jamais un siège retiré d'une fiche, et n'épargne que les
 * sièges `booked` — il écrase donc les `busy`, c'est-à-dire les renouvellements
 * en cours de paiement. Utilisable pour l'amorçage d'une campagne, pas pour
 * corriger une fiche en pleine campagne.
 *
 * Ce script fait l'inverse : une cible explicite, et une réconciliation
 * complète de ses sièges — on provisionne ce qui manque ET on relâche ce qui
 * n'est plus à elle.
 *
 * Un renouveleur est un GROUPE (une famille = plusieurs documents Subscriber
 * partageant un `groupKey`, un par ligne de siège). `--email` et `--group`
 * ciblent donc l'ensemble des lignes ; `--subscriber` une seule.
 *
 * Sécurités :
 *   - `booked` jamais touché (siège déjà renouvelé et payé) ;
 *   - `busy` jamais touché sans `--force-busy` (checkout en cours : l'écraser
 *     fait atterrir le paiement sur un siège que le système ne lui attribue
 *     plus) ;
 *   - un siège provisionné pour QUELQU'UN D'AUTRE n'est pris qu'avec
 *     `--reassign`, et le transfert est affiché.
 *
 * Usage:
 *   node scripts/03-season-management/reprovision-renewer-seats.js <seasonCode> --email=<email> [--venue=<slug>] [--apply]
 *   node scripts/03-season-management/reprovision-renewer-seats.js <seasonCode> --group=<groupKey> [...]
 *   node scripts/03-season-management/reprovision-renewer-seats.js <seasonCode> --subscriber=<objectId> [...]
 *
 * Options:
 *   --apply        écrit en base (sans lui : simulation, rien n'est modifié)
 *   --force-busy   re-provisionne aussi un siège en cours de checkout
 *   --reassign     reprend un siège provisionné pour un autre abonné
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { Seat, Season, Subscriber } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function arg(name, def = null) {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=').slice(1).join('=') : def;
}
const hasFlag = name => process.argv.includes(`--${name}`);
const normSeat = s => String(s || '').trim().toUpperCase();

function usage(msg) {
  if (msg) console.error(`❌ ${msg}`);
  console.error('Usage: node scripts/03-season-management/reprovision-renewer-seats.js <seasonCode>');
  console.error('         (--email=<email> | --group=<groupKey> | --subscriber=<objectId>)');
  console.error('         [--venue=<slug>] [--apply] [--force-busy] [--reassign]');
  process.exit(1);
}

async function resolveTargets({ seasonCode, venueSlug, email, group, subscriberId }) {
  const base = { seasonCode };
  if (venueSlug) base.venueSlug = venueSlug;

  if (subscriberId) {
    if (!mongoose.isValidObjectId(subscriberId)) usage(`--subscriber n'est pas un ObjectId : ${subscriberId}`);
    const one = await Subscriber.findOne({ ...base, _id: subscriberId }).lean();
    return one ? [one] : [];
  }
  if (group) return Subscriber.find({ ...base, groupKey: group }).lean();
  // L'email est saisi par un humain : on compare insensible à la casse.
  return Subscriber.find({ ...base, email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
}

async function main() {
  const seasonCode = process.argv[2];
  if (!seasonCode || seasonCode.startsWith('--')) usage('seasonCode manquant');

  const email        = arg('email');
  const group        = arg('group');
  const subscriberId = arg('subscriber');
  const selectors    = [email, group, subscriberId].filter(Boolean);
  if (selectors.length === 0) usage('préciser --email, --group ou --subscriber');
  if (selectors.length > 1)   usage('un seul sélecteur à la fois (--email, --group ou --subscriber)');

  const apply     = hasFlag('apply');
  const forceBusy = hasFlag('force-busy');
  const reassign  = hasFlag('reassign');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  await mongoose.connect(uri, {});

  const season = await Season.findOne({ code: seasonCode }).lean();
  if (!season) throw new Error(`Saison introuvable : ${seasonCode}`);
  const venueSlug = arg('venue', season.venueSlug || null);

  const subs = await resolveTargets({ seasonCode, venueSlug, email, group, subscriberId });
  if (!subs.length) {
    console.error(`❌ Aucun renouveleur trouvé (${seasonCode}${venueSlug ? ` / ${venueSlug}` : ''}) pour ${selectors[0]}.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const subIds = subs.map(s => String(s._id));
  console.log(`\nRenouveleur ciblé — ${subs.length} ligne(s) d'abonné`);
  for (const s of subs) {
    const seats = (s.previousSeasonSeats || []).map(normSeat).filter(Boolean);
    console.log(`  ${s._id}  ${(s.firstName || '') + ' ' + (s.lastName || '')}`.trimEnd()
      + `  <${s.email || '—'}>  groupe=${s.groupKey || '—'}  places=${s.places || 1}`);
    console.log(`      sièges attendus : ${seats.length ? seats.join(', ') : '(aucun — ligne en ZONE ?)'}`);
  }

  // Union des sièges attendus, et sièges actuellement rattachés à ces lignes.
  const wanted = new Set(subs.flatMap(s => (s.previousSeasonSeats || []).map(normSeat).filter(Boolean)));
  const attachedFilter = { seasonCode, provisionedFor: { $in: subs.map(s => s._id) } };
  if (venueSlug) attachedFilter.venueSlug = venueSlug;
  const attached = await Seat.find(attachedFilter).lean();

  const plan = { provision: [], release: [], skipBooked: [], skipBusy: [], conflict: [], notFound: [], noop: [] };

  for (const seatId of wanted) {
    const filter = { seasonCode, seatId };
    if (venueSlug) filter.venueSlug = venueSlug;
    const seat = await Seat.findOne(filter).lean();
    if (!seat) { plan.notFound.push(seatId); continue; }

    if (seat.status === 'booked') { plan.skipBooked.push(seatId); continue; }
    if (seat.status === 'busy' && !forceBusy) {
      plan.skipBusy.push({ seatId, orderId: seat.meta?.hold?.orderId || '—', until: seat.meta?.hold?.until || null });
      continue;
    }

    const owner = seat.provisionedFor ? String(seat.provisionedFor) : null;
    if (owner && !subIds.includes(owner)) {
      if (!reassign) { plan.conflict.push({ seatId, owner }); continue; }
      plan.provision.push({ seatId, from: owner, status: seat.status });
      continue;
    }
    if (seat.status === 'provisioned' && owner) { plan.noop.push(seatId); continue; }
    plan.provision.push({ seatId, from: null, status: seat.status });
  }

  // Sièges encore rattachés au renouveleur mais retirés de sa fiche : c'est le
  // cas que le script global ne traite pas, et qui laisse des orphelins.
  for (const seat of attached) {
    if (wanted.has(normSeat(seat.seatId))) continue;
    if (seat.status === 'booked') { plan.skipBooked.push(`${seat.seatId} (retiré, mais déjà payé)`); continue; }
    if (seat.status === 'busy' && !forceBusy) {
      plan.skipBusy.push({ seatId: seat.seatId, orderId: seat.meta?.hold?.orderId || '—', until: seat.meta?.hold?.until || null });
      continue;
    }
    plan.release.push(seat.seatId);
  }

  console.log(`\nPlan (${apply ? 'APPLIQUÉ' : 'simulation'})`);
  const line = (label, items) => { if (items.length) console.log(`  ${label} ${items.join(', ')}`); };
  line('→ provisionner   :', plan.provision.map(p => p.from ? `${p.seatId} (repris à ${p.from})` : p.seatId));
  line('→ relâcher       :', plan.release);
  line('= déjà en place  :', plan.noop);
  line('⏭ déjà payé      :', plan.skipBooked);
  line('⚠ introuvable    :', plan.notFound);
  if (plan.skipBusy.length) {
    console.log('  ⛔ checkout en cours (intact, utiliser --force-busy pour passer outre) :');
    for (const b of plan.skipBusy) console.log(`       ${b.seatId} — commande ${b.orderId}${b.until ? `, jusqu'à ${new Date(b.until).toISOString()}` : ''}`);
  }
  if (plan.conflict.length) {
    console.log('  ⛔ provisionné pour un autre abonné (intact, utiliser --reassign) :');
    for (const c of plan.conflict) console.log(`       ${c.seatId} — abonné ${c.owner}`);
  }
  if (!plan.provision.length && !plan.release.length) console.log('  (rien à changer)');

  if (!apply) {
    console.log('\nSimulation seule. Relancer avec --apply pour écrire en base.');
    await mongoose.disconnect();
    return;
  }

  // Le siège est rattaché à la ligne d'abonné qui le revendique, et non à la
  // première du groupe : c'est cette ligne que /renew retrouvera.
  const ownerOf = new Map();
  for (const s of subs) for (const raw of (s.previousSeasonSeats || [])) ownerOf.set(normSeat(raw), s._id);

  let provisioned = 0;
  for (const p of plan.provision) {
    const filter = { seasonCode, seatId: p.seatId };
    if (venueSlug) filter.venueSlug = venueSlug;
    const res = await Seat.updateOne(filter, {
      $set: { status: 'provisioned', provisionedFor: ownerOf.get(p.seatId) || subs[0]._id },
      $unset: { 'meta.hold': 1 }
    });
    provisioned += Number(res.modifiedCount ?? res.nModified ?? 0);
  }

  let released = 0;
  for (const seatId of plan.release) {
    const filter = { seasonCode, seatId };
    if (venueSlug) filter.venueSlug = venueSlug;
    const res = await Seat.updateOne(filter, {
      $set: { status: 'available', provisionedFor: null },
      $unset: { 'meta.hold': 1 }
    });
    released += Number(res.modifiedCount ?? res.nModified ?? 0);
  }

  console.log(`\n✔ provisionnés=${provisioned}  relâchés=${released}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
