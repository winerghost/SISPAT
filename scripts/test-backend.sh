#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/test-backend.sh
# =============================================================================
# Executa a suíte pytest do backend com cobertura. Não acessa Supabase,
# Google, n8n nem a VPS: os testes usam Flask test client + mocks
# (backend/tests/conftest.py define variáveis FICTÍCIAS).
#
# Uso:
#   scripts/test-backend.sh                 # usa o Python atual
#   scripts/test-backend.sh --venv          # cria/usa venv isolado (fora do repo)
#                                           # com backend/requirements-dev.txt
#   scripts/test-backend.sh --docker        # roda no container (target dev)
#   scripts/test-backend.sh -- -k rbac      # argumentos extras para o pytest
#
# Variáveis: PYTHON, COV_FAIL_UNDER (padrão 0 = só reporta), SISPAT_TOOLS_HOME.
# Saída: 0 = testes ok; !=0 = falha.
# =============================================================================
set -euo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

MODE="local"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --venv) MODE="venv" ;;
    --docker) MODE="docker" ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) EXTRA+=("$1") ;;
  esac
  shift
done

COV_FAIL_UNDER="${COV_FAIL_UNDER:-0}"
OUT_DIR="$(report_dir backend-tests)"
PYTEST_ARGS=(-q -p no:cacheprovider --cov=app --cov-report=term-missing:skip-covered
             "--cov-fail-under=$COV_FAIL_UNDER")

if [ "$MODE" = "docker" ]; then
  have docker || die "docker CLI ausente."
  log "pytest no container (docker-compose.dev.yml, target dev, sem dependências)"
  cd "$ROOT_DIR"
  exec docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps \
    -e FLASK_ENV=testing backend python -m pytest "${PYTEST_ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
fi

PY="$(pick_python)"
if [ "$MODE" = "venv" ]; then
  VENV="$(tools_home)/backend-venv"
  if [ ! -d "$VENV" ]; then
    log "Criando venv isolado em $VENV"
    "$PY" -m venv "$(native_path "$VENV")"
  fi
  PY="$(venv_bin "$VENV" python)"
  log "Instalando backend/requirements-dev.txt no venv"
  ( cd "$ROOT_DIR/backend" && "$PY" -m pip install -q --disable-pip-version-check -r requirements-dev.txt )
fi

"$PY" -c 'import pytest, pytest_cov' 2>/dev/null \
  || die "pytest/pytest-cov ausentes. Use --venv ou: pip install -r backend/requirements-dev.txt"

log "pytest (backend) — cobertura de app/"
cd "$ROOT_DIR/backend"
"$PY" -m pytest "${PYTEST_ARGS[@]}" \
  "--cov-report=xml:$(native_path "$OUT_DIR/coverage.xml")" \
  "--junitxml=$(native_path "$OUT_DIR/junit.xml")" \
  ${EXTRA[@]+"${EXTRA[@]}"}
info "Relatórios: $OUT_DIR"
