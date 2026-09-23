// src/services/checkout-freeze.js
//
// Un seul paiement en vol à la fois, par session de navigation.
//
// LE PROBLÈME. Chaque clic sur « payer » créait une commande et un intent de
// paiement. Un client qui revenait en arrière pour changer sa sélection en
// obtenait un second — et le premier restait `pending`, AVEC SON LIEN DE
// PAIEMENT ENCORE VALIDE. Les verrous de sièges, eux, migraient vers la
// nouvelle commande (claimEventSeatHolds reconnaît la session). Payer
// l'ancien lien échouait alors en conflit de sièges, après encaissement, et
// le client s'entendait dire qu'un tiers avait pris sa place.
//
// LE PRINCIPE. Tant qu'un paiement est en vol pour cette session :
//   - même sélection  → on rend le MÊME intent (retour arrière, double clic,
//     rechargement : ce ne sont pas de nouvelles intentions d'achat) ;
//   - sélection différente → on refuse, en disant ce qui bloque et pour
//     combien de temps encore ;
//   - abandon explicite → la commande est annulée et ses verrous rendus, tout
//     de suite, pour que le client puisse repartir sans attendre.
//
// L'abandon ANNULE au lieu de laisser « pending » : une commande pending est
// payable, et c'est précisément l'état qu'on cherche à supprimer. La
// sentinelle reste le filet pour qui ferme simplement son onglet.
//
// PORTÉE. La clé est le jeton de session (sessionStorage, donc un onglet).
// Un second onglet y échappe : le gel couvre le geste courant — revenir en
// arrière et changer — pas toutes les manières de se dédoubler.
import { Order } from '../models/Order.js';
import { SeatHold } from '../models/SeatHold.js';
import { Seat } from '../models/Seat.js';

/** Empreinte d'un panier : les mêmes places aux mêmes tarifs, quel que soit l'ordre. */
export function cartFingerprint(lines = []) {
  return (lines || [])
    .map(l => [
      String(l.seatId || '').trim().toUpperCase(),
      String(l.zoneKey || '').trim().toUpperCase(),
      String(l.tariffCode || '').trim().toUpperCase()
    ].join('|'))
    .sort()
    .join(';');
}

/**
 * Paiement en vol pour cette session, s'il y en a un.
 *
 * « En vol » = commande encore ouverte, intent créé chez le prestataire, et
 * fenêtre de blocage non expirée. Sans intent, rien n'est payable : ce n'est
 * pas un paiement en cours mais une commande mort-née, et la bloquer
 * n'apporterait rien.
 */
export async function findLiveCheckout({ sessionToken, eventId = null, seasonCode = null, venueSlug = null }) {
  const token = String(sessionToken || '').trim();
  if (!token) return null;

  const q = {
    status: { $in: ['pending', 'tobepaid'] },
    'paymentProviderMeta.checkoutSessionToken': token,
    'paymentProviderMeta.checkoutIntentId': { $exists: true, $ne: null }
  };
  if (eventId) q.eventId = eventId;
  else if (seasonCode) {
    q.seasonCode = seasonCode;
    if (venueSlug) q.venueSlug = venueSlug;
    q.eventId = null;
  }

  const candidates = await Order.find(q).sort({ createdAt: -1 }).limit(5).lean();
  const now = Date.now();
  for (const o of candidates) {
    // Une fenêtre expirée ne gèle plus rien : les verrous sont tombés, la
    // sentinelle va annuler la commande, et le client doit pouvoir repartir.
    if (holdUntil(o) <= now) continue;
    return o;
  }
  return null;
}

/**
 * Fin de la fenêtre de blocage, en millisecondes.
 *
 * `hold.until` n'a longtemps pas été enregistré (absent du schéma, donc écarté
 * par `strict: true`) : les commandes antérieures n'en portent pas. On retombe
 * sur createdAt + CHECKOUT_HOLD_MIN, sans quoi elles seraient tenues pour
 * éternellement en vol et gèleraient l'acheteur pour de bon.
 */
function holdUntil(order) {
  const stored = order?.hold?.until ? new Date(order.hold.until).getTime() : 0;
  if (stored) return stored;
  const created = order?.createdAt ? new Date(order.createdAt).getTime() : 0;
  if (!created) return 0;
  return created + Number(process.env.CHECKOUT_HOLD_MIN || 10) * 60 * 1000;
}

/** Secondes restantes avant l'expiration du blocage, pour l'afficher. */
export function remainingSeconds(order) {
  const until = holdUntil(order);
  if (!until) return 0;
  return Math.max(0, Math.round((until - Date.now()) / 1000));
}

/**
 * Décide quoi faire d'une demande de paiement quand une autre est en vol.
 * @returns {null|{action:'resume'|'blocked', order:object, seconds:number}}
 */
export async function evaluateFreeze({ sessionToken, eventId, seasonCode, venueSlug, lines }) {
  const live = await findLiveCheckout({ sessionToken, eventId, seasonCode, venueSlug });
  if (!live) return null;
  const same = cartFingerprint(live.lines) === cartFingerprint(lines);
  return { action: same ? 'resume' : 'blocked', order: live, seconds: remainingSeconds(live) };
}

/** Corps de réponse d'un refus, lisible par l'interface. */
export function blockedPayload(freeze) {
  return {
    ok: false,
    error: 'checkout_in_progress',
    orderId: String(freeze.order._id),
    secondsRemaining: freeze.seconds,
    abandonUrl: `/pay/abandon?oid=${encodeURIComponent(String(freeze.order._id))}`
  };
}

/** De quoi reprendre le paiement en vol sans en créer un second. */
export function resumePayload(freeze) {
  const meta = freeze.order.paymentProviderMeta || {};
  return {
    ok: true,
    resumed: true,
    orderId: String(freeze.order._id),
    checkoutIntentId: meta.checkoutIntentId || null,
    providerUrl: meta.providerRedirectUrl || null,
    redirectUrl: meta.providerRedirectUrl || null,
    secondsRemaining: freeze.seconds
  };
}

/**
 * Abandon explicite : annule la commande et rend ses places immédiatement.
 *
 * N'agit que sur une commande encore ouverte et appartenant à cette session —
 * sans quoi un identifiant deviné annulerait la commande d'autrui.
 */
export async function abandonCheckout({ orderId, sessionToken }) {
  const token = String(sessionToken || '').trim();
  if (!token) return { ok: false, reason: 'missing_session' };

  const order = await Order.findOne({
    _id: orderId,
    status: { $in: ['pending', 'tobepaid'] },
    'paymentProviderMeta.checkoutSessionToken': token
  });
  if (!order) return { ok: false, reason: 'not_found' };

  order.status = 'canceled';
  order.paymentProviderMeta = {
    ...(order.paymentProviderMeta || {}),
    abandonedAt: new Date(),
    abandonedBy: 'buyer'
  };
  await order.save();

  await SeatHold.deleteMany({ orderId: order._id }).catch(() => {});
  const seatIds = (order.lines || []).map(l => String(l.seatId || '').trim()).filter(Boolean);
  if (seatIds.length) {
    await Seat.updateMany(
      { seasonCode: order.seasonCode, venueSlug: order.venueSlug, seatId: { $in: seatIds },
        status: 'busy', 'meta.hold.orderId': String(order._id) },
      { $set: { status: 'available' }, $unset: { 'meta.hold': 1 } }
    ).catch(() => {});
  }
  return { ok: true, orderId: String(order._id), released: seatIds.length };
}
