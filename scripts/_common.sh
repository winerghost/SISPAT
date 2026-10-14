#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/_common.sh (funções compartilhadas; use via "source")
# Compatível com Linux, macOS e Git Bash (Windows). Não destrutivo.
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT_DIR

log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    [AVISO] %s\n' "$*" >&2; }
fail() { printf '    [FALHA] %s\n' "$*" >&2; }
die()  { printf '[ERRO] %s\n' "$*" >&2; exit 2; }

have() { command -v "$1" >/dev/null 2>&1; }

# Interpretador Python: $PYTHON > python3 > python.
pick_python() {
  if [ -n "${PYTHON:-}" ]; then echo "$PYTHON"; return; fi
  # Git Bash/MSYS (Windows): "python3.exe" não cria venv corretamente — usar "python".
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) if have python; then echo python; return; fi ;;
  esac
  if have python3 && python3 -c 'import sys' >/dev/null 2>&1; then echo python3; return; fi
  if have python; then echo python; return; fi
  die "Python não encontrado (defina PYTHON=/caminho/python)."
}

# Caminho do executável dentro de um venv (Scripts/ no Windows, bin/ no POSIX).
venv_bin() {
  local venv="$1" exe="$2"
  if [ -x "$venv/Scripts/$exe.exe" ] || [ -f "$venv/Scripts/$exe.exe" ]; then
    echo "$venv/Scripts/$exe.exe"
  elif [ -f "$venv/Scripts/$exe" ]; then
    echo "$venv/Scripts/$exe"
  else
    echo "$venv/bin/$exe"
  fi
}

# Diretório temporário/cache FORA do repositório (não polui o projeto).
tools_home() {
  local base="${SISPAT_TOOLS_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/sispat-agu-tools}"
  mkdir -p "$base"
  echo "$base"
}

# Converte caminho POSIX -> Windows quando executado no Git Bash (para
# programas nativos do Windows que recebem caminhos de saída).
native_path() {
  if have cygpath; then cygpath -w "$1"; else echo "$1"; fi
}

# Diretório de relatórios (ignorado pelo git: reports/).
report_dir() {
  local name="$1"
  local dir="$ROOT_DIR/reports/$name/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dir"
  echo "$dir"
}

# Executa "docker compose config" sem exigir um .env real: se .env não
# existir, cria um TEMPORÁRIO a partir de .env.example com valores fictícios
# e o remove ao final. Nunca sobrescreve um .env existente.
compose_config_check() {
  have docker || { warn "docker CLI ausente — 'docker compose config' não executado."; return 3; }
  local created=0 rc=0
  if [ ! -f "$ROOT_DIR/.env" ]; then
    sed -e 's/^REDIS_PASSWORD=$/REDIS_PASSWORD=ci0dummy0not0a0secret/' \
        "$ROOT_DIR/.env.example" > "$ROOT_DIR/.env"
    created=1
  fi
  (
    cd "$ROOT_DIR" || exit 2
    docker compose -f docker-compose.yml config -q &&
    docker compose -f docker-compose.yml --profile worker config -q &&
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile dev-db --profile worker config -q &&
    # Portas só em 127.0.0.1, sem 80/443, sem n8n, hardening presente.
    docker compose -f docker-compose.yml --profile worker config --format json \
      | "$(pick_python)" "$ROOT_DIR/scripts/check_compose_ports.py" &&
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile dev-db --profile worker config --format json \
      | "$(pick_python)" "$ROOT_DIR/scripts/check_compose_ports.py"
  ) || rc=1
  [ "$created" = 1 ] && rm -f "$ROOT_DIR/.env"
  return $rc
}
