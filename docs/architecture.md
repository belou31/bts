---
title: Architecture
nav_order: 10
---

# Architecture

Cette page décrit l'architecture **actuelle** de BTS telle qu'elle est implémentée dans `src/`, `scripts/` et les stubs de paiement.

## Vue d'ensemble

BTS est une application Node.js/Express adossée à MongoDB, avec trois grandes familles de surfaces :

- pages publiques et API métier pour les flux de vente
- surfaces opérateur pour l'administration et l'automatisation
- scripts CLI pour le provisioning, les imports, les exports et la maintenance

Le serveur Express sert :

- les assets statiques sous `/static`
- les assets dynamiques sous `/dynamic`
- les pages HTML/EJS métier
- les API JSON des flux `renew`, `subscription`, `event`, `partner`, `automation`, `scan`

Le tout peut être exposé à la racine en DEV ou derrière `BASE_PATH=/bts` en INT/PROD.

## Stack technique

- Runtime : Node.js 20+
- Web : Express
- Base de données : MongoDB via Mongoose
- Templates serveur : EJS
- Front statique : HTML/CSS/JS servis depuis `public/static`
- Documents : génération PDF des billets via `pdfkit` + templates SVG
- Paiement : couche d'abstraction fournisseur (`helloasso`, `sumup`)
- Backoffice : console `/admin` + scripts CLI + API d'automatisation JWT

## Topologie HTTP

| Surface | Rôle |
| --- | --- |
| `/renew` | page publique de renouvellement |
| `/subscription` | redirection vers la saison active |
| `/season/:seasonCode` | page d'abonnement d'une saison |
| `/event/:ev` | page publique d'un événement |
| `/s/renew` | API JSON du flux renouvellement |
| `/api/season/*` | API JSON des abonnements de saison |
| `/api/event/*` | API JSON des événements |
| `/api/partner/*` | API JSON partenaire |
| `/partner/*` | surfaces d'administration partenaire |
| `/pay/*` | retours / webhooks de paiement |
| `/api/automation/*` | API de jobs d'automatisation |
| `/admin` | console d'administration |
| `/admin/supervision` | supervision complémentaire |
| `/healthz` | point de santé HTTP |

## Découpage du code

### `src/loaders/`

- `express.js` construit l'application Express, monte les assets statiques/dynamiques et applique `BASE_PATH`.
- `mongoose.js` établit la connexion MongoDB à partir de `MONGO_URI`.
- `mailer.js` initialise l'envoi d'emails.

### `src/routes/`

- `index.js` compose toutes les pages et sous-routeurs.
- `renew.js` gère le flux tokenisé de renouvellement.
- `subscription.js` gère les abonnements de saison.
- `event.js` délègue au routeur factorisé d'événement.
- `event-flow.factory.js` porte la logique commune `event` et `partner`.
- `partner.js` applique les règles d'accès partenaire et les réservations de type facture.
- `pay.js` finalise les commandes après retour PSP ou webhook.
- `automation/index.js` expose l'API de jobs.
- `admin/` regroupe la console d'exploitation et la supervision.
- `control/scan.js` et `control/guestlist.js` exposent les surfaces de contrôle d'accès.

### `src/services/`

- `payments/` isole les différences entre HelloAsso et SumUp.
- `automation/` gère registre, jobs, logs et exécution des tâches.
- `order-finalization.js` convertit un paiement confirmé en réservation finale, emails et billets.
- `tickets-pdf.js` assemble les billets PDF.
- `customization.js` injecte les variantes de contenu UI/email.
- `imports/`, `exports.js`, `payment-links.js`, `mailer*.js` couvrent les opérations métier transverses.

### `src/models/`

Le modèle de données est organisé en quatre ensembles :

- catalogue : `Venue`, `SeatCatalog`, `ZoneCatalog`, `TariffPriceCatalog`
- runtime saison/vente : `Season`, `Zone`, `Seat`, `ZoneHold`, `Order`
- événements et contrôle : `Event`, `Ticket`, `QrBankCode`, `ScanLog`, `SeatHold`
- opérateur / audience : `Subscriber`, `Campaign`, `AutomationJob`, `Counter`

