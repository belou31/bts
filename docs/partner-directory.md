# Annuaire partenaire (connexion sans OpenID)

Pour un partenaire **sans fournisseur d'identité**, BTS tient lui-même la liste
de ses ayants droit. La connexion donne la même session qu'avec OpenID
(identifiant, nom, e-mail, `attributes.beneficiaries`) : droits d'achat
(`entitlements`), panneau Contact et page des commandes fonctionnent à
l'identique. Voir [partner-oidc.md](partner-oidc.md) pour ces mécanismes.

## Activer

Console d'administration → Operate → 05 — Partner → **Set Partner Directory**,
ou :

```
node scripts/05-partner-management/set-partner-directory.js --partner=<slug> --enabled=yes [--dry-run]
```

Écrit `"directory": { "enabled": true }` dans l'entrée du partenaire
(`partners.json`), sans toucher au reste. Refusé si le partenaire a un bloc
`oidc` : un seul mode de connexion par partenaire. Activé, **la connexion est
obligatoire** sur les pages du partenaire ; le jeton statique n'ouvre plus
l'accès.

La console (Monitor → Partenaires) affiche le mode de chaque partenaire :
OpenID, Annuaire ou Jeton.

## Importer l'annuaire

Page `/partner/<slug>/admin/directory`, protégée par le bloc `admin`
(`user` / `pass`) du partenaire. Elle donne le nombre d'ayants droit et
d'adresses, la date du dernier import, l'export CSV de l'annuaire courant
(`directory.csv`), et le formulaire d'import.

```
identifier,lastName,firstName,email,beneficiaries
A123456,DUPONT,Camille,camille.dupont@example.com,4
A123456,DUPONT,Camille,c.dupont@perso.example,4
B987654,MARTIN,Léo,leo.martin@example.com,2
```

- une ligne par adresse e-mail ; un identifiant répété reçoit plusieurs
  adresses (nom, prénom et `beneficiaries` identiques sur ses lignes, sinon
  l'identifiant est écarté) ;
- séparateur `,` ou `;`, UTF-8, champs entre guillemets admis ;
- `beneficiaries` : entier ≥ 1, nombre de places au titre des droits (vide :
  attribut absent, les droits qui en dépendent sont refusés) ;
- l'import **remplace** l'annuaire entier, et il est **refusé en bloc** si une
  ligne est invalide (le rapport liste les lignes et leur motif) ou s'il ne
  contient aucune ligne valide ;
- les nouvelles fiches sont écrites avant le retrait des anciennes : l'annuaire
  n'est jamais vide pendant un import.

Stockage : collection MongoDB `partnermembers` (un document par identifiant).

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

La page des commandes du partenaire est désormais
`/partner/<slug>/admin/orders` (`?format=html`, `?format=csv`, JSON par
défaut). L'ancienne adresse `/partner/<slug>/admin` y redirige.

## Vérification

`npm run test:partner-directory` : CSV, import, connexion, limites, accès.
Utilise la base de `MONGO_URI` avec un partenaire jetable, effacé à la fin.
