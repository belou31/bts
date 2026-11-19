/**
 * Sentinel to monitor pending/tobepaid payment-provider orders.
 *
 * Checks pending/tobepaid orders, finalises those marked as paid by provider, and
 * performs housekeeping (release expired holds, cancel stale pending orders).
 *
 * Usage:
 *   node scripts/04-admin-monitoring/sentinels/pending-orders.js [--sinceMinutes=180]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *   - CHECKOUT_HOLD_MIN, PENDING_MAX_MIN (optional overrides)
 */

import 'dotenv/config';
import { loadEnv } from '../lib/load-env.js';

// `dotenv/config` ne lit que `.env`. La sentinelle interroge le prestataire
// pour trancher le sort des commandes en attente : sans `.env.<PAYMENT_PROVIDER>`,
// l'appel échoue et elle laisse tout en attente sans le dire.
loadEnv();

import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Seat }  from '../../src/models/Seat.js';
import { getCheckoutStatus, currentPaymentProviderId } from '../../src/services/payments/index.js';
import { releaseOrderSeatHolds } from '../../src/services/event-seat-holds.js';
import { normalizePaymentStatus, isPaidLike,
         finalizePaidIfNoConflict,
         sendOrderAttestationIfNeeded,
         sendConflictEmail } from '../../src/services/order-finalization.js';

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('[sentinel] MONGO_URI/MONGODB_URI manquant'); process.exit(1); }

const sinceMin = Number((process.argv.find(a=>a.startsWith('--sinceMinutes='))||'').split('=')[1] || 180);

// ====== Housekeeping (holds & pending expirés) ======
const HOLD_EXPIRE_MIN = Number(process.env.CHECKOUT_HOLD_MIN || 5);
const PENDING_MAX_MIN = Number(process.env.PENDING_MAX_MIN || 5);
const PAYMENT_PROVIDER_ID = currentPaymentProviderId();

// Libère les sièges d'une commande annulée.
//
// Déléguée à releaseOrderSeatHolds : la version locale ne touchait que `Seat`,
// laissant le verrou d'évènement (SeatHold) en place — et c'est lui que lit le
// plan de salle, donc les places d'une commande annulée restaient affichées
// prises. Elle filtrait de surcroît sur `order._id` (ObjectId) quand les flux
// d'achat écrivent `String(order._id)` : elle ne libérait jamais rien.
async function releaseSeatsForOrder(order) {
  const { holds, seats } = await releaseOrderSeatHolds(order);
  console.log('[sentinel] releaseSeatsForOrder:', {
    orderId: order._id.toString(), seatHolds: holds, seats
  });
  return seats;
}

async function releaseExpiredHolds({ seasonCode, venueSlug }) {
   const now = new Date();
   const r = await Seat.updateMany(
     { seasonCode, venueSlug, status: 'busy', 'meta.hold.until': { $lte: now } },
     { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } }
   );
   console.log('[sentinel] releaseExpiredHolds:', { matched: r.matchedCount ?? r.n ?? 0, modified: r.modifiedCount ?? r.nModified ?? 0 });
 }
 
/**
 * Rattrape les commandes payées dont l'attestation n'est jamais partie.
 *
 * Les trois chemins de confirmation DIFFÈRENT désormais l'envoi (voir
 * scheduleOrderAttestation) pour répondre tout de suite à l'acheteur et au
 * webhook du prestataire. Ce filet est la contrepartie : si le processus
 * s'arrête entre la réponse et l'envoi, ou si le SMTP refuse, le courriel part
 * au passage suivant. Auparavant un échec d'envoi dans la requête ne laissait
 * qu'une ligne de journal, et personne ne réessayait.
 *
 * LE FILTRE EST VOLONTAIREMENT ÉTROIT. « Commande payée sans attestation »
 * décrit aussi les centaines de commandes importées ou issues de la bascule
 * saison→match, qui n'ont jamais eu à recevoir ce courriel : les balayer
 * enverrait des billets à des gens qui n'attendent rien. On exige donc
 * `lastSuccessfulFinalizeAt`, que SEULE finalizePaidIfNoConflict écrit — c'est
 * la marque d'un paiement passé par notre tunnel — et on ne regarde que la
 * fenêtre de la sentinelle.
 *
 * Le délai de grâce laisse l'envoi différé aboutir de lui-même ; au-delà, le
 * verrou `attestationSendingAt` de sendOrderAttestationIfNeeded empêche de
 * toute façon un double envoi.
 */
