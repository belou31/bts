// src/loaders/mailer.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export async function sendMail({ to, subject, html, attachments = [] }) {
  const outDir = path.resolve(process.cwd(), '.outbox');
  await fs.mkdir(outDir, { recursive: true });

  const boundary = '=_BTS_' + Math.random().toString(36).slice(2);
  const dateStr  = new Date().toISOString().replace(/[:.]/g,'-');
  const safeSubj = String(subject || 'Message').replace(/[^\w\- .]/g, '').slice(0,120);
  const fname    = `${dateStr}__${safeSubj}.eml`;
  const fpath    = path.join(outDir, fname);

  let mime = '';
  mime += `From: "BTS" <no-reply@bts.local>\r\n`;
  mime += `To: <${to}>\r\n`;
  mime += `Subject: ${subject}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;

  if (attachments.length) {
    mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    // part 1: HTML
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/html; charset="utf-8"\r\n`;
    mime += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    mime += (html || '') + `\r\n`;
    // parts: attachments
    for (const att of attachments) {
      const filename    = att.filename || 'piece.pdf';
      const contentType = att.contentType || 'application/octet-stream';
      const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(String(att.content||''), 'utf8');
      const b64 = buf.toString('base64').replace(/(.{76})/g, '$1\r\n'); // wrap
      mime += `--${boundary}\r\n`;
      mime += `Content-Type: ${contentType}; name="${filename}"\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n`;
      mime += `Content-Disposition: attachment; filename="${filename}"\r\n\r\n`;
      mime += b64 + `\r\n`;
    }
    mime += `--${boundary}--\r\n`;
  } else {
    // message simple (HTML seul)
    mime += `Content-Type: text/html; charset="utf-8"\r\n`;
    mime += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    mime += (html || '') + `\r\n`;
  }

  await fs.writeFile(fpath, mime, 'utf8');
  console.log('[EMAIL_STUB] écrit', fpath);
}