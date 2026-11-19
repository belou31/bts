# Stadium — bons cadeaux (invitations) test set

Compatible avec le lieu `stadium` de `data_examples/stadium_map_basic/` +
`data_examples/stadium_tariffs/`. Couvre les deux usages réels — le fan qui
offre quelques places, et l'école ou l'association à qui le club en donne un
lot — plus les cas limites qui font échouer un bon.

Un bon = **un droit à N places**, échangeable par le bénéficiaire lui-même sur
`/voucher?id=<jwt>`. Voir `docs/operations-runbook.md` § *Bons cadeaux*.

## Fichiers

| Fichier | Sert à | Format |
|---|---|---|
| `vouchers.stadium.csv` | `scripts/06-misc/create-voucher.js` | une ligne par bon |
| `import-vouchers.sh` | crée tous les bons du CSV d'un coup | script shell |
| `event-tags.stadium.csv` | rappel des `Event.tags` attendus | référence |

## Prérequis

Les bons ne s'appuient sur aucun match nommé (sauf le cas « presse ») : ils
ciblent une **étiquette**. Il faut donc que les matchs en portent une —
`Event.tags`, posé à la création ou en base :

```js
db.events.updateOne({ slug: 'match01-2027' }, { $set: { tags: ['regular'] } })
```

C'est le point du dispositif : un bon émis en fin de saison ne connaît pas le
calendrier suivant. Il dit « saison régulière », pas « match du 16 septembre ».

## Les cas couverts

| Bon | Solde | Plafond/match | Zones | Ce qu'il démontre |
|---|---|---|---|---|
| École Jean Moulin | 20 | 20 | S1, S3 | Groupe scolaire : tout sur un seul match |
| Centre social Les Tilleuls | 12 | 4 | S3 | **Multi-visites** : 4 places à la fois, plusieurs matchs |
| Cadeau anniversaire Camille | 2 | — | toutes | Bon fan minimal, sans restriction de zone |
| Tombola club | 6 | 2 | S1, S2, S3 | Zones assises seulement + échéance courte |
| Partenaire Boulangerie Girard | 4 | 2 | VIP | Zone unique, sans contrainte d'étiquette |
| Invitation presse J1 | 2 | 2 | E | **Match explicite** (`--events`) plutôt qu'une règle |
| Bon fin de saison | 10 | 4 | S1, S3 | **Aucun match listé** : la règle saison + tag suffit |

## Lancer

```bash
bash data_examples/stadium_vouchers/import-vouchers.sh
```

Chaque création imprime le lien `/voucher?id=…` à encoder dans un QR. Les bons
apparaissent ensuite dans `/admin/vouchers` (catégorie *Advanced*), avec leur
solde, leur portée et le journal des retraits.

## Ce qu'il faut essayer ensuite

- **Le plafond par match** : avec « Les Tilleuls », prendre 4 places sur un
  match, puis rouvrir le lien — le même match est épuisé, les 8 restantes
  attendent un autre match.
- **Le périmètre de zone** : avec « Boulangerie Girard », les sièges hors VIP
  sont affichés indisponibles et refusés côté serveur.
- **L'étiquette** : taguer un match `playoff` — il disparaît de la liste des
  bons `regular`, sans avoir eu à les modifier.
- **L'expiration** : avancer `expiresAt` d'un bon dans le passé (ou le suspendre
  depuis l'admin) et rouvrir le lien.

## Achat d'un bon

L'amont — un tiers qui *achète* un bon — se teste sur `/voucher/buy`. Le barème
vit dans `data/customization/voucher-purchase.json` (prix par place, bornes,
validité, portée). Le bon n'est créé **qu'au paiement confirmé** : rien n'est
émis tant que la commande est `pending`.
