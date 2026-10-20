# Prontidão de deploy — 2026-10-19

Revisão SOMENTE LEITURA (nada foi alterado, aplicado ou implantado). Sem
segredos: variáveis citadas apenas por nome. Banco consultado com SELECT
(projeto Supabase único: dev = prod). Não foi executado `git` (regra da
memória do projeto); portanto as alterações pendentes do working tree só foram
avaliadas pelo conteúdo atual dos arquivos, não pelo diff.

## 1. Migrações: repositório x banco

Repositório: Alembic em `backend/migrations/versions` (0001 a 0010) e espelhos
`.sql` em `backend/migrations/sql` (0001 a 0013). Numeração dos dois NÃO coincide.

| Alembic (versions/) | Espelho .sql | No banco? | Evidência |
|---|---|---|---|
| 0001_initial_schema | 0001, 0002 (seeds) | SIM | tabelas, 3 roles, 40 permissões |
| 0002_import_previews | 0003 | SIM | `import_previews` (18), `import_preview_items` |
| 0003_invites | 0004 | SIM | `invites`, `invite_units` |
| 0004_db_security_hardening | 0006 | SIM | `sispat_block_mutation` (search_path vazio), 8 triggers `trg_*`, RLS em todas as tabelas, `ck_assets_deleted_by_required`, 0 grants a anon/authenticated |
| (sem Alembic) | 0005 seed segurança | SIM | permissões `users.invite`, `security.*` presentes |
| 0005_settings_ai_users | 0007 | SIM | `ai_settings` (1 linha, desligada), `user_preferences`, colunas `version`, `sessions_revoked_at`, `avatar_object_key`, `deactivated_*` em `users`, permissões `settings.ai.manage`, `ai.use`, `users.reset_*` |
| 0006_email_settings_permission | 0009 | SIM | permissão `settings.email.manage` |
| 0007_unit_aliases | 0010 | SIM | tabela `unit_aliases` (4), `uq_unit_aliases_alias_lower`, `ix_unit_aliases_unit_id` |
| 0008_catalog_source_ids_perms | 0011 | SIM | colunas `source_record_id` (units/rooms/responsible_people), `phone`, 5 constraints `ck_*`, 5 índices únicos, permissões `responsible.manage`, `units.update` |
| 0009_uniq_idx_assets_movements | 0012 | SIM | `uq_assets_patrimony_number_active`, `uq_asset_movements_one_pending`; registrada também em `list_migrations` (20261017113052) |
| 0010_seed_permission_corrections | 0013 | SIM | USER não possui `rooms.manage` nem `inventory.create` |
| (sem Alembic) | 0008_storage_avatars | SIM | bucket `avatars` privado, 1 MiB, `image/webp`; policy RESTRICTIVE `sispat_avatars_deny_client_roles`; 3 objetos |

Conclusões:

- `alembic_version` = `0006_email_settings_permission`. O head do repositório é
  `0010_seed_permission_corrections`. TODO o conteúdo das 0007 a 0010 já existe
  no banco (aplicado manualmente via SQL), mas o carimbo está atrasado em 4
  revisões. Nada está faltando em termos de esquema/seed.
- A memória prévia estava desatualizada: 0005 (preferências) e 0008_storage_avatars
  NÃO estão pendentes; estão aplicadas.
- `list_migrations` (histórico do Supabase) mostra só 4 entradas: 0001_initial_schema,
  0002_seeds_roles_permissions, 0002_enable_rls_default_deny (sem arquivo no
  repositório; citada apenas em `docs/security/evidence/database.md`) e
  0012_unique_indexes_assets_movements. Esse histórico não é fonte de verdade
  (o resto foi aplicado fora dele). Divergência cosmética, mas deve ser registrada
  em `docs/database/historico-migracoes.md`.
- Nenhuma migração pendente é destrutiva (nada pendente). Os `DROP`/`DELETE` nos
  arquivos Alembic 0007/0008 estão só nos `downgrade`. O `.sql` 0013 contém um
  `DELETE` em `role_permissions`, já efetivado e idempotente.
- Fora de ordem: apenas o carimbo do Alembic. Rodar `alembic upgrade head` agora
  tentaria reexecutar 0007 a 0010; os espelhos .sql são idempotentes, mas confirme
  que os `.py` também são antes de arriscar. O caminho seguro é `stamp`.
