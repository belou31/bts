// src/services/attestation.js
import { fmtEuros } from '../utils/money.js';

function renderAttestationHtml({ seasonCode, payerEmail, order, subscribersById }) {
  const logoPath = (process.env.APP_URL || '').replace(/https?:\/\/[^/]+/, '') + '/static/img/logo.png';
  const lines = Array.isArray(order?.lines) ? order.lines : [];

  // Groupe par subscriberId pour afficher le numéro d’abonné
  const group = new Map();
  for (const ln of lines) {
    const k = ln.subscriberId ? String(ln.subscriberId) : '_';
    if (!group.has(k)) group.set(k, []);
    group.get(k).push(ln);
  }

  const blocks = [];
  for (const [sid, arr] of group.entries()) {
    const sub = subscribersById.get(sid) || {};
    const subLabel = sub.firstName ? `${sub.firstName} ${sub.lastName || ''}`.trim() : (sub.email || payerEmail || '');
    const subNo = sub.subscriberNo || '—';

    blocks.push(`
      <tr>
        <td style="padding:10px;border:1px solid #e5e7eb">
          <div style="font-weight:600">${subLabel}</div>
          <div style="font-size:12px;color:#64748b">N° abonné: <b>${subNo}</b></div>
          <ul style="margin:8px 0 0 18px">
            ${arr.map(x => {
              const isVirtual = /-Z\d{3,}$/i.test(String(x.seatId||''));
              const place = isVirtual ? (x.zoneKey || '') : (x.seatId || '');
              return `<li>${place} — ${x.tariffCode || 'TARIF'} ${(x.priceCents!=null)?'('+fmtEuros(x.priceCents)+')':''}</li>`;
            }).join('')}

          </ul>
        </td>
      </tr>
    `);
  }

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;color:#0f172a">
    <div style="display:flex;align-items:center;gap:12px">
      <img src="${logoPath}" alt="Belougas" style="height:44px"/>
      <h2 style="margin:0">Attestation d’abonnement ${seasonCode || ''}</h2>
    </div>
    <p>Bonjour,</p>
    <p>Nous confirmons la prise en compte de votre abonnement. Vous trouverez ci-dessous le récapitulatif de votre commande.</p>

    <table style="border-collapse:collapse;width:100%;margin:10px 0">
      <tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb"><b>Commande</b></td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${order._id || '—'}</td>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb"><b>Référence paiement</b></td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${order.haPaymentRef || order.checkoutIntentId || '—'}</td>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb"><b>Règlement</b></td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${(order.installments||1)} fois — Total ${fmtEuros(order.totalCents||0)}</td>
      </tr>
    </table>

    <h3 style="margin:14px 0 8px">Abonnés & sièges</h3>
    <table style="border-collapse:collapse;width:100%">
      ${blocks.join('')}
    </table>

    <p style="margin-top:16px">Vos e-tickets avec QR code seront envoyés à chaque match. Conservez cet e-mail comme justificatif.</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0"/>
    <p style="font-size:12px;color:#64748b">Besoin d’aide ? billetterie@tbhc.fr</p>
  </div>`;
}

exports { renderAttestationHtml };
