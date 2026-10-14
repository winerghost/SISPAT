#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/init.sh
# =============================================================================
# Inicializa o ambiente de desenvolvimento local:
#   1. Copia .env.example para .env (se ainda não existir).
#   2. Sobe os containers de desenvolvimento (base + overrides de dev).
#
# Uso:
#   ./scripts/init.sh
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> SISPAT-AGU — inicializando ambiente de desenvolvimento"

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp ".env.example" ".env"
    echo "==> Arquivo .env criado a partir de .env.example."
    echo "    IMPORTANTE: edite o .env e preencha as credenciais reais antes"
    echo "    de usar o ambiente (nunca versionar o .env)."
  else
    echo "ERRO: .env.example não encontrado em $ROOT_DIR." >&2
    exit 1
  fi
else
  echo "==> Arquivo .env já existe — mantendo o atual."
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERRO: Docker não encontrado no PATH. Instale o Docker Desktop/Engine." >&2
  exit 1
fi

echo "==> Subindo containers (docker-compose.yml + docker-compose.dev.yml)..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

echo "==> Ambiente de desenvolvimento iniciado."
echo "    Use 'docker compose -f docker-compose.yml -f docker-compose.dev.yml ps'"
echo "    para verificar o status, ou execute scripts/verify.sh."