- Não verifiquei policies de RLS (não há nenhuma em `public`, por desenho: negar
  por padrão, backend usa conexão direta) nem comparei o DDL do `.py` linha a linha
  com o banco; a checagem foi por existência de objetos.
- `public.alembic_version` está com RLS desligado; mesmo assim anon/authenticated
  não têm nenhum grant em `public` (0 linhas em `role_table_grants`), então não é
  exposta pelo PostgREST.

Ordem segura (sem aplicar): (1) backup/snapshot; (2) `alembic current` na imagem
nova; (3) `alembic stamp 0010_seed_permission_corrections` (só atualiza
`alembic_version`, sem DDL); (4) `alembic current` = head; (5) registrar em
`docs/database/historico-migracoes.md`. Nenhum `upgrade` é necessário.

## 2. Supabase: advisors

Segurança:
- INFO `rls_enabled_no_policy` em 27 tabelas: esperado e desejado (RLS ligado, sem
  policy = nega tudo a anon/authenticated; backend acessa por role própria). RLS
  habilitado em todas as tabelas patrimoniais (assets, asset_movements,
  raw_import_records, audit_logs, import_previews, etc.). Nenhum `FORCE RLS`.
- WARN `auth_leaked_password_protection`: proteção contra senhas vazadas
  DESLIGADA no Supabase Auth. Ligar antes de produção.
- WARN `extension_in_public`: `pg_trgm` no schema `public`. Baixo risco; mover
  para `extensions` exige migração (índice `ix_assets_description_trgm` depende);
  pode ficar para depois.
- Storage: bucket `avatars` privado, limite 1 MiB, só `image/webp`, policy
  restritiva bloqueando anon/authenticated. OK. Funções do `public`:
  `sispat_block_mutation` com `search_path=""`, `SECURITY INVOKER`; as demais são
  do pg_trgm.

Performance (todos INFO): 5 FKs sem índice (`ai_settings.deepseek_acknowledged_by`,
`ai_settings.updated_by`, `invites.revoked_by`, `unit_aliases.created_by`,
`users.deactivated_by`) e 52 índices "não usados" (sem tráfego ainda: `assets` está
vazia; não remover). Sem ação para o deploy.

## 3. Docker Compose e Dockerfiles

`docker-compose.yml` (evidências por linha):
- Portas: backend `127.0.0.1:${BACKEND_PORT:-8000}:8000` (l.105-106), frontend
  `127.0.0.1:${FRONTEND_PORT:-3000}:3000` (l.245-246). Nenhuma 80/443. Redis sem
  `ports` (l.205) e só em `backend-net` (`internal: true`, l.46-48).
- Targets: backend e worker `target: runtime` (l.75, 128); frontend `runtime`
  (l.218). Target `dev` só no `docker-compose.dev.yml` (l.28, 44).
- Hardening: `x-hardening` (read_only, no-new-privileges, cap_drop ALL, init) em
  todos os serviços (l.33-39, 71, 122, 171, 214); limites de CPU/memória/PIDs;
  logs rotacionados; tmpfs para `/tmp` e `.next/cache`.
- Healthchecks: backend (`/api/health`), worker (`celery inspect ping`), redis
  (ping autenticado), frontend (GET /). Frontend `depends_on` backend sem condição
  de saúde (aceitável).
- Redis: imagem fixada por digest, ACL gerada em tmpfs, comandos admin bloqueados,
  `REDIS_PASSWORD` obrigatório (`:?`, l.177). Volume persistente `redis-data`.
- Worker Celery: profile `worker` (opt-in, l.123-124); não sobe com `up -d` simples.
  Não exige `AI_ENABLED`/chaves para subir: com `AI_ENABLED=false` as tarefas do
  beat (alertas a cada 6 h, resumo diário, qualidade; `celery_app.py` l.31-39)
  caem no `NullProvider`/desligado (`ai_tasks._safe_run`). Só é útil se a IA for
  usada; pode ficar fora do primeiro deploy (o sistema funciona sem ele).
- `docker-compose.dev.yml` publica Postgres dev e usa `flask run --reload`;
  NUNCA usar na VPS (checklist já proíbe).
