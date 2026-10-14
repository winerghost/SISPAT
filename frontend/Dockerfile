# syntax=docker/dockerfile:1
# =============================================================================
# SISPAT-AGU — frontend/Dockerfile
# =============================================================================
# Multi-stage: deps -> build -> runtime (Next.js "standalone"), não-root.
#
# Endurecimento (ver docs/security/evidence/devsecops.md):
# - Node 24 LTS (Node 20 atingiu EOL em 2026-04) fixado por DIGEST
#   (atualizado pelo Dependabot, ecossistema "docker").
# - npm ci a partir do package-lock.json (instalação reprodutível).
# - SEM segredos no build: apenas variáveis NEXT_PUBLIC_* (públicas por
#   definição — são embutidas no bundle do navegador) entram como ARG.
#   NUNCA passar SUPABASE_SERVICE_ROLE_KEY, N8N_*, SECRET_KEY etc. aqui.
# - frontend/.dockerignore impede que .env* entre no contexto (o next build
#   copiaria .env para .next/standalone).
# =============================================================================


# -----------------------------------------------------------------------------
# Stage 1: deps — instala dependências a partir do lockfile
# -----------------------------------------------------------------------------
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: build — compila a aplicação Next.js (output: "standalone")
# -----------------------------------------------------------------------------
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Somente valores PÚBLICOS (embutidos no bundle do navegador).
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: runtime — imagem final mínima, não-root
# -----------------------------------------------------------------------------
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="sispat-agu-frontend" \
      org.opencontainers.image.description="SISPAT-AGU frontend Next.js" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 10001 nextjs \
    && adduser -S -D -H -u 10001 -G nextjs -s /sbin/nologin nextjs \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
              /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /opt/yarn* \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Artefatos pertencem ao root (somente leitura para o processo); apenas o
# cache do Next (.next/cache) precisa ser gravável — tmpfs no compose.
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p .next/cache && chown 10001:10001 .next/cache

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
