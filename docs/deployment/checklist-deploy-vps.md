# Checklist de deploy — VPS Hostinger + CloudPanel + Cloudflare

Atualizado em 2026-10-19. CHECKLIST CANÔNICO (substitui `docs/deploy/CHECKLIST.md`, cujo
conteúdo virou os anexos ao final). Roteiro operacional do domínio:
`docs/deploy/ROTEIRO_VPS_ueato.md`. Complementa `hostinger-cloudpanel-cloudflare.md`; em caso de
conflito (ex.: ordem de migrações), **este checklist prevalece**. Nenhum valor real de
segredo deve ser escrito aqui, em tickets ou em chats.

> Nada neste checklist autoriza, por si só, um deploy ou uma migração em produção:
> ambos exigem autorização explícita do responsável pelo sistema.

> **Pendências pós-implantação de 2026-10-20** (Supabase Auth, gitleaks/trivy na VPS,
> limite de 100 s da Cloudflare, worker Celery, `set_real_ip_from` global do CloudPanel,
> expurgo de `import_previews`): passo a passo em
> [`docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md`](../deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md).
> Varredura na VPS sem instalar binários: `bash scripts/security-scan-docker.sh`.

## 0. Pré-requisitos

- [ ] Autorização explícita para o deploy **e**, separadamente, para cada migração.
- [ ] VPS com Docker Engine e Docker Compose v2.24+ (`docker compose version`).
- [ ] Site no CloudPanel com proxy reverso para `127.0.0.1:<FRONTEND_PORT>` (raiz) e
      `127.0.0.1:<BACKEND_PORT>` (`/api/`), a partir de `infra/cloudpanel/vhost.conf.example`.
      As linhas `set_real_ip_from` precisam ter **todas** as faixas IPv4/IPv6 atuais da
      Cloudflare (https://www.cloudflare.com/ips/). Rode `nginx -t` antes de recarregar.
- [ ] Cloudflare: proxy ligado ("nuvem laranja"), SSL/TLS **Full (Strict)**, redirecionamento
      HTTP→HTTPS. Nunca use o modo "Flexible".
- [ ] Firewall da VPS: 22 (restrito por IP); 80 e 443 SOMENTE para as faixas da Cloudflare.
      8000/3000/6379 fechadas por fora, com TESTE EXTERNO (de outra máquina, `curl -m 5` ao IP).
- [ ] Certificado de origem para Full (Strict): Cloudflare Origin Certificate ou Let's Encrypt
      DNS-01 (HTTP-01 não funciona com o DNS proxied). "Always Use HTTPS" ligado; HSTS da
      Cloudflare desligado (o origin já emite; evita cabeçalho duplicado).
- [ ] Repositório privado: deploy key SOMENTE LEITURA na VPS.
- [ ] Decisão do worker registrada: `--profile worker` (subir) ou não subir.
- [ ] Risco M1 decidido (seção 4A).
- [ ] Supabase Auth: remover Redirect URLs `http://localhost...` quando o dev local não precisar.
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
- [ ] `gitleaks git` ANTES do push: histórico sem segredos.
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
| `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH` | para importação | caminho no HOST do JSON da service account, **fora do repositório**; o Compose o monta como secret somente leitura em `/run/secrets/google_sheets_credentials.json` (e já sobrepõe `GOOGLE_SHEETS_CREDENTIALS_JSON` no container). Sem o arquivo, `docker compose up` falha |
| `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_SHEET_NAME`/`_GID` (+ `_UNITS_`, `_ROOMS_`, `_PEOPLE_`) | para importação | identificam a planilha/abas de origem (nome OU gid) |
| `N8N_INTEGRATION_ENABLED` (+ `N8N_*`) | não | `false` até haver n8n externo com HTTPS |
| `AI_ENABLED` (+ `*_API_KEY`, `AI_*`) | não | `false` por padrão; chaves só no backend |
| `*_CPUS`, `*_MEMORY` | não | limites por serviço; não use valores de dev |

Notas:
- Placeholders: `grep -nE '^[^#]*<' .env` deve voltar VAZIA (ignora comentários); troque também
  `DATABASE_URL` e `NEXT_PUBLIC_API_URL` ilustrativos do `.env.example` (esta fica no bundle); `REDIS_URL` e
  `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH` vêm comentadas no `.env.example` (descomente com valor real).
- As `NEXT_PUBLIC_*` são embutidas no bundle **no build**. Se mudarem, refaça o build do
  frontend (`docker compose up -d --build frontend`). Se ficarem vazias, o login não funciona.
- Se faltar `REDIS_PASSWORD`, o Compose recusa subir. Se `SUPABASE_JWT_SECRET`/JWKS estiverem
  errados, a API sobe mas responde 401 a todos.
- Credencial do Google Sheets (service account):
  1. Guarde o JSON **fora do repositório** (ex.: `/etc/sispat-agu/google_sheets_credentials.json`)
     e aponte `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH` para ele no `.env`.
  2. Permissão `chmod 0400` e dono = UID do usuário do container (`chown 10001 <arquivo>`; confirme
     com `docker compose run --rm --entrypoint id backend`). O Compose (sem Swarm) ignora
     `uid/mode` do secret: valem as permissões do arquivo no host.
  3. Após a **importação inicial**, apague a chave (`shred -u` no arquivo, remova a variável do
     `.env`, delete a chave da service account no console do Google Cloud) e **reative** a
     política `iam.disableServiceAccountKeyCreation`.

## 3. Banco de dados: carimbo Alembic (sem upgrade)

Estado (docs/deploy/PRONTIDAO_2026-10-19.md): o repositório tem Alembic 0001 a 0010 e o
Supabase JÁ contém o conteúdo das migrações 0007-0010 (numeração dos `.sql` difere da do
Alembic; compare por conteúdo). O `alembic_version` do banco está em `0006`. Procedimento:
**`alembic stamp 0011_dashboard_charts_prefs`; nenhum `alembic upgrade`.**

1. [ ] Backup/PITR do Supabase CONFIRMADO no painel (data/hora registradas) ANTES do stamp.
2. [ ] Esquema real conferido contra 0007-0010 (`unit_aliases` e índices, `ai_settings`,
   `user_preferences`, colunas em `users`, permissões, RLS sem privilégios a anon/authenticated);
   resultado registrado. Se divergir, NÃO carimbe.
3. [ ] Autorização explícita + janela combinada (base única: dev = prod).
4. [ ] `docker compose run --rm --no-deps backend alembic current` (esperado `0006...`), depois
   `... alembic stamp 0011_dashboard_charts_prefs`, depois `alembic current`
   (esperado `0011_dashboard_charts_prefs (head)`).
5. [ ] Registre data, autorizador e resultado em `docs/database/historico-migracoes.md`.

> **Feito em 2026-10-20:** banco carimbado em `0011_dashboard_charts_prefs (head)`.
> Em deploys futuros, use `alembic upgrade head` normalmente (o carimbo já está
> correto) e só depois de autorização explícita.

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

## 4A. Risco M1: Cloudflare 100 s (HTTP 524) na importação

Com o DNS proxied, a Cloudflare corta respostas após 100 s (planos Free/Pro/Business). Prévia
do Sheets > 100 s falha com 524 mesmo com nginx 190 s e gunicorn 180 s. Opções (decisão do
responsável): (1) prévia assíncrona futura (Celery + polling); (2) rota de importação em
subdomínio DNS-only com firewall; (3) aceitar no início (ainda não há bens importados) e
monitorar. Registrar a decisão: __________. Sem mudança de código nesta etapa.

## 4B. Nginx / vhost

- [ ] Backup do vhost atual antes de editar (rollback = restaurar e `nginx -t && reload`).
- [ ] Vhost sem `include` externo (blocos literais), zona própria `sispat_imports`, sem
      `add_header` de segurança (Next e Flask são os emissores; tabela no vhost).
- [ ] `sudo nginx -t && sudo systemctl reload nginx`.

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
- [ ] Cabeçalhos únicos (M2): `curl -sI https://<dominio>/ativar-conta` com exatamente UM
      `Referrer-Policy` (`no-referrer`) e UM `Strict-Transport-Security`; idem em `/api/health`.
- [ ] `NEXT_PUBLIC_*` presentes no bundle e nenhum segredo no bundle (`grep` no `.next`).
- [ ] `trivy image` (backend/frontend) após o build; achados HIGH/CRITICAL avaliados.
- [ ] `curl -s https://<dominio>/api/v1/me` → 401 JSON `unauthorized`.
- [ ] `curl -sI https://<dominio>/.env` → 404.
- [ ] Login real: USER sem MFA chega à home; ADM é levado ao desafio TOTP, e as páginas de
      administração só funcionam após o MFA. Logout volta ao `/login`.

Logs (sem segredos):
- [ ] `docker compose logs --since 15m backend frontend | grep -iE 'eyJ|service_role|secret|password|Bearer |token_hash'`
      → nenhuma linha com valor sensível.
- [ ] `docker compose logs --since 15m backend | grep -E ' 500 |internal_error'` → vazio após o
      login de teste. Um 500 logo no login indica schema desatualizado: volte ao passo 3.
- [ ] O IP registrado nos eventos de auditoria é o do cliente, não o da Cloudflare.

## 6. Rollback

1. Código/imagens: `docker tag sispat-agu/backend:rollback sispat-agu/backend:latest` (idem
   frontend) e `docker compose up -d --no-build`. Também é possível `git checkout <commit
   anterior>` + `docker compose up -d --build`.
2. Banco: **não** faça `alembic downgrade` sem autorização e análise de impacto. O stamp só
   altera `alembic_version`; em geral basta reverter as imagens. Vhost: restaurar o backup.
3. Configuração: mantenha uma cópia do `.env` anterior fora do repositório (`chmod 600`).
4. Após o rollback, repita a seção 5 e registre o incidente.

## Anexos por funcionalidade (vindos de `docs/deploy/CHECKLIST.md`)

### Tela Perfis e Permissões (`/administracao/perfis-permissoes`)
- [ ] Novas variáveis de ambiente, migrações e portas: **nenhuma**.
- [ ] Backend publicado com `GET /api/v1/admin/roles` e `GET /api/v1/admin/permissions`
      (ADM + AAL2 + `roles.manage`; sem query string).
- [ ] Permissão `roles.manage` atribuída ao perfil ADM no banco alvo (seed existente).
- [ ] CSP padrão (nonce) inalterada; sem scripts/estilos inline novos nem origens adicionais.
- [ ] CORS: só `GET` (já permitido).
- [ ] Pós-implantação: ADM com MFA (AAL2) vê perfis e matriz; USER e RH veem "Acesso
      restrito"; nenhuma resposta de erro expõe detalhes.

### Convite de usuários (e-mail e redirecionamento)
- [ ] Supabase Auth > URL Configuration: Site URL e Redirect URLs no domínio final (HTTPS),
      incluindo `https://<domínio>/ativar-conta`.
- [ ] Template "Invite user" conforme `docs/deploy/email-template-convite.md` (token_hash;
      exige autorização do dono do projeto Supabase).
- [ ] SMTP próprio no Supabase (o embutido dá `429 email rate limit`); SPF/DKIM/DMARC.
- [ ] `INVITE_ALLOWED_REDIRECT_URLS` com o 1º item `https://<domínio>/ativar-conta`.
- [ ] Teste real: convidar e-mail de teste; o link só é consumido após o clique.