- PROBLEMA: o secret `google_sheets_credentials` (l.58-60) aponta para arquivo do
  host; se o arquivo não existir, QUALQUER `docker compose up` falha. O
  checklist manda apagar a chave após a importação inicial: isso quebraria
  reinicializações/rebuilds. Decidir: manter arquivo (chmod 0400, dono 10001) ou
  tornar o secret opcional/profile.
- PROBLEMA: build args `NEXT_PUBLIC_*` têm default vazio (l.220-222). Se o `.env`
  da VPS não os tiver, o build "passa" e o login quebra em silêncio.

Dockerfiles:
- Backend: base por digest, `requirements.lock` com `--require-hashes`, usuário
  uid 10001 sem shell, sem debug, `FLASK_ENV=production`, gunicorn 3 workers
  `--timeout 180 --graceful-timeout 30` (l.94-98, alteração pendente já presente
  no arquivo; consistente com `docs/deployment/timeouts-gunicorn.md`). Copia
  `migrations/` e `alembic.ini` (permite `alembic stamp` pela imagem). O stage
  `dev` roda pip sem hashes, mas só é usado no compose dev.
- Frontend: Node 24 por digest, `npm ci`, standalone, uid 10001, npm/yarn
  removidos do runtime. OK.
- Incoerência de timeouts: `DB_STATEMENT_TIMEOUT_MS` é opt-in (comentado no
  `.env.example`); sem ele, a regra "timeout interno < gunicorn" depende do
  Flask tratar antes. Ver item 5 (Nginx 60 s).

## 4. Variáveis de ambiente de produção (só nomes)

Obrigatórias (backend/worker, via `env_file`): `FLASK_ENV=production` (default já
é production; `Settings` recusa `DB_ECHO`, `SECRET_KEY` curta, `SUPABASE_JWT_SECRET`
curto: settings.py l.504-529), `SECRET_KEY` (>=32), `DATABASE_URL` (Supabase;
`DB_SSLMODE=verify-full` + `DB_SSLROOTCERT` recomendado só se o CA for montado),
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (só backend),
`SUPABASE_JWT_SECRET` se HS256 ou `SUPABASE_JWT_ALGORITHMS=ES256` + JWKS derivado
da URL (confirmar no painel qual algoritmo o projeto usa), `REDIS_PASSWORD` e
`REDIS_URL` (host `redis`), `CORS_ALLOWED_ORIGINS=https://<dominio>` (default é
`http://localhost:3000`, settings.py l.226-229: se esquecido, o navegador é
bloqueado e o localhost fica permitido), `INVITE_ALLOWED_REDIRECT_URLS` (default
vazio, l.316; 1º item `https://<dominio>/ativar-conta`, o backend recusa convite
que não termine em `/ativar-conta`), `PASSWORD_RESET_REDIRECT_URL` (se usada, deve
estar na lista), `TRUSTED_PROXY_IPS=127.0.0.1`.

Condicionais: `GOOGLE_SHEETS_CREDENTIALS_HOST_PATH`, `GOOGLE_SHEETS_SPREADSHEET_ID`,
`GOOGLE_SHEETS_*_SHEET_NAME/_GID` (importação), `EMAIL_ENABLED` + `EMAIL_HOST`,
`EMAIL_PORT` (587/465), `EMAIL_SECURITY`, `EMAIL_USER`, `EMAIL_PASSWORD`,
`EMAIL_FROM` (SMTP; settings.py l.457-473 exige o conjunto quando habilitado;
o SMTP do convite é configurado no Supabase Auth, separado), `N8N_INTEGRATION_ENABLED`
(+ `N8N_BASE_URL`, `N8N_WEBHOOK_URL`, `N8N_API_KEY`; `false` até existir HTTPS),
`AI_ENABLED=false` (+ chaves só se habilitar). Opcionais de ajuste: `TZ`,
`BACKEND_PORT`, `FRONTEND_PORT`, `*_CPUS`, `*_MEMORY`, `MAX_CONTENT_LENGTH_BYTES`,
`DB_STATEMENT_TIMEOUT_MS` (recomendado 120000), `GUNICORN_CMD_ARGS`,
`GOOGLE_SHEETS_TIMEOUT_SECONDS`, `ALERTS_*`.

