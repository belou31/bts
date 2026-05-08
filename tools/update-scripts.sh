#!/usr/bin/env bash
set -euo pipefail
BRANCH="${1:-int}"

echo "→ Updating scripts/ from branch: $BRANCH"
TMP="$(mktemp -d)"
curl -L -o "$TMP/repo.zip" "https://github.com/belou00/bts/archive/refs/heads/$BRANCH.zip"
unzip -q "$TMP/repo.zip" -d "$TMP"

# sauvegarde rapide (optionnelle)
tar -czf "scripts.backup.$(date +%F-%H%M%S).tgz" scripts/

rsync -a --delete "$TMP"/bts-*/scripts/ ./scripts/
rm -rf "$TMP"
echo "✓ Done."