### `scripts/`

Les scripts CLI sont le pendant opérateur du runtime applicatif :

- `00-system-management`
- `01-venue-management`
- `02-tariff-management`
- `03-season-management`
- `04-event-management`
- `05-partner-management`
- `06-misc`
- `diagnostics`, `migrations`, `sentinels`

Le catalogue partagé est centralisé dans `src/config/adminScripts.js` et réutilisé par la console `/admin`.

## Concepts structurants

### 1. Séparation catalogue / runtime

Le système distingue les données pérennes de configuration et les données instanciées pour une saison ou un événement.

- `SeatCatalog` / `ZoneCatalog` décrivent un lieu
- `Seat` / `Zone` représentent l'état opérationnel pour une saison et un lieu
- `TariffPriceCatalog` sert de catalogue réutilisable
- `TariffPrice` porte les prix réellement appliqués à une saison ou un événement

### 2. Saison puis événement

Le coeur BTS repose sur un axe :

- une `Season` associée à un `venueSlug`
- des `Event` rattachés à la saison
- des `Order` dont le `phase` distingue `renew`, `subscription`, `event`

Cette structure permet :

- le renouvellement de sièges existants
- la vente d'abonnements saison
- la vente événementielle ponctuelle
- la génération de billets événementiels à partir d'abonnements

### 3. Paiement abstrait

Les flux `renew`, `subscription` et `event` ne parlent pas directement à un PSP.

Ils appellent la façade `src/services/payments/index.js`, qui :

- sélectionne le provider via `PAYMENT_PROVIDER`
- construit les URLs de retour
- crée les intents de paiement
- normalise les statuts

Cette abstraction permet de brancher :

- HelloAsso en réel ou via stub local
- SumUp en réel ou via stub local

### 4. Finalisation asynchrone

Le checkout crée d'abord une `Order` en `pending`.

Ensuite, la confirmation passe par :

- retour navigateur sur `/pay/return`
- et/ou webhook fournisseur sur `/pay/webhook`

La finalisation :

- passe la commande en `paid` si aucun conflit n'empêche la réservation
- marque les sièges
- génère les tickets événementiels si nécessaire
- envoie les emails et PDF

### 5. Automatisation externalisée

Les intégrations bureautiques et certains scripts ne pilotent pas directement MongoDB.
Elles appellent `/api/automation`, protégée par JWT et scopes.

Les tâches actuellement enregistrées couvrent :

- envoi d'invitations de renouvellement
- import des catalogues tarifaires
- import des prix
- import de commandes événementielles

## Assets et fichiers runtime

### `public/static`

Contient les assets front versionnés :

- JS
- CSS
- templates front

### `public/dynamic`

Contient les assets modifiables par exploitation :

- logos et icônes
- plans SVG
- vues spécifiques de salle
- personnalisations dérivées des scripts d'admin

## Déploiement logique

### DEV

- `BASE_PATH` vide
- serveur souvent lancé via `npm run dev`
- MongoDB locale
- PSP souvent simulé par stub

### INT / PROD

- `BASE_PATH=/bts`
- reverse proxy Nginx
- process Node sous PM2
- MongoDB authentifiée
- URLs de retour paiement alignées sur le sous-chemin `/bts`

## Zones à forte volatilité

Les surfaces suivantes évoluent rapidement et doivent être considérées comme documentation "vivante" :

- `src/config/adminScripts.js`
- `src/routes/index.js`
- `src/routes/event-flow.factory.js`
- `src/services/payments/`
- `src/services/automation/tasks/`

Les pages de référence associées devront être générées ou synchronisées automatiquement en phase 3.

## Pages liées

- [Flux applicatifs](runtime-flows.md)
- [Installation](installation.md)
- [Runbook d’exploitation](operations-runbook.md)
- [Catalogue des scripts](scripts-catalog.md)
