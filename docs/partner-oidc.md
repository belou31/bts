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

## Profil AISC / SFI v2.2 (Castelis)

Premier partenaire raccordé. Sa spécification s'écarte de la norme sur six
points, tous couverts par les réglages ci-dessus :

- pas de document de découverte, pas de JWKS ;
- endpoints fixes `…/sfi/oauth/v1/{authorize,token,infoUser}` ;
- PKCE non mentionné ;
- `/token` attend un corps **JSON**, sans `client_secret` pour
  `authorization_code` ;
- l'`id_token` ne porte que `iss`, `iat`, `exp`, `sub`, `aud` : le profil
  s'obtient sur `infoUser` (GET, `Authorization: Bearer …`) ;
- erreurs au format RFC 7807 (`{type, title, status, detail}`).

Le `sub` est le matricule AISC (`M1234569`). Scopes propres au partenaire :
`od`, `family`, `billetterie` (`matricule_groupe`, `societe`, `code_societe`,
`conjoint`, `autres_ad`, `subvention`).

```jsonc
{
  "slug": "aisc",
  "name": "AISC — Comité social Airbus",
  "oidc": {
    "issuer": "https://sfi.aisc.example/sfi",
    "clientId": "bts-belougas",
    "endpoints": {
      "authorization": "https://sfi.aisc.example/sfi/oauth/v1/authorize",
      "token":         "https://sfi.aisc.example/sfi/oauth/v1/token",
      "userinfo":      "https://sfi.aisc.example/sfi/oauth/v1/infoUser"
    },
    "scopes": ["openid", "profile", "email", "billetterie"],
    "pkce": false,
    "tokenRequest": "json",
    "clientAuth": "none",
    "fetchUserInfo": true,
    "idTokenPublicKey": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq…\n-----END PUBLIC KEY-----",
    "subjectClaim": "sub",
    "requiredClaim": { "claim": "societe", "value": "AIRBUS SAS" }
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

Un fournisseur d'identité **factice** est fourni. Il n'est monté que si
`OIDC_STUB=true`, et il refuse de démarrer quand `APP_ENV=production` : il
délivre une identité à quiconque la demande.

```
OIDC_STUB=true npm run dev
```

- profil normalisé : `<APP_URL>/dev/oidc` (découverte, PKCE, JWKS, userinfo) ;
- profil SFI : `<APP_URL>/dev/oidc/sfi` — ni découverte ni JWKS, `/token` en
  JSON, `id_token` nu, erreurs RFC 7807. La clé publique se récupère sur
  `/dev/oidc/sfi/keys/public.pem` (hors spec, pour le test seulement).

Deux harnais rejouent le parcours complet puis mettent chaque contrôle en
échec. Ils travaillent dans un répertoire jetable et vérifient en sortie que la
configuration partenaire réelle est intacte :

```
npm run test:oidc        # profil normalisé
npm run test:oidc-sfi    # profil AISC / SFI
```

Sources : `scripts/05-partner-management/check-oidc-flow.js` et
`check-oidc-flow-sfi.js`. Les deux démarrent leur propre serveur sur un port
libre et ne demandent ni base de données ni `.env`.

## Limite connue

`required: true` est lu et transporté, mais **pas encore appliqué** : les pages
partenaire continuent de vérifier le jeton statique comme avant. Une session
OIDC s'ouvre et `whoami` la renvoie, mais elle ne remplace pas encore le jeton.
C'est le prochain pas à franchir, et il mérite d'être décidé partenaire par
partenaire — le basculer d'un coup couperait l'accès à ceux qui utilisent
l'iframe.
