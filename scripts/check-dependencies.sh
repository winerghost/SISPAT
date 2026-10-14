#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/check-dependencies.sh
# =============================================================================
# Verificação de cadeia de suprimentos (OWASP A03:2025):
#   1. backend/requirements*.txt usam somente versões fixadas (==);
#   2. pip-audit em requirements.lock (com hashes) e requirements-dev.txt;
#   3. lockfile coerente com requirements.txt (regenera em temp e compara);
#   4. npm audit (produção: falha em high/critical; completo: informativo);
#   5. pacotes desatualizados (informativo).
# Ferramentas são instaladas num venv FORA do repositório (SISPAT_TOOLS_HOME).
#
# Uso:
#   scripts/check-dependencies.sh           # verifica
#   scripts/check-dependencies.sh --lock    # REGENERA backend/requirements.lock
#   scripts/check-dependencies.sh --strict-dev  # npm audit completo também bloqueia
# Saída: 0 = sem achados bloqueantes; 1 = achados; 2 = erro de execução.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

DO_LOCK=0; STRICT_DEV=0
for arg in "$@"; do
  case "$arg" in
    --lock) DO_LOCK=1 ;;
    --strict-dev) STRICT_DEV=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "Argumento desconhecido: $arg" ;;
  esac
done

# Versões das ferramentas fixadas (atualizar via PR).
PIP_AUDIT_VERSION="${PIP_AUDIT_VERSION:-2.10.1}"
UV_VERSION="${UV_VERSION:-0.12.20}"

PY="$(pick_python)"
TOOLS_VENV="$(tools_home)/deps-venv"
[ -d "$TOOLS_VENV" ] || "$PY" -m venv "$(native_path "$TOOLS_VENV")" || die "falha ao criar venv"
TPY="$(venv_bin "$TOOLS_VENV" python)"
"$TPY" -m pip install -q --disable-pip-version-check \
  "pip-audit==$PIP_AUDIT_VERSION" "uv==$UV_VERSION" || die "falha ao instalar pip-audit/uv"

BACKEND="$ROOT_DIR/backend"
LOCK="$BACKEND/requirements.lock"
FAILED=0

compile_lock() {  # $1 = arquivo de saída
  ( cd "$BACKEND" && "$TPY" -m uv pip compile requirements.txt \
      --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
      --generate-hashes --no-header --quiet -o "$(native_path "$1")" )
}

if [ "$DO_LOCK" = 1 ]; then
  log "Regenerando backend/requirements.lock (Linux x86_64, Python 3.12)"
  tmp="$(mktemp)"
  compile_lock "$tmp" || die "uv pip compile falhou"
  {
    printf '# SISPAT-AGU - lockfile com hashes (GERADO - nao editar a mao).\n'
    printf '# Alvo: imagem Docker (Linux x86_64, Python 3.12). Regenerar com:\n'
    printf '#   scripts/check-dependencies.sh --lock\n'
    printf '# Instalar: pip install --no-deps --require-hashes -r requirements.lock\n'
    cat "$tmp"
  } > "$LOCK"
  rm -f "$tmp"
  info "Atualizado: backend/requirements.lock"
fi

log "1/5 Versões fixadas em backend/requirements*.txt"
unpinned="$(grep -hvE '^\s*(#|$|-r )' "$BACKEND/requirements.txt" "$BACKEND/requirements-dev.txt" \
            | sed 's/#.*//' | grep -vE '^[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,-]+\])?==[0-9][^[:space:]]*[[:space:]]*$' || true)"
if [ -n "$unpinned" ]; then
  fail "Dependências sem pin exato (==):"; printf '      %s\n' $unpinned; FAILED=1
else
  info "OK — todas as dependências diretas usam =="
fi

log "2/5 pip-audit (requirements.lock com hashes + requirements-dev.txt)"
"$TPY" -m pip_audit --progress-spinner off --no-deps --disable-pip -r "$(native_path "$LOCK")" || FAILED=1
( cd "$BACKEND" && "$TPY" -m pip_audit --progress-spinner off -r requirements-dev.txt ) || FAILED=1

log "3/5 Lockfile coerente com requirements.txt"
tmp="$(mktemp)"
if compile_lock "$tmp"; then
  if diff -q <(grep -E '^[a-z0-9]' "$LOCK" | sort) <(grep -E '^[a-z0-9]' "$tmp" | sort) >/dev/null; then
    info "OK — requirements.lock atualizado"
  else
    fail "requirements.lock desatualizado (rode: scripts/check-dependencies.sh --lock)"
    diff <(grep -E '^[a-z0-9]' "$LOCK" | sort) <(grep -E '^[a-z0-9]' "$tmp" | sort) | head -20
    FAILED=1
  fi
else
  warn "uv pip compile falhou (sem rede?) — verificação de lock não executada"
fi
rm -f "$tmp"

log "4/5 npm audit (frontend)"
if have npm; then
  ( cd "$ROOT_DIR/frontend" && npm audit --omit=dev --audit-level=high ) || { fail "npm audit (produção) com high/critical"; FAILED=1; }
  if ( cd "$ROOT_DIR/frontend" && npm audit --audit-level=high >/dev/null ); then
    info "npm audit completo: sem high/critical"
  else
    if [ "$STRICT_DEV" = 1 ]; then fail "npm audit completo (dev) com high/critical"; FAILED=1
    else warn "npm audit completo (devDependencies) com high/critical — ver docs/security/evidence/devsecops.md (aceito/residual)"; fi
  fi
else
  warn "npm ausente — npm audit não executado"
fi

log "5/5 Pacotes desatualizados (informativo)"
( cd "$ROOT_DIR/frontend" && npm outdated 2>/dev/null ) || true

[ "$FAILED" = 0 ] && log "Dependências: OK" || log "Dependências: ACHADOS (ver acima)"
exit "$FAILED"
