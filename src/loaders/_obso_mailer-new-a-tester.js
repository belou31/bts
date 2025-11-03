// src/loaders/mailer.js
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';

const OUTBOX   = process.env.OUTBOX_DIR || path.resolve(process.cwd(), '.outbox');
const FROM     = process.env.FROM_EMAIL || 'Billetterie <noreply@localhost>';
const REPLY_TO = process.env.REPLY_TO_EMAIL || '';

const TRANSPORT = String(process.env.MAIL_TRANSPORT || '').toLowerCase(); // 'smtp' | 'gmail' | 'stub' | ''
const EMAIL_STUB = String(process.env.EMAIL_STUB || '').toLowerCase() === 'true';

function pickTransport() {
  // 1) stub forcé
  if (TRANSPORT === 'stub' || EMAIL_STUB) return null;

  // 2) Gmail explicite ou dispo
  if (TRANSPORT === 'gmail' || process.env.GMAIL_USER) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS;
    if (!user || !pass) return null;
    return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  }

  // 3) SMTP générique (URL directe ou host/port)
  if (TRANSPORT === 'smtp' || process.env.SMTP_URL || process.env.SMTP_HOST) {
    if (process.env.SMTP_URL) return nodemailer.createTransport(process.env.SMTP_URL);
    const host   = process.env.SMTP_HOST;
    if (!host) return null;
    const port   = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true' || port === 465;
    const auth   = (process.env.SMTP_USER || process.env.SMTP_PASS)
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;
    return nodemailer.createTransport({ host, port, secure, auth });
  }

  // 4) Pas de config -> stub
  return null;
}

let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  transporter = pickTransport(); // peut être null => stub
  return transporter;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

export async function sendMail({ to, subject, html, text, attachments = [] }) {
  const t = getTransporter();

  // === Envoi réel via nodemailer (SMTP/Gmail) ===
  if (t) {
    return t.sendMail({
      from: FROM,
      to,
      subject,
      html,
      text,
      attachments,
      ...(REPLY_TO ? { replyTo: REPLY_TO } : {})
    });
  }

  // === Stub: écrit un .eml lisible (avec pièces jointes en base64) ===
  await fs.mkdir(OUTBOX, { recursive: true });

  const boundary = '=_BTS_' + Math.random().toString(36).slice(2);
  const dateStr  = new Date().toISOString().replace(/[:.]/g,'-');
  const safeSubj = String(subject || 'Message').replace(/[^\w\- .]/g, '').slice(0,120);
  const fpath    = path.join(OUTBOX, `${dateStr}__${safeSubj}.eml`);

  let mime = '';
  mime += `From: ${FROM}\r\n`;
  mime += `To: ${to}\r\n`;
  mime += `Subject: ${subject}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;

  if (attachments?.length) {
    mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    // part HTML
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: text/html; charset="utf-8"\r\n`;
    mime += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    mime += (html || (text ? `<pre>${escapeHtml(text)}</pre>` : '<p>(vide)</p>')) + `\r\n`;
    // parts attachments
    for (const att of attachments) {
      const filename    = att.filename || 'piece.bin';
      const contentType = att.contentType || att.contentType || 'application/octet-stream';
      // accepte Buffer / string (utf8 ou base64)
      let buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(String(att.content || ''), 'base64');
      if (!buf.length) buf = Buffer.from(String(att.content || ''), 'utf8');
      const b64 = buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
      mime +=