Somente dev (não devem existir na VPS): `POSTGRES_DEV_*`, `DEBUGPY_PORT`.

Congeladas no build do frontend (exigem REBUILD com o domínio final):
`NEXT_PUBLIC_API_URL` (`https://<dominio>/api`), `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (Dockerfile l.38-43; usadas em
`src/lib/api-client.ts` l.36, `supabase-client.ts` e na CSP em `src/middleware.ts`
l.37-38, que monta o `connect-src`). Trocar de domínio depois = novo
`docker compose up -d --build frontend`.

Divergência `.env.example` x código: `DB_POOL_RECYCLE_SECONDS` e
`DB_POOL_TIMEOUT_SECONDS` são lidas (documentadas em timeouts-gunicorn.md) mas não
constam no `.env.example`. O restante do `.env.example` bate com o `Settings`
(comparação automática por nome, com falsos positivos esperados porque o
`Settings` usa campos pydantic em minúsculas). Não li valores do `.env`.

Supabase Auth (fora do repo, manual): Site URL e Redirect URLs com
`https://<dominio>/ativar-conta`; template "Invite user" conforme
`docs/deploy/email-template-convite.md`; SMTP próprio; MFA TOTP; leaked password
protection.

## 5. Infra (CloudPanel/Nginx/Cloudflare)

Em `infra/cloudpanel/vhost.conf.example` (modelo, nada aplicado):
- OK: `proxy_pass` para 127.0.0.1 (l.129, 166), `X-Forwarded-For` sobrescrito com
  o IP real, HSTS sem preload, nosniff, frame DENY, Referrer/Permissions-Policy,
  CSP restritiva em `/api/`, `Cache-Control: no-store` na API, bloqueio de
  dotfiles, rate limit (10 r/s geral, 10 r/min em convite/ativação/MFA),
  `limit_conn`, métodos restritos, `server_tokens off`, avatar com 3 MiB
  (l.113-117) e geral 2 MiB (l.70). Importação vem do Google Sheets no servidor,
  então não há upload grande de planilha; só foto.
- PROBLEMA (timeouts): `proxy_read_timeout 60s` em `/api/` (l.144) e `send` 60 s.
  O gunicorn está em 180 s e `timeouts-gunicorn.md` exige `proxy_read_timeout`
  >= 190 s. O preview de importação (`POST /api/v1/imports/google-sheets/preview`)
  receberia 504 do Nginx aos 60 s antes do backend responder. Ajustar o modelo e
  o vhost real (location específica para `/api/v1/imports/` com 190 s é a opção
  menos permissiva).
- PROBLEMA (real IP): as linhas `set_real_ip_from` estão comentadas (l.56-58) e
  é preciso inserir todas as faixas atuais da Cloudflare; sem isso o
  `CF-Connecting-IP` é ignorado e a auditoria/rate limit veem o IP da Cloudflare.
- Atenção: o modelo usa `include /etc/nginx/snippets/sispat-api-proxy.conf`
  (l.106, 116), arquivo que precisa existir na VPS; se o CloudPanel não aceitar,
  duplicar o bloco. As duas locations com `include` herdam `limit_except`? Não:
  só `location /api/` tem `limit_except`; as locations de convite/avatar não
  restringem métodos (baixo risco).
- HSTS aparece no Nginx E no `next.config.ts` (l.26): cabeçalho duplicado no
  frontend (inofensivo, mas conferir). CSP do frontend vem do `middleware.ts`
  (nonce); o vhost não deve sobrescrevê-la. WAF/Cloudflare: regras e rate limit
  na Cloudflare não estão versionadas; checar em `hostinger-cloudpanel-cloudflare.md`
  e configurar no painel (SSL Full Strict, firewall da VPS só com faixas CF).

Dois checklists:
- `docs/deployment/checklist-deploy-vps.md` (2026-10-14): completo, mas
  DESATUALIZADO na seção 3 (diz Alembic em 0004, 0005 pendente, upgrade a
  0005; o repositório está em 0010 e o banco já tem tudo) e sem os itens de
  convite/e-mail, timeouts 180 s, aliases e Sheets de unidades/salas/pessoas.
  Também diz "redis, backend, frontend" sem citar o worker opcional.
- `docs/deploy/CHECKLIST.md` (novo, não rastreado): só apêndice por funcionalidade
  (Perfis e Permissões; convites). Declara "complementa" o outro.
