# SumUp Stub

Local simulator for the SumUp Checkout API (`/v0.1/checkouts`).

## Quick start

```bash
npm run sumup:stub
# or
node stub_sumup/server.js
```

The stub listens on `http://127.0.0.1:3015` by default. Override host/port if needed:

```bash
SUMUP_STUB_HOST=0.0.0.0 SUMUP_STUB_PORT=4001 node stub_sumup/server.js
```

## Wiring BTS

Set the BTS application to use SumUp:

```
PAYMENT_PROVIDER=sumup
SUMUP_API_BASE=http://127.0.0.1:3015/v0.1
SUMUP_TOKEN_URL=http://127.0.0.1:3015/token
SUMUP_CLIENT_ID=stub-client
SUMUP_CLIENT_SECRET=stub-secret
SUMUP_RETURN_URL=http://localhost:8080/pay/return
SUMUP_CALLBACK_URL=http://localhost:8080/pay/webhook
SUMUP_CURRENCY=EUR
```

## Features

- `POST /token` returns a static bearer token (`sumup-stub-token`).
- `POST /v0.1/checkouts` creates in-memory checkouts and responds with a redirect URL to the simulator.
- `GET /v0.1/checkouts/:checkout_reference` exposes the latest status for polling jobs.
- Web dashboard at `/` to inspect checkouts, mark success/failure, and trigger webhooks.
- Simulation screen `/simulate/:checkout_reference` provides quick links to complete or fail the payment flow, redirecting to the configured return URLs.

Webhooks (if `SUMUP_WEBHOOK_URL` is defined) are emitted asynchronously after the status changes, mimicking SumUp’s notifications.
