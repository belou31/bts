---
title: Operations Runbook
nav_order: 110
---

# Runbook d’exploitation

Cette page est le point d'entrée opérateur pour mettre BTS en service et exécuter les flux métier dans le bon ordre.

## Principes d'exploitation

- la documentation fonctionnelle des commandes longues vit dans [scripts-catalog.md](scripts-catalog.md)
- les fichiers d'entrée sont placés dans `data/inputs`
- les exports sont généralement écrits dans `data/outputs`
- la console `/admin` réutilise le même catalogue que la CLI

## Séquence d'ensemble

La séquence standard de mise en service est :

1. vérifier l'environnement
2. personnaliser l'application
3. enregistrer le lieu et ses plans
4. importer sièges et zones
5. créer la saison
6. instancier lieu et tarifs pour la saison
7. choisir le flux métier à ouvrir
8. surveiller paiements, commandes et tickets

## 1. Bootstrap système

### Vérifier l'environnement

```bash
node scripts/00-system-management/check-env.js
```

### Personnaliser les assets

```bash
node scripts/00-system-management/customize-app.js --name="Belougas"
```

Cas fréquents :

- logo PNG / SVG
- favicon
- icônes PWA

### Optionnel : remettre la base à zéro

```bash
node scripts/00-system-management/reset-db.js --force
```

À réserver aux environnements de DEV ou de rechargement complet.

## 2. Préparer le lieu

### Enregistrer le lieu

```bash
node scripts/01-venue-management/register-venue.js patinoire-blagnac "Patinoire de Blagnac" data/inputs/plan.svg
```

### Importer les sièges

```bash
node scripts/01-venue-management/import-seats.js --venue=patinoire-blagnac --csv=data/inputs/seats.csv
```

### Importer les zones

```bash
node scripts/01-venue-management/import-zones.js --venue=patinoire-blagnac --csv=data/inputs/zones.csv
```

### Ajouter des vues spécifiques

```bash
node scripts/01-venue-management/import-venue-view.js patinoire-blagnac partenaire data/inputs/view-partner.svg
```

Cette étape est importante si :

- certains partenaires ont une vue dédiée
- un événement utilise une variante de plan

## 3. Préparer les tarifs

### Importer le catalogue de tarifs

```bash
node scripts/02-tariff-management/import-tariffs.js data/inputs/tariff_catalog.csv
```

### Importer un catalogue de prix

```bash
node scripts/02-tariff-management/import-tariff-prices.js abonnement-2025 data/inputs/prices.csv --venue=patinoire-blagnac
```

### Vérifier ou exporter la matrice

```bash
node scripts/02-tariff-management/export-zone-tariffs-matrix.js 2025-2026 patinoire-blagnac data/outputs/prices-matrix.csv
```

## 4. Ouvrir une saison

### Créer la saison

```bash
node scripts/03-season-management/create-season.js 2025-2026 --name="Saison 2025-2026" --active=true
```

### Instancier le lieu pour la saison

```bash
node scripts/03-season-management/instantiate-venue-for-season.js 2025-2026 patinoire-blagnac
```

### Appliquer les tarifs à la saison

```bash
node scripts/03-season-management/instantiate-tariffs.js 2025-2026 patinoire-blagnac --catalog=abonnement-2025
```

### Régler les phases

Quand les scripts ou l'admin console sont utilisés pour piloter le calendrier, la logique attend les phases :

- `renewal`
- `fanclub`
- `public`

## 5. Exécuter une campagne de renouvellement

### Importer les abonnés à renouveler

```bash
node scripts/03-season-management/import-renewers-flat.js data/inputs/renew-subscribers.csv 2025-2026 --venue=patinoire-blagnac
```

### Provisionner les sièges

```bash
node scripts/03-season-management/renewal-provision-seats.js 2025-2026 --venue=patinoire-blagnac --apply
```

### Exporter les liens

```bash
node scripts/03-season-management/export-renew-groups.js 2025-2026 --venue=patinoire-blagnac --base=https://billetterie.example/bts --out=data/outputs/renew-groups.csv
```

### Envoyer les invitations

Via automation API ou console :

```bash
node scripts/03-season-management/send-renew-invites.js data/outputs/renew-groups.csv --season=2025-2026 --dry
```

### Auditer la campagne

