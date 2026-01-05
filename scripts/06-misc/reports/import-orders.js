// scripts/import-orders.js
// Usage:
//   node scripts/import-orders.js /path/orders.csv [--keepIds] [--overwrite] [--forceBooked] [--dryRun]
//
// - --keepIds     : conserve l'ObjectId d'origine (colonne orderId du CSV). Si déjà existant, skip ou --overwrite.
// - --overwrite   : si --keepIds ET l'Order existe, on remplace (lines, meta, etc.)
// - --forceBooked : pour les orders "paid", force Seat.status='booked' quel que soit l'état courant
// - --dryRun      : ne persiste rien, affiche le plan d'import
//
// Prérequis env : MONGO_URI=... [MONGODB_DB=...]
//
// CSV attendu (export-orders.js):
// orderId,createdAt,phase,status,payerFirstName,payerLastName,payerEmail,seasonCode,venueSlug,paymentSplit,totalCents,
// lineIndex,seatId,zoneKey,tariffCode,priceCents,holderFirstName,holderLastName

import fs from 'node:fs';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { Order } from '../../../src/models/Order.js';
import { Seat }  from '../../../src/models/Seat.js';

import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) { console.error('[import-orders] MONGO_URI manquant'); process.exit(1); }

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const KEEP_IDS     = args.includes('--keepIds');
const OVERWRITE    = args.includes('--overwrite');
const FORCE_BOOKED = args.includes('--forceBooked');
const DRY_RUN      = args.includes('--dryRun');

if (!file) {
  console.error('Usage: node scripts/import-orders.js /path/orders.csv [--keepIds] [--overwrite] [--forceBooked] [--dryRun]');
  process.exit(1);
}

// ---------- CSV utils (sans dépendance) ----------
function parseCsvLine(line) {
  // Parse CSV simple avec guillemets/échappement "..."
  const out = [];
  let cur = '';
  let i = 0;
  let inQuotes = false;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i += 2; continue; } // ""
        inQuotes = false; i++; continue;
      } else {
        cur += ch; i++; continue;
      }
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { out.push(cur); cur = ''; i++; continue; }
      cur += ch; i++;
    }
  }
  out.push(cur);
  return out;
}

function toNumberSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function toDateSafe(s) {
  const d = new Date(String(s || ''));
  return isNaN(d.getTime()) ? null : d;
}
const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));


// ---------- Flow / Phase helpers ----------
function looksLikeSeatId(v) {
  // Ex: S1-B-001, n3-H-032…
  return /^[a-z]\d+-[a-z]-\d{3}$/i.test(String(v||'').trim());
}
function normalizeFlow(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'renew') return 'renew';
  if (x === 'subscription' || x === 'sub' || x === 'fanclub' || x === 'public') return 'subscription';
  if (looksLikeSeatId(x)) {
    console.warn(`[import-orders] phase ressemble à un seatId ("${v}") → fallback "subscription"`);
    return 'subscription';
  }
  if (x) console.warn(`[import-orders] phase inconnue "${v}" → fallback "subscription"`);
  return 'subscription';
}
function templateForFlow(flow) {
  return flow === 'renew' ? 'renew' : 'subscription';
}

// ---------- ObjectId helpers ----------
function extractHex24(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Supporte: 24-hex nu, ObjectId("..."), ou une chaîne contenant quelque part un 24-hex
  const direct = /^[a-fA-F0-9]{24}$/.test(str) ? str : null;
  if (direct) return direct;
  const m = str.match(/[a-fA-F0-9]{24}/);
  return m ? m[0] : null;
}
function parseObjectIdOrNull(v) {
  const hex = extractHex24(v);
  if (!hex) return null;
  try { return new mongoose.Types.ObjectId(hex); }
  catch { return null; }
}


// ---------- Lecture CSV et agrégation par orderId ----------
async function readCsvGrouped(path) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let isHeader = true;
  let header = [];
  const byOrder = new Map();

  for await (const line of rl) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    const cols = parseCsvLine(trimmed);

    if (isHeader) {
      header = cols.map(c => c.trim());
      // Optionnel: valider quelques colonnes clés
      const must = ['orderId','createdAt','phase','status','payerEmail','seasonCode','venueSlug','totalCents','lineIndex','seatId','zoneKey','tariffCode','priceCents'];
      const ok = must.every(k => header.includes(k));
      if (!ok) {
        console.error('[import-orders] Header inattendu. Colonnes trouvées:', header.join(','));
        process.exit(1);
      }
      isHeader = false;
      continue;
    }

    const row = Object.create(null);
    for (let i=0;i<cols.length;i++) {
      row[header[i] ?? `_${i}`] = cols[i];
    }

    const oid = String(row.orderId || '').trim();
    if (!oid) continue; // ligne orpheline

    // base order fields
    const base = {
      orderId: oid,
      createdAt: row.createdAt,
      phase: row.phase,
      status: row.status,
      payerFirstName: row.payerFirstName,
      payerLastName:  row.payerLastName,
      payerEmail:     row.payerEmail,
      seasonCode: row.seasonCode,
      venueSlug:  row.venueSlug,
      paymentSplit: row.paymentSplit,
      totalCents: row.totalCents
    };

    const lineObj = {
      lineIndex: toNumberSafe(row.lineIndex),
      seatId: String(row.seatId||''),
      zoneKey: String(row.zoneKey||''),
      tariffCode: String(row.tariffCode||'').toUpperCase(),
      priceCents: toNumberSafe(row.priceCents),
      holderFirstName: String(row.holderFirstName||''),
      holderLastName:  String(row.holderLastName||'')
    };

    if (!byOrder.has(oid)) {
      byOrder.set(oid, { base, lines: [] });
    }
    byOrder.get(oid).lines.push(lineObj);
  }

  // Trier les lignes par lineIndex pour chaque order
  for (const v of byOrder.values()) {
    v.lines.sort((a,b) => a.lineIndex - b.lineIndex);
  }

  return byOrder;
}

