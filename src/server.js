// src/server.js
import 'dotenv/config';
import { connectDB } from './loaders/mongoose.js';
import { buildApp } from './loaders/express.js';

await connectDB();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);

const app = await buildApp();

app.set('view engine', 'ejs');
//app.set('views', path.join(VIEWS_DIR, 'views'));

  app.listen(PORT, HOST, () => {
  const env = process.env.APP_ENV || 'development';
  console.log(`[server] ${env} listening on http://${HOST}:${PORT}`);
});



