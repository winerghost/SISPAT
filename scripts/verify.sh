#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/verify.sh
# =============================================================================
# Verifica a saúde do ambiente local:
#   1. Lista status/healthcheck dos containers (docker compose ps).
#   2. (Placeholder) Executa migrações Alembic — ativar quando o backend
#      estiver pronto.
#   3. (Placeholder) Executa a suíte de testes pytest — ativar quando o
#      backend estiver pronto.
#
# Uso:
#   ./scripts/verify.sh
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"

echo "==> SISPAT-AGU — verificando status dos containers"
$COMPOSE ps

echo
echo "==> Resumo de healthcheck por serviço:"
for svc in backend worker redis frontend; do
  cid=$($COMPOSE ps -q "$svc" 2>/dev/null || true)
  if [ -n "$cid" ]; then
    status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}sem healthcheck{{end}}' "$cid" 2>/dev/null || echo "indisponível")
    echo "    - $svc: $status"
  else
    echo "    - $svc: container não encontrado (não iniciado?)"
  fi
done

echo
echo "==> [PLACEHOLDER] Migrações Alembic"
echo "    Quando o backend (backend/app, backend/migrations) estiver pronto,"
echo "    substitua a linha abaixo pelo comando real, por exemplo:"
echo "      $COMPOSE exec backend alembic upgrade head"
# $COMPOSE exec backend alembic upgrade head

echo
echo "==> [PLACEHOLDER] Testes automatizados (pytest)"
echo "    Quando o backend estiver pronto, substitua a linha abaixo pelo"
echo "    comando real, por exemplo:"
echo "      $COMPOSE exec backend pytest"
# $COMPOSE exec backend pytest

echo
echo "==> Verificação concluída."
