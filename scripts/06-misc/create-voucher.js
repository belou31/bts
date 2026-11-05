/**
 * Crée un bon cadeau (invitation) et imprime le lien à mettre dans le QR.
 *
 * Émission côté club (don). L'achat d'un bon par un tiers viendra plus tard :
 * le retrait est identique dans les deux cas, seule l'origine change.
 *
 * Usage:
 *   node scripts/06-misc/create-voucher.js --total=4 --label="École Jean Moulin" \
 *     [--code=VCH-XXXX] [--max-per-event=2] [--expires=2027-06-30] \
 *     [--zones=S1,S3] [--events=match01-2027] [--seasons=test8-2027] [--tags=regular] \
 *     [--tariff=INVITATION] [--dry-run]
 *
 * Environment:
 *   - MONGO_URI ou MONGODB_URI (requis)
 *   - JWT_SECRET (requis pour imprimer le lien)
 *   - APP_URL (base du lien)
 */
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { Voucher } from '../../src/models/Voucher.js';
import { signVoucherToken } from '../../src/services/vouchers.js';

import dotenv from 'dotenv';
dotenv.config();

const list = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);

// Sans I/O/0/1 : un code se lit au téléphone et se recopie à la main.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode() {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return `VCH-${pick()}-${pick()}`;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('total', { type: 'number', demandOption: true, desc: 'Nombre de places offertes' })
    .option('label', { type: 'string', default: '', desc: 'Bénéficiaire (école, personne…)' })
    .option('code', { type: 'string', desc: 'Code imprimé (généré si absent)' })
    .option('max-per-event', { type: 'number', default: 0, desc: 'Plafond par match (0 = aucun)' })
    .option('expires', { type: 'string', desc: 'Échéance AAAA-MM-JJ' })
    .option('zones', { type: 'string', desc: 'Zones autorisées (ou catégories), séparées par des virgules' })
    .option('events', { type: 'string', desc: 'Slugs de matchs explicites' })
    .option('seasons', { type: 'string', desc: 'Codes saison autorisés' })
    .option('tags', { type: 'string', desc: 'Étiquettes d\'évènement (Event.tags)' })
    .option('from', { type: 'string', desc: 'Début de fenêtre (ISO)' })
    .option('to', { type: 'string', desc: 'Fin de fenêtre (ISO)' })
    .option('tariff', { type: 'string', default: 'INVITATION', desc: 'Code tarif porté par les lignes' })
    .option('dry-run', { type: 'boolean', default: false })
    .help().argv;

  if (!(argv.total > 0)) throw new Error('--total doit être un entier positif');

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI / MONGODB_URI requis');
  const opts = {};
  if (process.env.MONGODB_DB) opts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(uri, opts);

  const code = String(argv.code || generateCode()).toUpperCase();
  if (await Voucher.findOne({ code }).lean()) throw new Error(`Le code ${code} existe déjà`);

  const doc = {
    code,
    label: argv.label || '',
    balance: { total: Math.floor(argv.total), used: 0 },
    maxPerEvent: Math.max(0, Math.floor(argv['max-per-event'] || 0)),
    eligibility: {
      events: list(argv.events),
      rules: {
        seasonCodes: list(argv.seasons),
        tags: list(argv.tags),
        from: argv.from ? new Date(argv.from) : null,
        to: argv.to ? new Date(argv.to) : null
      }
    },
    allowedZones: list(argv.zones),
    tariffCode: String(argv.tariff || 'INVITATION').toUpperCase(),
    expiresAt: argv.expires ? new Date(argv.expires) : null,
    status: 'active',
    origin: { kind: 'donation' }
  };

  if (argv['dry-run']) {
    console.log('— dry-run —');
    console.log(JSON.stringify(doc, null, 2));
    await mongoose.disconnect();
    return;
  }

  const saved = await Voucher.create(doc);
  console.log('✅ Bon créé :', saved.code, `(${saved.balance.total} place(s))`);

  try {
    const token = signVoucherToken(saved.code, { expiresAt: saved.expiresAt });
    const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
    console.log('🔗 Lien à encoder dans le QR :');
    console.log(`   ${base}/voucher?id=${token}`);
  } catch (err) {
    console.warn('⚠ Lien non généré :', err.message);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* ignore */ }
});