```bash
node scripts/03-season-management/export-renew-seats.js 2025-2026 --venue=patinoire-blagnac --out=data/outputs/renew-seats.csv
```

### Clore la phase

```bash
node scripts/03-season-management/renewal-close-phase.js 2025-2026 --venue=patinoire-blagnac
```

Effet attendu :

- désactivation de la phase de renouvellement
- libération des sièges non renouvelés

## 6. Exploiter les abonnements saison

### Importer des commandes d'abonnement

```bash
node scripts/03-season-management/import-subscription-orders.js data/inputs/subscription-orders.csv --season=2025-2026 --venue=patinoire-blagnac --status=paid --commit
```

### Exporter les abonnés

```bash
node scripts/03-season-management/export-subscribers.js --season=2025-2026 --venue=patinoire-blagnac --activeOnly
```

### Exporter les commandes

```bash
node scripts/03-season-management/export-subscription-orders.js --season=2025-2026 --venue=patinoire-blagnac --status=paid
```

## 7. Ouvrir une vente événementielle

### Créer l'événement

```bash
node scripts/04-event-management/create.js --slug=match-j1 --name="Match J1" --date=2026-09-20T18:00:00Z --season=2025-2026
```

### Instancier les tarifs événementiels

```bash
node scripts/04-event-management/instantiate-tariffs.js --event=match-j1 --catalog=event-j1 --clear
```

### Recalculer les tarifs autorisés par zone

```bash
node scripts/04-event-management/build-allowed-from-prices.js --event=match-j1
```

### Ouvrir la vente

```bash
node scripts/04-event-management/publish-event.js --event=match-j1 --sale=onsale
```

### Charger des QR si nécessaire

```bash
node scripts/04-event-management/import-qr-bank.js --event=match-j1 --csv=data/inputs/qr-bank.csv
```

### Importer ou rejouer des commandes

```bash
node scripts/04-event-management/import-orders.js data/inputs/event-orders.csv --status=paid --commit
```

### Relancer l'envoi de billets

```bash
node scripts/04-event-management/resend-event-tickets.js --event=match-j1 --order=<orderId>
```

## 8. Exploiter les partenaires

### Initialiser les partenaires

```bash
node scripts/05-partner-management/init-partners.js --force
```

### Créer ou mettre à jour un partenaire

```bash
node scripts/05-partner-management/upsert-partner.js --slug=cseairbus --name="CSE Airbus" --payment-mode=psp
```

### Régler la sécurité d'embarquement

```bash
node scripts/05-partner-management/set-partner-security.js --slug=cseairbus --allowed-origins=https://partner.example.com --frame-ancestors=https://partner.example.com
```

### Générer un token partenaire

```bash
node scripts/05-partner-management/generate-partner-token.js --partner=cseairbus --event=match-j1 --force
```

### Affecter une vue spécifique

```bash
node scripts/05-partner-management/set-partner-view.js --slug=cseairbus --venue-view=partenaire --event=match-j1
```

## 9. Supervision courante

### Console d'administration

Utiliser `/admin` pour :

- l'état serveur et MongoDB
- le lancement de scripts
- le suivi des jobs d'automatisation
- les exports
- les vues de monitoring abonnement / événement / partenaires

### Vérifier les commandes en attente (exécution ponctuelle)

```bash
node scripts/sentinels/pending-orders.js
```

### Sentinel `bts-sentinel` (INT/PROD)

Sur INT et PROD, `pending-orders.js` tourne en continu sous pm2, relancé toutes les 2 minutes
via `cron_restart` (le script est one-shot : il fait un passage puis `process.exit(0)`).
Ces réglages (`--cron`, `--no-autorestart`) sont définis une fois pour toutes dans
[`ecosystem.config.cjs`](../ecosystem.config.cjs) à la racine du repo — ne pas relancer le
sentinel avec un simple `pm2 start scripts/sentinels/pending-orders.js --name bts-sentinel`
sans passer par ce fichier, sinon il repart avec les valeurs par défaut pm2 (autorestart
continu, pas de cron) et diverge silencieusement de la config de référence.

```bash
# démarrage / (re)lecture de la config versionnée
pm2 start ecosystem.config.cjs --only bts-sentinel
pm2 save   # persiste dans ~/.pm2/dump.pm2 pour ce host (pm2 resurrect / pm2 startup)

# ou via le wrapper du repo (fait restart puis fallback start) :
node scripts/00-system-management/pm2-control.js --name=bts-sentinel --action=restart
```

