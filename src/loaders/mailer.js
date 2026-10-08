// src/loaders/mailer.js
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';

// Ces trois valeurs sont lues À L'APPEL, pas au chargement du module.
//
// Les imports ESM sont évalués avant le corps du script, donc avant son
// `dotenv.config()` : lues ici au chargement, EMAIL_STUB valait `undefined`
// pour tout script CLI, qui basculait alors sur le SMTP réel. Autrement dit,
// lancer un script d'envoi en DEV expédiait de vrais courriels.
const isStub = () => String(process.env.EMAIL_STUB || 'false').toLowerCase() === 'true';
const fromAddress = () => process.env.FROM_EMAIL || 'Billetterie <noreply@localhost>';
const outboxDir = () => path.resolve(process.cwd(), 'data/outputs/outbox');

let transporter = null;

/**
 * Délais de garde et réutilisation des connexions SMTP.
 *
 * CE QUI MANQUAIT. Aucune de ces valeurs n'était posée, donc on héritait des
 * défauts de Nodemailer : 2 min pour établir la connexion, 10 min sur la
 * socket. Or cet envoi était attendu À L'INTÉRIEUR de la confirmation de
 * paiement — page de retour, sondage, webhook. Un SMTP lent ne ralentissait
 * pas seulement le courriel : il retenait la réponse que l'acheteur attend, et
 * la réponse que le prestataire attend de son webhook (qu'il réessaie s'il ne
 * l'obtient pas). Les envois sont désormais différés (voir
 * scheduleOrderAttestation), mais un envoi différé qui pend dix minutes
 * occupe quand même une connexion et retarde la file.
 *
 * `pool` : sans lui, chaque message ouvrait une connexion neuve — TLS plus
 * AUTH à chaque billet. Pour un match, ce sont plus de 1500 courriels : la
 * poignée de main répétée coûtait davantage que l'envoi lui-même.
 *
 * `rateDelta`/`rateLimit` : les fournisseurs grand public (Gmail) limitent le
 * débit ET le volume journalier. Mieux vaut lisser ici que se faire refuser
 * une rafale au pire moment.
 */
function transportTuning() {
  const num = (name, fallback) => {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    connectionTimeout: num('SMTP_CONNECTION_TIMEOUT_MS', 10_000),
    greetingTimeout:   num('SMTP_GREETING_TIMEOUT_MS', 10_000),
    socketTimeout:     num('SMTP_SOCKET_TIMEOUT_MS', 30_000),
    pool:              String(process.env.SMTP_POOL || 'true').toLowerCase() === 'true',
    maxConnections:    num('SMTP_MAX_CONNECTIONS', 3),
    maxMessages:       num('SMTP_MAX_MESSAGES', 100),
    rateDelta:         num('SMTP_RATE_DELTA_MS', 1000),
    rateLimit:         num('SMTP_RATE_LIMIT', 5)
  };
}

export async function sendMail({ to, subject, html, attachments = [] }) {
  const FROM = fromAddress();
  const OUTBOX = outboxDir();
  if (isStub()) {
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
    transporter = nodemailer.createTransport(
      process.env.SMTP_URL
        ? { url: process.env.SMTP_URL, ...transportTuning() }
        : {
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
            ...transportTuning()
          }
    );
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
