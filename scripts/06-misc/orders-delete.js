#!/usr/bin/env node
/**
 * Annule (soft) ou supprime (hard) des commandes, et invalide leurs billets.
 *
 * Deux façons de désigner la cible :
 *   --order=<id>       une commande précise (usage courant : un cas isolé)
 *   --file=<csv>       un lot, colonnes `orderId` et `mode` (soft|hard)
 *
 * soft : la commande passe à `canceled` et ses billets sont supprimés. La
 *        trace du paiement est conservée — à préférer presque toujours.
 * hard : le document est supprimé. Aucune trace ne subsiste ; à réserver aux
 *        commandes de test.
 *
 * Dans les deux cas les billets sont SUPPRIMÉS : `Ticket` n'a pas de champ
 * `status`, et c'est ainsi que le reste du code les révoque.
 *
 * LES SIÈGES : ni l'annulation ni la suppression ne les libèrent par défaut.
 * Une commande supprimée dont les places restent `booked` bloque ces places
 * sans plus rien pour expliquer pourquoi — passer --release-seats pour les
 * remettre en vente, ou les traiter ensuite à la main. Le script affiche
 * toujours les places concernées.
 *
 * Usage:
 *   node scripts/06-misc/orders-delete.js --order=<id> [--mode=soft|hard]
 *   node scripts/06-misc/orders-delete.js --file=<orders.csv>
 *   ... [--commit] [--force] [--release-seats]
 *
 * Options:
 *   --commit          écrit en base (sans lui : simulation, rien n'est modifié)
 *   --force           autorise à toucher une commande `paid`
 *   --release-seats   remet les places de la commande en `available`
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, loadModels, readCsv, logDryRun } from '../_utils.js';

const argv = yargs(hideBin(process.argv))
  .option('order',  { type: 'string', desc: 'Identifiant d\'une commande' })
  .option('file',   { type: 'string', desc: 'CSV : colonnes orderId, mode' })
  .option('mode',   { type: 'string', default: 'soft', choices: ['soft', 'hard'], desc: 'Avec --order' })
  .option('commit', { type: 'boolean', default: false })
  .option('force',  { type: 'boolean', default: false, desc: 'Autorise une commande payée' })
  .option('release-seats', { type: 'boolean', default: false, desc: 'Remet les places en vente' })
  .check(a => {
    if (!a.order && !a.file) throw new Error('Préciser --order=<id> ou --file=<csv>');
    if (a.order && a.file) throw new Error('Un seul mode à la fois : --order ou --file');
    return true;
  })
  .help().argv;

// Le modèle n'accepte que 'canceled' : le script écrivait 'cancelled', ce qui
// faisait échouer toute annulation à l'enregistrement.
const CANCELED = 'canceled';

async function targets() {
  if (argv.order) return [{ orderId: String(argv.order).trim(), mode: argv.mode }];
  const rows = await readCsv(argv.file);
  return rows
    .map(r => ({ orderId: String(r.orderId || '').trim(), mode: String(r.mode || 'soft').toLowerCase() }))
    .filter(r => r.orderId);
}

async function main() {
  await connectMongo();
  const { Order, Ticket, Seat } = loadModels();
  logDryRun(argv.commit);

  const list = await targets();
  if (!list.length) {
    console.log('Aucune commande à traiter.');
    process.exit(0);
  }

  let soft = 0, hard = 0, miss = 0, skipped = 0, released = 0, revoked = 0;

  for (const { orderId, mode } of list) {
    const order = await Order.findById(orderId).catch(() => null);
    if (!order) { console.warn(`❓ introuvable ${orderId}`); miss++; continue; }

    // Les lignes ZONE n'ont pas de document Seat : seules les places
    // identifiées peuvent être remises en vente.
    const seatIds = (order.lines || [])
      .filter(l => (l.unitType || '') !== 'zone')
      .map(l => String(l.seatId || '').trim())
      .filter(Boolean);

    console.log(`\n${orderId}`);
    console.log(`  statut : ${order.status} · ${order.origin?.flow || '—'} · ${(order.totalCents || 0) / 100} €`
      + ` · ${order.payerEmail || '—'}`);
    console.log(`  places : ${seatIds.length ? seatIds.join(', ') : '(aucune place identifiée)'}`);

    // Une commande payée correspond à de l'argent encaissé : la toucher sans
    // le dire explicitement est le genre d'action qu'on regrette.
    if (order.status === 'paid' && !argv.force) {
      console.log('  ⛔ commande PAYÉE — ignorée. Ajouter --force pour la traiter malgré tout.');
      skipped++;
      continue;
    }

    if (!argv.commit) {
      console.log(`  🧪 ${mode.toUpperCase()} — et ${argv['release-seats']
        ? `${seatIds.length} place(s) remise(s) en vente`
        : 'places laissées en l\'état'}`);
      continue;
    }

    // Les billets sont SUPPRIMÉS, pas marqués : `Ticket` n'a pas de champ
    // `status`, et son schéma est strict — l'ancien $set:{status:'void'} était
    // donc écarté en silence, laissant des billets parfaitement scannables
    // pour une commande annulée. La suppression est la façon dont le reste du
    // code révoque un billet (event-season-sync.js, delete-event.js).
    const ticketDel = await Ticket.deleteMany({ orderId: order._id });
    const ticketsRemoved = Number(ticketDel.deletedCount ?? 0);

    if (mode === 'hard') {
      await Order.deleteOne({ _id: orderId });
      hard++;
      console.log(`  ✔ supprimée${ticketsRemoved ? ` · ${ticketsRemoved} billet(s) révoqué(s)` : ''}`);
    } else {
      order.status = CANCELED;
      order.meta = order.meta || {};
      order.meta.canceledAt = new Date();
      if (Array.isArray(order.meta.tickets)) {
        order.meta.tickets = order.meta.tickets.map(t => ({ ...t, status: 'void' }));
      }
      order.markModified('meta');
      await order.save();
      soft++;
      console.log(`  ✔ annulée (${CANCELED})${ticketsRemoved ? ` · ${ticketsRemoved} billet(s) révoqué(s)` : ''}`);
    }
    revoked += ticketsRemoved;

    if (argv['release-seats'] && seatIds.length) {
      const upd = await Seat.updateMany(
        { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: seatIds } },
        { $set: { status: 'available', provisionedFor: null }, $unset: { 'meta.hold': 1 } }
      );
      const n = Number(upd.modifiedCount ?? upd.nModified ?? 0);
      released += n;
      console.log(`  ✔ ${n} place(s) remise(s) en vente`);
    } else if (seatIds.length) {
      console.log(`  ⚠ ${seatIds.length} place(s) restent réservées (--release-seats pour les libérer)`);
    }
  }

  console.log(`\n✅ Soft: ${soft} | Hard: ${hard} | Payées ignorées: ${skipped}`
    + ` | Manquantes: ${miss} | Billets révoqués: ${revoked} | Places libérées: ${released}`);
  if (!argv.commit) console.log('Simulation seule. Relancer avec --commit pour écrire.');
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message || e); process.exit(1); });
