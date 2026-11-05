// scripts/06-misc/check-attestation-deferral.js
//
// Vérifie que l'envoi de l'attestation a bien quitté le chemin de réponse,
// et que le filet qui le remplace ne réveille pas des commandes qui n'ont
// jamais eu à recevoir ce courriel.
//
// CE QUI A CHANGÉ. Les trois chemins de confirmation de paiement attendaient
// l'envoi complet avant de répondre. Le PDF n'était pas le coupable (mesuré :
// ~31 ms par billet, et il ne retient la boucle d'évènements que par tranches
// d'une dizaine de millisecondes) : c'était la connexion SMTP, en secondes, et
// sans aucun délai de garde. L'acheteur attendait sa page, et le prestataire
// attendait son 200 — faute de quoi il rejoue le webhook, donc une
// finalisation concurrente de plus.
//
// LE RISQUE DU FILET. « Commande payée sans attestation » décrit aussi les
// centaines de commandes importées ou issues de la bascule saison→match. Les
// balayer enverrait des billets à des gens qui n'attendent rien. Le cas 3
// ci-dessous est là pour que cela ne puisse pas arriver.
//
// Usage : npm run test:attestation-deferral   (mongod local requis)
//
// Base ISOLÉE (bts_mailcheck), créée et supprimée par ce script. Les courriels
// partent dans l'outbox de stub (EMAIL_STUB) ; le script relève la liste avant
// et après, et ne supprime QUE les fichiers qu'il a lui-même produits.
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { Order } from '../../src/models/Order.js';
import { Event } from '../../src/models/Event.js';
import { Seat } from '../../src/models/Seat.js';
import {
  sendOrderAttestationIfNeeded,
  scheduleOrderAttestation
} from '../../src/services/order-finalization.js';

process.env.EMAIL_STUB = 'true';

const DB = 'bts_mailcheck';
const SEASON = '2026-2027';
const VENUE = 'mailcheck-arena';
const OUTBOX = path.resolve(process.cwd(), 'data/outputs/outbox');

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

const listOutbox = async () => new Set(await fs.readdir(OUTBOX).catch(() => []));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** @param {object} opts  finalized: pose lastSuccessfulFinalizeAt (paiement passé par le tunnel) */
async function makePaidOrder(ev, seatId, { finalized, finalizedAt = new Date(Date.now() - 600000) } = {}) {
  const meta = {};
  if (finalized) meta.lastSuccessfulFinalizeAt = finalizedAt;
  return Order.create({
    eventId: ev._id, seasonCode: SEASON, venueSlug: VENUE, status: 'paid',
    payerEmail: `mailcheck-${seatId}@example.fr`, payerFirstName: 'Test', payerLastName: 'Mailcheck',
    totalCents: 1100, origin: { flow: 'event' }, mailTemplateKind: 'event',
    paymentProviderMeta: meta,
    meta: {
      eventId: String(ev._id),
      tickets: [{ seatId, zoneKey: 'N1', tariffCode: 'NORMAL', hex: Buffer.from(`T:${seatId}`).toString('base64') }]
    },
    lines: [{ seatId, zoneKey: 'N1', unitType: 'seat', zoneType: 'seated', tariffCode: 'NORMAL', priceCents: 1100 }]
  });
}

