// src/services/qr.js
// Génération d'images QR (SVG/PNG) à partir d'une chaîne (ex: HEX).
import crypto from 'crypto';
import QRCode from 'qrcode';

const DEFAULT_SIZE = 256;

export async function hexToQrSvg(hexString, opts = {}){
  const text = String(hexString || '');
  // ECC M par défaut; marge 2; taille auto
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: opts.ecl || 'M',
    margin: opts.margin ?? 2,
    width: opts.width, // optionnel
  });
  return svg; // string SVG prêt à insérer dans un template
}

export async function hexToQrPngBuffer(hexString, opts = {}){
  const text = String(hexString || '');
  const buf = await QRCode.toBuffer(text, {
    errorCorrectionLevel: opts.ecl || 'M',
    margin: opts.margin ?? 2,
    width: opts.width || 512,
    type: 'png'
  });
  return buf; // Buffer PNG
}





/**
 * Génère un code opaque (HEX ou texte court).
 * Par défaut: 20 bytes => 40 hex chars (suffisant et imprévisible).
 */
export function makeOpaqueCode({ kind = process.env.QR_CODE_FORMAT || 'hex' } = {}) {
  if (kind === 'text') {
    // base36 sur 16 bytes -> ~25-26 chars alphanum
    const buf = crypto.randomBytes(16);
    return buf.toString('base64url').replace(/[-_]/g,'').slice(0, 24); // compact et lisible
  }
  // hex (défaut)
  return crypto.randomBytes(20).toString('hex'); // 40 hexa
}

/**
 * Variante signée (facultatif) pour anti-forgery (courte signature HMAC).
 * code|sig4 où sig4 = 4 hex chars de HMAC-SHA1(code) avec QR_SECRET
 */
export function signCode(value) {
  const secret = process.env.QR_SECRET || 'dev-secret';
  const mac = crypto.createHmac('sha1', secret).update(value).digest('hex').slice(0,4);
  return `${value}|${mac}`;
}

export function verifySignature(valueWithMac) {
  const i = valueWithMac.lastIndexOf('|');
  if (i < 0) return { ok: false, value: valueWithMac, reason: 'no_sig' };
  const value = valueWithMac.slice(0, i);
  const mac   = valueWithMac.slice(i+1);
  const expected = signCode(value).slice(-4);
  return { ok: mac === expected, value, reason: mac === expected ? null : 'bad_sig' };
}

/**
 * Rend un QR **SVG** (string) pour une valeur donnée.
 */
export async function renderQrSvg({ text, size = DEFAULT_SIZE }) {
  return QRCode.toString(text, { type: 'svg', width: size, margin: 0 });
}

/**
 * Rend un QR **PNG** (Buffer) pour une valeur donnée.
 */
export async function renderQrPng({ text, size = DEFAULT_SIZE }) {
  return QRCode.toBuffer(text, { type: 'png', width: size, margin: 1 });
}
