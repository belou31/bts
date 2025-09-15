// src/services/qr.js
// Génération d'images QR (SVG/PNG) à partir d'une chaîne (ex: HEX).
import QRCode from 'qrcode';

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
