// src/routes/admin/order-contact.routes.js
// Édition de l'identité de contact d'une commande depuis admin/orders.
//
// Volontairement distinct de « Ajuster » (l'overlay de présence d'un match,
// dans index.js) : celui-ci ne touche jamais aux sièges, aux tarifs ni au
// montant — uniquement à qui reçoit et à quel nom. C'est le besoin courant
// (e-mail saisi de travers, changement d'adresse) et il doit rester sans
// effet de bord sur l'allocation.
//
// Aucun envoi d'e-mail : renvoyer l'attestation est une action séparée, pour
// qu'une correction puisse être combinée à d'autres avant de notifier.
import { Router } from 'express';
import mongoose from 'mongoose';

import { Order } from '../../models/index.js';
import { adminAuth } from './index.js';

const router = Router();
router.use(adminAuth);

const norm = v => String(v ?? '').trim();
// Volontairement permissif : on refuse les saisies manifestement fautives
// (espace, arobase manquante) sans prétendre valider une adresse réelle.
const looksLikeEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function serialize(order) {
  return {
    id: String(order._id),
    status: order.status || '',
    flow: order.origin?.flow || '',
    seasonCode: order.seasonCode || '',
    venueSlug: order.venueSlug || '',
    payerFirstName: order.payerFirstName || '',
    payerLastName: order.payerLastName || '',
    payerEmail: order.payerEmail || '',
    lines: (order.lines || []).map((l, index) => ({
      index,
      seatId: l.seatId || '',
      zoneKey: l.zoneKey || '',
      tariffCode: l.tariffCode || '',
      holderFirstName: l.holderFirstName || '',
      holderLastName: l.holderLastName || ''
    }))
  };
}

router.get('/:orderId', async (req, res) => {
  const orderId = norm(req.params.orderId);
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(400).json({ ok: false, error: 'Identifiant de commande invalide' });
  }
  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'Commande introuvable' });
  return res.json({ ok: true, order: serialize(order) });
});

router.post('/:orderId', async (req, res) => {
  try {
    const orderId = norm(req.params.orderId);
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ ok: false, error: 'Identifiant de commande invalide' });
    }
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Commande introuvable' });

    const { payerFirstName, payerLastName, payerEmail, lines } = req.body || {};
    const previousEmail = order.payerEmail || '';
    const changes = [];

    if (payerEmail !== undefined) {
      const email = norm(payerEmail);
      if (!email) return res.status(400).json({ ok: false, error: 'L\'e-mail ne peut pas être vide' });
      if (!looksLikeEmail(email)) {
        return res.status(400).json({ ok: false, error: `E-mail invalide : ${email}` });
      }
      if (email !== previousEmail) {
        order.payerEmail = email;
        changes.push(`e-mail ${previousEmail || '(vide)'} → ${email}`);
      }
    }
    if (payerFirstName !== undefined && norm(payerFirstName) !== (order.payerFirstName || '')) {
      order.payerFirstName = norm(payerFirstName);
      changes.push('prénom');
    }
    if (payerLastName !== undefined && norm(payerLastName) !== (order.payerLastName || '')) {
      order.payerLastName = norm(payerLastName);
      changes.push('nom');
    }

    if (Array.isArray(lines)) {
      for (const patch of lines) {
        const index = Number(patch?.index);
        if (!Number.isInteger(index) || index < 0 || index >= (order.lines || []).length) {
          return res.status(400).json({ ok: false, error: `Ligne inconnue : ${patch?.index}` });
        }
        const line = order.lines[index];
        if (patch.holderFirstName !== undefined && norm(patch.holderFirstName) !== (line.holderFirstName || '')) {
          line.holderFirstName = norm(patch.holderFirstName);
          changes.push(`porteur ligne ${index + 1}`);
        }
        if (patch.holderLastName !== undefined && norm(patch.holderLastName) !== (line.holderLastName || '')) {
          line.holderLastName = norm(patch.holderLastName);
          changes.push(`porteur ligne ${index + 1}`);
        }
      }
      order.markModified('lines');
    }

    if (!changes.length) {
      return res.json({ ok: true, changed: false, order: serialize(order), message: 'Aucun changement.' });
    }

    // Trace : une adresse corrigée efface l'ancienne, or c'est elle qui figure
    // sur l'attestation déjà envoyée et dans le relevé du prestataire.
    order.adminEdits = [...(order.adminEdits || []), {
      at: new Date(),
      by: 'admin-ui',
      kind: 'contact',
      previousEmail,
      changes
    }];
    order.markModified('adminEdits');

    await order.save();
    return res.json({
      ok: true,
      changed: true,
      order: serialize(order),
      changes,
      // L'appelant décide d'un renvoi éventuel : jamais automatique ici.
      message: 'Contact mis à jour. Aucun e-mail n\'a été envoyé.'
    });
  } catch (err) {
    // `uniq_paid_per_payer` refusait de recopier l'adresse d'une autre commande
    // payée du même groupe. Il a été retiré, mais le cas reste traité : une base
    // non encore migrée le lève toujours, et un autre index unique pourrait le
    // lever demain.
    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        error: 'Un index d\'unicité refuse cette adresse (probablement uniq_paid_per_payer, sur une base non migrée). Utiliser une adresse distincte, ou retirer l\'index : scripts/06-misc/drop-uniq-paid-per-payer.js'
      });
    }
    console.error('[admin/order-contact]', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Erreur serveur' });
  }
});

export default router;
