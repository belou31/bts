---
title: Accueil
nav_order: 1
---

# Belougas Ticketing System (BTS)

Cette arborescence `docs/` est désormais la **source de vérité** de la documentation BTS.

- Les pages Markdown `docs/*.md` sont les sources à maintenir.
- Les anciens documents numérotés `03-*`, `04-*`, `05-*` restent disponibles comme références historiques pendant la migration, mais ils ne sont plus l'entrée principale.

## Table des matières

1. [Architecture](architecture.md)
2. [Flux applicatifs](runtime-flows.md)
3. [Installation](installation.md)
4. [Configuration](configuration.md)
5. [Console d’administration](admin-console.md)
6. [Catalogue des scripts](scripts-catalog.md)
7. [API d’automatisation](automation-api.md)
8. [Paiements](payments.md)
9. [Stubs de paiement](stubs.md)
10. [Intégrations tableur](spreadsheet-integrations.md)
11. [Runbook d’exploitation](operations-runbook.md)
12. [Modèle de données](data-model.md)
13. [Migrations](migrations.md)
14. [Dépannage](troubleshooting.md)

## État de migration

- **Phase 1** : séparation nette entre documentation source et anciens artefacts.
- **Phase 2** : pages coeur réécrites autour du runtime actuel : architecture, flux, installation, runbook.
- **Phase 3** : références volatiles désormais générées depuis le code pour le catalogue des scripts, l’API d’automatisation, les paiements et le modèle de données.
