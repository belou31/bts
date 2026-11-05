---
title: Installation
nav_order: 30
---

# Installation

Cette page remplace l'ancien brouillon d'installation et décrit la manière recommandée de démarrer BTS aujourd'hui.

## Pré-requis

- Node.js 20+
- MongoDB 6+
- `npm`
- un fichier `.env`

Pour INT/PROD, ajouter :

- Nginx
- PM2
- TLS

## Principes d'environnement

### DEV local

- `BASE_PATH` doit rester vide
- `APP_URL` ne doit pas contenir `/bts`
- MongoDB peut être locale
- le paiement peut être branché sur un stub

### INT / PROD

- `BASE_PATH=/bts`
- `APP_URL` doit inclure `/bts`
- les URLs de retour paiement doivent aussi inclure `/bts`
- BTS est généralement placé derrière Nginx et géré par PM2

Le script `node scripts/00-system-management/check-env.js` vérifie précisément ces points.

## 1. Cloner et installer

```bash
git clone <repo>
cd bts
npm ci
```

## 2. Créer le `.env`

Point de départ recommandé :

```bash
cp data_references/env/.env.template .env
```

### Exemple minimal DEV avec HelloAsso stub

```dotenv
APP_ENV=development
APP_URL=http://localhost:8080
BASE_PATH=

HOST=127.0.0.1
PORT=8080

MONGO_URI=mongodb://127.0.0.1:27017/bts

JWT_SECRET=replace-with-strong-secret

ADMIN_TOKEN=dev-admin-token

PAYMENT_PROVIDER=helloasso
HELLOASSO_API_URL=http://127.0.0.1:3005
HELLOASSO_ORG_SLUG=dev-stub
HELLOASSO_CLIENT_ID=stub-client
HELLOASSO_CLIENT_SECRET=stub-secret
HELLOASSO_RETURN_URL=http://localhost:8080/pay/return
HELLOASSO_WEBHOOK_URL=http://localhost:8080/pay/webhook

BASE_EMAIL=notifications@example.org
SMTP_HOST=localhost
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
```

### Exemple minimal DEV avec SumUp stub

```dotenv
APP_ENV=development
APP_URL=http://localhost:8080
BASE_PATH=

HOST=127.0.0.1
PORT=8080

MONGO_URI=mongodb://127.0.0.1:27017/bts
JWT_SECRET=replace-with-strong-secret

PAYMENT_PROVIDER=sumup
SUMUP_API_BASE=http://127.0.0.1:3015/v0.1
SUMUP_TOKEN_URL=http://127.0.0.1:3015/token
SUMUP_CLIENT_ID=stub-client
SUMUP_CLIENT_SECRET=stub-secret
SUMUP_MERCHANT_CODE=demo-merchant
SUMUP_PAY_TO_EMAIL=demo@example.org
SUMUP_CURRENCY=EUR
SUMUP_RETURN_URL=http://localhost:8080/pay/return
SUMUP_CALLBACK_URL=http://localhost:8080/pay/webhook
```

## 3. Lancer MongoDB

BTS exige `MONGO_URI`. La méthode de lancement dépend de votre poste ou serveur, mais le point attendu est une base MongoDB accessible par l'application.

## 4. Vérifier la configuration

```bash
node scripts/00-system-management/check-env.js
```

Points contrôlés :

- `APP_ENV`
- validité de `APP_URL`
- cohérence de `BASE_PATH`
- cohérence des URLs HelloAsso
- validité de `HELLOASSO_API_URL` si définie

## 5. Démarrer BTS

### En développement

```bash
npm run dev
```

### En exécution simple

```bash
npm start
```

Le serveur écoute par défaut sur `http://127.0.0.1:8080`.

## 6. Démarrer un stub de paiement

### HelloAsso

```bash
npm run helloasso:stub
```

Par défaut :

- URL : `http://127.0.0.1:3005`
- tableau de bord : `http://127.0.0.1:3005/`

