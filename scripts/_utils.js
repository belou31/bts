// scripts/_utils.js
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, existsSync } from 'fs';
import { parse } from 'csv-parse';

export async function connectMongo() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/arena';
  mongoose.set('strictQuery', false);
  await mongoose.connect(uri);
  return mongoose;
}

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
  return (await import(path.resolve(root, p))).default || (await import(path.resolve(root, p)));
}

export async function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const absolute = path.resolve(filePath);
    const inputsDir = path.resolve(process.cwd(), 'data/inputs');
    let source = absolute;
    if (!existsSync(source)) {
      const fallback = path.resolve(inputsDir, filePath);
      if (existsSync(fallback)) source = fallback;
    }
    if (!existsSync(source)) {
      return reject(new Error(`CSV introuvable: ${filePath}`));
    }
    createReadStream(source)
      .pipe(parse({ columns: true, trim: true }))
      .on('data', (r) => rows.push(r))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

export function logDryRun(commit) {
  console.log(commit ? '⚠️  COMMIT activé — écriture en base.' : '🧪 Dry-run — aucune écriture.');
}