- Recomendação: manter UM checklist canônico, `docs/deployment/checklist-deploy-vps.md`;
  reescrever a seção 3 para o estado real (stamp 0010, nenhum upgrade); mover o
  conteúdo de `docs/deploy/CHECKLIST.md` para uma seção "Anexos por funcionalidade"
  desse arquivo (ou renomear a pasta `docs/deploy/` para conter apenas
  `email-template-convite.md` e as prontidões datadas como esta). Uma só fonte
  para "o que fazer", relatórios datados em `docs/deploy/`.

## 6. Dados (contagens em 2026-10-19)

| Tabela | Linhas |
|---|---|
| units | 4 (023401 a 023404) |
| users | 3 |
| rooms | 40 |
| responsible_people | 77 (inclui telefone/e-mail: dado pessoal) |
| assets | 0 |
| asset_movements | 0 |
| import_previews | 18 (todas CONCLUIDA, 2026-10-16 a 2026-10-19) |
| import_preview_items | 6.739 (carga de PII da planilha) |
| raw_import_records | 0 |
| audit_logs | 32 (append-only: não podem ser removidos) |
| invites | 2 (ambos REVOGADO) |
| unit_aliases | 4 |
| user_preferences | 0 |
| ai_settings | 1 (enabled=false, provider=none) |
| permissions / roles / role_permissions | 40 / 3 / 57 (ADM 40, USER 11, RH 6) |

Usuários: Maycon Douglas (ADM, criado 2026-10-14), Carlos Silva dos Santos (RH,
2026-10-19) e Daniel Rodrigues Aires (USER, 2026-10-19). Nenhum se chama
"TESTE USER" ou "TESTE RH"; porém os dois não-ADM foram criados hoje e ambos têm
convite REVOGADO, o que sugere que são as contas de teste renomeadas. CONFIRMAR
com o responsável e, se forem de teste, desativar/remover antes da produção
(remoção também no Supabase Auth, pois `auth_user_id` está preenchido nos 3).
Não deletei nada.

Observações: `assets` e `raw_import_records` vazios = a importação real ainda NÃO
foi executada (só previews). As 6.739 linhas de `import_preview_items` e os 18
previews contêm PII e devem ser expurgados/definir retenção após a importação.
Como dev = prod, qualquer teste e2e que escreva neste banco também escreve em
produção.

## Resumo executivo

BLOQUEIA o deploy:
1. Proxy `proxy_read_timeout 60s` x gunicorn 180 s: o preview de importação
   falha com 504 no Nginx. Corrigir o vhost (>=190 s em `/api/`).
2. `set_real_ip_from` da Cloudflare não configurado no modelo: IP real incorreto
   em auditoria e rate limit.
3. Variáveis de domínio: `CORS_ALLOWED_ORIGINS`, `INVITE_ALLOWED_REDIRECT_URLS` e
   as três `NEXT_PUBLIC_*` (build) precisam do domínio final HTTPS; os defaults
   (localhost, vazio) quebram login/convite.
4. Supabase Auth: Site URL/Redirect URLs, template de convite e SMTP próprio com
   o domínio final (convites falham ou apontam para localhost).
5. Secret do Google Sheets obrigatório no Compose: arquivo ausente impede QUALQUER
   `up`; conflita com a orientação de apagar a chave após a importação.
6. Autorização explícita do responsável (regra do projeto) e contas de teste
   confirmadas/removidas (RH/USER criados hoje) com Supabase compartilhado.

Fazer antes, não bloqueia:
- `alembic stamp 0010_seed_permission_corrections` (carimbo em 0006; esquema ok).
  **Superado em 2026-10-20:** com a 0011 aplicada, o carimbo é
  `alembic stamp 0011_dashboard_charts_prefs`.
- Ligar leaked password protection no Supabase Auth.
- Unificar os checklists e atualizar a seção 3 desatualizada.
- Definir retenção/expurgo de `import_previews`/`import_preview_items` (PII).
- Adicionar `DB_POOL_*` ao `.env.example`; ativar `DB_STATEMENT_TIMEOUT_MS=120000`
  (ou `ALTER ROLE ... statement_timeout`).
