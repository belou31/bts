---
title: Runtime Flows
nav_order: 20
---

# Flux applicatifs

Cette page décrit les flux métier réellement exposés par BTS au runtime.

## Vue synthétique

| Flux | Page d'entrée | API principale | Paiement | Finalisation |
| --- | --- | --- | --- | --- |
| Renouvellement | `/renew?id=...` | `/s/renew` | PSP via intent | `/pay/*` |
| Abonnement saison | `/subscription` ou `/season/:seasonCode` | `/api/season/*` | PSP via intent | `/pay/*` |
| Vente événementielle | `/event/:ev` | `/api/event/*` | PSP via intent | `/pay/*` |
| Vente partenaire | `/partner/:partnerSlug/event/:eventId` | routeur partenaire | PSP ou réservation facture | `/pay/*` ou finalisation directe |
| Automatisation | pas de page publique | `/api/automation/*` | sans objet | job API |
| Contrôle d'accès | interface scan/guestlist | routes `control/*` | sans objet | lecture tickets / scans |

## 1. Renouvellement

### Entrée

Le flux commence par un lien signé portant un JWT en query string :

```text
/renew?id=<token>
```

Le token embarque :

- `seasonCode`
- `venueSlug`
- la liste des `seatIds` renouvelables

### Lecture de l'état

Le front appelle `GET /s/renew?id=...` pour récupérer :

- les sièges du token
- les tarifs actifs
- les prix par zone
- les abonnés associés aux sièges
- l'état bloqué ou non des sièges

### Création de commande

Le front poste sur `POST /s/renew?id=...` avec :

- le panier
- le payeur
- l'échelonnement `1|2|3`

Le backend :

- vérifie que chaque siège demandé appartient au token
- résout les prix depuis `TariffPrice`
- crée une `Order` `pending` en phase `renew`
- crée un intent PSP via `createCheckoutIntent`

### Finalisation

Après paiement confirmé :

- `/pay/return` ou `/pay/webhook` relit l'intent fournisseur
- `order-finalization.js` applique la réservation finale
- les emails de confirmation sont envoyés

## 2. Abonnement de saison

### Entrée

Deux points d'entrée existent :

- `/subscription` : redirection vers la saison active
- `/season/:seasonCode` : page explicite d'abonnement

La page charge une vue de type `order` avec sélection :

- par siège réel
- ou par zone debout/fanclub selon la configuration

### Lecture de l'état

Le front appelle `GET /api/season/:seasonCode/status`.

La réponse inclut :

- `seats`
- `zones`
- `tariffs`
- `prices`
- les personnalisations de contenu

Le backend calcule aussi :

- le quota restant par zone
- les zones réellement proposées pour ce canal

### Création de commande

Le front appelle `POST /api/season/:seasonCode/checkout`.

Le backend :

- accepte des lignes siège réel ou zone virtuelle
- vérifie la disponibilité des sièges
- contrôle les quotas de zone
- prépare les lignes tarifaires
- applique la règle anti-trou pour les sièges quand nécessaire
- crée l'`Order` `pending`
- crée l'intent de paiement

### Spécificités

- les commandes portent `phase: subscription`
- le quota des zones est calculé à partir des commandes `paid`
- le front peut proposer un échelonnement en 1, 2 ou 3 paiements

## 3. Vente événementielle publique

### Entrée

La page publique est :

```text
/event/:ev
```

`ev` peut être un slug, et certains chemins acceptent aussi un ObjectId selon la résolution interne.

### Lecture de l'état

Le front appelle `GET /api/event/:eventId/status`.

Le backend agrège :

- l'événement (`slug`, `name`, `startsAt`, `isOnSale`)
- l'état des sièges
- les zones debout et leur capacité restante
- les tarifs/prix applicables
- les zones et tarifs autorisés

La logique tarifaire utilise :

- d'abord une table événementielle via `priceTableKey`
- sinon un fallback saison/lieu

### Création de commande

Le front appelle `POST /api/event/:eventId/checkout`.

Le backend :

- refuse le checkout si la vente n'est pas ouverte
- valide sièges et zones
- applique les prix selon le canal
- crée une `Order` `pending` en phase `event`
- pose un hold temporaire sur les vrais sièges
- crée l'intent de paiement

### Finalisation

Lorsqu'une commande événementielle passe à `paid` :

- les sièges sont confirmés
- les tickets sont garantis en base (`Ticket`)
- les PDF peuvent être générés
- les futures routes de scan lisent ces tickets

## 4. Vente partenaire

### Entrée

Le flux partenaire réutilise le routeur d'événement via :

```text
/partner/:partnerSlug/event/:eventId
```

Avant d'entrer dans le flux, BTS :

- charge la config partenaire
- vérifie éventuellement un token d'accès

### Capacités spécifiques

Le canal partenaire peut :

- filtrer ses tarifs dédiés
- autoriser un fallback vers les tarifs publics
- utiliser une vue de salle dédiée
- disposer d'un quota de prévente avant ouverture publique
- basculer vers une réservation sur facture au lieu d'un PSP

### Réservation facture

Certaines configs partenaires exposent `POST /reserve` au lieu de passer par un paiement immédiat.

Dans ce cas BTS :

- crée une commande au statut métier partenaire
- pose les holds nécessaires
- peut auto-finaliser la commande
- peut envoyer les billets sans passage PSP

## 5. Paiement et post-paiement

Tous les flux de vente convergent vers le même mécanisme :

### Création d'intent

- `buildReturnUrls(order)` construit les URLs de retour
- `createCheckoutIntent(...)` délègue au fournisseur

### Retour / webhook

Les endpoints `pay` lisent :

- l'identifiant d'intent
- le statut fournisseur
- les identifiants de paiement et commande du PSP

### Effets de finalisation

Selon le flux et le statut :

- réservation définitive des sièges
- création ou mise à jour des tickets
- envoi de mails
- génération PDF
- détection de conflits

## 6. Automatisation

### Entrée

Les clients d'automatisation appellent :

```text
/api/automation/*
```

avec un JWT signé par `AUTOMATION_JWT_SECRET`.

### Modèle

- `GET /scripts` liste les tâches
- `POST /scripts/:id/jobs` crée un job
- `GET /jobs` et `GET /jobs/:jobId` lisent l'historique

### Tâches actuellement enregistrées

- `season.send-renew-invites`
- `event.import-orders`
- `tariff.import-catalog`
- `tariff.import-prices`

## 7. Contrôle d'accès et supervision

En sortie de vente, BTS alimente :

- `Ticket` pour la possession de billet
- `ScanLog` pour la traçabilité des scans

Les surfaces de contrôle et de supervision permettent ensuite :

- la lecture des billets
- le suivi des scans
- les exports de rapprochement
- l'audit opérateur depuis `/admin`

## Pages liées

- [Architecture](architecture.md)
- [Paiements](payments.md)
- [API d’automatisation](automation-api.md)
- [Runbook d’exploitation](operations-runbook.md)
