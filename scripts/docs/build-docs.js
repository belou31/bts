// scripts/docs/build-docs.js
// Génère les docs HTML Phase 1 dans le dossier /docs, prêtes pour GitHub Pages.
// Usage: node scripts/docs/build-docs.js

import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';
dotenv.config();


const OUT_DIR = path.resolve(process.cwd(), 'docs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const today = new Date().toISOString().slice(0, 10);

// CSS commun
const BASE_CSS = `
:root{
  --bg:#0f172a; --panel:#111827; --text:#e5e7eb; --muted:#94a3b8; --border:#1f2937;
  --accent:#22d3ee; --ok:#34d399; --warn:#fbbf24; --danger:#f87171;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0b1020;color:var(--text);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}
.container{max-width:1100px;margin:0 auto;padding:24px}
header{position:sticky;top:0;background:rgba(17,24,39,.9);border-bottom:1px solid var(--border);backdrop-filter:saturate(140%) blur(6px);}
header .inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:14px;padding:12px 24px}
header img{height:38px}
h1{font-size:28px;margin:18px 0 8px}
h2{font-size:22px;margin:20px 0 8px}
h3{font-size:18px;margin:18px 0 6px}
p{margin:8px 0}
ul{margin:6px 0 12px 22px}
code,kbd,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,"Courier New",monospace}
pre{background:#0b1020;border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;white-space:pre}
table{width:100%;border-collapse:collapse;margin:10px 0 16px}
th,td{border:1px solid var(--border);padding:8px;vertical-align:top}
.small{color:var(--muted);font-size:12px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin:16px 0}
footer{border-top:1px solid var(--border);margin-top:24px;padding:16px 24px;color:var(--muted)}
.toc{background:#0b1020;border:1px solid var(--border);border-radius:12px;padding:12px}
hr{border:none;border-top:1px solid var(--border);margin:16px 0}
`;

// Helpers
const head = (title) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header><div class="inner">
  <img src="logo.png" alt="Belougas" />
  <div>
    <div class="small">BelougasTicketingSystem · Phase 1 · ${today}</div>
    <strong>${title}</strong>
  </div>
</div></header>
<main class="container">
`;

const foot = `</main>
<footer>
  <div>Licence MIT · © TBHC / Belougas</div>
</footer>
</body></html>`;

function writeHtml(filename, title, body) {
  fs.writeFileSync(path.join(OUT_DIR, filename), head(title) + body + foot, 'utf8');
  console.log('✓', filename);
}

/* -----------------------------
 * 01 – Cahier des charges
 * ----------------------------- */
const body1 = `
<div class="card">
  <h1>Cahier des charges – Phase 1 (Renew)</h1>
  <p><strong>Projet</strong> : BelougasTicketingSystem (BTS) – Club de hockey Belougas<br/>
     <strong>Date</strong> : ${today}<br/>
     <strong>Licence</strong> : MIT</p>
</div>

<h2>1. Contexte &amp; objectifs</h2>
<ul>
  <li>Billetterie auto-hébergée (OVH VPS), open source, Node.js/Express + MongoDB.</li>
  <li>Intégration paiement via HelloAsso CheckOut (sandbox en INT, production en PROD).</li>
  <li>Phase 1 centrée sur les <strong>renouvellements</strong> d’abonnements existants (sans QR-code).</li>
  <li>Front léger (HTML/CSS/JS statiques), intégrable dans WordPress via iframe.</li>
</ul>

<h2>2. Périmètre fonctionnel Phase 1</h2>
<h3>2.1 Renouvellements (scénario 1)</h3>
<ul>
  <li>Lien personnalisé (token) envoyé aux abonnés N-1.</li>
  <li>Affichage plan SVG (venue) avec surbrillance des sièges à renouveler.</li>
  <li>Choix du tarif par siège, justificatifs, paiement 1/2/3 fois.</li>
  <li>Attestation e-mail après paiement validé (pas de QR-code en Phase 1).</li>
</ul>
<h3>2.2 Provision & synchronisation</h3>
<ul>
  <li>Sièges N-1 marqués <em>provisioned</em> (non réservable public), visibles sur le plan.</li>
  <li>À clôture administrateur, sièges non renouvelés → <em>available</em> (phase publique).</li>
</ul>
<h3>2.3 Administration (extraits)</h3>
<ul>
  <li>Import/export abonnés (CSV <em>flat</em> 1 ligne = 1 siège), catalogue tarifs, prix par zone.</li>
  <li>Gestion des saisons (code, venueSlug, phases).</li>
  <li>E-mails : test SMTP, invitations renew (bulk), attestation post-paiement.</li>
</ul>

<h2>3. Contraintes &amp; exigences</h2>
<ul>
  <li>Node ≥ 20, Mongo ≥ 6, Nginx, PM2, Ubuntu 22.04.</li>
  <li>Sécurité : ENV séparés DEV/INT/PROD, auth Mongo, .env, HTTPS, CORS, rate-limit.</li>
  <li>Interop : HelloAsso sandbox/prod, e-mail Gmail (mot de passe application).</li>
  <li>UX : responsive, tarifs dynamiques (prix & justificatifs).</li>
  <li>Perf : CSV, indexes, TTL sur réservations (<code>SeatHold</code>).</li>
</ul>

<h2>4. Hors périmètre</h2>
<ul>
  <li>Vente publique complète, TBH7 si non finalisé, QR-code par match, multi-événements avancés, reporting BI.</li>
</ul>

<h2>5. KPI</h2>
<ul>
  <li>Taux de renouvellement, paiements confirmés, erreurs paiement, délivrabilité e-mail.</li>
</ul>

<h2>6. Dépôt</h2>
<p>Dépôt GitHub public <code>belou00/bts</code> – branches : <code>main</code> (PROD), <code>int</code> (INT), <code>dev</code> (DEV).</p>
`;

/* -----------------------------
 * 02 – Gestion de projet
 * ----------------------------- */
const body2 = `
<div class="card"><h1>Gestion de projet – Approche agile</h1></div>
<h2>1. Organisation</h2>
<ul>
  <li>Backlog GitHub (Issues/Projects), épique « Phase 1 – Renew ».</li>
  <li>Itérations courtes (1–2 jours), démonstrations en INT.</li>
  <li>DoD : code linté/testé, scriptable (import/export), doc à jour, test fumée INT OK.</li>
</ul>
<h2>2. Environnements</h2>
<ul>
  <li><strong>DEV</strong> : Node/Express local, HelloAsso stub possible.</li>
  <li><strong>INT</strong> : VPS OVH, <code>billetterie-dev.belougas.fr</code>, Mongo <code>bts_int</code>, HA sandbox, PM2 <code>bts-int</code>.</li>
  <li><strong>PROD</strong> : VPS OVH, <code>billetterie.belougas.fr</code>, Mongo <code>bts_prod</code>, HA prod, PM2 <code>bts-prod</code>.</li>
</ul>
<h2>3. Versionning & déploiement</h2>
<ul>
  <li>Flux à 3 branches : <code>dev → int → main</code>.</li>
  <li>INT : <code>git reset --hard origin/int && npm ci && pm2 restart bts-int</code></li>
  <li>PROD : <code>git reset --hard origin/main && npm ci && pm2 restart bts-prod</code></li>
</ul>
<h2>4. Qualité & tests</h2>
<ul>
  <li>Tests manuels guidés, scripts CSV, /health, paiements sandbox, attestation e-mail.</li>
  <li>Audit CSV : cohérence sièges/renouvellements/prix.</li>
</ul>
`;

/* -----------------------------
 * 03 – Architecture (avec arbo détaillée)
 * ----------------------------- */
const body3 = `
<div class="card"><h1>Architecture générale</h1></div>

<h2>1. Vue d’ensemble</h2>
<ul>
  <li>API Node.js/Express (routes REST + front statique sous <code>/static</code> et <code>/venues/&lt;slug&gt;/plan.svg</code>).</li>
  <li>MongoDB : <code>Subscriber</code>, <code>Seat</code>, <code>SeatHold</code>, <code>Season</code>, <code>Tariff</code>, <code>TariffPrice</code>, <code>Counter</code>, <code>Order</code>.</li>
  <li>Paiement HelloAsso (sandbox/prod) ; attestation e-mail après retour.</li>
  <li>Infra : Nginx (TLS) + PM2 (bts-int, bts-prod) sur VPS OVH.</li>
</ul>

<h2>2. Arborescence (principale)</h2>
<pre><code>.
├── data/                         # CSV d'import/export (tarifs, prix, abonnés, liens)
├── docs/                         # Pages HTML de documentation (GitHub Pages)
├── scripts/
│   ├── docs/
│   │   └── build-docs.js         # Générateur des pages HTML (ce fichier)
│   ├── email/
│   │   └── send-renew-invites.js # Envoi d'invitations renew (CSV)
│   ├── renewal/
│   │   └── provision-seats.js    # Provision des sièges N-1 → status=provisioned
│   ├── tariffs/
│   │   └── import-catalog.js     # Import du catalogue des tarifs (codes/labels/justifs)
│   ├── pricing/
│   │   └── import-zone-tariffs.js# Import des prix par zone/saison/venue
│   ├── import-subscribers-flat.js# Import abonnés "1 ligne = 1 siège"
│   └── export-renew-groups.js    # Export des liens renew "par groupe"
├── src/
│   ├── config/
│   │   └── env.js                # Sélection des variables selon APP_ENV (dev/int/prod)
│   ├── loaders/
│   │   ├── express.js            # Création app Express, static (/static, /venues, basePath)
│   │   ├── mongo.js              # Connexion Mongo (MONGO_URI_DEV/INT/PROD)
│   │   └── mailer.js             # Nodemailer (Gmail), bascule MAIL_ENABLED
│   ├── models/
│   │   ├── Counter.js            # Compteur (séquences: subscriberNo)
│   │   ├── Order.js              # Commande (checkoutId, payer, lines, status)
│   │   ├── Seat.js               # Siège (status available/provisioned/held/booked)
│   │   ├── SeatHold.js           # Blocage temporaire (TTL index)
│   │   ├── Season.js             # Saison (code, venueSlug, phases)
│   │   ├── Subscriber.js         # Abonné (groupKey, subscriberNo, ...)
│   │   ├── Tariff.js             # Catalogue de tarifs (codes, labels, champs requis)
│   │   └── TariffPrice.js        # Prix par zone/saison/venue/tarif
│   ├── routes/
│   │   ├── index.js              # Montage des sous-routes
│   │   ├── renew.js              # GET/POST renouvellement (token → sièges, tarifs, checkout)
│   │   ├── payments-helloasso.js # POST checkout HelloAsso (intent)
│   │   ├── ha.js                 # GET /ha/return|back|error (validation + attestation e-mail)
│   │   ├── admin.js              # Admin (phases, close/open renewal, etc.)
│   │   └── admin-email.js        # Test e-mail SMTP
│   ├── services/
│   │   ├── attestation.js        # Rendu HTML de l’attestation e-mail
│   │   ├── helloasso.js          # Client HelloAsso (token, endpoints, status)
│   │   └── mailer.js             # Envoi d’e-mails (from/subject/html...)
│   ├── utils/
│   │   ├── money.js              # fmtEuros, splitInstallments...
│   │   └── pricing.js            # needJustification, computeSubscriptionPriceCents
│   ├── public/
│   │   ├── html/
│   │   │   └── renew.html        # Front Renew (HTML)
│   │   ├── styles/
│   │   │   └── renew.css         # Styles
│   │   ├── static/
│   │   │   └── img/logo.png      # Logo club
│   │   └── venues/
│   │       └── patinoire-blagnac/
│   │           └── plan.svg      # Plan SVG (ids de sièges)
│   └── server.js                 # Entrée de l'application (start Express + Mongo)
├── package.json
└── README.md
</code></pre>

<h2>3. Modèles clés (rappel)</h2>
<table>
<tr><th>Modèle</th><th>Champs principaux</th></tr>
<tr><td>Season</td><td>code, name, active, <strong>venueSlug</strong>, phases[{name,openAt,closeAt,enabled}]</td></tr>
<tr><td>Seat</td><td>seatId, zoneKey, seasonCode, venueSlug, status, provisionedFor</td></tr>
<tr><td>SeatHold</td><td>seatId, orderId, expiresAt (TTL index)</td></tr>
<tr><td>Subscriber</td><td>subscriberNo?, firstName, lastName, email, phone, group, groupKey, previousSeasonSeats, status</td></tr>
<tr><td>Tariff</td><td>code, label, active, requiresField, fieldLabel, requiresInfo, sortOrder</td></tr>
<tr><td>TariffPrice</td><td>seasonCode, venueSlug, zoneKey, tariffCode, priceCents</td></tr>
<tr><td>Counter</td><td>key, seq (numérotation abonné)</td></tr>
<tr><td>Order</td><td>seasonCode, payer, totalCents, installments, status, checkoutIntentId, haPaymentRef?, lines[{seatId,zoneKey,tariffCode,priceCents,subscriberId}]</td></tr>
</table>
`;

/* -----------------------------
 * 04 – Installation (plus de commandes + résultats attendus)
 * ----------------------------- */
const body4 = `
<div class="card"><h1>Guide d’installation</h1></div>

<h2>1. Pré-requis</h2>
<ul>
  <li>Ubuntu 22.04, Node ≥ 20, npm ≥ 10, MongoDB, Nginx, Certbot.</li>
  <li>DNS : <code>billetterie-dev.belougas.fr</code> (INT) et <code>billetterie.belougas.fr</code> (PROD) → IP VPS.</li>
</ul>

<h2>2. Vérifications de base</h2>
<pre><code>node -v           # → v20.x
npm -v            # → 10.x
mongod --version  # → &gt;= 6.x
nginx -v          # → nginx/1.2x
</code></pre>

<h2>3. Dépôts & arborescence</h2>
<pre><code>sudo mkdir -p /var/www/bts-int /var/www/bts-prod /var/log/pm2
sudo chown -R $USER:$USER /var/www

git clone git@github.com:belou00/bts.git /var/www/bts-int
cd /var/www/bts-int &amp;&amp; git checkout int &amp;&amp; npm ci --omit=dev

git clone git@github.com:belou00/bts.git /var/www/bts-prod
cd /var/www/bts-prod &amp;&amp; git checkout main &amp;&amp; npm ci --omit=dev
</code></pre>

<h2>4. MongoDB (auth + utilisateurs)</h2>
<p><strong>/etc/mongod.conf</strong> :</p>
<pre><code>security:
  authorization: enabled
net:
  bindIp: 127.0.0.1
</code></pre>
<p>Création des users :</p>
<pre><code>// INT
use bts_int
db.createUser({ user:"bts_int", pwd:"***", roles:[{role:"readWrite",db:"bts_int"}] })
// PROD
use bts_prod
db.createUser({ user:"bts_prod", pwd:"***", roles:[{role:"readWrite",db:"bts_prod"}] })
</code></pre>
<p><em>Tests attendus</em> :</p>
<pre><code>mongosh "mongodb://bts_int:&lt;PASS&gt;@127.0.0.1:27017/bts_int?authSource=bts_int" --eval 'db.runCommand({ping:1})'
# → { ok: 1 }
</code></pre>

<h2>5. Variables d’environnement (INT exemple)</h2>
<pre><code>APP_ENV=integration
PORT=8081
MONGO_URI_INT=mongodb://bts_int:&lt;PASS&gt;@127.0.0.1:27017/bts_int?authSource=bts_int
JWT_SECRET=***INT***

HELLOASSO_ENV=sandbox
HELLOASSO_ORG_SLUG=...
HELLOASSO_CLIENT_ID_SANDBOX=...
HELLOASSO_CLIENT_SECRET_SANDBOX=...
HELLOASSO_RETURN_URL_SANDBOX=https://billetterie-dev.belougas.fr/bts/ha/return
HELLOASSO_ERROR_URL_SANDBOX=https://billetterie-dev.belougas.fr/bts/ha/error
HELLOASSO_BACK_URL_SANDBOX=https://billetterie-dev.belougas.fr/bts/ha/back

APP_URL=https://billetterie-dev.belougas.fr/bts
SELF_API_BASE=http://127.0.0.1:8081
FRONTEND_ORIGIN=https://billetterie-dev.belougas.fr

GMAIL_USER=...
GMAIL_APP_PASSWORD=...
FROM_EMAIL=billetterie@tbhc.fr
</code></pre>

<h2>6. PM2 (démarrage + tests)</h2>
<pre><code>pm2 start /var/www/ecosystem.config.js --only bts-int
pm2 status
pm2 logs bts-int --lines 50
# Attendu dans les logs : "[BTS] Mongo connected", "API listening on http://localhost:8081"
</code></pre>

<h2>7. Nginx &amp; TLS</h2>
<p>Test du proxy :</p>
<pre><code>curl -s https://billetterie-dev.belougas.fr/bts/health | jq .
# Attendu: {"ok":true,"env":"integration",...}
</code></pre>
<p>Challenge ACME (si besoin) :</p>
<pre><code>sudo mkdir -p /var/www/html/.well-known/acme-challenge
echo ok | sudo tee /var/www/html/.well-known/acme-challenge/test.txt
curl -I http://billetterie-dev.belougas.fr/.well-known/acme-challenge/test.txt
# Attendu: 200 OK (ou 301→200), pas d'intercepteur tiers
</code></pre>

<h2>8. Tests fonctionnels</h2>
<pre><code># Front statique (CSS/plan)
curl -I https://billetterie-dev.belougas.fr/bts/static/styles/renew.css     # → 200
curl -I https://billetterie-dev.belougas.fr/bts/venues/patinoire-blagnac/plan.svg  # → 200

# Santé API
curl -s https://billetterie-dev.belougas.fr/bts/health | jq .

# E-mail test (adapter requireAdmin)
curl -s "https://billetterie-dev.belougas.fr/bts/api/admin/email/test?to=toi@mail.com" \
  -H "x-admin-key: &lt;SECRET&gt;" | jq .
</code></pre>
`;

/* -----------------------------
 * 05 – Exploitation (commandes + formats CSV)
 * ----------------------------- */
const body5 = `
<div class="card"><h1>Guide d’exploitation</h1></div>

<h2>1. Opérations courantes</h2>
<ul>
  <li>Status/logs : <code>pm2 status</code>, <code>pm2 logs bts-int|bts-prod</code></li>
  <li>Santé : <code>GET /bts/health</code></li>
  <li>Déploiement : INT → <code>reset origin/int</code> ; PROD → <code>reset origin/main</code> + <code>npm ci</code> + <code>pm2 restart</code></li>
  <li>Backups Mongo : <code>mongodump --db bts_prod</code></li>
</ul>

<h2>2. Démarrer une nouvelle saison</h2>
<ol>
  <li>Créer la <strong>saison</strong> (<code>Season</code> : code, name, venueSlug, phases).</li>
  <li>Importer <strong>catalogue</strong> de tarifs (tarifs génériques).</li>
  <li>Importer <strong>prix par zone</strong> (saison/venue).</li>
  <li>Importer <strong>subscribers_flat</strong> (1 ligne = 1 siège).</li>
  <li><strong>Provisionner</strong> les sièges N-1.</li>
  <li>Exporter <strong>liens renew</strong> par groupe et envoyer invitations.</li>
</ol>

<h2>3. Commandes (INT exemple)</h2>
<h3>3.1 Catalogue de tarifs (import)</h3>
<pre><code>node -r dotenv/config scripts/tariffs/import-catalog.js data/tariff_catalog.csv \\
  dotenv_config_path=.env.int
# Attendu: "Imported &lt;n&gt; tariffs" / diff si mise à jour
</code></pre>

<h3>3.2 Prix par zone (import)</h3>
<pre><code>node -r dotenv/config scripts/pricing/import-zone-tariffs.js 2025-2026 patinoire-blagnac \\
  data/prices_patinoire-blagnac.csv dotenv_config_path=.env.int
# Attendu: "Upserted &lt;n&gt; zone prices"
</code></pre>

<h3>3.3 Abonnés (flat, 1 ligne = 1 siège)</h3>
<pre><code>node -r dotenv/config scripts/import-subscribers-flat.js data/subscribers_flat.csv 2025-2026 \\
  --venue=patinoire-blagnac dotenv_config_path=.env.int
# Attendu: "Imported &lt;n&gt; subscriber seat lines"
</code></pre>

<h3>3.4 Provision des sièges N-1</h3>
<pre><code>node -r dotenv/config scripts/renewal/provision-seats.js 2025-2026 \\
  --venue=patinoire-blagnac --apply dotenv_config_path=.env.int
# Attendu: "scanned=&lt;n&gt; provisioned=&lt;m&gt; ..."
</code></pre>

<h3>3.5 Export des liens renew (groupes)</h3>
<pre><code>node -r dotenv/config scripts/export-renew-groups.js 2025-2026 \\
  --base=https://billetterie-dev.belougas.fr/bts --out=renew-groups-int.csv \\
  dotenv_config_path=.env.int
# Fichier généré: renew-groups-int.csv
</code></pre>

<h3>3.6 Envoi d’invitations (e-mail)</h3>
<pre><code># DRY-RUN
node -r dotenv/config scripts/email/send-renew-invites.js renew-groups-int.csv \\
  --season=2025-2026 --venue=patinoire-blagnac --fromName="TBHC Billetterie" \\
  --dry dotenv_config_path=.env.int

# ENVOI RÉEL
node -r dotenv/config scripts/email/send-renew-invites.js renew-groups-int.csv \\
  --season=2025-2026 --venue=patinoire-blagnac --fromName="TBHC Billetterie" \\
  dotenv_config_path=.env.int
</code></pre>

<h3>3.7 Clôturer la phase renew</h3>
<p>(si route admin activée)</p>
<pre><code>curl -X POST https://billetterie-dev.belougas.fr/bts/api/admin/renewal/close \\
  -H "x-admin-key: &lt;SECRET&gt;"
# Attendu: { "ok": true, "released": &lt;n&gt; }
</code></pre>

<h2>4. Formats CSV (en-têtes & exemples)</h2>

<h3>4.1 Catalogue des tarifs – <code>data/tariff_catalog.csv</code></h3>
<p><strong>En-têtes :</strong> <code>code,label,active,requiresField,fieldLabel,requiresInfo,sortOrder</code></p>
<pre><code>code,label,active,requiresField,fieldLabel,requiresInfo,sortOrder
NORMAL,TARIF NORMAL,true,false,,false,10
ETUDIANT,TARIF ETUDIANT,true,true,Numéro INE,true,20
12_17,TARIF 12-17 ANS,true,false,,true,30
U12,TARIF MOINS DE 12 ANS,true,false,,true,40
LIC_MAJ,TARIF CLUB - LICENCIE MAJEUR,true,true,Numéro de licence,false,50
LIC_MIN,TARIF CLUB - LICENCIE MINEUR,true,true,Numéro de licence,false,60
PARENT,TARIF CLUB - PARENT DE LICENCIE,true,true,Numéro de licence,true,70
</code></pre>

<h3>4.2 Prix par zone – <code>data/prices_patinoire-blagnac.csv</code></h3>
<p><strong>En-têtes :</strong> <code>zoneKey,tariffCode,priceCents</code></p>
<pre><code>zoneKey,tariffCode,priceCents
N1,NORMAL,18000
N1,ETUDIANT,12600
N1,12_17,12000
N1,U12,9000
S1,NORMAL,16000
S1,ETUDIANT,11200
S1,12_17,10800
S1,U12,8000
</code></pre>

<h3>4.3 Abonnés (flat) – <code>data/subscribers_flat.csv</code></h3>
<p><strong>En-têtes :</strong> <code>groupKey,email,firstName,lastName,phone,seasonCode,venueSlug,seatId,zoneKey</code></p>
<p><em>1 ligne = 1 siège</em>. Exemple (nomenclature de siège type <code>N1-A-001</code> / <code>S1-H-012</code>) :</p>
<pre><code>groupKey,email,firstName,lastName,phone,seasonCode,venueSlug,seatId,zoneKey
alice-group,alice@example.com,Alice,Durand,0600000001,2025-2026,patinoire-blagnac,N1-A-001,N1
alice-group,alice@example.com,Alice,Durand,0600000001,2025-2026,patinoire-blagnac,N1-A-002,N1
bruno-group,bruno@example.com,Bruno,Martin,0600000002,2025-2026,patinoire-blagnac,S1-H-003,S1
</code></pre>

<h3>4.4 Liens renew (export) – <code>renew-groups-*.csv</code></h3>
<p><strong>En-têtes :</strong> <code>groupKey,email,link,seats</code> – <code>seats</code> = liste séparée par <code>;</code>.</p>
<pre><code>groupKey,email,link,seats
alice-group,alice@example.com,https://billetterie-dev.belougas.fr/bts/s/renew?id=...,N1-A-001;N1-A-002
bruno-group,bruno@example.com,https://billetterie-dev.belougas.fr/bts/s/renew?id=...,S1-H-003
</code></pre>

<h2>5. E-mails</h2>
<ul>
  <li>Test SMTP : <code>/api/admin/email/test?to=...</code> (header admin si nécessaire).</li>
  <li>Invitations : script CLI (dry-run conseillé).</li>
  <li>Attestation : envoi automatique au retour HelloAsso payé (<code>/ha/return</code>).</li>
</ul>

<h2>6. Supervision &amp; sécurité</h2>
<ul>
  <li>Logs PM2, grep erreurs HelloAsso/e-mail.</li>
  <li><code>syncIndexes</code> après migrations.</li>
  <li>Rotation des secrets, .env permissions.</li>
  <li>Mongo auth/bind 127.0.0.1.</li>
</ul>
`;

// Écrit les pages
writeHtml('01-cahier-des-charges.html', 'BTS – Cahier des charges (Phase 1)', body1);
writeHtml('02-gestion-de-projet.html', 'BTS – Gestion de projet (Phase 1)', body2);
writeHtml('03-architecture.html', 'BTS – Architecture (Phase 1)', body3);
writeHtml('04-installation.html', 'BTS – Guide d’installation (Phase 1)', body4);
writeHtml('05-exploitation.html', 'BTS – Guide d’exploitation (Phase 1)', body5);

// Index
const index = `
<div class="card">
  <h1>BelougasTicketingSystem – Documentation Phase 1</h1>
  <p>Accédez aux documents :</p>
  <ul>
    <li><a href="01-cahier-des-charges.html">01 – Cahier des charges</a></li>
    <li><a href="02-gestion-de-projet.html">02 – Gestion de projet</a></li>
    <li><a href="03-architecture.html">03 – Architecture</a></li>
    <li><a href="04-installation.html">04 – Installation</a></li>
    <li><a href="05-exploitation.html">05 – Exploitation</a></li>
  </ul>
  <p class="small">Généré automatiquement.</p>
</div>
`;
writeHtml('index.html', 'BTS – Documentation Phase 1', index);

// Logo : copie si présent, sinon placeholder
const srcLogo = path.resolve(process.cwd(), 'src/public/static/img/logo.png');
const outLogo = path.join(OUT_DIR, 'logo.png');
if (fs.existsSync(srcLogo)) {
  fs.copyFileSync(srcLogo, outLogo);
} else {
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
  fs.writeFileSync(outLogo, Buffer.from(b64, 'base64'));
}

console.log(`\nDocs générées dans: ${OUT_DIR}`);
