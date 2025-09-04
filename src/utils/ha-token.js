// src/utils/ha-token.js
import { createHash } from 'node:crypto';

export function makeTokenHash({ orderId, checkoutIntentId, secret = (process.env.HA_TOKEN_SECRET || process.env.APP_SECRET || '') }) {
  const base = `${orderId}:${checkoutIntentId}:${secret}`;
  return createHash('sha256').update(base).digest('hex').slice(0, 40); // court & suffisant
}