async function sendMissingAttestations({ since }) {
  const graceMs = Number(process.env.ATTESTATION_GRACE_MS || 120000);
  const graceCutoff = new Date(Date.now() - graceMs);

  const orders = await Order.find({
    status: 'paid',
    'paymentProviderMeta.lastSuccessfulFinalizeAt': { $gte: since, $lte: graceCutoff },
    // `null` couvre l'absence du champ ET sa valeur nulle.
    'paymentProviderMeta.attestationSentAt': null
  }).limit(50);

  if (!orders.length) {
    console.log('[sentinel] attestations manquantes: aucune');
    return;
  }
  console.log(`[sentinel] attestations manquantes: ${orders.length}`);
  for (const order of orders) {
    try {
      const sent = await sendOrderAttestationIfNeeded(order, { source: 'sentinel/missing-attestation' });
      console.log(`[sentinel]   ${order._id} → ${sent ? 'envoyée' : 'ignorée (déjà envoyée ou verrouillée)'}`);
    } catch (err) {
      console.warn(`[sentinel]   ${order._id} → échec:`, err?.message || err);
    }
  }
}

 async function cancelStalePendingAndRelease({ seasonCode, venueSlug }) {
   const cutoff = new Date(Date.now() - PENDING_MAX_MIN * 60 * 1000);
   const stale = await Order.find({
     seasonCode, venueSlug,
     status: 'pending',
     createdAt: { $lte: cutoff }
   }).lean();
   for (const o of stale) {
     await Order.updateOne({ _id: o._id, status: 'pending' }, { $set: { status: 'canceled' } });
     await releaseSeatsForOrder(o);
     console.log('[sentinel] canceled pending:', o._id.toString());

    }
 }


// ====== Résolution d’un contexte {seasonCode, venueSlug} ======
async function resolveCtx() {
  // On prend la saison/la salle de la commande la plus récente
  const recent = await Order.findOne({}).sort({ createdAt: -1 }).lean();
  const seasonCode = recent?.seasonCode || null;
  const venueSlug  = recent?.venueSlug  || null;
  return { seasonCode, venueSlug };
}

// ====== Runner unique : scan + housekeeping ======
async function runOnce() {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  const since = new Date(Date.now() - sinceMin*60*1000);

  console.log('[sentinel] config:', {
    sinceMinutes: sinceMin,
    PENDING_MAX_MIN,
    CHECKOUT_HOLD_MIN: HOLD_EXPIRE_MIN
  });

  const list = await Order.find({
    status: { $in: ['pending', 'tobepaid'] },
    paymentProvider: PAYMENT_PROVIDER_ID,
    'paymentProviderMeta.checkoutIntentId': { $exists: true, $ne: null },
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 }).lean();

  console.log(`[sentinel] scanning ${list.length} pending orders since ${since.toISOString()}`);

  for (const o of list) {
    const intent = o.paymentProviderMeta?.checkoutIntentId;
    if (!intent) continue;

    let raw;
    try { raw = await getCheckoutStatus(intent); }
    catch (e) { console.warn('[sentinel] getCheckoutStatus failed:', intent, e.message); raw = ''; }

    const status = normalizePaymentStatus(raw);

    if (!isPaidLike(status)) {
      console.log(`[sentinel] keep pending ${o._id} → ${status||'(empty)'}`);
      continue;
    }

    // finalize (anti-conflit) via service
    const order = await Order.findById(o._id);
    if (!order) continue;
     const fin = await finalizePaidIfNoConflict(order);
      if (fin.ok) {
      console.log(`[sentinel] order ${o._id} → paid, seats booked: ${fin.booked}`);
      await sendOrderAttestationIfNeeded(order, { source: 'sentinel/pending-orders' });
     } else if (fin.inFlight) {
      // Une requête tient le verrou de finalisation (retour de paiement,
      // webhook, sondage). La sentinelle est un filet, pas un arbitre : elle
      // repasse dans deux minutes. Envoyer le courriel d'échec ici
      // contredirait des billets en cours d'expédition.
      console.log(`[sentinel] order ${o._id} → finalisation en vol, on repassera`);
     } else if (fin.blocked) {
      console.log(`[sentinel] order ${o._id} → ${fin.conflicts?.[0]?.reason || 'bloquée'}, rien à faire`);
     } else {
      console.warn(`[sentinel] conflict — order ${o._id} marked failed`, fin.conflicts);
      await sendConflictEmail(order);
     }
    }
  // --- Filet des attestations non parties (indépendant du contexte saison/lieu)
  await sendMissingAttestations({ since });

  // --- Housekeeping systématique (libérer holds expirés + annuler pending trop vieux)
  const ctx = await resolveCtx();
  if (ctx.seasonCode && ctx.venueSlug) {
    await releaseExpiredHolds(ctx);
    await cancelStalePendingAndRelease(ctx);
  } else {
    console.warn('[sentinel] housekeeping skipped (no season/venue context)');
  }

  await mongoose.disconnect();
  process.exit(0);
}

// Entrée
runOnce().catch(e => {
  console.error('[sentinel] fatal:', e);
  process.exit(1);
}); 
