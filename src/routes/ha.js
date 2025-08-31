// src/routes/ha.js
import express from 'express';
import { Order } from '../models/Order.js';
import { Seat } from '../models/Seat.js';
import { getCheckoutStatus, getCheckoutIntent } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';
import { renderEmailTemplate } from '../utils/email-template.js';


const router = express.Router();


function isPaidLike(status) {
  return /paid|authorized|succeeded|success|ok/i.test(String(status||''));
}

async function reserveSeatsForOrder(order) {
  if (!order?.lines?.length) return;
  const { seasonCode, venueSlug } = order;
  for (const l of order.lines) {
    if (!l.seatId) continue;
    await Seat.updateOne(
      { seasonCode, venueSlug, seatId: l.seatId },
      { $set: { status: 'reserved', reservedByOrderId: order._id } }
    );
  }
}

// helper: persister info HelloAsso dans l’order
async function persistHelloAssoInfo(order, { intentId, providerOrderId, rawStatus, raw }) {
  order.meta = order.meta || {};
  order.meta.helloasso = {
    ...(order.meta.helloasso || {}),
    intentId: intentId || (order.meta.helloasso?.intentId || null),
    orderId: providerOrderId || (order.meta.helloasso?.orderId || null),
    rawStatus: rawStatus || (order.meta.helloasso?.rawStatus || null),
    raw: raw || (order.meta.helloasso?.raw || null),
  };
  // Champ dédié pour faciliter les exports / recherches
  if (providerOrderId && !order.paymentProviderOrderId) {
    order.paymentProviderOrderId = String(providerOrderId);
  }
  await order.save();
}



/**
 * GET /ha/return
 * HelloAsso renvoie souvent ?checkoutIntentId=...&code=...
 * NE PAS se fier à ?orderId=... (ID HelloAsso), on récupère l’orderId Mongo via metadata du checkout-intent.
 */
router.get('/ha/return', async (req, res) => {
  try {
    const q = req.query || {};
    const ci = q.ci || q.checkoutIntentId || q.id || null; // checkoutIntentId côté HA
    let   oid = q.oid || null;                              // _id (BTS) de la commande
    let status = q.code || 'unknown';                       // code=succeeded|...
    // 👇 Surtout ne pas oublier d'initialiser :
    let providerOrderId = q.order || q.orderId || null;     // n° commande HelloAsso
    let rawIntent = null;

    // Si on a l'intent, on complète via l'API HelloAsso
    if (ci) {
      try {
        const det = await getCheckoutIntent(ci);
        rawIntent = det.raw || null;
        if (!oid) {
          // BTS stocke en metadata.orderNo ou orderId suivant les versions
          oid = det?.metadata?.orderNo || det?.metadata?.orderId || null;
        }
        status = det?.status || status;
        if (!providerOrderId) {
          providerOrderId = det?.providerOrderId || det?.orderId || null;
        }
      } catch (e) {
        console.warn('[ha/return] getCheckoutIntent failed:', e.message);
      }
    }

    if (!oid) return res.status(400).send('Missing order reference');

    const order = await Order.findById(oid);



    if (!order) return res.status(404).send('Order not found');

    // on sauvegarde ce qu’on sait déjà (intentId / orderId HA / statut brut)
    await persistHelloAssoInfo(order, {
      intentId: ci || null,
      providerOrderId: providerOrderId || null,
      rawStatus: status || null,
      raw: rawIntent || null
    });

    // si le statut est incertain, on le redemande
    if (!isPaidLike(status) && ci) {
      try { status = await getCheckoutStatus(ci); } catch {}
    }

    if (isPaidLike(status)) {
      if (order.status !== 'paid') {
        // (si tu as une allocation TBH7, appelle-la ici avant)
        order.status = 'paid';
        // si providerOrderId a été découvert après coup, on le garde aussi
        if (providerOrderId) {
          order.paymentProvider = "helloasso";
          order.meta.helloasso =
          {
            ...(order.paymentProvider || {}),
            orderId: providerOrderId || order.meta.helloasso?.orderId || null,
            intentId: ci || order.meta.helloasso?.intentId || null,
            rawStatus: status || order.meta.helloasso?.rawStatus || null,
            raw: rawIntent || order.meta.helloasso?.raw || null
          };
          //order.paymentProviderOrderId = order.paymentProviderOrderId || String(providerOrderId);
        }
        await order.save();

        // réservation des sièges seatId (renew) / déjà alloué (TBH7 après allocation)
        await reserveSeatsForOrder(order);

// — Prépare les variables pour le template —
const totalEuro = (Number(order.totalCents || 0) / 100).toFixed(2);
const installments = Number(order.installments || order.paymentSplit || 1);
const installmentsInfo = installments > 1
  ? `Règlement en ${installments} échéances.`
  : `Règlement en une fois.`;

const lines = Array.isArray(order.lines) ? order.lines : [];
const linesRows = lines.map(l =>
  `<tr><td>${l.seatId || l.zoneKey || ''}</td><td>${l.tariffCode || ''}</td><td>${(Number(l.priceCents||0)/100).toFixed(2)} €</td></tr>`
).join('');

const linesHtml = lines.map(l =>
  `<li>${l.seatId || l.zoneKey || ''} — ${l.tariffCode || ''} (${(Number(l.priceCents||0)/100).toFixed(2)} €)</li>`
).join('');

// bloc HelloAsso (si dispo)
let haOrderBlock = '';
if (order.paymentProviderOrderId) {
  haOrderBlock = `<p>Référence HelloAsso : <b>${order.paymentProviderOrderId}</b></p>`;
}

// infos club optionnelles
const clubName = process.env.CLUB_NAME || 'Les Bélougas';

const tplName = process.env.EMAIL_TEMPLATE_RENEW_CONFIRM || 'renew-confirmation';
const html = await renderEmailTemplate(tplName, {
  orderId: String(order._id),
  seasonCode: order.seasonCode || '',
  venueSlug: order.venueSlug || '',
  payerFirstName: order.payerFirstName || '',
  payerLastName:  order.payerLastName  || '',
  payerEmail:     order.payerEmail     || '',
  totalEuro,
  installmentsInfo,
  linesRows,     // pour <table>
  linesHtml,     // pour <ul> de secours (dans le default template)
  haOrderBlock,  // bloc référence HA, éventuellement vide
  clubName,
  extraInfo: ''  // tu peux injecter des consignes supplémentaires ici
});

// — Envoi de l’email (le loader gère déjà EMAIL_STUB=true → .eml) —
await sendMail({
  to: order.payerEmail,
  subject: process.env.EMAIL_SUBJECT_RENEW_CONFIRM || 'Confirmation de paiement - Abonnement',
  html
});        

      }
      return res
        .status(200)
        .send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>OK</title><body>
          <h1>Paiement confirmé ✅</h1>
          <p>Commande ${order._id}</p>
          ${order.paymentProviderOrderId ? `<p>Référence HelloAsso : <b>${order.paymentProviderOrderId}</b></p>` : ''}
        </body></html>`);
        
    } else {
      order.status = 'failed';
      await order.save();
      return res
        .status(200)
        .send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>KO</title><body>
          <h1>Paiement non confirmé ❌</h1>
          <p>Commande ${order._id} — statut: ${status}</p>
        </body></html>`);
    }
  } catch (e) {
    console.error('[GET /ha/return] error:', e);
    res.status(500).send('Erreur interne');
  }
});


