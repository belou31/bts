#!/usr/bin/env node
/**
 * Import tariff prices (list or matrix) into a reusable catalog.
 *
 * Usage:
 *   node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> <csvPath>
 *     [--venue=<slug>] [--format=list|matrix] [--delimiter=,|;] [--append] [--dry-run]
 *
 * Supported CSV formats:
 *   LIST   : zoneKey,metaZone,tariffCode,priceCents|priceEuro
 *            Un SEUL fichier pour les deux : chaque ligne remplit soit
 *            zoneKey, soit metaZone — jamais les deux, jamais aucune.
 *            Les lignes commençant par # sont ignorées.
 *   MATRIX : first column tariffCode, subsequent columns zone keys
 *
 * Notes:
 *   - By default the script clears the existing catalog entries (same slug/venue) before import.
 *     Use --append to upsert without clearing.
 *   - Prices can be expressed in cents (18000) or euros (180,00 / 180.00).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';

import dotenv from 'dotenv';
dotenv.config();

import { Tariff } from '../../src/models/Tariff.js';
import { TariffPriceCatalog } from '../../src/models/TariffPriceCatalog.js';
import { ZoneCatalog } from '../../src/models/ZoneCatalog.js';
import { serializeChannelList } from '../../src/utils/channel-scopes.js';

const INPUT_DIR = path.resolve(process.cwd(), 'data/inputs');

function usage() {
  console.error('Usage: node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> <csvPath> [--venue=<slug>] [--format=list|matrix] [--delimiter=,|;] [--append] [--dry-run]');
  process.exit(1);
}

function resolveInputFile(p) {
  if (!p) return p;
  const absolute = path.resolve(p);
  if (fs.existsSync(absolute)) return absolute;
  const fromInputs = path.resolve(INPUT_DIR, p);
  if (fs.existsSync(fromInputs)) return fromInputs;
  return absolute;
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find(token => token.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function stripBOM(s) {
  if (!s) return s;
  return s.replace(/^\uFEFF/, '');
}

function detectDelimiter(line, explicit) {
  if (explicit === ',' || explicit === ';') return explicit;
  let comma = 0;
  let semi = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ',') comma++;
      else if (ch === ';') semi++;
    }
  }
  return semi > comma ? ';' : ',';
}

function parseCSVLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseEuroToCents(s) {
  if (s == null || s === '') return null;
  const cleaned = String(s).trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (Number.isFinite(n)) return Math.round(n * 100);
  return null;
}

function parsePriceCell(val) {
  if (val == null) return null;
  const sv = String(val).trim();
  if (!sv) return null;
  if (/^\d+$/.test(sv) && Number(sv) > 999) return Number(sv);
  const cents = parseEuroToCents(sv);
  return Number.isFinite(cents) ? cents : null;
}

function parseExplicitCents(val) {
  if (val == null) return null;
  const cleaned = String(val).trim().replace(/\s/g, '');
  if (!cleaned) return null;
  if (/^-?\d+$/.test(cleaned)) return Number(cleaned);
  const normalized = cleaned.replace(/,/g, '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function headersLC(arr) {
  return arr.map(h => stripBOM(h).trim().toLowerCase());
}

function detectFormat(hdrLC, explicit) {
  if (explicit === 'list' || explicit === 'matrix') return explicit;
  const first = hdrLC[0] || '';
  const hasListSig =
    hdrLC.includes('zonekey') ||
    hdrLC.includes('zone') ||
    // Une grille entièrement par méta-zone n'a pas de colonne zoneKey.
    hdrLC.includes('metazone') ||
    hdrLC.includes('category') ||
    hdrLC.includes('categorie') ||
    hdrLC.includes('pricecents') ||
    hdrLC.includes('priceeuro') ||
    hdrLC.includes('prix') ||
    hdrLC.includes('prix_euro');

  if (hasListSig) return 'list';
  if (['tariffcode', 'code', 'tariff'].includes(first)) return 'matrix';
  const hasTariffFirst = ['tariffcode', 'code', 'tariff'].some(k => hdrLC.includes(k));
  if (hasTariffFirst) return 'matrix';
  return null;
}

async function loadEntriesFromCsv(resolvedCsv, delimiter, explicitFormat) {
  console.log(`[import-tariff-prices] Streaming CSV from ${resolvedCsv}`);
  const rl = readline.createInterface({
    input: fs.createReadStream(resolvedCsv, 'utf8'),
    crlfDelay: Infinity
  });
  rl.on('error', (err) => {
    console.error('[import-tariff-prices] CSV stream error:', err?.message || err);
  });

  const headerInfo = { header: null, headerLC: null, mode: null, hasChannels: false, hasPartnerPrice: false, hasCurrency: false };
  const entries = [];
  let rowCount = 0;
  let skips = 0;

  for await (const rawLine0 of rl) {
    const rawLine = rawLine0.replace(/\r$/, '');
    if (!rawLine.trim()) continue;
    // Lignes de commentaire, comme dans les autres gabarits CSV du projet.
    // Sans cela, un gabarit commenté voyait sa première ligne `# zoneKey,…`
    // prise pour l'en-tête : la colonne s'appelait « # zonekey », plus aucune
    // ligne n'était reconnue, et l'import rejetait tout le fichier.
    if (rawLine.trimStart().startsWith('#')) continue;

    if (!headerInfo.header) {
      headerInfo.header = parseCSVLine(rawLine, delimiter).map(stripBOM);
      headerInfo.headerLC = headersLC(headerInfo.header);
      headerInfo.mode = detectFormat(headerInfo.headerLC, explicitFormat);
      headerInfo.hasChannels = headerInfo.headerLC.some((name) =>
        ['channels', 'channel', 'scopes'].includes(name)
      );
      headerInfo.hasPartnerPrice = headerInfo.headerLC.some((name) =>
        ['partnerpricecents', 'partnerprice', 'partnerpriceeuro'].includes(name)
      );
      headerInfo.hasCurrency = headerInfo.headerLC.includes('currency');
      if (!headerInfo.mode) {
        throw new Error(`Impossible de détecter le format CSV. En-têtes: ${headerInfo.header.join(' | ')}`);
      }
      console.log(`[import-tariff-prices] header columns = ${headerInfo.header.join(', ')}`);
      console.log(`[import-tariff-prices] format=${headerInfo.mode}`);
      continue;
    }

    const cells = parseCSVLine(rawLine, delimiter);
    rowCount++;

    if (headerInfo.mode === 'list') {
      const map = Object.fromEntries(headerInfo.headerLC.map((name, idx) => [name, cells[idx]]));
      const zoneKey = String(map.zonekey || map.zone || '').trim().toUpperCase();
      // Une ligne vise SOIT une zone, SOIT une méta-zone : écrire la
      // grille une fois pour « CAT2 » plutôt que de la recopier sur S1, S3, N.
      const metaZone = String(map.metazone || map.category || map.categorie || '').trim().toUpperCase();
      const tariffCode = String(map.tariffcode || map.code || '').trim().toUpperCase();
      const rawPriceCents = map.pricecents;
      const rawPrice = rawPriceCents ?? map.priceeuro ?? map.prix ?? map.prix_euro ?? map.price;
      const rawPartnerPriceCents = map.partnerpricecents;
      const rawPartnerPrice = rawPartnerPriceCents ?? map.partnerpriceeuro ?? null;
      const currency = headerInfo.hasCurrency
        ? (String(map.currency || '').trim().toUpperCase() || 'EUR')
        : 'EUR';
      const priceCents = rawPriceCents !== undefined && rawPriceCents !== null && rawPriceCents !== ''
        ? parseExplicitCents(rawPriceCents)
        : parsePriceCell(rawPrice);
      if (Boolean(zoneKey) === Boolean(metaZone)) {
        console.warn(`[import-tariff-prices] Ligne ${rowCount}: renseigner zoneKey OU metaZone, pas les deux ni aucun (zone=${zoneKey}, méta-zone=${metaZone}) → ignorée`);
        skips++;
        continue;
      }
      if (!tariffCode || !Number.isFinite(priceCents)) {
        console.warn(`[import-tariff-prices] Ligne ${rowCount}: données incomplètes (zone=${zoneKey || metaZone}, tarif=${tariffCode}, prix=${rawPrice}) → ignorée`);
        skips++;
        continue;
      }
      const channelsRaw = headerInfo.hasChannels
        ? (map.channels || map.channel || map.scopes || '')
        : '';
      const parsedChannels = headerInfo.hasChannels ? serializeChannelList(channelsRaw) : undefined;
      entries.push({
        zoneKey: zoneKey || null,
        metaZone: metaZone || null,
        tariffCode,
        priceCents,
        partnerPriceCents: headerInfo.hasPartnerPrice
          ? (parseExplicitCents(rawPartnerPriceCents) ?? parsePriceCell(rawPartnerPrice) ?? null)
          : null,
        currency,
        channels: parsedChannels,
        channelsDefined: headerInfo.hasChannels
      });
    } else {
      const hdr = headerInfo.header;
      const tariffCode = String(stripBOM(cells[0] || '')).trim().toUpperCase();
      if (!tariffCode) {
        console.warn(`[import-tariff-prices] Ligne ${rowCount}: Tarif vide → ignoré`);
        skips++;
        continue;
      }
      for (let idx = 1; idx < hdr.length; idx++) {
        const zoneKey = String(stripBOM(hdr[idx] || '')).trim().toUpperCase();
        if (!zoneKey) continue;
        const priceCents = parsePriceCell(cells[idx]);
        if (!Number.isFinite(priceCents)) continue;
        entries.push({ zoneKey, tariffCode, priceCents, partnerPriceCents: null, currency: 'EUR', channelsDefined: false });
      }
    }
  }

  return {
    entries,
    rowCount,
    skips,
    format: headerInfo.mode,
    header: headerInfo.header
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const catalogSlugRaw = argv[0];
  const csvPath = argv[1];
  if (!catalogSlugRaw || !csvPath) usage();

  const catalogSlug = String(catalogSlugRaw).trim().toLowerCase();
  if (!catalogSlug) usage();

  const venueOpt = optionValue(argv, 'venue');
  const explicitFormat = optionValue(argv, 'format');
  const explicitDelim = optionValue(argv, 'delimiter');
  const append = hasFlag(argv, 'append');
  const dryRun = hasFlag(argv, 'dry-run');
  const serialWrites = hasFlag(argv, 'serial') || hasFlag(argv, 'no-bulk');

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI (ou MONGODB_URI) manquant dans l’environnement');
    process.exit(1);
  }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  await mongoose.connect(mongoUri, connectOpts);

  const resolvedCsv = resolveInputFile(csvPath);
  if (!fs.existsSync(resolvedCsv)) {
    console.error(`CSV introuvable: ${csvPath} (cherché aussi dans data/inputs)`);
    process.exit(1);
  }

  const firstLine = fs.readFileSync(resolvedCsv, 'utf8').split(/\r?\n/).find(l => l.trim().length);
  if (!firstLine) {
    console.error('CSV vide ou invalide');
    process.exit(1);
  }
  const delimiter = detectDelimiter(firstLine, explicitDelim);
  console.log(`[import-tariff-prices] delimiter="${delimiter}"`);

  let parseResult;
  try {
    parseResult = await loadEntriesFromCsv(resolvedCsv, delimiter, explicitFormat);
  } catch (err) {
    console.error('[import-tariff-prices] Erreur lecture CSV:', err?.message || err);
    await mongoose.disconnect();
    process.exit(1);
  }
  const { entries, rowCount, skips } = parseResult;
  console.log(`[import-tariff-prices] Parsed rows=${rowCount} entries=${entries.length} skips=${skips}`);

  if (!entries.length) {
    console.error('[import-tariff-prices] Aucune donnée exploitable.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Tariff consistency check
  const uniqueTariffs = [...new Set(entries.map(e => e.tariffCode))];
  console.time('[import-tariff-prices] load-known-tariffs');
  const knownTariffs = await Tariff.find({ code: { $in: uniqueTariffs } }).select({ code: 1 }).lean();
  console.timeEnd('[import-tariff-prices] load-known-tariffs');
  const knownSet = new Set(knownTariffs.map(t => t.code));
  const missingTariffs = uniqueTariffs.filter(code => !knownSet.has(code));
  if (missingTariffs.length) {
    console.warn(`[import-tariff-prices] Attention: ${missingTariffs.length} tarifs absents du catalogue Tariff: ${missingTariffs.join(', ')}`);
  }

  const venueSlug = venueOpt ? String(venueOpt).trim() || null : null;

  // Cohérence des zones — même exigence que set-zone-meta.js.
  //
  // Une ligne visant une zone qui n'existe pas s'importe sans broncher puis ne
  // s'applique à aucun siège : la zone reste sans tarif, donc non sélectionnable
  // à l'achat, sans que rien ne l'ait signalé.
  //
  // Le cas le plus fréquent est d'avoir mis une MÉTA-ZONE dans la colonne
  // zoneKey (l'en-tête du gabarit commence par `zoneKey`, et la variante
  // méta-zone n'y est qu'en commentaire). C'est une erreur sans ambiguïté :
  // on refuse l'import plutôt que de produire un catalogue inopérant.
  if (venueSlug) {
    const catalogZones = await ZoneCatalog.find({ venueSlug }, 'key metaZone').lean();
    if (!catalogZones.length) {
      console.warn(`[import-tariff-prices] Aucune zone au catalogue de "${venueSlug}" : contrôle des zones ignoré.`);
    } else {
      const knownZones = new Set(catalogZones.map(z => String(z.key || '').toUpperCase()));
      const knownMetaZones = new Set(
        catalogZones.map(z => String(z.metaZone || '').toUpperCase()).filter(Boolean)
      );

      const usedZones = [...new Set(entries.map(e => String(e.zoneKey || '').toUpperCase()).filter(Boolean))];
      const metaInZoneColumn = usedZones.filter(k => !knownZones.has(k) && knownMetaZones.has(k));
      const unknownZones = usedZones.filter(k => !knownZones.has(k) && !knownMetaZones.has(k));

      // On signale TOUT avant de s'arrêter : s'arrêter au premier problème
      // ferait relancer l'import autant de fois qu'il y a d'erreurs.
      if (unknownZones.length) {
        console.warn(`[import-tariff-prices] ⚠ Zone(s) inconnue(s) au catalogue de "${venueSlug}" : ${unknownZones.join(', ')}`);
        console.warn('    Ces lignes ne s\'appliqueront à aucun siège.');
        if (knownMetaZones.size) {
          console.warn(`    Méta-zones existantes sur ce lieu : ${[...knownMetaZones].sort().join(', ')}`);
        }
      }
      if (metaInZoneColumn.length) {
        console.error(`[import-tariff-prices] ❌ ${metaInZoneColumn.join(', ')} : ce sont des MÉTA-ZONES de "${venueSlug}", pas des zones.`);
        console.error('    Elles sont dans la colonne zoneKey ; elles doivent être dans la colonne metaZone.');
        console.error('    En-tête attendu pour une grille par méta-zone : metaZone,tariffCode,priceCents');
        console.error('    En l\'état, aucune zone du groupe ne recevrait de tarif : import interrompu.');
        await mongoose.disconnect();
        process.exit(1);
      }

      const usedMetaZones = [...new Set(entries.map(e => String(e.metaZone || '').toUpperCase()).filter(Boolean))];
      const orphanMetaZones = usedMetaZones.filter(c => !knownMetaZones.has(c));
      if (orphanMetaZones.length) {
        console.warn(`[import-tariff-prices] ⚠ Méta-zone(s) qu'aucune zone de "${venueSlug}" ne porte : ${orphanMetaZones.join(', ')}`);
        console.warn(`    Rattacher des zones : set-zone-meta.js --venue=${venueSlug} --meta=<META> --zones=<A,B>`);
      }
    }
  }

  if (dryRun) {
    console.log('[import-tariff-prices] Dry-run terminé. Aucun write effectué.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!append) {
    console.time('[import-tariff-prices] deleteMany');
    const delRes = await TariffPriceCatalog.deleteMany({ catalogSlug, venueSlug });
    console.log(`[import-tariff-prices] Cleared ${delRes.deletedCount} existing entries for catalog="${catalogSlug}" venue="${venueSlug || '∅'}"`);
    console.timeEnd('[import-tariff-prices] deleteMany');
  }

  let upserts = 0;
  if (serialWrites) {
    console.log(`[import-tariff-prices] Serial write mode (${entries.length} updates)`);
    console.time('[import-tariff-prices] serial-writes');
    for (const entry of entries) {
      const updateSet = {
        catalogSlug,
        venueSlug,
        zoneKey: entry.zoneKey,
        metaZone: entry.metaZone ?? null,
        tariffCode: entry.tariffCode,
        priceCents: entry.priceCents,
        currency: entry.currency || 'EUR',
        ...(entry.partnerPriceCents != null ? { partnerPriceCents: entry.partnerPriceCents } : {})
      };
      const updateDoc = { $set: updateSet };
      if (entry.channelsDefined) {
        if (entry.channels && entry.channels.length) {
          updateSet.channels = entry.channels;
        } else {
          updateDoc.$unset = { channels: '' };
        }
      }
      const res = await TariffPriceCatalog.updateOne(
        {
          catalogSlug,
          venueSlug,
          zoneKey: entry.zoneKey,
          metaZone: entry.metaZone ?? null,
          tariffCode: entry.tariffCode
        },
        updateDoc,
        { upsert: true }
      );
      if ((res.upsertedCount ?? 0) > 0 || (res.modifiedCount ?? 0) > 0) upserts++;
    }
    console.timeEnd('[import-tariff-prices] serial-writes');
  } else {
    const bulkOps = entries.map(entry => {
      const updateSet = {
        catalogSlug,
        venueSlug,
        zoneKey: entry.zoneKey,
        metaZone: entry.metaZone ?? null,
        tariffCode: entry.tariffCode,
        priceCents: entry.priceCents,
        currency: entry.currency || 'EUR',
        ...(entry.partnerPriceCents != null ? { partnerPriceCents: entry.partnerPriceCents } : {})
      };
      const updateDoc = { $set: updateSet };
      if (entry.channelsDefined) {
        if (entry.channels && entry.channels.length) {
          updateSet.channels = entry.channels;
        } else {
          updateDoc.$unset = { channels: '' };
        }
      }
      return {
        updateOne: {
          filter: {
            catalogSlug,
            venueSlug,
            zoneKey: entry.zoneKey,
            metaZone: entry.metaZone ?? null,
            tariffCode: entry.tariffCode
          },
          update: updateDoc,
          upsert: true
        }
      };
    });

    console.time('[import-tariff-prices] bulk-write');
    const bulkRes = await TariffPriceCatalog.bulkWrite(bulkOps, { ordered: false });
    console.timeEnd('[import-tariff-prices] bulk-write');
    upserts = (bulkRes.upsertedCount || 0) + (bulkRes.modifiedCount || 0);
  }
  console.log(`[import-tariff-prices] Upserts=${upserts} (catalog="${catalogSlug}", venue="${venueSlug || '∅'}")`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async err => {
  console.error('[import-tariff-prices] Erreur:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
