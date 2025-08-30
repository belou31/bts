// src/routes/ha.js
import express from 'express';
import { Order } from '../models/Order.js';
import { Seat } from '../models/Seat.js';
import { getCheckoutStatus, getCheckoutIntent } from '../services/helloasso.js';
import { sendMail } from '../loaders/mailer.js';

const router = express.Router();

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

function isPaidLike(status) {
  return /paid|authorized|succeeded|success|ok/i.test(String(status||''));
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
    const q  = req.query;
    const ci = q.ci || q.checkoutIntentId || q.id || null;

    // On ignore q.orderId (côté HelloAsso), on n’accepte que q.oid si présent (notre MongoID)
    let oid = q.oid || null;
    let status = q.code || 'unknown';

    // Si pas d'oid → on va le chercher dans la metadata du checkout-intent
    if (!oid && ci) {
      try {
        const det = await getCheckoutIntent(ci);
        oid = det?.metadata?.orderId || null;
        status = det?.status || status;
      } catch (e) {
        // on continue, on tentera /status ci-dessous
      }
    }

    if (!oid) return res.status(400).send('Missing order reference');
    const order = await Order.findById(oid);
    if (!order) return res.status(404).send('Order not found');

    if (!isPaidLike(status) && ci) {
      status = await getCheckoutStatus(ci);
    }


    // On persiste toujours l’info HelloAsso qu’on a pu récupérer
    await persistHelloAssoInfo(order, {
      intentId: ci || null,
      providerOrderId: providerOrderId || null,
      rawStatus: status || null,
      raw: rawIntent || null
    });

    
    if (isPaidLike(status)) {
      if (order.status !== 'paid') {
        order.status = 'paid';
        await order.save();
        await reserveSeatsForOrder(order);
        try {
          await sendMail({
            to: order.payerEmail,
            subject: 'Confirmation de paiement - Abonnement',
            html: `<p>Bonjour ${order.payerFirstName || ''} ${order.payerLastName || ''},</p>
                   <p>Votre commande <b>${order._id}</b> a été confirmée.</p>
                   <p>Places :</p>
                   <ul>${order.lines.map(l => `<li>${l.seatId} — ${l.tariffCode} (${(l.priceCents/100).toFixed(2)}€)</li>`).join('')}</ul>
                   <p>Les billets (QR codes) seront envoyés match par match.</p>`
          });
        } catch {}
      }
      return res.send(`<h1>Paiement confirmé ✅</h1><p>Commande ${order._id}</p>`);
    } else {
      order.status = 'failed';
      await order.save();
      return res.send(`<h1>Paiement non confirmé ❌</h1><p>Commande ${order._id} — statut: ${status}</p>`);
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