### SumUp

```bash
npm run sumup:stub
```

Par défaut :

- URL : `http://127.0.0.1:3015`
- tableau de bord : `http://127.0.0.1:3015/`

## 7. Vérifications de base

### Santé HTTP

```bash
curl -s http://127.0.0.1:8080/healthz
```

Réponse attendue :

```json
{"ok":true}
```

### Pages principales

Selon les données déjà présentes en base :

- `/renew?id=<token>`
- `/subscription`
- `/season/<code>`
- `/event/<slug>`
- `/admin`

Sans données métier, certaines pages peuvent répondre `404` ou `503`, ce qui est normal tant que la base n'est pas initialisée.

## 8. Initialisation fonctionnelle minimale

Une installation applicative n'est pas suffisante : BTS a besoin d'un minimum de données de catalogue et de saison.

Séquence minimale :

1. enregistrer un lieu
2. importer sièges et zones
3. créer une saison
4. instancier lieu et tarifs pour cette saison
5. ouvrir un flux métier (`renew`, `subscription`, `event`)

Le détail opérateur est documenté dans [operations-runbook.md](operations-runbook.md).

## 9. Déploiement INT / PROD

Pour un déploiement serveur :

- utiliser `BASE_PATH=/bts`
- faire pointer `APP_URL` vers l'URL publique complète
- exécuter `npm ci`
- lancer BTS sous PM2
- servir BTS derrière Nginx

Exemple de démarrage PM2 :

```bash
pm2 start src/server.js --name bts --update-env
pm2 save
```

Le playbook historique VPS reste disponible ici :

- [PLAYBOOK.md](PLAYBOOK.md)

### Mettre à jour un déploiement existant (INT / PROD)

Une fois BTS déjà installé, chaque mise à jour de code doit repasser par ces étapes — dans cet ordre. Sauter `npm install` est la cause la plus fréquente de 502 après déploiement : le process démarre avec l'ancien code en mémoire, puis crashe au premier redémarrage dès qu'une dépendance ajoutée entre-temps (ex. `marked`, `archiver`, `@google/clasp`) manque dans `node_modules/` — voir [troubleshooting.md](troubleshooting.md).

```bash
cd ~/bts
git pull
npm install
node scripts/00-system-management/pm2-control.js --name=bts --action=restart
```

Puis vérifier que le process est bien reparti avant de considérer le déploiement terminé :

```bash
pm2 status
pm2 logs bts --lines 30 --nostream
```

## 10. Variables à connaître immédiatement

### Obligatoires en pratique

- `MONGO_URI`
- `JWT_SECRET`
- `APP_URL`
- `APP_ENV`

### Très recommandées

- `BASE_PATH`
- `ADMIN_TOKEN` ou `ADMIN_USER` / `ADMIN_PASS`
- `PAYMENT_PROVIDER`
- les variables du provider choisi

### Pour l'automatisation

- `AUTOMATION_JWT_SECRET`
- `AUTOMATION_JWT_ISSUER`
- `AUTOMATION_JWT_AUDIENCE`
- `AUTOMATION_ALLOWED_IPS`

## 11. Dépannage initial

### Erreur `MONGO_URI manquant`

- vérifier le `.env`
- vérifier le répertoire de lancement

### `/healthz` OK mais pages métier vides

- la base n'est probablement pas initialisée
- suivre le runbook opérateur

### Retour paiement invalide

- vérifier `APP_URL`
- vérifier `BASE_PATH`
- vérifier `HELLOASSO_RETURN_URL` ou `SUMUP_RETURN_URL`

### `/admin` inaccessible

- vérifier `ADMIN_TOKEN` ou `ADMIN_USER` / `ADMIN_PASS`

## Pages liées

- [Configuration](configuration.md)
- [Stubs de paiement](stubs.md)
- [Runbook d’exploitation](operations-runbook.md)
