#!/usr/bin/env node
/**
 * Sets (or clears) an event's explicit templateTheme override — checked
 * BEFORE the customization-layered "theme" key (see resolveThemeForOrder in
 * src/services/customization.js) by both buildTicketsPdfBuffer
 * (tickets-pdf.js) and renderOrderEmail (mailer.js), so the same value
 * drives both the ticket PDF and the confirmation email for this event.
 * Resolution still falls through to the existing customization system when
 * this is unset (null) — this is an additional, more specific override, not
 * a replacement for it.
 *
 * Usage:
 *   node scripts/04-event-management/set-event-theme.js --event=<slug|id> --theme=<value> [--dry-run]
 *   node scripts/04-event-management/set-event-theme.js --event=<slug|id> --clear [--dry-run]
 *
 * A theme value only does anything once a matching file exists —
 * tickets/<file>.<theme>.svg and/or email/<file>.<theme>.html, staged via
 * set-ticket-template.js / set-email-template.js --theme=<value>.
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
dotenv.config();

import { Event } from '../../src/models/Event.js';

const argv = yargs(hideBin(process.argv))
  .option('event', { type: 'string', demandOption: true, desc: 'Slug ou ObjectId de l\'événement' })
  .option('theme', { type: 'string', desc: 'Valeur du thème (ex: ads, halloween)' })
  .option('clear', { type: 'boolean', default: false, desc: 'Efface le thème (retombe sur le système de customization)' })
  .option('dry-run', { type: 'boolean', default: false, desc: 'Aperçu sans écriture' })
  .help()
  .argv;

function resolveEventQuery(ref) {
  return /^[0-9a-f]{24}$/i.test(ref) ? { _id: ref } : { slug: ref };
}

async function main() {
  if (!argv.clear && !argv.theme) throw new Error('--theme=<value> ou --clear requis');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant');
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, connectOpts);

  const ev = await Event.findOne(resolveEventQuery(String(argv.event).trim())).lean();
  if (!ev) throw new Error(`Événement introuvable: ${argv.event}`);

  const nextTheme = argv.clear ? null : String(argv.theme).trim();
  console.log(`→ Event: ${ev.slug} · templateTheme actuel="${ev.templateTheme || '∅'}" → nouveau="${nextTheme || '∅'}"`);

  if (argv['dry-run']) {
    console.log('\n🧪 Dry-run — rien n\'est écrit.');
    await mongoose.disconnect();
    return;
  }

  await Event.updateOne({ _id: ev._id }, { $set: { templateTheme: nextTheme } });
  console.log(`\n✅ templateTheme mis à jour pour "${ev.slug}".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message || e);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
