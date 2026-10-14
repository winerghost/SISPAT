#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/test-frontend.sh
# =============================================================================
# Lint + typecheck + build de produção do Next.js. Não chama serviços reais:
# o build usa apenas variáveis NEXT_PUBLIC_* fictícias quando não definidas.
#
# Uso:
#   scripts/test-frontend.sh            # lint, typecheck, build
#   scripts/test-frontend.sh --ci       # npm ci antes (instalação limpa do lockfile)
#   scripts/test-frontend.sh --no-build # só lint + typecheck
#   scripts/test-frontend.sh --docker   # build da imagem (docker compose build frontend)
# Saída: 0 = ok; !=0 = falha.
# =============================================================================
set -euo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

DO_CI=0; DO_BUILD=1; DO_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --ci) DO_CI=1 ;;
    --no-build) DO_BUILD=0 ;;
    --docker) DO_DOCKER=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "Argumento desconhecido: $arg" ;;
  esac
done

if [ "$DO_DOCKER" = 1 ]; then
  have docker || die "docker CLI ausente."
  cd "$ROOT_DIR"
  log "docker compose build frontend (target runtime)"
  exec docker compose -f docker-compose.yml build frontend
fi

have npm || die "npm não encontrado."
cd "$ROOT_DIR/frontend"

if [ "$DO_CI" = 1 ] || [ ! -d node_modules ]; then
  log "npm ci (lockfile)"
  npm ci --no-audit --no-fund
fi

export NEXT_TELEMETRY_DISABLED=1
# Valores sintéticos apenas para o build não depender de configuração real.
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:8000/api}"
export NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-build-anon-key-ficticia}"

log "npm run lint"
npm run lint
log "npm run typecheck"
npm run typecheck
if [ "$DO_BUILD" = 1 ]; then
  log "npm run build"
  npm run build
fi
log "Frontend OK"
