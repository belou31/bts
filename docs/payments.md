---
title: Payments
nav_order: 80
---

# Payments

> Generated from code.
> Source: src/services/payments/* and src/services/payments/index.js
> Regenerate with: `npm run docs:refs`

## Provider switch

BTS selects its payment adapter through `PAYMENT_PROVIDER`.

## Shared payment surfaces

- checkout intent creation
- return/back/error URL construction
- payment status normalization
- intent polling and webhook reconciliation via `/pay/*`

## Registered providers

| Provider | Label | Default API base | Local stub | Webhook-driven |
| --- | --- | --- | --- | --- |
| `helloasso` | HelloAsso | `https://api.helloasso.com` | `npm run helloasso:stub` | yes |
| `mollie` | Mollie | `https://api.mollie.com/v2` | `npm run mollie:stub` | yes |
| `sumup` | SumUp | `https://api.sumup.com/v0.1` | `npm run sumup:stub` | yes |

## HelloAsso

- Provider ID: `helloasso`
- Default API base: `https://api.helloasso.com`
- Stub command: `npm run helloasso:stub`
- Uses webhook/async confirmation: yes

### Environment variables

- `PAYMENT_PROVIDER`
- `HELLOASSO_API_URL`
- `HELLOASSO_ORG_SLUG`
- `HELLOASSO_CLIENT_ID`
- `HELLOASSO_CLIENT_SECRET`
- `HELLOASSO_RETURN_URL`
- `HELLOASSO_BACK_URL`
- `HELLOASSO_ERROR_URL`
- `HELLOASSO_WEBHOOK_URL`
- `HELLOASSO_STUB_WEBHOOK_URL`
- `HELLOASSO_ENV`

### Notes

- Uses OAuth client credentials against the HelloAsso API.
- Supports local development through the HelloAsso stub by overriding HELLOASSO_API_URL.

## Mollie

- Provider ID: `mollie`
- Default API base: `https://api.mollie.com/v2`
- Stub command: `npm run mollie:stub`
- Uses webhook/async confirmation: yes

### Environment variables

- `PAYMENT_PROVIDER`
- `MOLLIE_API_BASE`
- `MOLLIE_API_KEY`
- `MOLLIE_CURRENCY`
- `MOLLIE_RETURN_URL`
- `MOLLIE_CANCEL_URL`
- `MOLLIE_WEBHOOK_URL`
- `MOLLIE_METHODS`

### Notes

- Uses API key auth (Bearer token) — no OAuth step needed.
- Webhook body is form-urlencoded: id=tr_xxxx. BTS fetches payment status from Mollie API upon receipt.
- Set MOLLIE_METHODS to a comma-separated list to restrict payment methods (e.g. "creditcard,wero").
- Wero is available in Germany and Belgium; France rollout expected mid/late 2026.

## SumUp

- Provider ID: `sumup`
- Default API base: `https://api.sumup.com/v0.1`
- Stub command: `npm run sumup:stub`
- Uses webhook/async confirmation: yes

### Environment variables

- `PAYMENT_PROVIDER`
- `SUMUP_API_BASE`
- `SUMUP_TOKEN_URL`
- `SUMUP_CLIENT_ID`
- `SUMUP_CLIENT_SECRET`
- `SUMUP_MERCHANT_CODE`
- `SUMUP_PAY_TO_EMAIL`
- `SUMUP_CURRENCY`
- `SUMUP_RETURN_URL`
- `SUMUP_CANCEL_URL`
- `SUMUP_ERROR_URL`
- `SUMUP_CALLBACK_URL`
- `SUMUP_WEBHOOK_URL`
- `SUMUP_OAUTH_SCOPES`
- `SUMUP_PAYMENT_TYPE`
- `SUMUP_CHECKOUT_PREFIX`

### Notes

- Uses OAuth client credentials against the SumUp API.
- Requires either SUMUP_MERCHANT_CODE or SUMUP_PAY_TO_EMAIL.
- Supports local development through the SumUp stub by overriding SUMUP_API_BASE and SUMUP_TOKEN_URL.

See also [stubs.md](stubs.md) for local simulator usage.

