# Annuaire partenaire (connexion sans OpenID)

Pour un partenaire **sans fournisseur d'identité**, BTS tient lui-même la liste
de ses ayants droit. La connexion donne la même session qu'avec OpenID
(identifiant, nom, e-mail, `attributes.beneficiaries`) : droits d'achat
(`entitlements`), panneau Contact et page des commandes fonctionnent à
l'identique. Voir [partner-oidc.md](partner-oidc.md) pour ces mécanismes.

## Activer

Console d'administration → Operate → 05 — Partner → **Set Partner Connection**,
mode `directory`, ou :

```
node scripts/05-partner-management/set-partner-connection.js --partner=<slug> --mode=directory [--dry-run]
```

Écrit `"connection": "directory"` dans l'entrée du partenaire
(`partners.json`) et retire les anciens interrupteurs (`directory.enabled`,
`oidc.required`) ; le reste de l'entrée, bloc `oidc` compris, est conservé.
Activé, **la connexion est obligatoire** sur les pages du partenaire ; le
jeton statique n'ouvre plus l'accès. `--mode=none` la désactive, `--mode=openid`
bascule sur le fournisseur d'identité du partenaire (bloc `oidc` requis).

La console (Monitor → Partenaires) affiche le mode de chaque partenaire :
OpenID, Annuaire, Jeton ou Aucune.

## Importer l'annuaire

Page `/partner/<slug>/admin/directory`, protégée par le bloc `admin`
(`user` / `pass`) du partenaire. Elle donne le nombre d'ayants droit et
d'adresses, la date du dernier import, l'export CSV de l'annuaire courant
(`directory.csv`), et le formulaire d'import.

```
identifier,lastName,firstName,email,beneficiaries,extraPublic
A123456,DUPONT,Camille,camille.dupont@example.com,4,2
A123456,DUPONT,Camille,c.dupont@perso.example,4,2
B987654,MARTIN,Léo,leo.martin@example.com,2,
```

- une ligne par adresse e-mail ; un identifiant répété reçoit plusieurs
  adresses (nom, prénom et `beneficiaries` identiques sur ses lignes, sinon
  l'identifiant est écarté) ;
- séparateur `,` ou `;`, UTF-8, champs entre guillemets admis ;
- `beneficiaries` : entier ≥ 1, nombre de places au titre des droits (vide :
  attribut absent, les droits qui en dépendent sont refusés) ;
- `extraPublic` (colonne facultative) : entier ≥ 0, places en plus au tarif
  public **propres à cet ayant droit**, attribut de session `extraPublic`. Vide
  ou colonne absente : la valeur par défaut du panier de droits (voir
  ci-dessous). Comme pour `beneficiaries`, la valeur doit être la même sur
  toutes les lignes d'un identifiant ;
- l'import **remplace** l'annuaire entier, et il est **refusé en bloc** si une
  ligne est invalide (le rapport liste les lignes et leur motif) ou s'il ne
  contient aucune ligne valide ;
- les nouvelles fiches sont écrites avant le retrait des anciennes : l'annuaire
  n'est jamais vide pendant un import.

Stockage : collection MongoDB `partnermembers` (un document par identifiant).

## Places en plus par ayant droit

Le panier « places en plus » lit l'attribut au lieu d'un nombre fixe, avec un
défaut pour qui n'a pas de valeur :

```json
{ "key": "public-extra", "label": "Places en plus (tarif public)", "per": "event",
  "tariffChannel": "public", "limitDuring": ["presale"],
  "max": { "attribute": "extraPublic", "default": 2 } }
```

Un ayant droit à `extraPublic = 5` a 5 places en plus, un autre sans valeur en
a 2, un troisième à `0` n'en a aucune. Sans `default`, une valeur absente
refuse ce panier.

## Connexion de l'ayant droit

1. Sur `/partner/<slug>/auth/login` (où mènent les pages du partenaire sans
   session), il saisit son **identifiant** et **l'une des adresses** de
   l'annuaire (casse indifférente pour les deux).
2. Si les deux correspondent, un **code à 6 chiffres** est envoyé à cette
   adresse. L'écran est le même que l'envoi ait eu lieu ou non : impossible de
   savoir par ce biais qui figure dans l'annuaire.
3. Il saisit le code ; la session s'ouvre avec l'adresse saisie, qui
   pré-remplit le panneau Contact.

| Règle | Valeur |
| --- | --- |
| validité du code | 10 minutes, usage unique |
| essais par code | 5 |
| codes par identifiant | 3 par 15 minutes |
| stockage | HMAC (clé `JWT_SECRET`), jamais en clair ; effacé à expiration (index TTL) |

Courriels : en DEV, `EMAIL_STUB=true` les écrit dans `data/outputs/outbox/`.

## Commandes

La page des commandes du partenaire est `/partner/<slug>/admin/orders` : page
HTML par défaut (titre au nom du partenaire, plus récentes en tête), filtre par
événement et par statut (payées / toutes), filtre texte instantané sur les noms,
l'e-mail et l'identifiant. `?format=csv` exporte la sélection, `?format=json`
la renvoie en JSON. L'ancienne adresse `/partner/<slug>/admin` y redirige.

## Vérification

`npm run test:partner-directory` : CSV, import, connexion, limites, accès.
Utilise la base de `MONGO_URI` avec un partenaire jetable, effacé à la fin.
