// src/services/seat-change-link.js
//
// Construit le lien « choisir une autre place » d'une commande.
//
// La règle vit ici plutôt qu'en double dans pay.js et
// send-all-season-tickets-for-event.js : elle porte plusieurs conditions
// (secret JWT présent, match rattaché, coup d'envoi à venir) qu'il serait
// facile de laisser diverger d'un appelant à l'autre.

import { Event } from '../models/Event.js';
import { signSeatChangeToken } from '../routes/seat-change.js';

/**
 * @returns {Promise<string>} l'URL, ou '' si le lien n'a pas lieu d'être.
 */
export async function buildSeatChangeUrlForOrder(order, options = {}) {
  try {
    if (!process.env.JWT_SECRET) return '';

    const base = String(options.baseUrl || process.env.APP_URL || '').trim().replace(/\/+$/, '');
    if (!base) return '';

    // Une commande d'ABONNEMENT n'est rattachée à aucun match : le changement
    // de place se fait match par match, sur les commandes filles.
    const eventIdRaw = order?.eventId || order?.meta?.eventId;
    if (!eventIdRaw) return '';

    let startsAt = options.startsAt || null;
    if (!startsAt) {
      const ev = await Event.findById(eventIdRaw).select({ startsAt: 1 }).lean().catch(() => null);
      startsAt = ev?.startsAt || null;
    }
    // Expire au coup d'envoi : proposer de changer de place pour un match
    // commencé n'aurait pas de sens.
    if (!startsAt || new Date(startsAt) <= new Date()) return '';

    const token = signSeatChangeToken({ eventId: eventIdRaw, orderId: order._id, startsAt });
    return `${base}/seat-change?id=${token}`;
  } catch (err) {
    console.warn('[seat-change-link] skipped:', err?.message || err);
    return '';
  }
}
