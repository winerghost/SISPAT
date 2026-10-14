# syntax=docker/dockerfile:1
# =============================================================================
# SISPAT-AGU — backend/Dockerfile
# =============================================================================
# Imagem multi-stage da API Flask (também usada pelo serviço "worker").
#
# Endurecimento (ver docs/security/evidence/devsecops.md):
# - Imagem base fixada por DIGEST (atualizada pelo Dependabot, ecossistema
#   "docker"). Trocar o digest apenas via PR revisado.
# - Dependências instaladas a partir de requirements.lock com
#   --require-hashes e --only-binary (sem compiladores na imagem, sem
#   execução de setup.py de terceiros).
# - Nenhum segredo em ARG/ENV/camadas: credenciais entram só em runtime via
#   env_file/.env (docker-compose.yml). backend/.dockerignore exclui .env*,
#   chaves e testes do contexto de build.
# - Código pertence ao root e é somente-leitura para o usuário da aplicação
#   (uid 10001, sem shell de login); compatível com read_only: true.
# =============================================================================


# -----------------------------------------------------------------------------
# Stage 1: builder — cria o virtualenv com dependências verificadas por hash
# -----------------------------------------------------------------------------
FROM python:3.14-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /build
COPY requirements.lock requirements.txt ./
RUN pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: \
        -r requirements.lock

# -----------------------------------------------------------------------------
# Stage 2: dev — usado APENAS por docker-compose.dev.yml (hot-reload).
# Inclui ferramentas de teste (requirements-dev.txt). Nunca usar em produção.
# -----------------------------------------------------------------------------
FROM builder AS dev
COPY requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements-dev.txt \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
USER 10001:10001
EXPOSE 8000

# -----------------------------------------------------------------------------
# Stage 3: runtime — imagem final mínima, não-root, sem toolchain
# -----------------------------------------------------------------------------
FROM python:3.14-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS runtime

LABEL org.opencontainers.image.title="sispat-agu-backend" \
      org.opencontainers.image.description="SISPAT-AGU API Flask" \
      org.opencontainers.image.licenses="UNLICENSED"

# Usuário/grupo dedicados, sem home e sem shell de login.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    FLASK_ENV=production

WORKDIR /app

# Apenas o necessário para executar (testes/docs ficam fora — ver
# backend/.dockerignore). Arquivos pertencem ao root (somente leitura p/ app).
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini

USER 10001:10001

EXPOSE 8000

# GET /api/health existe (app/api/v1/health.py, rota legada sem /v1).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)"]

# --worker-tmp-dir /dev/shm: compatível com read_only: true no compose.
# --forwarded-allow-ips padrão (127.0.0.1); o ProxyFix do Flask usa
# TRUSTED_PROXY_IPS. Limites de linha/cabeçalho mitigam abusos de parsing.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "60", \
     "--worker-tmp-dir", "/dev/shm", "--limit-request-line", "8190", \
     "--limit-request-fields", "100", "--limit-request-field_size", "8190", \
     "--access-logfile", "-", "app:create_app()"]
