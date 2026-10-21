#!/usr/bin/env bash
# =============================================================================
# SISPAT-AGU — scripts/security-scan-docker.sh
# =============================================================================
# gitleaks + trivy via IMAGENS DOCKER OFICIAIS (versão fixa), para rodar NA VPS
# sem instalar binários. Complementa scripts/security-audit.sh (que espera
# gitleaks/trivy no PATH). Doc: docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md.
#
# Garantias:
# - Repositório montado SOMENTE LEITURA (:ro). Nada é alterado.
# - gitleaks roda com --network none e --redact (relatório sem o segredo).
# - trivy baixa SÓ a base de vulnerabilidades (download; nada é enviado) e
#   depois varre com --network none. Imagens são lidas de um "docker save"
#   (sem montar /var/run/docker.sock no container do trivy).
# - Contêineres com o seu UID, --cap-drop ALL e no-new-privileges.
# - Relatórios em $OUT_DIR (padrão: ~/sispat-security-scans/<UTC>, chmod 700),
#   FORA do repositório.
#
# Uso (na raiz do projeto, ex. /opt/SISPAT):
#   bash scripts/security-scan-docker.sh                 # tudo
#   bash scripts/security-scan-docker.sh --no-images     # sem trivy image
#   bash scripts/security-scan-docker.sh --no-gitleaks   # só trivy
#   bash scripts/security-scan-docker.sh --no-trivy      # só gitleaks
#   bash scripts/security-scan-docker.sh --offline       # não baixa a base (usa o cache)
# Variáveis: GITLEAKS_IMAGE, TRIVY_IMAGE, SCAN_IMAGES, OUT_DIR, TRIVY_CACHE.
# Saída: 0 = sem achados; 1 = achados (ver relatórios); 2 = erro de execução.
# =============================================================================
set -uo pipefail
# shellcheck source=scripts/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

RUN_GITLEAKS=1; RUN_TRIVY=1; RUN_IMAGES=1; OFFLINE=0
for arg in "$@"; do
  case "$arg" in
    --no-gitleaks) RUN_GITLEAKS=0 ;;
    --no-trivy) RUN_TRIVY=0 ;;
    --no-images) RUN_IMAGES=0 ;;
    --offline) OFFLINE=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "Argumento desconhecido: $arg" ;;
  esac
done

have docker || die "docker não encontrado."

# Versões FIXAS. Para atualizar: confira a release oficial e troque aqui (ou
# exporte a variável). Para fixar por digest: docker pull <img> e depois
# docker inspect --format '{{index .RepoDigests 0}}' <img>.
GITLEAKS_IMAGE="${GITLEAKS_IMAGE:-zricethebat/gitleaks:v8.28.0}"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.65.0}"
SCAN_IMAGES="${SCAN_IMAGES:-sispat-agu/backend:latest sispat-agu/frontend:latest}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-$HOME/sispat-security-scans/$TS}"
TRIVY_CACHE="${TRIVY_CACHE:-$HOME/.cache/sispat-trivy}"
umask 077
mkdir -p "$OUT_DIR" "$TRIVY_CACHE" || die "não foi possível criar $OUT_DIR"
chmod 700 "$OUT_DIR"

UIDGID="$(id -u):$(id -g)"
HARDEN=(--rm --user "$UIDGID" --cap-drop ALL --security-opt no-new-privileges:true -e HOME=/tmp)

declare -A RESULT
FAILED=0
record() {  # $1 ferramenta, $2 OK|ACHADOS|ERRO|NAO_EXECUTADO, $3 detalhe
  RESULT["$1"]="$2 $3"
  case "$2" in ACHADOS) [ "$FAILED" = 2 ] || FAILED=1 ;; ERRO) FAILED=2 ;; esac
}

# Lista os arquivos citados num relatório JSON do gitleaks (sem jq).
leak_files() { grep -o '"File": *"[^"]*"' "$1" 2>/dev/null | sed 's/.*: *"//; s/"$//' | sort | uniq -c; }

# --- gitleaks ---------------------------------------------------------------
if [ "$RUN_GITLEAKS" = 1 ]; then
  log "gitleaks git (histórico versionado, redigido) — $GITLEAKS_IMAGE"
  if [ -d "$ROOT_DIR/.git" ]; then
    # safe.directory: o dono do repositório difere do UID do contêiner.
    docker run "${HARDEN[@]}" --network none \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -v "$ROOT_DIR:/repo:ro" -v "$OUT_DIR:/out" \
      "$GITLEAKS_IMAGE" git /repo --config /repo/.gitleaks.toml --redact --no-banner \
      -f json -r /out/gitleaks-git.json
    rc=$?
    case "$rc" in
      0) record gitleaks-git OK "histórico sem segredos" ;;
      1) leak_files "$OUT_DIR/gitleaks-git.json"; record gitleaks-git ACHADOS "ver $OUT_DIR/gitleaks-git.json" ;;
      *) record gitleaks-git ERRO "código $rc (imagem/flags?)" ;;
    esac
  else
    record gitleaks-git NAO_EXECUTADO "sem .git em $ROOT_DIR"
  fi

  log "gitleaks dir (arquivos no disco, redigido)"
  docker run "${HARDEN[@]}" --network none \
    -v "$ROOT_DIR:/repo:ro" -v "$OUT_DIR:/out" \
    "$GITLEAKS_IMAGE" dir /repo --config /repo/.gitleaks.toml --redact --no-banner \
    -f json -r /out/gitleaks-dir.json
  rc=$?
  case "$rc" in
    0) record gitleaks-dir OK "nenhum segredo no disco" ;;
    1) info "Arquivos com achados (esperado: só .env e secrets/, que NÃO são versionados):"
       leak_files "$OUT_DIR/gitleaks-dir.json"
       record gitleaks-dir ACHADOS "conferir a lista acima; ver $OUT_DIR/gitleaks-dir.json" ;;
    *) record gitleaks-dir ERRO "código $rc" ;;
  esac
