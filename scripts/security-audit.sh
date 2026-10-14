#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/security-audit.sh
# =============================================================================
# Auditoria estática local, NÃO destrutiva e sem tráfego para sistemas reais
# (Supabase, VPS, Google, n8n). Executa, quando disponíveis:
#   bandit (SAST Python) · pip-audit (SCA Python) · npm audit (SCA Node) ·
#   gitleaks (segredos, modo diretório) · semgrep (SAST multi-linguagem) ·
#   trivy fs/config (SCA + misconfig de Dockerfile/compose) ·
#   docker compose config (sintaxe + regras de portas/hardening).
# Relatórios em reports/security/<timestamp>/ (ignorado pelo git) — os
# relatórios do gitleaks são sempre REDIGIDOS (--redact).
#
# Ferramentas Python (bandit/pip-audit/semgrep) são instaladas num venv FORA
# do repositório ($SISPAT_TOOLS_HOME). gitleaks/trivy: use binários no PATH
# ou GITLEAKS_BIN / TRIVY_BIN. Ferramenta ausente => "NÃO EXECUTADO" (não
# conta como aprovado em --strict).
#
# Uso:
#   scripts/security-audit.sh             # tudo que estiver disponível
#   scripts/security-audit.sh --strict    # ferramenta ausente também falha
#   scripts/security-audit.sh --no-semgrep --no-install
# Saída: 0 = sem achados alto/crítico; 1 = achados; 2 = erro de execução.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

STRICT=0; RUN_SEMGREP=1; INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --no-semgrep) RUN_SEMGREP=0 ;;
    --no-install) INSTALL=0 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "Argumento desconhecido: $arg" ;;
  esac
done

BANDIT_VERSION="${BANDIT_VERSION:-1.9.4}"
PIP_AUDIT_VERSION="${PIP_AUDIT_VERSION:-2.10.1}"
SEMGREP_VERSION="${SEMGREP_VERSION:-1.180.0}"

OUT="$(report_dir security)"
declare -A RESULT
FAILED=0

record() {  # $1 = ferramenta, $2 = OK|ACHADOS|NAO_EXECUTADO, $3 = detalhe
  RESULT["$1"]="$2 $3"
  case "$2" in
    ACHADOS) FAILED=1 ;;
    NAO_EXECUTADO) [ "$STRICT" = 1 ] && FAILED=1 ;;
  esac
}

PY="$(pick_python)"
TOOLS_VENV="$(tools_home)/security-venv"
if [ "$INSTALL" = 1 ]; then
  [ -d "$TOOLS_VENV" ] || "$PY" -m venv "$(native_path "$TOOLS_VENV")" || die "falha ao criar venv de ferramentas"
  TPY="$(venv_bin "$TOOLS_VENV" python)"
  log "Instalando bandit/pip-audit no venv de ferramentas ($TOOLS_VENV)"
  "$TPY" -m pip install -q --disable-pip-version-check \
    "bandit==$BANDIT_VERSION" "pip-audit==$PIP_AUDIT_VERSION" || warn "instalação falhou"
  if [ "$RUN_SEMGREP" = 1 ] && ! "$TPY" -m pip show semgrep >/dev/null 2>&1; then
    "$TPY" -m pip install -q --disable-pip-version-check "semgrep==$SEMGREP_VERSION" \
      || warn "semgrep não instalável neste sistema"
  fi
elif [ -d "$TOOLS_VENV" ]; then
  TPY="$(venv_bin "$TOOLS_VENV" python)"   # reutiliza ferramentas já instaladas
else
  TPY="$PY"
fi

cd "$ROOT_DIR"

# --- bandit -----------------------------------------------------------------
log "bandit -r backend/app (falha em severidade MEDIUM+ com confiança MEDIUM+)"
if "$TPY" -m bandit --version >/dev/null 2>&1; then
  "$TPY" -m bandit -r backend/app -q -f json -o "$(native_path "$OUT/bandit.json")" >/dev/null 2>&1
  if "$TPY" -m bandit -r backend/app -q -ll -ii >/dev/null 2>&1; then
    record bandit OK "sem achados MEDIUM/HIGH"
  else
    "$TPY" -m bandit -r backend/app -q -ll -ii | tail -30
    record bandit ACHADOS "ver $OUT/bandit.json"
  fi
else
  record bandit NAO_EXECUTADO "bandit indisponível"
fi

# --- pip-audit --------------------------------------------------------------
log "pip-audit (backend/requirements.lock + requirements-dev.txt)"
if "$TPY" -m pip_audit --version >/dev/null 2>&1; then
  pa_rc=0
  "$TPY" -m pip_audit --progress-spinner off --no-deps --disable-pip \
    -r "$(native_path backend/requirements.lock)" -f json -o "$(native_path "$OUT/pip-audit-lock.json")" >/dev/null 2>&1 || pa_rc=1
  ( cd backend && "$TPY" -m pip_audit --progress-spinner off -r requirements-dev.txt \
      -f json -o "$(native_path "$OUT/pip-audit-dev.json")" >/dev/null 2>&1 ) || pa_rc=1
  if [ "$pa_rc" = 0 ]; then record pip-audit OK "sem vulnerabilidades conhecidas"
  else record pip-audit ACHADOS "ver $OUT/pip-audit-*.json"; fi
