# OIDC stub

Local OpenID Connect / OAuth 2.0 identity provider for partner logins, in the
same spirit as the payment stubs. It hands out an identity to anyone who asks:
development only (refuses to start with `APP_ENV=production`).

## Quick start

```bash
npm run oidc:stub
# or
node stub_oidc/server.js
```

Listens on `http://127.0.0.1:3016`. Overrides:

```bash
OIDC_STUB_HOST=0.0.0.0 OIDC_STUB_PORT=4016 node stub_oidc/server.js
OIDC_STUB_PUBLIC_URL=http://oidc.local:3016   # issuer announced, if reached by another name
OIDC_STUB_KEY_FILE=/path/key.pem              # default: stub_oidc/.keys/signing-key.pem
```

## Two profiles

| Profile | Issuer / endpoints | Behaviour |
| --- | --- | --- |
| standard | `http://127.0.0.1:3016` (discovery at `/.well-known/openid-configuration`) | conformant OIDC: PKCE S256, JWKS, full id_token, JSON userinfo |
| sfi | `http://127.0.0.1:3016/sfi/oauth/v1/{authorize,token,infoUser}` | AISC / Castelis preprod: no discovery, `client_secret` required on `/token`, OAuth errors in HTTP 200, bare id_token, `infoUser` as a signed JWT |

Any `client_id` is accepted; the SFI profile needs a non-empty `client_secret`.

## Dashboard (`/`)

- **Default scenario**, applied to the next login:
  `manual` (login screen), `auto` (logs in with the default identity),
  `deny`, `no_nonce`, `wrong_nonce`, `bad_signature`, `expired`,
  `token_error`, `userinfo_error`.
  In `manual`, the login screen also lets you pick a scenario for one login.
- **Test identities** for each profile (SFI: spouse 1/0, number of children,
  company code).
- **`oidc` blocks to paste into `data/customization/partners.json`** for each
  profile, and the public key (PEM) for `idTokenPublicKey`.
- **Recent calls** (also at `/events.json`).

The signing key is kept in `stub_oidc/.keys/` (git-ignored), so a key pasted
into `partners.json` stays valid across restarts. Delete the file to rotate it.

## Wiring BTS

Paste the snippet from the dashboard into the partner's `oidc` block, keep
the partner's own `slug`, then open `<APP_URL>/partner/<slug>/auth/login`.

## Automated checks

`npm run test:oidc` and `npm run test:oidc-sfi` run the full login against the
same provider (`stub_oidc/idp.js`, mounted in memory on a free port), then make
every security check and scenario fail on purpose.
