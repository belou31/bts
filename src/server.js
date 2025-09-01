// src/server.js
import 'dotenv/config';                 // ← plus simple et sûr
import { connectDB } from './loaders/mongoose.js';
import { buildApp } from './loaders/express.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);

await connectDB();                      // utilise process.env.MONGO_URI
const app = await buildApp();           // construit l'Express app

app.listen(PORT, HOST, () => {
  console.log(`[server] ${process.env.APP_ENV || 'dev'} listening on http://${HOST}:${PORT}`);
});
