---
title: Configuration
nav_order: 40
---

# Configuration

## Main configuration families

- Core server: `HOST`, `PORT`, `BASE_PATH`, `APP_ENV`, `APP_URL`
- Database: `MONGO_URI`
- Admin auth: `ADMIN_TOKEN`, `ADMIN_USER`, `ADMIN_PASS`
- Payment provider switch: `PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_NAME`
- HelloAsso: API base URL, org slug, OAuth credentials, webhook/return URLs
- SumUp: API base URL, OAuth credentials, callback/return URLs
- Automation JWT: shared secret, issuer, audience, scopes
- Partner embedding/security: frame ancestors and partner-specific options
- Order limits: `ORDER_MAX_ITEMS`

## Plafond de places par commande — `ORDER_MAX_ITEMS`

Nombre maximum de places qu'une commande en libre-service peut porter. Défaut :
**19**. `0` désactive le plafond.

Jusqu'à son introduction, aucun flux public n'en avait : hors contraintes
indirectes (sièges disponibles, quota d'un partenaire, solde d'un bon), rien
n'empêchait un panier de cent places. Le plafond trace la frontière entre un
achat individuel et un **groupe**, ce dernier relevant d'un traitement dédié
qui reste à écrire.

Appliqué à l'achat de match (public et partenaire), à la souscription
d'abonnement, au renouvellement et au retrait d'un bon. Pour la vente de bons,
`maxPlaces` de `data/customization/voucher-purchase.json` reste pris en compte :
c'est le **plus bas des deux** qui s'applique.

Pas appliqué aux actions d'exploitation — import de commandes, console
d'administration, API d'automatisation : un plafond de libre-service n'a pas à
brider un opérateur qui sait ce qu'il fait.

Le refus est un `HTTP 400` portant
`{ error: "too_many_items", max, asked, message }`. Le plafond est aussi publié
dans les payloads de statut (`limits.maxItems`) pour que le panier refuse la
place de trop au clic, avant la saisie des porteurs et avant tout paiement.

**Avant de le déployer sur une base existante**, vérifier que personne ne le
dépasse déjà — un abonné détenant plus de places que le plafond serait refusé
au renouvellement :

```
node scripts/diagnostics/audit-large-orders.js [--max=19]
```

Le harnais `npm run test:order-limits` éprouve la frontière, le décompte des
places, l'échappatoire `0` et une valeur illisible.

## Next step

Phase 2 should turn this into a variable-by-variable reference with environment examples for DEV, INT, and PROD.
