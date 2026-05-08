---
title: Configuration
nav_order: 40
---

# Configuration

## Main configuration families

- Core server: `HOST`, `PORT`, `BASE_PATH`, `APP_ENV`, `APP_URL`
- Database: `MONGO_URI`
- Admin auth: `ADMIN_TOKEN`, `ADMIN_USER`, `ADMIN_PASS`
- Payment provider switch: `PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_NAME`
- HelloAsso: API base URL, org slug, OAuth credentials, webhook/return URLs
- SumUp: API base URL, OAuth credentials, callback/return URLs
- Automation JWT: shared secret, issuer, audience, scopes
- Partner embedding/security: frame ancestors and partner-specific options

## Next step

Phase 2 should turn this into a variable-by-variable reference with environment examples for DEV, INT, and PROD.
