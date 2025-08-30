// src/loaders/mailer.js
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

const EMAIL_STUB = String(process.env.EMAIL_STUB || 'false').toLowerCase() === 'true';
const FROM = process.env.FROM_EMAIL || 'Billetterie <noreply@localhost>';
const OUTBOX = path.resolve(process.cwd(), '.outbox');

let transporter;

export async function sendMail({ to, subject, html, text }) {
  if (EMAIL_STUB) {
    if (!fs.existsSync(OUTBOX)) fs.mkdirSync(OUTBOX, { recursive: true });
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = path.join(OUTBOX, `${now}__${sanitize(subject)}.eml`);
    const eml = [
      `From: ${FROM}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      html || (text ? `<pre>${escapeHtml(text)}</pre>` : '<p>(vide)</p>')
    ].join('\r\n');
    fs.writeFileSync(fname, eml, 'utf8');
    console.log(`[EMAIL_STUB] écrit ${fname}`);
    return { stub: true, file: fname };
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
  }

  return transporter.sendMail({ from: FROM, to, subject, html, text });
}

function sanitize(s) {
  return String(s || 'message').replace(/[^\w\-éèàêîôùçÉÈÀÊÎÔÛÇ ]+/g, '_').slice(0, 80);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
