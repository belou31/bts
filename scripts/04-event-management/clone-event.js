#!/usr/bin/env node
/**
 * Clone an existing event into a new one: venue instantiation (seats/zones
 * for the new event's season+venue), tariffs (copied from the source
 * event's actual Tariff/TariffPrice rows, not re-derived from a catalog —
 * this preserves any manual price tweaks the source event has), and the
 * event-level customization file.
 *
 * Usage:
 *   node scripts/04-event-management/clone-event.js --from=<slug|id> --slug=<newSlug> --name="<New name>" --date=<ISO>
 *     [--season=<code>] [--skip-venue] [--skip-tariffs] [--skip-custo] [--dry-run]
 *
 * Behaviour:
 *   - New event always starts in the default lifecycle state (sale=notopen,
 *     activity=draft) and with a fresh empty qrBank (QR codes are one-shot
 *     and event-specific — never copied).
 *   - venueSlug/venueView are copied from the source event.
 *   - seasonCode defaults to the source event's, override with --season.
 *   - priceTableKey is always a fresh "ev:<newSlug>" — never shared with the source.
 */
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';
import { Tariff } from '../../src/models/Tariff.js';
import { TariffPrice } from '../../src/models/TariffPrice.js';

const INSTANTIATE_VENUE_SCRIPT = path.resolve(process.cwd(), 'scripts/04-event-management/instantiate-venue-for-event.js');
const CUSTOM_EVENTS_DIR = path.resolve(process.cwd(), 'data', 'customization', 'events');

const argv = yargs(hideBin(process.argv))
  .option('from', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement source' })
  .option('slug', { type: 'string', demandOption: true, desc: 'Slug du nouvel événement' })
  .option('name', { type: 'string', demandOption: true, desc: 'Nom affiché du nouvel événement' })
  .option('date', { type: 'string', demandOption: true, desc: 'Date ISO du nouvel événement' })
  .option('season', { type: 'string', desc: 'Code saison (par défaut : celui de l\'événement source)' })
  .option('skip-venue', { type: 'boolean', default: false, desc: 'Ne pas instancier sièges/zones pour le nouvel événement' })
  .option('skip-tariffs', { type: 'boolean', default: false, desc: 'Ne pas copier les tarifs de l\'événement source' })
  .option('skip-custo', { type: 'boolean', default: false, desc: 'Ne pas copier le fichier de personnalisation' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

function resolveEventQuery(ref) {
  return /^[0-9a-f]{24}$/i.test(ref) ? { _id: ref } : { slug: ref };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const source = await Event.findOne(resolveEventQuery(String(argv.from).trim())).lean();
  if (!source) throw new Error(`Événement source introuvable: ${argv.from}`);

  const newSlug = String(argv.slug).trim();
  if (!newSlug) throw new Error('--slug requis');
  const existing = await Event.findOne({ slug: newSlug }).lean();
  if (existing) throw new Error(`Un événement avec le slug "${newSlug}" existe déjà (id=${existing._id})`);

  const startsAt = new Date(argv.date);
  if (isNaN(startsAt)) throw new Error('Date invalide');

  const seasonCode = argv.season ? String(argv.season).trim() : source.seasonCode;
  const priceTableKey = `ev:${newSlug}`;

  console.log(`→ Source: ${source.slug} (${source._id}) · venue=${source.venueSlug || '—'} · season=${source.seasonCode} · priceTableKey=${source.priceTableKey || '—'}`);
  console.log(`→ Nouvel événement: ${newSlug} · venue=${source.venueSlug || '—'} · season=${seasonCode} · priceTableKey=${priceTableKey}`);

  if (argv['dry-run']) {
    console.log('🧪 Dry-run — rien n\'est écrit.');
    if (!argv['skip-venue']) console.log(`  · instancierait sièges/zones pour season=${seasonCode} venue=${source.venueSlug || '—'}`);
    if (!argv['skip-tariffs'] && source.priceTableKey) {
      const tariffCount = await Tariff.countDocuments({ priceTableKey: source.priceTableKey });
      const priceCount = await TariffPrice.countDocuments({ priceTableKey: source.priceTableKey });
      console.log(`  · copierait ${tariffCount} Tariff + ${priceCount} TariffPrice vers priceTableKey=${priceTableKey}`);
    }
    if (!argv['skip-custo']) {
      const srcCustoPath = path.join(CUSTOM_EVENTS_DIR, `${source.slug}.json`);
      console.log(fs.existsSync(srcCustoPath)
        ? `  · copierait data/customization/events/${source.slug}.json → ${newSlug}.json`
        : `  · aucun data/customization/events/${source.slug}.json à copier`);
    }
    await mongoose.disconnect();
    return;
  }

  const newEvent = await Event.create({
    slug: newSlug,
    name: argv.name,
    startsAt,
    seasonCode,
    venueSlug: source.venueSlug,
    venueView: source.venueView,
    priceTableKey,
    description: source.description || '',
    qrBank: { provider: 'bank', codes: [] }
  });
  console.log(`✓ Event créé: ${newEvent.slug} (${newEvent._id})`);

  if (!argv['skip-venue']) {
    console.log('→ Instantiation sièges/zones...');
    try {
      execFileSync('node', [INSTANTIATE_VENUE_SCRIPT, `--event=${newSlug}`], { stdio: 'inherit' });
    } catch {
      console.warn('⚠ Échec de l\'instantiation venue — vérifiez manuellement.');
    }
  }

  if (!argv['skip-tariffs']) {
    if (!source.priceTableKey) {
      console.log('ℹ Événement source sans priceTableKey — rien à copier.');
    } else {
      const sourceTariffs = await Tariff.find({ priceTableKey: source.priceTableKey }).lean();
      const sourcePrices = await TariffPrice.find({ priceTableKey: source.priceTableKey }).lean();
      let tariffCount = 0;
      for (const t of sourceTariffs) {
        const { _id, createdAt, updatedAt, __v, ...rest } = t;
        await Tariff.create({ ...rest, priceTableKey });
        tariffCount++;
      }
      let priceCount = 0;
      for (const p of sourcePrices) {
        const { _id, createdAt, updatedAt, __v, ...rest } = p;
        await TariffPrice.create({ ...rest, priceTableKey });
        priceCount++;
      }
      console.log(`✓ Tarifs copiés: ${tariffCount} Tariff + ${priceCount} TariffPrice`);
    }
  }

  if (!argv['skip-custo']) {
    const srcCustoPath = path.join(CUSTOM_EVENTS_DIR, `${source.slug}.json`);
    if (fs.existsSync(srcCustoPath)) {
      fs.mkdirSync(CUSTOM_EVENTS_DIR, { recursive: true });
      const destCustoPath = path.join(CUSTOM_EVENTS_DIR, `${newSlug}.json`);
      fs.copyFileSync(srcCustoPath, destCustoPath);
      console.log(`✓ Personnalisation copiée: data/customization/events/${newSlug}.json`);
    } else {
      console.log(`ℹ Aucune personnalisation à copier (data/customization/events/${source.slug}.json absent).`);
    }
  }

  console.log(`\n✅ Clone terminé. "${newSlug}" n'est PAS en vente (sale=notopen, activity=draft) — vérifiez tarifs/personnalisation puis utilisez publish-event quand prêt.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
