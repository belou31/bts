// src/loaders/mailer.js
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';

const EMAIL_STUB = String(process.env.EMAIL_STUB || 'false').toLowerCase() === 'true';
const FROM = process.env.FROM_EMAIL || 'Billetterie <noreply@localhost>';
const OUTBOX = path.resolve(process.cwd(), 'data/outputs/outbox');

let transporter = null;

export async function sendMail({ to, subject, html, attachments = [] }) {
  if (EMAIL_STUB) {
    await fs.mkdir(OUTBOX, { recursive: true });
    const boundary = '=_BTS_' + Math.random().toString(36).slice(2);
    const dateStr  = new Date().toISOString().replace(/[:.]/g,'-');
    const safeSubj = String(subject || 'Message').replace(/[^\w\- .]/g, '').slice(0,120);
    const fpath    = path.join(OUTBOX, `${dateStr}__${safeSubj}.eml`);

    let mime = '';
    mime += `From: ${FROM}\r\n`;
    mime += `To: ${Array.isArray(to) ? to.join(', ') : to}\r\n`;
    mime += `Subject: ${subject}\r\n`;
    mime += `MIME-Version: 1.0\r\n`;

    if (attachments.length) {
      mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

      // part 1: HTML
      mime += `--${boundary}\r\n`;
      mime += `Content-Type: text/html; charset="utf-8"\r\n`;
      mime += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
      mime += (html || '<p>(vide)</p>') + `\r\n`;

      // parts: attachments
      for (const att of attachments) {
        const filename    = att.filename || 'piece.bin';
        const contentType = att.contentType || 'application/octet-stream';
        const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(String(att.content||''), 'utf8');
        const b64 = buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

        mime += `--${boundary}\r\n`;
        mime += `Content-Type: ${contentType}; name="${filename}"\r\n`;
        mime += `Content-Transfer-Encoding: base64\r\n`;
        mime += `Content-Disposition: attachment; filename="${filename}"\r\n\r\n`;
        mime += b64 + `\r\n`;
      }
      mime += `--${boundary}--\r\n`;
    } else {
      // message simple
      mime += `Content-Type: text/html; charset="utf-8"\r\n`;
      mime += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
      mime += (html || '<p>(vide)</p>') + `\r\n`;
    }

    await fs.writeFile(fpath, mime, 'utf8');
    console.log('[EMAIL_STUB] écrit', fpath);
    return { stub: true, file: fpath };
  }

  // PROD/INT SMTP (Nodemailer)
  if (!transporter) {
    if (process.env.SMTP_URL) {
      transporter = nodemailer.createTransport(process.env.SMTP_URL);
    } else {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
    }
  }

  return transporter.sendMail({
    from: FROM,
    to,
    subject,
    html,
    attachments: (attachments || []).map(a => ({
      filename: a.filename || 'piece.bin',
      content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content||'')),
      contentType: a.contentType || 'application/octet-stream'
    }))
  });
}