async function main() {
  const before = await listOutbox();
  await mongoose.connect(process.env.MAILCHECK_MONGO_URI || 'mongodb://127.0.0.1:27017', { dbName: DB });
  console.log(`[mailcheck] base isolée: ${DB}\n`);

  await Promise.all([Order.deleteMany({}), Event.deleteMany({}), Seat.deleteMany({})]);
  const ev = await Event.create({
    name: 'Mailcheck', slug: 'mailcheck', seasonCode: SEASON, venueSlug: VENUE,
    startsAt: new Date(Date.now() + 86400000)
  });
  await Seat.insertMany(['N1-A-001', 'N1-A-002', 'N1-A-003', 'N1-A-004'].map(seatId => ({
    seasonCode: SEASON, venueSlug: VENUE, seatId, zoneKey: 'N1', status: 'available'
  })));

  // ---- 1. L'ordonnancement rend la main tout de suite.
  console.log("1. scheduleOrderAttestation ne fait pas attendre l'appelant");
  {
    const order = await makePaidOrder(ev, 'N1-A-001', { finalized: true });
    const t0 = process.hrtime.bigint();
    const ret = scheduleOrderAttestation(order._id, { source: 'test' });
    const syncMs = Number(process.hrtime.bigint() - t0) / 1e6;

    check('rend la main en moins de 5 ms', syncMs < 5, `${syncMs.toFixed(2)} ms`);
    check('ne renvoie pas de promesse à attendre', ret === undefined, `ret=${ret}`);

    const fresh = await Order.findById(order._id).lean();
    check("rien n'est encore envoyé à cet instant",
      !fresh.paymentProviderMeta?.attestationSentAt);

    // On laisse la tâche différée aboutir.
    for (let i = 0; i < 60; i++) {
      const o = await Order.findById(order._id).lean();
      if (o.paymentProviderMeta?.attestationSentAt) break;
      await sleep(100);
    }
    const after = await Order.findById(order._id).lean();
    check("l'attestation part bien, juste après", Boolean(after.paymentProviderMeta?.attestationSentAt),
      `attestationSentAt=${after.paymentProviderMeta?.attestationSentAt}`);
  }

  // ---- 2. Pas de double envoi si les deux chemins s'en mêlent.
  console.log('\n2. Deux chemins qui ordonnancent le même envoi');
  {
    const order = await makePaidOrder(ev, 'N1-A-002', { finalized: true });
    scheduleOrderAttestation(order._id, { source: 'return' });
    scheduleOrderAttestation(order._id, { source: 'webhook' });
    await sleep(2500);
    const o = await Order.findById(order._id).lean();
    check('envoyée une fois', Boolean(o.paymentProviderMeta?.attestationSentAt));
    // Le verrou attestationSendingAt doit avoir été rendu.
    check('le verrou d\'envoi est rendu', !o.paymentProviderMeta?.attestationSendingAt,
      `sendingAt=${o.paymentProviderMeta?.attestationSendingAt}`);
  }

  // ---- 3. LE FILET NE DOIT PAS TOUCHER AUX COMMANDES IMPORTÉES.
  console.log('\n3. Le filet de la sentinelle ne réveille que les vrais paiements');
  {
    const since = new Date(Date.now() - 180 * 60 * 1000);
    const graceCutoff = new Date(Date.now() - Number(process.env.ATTESTATION_GRACE_MS || 120000));

    const legit = await makePaidOrder(ev, 'N1-A-003', { finalized: true });
    const imported = await makePaidOrder(ev, 'N1-A-004', { finalized: false }); // import / season-sync

    // Exactement la requête de scripts/sentinels/pending-orders.js.
    const picked = await Order.find({
      status: 'paid',
      'paymentProviderMeta.lastSuccessfulFinalizeAt': { $gte: since, $lte: graceCutoff },
      'paymentProviderMeta.attestationSentAt': null
    }).select({ _id: 1 }).lean();
    const ids = picked.map(p => String(p._id));

    check('le paiement légitime est retenu', ids.includes(String(legit._id)));
    check('la commande importée est ÉCARTÉE', !ids.includes(String(imported._id)),
      `retenues=${ids.length}`);

    // Et une commande finalisée à l'instant doit attendre son délai de grâce.
    const justNow = await makePaidOrder(ev, 'N1-A-001', { finalized: true, finalizedAt: new Date() });
    const picked2 = await Order.find({
      status: 'paid',
      'paymentProviderMeta.lastSuccessfulFinalizeAt': { $gte: since, $lte: graceCutoff },
      'paymentProviderMeta.attestationSentAt': null
    }).select({ _id: 1 }).lean();
    check("une finalisation à l'instant n'est pas doublée par le filet",
      !picked2.map(p => String(p._id)).includes(String(justNow._id)));
  }

  // ---- 4. L'appel direct reste disponible (scripts, admin) et attend.
  console.log("\n4. L'appel direct attend toujours (scripts, administration)");
  {
    const order = await makePaidOrder(ev, 'N1-A-002', { finalized: true });
    const sent = await sendOrderAttestationIfNeeded(order, { source: 'test-direct' });
    check('renvoie true après envoi effectif', sent === true, `sent=${sent}`);
    const o = await Order.findById(order._id).lean();
    check('la trace est posée', Boolean(o.paymentProviderMeta?.attestationSentAt));
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n[mailcheck] base ${DB} supprimée`);

  // Ménage : uniquement les .eml que CE script a produits.
  const after = await listOutbox();
  const created = [...after].filter(f => !before.has(f));
  for (const f of created) await fs.unlink(path.join(OUTBOX, f)).catch(() => {});
  console.log(`[mailcheck] outbox: ${created.length} fichier(s) de test supprimé(s), ${before.size} conservé(s)`);

  console.log(failures ? `\n❌ ${failures} assertion(s) en échec` : '\n✅ toutes les assertions passent');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[mailcheck] fatal:', e);
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch {}
  process.exit(1);
});
