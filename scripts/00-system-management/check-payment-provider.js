#!/usr/bin/env node
/**
 * Vérifie les identifiants du prestataire de paiement, sans créer de commande.
 *
 * Un 401 au moment du paiement ne dit pas LEQUEL des réglages est en cause :
 * clé absente, clé d'un autre compte, clé de test contre l'API de production,
 * ou simplement un espace de trop collé dans .env. Ce script pose la question
 * directement à SumUp et rapporte la réponse.
 *
 * N'AFFICHE JAMAIS la clé : seulement sa présence, sa longueur, et si elle
 * porte des espaces parasites.
 *
 * Usage:
 *   node scripts/00-system-management/check-payment-provider.js
 */
import { loadEnv } from '../lib/load-env.js';

// Même séquence que src/server.js : `.env` puis `.env.<PAYMENT_PROVIDER>`.
// Se contenter de dotenv.config() ne lisait que le premier, et le script
// annonçait « non défini » pour des identifiants parfaitement présents.
const ENV = loadEnv();

const API_BASE = String(process.env.SUMUP_API_BASE || 'https://api.sumup.com/v0.1').trim().replace(/\/+$/, '');
const TOKEN_URL = String(process.env.SUMUP_TOKEN_URL || 'https://api.sumup.com/token').trim();

// SumUp distingue deux clés, dont une seule authentifie l'API serveur :
//   sup_pk_… : clé PUBLIQUE, destinée au navigateur (widget de paiement).
//              Elle n'est pas secrète et ne donne accès à aucun appel serveur.
//   sup_sk_… : clé SECRÈTE, la seule acceptée sur /checkouts.
// Les deux se ressemblent et se copient depuis le même écran : c'est l'erreur
// la plus facile à commettre, et elle se manifeste par un 401 sans explication.
function classifyKey(key) {
  if (!key) return null;
  if (/^sup_pk_/i.test(key)) return { kind: 'publique', ok: false };
  if (/^sup_sk_/i.test(key)) return { kind: 'secrète', ok: true };
  return { kind: 'préfixe inconnu', ok: null };
}

function describeSecret(name) {
  const raw = process.env[name];
  if (raw === undefined) return `${name} : (non défini)`;
  const trimmed = raw.trim();
  const notes = [];
  if (!trimmed) notes.push('VIDE');
  if (raw !== trimmed) notes.push('⚠ espaces/retour-ligne parasites — cause classique de 401');
  if (name === 'SUMUP_API_KEY') {
    const cls = classifyKey(trimmed);
    if (cls) notes.push(`clé ${cls.kind}${cls.ok === false ? ' ❌' : cls.ok === true ? ' ✅' : ''}`);
  }
  return `${name} : ${trimmed.length} caractères${notes.length ? ' — ' + notes.join(', ') : ''}`;
}

async function resolveToken() {
  const key = String(process.env.SUMUP_API_KEY || '').trim();
  if (key) return { mode: 'SUMUP_API_KEY', token: key };

  const id = String(process.env.SUMUP_CLIENT_ID || '').trim();
  const secret = String(process.env.SUMUP_CLIENT_SECRET || '').trim();
  if (!id || !secret) {
    return { mode: 'aucun', token: null, error: 'Ni SUMUP_API_KEY, ni SUMUP_CLIENT_ID/SECRET.' };
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret });
  if (process.env.SUMUP_OAUTH_SCOPES) body.set('scope', String(process.env.SUMUP_OAUTH_SCOPES).trim());

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { mode: 'OAuth', token: null, error: `token ${r.status} ${JSON.stringify(j)}` };
  return { mode: 'OAuth', token: j.access_token, scopes: j.scope || null };
}

