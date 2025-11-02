// src/middlewares/require-scanner.js
import { Buffer } from 'node:buffer';

function parseBasic(header = '') {
  try {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return { login: '', password: '' };
    return {
      login: decoded.slice(0, idx),
      password: decoded.slice(idx + 1)
    };
  } catch {
    return { login: '', password: '' };
  }
}

export function requireScanner(req, res, next) {
  const envToken = String(process.env.SCANNER_TOKEN || '').trim();
  const envLogin = String(process.env.SCAN_LOGIN || '').trim();
  const envPassword = String(process.env.SCAN_PASSWORD || '').trim();

  const header = String(req.headers.authorization || '');
  let token = '';
  let login = '';
  let password = '';

  if (/^Bearer\s+/i.test(header)) {
    token = header.replace(/^Bearer\s+/i, '').trim();
  } else if (/^Basic\s+/i.test(header)) {
    ({ login, password } = parseBasic(header));
  }

  token = token || String(req.query.token || req.query.bearer || req.body?.token || '').trim();

  if (!login && !password) {
    const qLogin = String(req.query.login || req.query.user || req.body?.login || '').trim();
    const qPassword = String(req.query.password || req.query.pass || req.body?.password || '').trim();
    if (qLogin && qPassword) {
      login = qLogin;
      password = qPassword;
    }
  }

  let ok = false;
  if (token && envToken && token === envToken) ok = true;
  if (!ok && login && envLogin && envPassword && login === envLogin && password === envPassword) ok = true;

  if (!ok) {
    if (!res.headersSent) {
      res.set('WWW-Authenticate', 'Basic realm="BTS Control", charset="UTF-8"');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  req.scannerAuth = { token, login };
  next();
}

export default requireScanner;
