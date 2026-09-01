// src/routes/admin/renewers.routes.js
// JSON action endpoints backing the admin/renewers panel (index.js owns the
// server-rendered list page itself — see router.get('/renewers', ...) there).
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { Subscriber } from '../../models/Subscriber.js';
import { Seat } from '../../models/Seat.js';
import { createJob, runJob } from '../../services/automation/index.js';
import { adminAuth } from './index.js';

const router = Router();
router.use(adminAuth);

const STATUSES = ['none', 'invited', 'pending', 'active', 'partial', 'canceled'];
const JWT_SECRET = process.env.JWT_SECRET;
const RENEW_LINK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches export-renew-groups.js

function isValidObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

function normSeatId(s) {
  return String(s || '').trim();
}

function serializeSubscriber(sub) {
  return {
    id: String(sub._id),
    subscriberNo: sub.subscriberNo || '',
    firstName: sub.firstName || '',
    lastName: sub.lastName || '',
    email: sub.email || '',
    phone: sub.phone || '',
    groupKey: sub.groupKey || '',
    prefSeatId: sub.prefSeatId || '',
    previousSeasonSeats: sub.previousSeasonSeats || [],
    seasonCode: sub.seasonCode || '',
    venueSlug: sub.venueSlug || '',
    status: sub.status || 'none',
    notes: sub.notes || '',
    lastInviteSentAt: sub.lastInviteSentAt || null
  };
}

// Builds the same shared-per-group renewal link as
// scripts/03-season-management/export-renew-groups.js: one JWT covering
// every seat held by every Subscriber sharing this group (falls back to
// email, then to the subscriber id, exactly like the CLI script does).
async function buildRenewLink(subscriber, req) {
  if (!JWT_SECRET) {
    const err = new Error('JWT_SECRET is not configured');
    err.statusCode = 500;
    throw err;
  }

  const groupKey = subscriber.groupKey || subscriber.email || String(subscriber._id);
  const groupQuery = { seasonCode: subscriber.seasonCode, venueSlug: subscriber.venueSlug };
  if (subscriber.groupKey) groupQuery.groupKey = subscriber.groupKey;
  else groupQuery._id = subscriber._id;

  const members = subscriber.groupKey
    ? await Subscriber.find(groupQuery).lean()
    : [subscriber];

  const seatIds = [...new Set(
    members.flatMap((m) => [
      ...(Array.isArray(m.previousSeasonSeats) ? m.previousSeasonSeats : []),
      m.prefSeatId
    ]).map(normSeatId).filter(Boolean)
  )];

  if (!seatIds.length) {
    const err = new Error('This subscriber has no seat to renew (prefSeatId/previousSeasonSeats empty)');
    err.statusCode = 400;
    throw err;
  }

  const contact = members.find((m) => m.email) || subscriber;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + RENEW_LINK_TTL_SECONDS;
  const token = jwt.sign(
    { seasonCode: subscriber.seasonCode, venueSlug: subscriber.venueSlug, email: contact.email || '', groupKey, seatIds, iat, exp },
    JWT_SECRET
  );

  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  // Chemin explicite (voir export-renew-groups.js).
  const url = `${base.replace(/\/+$/, '')}/season/${encodeURIComponent(subscriber.seasonCode)}/renew?id=${token}`;

  return { url, token, groupKey, seatIds, groupSize: members.length, expiresAt: new Date(exp * 1000) };
}

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const sub = await Subscriber.findById(id);
    if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });

    const body = req.body || {};
    if ('status' in body && !STATUSES.includes(body.status)) {
      return res.status(400).json({ ok: false, error: `Invalid status (expected one of: ${STATUSES.join(', ')})` });
    }

    for (const field of ['firstName', 'lastName', 'email', 'phone', 'prefSeatId', 'groupKey', 'notes']) {
      if (field in body) sub[field] = String(body[field] ?? '').trim();
    }
    if ('status' in body) sub.status = body.status;

    await sub.save();
    return res.json({ ok: true, subscriber: serializeSubscriber(sub) });
  } catch (err) {
    console.error('[admin/renewers] PATCH error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const sub = await Subscriber.findById(id);
    if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });

    sub.status = 'canceled';
    await sub.save();

    // Mirrors release-unrenewed-seats.js: only release a seat this cancellation
    // actually owns (provisionedFor === this subscriber, still 'provisioned').
    let seatReleased = false;
    if (sub.prefSeatId) {
      const result = await Seat.updateOne(
        { seasonCode: sub.seasonCode, venueSlug: sub.venueSlug, seatId: sub.prefSeatId, status: 'provisioned', provisionedFor: sub._id },
        { $set: { status: 'available', provisionedFor: null } }
      );
      seatReleased = (result.modifiedCount ?? result.nModified ?? 0) > 0;
    }

    return res.json({ ok: true, subscriber: serializeSubscriber(sub), seatReleased });
  } catch (err) {
    console.error('[admin/renewers] cancel error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

router.post('/:id/link', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const sub = await Subscriber.findById(id).lean();
    if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });

    const link = await buildRenewLink(sub, req);
    return res.json({ ok: true, ...link });
  } catch (err) {
    console.error('[admin/renewers] link error', err);
    return res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

router.post('/:id/send-email', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const sub = await Subscriber.findById(id);
    if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });
    if (!sub.email) return res.status(400).json({ ok: false, error: 'Subscriber has no email address' });

    const link = await buildRenewLink(sub, req);
    const subject = String(req.body?.subject || '').trim() || undefined;

    const job = await createJob({
      scriptId: 'season.send-renew-invites',
      params: {
        invitees: [{
          email: sub.email,
          renewUrl: link.url,
          firstName: sub.firstName || '',
          lastName: sub.lastName || '',
          seats: link.seatIds.join(', ')
        }],
        subject,
        seasonCode: sub.seasonCode,
        venue: sub.venueSlug
      },
      dryRun: false,
      requestedBy: 'admin-ui',
      requestContext: { integration: 'admin-ui', ip: req.ip, userAgent: req.get('user-agent') }
    });

    const finished = await runJob(job);

    if (finished.status !== 'succeeded') {
      return res.status(502).json({
        ok: false,
        error: finished.error?.message || 'Send failed',
        job: { id: String(finished._id), status: finished.status }
      });
    }

    const counts = finished.result?.payload?.counts || null;
    if (counts?.sent > 0) {
      sub.lastInviteSentAt = new Date();
      await sub.save();
    }

    return res.json({
      ok: true,
      subscriber: serializeSubscriber(sub),
      job: { id: String(finished._id), status: finished.status, summary: finished.result?.summary || '', counts }
    });
  } catch (err) {
    console.error('[admin/renewers] send-email error', err);
    return res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

export default router;
