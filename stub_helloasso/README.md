# HelloAsso Stub

Local development server that mimics a minimal subset of the HelloAsso Checkout API.

## Quick start

```bash
npm run helloasso:stub
# or
node stub_helloasso/server.js
```

The stub listens on `http://127.0.0.1:3005` by default. You can override the host and port:

```bash
HELLOASSO_STUB_HOST=0.0.0.0 HELLOASSO_STUB_PORT=4000 node stub_helloasso/server.js
```

## Wiring BTS to the stub

Set the following entries in your `.env` file while working locally:

```
HELLOASSO_API_URL=http://127.0.0.1:3005
HELLOASSO_ORG_SLUG=dev-stub
HELLOASSO_CLIENT_ID=stub-client
HELLOASSO_CLIENT_SECRET=stub-secret
HELLOASSO_WEBHOOK_URL=http://localhost:8080/pay/webhook
```

The existing `HELLOASSO_STUB` and `HELLOASSO_STUB_RESULT` flags become optional; the BTS application will now drive its normal HelloAsso code path against the stub URL.

## Features

- `POST /oauth2/token` returns a static bearer token (`helloasso-stub-token`).
- `POST /v5/organizations/:slug/checkout-intents` records a new in-memory intent and responds with a redirect URL pointing to the simulation screen.
- `GET /v5/checkout-intents/:id` (and the organisation-scoped variant) echoes the stored status so background jobs can poll for updates.
- Automatic webhook relay: when an intent transitions to a non-pending state, the stub POSTs a payment event to `HELLOASSO_WEBHOOK_URL` (or `HELLOASSO_STUB_WEBHOOK_URL`) after a short delay so the BTS async flow can react as if it came from HelloAsso.
- Web dashboard at `/` to inspect intents, choose the default scenario (manual, auto-success, auto-failure) and purge the in-memory store.
- Simulation screen at `/simulate/:intentId` presenting quick links for success, failure, error or “go back” flows. The links forward to the BTS application using the same query parameters as the real HelloAsso return URLs.

Data lives purely in memory; restart the stub to clear the state.