`pm2 save` n'écrit que sur la machine locale (`~/.pm2/dump.pm2`, hors dépôt git) — c'est un
instantané du process list de CE host, pas une sauvegarde de la commande elle-même. Après un
`pm2 kill` / redémarrage machine sans `pm2 save` préalable (ou sans `pm2 startup` configuré),
rien ne redémarre automatiquement : vérifier `pm2 list` après toute intervention sur l'hôte.

#### Survivre à un reboot machine (`pm2 startup`)

`pm2 save` seul ne suffit pas à survivre à un redémarrage de la machine : il faut en plus
qu'un service d'init (systemd sur INT/PROD) relance le démon pm2 au boot, qui ensuite exécute
`pm2 resurrect` pour relire `dump.pm2`. C'est ce que configure `pm2 startup` — **à faire une
seule fois par host**, pas par déploiement :

```bash
# 1) démarrer les process de référence
pm2 start ecosystem.config.cjs
pm2 save

# 2) générer + activer le service systemd (imprime une commande à copier-coller en sudo,
#    sauf si pm2 est déjà enregistré comme service sur cet host — vérifier avant de relancer)
pm2 startup
# → exécuter la ligne "sudo env PATH=... pm2 startup systemd -u <user> --hp <home>" affichée

# 3) reconfirmer l'état à sauvegarder (indispensable après toute évolution de la liste de
#    process : ajout, suppression, changement de ecosystem.config.cjs)
pm2 save
```

Vérification après coup :

```bash
systemctl status pm2-<user>       # actif et enabled au boot
pm2 status                         # bts + bts-sentinel présents après un `sudo reboot` de test
```

À refaire : `pm2 save` après **chaque** changement durable de la liste de process (nouvel
app, retrait d'un app, édition de `ecosystem.config.cjs`) — sinon le prochain boot resurrect
l'ancien état. `pm2 startup` lui-même (l'enregistrement systemd) n'a besoin d'être relancé que
si l'utilisateur système, le chemin `node`, ou l'OS changent. Pour désactiver : `pm2 unstartup systemd`.

Historique/diagnostic :

```bash
pm2 describe bts-sentinel                 # restart_time, cron_restart, status
tail -n 500 ~/.pm2/logs/bts-sentinel-out.log
grep -i sentinel ~/.pm2/pm2.log           # évènements démon (start/stop/crash)
```

### Vérifier les modèles et index

```bash
npm run db:verify-models
npm run db:sync-indexes
```

### Nettoyer les logs opérationnels

```bash
node scripts/00-system-management/purge-logs.js --apply
```

## 10. Diagnostics et exports

### Audit sièges manquants

```bash
node scripts/06-misc/audit-missing-seats.js 2025-2026 --venue=patinoire-blagnac
```

### Exports courants

```bash
node scripts/06-misc/reports/export-orders.js --season=2025-2026 --venue=patinoire-blagnac --status=paid
node scripts/06-misc/reports/export-seats.js --season=2025-2026 --venue=patinoire-blagnac
```

### Suppression / annulation de commandes importées

```bash
node scripts/orders-delete-csv.js --file=data/inputs/orders-delete.csv --commit
```

## 11. Intégrations tableur

Deux modes existent pour les équipes d'exploitation :

- console `/admin` et CLI locale
- intégrations Google Sheets / LibreOffice / Microsoft branchées sur `/api/automation`

À utiliser lorsque :

- l'équipe métier travaille déjà dans des tableurs
- on veut un historique de jobs et des contrôles de scope

Références :

- [automation-api.md](automation-api.md)
- [spreadsheet-integrations.md](spreadsheet-integrations.md)

## 12. Règles de prudence

- toujours identifier l'environnement cible avant un import massif
- privilégier les dry-runs quand le script le permet
- vérifier les exports générés avant d'envoyer des emails ou d'ouvrir une vente
- ne pas lancer une migration ou un reset sans sauvegarde adaptée

## Pages liées

- [Installation](installation.md)
- [Catalogue des scripts](scripts-catalog.md)
- [Console d’administration](admin-console.md)
- [Migrations](migrations.md)
