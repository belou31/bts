# Contrôles de panier

Règles de cohérence vérifiées avant le paiement, pour **tous les canaux**
(public comme partenaires). Exemple : un tarif Enfant exige au moins un adulte.

Fichier : `data/customization/cart-rules.json` (modèle :
`data_references/customization/cart-rules.json`). Relu à chaque appel :
une modification s'applique sans redémarrage.

```json
[
  {
    "key": "enfant-accompagne",
    "message": "Un tarif Enfant doit être accompagné d'au moins un adulte.",
    "when": { "tariffs": ["ENFANT"] },
    "require": { "tariffs": ["NORMAL", "ETUDIANT", "AUTRES_REDUITS"], "min": 1 }
  }
]
```

| Champ | Rôle |
| --- | --- |
| `key` | identifiant stable (réponse d'API : `error: "cart_rule"`, `key`) |
| `message` | texte montré à l'acheteur |
| `channels` | `public`, `partner` (tout partenaire), `partner:<slug>`, `all` ; absent = partout |
| `when.tariffs` | la règle ne joue que si le panier contient au moins une ligne de ces tarifs |
| `require.tariffs` | tarifs qui doivent alors être présents |
| `require.min` | nombre minimum de ces lignes (défaut 1) |
| `require.per` | `min` lignes par tranche de `per` lignes « when » (ex. `per: 4` : un adulte pour quatre enfants) |

Les codes sont ceux des grilles tarifaires : une règle vaut pour toutes les
grilles qui emploient ces codes. Un fichier mal formé est signalé au journal
(`[cart-rules]`) et ignoré : ce sont des règles de cohérence, une faute de
frappe ne doit pas bloquer toute vente.

## Où c'est vérifié

| Flux | Panier (avant paiement) | Serveur (paiement) |
| --- | --- | --- |
| Événement public, événement partenaire | oui | oui |
| Abonnement, renouvellement, bon cadeau, changement de place | dès que leur API de statut fournit `cartRules` | **à brancher** |

Le contrôle côté panier est dans `public/static/js/generic-view.js`, commun à
toutes les pages de commande : il s'applique à tout flux dont l'API de statut
renvoie `cartRules`. Le contrôle serveur est une fonction partagée
(`cartRuleViolation`, `src/services/cart-rules.js`) à appeler dans le
paiement de chaque flux ; aujourd'hui seul `event-flow.factory.js` l'appelle.

Vérification : `npm run test:cart-rules`.
