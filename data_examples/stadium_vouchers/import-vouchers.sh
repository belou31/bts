#!/usr/bin/env bash
# Crée les bons de vouchers.stadium.csv via scripts/06-misc/create-voucher.js.
# Chaque ligne devient un bon ; le lien de retrait est imprimé à la création.
#
#   bash data_examples/stadium_vouchers/import-vouchers.sh
#
set -euo pipefail
CSV="$(dirname "$0")/vouchers.stadium.csv"
tail -n +2 "$CSV" | while IFS=';' read -r label total maxPerEvent zones tags seasons events expires note; do
  [ -z "${label:-}" ] && continue
  args=(--total="$total" --label="$label")
  [ -n "${maxPerEvent:-}" ] && [ "$maxPerEvent" != "0" ] && args+=(--max-per-event="$maxPerEvent")
  [ -n "${zones:-}" ]   && args+=(--zones="$zones")
  [ -n "${tags:-}" ]    && args+=(--tags="$tags")
  [ -n "${seasons:-}" ] && args+=(--seasons="$seasons")
  [ -n "${events:-}" ]  && args+=(--events="$events")
  [ -n "${expires:-}" ] && args+=(--expires="$expires")
  echo "── $label"
  node scripts/06-misc/create-voucher.js "${args[@]}"
done