/**
 * GET /ha/back
 * Retour "annuler/revenir" depuis HelloAsso (navigateur).
 * Affiche un message simple.
 */
router.get('/ha/back', (_req, res) => {
  res
    .status(200)
    .send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Paiement annulé</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Helvetica,Arial,sans-serif;background:#0b0f17;color:#e5e7eb;margin:0;padding:24px}
  .card{max-width:720px;margin:0 auto;background:#0f1622;border:1px solid #111827;border-radius:12px;padding:18px}
  a.btn{display:inline-block;margin-top:12px;padding:10px 14px;border-radius:10px;background:#111827;border:1px solid #1f2937;color:#e5e7eb;text-decoration:none}
  a.btn:hover{background:#162233}
</style>
</head>
<body>
  <div class="card">
    <h1>Paiement annulé</h1>
    <p>Vous avez quitté HelloAsso avant de confirmer le règlement.</p>
    <p>Vous pouvez relancer la procédure si besoin.</p>
  </div>
</body>
</html>`);
});

/**
 * GET /ha/error
 * Page d'erreur simple si HelloAsso renvoie une redirection d'erreur.
 */
router.get('/ha/error', (_req, res) => {
  res
    .status(400)
    .send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Erreur de paiement</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Helvetica,Arial,sans-serif;background:#0b0f17;color:#e5e7eb;margin:0;padding:24px}
  .card{max-width:720px;margin:0 auto;background:#0f1622;border:1px solid #111827;border-radius:12px;padding:18px}
  a.btn{display:inline-block;margin-top:12px;padding:10px 14px;border-radius:10px;background:#111827;border:1px solid #1f2937;color:#e5e7eb;text-decoration:none}
  a.btn:hover{background:#162233}
</style>
</head>
<body>
  <div class="card">
    <h1>Erreur de paiement</h1>
    <p>Une erreur est survenue pendant le paiement. Veuillez réessayer dans quelques minutes.</p>
  </div>
</body>
</html>`);
});


// (optionnel) webhook serveur→serveur
router.post('/webhook/helloasso', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body || {};
    const ci = body.id || body.checkoutIntentId || null;

    let orderId = body?.metadata?.orderId || null;
    let status  = body?.status || body?.code || '';

    if (!orderId && ci) {
      try {
        const det = await getCheckoutIntent(ci);
        orderId = det?.metadata?.orderId || null;
        status  = status || det?.status;
      } catch {}
    }
    if (!orderId) return res.status(400).json({ ok:false, error:'no orderId' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(200).json({ ok:true, note:'order not found (idempotent)' });

    await persistHelloAssoInfo(order, {
      intentId: ci || null,
      providerOrderId: providerOrderId || null,
      rawStatus: status || null,
      raw: rawIntent || body || null
    });

    if (isPaidLike(status) && order.status !== 'paid') {
      order.status = 'paid';
      await order.save();
      await reserveSeatsForOrder(order);
    }
    return res.json({ ok:true });
  } catch (e) {
    console.error('[POST /webhook/helloasso] error:', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

export default router;
