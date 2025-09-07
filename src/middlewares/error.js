// src/middlewares/error.js
export default function errorHandler(err, _req, res, _next) {
  const status = err.status || err.code || 500;
  const msg = err.message || 'Internal error';
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: msg });
}
