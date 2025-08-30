

function normalizeEnv() {
  const v = String(process.env.HELLOASSO_ENV || '').trim().toLowerCase();
  if (['sandbox','dev','test'].includes(v)) return 'sandbox';
  if (['prod','production','live'].includes(v)) return 'prod';
  const legacy = String(process.env.HELLOASSO_USE_SANDBOX || '').trim().toLowerCase();
  if (legacy === 'true' || legacy === '1') return 'sandbox';
  return 'prod';
}

function pickPerEnv(baseKey, env) {
  const suffix = env === 'sandbox' ? '_SANDBOX' : '_PROD';
  return process.env[baseKey + suffix] || process.env[baseKey] || '';
}

function getHelloAssoConfig() {
  const env = normalizeEnv();

  const baseUri = process.env.HELLOASSO_BASE_URI || "api.helloasso.com";
  const tokenUri = process.env.HELLOASSO_TOKEN_URI || `${baseUri}/oauth2/token`;
  const apiBase  = process.env.HELLOASSO_API_BASE  || `${baseUri}/v5`;

  const orgSlug      = pickPerEnv('HELLOASSO_ORG_SLUG', env);
  const clientId     = pickPerEnv('HELLOASSO_CLIENT_ID', env);
  const clientSecret = pickPerEnv('HELLOASSO_CLIENT_SECRET', env);

  // ➜ URLs de retour spécifiques par environnement, avec fallback générique
  const returnUrl = pickPerEnv('HELLOASSO_RETURN_URL', env);
  const errorUrl  = pickPerEnv('HELLOASSO_ERROR_URL', env);
  const backUrl   = pickPerEnv('HELLOASSO_BACK_URL', env);

  return { env, baseUri, tokenUri, apiBase, orgSlug, clientId, clientSecret, returnUrl, errorUrl, backUrl };
}

export default getHelloAssoConfig;
