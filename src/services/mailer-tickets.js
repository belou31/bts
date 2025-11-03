// src/services/mailer-tickets.js
import { renderQrSvg } from './qr.js';
import { fmtEuros }    from './util-money.js'; // si tu as un helper
import { Ticket }      from '../models/Ticket.js';

export async function renderTicketEmailHtml(ticket) {
  const svg = await renderQrSvg({ text: ticket.qr.value, size: 256 });
  const holder = ticket.holder || {};
  return `<!doctype html><html><body style="font-family:system-ui">
  <h1>Votre e-ticket — ${ticket.eventId}</h1>
  <p><b>Place:</b> ${ticket.seatId} — <b>Tarif:</b> ${ticket.tariffCode||'—'}</p>
  <p><b>Bénéficiaire:</b> ${holder.firstName||''} ${holder.lastName||''}</p>
  <div>${svg}</div>
  <p>Présentez ce QR code à l'entrée. Un seul passage autorisé.</p>
  </body></html>`;
}
