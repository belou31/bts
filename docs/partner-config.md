# Configuration des partenaires

Un fichier par partenaire, dans son dossier :

```
data/customization/partners/
  _default.json            habillage commun à tous les partenaires (textes)
  _templates/              modèles locaux, par mode de connexion
    openid.json
    directory.json
    none.json
  aisc.json                habillage du partenaire (textes)
  aisc/
    partner.json           configuration du partenaire
    seasons/…  events/…    habillage par saison / événement
  tbhc/
    partner.json
```

`partner.json` porte la **configuration métier** : connexion (`connection`),
bloc `oidc`, identifiants admin, droits (`entitlements`), mode de paiement,
quotas de prévente, jetons, vues de salle. L'habillage (titres, textes) reste
dans `partners/<slug>.json` — voir Set Partner Customization.

- Le **nom du dossier fait le slug**. Un `slug` différent dans le fichier est
  signalé ; le dossier l'emporte.
- Les dossiers qui commencent par `_` sont réservés (`_templates`).
- Le fichier est relu à chaque requête : une modification s'applique sans
  redémarrer.
- **Un fichier illisible n'écarte que son partenaire** (avertissement dans le
  journal, avec le fichier et la position de l'erreur). Les autres partenaires
  continuent de fonctionner. Les scripts refusent d'écrire par-dessus un
  fichier illisible.
- Les scripts écrivent dans un fichier temporaire puis le renomment : un
  fichier n'est jamais lu à moitié écrit.

Vérifier un fichier après une modification à la main :

```bash
node -e "JSON.parse(require('fs').readFileSync('data/customization/partners/tbhc/partner.json','utf8'))"
```

## Modèles par mode de connexion

Trois modèles, un par mode de connexion :

| Modèle | Contenu | À compléter après création |
|---|---|---|
| `openid` | `connection: openid`, bloc `oidc` (vide), correspondance d'identité, droits « ayants droit » | bloc `oidc` (voir `partner-oidc.md`), identifiants admin |
| `directory` | `connection: directory`, droits « ayants droit » + « extra (tarif public) » lus dans l'annuaire | identifiants admin, puis import de l'annuaire (`partner-directory.md`) |
| `none` | `connection: none`, jetons et prévente vides | rien ; jeton éventuel (Generate Partner Token) |

**Copiés une fois, à la création** : le modèle est recopié en entier dans
`partner.json`, qui contient ensuite tout ce qui s'applique. Modifier un modèle
plus tard ne change pas les partenaires existants.

```bash
# Créer à partir d'un modèle (refusé si le partenaire existe déjà)
node scripts/05-partner-management/upsert-partner.js --slug=tbhc --name="TBHC" --template=directory
```

Les options données en plus (`--payment-mode`, `--allow-public-tariffs`)
remplacent les valeurs du modèle ; les autres restent celles du modèle. Les
notes du modèle (`_notes`) s'affichent à la création et ne sont pas recopiées.

Modèles utilisés :

1. `data/customization/partners/_templates/<kind>.json` s'il existe — créé par
   **Init Partner Templates** (`init-partners.js`), à adapter à l'installation ;
2. sinon le modèle livré, `data_references/partners/<kind>.json`.

## Migration depuis `partners.json`

Avant, tous les partenaires étaient dans un seul tableau,
`data/customization/partners.json`. Il reste lu, pour les partenaires qui n'ont
pas encore leur fichier ; chaque script Set Partner … déplace le partenaire
qu'il modifie dans son fichier.

Migration en bloc :

```bash
node scripts/05-partner-management/migrate-partners-to-files.js --dry-run
node scripts/05-partner-management/migrate-partners-to-files.js
```

- chaque entrée est recopiée telle quelle ;
- l'original est d'abord copié en `partners.json.migrated-<date>` (sauvegarde,
  jamais relue), puis `partners.json` est retiré une fois tout migré ;
- un partenaire qui a déjà son fichier n'est pas écrasé (signalé) ;
- un `partners.json` invalide arrête le script avant toute écriture : le
  corriger d'abord.
