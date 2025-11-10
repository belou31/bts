// src/utils/channel-scopes.js

function normalizeChannelToken(token) {
  if (!token && token !== 0) return '';
  return String(token).trim().toLowerCase();
}

export function normalizeChannelList(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input
      .map(normalizeChannelToken)
      .filter(Boolean)
      .map((token) => (token === 'partner:*' ? 'partner' : token));
  }
  if (typeof input === 'string') {
    return input
      .split(/[,;\s]+/)
      .map(normalizeChannelToken)
      .filter(Boolean)
      .map((token) => (token === 'partner:*' ? 'partner' : token));
  }
  return [];
}

export function serializeChannelList(input) {
  const list = normalizeChannelList(input);
  return list.length ? Array.from(new Set(list)) : undefined;
}

export function matchesChannel(list, context = { kind: 'public' }) {
  const channels = normalizeChannelList(list);
  const scoped = channels.length ? channels : ['public'];

  if (scoped.includes('all')) return true;

  const kind = context?.kind || 'public';
  if (kind === 'partner') {
    const slug = normalizeChannelToken(context.partnerSlug || '');
    if (slug && (scoped.includes(`partner:${slug}`) || scoped.includes('partner'))) {
      return true;
    }
    if (!slug) {
      return scoped.includes('partner');
    }
    return false;
  }

  if (kind === 'public' || kind === 'event') {
    return scoped.includes('public');
  }

  if (kind === 'subscription') {
    return scoped.includes('subscription') || scoped.includes('public');
  }

  return scoped.includes(kind);
}

export function describeChannelContext(flowKey, extras = {}) {
  if (flowKey === 'partner') {
    return {
      kind: 'partner',
      partnerSlug: serializeSlug(extras.partnerSlug)
    };
  }
  return { kind: flowKey === 'event' ? 'public' : flowKey };
}

function serializeSlug(value) {
  if (!value) return '';
  return String(value).trim().toLowerCase();
}

