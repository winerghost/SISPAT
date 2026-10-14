# Checklist de deploy — VPS Hostinger + CloudPanel + Cloudflare

Atualizado em 2026-10-14. Complementa `hostinger-cloudpanel-cloudflare.md`; em caso de
conflito (ex.: ordem de migrações), **este checklist prevalece**. Nenhum valor real de
segredo deve ser escrito aqui, em tickets ou em chats.

> Nada neste checklist autoriza, por si só, um deploy ou uma migração em produção:
> ambos exigem autorização explícita do responsável pelo sistema.

## 0. Pré-requisitos

- [ ] Autorização explícita para o deploy **e**, separadamente, para cada migração.
- [ ] VPS com Docker Engine e Docker Compose v2.24+ (`docker compose version`).
- [ ] Site no CloudPanel com proxy reverso para `127.0.0.1:<FRONTEND_PORT>` (raiz) e
      `127.0.0.1:<BACKEND_PORT>` (`/api/`), a partir de `infra/cloudpanel/vhost.conf.example`.
      As linhas `set_real_ip_from` precisam ter **todas** as faixas IPv4/IPv6 atuais da
      Cloudflare (https://www.cloudflare.com/ips/). Rode `nginx -t` antes de recarregar.
- [ ] Cloudflare: proxy ligado ("nuvem laranja"), SSL/TLS **Full (Strict)**, redirecionamento
      HTTP→HTTPS. Nunca use o modo "Flexible".
- [ ] Firewall da VPS: 22 (restrito por IP), 80 e 443 abertos, de preferência só para as faixas
      da Cloudflare. Nenhuma porta de aplicação (8000/3000/6379) aberta externamente.
- [ ] Supabase: confirme no painel o algoritmo de assinatura dos JWT (HS256 legado ou chaves
      assimétricas ES256/JWKS) e que a versão do backend a implantar suporta esse modo.
- [ ] Supabase Auth: Site URL e Redirect URLs com `https://<dominio>/ativar-conta`; expiração do
      JWT curta (ex.: 15 min a 1 h); MFA TOTP habilitado; política de senha forte.
- [ ] Primeiro ADM já criado (bootstrap descrito no `README.md`) com unidades vinculadas.

## 1. Antes do `git push` (máquina local)

- [ ] Todo o código que deve ir para produção está **commitado** (`git status` limpo). O deploy
      leva somente o que estiver no commit.
- [ ] `cd backend && python -m pytest -q`: sem falhas (xfail documentados são aceitos).
- [ ] `cd frontend && npm run lint && npm run typecheck && npm run build`, e a suíte Playwright.
- [ ] `bash scripts/security-audit.sh --strict`: revise cada ferramenta. O gitleaks em modo
      diretório acusa o `.env` local, que não é versionado; confirme com `gitleaks git` que o
      histórico está limpo.
- [ ] `git ls-files` não lista `.env`, chaves, credenciais nem arquivos que o `.gitignore`
      declara como locais (relatórios de segurança, `CLAUDE.md`, `DESIGN.md`, `.claude/`).
      Se aparecer algum, rode `git rm --cached <arquivo>` antes do push.

## 2. `.env` na VPS (raiz do projeto, `chmod 600`, nunca versionado)

Crie o arquivo a partir do `.env.example` e preencha **na VPS**. Não copie o `.env` de
desenvolvimento. O Compose lê este arquivo para o backend e o worker (`env_file`) e também
para interpolar os build args do frontend.

Como gerar valores fortes (na VPS): `openssl rand -hex 32` (64 caracteres hexadecimais).
Use hex nas senhas que entram em URLs (ex.: Redis), para não precisar escapar caracteres.

| Variável | Obrigatória | Valor / como obter |
|---|---|---|
| `FLASK_ENV` | sim | `production` (ativa a validação de segredos) |
| `SECRET_KEY` | sim | `openssl rand -hex 32` (≥ 32 caracteres) |
| `DATABASE_URL` | sim | connection string do Supabase de produção; o backend força TLS em hosts Supabase |
| `SUPABASE_URL` | sim | `https://<project-ref>.supabase.co` (também deriva o `iss` esperado e o JWKS) |
| `SUPABASE_SERVICE_ROLE_KEY` | sim (convites/MFA) | painel do Supabase; **só no backend** |
| `SUPABASE_JWT_SECRET` | se HS256 | painel do Supabase (≥ 32 caracteres); está comentada no `.env.example`, descomente |
| `SUPABASE_JWT_ALGORITHMS` | se a versão suportar | `HS256`, `ES256` ou ambos, conforme o painel |
| `SUPABASE_JWT_AUDIENCE` / `SUPABASE_JWT_ISSUER` | não | padrão `authenticated` / derivado de `SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | sim | chave pública (anon/publishable) |
| `INVITE_ALLOWED_REDIRECT_URLS` | sim | `https://<dominio>/ativar-conta` (a primeira URL é a de ativação) |
| `CORS_ALLOWED_ORIGINS` | sim | `https://<dominio>` (sem `localhost` em produção) |
| `TRUSTED_PROXY_IPS` | sim | `127.0.0.1` (documental; o Nginx do CloudPanel é o único hop) |
| `REDIS_PASSWORD` | sim | `openssl rand -hex 32` |
| `REDIS_URL` | sim | `redis://:<REDIS_PASSWORD>@redis:6379/0` (host `redis`, não `localhost`) |
| `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` | não | padrão = `REDIS_URL` |
| `NEXT_PUBLIC_API_URL` | sim (build) | `https://<dominio>/api` |
| `NEXT_PUBLIC_SUPABASE_URL` | sim (build) | igual a `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sim (build) | igual a `SUPABASE_ANON_KEY` (nunca a service role) |
| `BACKEND_PORT` / `FRONTEND_PORT` | não | `8000` / `3000`, as mesmas do vhost |
| `TZ` | não | `America/Araguaina` |
| `MAX_CONTENT_LENGTH_BYTES`, `JWT_LEEWAY_SECONDS` | não | padrões `1048576` / `30` |
| `DB_SSLMODE`, `DB_SSLROOTCERT` | recomendado | `verify-full` + caminho da CA, **somente** se o arquivo for montado no container |
| `DB_STATEMENT_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT`, `DB_POOL_*` | não | ajuste fino do pool |
| `GOOGLE_SHEETS_CREDENTIALS_JSON`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_SHEET_NAME`/`_GID` | para importação | o arquivo de credenciais precisa ser montado no container (somente leitura); sem isso a importação fica indisponível |
| `N8N_INTEGRATION_ENABLED` (+ `N8N_*`) | não | `false` até haver n8n externo com HTTPS |
| `AI_ENABLED` (+ `*_API_KEY`, `AI_*`) | não | `false` por padrão; chaves só no backend |
| `*_CPUS`, `*_MEMORY` | não | limites por serviço; não use valores de dev |

Notas:
- As `NEXT_PUBLIC_*` são embutidas no bundle **no build**. Se mudarem, refaça o build do
  frontend (`docker compose up -d --build frontend`). Se ficarem vazias, o login não funciona.
- Se faltar `REDIS_PASSWORD`, o Compose recusa subir. Se `SUPABASE_JWT_SECRET`/JWKS estiverem
  errados, a API sobe mas responde 401 a todos.

## 3. Banco de dados: migrações (somente com autorização)

Estado documentado (README.md): Alembic em `0004_db_security_hardening`, com
`0005_settings_ai_users` **pendente**. O backend atual depende das colunas e tabelas da 0005.
**Aplique a 0005 ANTES de subir a imagem nova do backend.** A 0005 é aditiva, e o backend
antigo continua funcionando com ela.

1. [ ] Teste num **branch do Supabase** (nunca direto em produção):
   - `alembic current` → esperado `0004_db_security_hardening`.
     - Se não existir `alembic_version`: `alembic stamp 0001_initial_schema` e depois
       `alembic upgrade 0004_db_security_hardening` na **mesma janela** (nunca 0002/0003 sem a
       0004).
   - Seeds SQL: confirme se `backend/migrations/sql/0005_seed_security_permissions.sql` já foi
     aplicado (existem as permissões `users.invite` e `users.revoke_access`). Esse seed não tem
     equivalente Alembic.
   - `alembic upgrade 0005_settings_ai_users`.
   - Verifique: colunas `version`, `sessions_revoked_at`, `avatar_object_key`,
     `deactivated_at`, `deactivated_by` em `public.users`; tabelas `ai_settings` (1 linha,
     desligada) e `user_preferences` com RLS habilitado e sem privilégios para
     `anon`/`authenticated`; `alembic current` = `0005_settings_ai_users`.
   - Suba a versão nova contra o branch e faça login real com MFA.
2. [ ] Com nova autorização, repita o passo 1 em produção. Na VPS, use a própria imagem:
   `docker compose run --rm --no-deps backend alembic current` e depois
   `docker compose run --rm --no-deps backend alembic upgrade 0005_settings_ai_users`.
   Para isso, a imagem precisa ter sido construída (`docker compose build backend`) sem
   recriar o container em execução.
3. [ ] Registre data, autorizador e resultado em `docs/database/historico-migracoes.md`.

## 4. Subida

```bash
cd <diretorio-do-projeto>
git pull --ff-only
ls docker-compose.override.yml compose.override.yml 2>/dev/null   # deve não existir
docker compose config --quiet            # valida (não imprime o .env)
docker compose config --services         # redis, backend, frontend
# guarde as imagens atuais para rollback (se existirem)
docker tag sispat-agu/backend:latest  sispat-agu/backend:rollback  2>/dev/null || true
docker tag sispat-agu/frontend:latest sispat-agu/frontend:rollback 2>/dev/null || true
docker compose up -d --build
```

- Worker Celery (opcional; hoje só há a tarefa de IA). O `up -d` simples **não** o sobe:
  `docker compose --profile worker up -d --build worker`.
- Nunca use `docker-compose.dev.yml` na VPS.

## 5. Verificação pós-subida

Na VPS:
- [ ] `docker compose ps`: `backend`, `frontend` e `redis` em `healthy`.
- [ ] `curl -fsS http://127.0.0.1:${BACKEND_PORT:-8000}/api/health` → `{"status":"ok"}`.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:${BACKEND_PORT:-8000}/api/v1/me` → `401`.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer x' http://127.0.0.1:${BACKEND_PORT:-8000}/api/v1/users` → `401`.
- [ ] `ss -ltnp | grep -E ':(8000|3000|6379)\b'` → só `127.0.0.1` (Redis não aparece).

Pelo domínio (outra máquina):
- [ ] `curl -sI https://<dominio>/login` → 200 com `Content-Security-Policy` (com `nonce-`),
      `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` e `X-Frame-Options`.
- [ ] `curl -s https://<dominio>/api/v1/me` → 401 JSON `unauthorized`.
- [ ] `curl -sI https://<dominio>/.env` → 404.
- [ ] Login real: USER sem MFA chega à home; ADM é levado ao desafio TOTP, e as páginas de
      administração só funcionam após o MFA. Logout volta ao `/login`.

Logs (sem segredos):
- [ ] `docker compose logs --since 15m backend frontend | grep -iE 'eyJ|service_role|secret|password|Bearer '`
      → nenhuma linha com valor sensível.
- [ ] `docker compose logs --since 15m backend | grep -E ' 500 |internal_error'` → vazio após o
      login de teste. Um 500 logo no login indica schema desatualizado: volte ao passo 3.
- [ ] O IP registrado nos eventos de auditoria é o do cliente, não o da Cloudflare.

## 6. Rollback

1. Código/imagens: `docker tag sispat-agu/backend:rollback sispat-agu/backend:latest` (idem
   frontend) e `docker compose up -d --no-build`. Também é possível `git checkout <commit
   anterior>` + `docker compose up -d --build`.
2. Banco: **não** faça `alembic downgrade` sem autorização e análise de impacto. A 0005 é
   aditiva e compatível com o backend anterior, então em geral basta reverter as imagens.
3. Configuração: mantenha uma cópia do `.env` anterior fora do repositório (`chmod 600`).
4. Após o rollback, repita a seção 5 e registre o incidente.