else
  record pip-audit NAO_EXECUTADO "pip-audit indisponível"
fi

# --- npm audit --------------------------------------------------------------
log "npm audit (frontend; produção bloqueia em high/critical)"
if have npm; then
  ( cd frontend && npm audit --json > "$OUT/npm-audit-all.json" 2>/dev/null ) || true
  if ( cd frontend && npm audit --omit=dev --audit-level=high > "$OUT/npm-audit-prod.txt" 2>&1 ); then
    record npm-audit OK "produção sem high/critical (devDeps: ver npm-audit-all.json)"
  else
    tail -15 "$OUT/npm-audit-prod.txt"
    record npm-audit ACHADOS "dependências de produção com high/critical"
  fi
else
  record npm-audit NAO_EXECUTADO "npm ausente"
fi

# --- gitleaks ---------------------------------------------------------------
log "gitleaks dir (redigido)"
GL="${GITLEAKS_BIN:-$(command -v gitleaks || true)}"
if [ -n "$GL" ]; then
  if "$GL" dir . --config .gitleaks.toml --redact --no-banner -f json \
       -r "$(native_path "$OUT/gitleaks.json")" >/dev/null 2>&1; then
    record gitleaks OK "nenhum segredo detectado"
  else
    record gitleaks ACHADOS "ver $OUT/gitleaks.json (redigido)"
  fi
else
  record gitleaks NAO_EXECUTADO "binário ausente (defina GITLEAKS_BIN)"
fi

# --- semgrep ----------------------------------------------------------------
SG="$(venv_bin "$TOOLS_VENV" semgrep)"
[ -f "$SG" ] || SG="$(command -v semgrep || true)"
if [ "$RUN_SEMGREP" = 1 ] && [ -n "$SG" ] && [ -f "$SG" -o -x "$SG" ]; then
  log "semgrep (p/python p/flask p/typescript p/react p/secrets p/dockerfile p/docker-compose)"
  export PYTHONUTF8=1 SEMGREP_SEND_METRICS=off
  # Falsos positivos TRIADOS (docs/security/evidence/devsecops.md, DSO-14):
  # logger-credential-disclosure em supabase_auth.py:263 registra só o NOME da
  # classe da exceção. Remover a exclusão quando o código receber "# nosemgrep".
  SEMGREP_EXCLUDES="--exclude-rule python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure"
  if "$SG" scan --metrics off --error --severity ERROR --severity WARNING \
       --config p/python --config p/flask --config p/typescript --config p/react \
       --config p/secrets --config p/dockerfile --config p/docker-compose        $SEMGREP_EXCLUDES \
       --json -o "$(native_path "$OUT/semgrep.json")" -q \
       backend/app frontend/src backend/Dockerfile frontend/Dockerfile \
       docker-compose.yml docker-compose.dev.yml >/dev/null 2>&1; then
    record semgrep OK "sem achados WARNING/ERROR"
  else
    record semgrep ACHADOS "ver $OUT/semgrep.json (triagem: .semgrepignore / nosemgrep justificado)"
  fi
else
  record semgrep NAO_EXECUTADO "semgrep indisponível ou desativado"
fi

# --- trivy ------------------------------------------------------------------
TV="${TRIVY_BIN:-$(command -v trivy || true)}"
if [ -n "$TV" ]; then
  log "trivy fs (vuln) + config (misconfig) — HIGH/CRITICAL"
  tv_rc=0
  "$TV" fs --quiet --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
     --skip-dirs node_modules --skip-dirs .next --skip-dirs docs \
     --format table -o "$(native_path "$OUT/trivy-fs.txt")" . || tv_rc=1
  "$TV" config --quiet --severity HIGH,CRITICAL --exit-code 1 \
     --skip-dirs node_modules --skip-dirs docs \
     --format table -o "$(native_path "$OUT/trivy-config.txt")" . || tv_rc=1
  if [ "$tv_rc" = 0 ]; then record trivy OK "fs/config sem HIGH/CRITICAL"
  else record trivy ACHADOS "ver $OUT/trivy-*.txt"; fi
else
  record trivy NAO_EXECUTADO "binário ausente (defina TRIVY_BIN); imagem exige daemon Docker"
fi

# --- docker compose config --------------------------------------------------
log "docker compose config (sintaxe + portas/hardening)"
compose_config_check; cc=$?
case "$cc" in
  0) record compose OK "válido; portas só em 127.0.0.1; sem n8n" ;;
  3) record compose NAO_EXECUTADO "docker CLI ausente" ;;
  *) record compose ACHADOS "config inválida ou regra violada" ;;
esac

# --- resumo -----------------------------------------------------------------
log "Resumo (relatórios em $OUT)"
{
  for k in bandit pip-audit npm-audit gitleaks semgrep trivy compose; do
    printf '%-10s %s\n' "$k" "${RESULT[$k]:-NAO_EXECUTADO}"
  done
} | tee "$OUT/summary.txt"
exit "$FAILED"
