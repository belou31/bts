# Authentification partenaire par OpenID Connect

Cette authentification **s'ajoute** aux deux intégrations existantes — jeton
statique dans l'URL, et iframe sur le site du partenaire — sans les remplacer.
Un partenaire dont la configuration ne porte pas de bloc `oidc` fonctionne
exactement comme avant.

Elle se configure par partenaire, dans `data/customization/partners.json`.

## Ce que BTS vérifie, et pourquoi

| Contrôle | Ce qu'il empêche |
| --- | --- |
| `state` | qu'une connexion initiée par un tiers aboutisse dans le navigateur du bénéficiaire |
| `nonce` | qu'un `id_token` capté ailleurs soit rejoué |
| PKCE S256 | qu'un code d'autorisation intercepté soit échangeable |
| signature, `iss`, `aud`, `exp` | qu'un jeton forgé ou périmé soit accepté |
| `requiredClaim` | qu'un compte hors périmètre (mauvais groupe, mauvaise société) entre |
| `next` restreint au partenaire | qu'une redirection ouverte fasse atterrir ailleurs sous notre domaine |

Si la signature **ne peut pas** être vérifiée — ni JWKS ni clé publique
configurée — la connexion est refusée. Un `id_token` non vérifié n'est qu'une
affirmation du réseau.

## Paramètres

```jsonc
{
  "slug": "mon-partenaire",
  "oidc": {
    "issuer":   "https://idp.partenaire.fr",   // obligatoire
    "clientId": "bts-belougas",                // obligatoire
    "clientSecret": "…",                       // selon le partenaire

    "scopes": ["openid", "profile", "email"],  // "openid" toujours ajouté
    "subjectClaim": "sub",                     // claim qui identifie le bénéficiaire
    "emailClaim": "email",
    "nameClaim": "name",
    "requiredClaim": { "claim": "groups", "value": "abonnes" },
    "required": false                          // cf. « Limite connue »
  }
}
```

Avec ces seuls paramètres, BTS suit le chemin normalisé : découverte sur
`<issuer>/.well-known/openid-configuration`, PKCE S256, `/token` en
`application/x-www-form-urlencoded`, signature vérifiée via le JWKS annoncé.

### Réglages pour un IdP qui s'écarte de la norme

À n'employer que sur constat, chacun affaiblissant ou contournant le chemin
normalisé :

| Réglage | Défaut | Usage |
| --- | --- | --- |
| `endpoints.authorization`, `endpoints.token` | découverte | IdP sans document de découverte. **Dès que les deux sont fournis, la découverte n'est plus tentée.** |
| `endpoints.userinfo` | découverte | adresse du endpoint de profil |
| `endpoints.jwks` | découverte | JWKS non annoncé mais existant |
| `idTokenPublicKey` | — | clé publique PEM transmise hors bande, faute de JWKS |
| `pkce` | `true` | `false` si l'IdP rejette les paramètres inconnus |
| `tokenRequest` | `"form"` | `"json"` si `/token` attend un corps JSON |
| `clientAuth` | `basic` si secret, sinon `none` | `basic`, `body` ou `none` |
| `fetchUserInfo` | `false` | `true` si l'`id_token` ne porte aucun claim de profil |
| `authorizeParams` | — | paramètres supplémentaires sur `/authorize` (ex. `prompt`) |

## Profil AISC / SFI (Castelis)

Premier partenaire raccordé. La spécification SFI v2.2 (2016) diffère du
service réellement servi ; ce qui suit est ce que sert la **préproduction**
(réponse de Castelis du 16/10/2026 et swagger
`https://ws-preprod.airbus-staffcouncil.com/api/swagger`) :

- les endpoints sont sur le domaine **WS** (`ws-preprod.…`), pas sur le site
  des salariés (`preprod.…`, qui répond 404 après connexion) ;
