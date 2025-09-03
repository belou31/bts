// scripts/_env.js
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ⚠️ override:true pour écraser toute MONGO_URI héritée du shell
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

// (optionnel) petit log masqué si tu veux vérifier
if (process.env.DEBUG_ENV === '1') {
  console.log('[env] MONGO_URI=', (process.env.MONGO_URI||'').replace(/:[^@]*@/, '://***@'));
  console.log('[env] JWT_SECRET len=', (process.env.JWT_SECRET||'').length);
}
