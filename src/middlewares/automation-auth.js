// src/middlewares/automation-auth.js
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.AUTOMATION_JWT_SECRET || '';
const JWT_ISSUER = process.env.AUTOMATION_JWT_ISSUER || undefined;
const JWT_AUDIENCE = process.env.AUTOMATION_JWT_AUDIENCE || undefined;

const allowedIpRules = parseAllowedIpList(process.env.AUTOMATION_ALLOWED_IPS);

function parseAllowedIpList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeIp(ip) {
  if (!ip) return '';
  let out = String(ip).trim();
  if (out.startsWith('::ffff:')) {
    out = out.slice(7);
  } else if (out === '::1') {
    out = '127.0.0.1';
  }
  return out;
}

function wildcardToRegExp(rule) {
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function isIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

function ipToInt(ip) {
  if (!isIPv4(ip)) return null;
  return ip
    .split('.')
    .map((n) => Number(n) & 255)
    .reduce((acc, octet) => ((acc << 8) + octet) >>> 0, 0);
}

function matchesCidr(ip, rule) {
  const [range, bitsStr] = rule.split('/');
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt == null || rangeInt == null) return false;
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) & 0xffffffff) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function matchesIpRule(ip, rule) {
  if (rule === '*') return true;
  if (rule.includes('/')) return matchesCidr(ip, rule);
  if (rule.includes('*')) {
    const regex = wildcardToRegExp(rule);
    return regex.test(ip);
  }
  return ip === rule;
}

function isIpAllowed(ip) {
  if (!allowedIpRules.length) return true;
  if (!ip) return false;
  return allowedIpRules.some((rule) => matchesIpRule(ip, rule));
}

function extractToken(req) {
  const authHeader = req.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const headerToken = req.get('x-automation-token');
  if (headerToken) return headerToken.trim();
  if (req.query?.token) return String(req.query.token).trim();
  return null;
}

function parseScopes(claims) {
  if (!claims) return [];
  if (Array.isArray(claims.scopes)) {
    return claims.scopes.map(String);
  }
  if (Array.isArray(claims.scope)) {
    return claims.scope.map(String);
  }
  if (typeof claims.scopes === 'string') {
    return claims.scopes
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof claims.scope === 'string') {
    return claims.scope
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function buildVerifyOptions() {
  const options = {};
  if (JWT_ISSUER) options.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) options.audience = JWT_AUDIENCE;
  return options;
}

function hasScope(auth, scope) {
  if (!scope) return true;
  if (!auth) return false;
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
  if (scopes.includes('*') || scopes.includes('automation:*')) return true;
  return scopes.includes(scope);
}

export function hasAnyScope(auth, requiredScopes = []) {
  if (!requiredScopes || requiredScopes.length === 0) return true;
  return requiredScopes.some((scope) => hasScope(auth, scope));
}

export function hasAllScopes(auth, requiredScopes = []) {
  if (!requiredScopes || requiredScopes.length === 0) return true;
  return requiredScopes.every((scope) => hasScope(auth, scope));
}

export function automationAuth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(503).json({ error: 'Automation API disabled (missing secret).' });
  }

  const requesterIp = normalizeIp(req.ip || req.connection?.remoteAddress || '');
  if (!isIpAllowed(requesterIp)) {
    return res.status(403).json({ error: 'Forbidden: IP not allowed.' });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, buildVerifyOptions());
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token.', details: error.message });
  }

  const scopes = parseScopes(claims);

  req.automationAuth = {
    token,
    scopes,
    claims,
    subject: claims.sub || null,
    integration: claims.integration || claims.client_id || claims.iss || null,
    requestedBy: claims.requestedBy || claims.requestor || claims.sub || null,
    ip: requesterIp
  };

  return next();
}

export function requireAllScopes(requiredScopes) {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  return function requireScopesMiddleware(req, res, next) {
    if (!req.automationAuth) {
      return res.status(401).json({ error: 'Automation authentication required.' });
    }
    if (!hasAllScopes(req.automationAuth, scopes)) {
      return res.status(403).json({ error: 'Forbidden: missing required scope.' });
    }
    return next();
  };
}

export function requireAnyScope(requiredScopes) {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  return function requireScopesMiddleware(req, res, next) {
    if (!req.automationAuth) {
      return res.status(401).json({ error: 'Automation authentication required.' });
    }
    if (!hasAnyScope(req.automationAuth, scopes)) {
      return res.status(403).json({ error: 'Forbidden: missing required scope.' });
    }
    return next();
  };
}