- Registrar a divergência do histórico de migrações do Supabase
  (`0002_enable_rls_default_deny` sem arquivo no repo).
- Worker Celery: decidir se sobe (não precisa de IA para subir).
- Firewall da VPS só com faixas Cloudflare; regras de WAF/rate limit na Cloudflare.
- Remover o HSTS duplicado (Nginx e Next) se incomodar.
- Rodar `scripts/security-audit.sh` e pytest/Playwright (não executados nesta
  revisão).

OK:
- Esquema do banco completo até a 0013 (.sql) / 0010 (Alembic); nenhuma migração
  pendente nem destrutiva.
- RLS ligado em todas as tabelas, 0 grants para anon/authenticated, triggers de
  append-only e anti-exclusão física, bucket `avatars` privado com policy.
- Compose: portas só em 127.0.0.1, sem 80/443, Redis interno com senha, hardening,
  healthchecks, targets `runtime`, usuário não-root, sem n8n.
- `Settings` recusa configuração fraca em produção.
- Dockerfiles endurecidos, timeouts do gunicorn coerentes com o documento.

## Ordem recomendada (comandos que o USUÁRIO executa)

1. Confirmar autorização de deploy e limpar contas de teste (decisão do usuário).
2. Local: `cd backend && python -m pytest -q`; `cd frontend && npm run lint &&
   npm run typecheck && npm run build`; `bash scripts/security-audit.sh --strict`.
3. Commitar o working tree (git manual, pelo usuário).
4. Supabase (painel): Site URL/Redirects, template de convite, SMTP, leaked
   password protection.
5. VPS: criar `.env` (chmod 600) com as variáveis da seção 4 e o JSON do Sheets
   fora do repo (chmod 0400, chown 10001).
6. CloudPanel: vhost a partir de `infra/cloudpanel/vhost.conf.example` com
   `proxy_read_timeout 190s` em `/api/`, faixas `set_real_ip_from` da Cloudflare;
   `nginx -t` e só então recarregar.
7. `docker compose config --quiet` e `docker compose build backend frontend`.
8. Carimbo Alembic (com autorização, sem DDL):
   `docker compose run --rm --no-deps backend alembic current`
   `docker compose run --rm --no-deps backend alembic stamp 0011_dashboard_charts_prefs`
   (0011 aplicada manualmente em 2026-10-19; ver atualização de 2026-10-20 abaixo)
   `docker compose run --rm --no-deps backend alembic current`
9. `docker compose up -d` (acrescentar `--profile worker` apenas se for usar IA).
10. Verificações pós-subida da seção 5 do checklist (health, 401, `ss -ltnp`,
    cabeçalhos, login com MFA ADM, logs sem segredos).
11. Executar a importação real e depois expurgar previews (PII) e a chave do Sheets.

## Não verificado

Valores do `.env` e da VPS; estado real do Supabase Auth (algoritmo de JWT,
SMTP, URLs); regras de Cloudflare/firewall; execução de testes e do
security-audit; diff do `backend/Dockerfile` (sem git); equivalência linha a linha
dos DDL dos `.py` com o banco (verifiquei existência de objetos); se os `.py`
Alembic 0007 a 0010 são idempotentes.

## Atualização — 2026-10-19 (fim do ciclo de correção)

Ciclo de correção pré-deploy concluído; deploy ainda NÃO realizado.

- Corrigidos: SEC-REV-01 a 04 (JSON aninhado agora tratado em todas as rotas por
  `get_json_body()` e em `rbac.py`), M1/M2 (https obrigatório em produção para
  CORS e redirects de convite), `nosemgrep` justificado, Referrer-Policy
  `no-referrer` em `/ativar-conta`, `DB_POOL_*` no `.env.example`, redação de
  inteiro de 11 dígitos em `safe_scalar`.
- Infra: vhost sem `add_header` (Next/Flask emitem), blocos de proxy literais,
  zona `sispat_imports`, location de importação com 190 s; roteiro e checklist
  canônico unificados.
- Contas fictícias RH e USER desativadas (`active=false`, banidas no Auth,
  sessões revogadas) em 2026-10-19; ADM mantido.
- Testes: pytest completo 10228 passaram, 0 falhas, 42 ignorados, 4 xfailed;
  Playwright em 4 grupos 2162 passaram; frontend lint/typecheck/build ok.