else
  record gitleaks-git NAO_EXECUTADO "desativado"; record gitleaks-dir NAO_EXECUTADO "desativado"
fi

# --- trivy ------------------------------------------------------------------
if [ "$RUN_TRIVY" = 1 ]; then
  TV=(docker run "${HARDEN[@]}" -v "$TRIVY_CACHE:/cache" -e TRIVY_CACHE_DIR=/cache)
  TV_OFF=(--skip-db-update --skip-java-db-update --offline-scan)

  if [ "$OFFLINE" = 0 ]; then
    log "trivy: baixando a base de vulnerabilidades (só download) — $TRIVY_IMAGE"
    "${TV[@]}" "$TRIVY_IMAGE" image --download-db-only --quiet \
      || { record trivy-db ERRO "falha ao baixar a base"; }
  fi

  log "trivy fs (dependências: requirements.lock, package-lock.json) — HIGH/CRITICAL"
  # Mesmos filtros de scripts/security-audit.sh (alvo "." dentro de /repo).
  "${TV[@]}" --network none -v "$ROOT_DIR:/repo:ro" -v "$OUT_DIR:/out" -w /repo "$TRIVY_IMAGE" \
    fs --quiet "${TV_OFF[@]}" --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
    --skip-dirs node_modules --skip-dirs .next --skip-dirs docs --skip-dirs reports \
    --format table -o /out/trivy-fs.txt .
  rc=$?
  case "$rc" in 0) record trivy-fs OK "sem HIGH/CRITICAL" ;;
    1) record trivy-fs ACHADOS "ver $OUT_DIR/trivy-fs.txt" ;; *) record trivy-fs ERRO "código $rc" ;; esac

  log "trivy config (Dockerfile/compose) — HIGH/CRITICAL"
  "${TV[@]}" --network none -v "$ROOT_DIR:/repo:ro" -v "$OUT_DIR:/out" -w /repo "$TRIVY_IMAGE" \
    config --quiet --skip-check-update --severity HIGH,CRITICAL --exit-code 1 \
    --skip-dirs node_modules --skip-dirs docs \
    --format table -o /out/trivy-config.txt .
  rc=$?
  case "$rc" in 0) record trivy-config OK "sem HIGH/CRITICAL" ;;
    1) record trivy-config ACHADOS "ver $OUT_DIR/trivy-config.txt" ;; *) record trivy-config ERRO "código $rc" ;; esac

  if [ "$RUN_IMAGES" = 1 ]; then
    TMP_TAR="$(mktemp -d "${TMPDIR:-/tmp}/sispat-trivy.XXXXXX")" || die "mktemp falhou"
    trap 'rm -rf "$TMP_TAR"' EXIT
    for img in $SCAN_IMAGES; do
      name="$(printf '%s' "$img" | tr '/:@' '___')"
      log "trivy image $img (vuln + segredos embutidos) — HIGH/CRITICAL"
      if ! docker image inspect "$img" >/dev/null 2>&1; then
        record "img:$img" NAO_EXECUTADO "imagem não existe localmente (faça o build)"; continue
      fi
      docker save "$img" -o "$TMP_TAR/$name.tar" || { record "img:$img" ERRO "docker save falhou"; continue; }
      chmod 0644 "$TMP_TAR/$name.tar"
      "${TV[@]}" --network none -v "$TMP_TAR:/in:ro" -v "$OUT_DIR:/out" "$TRIVY_IMAGE" \
        image --quiet "${TV_OFF[@]}" --input "/in/$name.tar" --scanners vuln,secret \
        --severity HIGH,CRITICAL --exit-code 1 --format table -o "/out/trivy-image-$name.txt"
      rc=$?
      rm -f "$TMP_TAR/$name.tar"
      case "$rc" in 0) record "img:$img" OK "sem HIGH/CRITICAL" ;;
        1) record "img:$img" ACHADOS "ver $OUT_DIR/trivy-image-$name.txt" ;; *) record "img:$img" ERRO "código $rc" ;; esac
    done
  fi
else
  record trivy NAO_EXECUTADO "desativado"
fi

# --- resumo -----------------------------------------------------------------
log "Resumo (relatórios em $OUT_DIR)"
{
  for k in $(printf '%s\n' "${!RESULT[@]}" | sort); do
    printf '%-40s %s\n' "$k" "${RESULT[$k]}"
  done
} | tee "$OUT_DIR/summary.txt"
exit "$FAILED"
