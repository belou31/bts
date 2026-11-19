// src/server.js
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { connectDB } from './loaders/mongoose.js';
import { buildApp } from './loaders/express.js';

// Load provider-specific env after base (doesn't override vars already set by .env or system)
const _provider = process.env.PAYMENT_PROVIDER;
if (_provider) dotenvConfig({ path: `.env.${_provider}` });

await connectDB();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);

const app = await buildApp();

app.set('view engine', 'ejs');
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.set('views', path.resolve(__dirname, 'views'));

  app.listen(PORT, HOST, () => {
  const env = process.env.APP_ENV || 'development';
  console.log(`[server] ${env} listening on http://${HOST}:${PORT}`);
});