- `security-audit.sh --strict`: bandit, pip-audit, npm audit, semgrep e compose
  OK; **gitleaks e trivy NÃO executados** (binários ausentes).
- Revisões: authz e infra sem achados Críticos/Altos; pós-correções "COM
  RESSALVAS".
- Pendências: gitleaks (antes do push) e trivy (após build); `nginx -t` só na
  VPS; limite de 100 s da Cloudflare (decisão do responsável); template de
  convite, SMTP e senhas vazadas no Supabase; backup/PITR antes do `alembic
  stamp`; `test_sec_json_depth.py` sem prova de falha sem a correção.

## Atualização — 2026-10-20 (gráficos do dashboard + Nivo)

- Gráficos personalizáveis por usuário e troca do Recharts pelo Nivo 0.99
  (Tremor descartado por exigir React 18). Detalhes em
  `docs/ux/DASHBOARD_GRAFICOS.md`.
- Migração Alembic `0011_dashboard_charts_prefs` (espelho `sql/0014`)
  aplicada manualmente no Supabase em 2026-10-19, com autorização; CHECKs
  confirmados pelo responsável. **Carimbo no deploy:**
  `alembic stamp 0011_dashboard_charts_prefs` (sem `upgrade`).
- Revisão `docs/security/REVISAO_DASHBOARD_NIVO_2026-10-20.md`: APROVADO COM
  RESSALVAS; L-1 e I-3 corrigidos; L-2 e I-4 (`npm dedupe`) adiados para depois
  do deploy.
- Testes finais: pytest completo **10269 passaram**, 0 falhas, 42 ignorados,
  4 xfailed. Playwright em 4 grupos com `--workers=1`: e2e 631 + 1 falha,
  a11y 386, unit/dashboard/motion 102, responsive 1089. A falha foi no 1º teste
  da rodada (`activate-invite-functional.spec.ts`, timeout esperando a
  hidratação durante a compilação a frio do `next dev`); reexecutado
  isoladamente, o spec passou 10/10. Total: 2209 testes, nenhuma falha real.
- Deploy: o build do frontend muda (Nivo no `package-lock.json`), então
  a VPS precisa de `docker compose build frontend backend`.

## Implantação concluída — 2026-10-20

Executada pelo responsável na VPS (`/opt/SISPAT`), com autorização explícita e
orientação passo a passo.

- `.env` de produção: URLs `https://`, portas `BACKEND_PORT=8110` e
  `FRONTEND_PORT=3110` (3000/8000 ocupadas por outros sistemas), credencial do
  Sheets em `/etc/google_sheets_credentials.json` (0400, dono 10001).
  Corrigidos na hora: caminhos do Windows (`C:/...`) copiados do `.env` local,
  `INVITE_ALLOWED_REDIRECT_URLS` duplicada e espaço no fim de linha.
- Imagens `backend` e `frontend` construídas na VPS.
- Alembic: o primeiro `stamp` falhou (`StringDataRightTruncation`: ID com 38
  caracteres em `varchar(32)`; transação desfeita, banco inalterado). IDs
  0008/0009/0011 encurtados, com teste de regressão; novo `stamp` OK ->
  `0011_dashboard_charts_prefs (head)`.
- `docker compose up -d`: `backend`, `frontend` e `redis` healthy;
  `/api/health` -> `{"status":"ok"}`; `/login` -> 200.
- CloudPanel: o primeiro vhost era o padrão do painel (tudo para o frontend,
  `/api/` caía no 404 do Next.js) e incluía `global_settings`
  (`Referrer-Policy same-origin` duplicado). Substituído por
  `infra/cloudpanel/vhost.ueato-cloudpanel.conf` (validado com `nginx -t`
  antes). Detalhes no `ROTEIRO_VPS_ueato.md`, seção 5.
- Verificação externa: `/api/health` ok; em `/ativar-conta` e `/api/health`
  cada cabeçalho de segurança aparece uma única vez (`no-referrer` em
  `/ativar-conta`).
- Pendente: teste no navegador (login ADM + MFA, dashboard), itens de Supabase
  Auth, trivy, limite de 100 s da Cloudflare, worker e
  `set_real_ip_from 0.0.0.0/0` no `nginx.conf` global do CloudPanel.
