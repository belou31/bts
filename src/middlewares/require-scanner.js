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

function decodeQueryValuePreservePlus(rawValue = '') {
  const raw = String(rawValue || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%2B'));
  } catch {
    return raw;
  }
}

function extractQueryParamPreservePlus(req, keys = []) {
  const wantedKeys = new Set(
    (Array.isArray(keys) ? keys : [keys])
      .map((key) => String(key || '').trim())
      .filter(Boolean)
  );
  if (!wantedKeys.size) return '';

  const originalUrl = String(req.originalUrl || req.url || '');
  const qsIndex = originalUrl.indexOf('?');
  if (qsIndex < 0) return '';

  const queryString = originalUrl.slice(qsIndex + 1);
  if (!queryString) return '';

  for (const segment of queryString.split('&')) {
    if (!segment) continue;
    const eqIndex = segment.indexOf('=');
    const rawKey = eqIndex >= 0 ? segment.slice(0, eqIndex) : segment;
    const rawValue = eqIndex >= 0 ? segment.slice(eqIndex + 1) : '';
    let decodedKey = rawKey;
    try {
      decodedKey = decodeURIComponent(rawKey.replace(/\+/g, '%20'));
    } catch {}
    if (!wantedKeys.has(decodedKey)) continue;
    const value = String(decodeQueryValuePreservePlus(rawValue) || '').trim();
    if (value) return value;
  }

  return '';
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

  const queryToken = extractQueryParamPreservePlus(req, ['token', 'bearer']);
  token = token || queryToken || String(req.query.token || req.query.bearer || req.body?.token || '').trim();

  if (!login && !password) {
    const qLogin = extractQueryParamPreservePlus(req, ['login', 'user'])
      || String(req.query.login || req.query.user || req.body?.login || '').trim();
    const qPassword = extractQueryParamPreservePlus(req, ['password', 'pass'])
      || String(req.query.password || req.query.pass || req.body?.password || '').trim();
    if (qLogin && qPassword) {
      login = qLogin;
      password = qPassword;
    }
  }

  let ok = false;
  if (token && envToken && token === envToken) ok = true;
  if (!ok && login && envLogin && envPassword && login === envLogin && password === envPassword) ok = true;

  if (!ok) {
    const isApiPath = String(req.path || '').includes('/api/');
    if (!res.headersSent && !isApiPath) {
      res.set('WWW-Authenticate', 'Basic realm="BTS Control", charset="UTF-8"');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  req.scannerAuth = { token, login };
  next();
}

export default requireScanner;