async function checkHelloAsso() {
  console.log('Configuration HelloAsso');
  console.log(`  org slug        : ${process.env.HELLOASSO_ORG_SLUG || '(non défini)'}`);
  console.log(`  ${describeSecret('HELLOASSO_CLIENT_ID')}`);
  console.log(`  ${describeSecret('HELLOASSO_CLIENT_SECRET')}`);

  const id = String(process.env.HELLOASSO_CLIENT_ID || '').trim();
  const secret = String(process.env.HELLOASSO_CLIENT_SECRET || '').trim();
  if (!id || !secret) {
    console.log('\n❌ Identifiants HelloAsso incomplets.');
    process.exitCode = 1;
    return;
  }
  const url = (process.env.HELLOASSO_API_URL || 'https://api.helloasso.com/v5').trim().replace(/\/+$/, '');
  const tokenUrl = url.replace(/\/v\d+$/, '') + '/oauth2/token';
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log(`\n❌ ${r.status} — HelloAsso refuse ces identifiants : ${JSON.stringify(j).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n✅ Identifiants acceptés (jeton obtenu).');
}

async function main() {
  console.log(`Environnement chargé : ${ENV.files.join(', ') || '(aucun fichier .env trouvé)'}`);
  console.log(`Prestataire actif    : ${ENV.provider || '(PAYMENT_PROVIDER non défini)'}`);
  console.log('');

  // Ne teste que le prestataire RÉELLEMENT configuré : contrôler SumUp sur une
  // installation HelloAsso ne rapportait que des variables « non définies »,
  // ce qui ressemblait à une panne alors que tout était en ordre.
  if (ENV.provider && ENV.provider !== 'sumup') {
    if (ENV.provider === 'helloasso') return checkHelloAsso();
    console.log(`Prestataire « ${ENV.provider} » : aucun contrôle spécifique implémenté.`);
    return;
  }

  console.log('Configuration SumUp');
  console.log(`  api base        : ${API_BASE}`);
  console.log(`  merchant code   : ${process.env.SUMUP_MERCHANT_CODE || '(non défini)'}`);
  console.log(`  pay_to_email    : ${process.env.SUMUP_PAY_TO_EMAIL || '(non défini)'}`);
  console.log(`  ${describeSecret('SUMUP_API_KEY')}`);
  console.log(`  ${describeSecret('SUMUP_CLIENT_ID')}`);
  console.log(`  ${describeSecret('SUMUP_CLIENT_SECRET')}`);

  const { mode, token, error, scopes } = await resolveToken();
  console.log(`\nAuthentification : ${mode}`);
  if (scopes) console.log(`  scopes accordés : ${scopes}`);
  if (!token) {
    console.log(`❌ Aucun jeton utilisable : ${error}`);
    process.exitCode = 1;
    return;
  }

  // GET /me : le test d'identité le plus léger. Il dit à QUEL compte la clé
  // donne accès, ce qui permet de comparer avec SUMUP_MERCHANT_CODE.
  const r = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));

  if (r.status === 401) {
    console.log('\n❌ 401 — SumUp refuse ces identifiants.');
    const cls = classifyKey(String(process.env.SUMUP_API_KEY || '').trim());
    if (cls && cls.ok === false) {
      console.log('   ➜ CAUSE TROUVÉE : SUMUP_API_KEY est une clé PUBLIQUE (sup_pk_…).');
      console.log('     Elle sert au widget côté navigateur et n\'authentifie aucun appel serveur.');
      console.log('     Utiliser la clé SECRÈTE (sup_sk_…), depuis le tableau de bord SumUp');
      console.log('     → Développeurs / API keys.');
      process.exitCode = 1;
      return;
    }
    console.log('   • clé révoquée, expirée, ou appartenant à un autre compte ;');
    console.log('   • clé de TEST utilisée contre l\'API de production (ou l\'inverse) ;');
    console.log('   • clé recopiée partiellement (comparer la longueur ci-dessus au tableau de bord SumUp).');
    process.exitCode = 1;
    return;
  }
  if (!r.ok) {
    console.log(`\n⚠ Réponse inattendue ${r.status} : ${JSON.stringify(j).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const account = j?.merchant_profile?.merchant_code || j?.merchant_code || null;
  console.log('\n✅ Identifiants acceptés.');
  console.log(`   compte SumUp    : ${account || '(code marchand non renvoyé)'}`);
  if (account && process.env.SUMUP_MERCHANT_CODE && account !== String(process.env.SUMUP_MERCHANT_CODE).trim()) {
    // Signalé, pas condamné : un écart est NORMAL quand SUMUP_MERCHANT_CODE
    // désigne un sous-compte (bac à sable) rattaché au compte de la clé.
    // /me renvoie le compte propriétaire de la clé, pas le marchand facturé.
    // Ne pas conclure à une panne : si les checkouts aboutissent, la
    // combinaison est acceptée par SumUp telle quelle.
    console.log(`   ⚠ SUMUP_MERCHANT_CODE vaut « ${process.env.SUMUP_MERCHANT_CODE} », la clé appartient à « ${account} ».`);
    console.log('     Normal si le premier est un sous-compte (bac à sable) du second.');
    console.log('     À vérifier seulement si la CRÉATION du checkout échoue en 401/403 :');
    console.log('     les paiements qui aboutissent prouvent que SumUp accepte cette combinaison.');
  }
}

main().catch((e) => {
  console.error('❌', e?.message || e);
  process.exitCode = 1;
});
