// scripts/_utils.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Chargé ici plutôt que dans chaque script : la moitié des appelants de
// connectMongo() ne le faisaient pas, et repartaient donc sur l'URI de repli
// ci-dessous — une base vide, où toute requête « ne trouve rien » au lieu
// d'échouer. Le diagnostic était trompeur à tous les coups.
dotenv.config();
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { existsSync, promises as fsPromises } from 'fs';

export async function connectMongo() {
  // Pas d'URI de repli : « mongodb://localhost:27017/arena » était codé en dur
  // et se connectait sans broncher à une base inexistante. Un script y lisait
  // zéro siège, zéro commande, et l'annonçait comme un résultat. Mieux vaut
  // refuser de démarrer que travailler sur le vide.
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI / MONGODB_URI non défini (ni dans l\'environnement, ni dans .env) — connexion refusée.');
  }
  const connectOpts = {};
  if (process.env.MONGODB_DB) connectOpts.dbName = process.env.MONGODB_DB;
  mongoose.set('strictQuery', false);
  await mongoose.connect(uri, connectOpts);
  return mongoose;
}

const requireFromFile = createRequire(import.meta.url);

export function loadModels() {
  const models = {};
  models.Event  = requireFromRoot('src/models/Event.js').Event;
  models.Order  = requireFromRoot('src/models/Order.js').Order;
  models.Ticket = requireFromRoot('src/models/Ticket.js').Ticket;
  return models;
}

function requireFromRoot(p) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const modulePath = path.resolve(root, p);
  const mod = requireFromFile(modulePath);
  return mod?.default || mod;
}

function parseCsvLine(line, delimiter = ',') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(cell => cell.trim());
}

export async function readCsv(filePath) {
  const absolute = path.resolve(filePath);
  const inputsDir = path.resolve(process.cwd(), 'data/inputs');
  let source = absolute;
  if (!existsSync(source)) {
    const fallback = path.resolve(inputsDir, filePath);
    if (existsSync(fallback)) source = fallback;
  }
  if (!existsSync(source)) {
    throw new Error(`CSV introuvable: ${filePath}`);
  }

  const content = await fsPromises.readFile(source, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length);
  if (!lines.length) return [];

  const header = parseCsvLine(lines.shift());
  const rows = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((key, idx) => {
      if (!key) return;
      row[key] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

export function logDryRun(commit) {
  console.log(commit ? '⚠️  COMMIT activé — écriture en base.' : '🧪 Dry-run — aucune écriture.');
}
