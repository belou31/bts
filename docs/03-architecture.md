---
title: Architecture & arborescence
nav_order: 4
---

# Architecture

BTS est une app **Node.js + Express** avec **MongoDB**.  
Le plan des lieux est un **SVG** (servi en statique et parsé côté scripts).

## Vue d’ensemble

Client (HTML5/CSS) → Express → MongoDB
│ ├── Routes renew / admin / payments
│ ├── Static: /html, /static, /venues/<slug>/plan.svg
└── HelloAsso (sandbox/prod) via Checkout API (STUB en DEV)


## Arborescence (rôles clés)

```text
src/
  loaders/
    express.js      # construit l’app (helmet, CORS, static, routes)
    mongo.js        # connexion MONGO_URI
  models/
    Seat.js         # sièges instanciés par saison/lieu
    Subscriber.js   # registre \"renewers\" (campagne suivante : groupKey, prefSeatId)
    Season.js       # phases (renewal/tbh7/public)
    Tariff.js       # catalogue tarifs
    TariffPrice.js  # prix par zone/saison/lieu
    TariffPriceCatalog.js # catalogue de prix réutilisable (zone × tarif)
    Order.js        # commandes (paid/failed)
    PaymentIntent.js# intents checkout
  routes/
    index.js        # router principal
    renew.js        # GET/POST renouvellement
    admin.js        # endpoints d’admin légers
    payments/
      helloasso.js  # intégration HelloAsso + STUB en DEV
  public/
    html/
      renew.html    # page de renouvellement
      ha-return.html# retour paiement (STUB)
    static/
      styles/
        renew.css   # styles
    venues/
      <slug>/
        plan.svg    # plan
scripts/
  01-venue-management/   # register venue, import seats/zones, validate SVG
  02-tariff-management/  # import/export tariff catalogs & matrices
  03-season-management/  # instantiate venue/tariffs, seed data, renewal helpers
  04-event-management/   # création d’événements, imports QR/prix, set-onsale
  05-misc/   # exports/reports, audits
  00-initialization/     # reset-db, check-env, customize-app
