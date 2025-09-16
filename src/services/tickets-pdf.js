// src/services/tickets-pdf.js
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { Event } from '../models/Event.js';
import { hexToQrSvg } from './qr.js';

function fmtDateFR(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  } catch { return ''; }
}
function seatOrZone(t) {
  // Priorité au siège réel ; fallback sur zone
  return String(t?.seatId || t?.zoneKey || '').trim();
}

// ⬅️ make it async so we can await the SVG
async function drawTicketPage(doc, { clubName, eventName, eventStartsAt, venueSlug, orderId, ticket }) {

  const margin = 50;
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  // Header
  doc.fillColor('#111111').fontSize(18).text(clubName || 'Les Bélougas', margin, margin);
  doc.moveDown(0.5);
  doc.fontSize(14).fillColor('#333')
     .text(eventName || 'Match', { continued:true })
     .fillColor('#666').text(` — ${fmtDateFR(eventStartsAt)}`);
  doc.moveDown(0.2).fontSize(11).fillColor('#666')
     .text(`Lieu : ${venueSlug || ''}`);

  // Cadre billet
  doc.roundedRect(margin, 130, pageW - margin*2, pageH - 130 - margin, 12).stroke('#e5e7eb');

  // Infos place
  doc.fontSize(24).fillColor('#111').text(seatOrZone(ticket), margin + 24, 170);
  doc.moveDown(0.3).fontSize(12).fillColor('#555').text(`Tarif : ${String(ticket?.tariff||'').toUpperCase()}`);

  // QR (vectoriel depuis SVG)
  const qrSize = 220;
  const qrX = pageW - margin - qrSize - 24;
  const qrY = 200;

  if (ticket?.hex) {
    // ⬅️ the fix: await the SVG string
    const svg = await hexToQrSvg(String(ticket.hex), { ecl:'M', margin:0 });
    if (typeof svg === 'string' && svg.trim()) {
      SVGtoPDF(doc, svg, qrX, qrY, { width: qrSize, height: qrSize });
    }
  }

  // Bas de page
  doc.fontSize(10).fillColor('#777');
  doc.text(`Commande : ${orderId}`, margin + 24, pageH - margin - 30);
  doc.text(`Présentez ce QR à l’entrée.`, margin + 24, pageH - margin - 14);
}

export async function buildTicketsPdfBuffer(order) {
  const tickets = Array.isArray(order?.meta?.tickets) ? order.meta.tickets : [];
  if (!tickets.length) return null;

  const evId = String(order?.meta?.eventId || '');
  const ev = evId ? await Event.findById(evId).lean().catch(()=>null) : null;

  return await new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const clubName = process.env.CLUB_NAME || 'Les Bélougas';
    const eventName = ev?.name || 'Match';
    const eventStartsAt = ev?.startsAt || order?.createdAt;
    const venueSlug = order?.venueSlug || ev?.venueSlug || '';

    // ⬅️ await page-by-page so the awaited SVG is fully drawn
    for (let i = 0; i < tickets.length; i++) {
      if (i > 0) doc.addPage();
      await drawTicketPage(doc, {
        clubName, eventName, eventStartsAt, venueSlug,
        orderId: String(order?._id || ''),
        ticket: tickets[i]
      });
    }

    doc.end();
  });
}