- pas de document de découverte, pas de JWKS ;
- PKCE non utilisé ;
- `/token` : POST avec `client_id`, `client_secret`, `code`, `redirect_uri`
  (identique à celle de l'autorisation). Les erreurs OAuth répondent
  **HTTP 200** avec `{error, error_description}` ; seul un client inconnu ou
  sans secret répond 400 (`unknow_client`) ;
- l'`id_token` ne porte que `iss`, `iat`, `exp`, `sub`, `aud` (+ `nonce`) ;
  `iss` vaut `https://ws-preprod.airbus-staffcouncil.com` ;
- `infoUser` (GET, `Authorization: Bearer …`) répond **`application/jwt`** :
  un JWT signé par la même clé, erreurs comprises (charge `{error}` ou `[]`,
  toujours en 200). BTS le vérifie comme l'id_token ;
- scope **`partenaires`** : `given_name`, `family_name`, `email`, matricule,
  famille. Pas de `name` : BTS compose prénom + nom. Le scope `billetterie`
  range ses données dans un objet `billetterie` (`code_societe`, `societe` —
  un code, pas un libellé —, `subvention`…), d'où le chemin pointé admis par
  `requiredClaim`.

Le `sub` est le matricule AISC.

```jsonc
{
  "slug": "aisc",
  "name": "Airbus Staff Council (AISC)",
  "oidc": {
    "issuer": "https://ws-preprod.airbus-staffcouncil.com",
    "clientId": "belouga",
    "clientSecret": "…",
    "endpoints": {
      "authorization": "https://ws-preprod.airbus-staffcouncil.com/sfi/oauth/v1/authorize",
      "token":         "https://ws-preprod.airbus-staffcouncil.com/sfi/oauth/v1/token",
      "userinfo":      "https://ws-preprod.airbus-staffcouncil.com/sfi/oauth/v1/infoUser"
    },
    "scopes": ["openid", "partenaires"],
    "pkce": false,
    "tokenRequest": "json",
    "clientAuth": "body",
    "fetchUserInfo": true,
    "idTokenPublicKey": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq…\n-----END PUBLIC KEY-----",
    "identity": {
      "identifier": "sub", "firstName": "given_name", "lastName": "family_name", "email": "email",
      "attributes": { "beneficiaries": { "sum": [1, "conjoint", "autres_ad"] } }
    }
  }
}
```

### Points à confirmer auprès de Castelis

Quatre questions que la spécification ne tranche pas, et dont deux bloquent la
mise en service :

1. **Comment la clé publique de vérification est-elle transmise ?** La spec
   impose RS256 mais ne publie pas de JWKS. Sans clé, BTS refuse la connexion.
   Une URL de JWKS (`endpoints.jwks`) serait préférable à une clé en dur, qui
   casse à chaque rotation.
2. **Le `nonce` est-il bien recopié dans l'`id_token` ?** La liste de claims de
   §4.2.2.2.2 ne le mentionne pas. OIDC Core l'exige dès lors que le client
   l'envoie, et BTS refuse un jeton sans. Le cas est éprouvé (case « id_token
   sans nonce » de l'écran de test).
3. `/authorize` est listé en POST dans le tableau de §5.1 mais illustré en GET
   en §5.3.1.1. BTS redirige en GET, le seul choix cohérent avec une
   redirection de navigateur.
4. La spec note « RS256 (HMAC using SHA-256) » : RS256 est une signature RSA,
   pas un HMAC. À lever pour éviter un malentendu sur le mode de vérification.

Les dates renvoyées par `infoUser` sont au format `JJ/MM/AAAA` et non ISO 8601 :
à convertir si l'un de ces champs est un jour exploité (aucun ne l'est
aujourd'hui).

## Éprouver sur DEV

Un fournisseur d'identité **factice** tourne à part, comme les stubs de
paiement (`stub_oidc/`, détails dans `stub_oidc/README.md`). Il délivre une
identité à quiconque la demande et refuse de démarrer avec `APP_ENV=production`.

```
npm run oidc:stub        # http://127.0.0.1:3016, tableau de bord sur /
```

- profil normalisé : émetteur `http://127.0.0.1:3016` (découverte, PKCE, JWKS,
  userinfo) ;
- profil SFI : `http://127.0.0.1:3016/sfi/oauth/v1/{authorize,token,infoUser}`
  — calqué sur la préproduction AISC : ni découverte, `client_secret` exigé sur
  `/token`, erreurs OAuth en HTTP 200, `id_token` nu, `infoUser` en JWT signé ;
- **scénarios** : connexion manuelle ou automatique, refus, `id_token` sans
  nonce / autre nonce / mauvaise signature / expiré, `/token` qui refuse le
  client, erreur userinfo. Le défaut se choisit sur le tableau de bord ; en
  manuel, l'écran de connexion permet d'en choisir un pour une seule connexion ;
- identités de test modifiables (dont conjoint et nombre d'enfants pour SFI) ;
- le tableau de bord donne le bloc `oidc` à coller dans `partners.json` pour
  chaque profil, et la clé publique PEM. La clé de signature est conservée dans
  `stub_oidc/.keys/` (hors git) : elle survit au redémarrage.

Deux harnais rejouent le parcours complet contre ce même fournisseur (monté en
mémoire), puis mettent chaque contrôle et chaque scénario en échec. Ils
travaillent dans un répertoire jetable et vérifient en sortie que la
configuration partenaire réelle est intacte :

```
npm run test:oidc        # profil normalisé
npm run test:oidc-sfi    # profil AISC / SFI
```

Sources : `scripts/05-partner-management/check-oidc-flow.js` et
`check-oidc-flow-sfi.js`. Ni base de données ni `.env`.

## Identité et droits d'achat

### Correspondance des claims (`oidc.identity`)

```json
"identity": {
  "identifier": "sub",
  "firstName": "given_name",
  "lastName": "family_name",
  "email": "email",
  "attributes": {
    "beneficiaries": { "sum": [1, "conjoint", "autres_ad"] }
  }
}
```

Chaque valeur est une expression :

- `"claim"` ou `"objet.claim"` : valeur du claim ;
- un nombre : lui-même ;
- `{ "sum": [ … ] }` : somme des termes, un booléen valant 1 ou 0. Si un terme
  manque, la somme est **absente** (et non 0) : un droit sous-évalué en silence
  serait pire qu'un refus explicite.

`identifier` est l'identifiant stable du bénéficiaire chez l'IdP : le
« Subject Identifier » d'OpenID Connect (claim `sub`, OIDC Core §2). `name`
absent : prénom + nom. Sans bloc `identity`, les anciennes clés `subject`,
`subjectClaim` / `emailClaim` / `nameClaim` restent lues.

La session garde identifiant, nom, prénom, courriel et `attributes` ;
`/partner/<slug>/auth/whoami` les affiche. Le prénom, le nom et le courriel
pré-remplissent le panneau Contact de la page de commande (modifiables), qui
affiche aussi, en lecture seule, l'identifiant et les droits restants.

### Droits (`entitlements`, au niveau du partenaire)

```json
"entitlements": [
  { "key": "ayants-droit", "label": "Places ayants droit", "per": "event",
    "max": { "attribute": "beneficiaries" } }
]
```

| Champ | Rôle |
| --- | --- |
| `key` | identifiant stable du panier de droits |
| `label` | libellé montré à l'acheteur et dans les refus |
| `per` | période de décompte ; seul `event` (par match) existe |
| `max` | entier, ou `{ "attribute": "…" }` lu dans la session |
| `tariffs` | codes tarif couverts ; absent = tous |
| `tariffChannel` | `partner` : tarifs propres au partenaire ; `public` : tarifs de la grille publique (`allowPublicTariffs`) |
| `limitDuring` | états de vente où `max` s'applique (ex. `["presale"]`) ; hors de ces états, aucune limite |
| `icon` | pictogramme affiché après le décompte dans le panneau Contact (ex. `"❤️"`) |

- une ligne relève du **premier** panier qui couvre son tarif ; une ligne
  qu'aucun ne couvre est refusée ;
- le décompte porte sur les commandes de ce bénéficiaire (`meta.partner.identifier`,
  désormais enregistré) sur ce match, hors annulées / échouées ;
- l'API de statut renvoie `entitlements` (max, déjà commandé, restant) et
  `limits.entitlementMax` ; le panier bloque la place de trop, le panneau
  Contact affiche « Vos droits : x / y place(s) » ; le paiement et la réservation refusent un
  dépassement (`entitlement_exceeded`, `entitlement_tariff_not_covered`) ;
- les droits exigent une session : sans elle, l'API répond
  `partner_login_required` ;
- le quota global du partenaire (`presale.events`) reste le plafond commun.

Places « en plus » au tarif public, bornées en prévente et libres à
l'ouverture publique :

```json
"allowPublicTariffs": true,
"entitlements": [
  { "key": "ayants-droit", "label": "Places ayants droit",
    "tariffChannel": "partner", "max": { "attribute": "beneficiaries" } },
  { "key": "public-extra", "label": "Places en plus (tarif public)",
    "tariffChannel": "public", "max": 2, "limitDuring": ["presale"] }
]
```

Sur la page partenaire, les tarifs propres au partenaire sont listés en tête
de chaque ligne du panier, et le premier est choisi par défaut (sinon NORMAL).

Un tarif est « partenaire » si ses canaux nomment le partenaire
(`partner:<slug>`, `partner` ou `all`), « public » sinon. Hors de son état de
vente, un panier est marqué `unlimited` et le panneau Contact affiche « sans
limite ».

Évolutions prévues sans changer la forme : un panier par catégorie
(adultes / ados / enfants, chacun avec ses tarifs et son attribut), un panier
« places en plus » au tarif public avec un `max` fixe.

## Connexion obligatoire

`"required": true` dans le bloc `oidc` rend la connexion obligatoire pour ce
partenaire (`src/services/partner-access.js`) :

- pages `/partner/<slug>/events`, `/event/<match>`, `/season/<code>/subscribe` :
  sans session, redirection vers `/partner/<slug>/auth/login?next=<page>`, qui
  ramène sur la page demandée après connexion ;
- API `/api/partner/<slug>/…` : `401 {"error": "partner_login_required"}` ;
- le jeton statique (`?token=`, `x-partner-token`) **n'ouvre plus l'accès** :
  sinon l'obligation se contournerait en le recopiant.

Sans `required` (ou à `false`), le partenaire reste au jeton statique, inchangé.

La session dure `PARTNER_SESSION_TTL_MIN` minutes (120 par défaut). Son cookie
est `SameSite=Lax` : il n'est pas envoyé dans une iframe hébergée sur un autre
site. Un partenaire à connexion obligatoire s'ouvre donc en page directe, pas
en iframe.

Les liens de renouvellement d'abonnement (`/season/<code>/renew?id=…`) restent
nominatifs et signés : ils ne demandent pas de connexion.