// ---------- Import ----------
async function run() {
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
  console.log('[import-orders] connected');

  const groups = await readCsvGrouped(file);
  console.log(`[import-orders] fichier: ${file} — orders agrégés: ${groups.size}`);

  let created = 0, updated = 0, skipped = 0, seatsBooked = 0;

  for (const [oid, pack] of groups.entries()) {
    const b = pack.base;
    const lines = pack.lines;

    // Phase / flow normalisés (enum du modèle)
    const flow = normalizeFlow(b.phase);

    // Construire le document Order
    const createdAt = toDateSafe(b.createdAt);
    const totalCents = toNumberSafe(b.totalCents);
    const paymentSplit = toNumberSafe(b.paymentSplit) || 1;

    const doc = {
      seasonCode: b.seasonCode || null,
      venueSlug:  b.venueSlug  || null,
      phase:      flow,
      groupKey:   `${flow.toUpperCase()}-${b.seasonCode || 'NA'}`,
      payerFirstName: b.payerFirstName || '',
      payerLastName:  b.payerLastName  || '',
      payerEmail:     b.payerEmail     || '',
      paymentSplit,
      lines: lines.map(l => ({
        seatId: l.seatId,
        zoneKey: l.zoneKey || (l.seatId ? String(l.seatId).split('-')[0] : ''),
        tariffCode: l.tariffCode,
        priceCents: l.priceCents,
        holderFirstName: l.holderFirstName,
        holderLastName:  l.holderLastName
      })),
      totalCents,
      status: (b.status || '').toLowerCase() || 'pending',
      paymentProvider: 'import',
      paymentProviderMeta: { importedAt: new Date(), source: 'csv', legacyOrderId: KEEP_IDS ? undefined : oid },
      origin: {
        flow,
        uiPath: flow === 'renew'
          ? '/renew'
          : (b.seasonCode ? `/season/${b.seasonCode}` : '/season'),
        apiPath: '/admin/import'
      },
      mailTemplateKind: templateForFlow(flow),
    };

    if (createdAt) { doc.createdAt = createdAt; doc.updatedAt = createdAt; }

    // Décision per-order : garde l’_id uniquement si c’est un ObjectId valide
    const parsedId = KEEP_IDS ? parseObjectIdOrNull(oid) : null;
    if (KEEP_IDS && !parsedId) {
      const msg = `[import-orders] orderId non-ObjectId dans le CSV: "${oid}"`;
      if (STRICT_IDS) {
        throw new Error(`${msg} (utilise --strictIds)`);
      } else {
        console.warn(`${msg} → fallback sans --keepIds pour cette commande`);
      }
    }
    const keepThisId = !!parsedId;
    
    if (DRY_RUN) {
      console.log(`• [DRY] ${keepThisId ? 'keepId ' : ''}${oid} — ${doc.phase} — ${doc.status} — lines=${doc.lines.length} — total=${doc.totalCents}`);

} else {
      let existing = null;
      if (keepThisId) {
        try { existing = await Order.findById(parsedId); } catch { existing = null; }
       }

      if (existing && !OVERWRITE) {
        skipped++;
        console.log(`↷ skip (exists): ${oid}`);
    } else if (existing && OVERWRITE) {
        // Remplacer l'Order (écrase lines, meta…)
        existing.set(doc);
        await existing.save();
        updated++;
        console.log(`↺ update: ${oid}`);
      } else {
        // Créer
        if (keepThisId) {
          // injecter _id si valide
          doc._id = parsedId;
        } else {
          // mémoriser l'identifiant d'origine si on ne peut pas le garder
          doc.paymentProviderMeta.legacyOrderId = oid;
        }


        await Order.create(doc);
        created++;
        console.log(`✓ insert: ${keepThisId ? oid : '(new id)'} — flow=${flow} — tpl=${templateForFlow(flow)}`);
    }
 }

    // Book seats si paid
    const isPaid = /^paid$/i.test(doc.status) || /^paid$/i.test(b.status || '');
    if (isPaid) {
      const realSeatIds = Array.from(new Set(
        lines.map(l => l.seatId).filter(s => s && !isVirtualZoneSeatId(s))
      ));
      if (realSeatIds.length) {
        if (DRY_RUN) {
          console.log(`  └─ [DRY] book seats: ${realSeatIds.length} ${FORCE_BOOKED ? '(force)' : ''}`);
        } else {
          const q = {
            seasonCode: doc.seasonCode,
            venueSlug:  doc.venueSlug,
            seatId: { $in: realSeatIds }
          };
          if (!FORCE_BOOKED) {
            // Par défaut, on ne touche qu'aux dispo
            q.status = 'available';
          }
          const r = await Seat.updateMany(q, { $set: { status: 'booked' } }, { runValidators: false });
          const mod = r.modifiedCount ?? r.nModified ?? 0;
          seatsBooked += mod;
          console.log(`  └─ booked: ${mod}/${realSeatIds.length} seats (${FORCE_BOOKED ? 'force' : 'available-only'})`);
        }
      }
    }
  }

  console.log(`[import-orders] done. created=${created}, updated=${updated}, skipped=${skipped}, seatsBooked=${seatsBooked}${DRY_RUN ? ' (dryRun)' : ''}`);
  await mongoose.disconnect();
}

run().catch(e => {
  console.error('[import-orders] fatal:', e);
  process.exit(1);
});
