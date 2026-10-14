#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/test-responsive.sh
# =============================================================================
# Executa os testes Playwright do frontend (frontend/e2e, playwright.config.ts).
# O Next sobe localmente com variáveis SINTÉTICAS e toda rede externa é
# bloqueada/mocada pelos próprios testes — nada vai para Supabase/VPS reais.
#
# Uso:
#   scripts/test-responsive.sh                     # projeto "responsive"
#   scripts/test-responsive.sh --all               # npm run test:e2e (todos)
#   scripts/test-responsive.sh --install-browsers  # baixa o Chromium do Playwright antes
#   scripts/test-responsive.sh -- --grep login     # argumentos extras ao Playwright
# Saída: código do Playwright (0 = ok).
# =============================================================================
set -euo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

ALL=0; INSTALL=0; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --install-browsers) INSTALL=1 ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) EXTRA+=("$1") ;;
  esac
  shift
done

have npx || die "npx/npm não encontrado."
cd "$ROOT_DIR/frontend"
[ -f playwright.config.ts ] || die "frontend/playwright.config.ts não encontrado."
[ -d node_modules/@playwright/test ] || { log "npm ci"; npm ci --no-audit --no-fund; }

if [ "$INSTALL" = 1 ]; then
  log "npx playwright install chromium"
  npx playwright install chromium
fi

export NEXT_TELEMETRY_DISABLED=1
if [ "$ALL" = 1 ]; then
  log "npm run test:e2e"
  npm run test:e2e -- ${EXTRA[@]+"${EXTRA[@]}"}
else
  log "npx playwright test --project=responsive"
  npx playwright test --project=responsive ${EXTRA[@]+"${EXTRA[@]}"}
fi
