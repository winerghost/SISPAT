# SISPAT-AGU — Backend (API Flask + banco de dados)

O backend é onde vivem **toda** a regra de negócio, a validação de entrada
(schemas Pydantic com `extra="forbid"` e limites de tamanho) e a autorização por
perfil, unidade e campo — o frontend é apresentação, nunca mecanismo de
segurança. Pilha: Python + Flask + SQLAlchemy 2.x + Alembic contra
Supabase/PostgreSQL. A API é versionada em `v1`.

## Estrutura

```
backend/
  requirements.txt            # pins exatos
  requirements.lock           # com hashes (usado no Dockerfile)
  requirements-dev.txt        # testes e ferramentas
  alembic.ini
  ruff.toml
  Dockerfile
  app/
    __init__.py               # factory da aplicação
    cli.py                    # comandos `flask ...` de manutenção
    celery_app.py             # worker/agendador (perfil `worker` do Compose)
    errors.py
    api/v1/                   # rotas (blueprints) + schemas de requisição
    auth/                     # validação do JWT do Supabase (jwks.py, supabase_auth.py)
    authorization/            # rbac.py (require_role/require_aal2/require_permission,
                              # require_unit_access/apply_unit_scope) e security_events.py
    config/settings.py        # configuração via variáveis de ambiente
    database/session.py       # engine, SessionLocal, Base declarativa
    integrations/             # google_sheets_client, n8n_client,
                              # supabase_admin_client, supabase_storage_client
    models/                   # modelos ORM (um arquivo por grupo de entidades)
    security/                 # csv_safety, rate_limit, sanitize, text_search
    services/                 # regra de negócio por domínio + ai/, alerts/, email/
    tasks/                    # tarefas Celery
  migrations/
    env.py, script.py.mako
    versions/                 # cadeia Alembic 0001 ... 0019 (head)
    sql/                      # espelhos SQL puros (0001 ... 0022) + seeds manuais
  tests/                      # pytest (Flask test client + mocks; zero rede)
```

Módulos de rota em `app/api/v1/` (2026-10-29): `admin_access`, `admin_audit`,
`ai`, `ai_settings`, `assets`, `catalog_http`, `catalog_imports`, `dashboard`,
`dashboard_equipment`, `email_settings`, `health`, `imports`, `inventories`,
`locations`, `me`, `movements`, `pagination`, `reports`, `responsible_people`,
`rooms`, `security`, `units`, `user_admin_http` e `users`. Os arquivos
`*_schemas.py` ao lado são os schemas Pydantic de cada grupo.

### Cadeia Alembic

Linear, sem ramos: `0001_initial_schema` → `0002_import_previews` →
`0003_invites` → `0004_db_security_hardening` → `0005_settings_ai_users` →
`0006_email_settings_permission` → `0007_unit_aliases` →
`0008_catalog_source_ids_perms` → `0009_uniq_idx_assets_movements` →
`0010_seed_permission_corrections` → `0011_dashboard_charts_prefs` →
`0012_asset_bond_status` → `0013_dashboard_layout_prefs` →
`0014_unaccent_search` → `0015_asset_tech_classification` →
`0016_asset_search_key` → `0017_dashboard_panel_prefs` →
`0018_equipment_classification` → **`0019_user_soft_delete` (head)**.

> **Estado do banco (Supabase `tocbtonqnahmtegfkrmn`, conferido em 2026-10-29
> por consulta somente leitura):** `alembic_version` =
> **`0019_user_soft_delete`**, igual à head do código. Como a cadeia é linear, o
> carimbo declara toda a cadeia aplicada. O schema `public` tem 28 tabelas de
> aplicação (mais a própria `alembic_version`): a 0001 criou 20 delas e as
> demais vieram das migrações seguintes. O padrão deste projeto é o responsável
> executar o espelho `.sql` no SQL Editor do Supabase e **carimbar**
> (`alembic stamp <revisão>`), nunca rodar `alembic upgrade` contra produção.
> Vários arquivos de migração ainda trazem "PENDENTE DE APLICAÇÃO" no cabeçalho:
> é o texto de quando foram escritos, não o estado do banco. Histórico
> detalhado, consultas de verificação e rollbacks:
> `docs/database/historico-migracoes.md`.

### Alembic ↔ espelho SQL (`migrations/sql/`)

A numeração dos arquivos SQL é própria e **não** coincide com a do Alembic: o
deslocamento cresce ao longo da cadeia (+1 a partir da 0002, +2 a partir da
0004, +3 a partir da 0006), porque alguns arquivos `.sql` são seeds ou scripts
sem migração. Cada
espelho é mantido **semanticamente idêntico** à migração correspondente —
`tests/test_db_static.py` verifica que cada bloco do `upgrade` aparece no
espelho. Qualquer alteração de schema deve ser feita nos **dois** arquivos.

| Migração Alembic | Espelho SQL | O que cria | Reverter (dev; produção só com autorização) |
|---|---|---|---|
| `0001_initial_schema` | `0001` | extensões, enum `asset_located_status` e as 20 tabelas com índices e constraints | `alembic downgrade base` |
| `0002_import_previews` | `0003` | `import_previews` e os itens de prévia | `alembic downgrade 0001_initial_schema` |
| `0003_invites` | `0004` | `invites` (convite de acesso) | `alembic downgrade 0002_import_previews` |
| `0004_db_security_hardening` | `0006` | `sispat_block_mutation()`, gatilhos append-only de `audit_logs`, proibição de DELETE/TRUNCATE físico em `assets`/`asset_movements`/`raw_import_records`, RLS e REVOKEs | `alembic downgrade 0003_invites` |
| `0005_settings_ai_users` | `0007` | `ai_settings`, `user_preferences` e colunas novas de `users` | `alembic downgrade 0004_db_security_hardening` |
| `0006_email_settings_permission` | `0009` (sem BEGIN/COMMIT) | seed da permissão `settings.email.manage` | `alembic downgrade 0005_settings_ai_users` |
| `0007_unit_aliases` | `0010` | `unit_aliases` (siglas de atalho de unidade) | `alembic downgrade 0006_email_settings_permission` |
| `0008_catalog_source_ids_perms` | `0011` | `source_record_id` nos cadastros de apoio + permissões de catálogo | `alembic downgrade 0007_unit_aliases` |
| `0009_uniq_idx_assets_movements` | `0012` | índices únicos de `assets` e `asset_movements` | `alembic downgrade 0008_catalog_source_ids_perms` |
| `0010_seed_permission_corrections` | `0013` | correções do seed de permissões | `alembic downgrade 0009_uniq_idx_assets_movements` |
| `0011_dashboard_charts_prefs` | `0014` | `user_preferences.dashboard_charts` | `alembic downgrade 0010_seed_permission_corrections` |
| `0012_asset_bond_status` | `0015` | `assets.bond_status` (vínculo do bem) | `alembic downgrade 0011_dashboard_charts_prefs` |
| `0013_dashboard_layout_prefs` | `0016` | `user_preferences.dashboard_layout` | `alembic downgrade 0012_asset_bond_status` |
| `0014_unaccent_search` | `0017` | extensão `unaccent` (schema `extensions`) + wrapper `public.sispat_unaccent(text)` | `alembic downgrade 0013_dashboard_layout_prefs` |
| `0015_asset_tech_classification` | `0018` | `assets.asset_category`, `assets.tech_type`, `assets.operational_status` (+ CHECKs) | `alembic downgrade 0014_unaccent_search` |
| `0016_asset_search_key` | `0019` | função `public.sispat_alnum_key(text)` e índice GIN trigram funcional `ix_assets_patrimony_key_trgm` — **não cria coluna `assets.search_key`** | `alembic downgrade 0015_asset_tech_classification` |
| `0017_dashboard_panel_prefs` | `0020` | tabela `user_dashboard_preferences` (RLS sem políticas, sem grants para `anon`/`authenticated`) | `alembic downgrade 0016_asset_search_key` |
| `0018_equipment_classification` | `0021` | `assets.equipment_family`, `equipment_category`, `classification_confidence`, `classification_rule`, `classification_rules_version`, `category_override`, CHECKs e índice | `alembic downgrade 0017_dashboard_panel_prefs` |
| `0019_user_soft_delete` | `0022` | `users.deleted_at`, `users.deleted_by`, `users.anonymized_at`, CHECK `ck_users_deleted_requires_anonymized` e a permissão `users.delete` (vinculada só ao ADM) | `alembic downgrade 0018_equipment_classification` |

(`0008_storage_avatars.sql` é script do Supabase Storage — bucket privado
`avatars` —, sem migração Alembic correspondente.)

Os seeds SQL `0002` (roles/permissions) e `0005` (8 permissões de gestão de
usuários/segurança, atribuídas somente ao ADM) **não são migrações Alembic**:
são aplicados manualmente e são idempotentes (`ON CONFLICT DO NOTHING`).

### Backup antes de qualquer migração ou rollback

Obrigatório antes de aplicar ou reverter qualquer coisa em banco que não seja
descartável. A URL de conexão vem de variável de ambiente local, **nunca**
versionada:

```bash
pg_dump "$SUPABASE_DB_URL" --schema=public --format=custom \
  --file=sispat_public_$(date -u +%Y%m%dT%H%M%SZ).dump
```

Depois do dump, confira o carimbo com
`SELECT version_num FROM alembic_version;` (esperado hoje:
`0019_user_soft_delete`). Alguns rollbacks **perdem dados**: o da `0018`, por
exemplo, apaga a classificação e os `category_override` feitos pelo ADM
(sobrando apenas as linhas de `audit_logs`). Nenhuma migração é aplicada ou
revertida em produção sem autorização explícita.

### Ordem de implantação quando a migração cria objeto que o código consulta

As migrações `0014`, `0015`, `0016`, `0018` e `0019` criam objetos lidos pelo
código novo, então o DDL vai **antes** de subir a imagem nova do backend. Na
`0019`, `app.models.rbac.User` declara as três colunas e a consulta de
autenticação as seleciona: sem elas no banco, toda requisição autenticada
falharia. Rebuild, quando a implantação estiver autorizada:

```bash
docker compose build backend frontend && docker compose up -d backend frontend
```

## Comandos de manutenção (`flask ...`)

Registrados em `app/cli.py` pelo factory. Nenhum imprime dados de bens/pessoas,
segredos ou a URL do banco. Todos são **dry-run por padrão** ou somente leitura;
gravar exige autorização explícita.

| Comando | O que faz |
|---|---|
| `flask purge-import-previews [--older-than-days N] [--dry-run]` | apaga prévias de importação finais/expiradas e seus itens — **nunca** `raw_import_records`; grava `IMPORT_PREVIEWS_PURGED` com origem `cli` |
| `flask classify-assets` | dry-run: conta a classificação legada (categoria e tipo de TI) dos bens ativos **sem** categoria |
| `flask classify-assets --apply` | grava; nunca sobrescreve classificação existente (exige a `0015`) |
| `flask classify-assets --list-unclassified` | somente leitura: id + descrição truncada dos bens que nenhuma regra classifica |
| `flask classify-equipment` | dry-run: conta família, categoria e confiança por bem (motor em `app/services/asset_classification.py`) |
| `flask classify-equipment --apply` | grava; respeita `category_override` do ADM, ignora bem sem descrição e é idempotente (exige a `0018`) |
| `flask classify-equipment --list-low-confidence` | somente leitura: id + descrição truncada dos bens com confiança BAIXA |

No container: `docker compose exec backend flask <comando>`. As opções `--list-*`
são incompatíveis com `--apply`.

Para **adicionar uma regra nova de classificação** — onde editar, em que ordem de
prioridade a regra entra, que teste criar e como medir o impacto com
`flask classify-equipment` em dry-run antes de cogitar `--apply` — siga
`docs/architecture/classificacao-patrimonial.md`.

## Rodando localmente (com Python + Alembic)

1. Criar e ativar um ambiente virtual:

   ```bash
   cd backend
   python -m venv .venv
   # Windows (PowerShell):
   .venv\Scripts\Activate.ps1
   # Linux/macOS:
   source .venv/bin/activate
   ```

2. Instalar as dependências:

   ```bash
   pip install -r requirements.txt
   ```

3. Criar um arquivo `.env` em `backend/` (não versionado) com, no mínimo:

   ```
   DATABASE_URL=postgresql+psycopg2://usuario:senha@host:5432/nome_do_banco
   SECRET_KEY=uma-chave-secreta-gerada-localmente
   ```

   Outras variáveis suportadas (todas opcionais, ver
   `app/config/settings.py`): `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_ECHO`,
   `FLASK_ENV`, `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

   **Nunca** commite o arquivo `.env` nem credenciais reais.

4. Aplicar as migrações (**em banco descartável**; produção segue o fluxo
   espelho `.sql` + `alembic stamp`, com autorização):

   ```bash
   alembic upgrade head
   ```

5. Para reverter (apenas em desenvolvimento):

   ```bash
   alembic downgrade base
   ```

6. Para gerar uma nova migração a partir de alterações nos modelos:

   ```bash
   alembic revision --autogenerate -m "descrição da alteração"
   ```

   Toda migração nova precisa do espelho `.sql` correspondente (ver a tabela
   acima) e do registro em `docs/database/historico-migracoes.md`.

## Aplicando o schema manualmente via Supabase (sem Python/Alembic)

Quando não houver conectividade Python → Postgres no ambiente, o schema
pode ser aplicado diretamente via **Supabase SQL Editor** (ou MCP do
Supabase), executando, nesta ordem:

1. `0001_initial_schema.sql` — extensões, tipo `asset_located_status` e as
   20 tabelas com índices e constraints.
2. `0002_seeds_roles_permissions.sql` — papéis `ADM`/`USER`/`RH`,
   permissions e `role_permissions` (idempotente, `ON CONFLICT DO NOTHING`).
3. Espelhos de schema na ordem da tabela acima: `0003`, `0004`, `0006`, `0007`,
   `0009`, `0010`, `0011`, `0012`, `0013`, `0014`, `0015`, `0016`, `0017`,
   `0018`, `0019`, `0020`, `0021`, `0022`. O seed
   `0005_seed_security_permissions.sql` (idempotente) exige apenas o `0002` e o
   `0004_invites.sql` já aplicados (pré-requisito declarado no cabeçalho do
   próprio arquivo); não depende do `0006`.

Cada espelho de schema é mantido **semanticamente idêntico** à migração
Alembic correspondente. Qualquer alteração de schema deve ser replicada nos
dois lugares.

**Nota operacional:** no SQL Editor do Supabase o `BEGIN`/`COMMIT` não foi
confiável; executar os `INSERT` dos seeds **sem transação explícita**
funcionou (os seeds são idempotentes, então reexecutar é seguro).
Nenhuma migração deve ser aplicada em produção sem autorização.

## Convenções do schema

- Schema `public`, identificadores em `snake_case` minúsculo.
- Todas as datas/horas são `timestamptz`, tratadas pela aplicação sempre em
  UTC (a interface exibe em America/Araguaina).
- `assets` nunca é apagado fisicamente — exclusão é sempre lógica
  (`deleted_at`/`deleted_by`). As demais tabelas de histórico
  (`asset_movements`, `audit_logs`, `sync_jobs`, `sync_conflicts`,
  `raw_import_records`) também nunca são apagadas.
- `users` também nunca é apagado fisicamente: a exclusão é lógica
  (`deleted_at`/`deleted_by`) e vem sempre acompanhada de anonimização
  (`anonymized_at`), garantida pelo CHECK
  `ck_users_deleted_requires_anonymized` da `0019`. Quatro FKs `RESTRICT`
  apontam para `users.id` (`asset_movements.requested_by`,
  `import_previews.requested_by`, `inventories.created_by`,
  `invites.invited_by`) e o gatilho append-only de `audit_logs` recusa o
  `ON DELETE SET NULL` de `audit_logs.actor_user_id` — por isso a linha precisa
  continuar existindo.
- `assets.version` é usado para controle otimista de concorrência (a
  aplicação deve verificar/incrementar este campo em cada `UPDATE`).
- `assets.patrimony_number` é sempre `TEXT`, nunca numérico/float.
- Autenticação (senha, MFA) é externa (Supabase Auth); nenhuma tabela de
  senha é criada neste schema. `users.auth_user_id` (coluna `text`) referencia o
  usuário no provedor de autenticação; as chaves primárias do schema são `uuid`.
- O controle de acesso por unidade (`user_unit_access`) é aplicado pelo
  backend, não por Row Level Security neste momento — isso pode ser
  revisitado em fase posterior caso o banco passe a ser acessado
  diretamente por clientes (hoje é acessado apenas pelo backend, via
  conexão de serviço).

## E-mail (SMTP) — desligado por padrão

Módulo `app/services/email/` (`address`, `templates`, `sender`, `dispatch`).
Variáveis `EMAIL_*` (ver `.env.example`); só backend/worker as recebem.

- `EMAIL_ENABLED=false` (padrão): `NullEmailSender` — não envia, não falha, sem rede.
- Habilitado: exige HOST/PORT/USER/PASSWORD/FROM; porta 587 (`starttls`) ou 465 (`ssl`);
  25/texto claro recusados; certificado e hostname sempre verificados
  (`ssl.create_default_context()`); login só após TLS; timeout 1–60 s (padrão 10).
- `EMAIL_PASSWORD` é `SecretStr` (fora de repr/dump/log); espaços são removidos.
- `From` vem só das settings; destinatário = 1 endereço simples (sem CR/LF/NUL,
  vírgula, display-name); `EMAIL_ALLOWED_RECIPIENT_DOMAINS` restringe domínios exatos.
- Conteúdo: templates fixos Jinja2 com autoescape; links só da allowlist.
- `send_email_safely(...)` nunca levanta: teto global `EMAIL_MAX_PER_HOUR` (Redis,
  fail-closed), prazo total de execução, eventos `EMAIL_SENT`/`EMAIL_FAILED` em
  `audit_logs` (sem corpo/senha; destinatário mascarado `m***@agu.gov.br`).
- Gmail: exige verificação em duas etapas + senha de app; `EMAIL_FROM` deve ser a conta
  autenticada (ou alias verificado), senão o Gmail reescreve o remetente; limite ~500
  mensagens/dia.
- **Convite e redefinição de senha usam ESTE módulo** desde as correções de
  2026-10-27/28: `app/services/invite_delivery.py` e
  `app/services/password_reset_delivery.py` montam o link
  `?token_hash=...&type=invite|recovery` para `/ativar-conta` a partir de
  `POST /auth/v1/admin/generate_link` (que não envia e-mail) e entregam pelo
  SMTP próprio. O `token_hash` e a URL nunca são logados, auditados nem
  devolvidos ao chamador, e o `redirect_to` é validado contra
  `INVITE_ALLOWED_REDIRECT_URLS` antes de qualquer rede. Motivo: o link de uso
  único dos templates do Supabase era consumido por scanners de antivírus de
  e-mail antes do clique da pessoa (ver
  `docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md` e
  `docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md`).
- Testes: `tests/test_email_*.py`, `tests/test_invite_delivery.py` e
  `tests/test_password_reset_delivery.py` (SMTP mockado, zero rede).

## Testes

```bash
pytest                                   # dentro de backend/, com requirements-dev.txt
../scripts/test-backend.sh               # pytest + cobertura
../scripts/test-backend.sh --venv        # venv isolado, fora do repositório
../scripts/test-backend.sh --docker      # no container (target dev)
../scripts/test-backend.sh -- -k rbac    # argumentos extras para o pytest
```

A suíte **não** acessa Supabase, Google Sheets, n8n nem a VPS: usa o Flask test
client com mocks e `tests/conftest.py` define variáveis **fictícias**. O motor
real dos testes é SQLite, com `sispat_unaccent`/`sispat_alnum_key` registrados em
Python por `app/security/text_search.py`. Consequência: comportamento específico
de PostgreSQL (índices trigram, `unaccent` nativo, CHECKs e gatilhos aplicados no
Supabase) **não** é coberto por pytest.

Última execução registrada em documento deste repositório: `test-backend.sh` com
15 003 testes, 0 falhas e 69 skipped, em Python 3.10 e SQLite — números
informados pela QA em `docs/security/REVISAO_QA_ONDA_C_2026-10-29.md`
(2026-10-29). **Não reexecutada nesta data**; a suíte nunca foi validada em
PostgreSQL nem em Python 3.11+.

## Validação de JWT (HS256 legado + ES256/JWKS)

O projeto Supabase assina com ES256; o backend valida via JWKS
(`app/auth/jwks.py`) e mantém HS256 legado por compatibilidade.

| Variável | Padrão | Descrição |
|---|---|---|
| `SUPABASE_JWT_ALGORITHMS` | `HS256,ES256` | Allowlist (somente HS256/ES256). Use `ES256` para desligar o segredo legado. |
| `SUPABASE_JWT_SECRET` | — | Exigido (>= 32 car. em produção) só se HS256 estiver habilitado. |
| `SUPABASE_JWKS_URL` | `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` | HTTPS obrigatório em produção; sem redirects. |
| `SUPABASE_JWKS_CACHE_SECONDS` | `600` | TTL do cache; `kid` desconhecido => no máx. 1 refetch/30 s. |
| `SUPABASE_JWKS_TIMEOUT_SECONDS` | `3` | Timeout da busca (JWKS indisponível sem cache => 401). |

## E-mail administrativo e correcoes da auditoria de fronteira (2026-10-15)

- `POST /api/v1/settings/email/test` (ADM + AAL2 + `settings.email.manage`, 3/h, fail-closed): corpo vazio
  (`extra="forbid"`), envia SOMENTE ao e-mail do ADM autenticado, resposta generica
  `{"result": "sent"|"disabled"|"failed"}`, auditoria `EMAIL_TEST_REQUESTED`. A permissao
  `settings.email.manage` é semeada pela migração `0006_email_settings_permission`.
- `app/services/security_notifications.py`: eventos com `notify=true` (high/critical) avisam por e-mail os ADMs
  ativos (resolvidos no banco), em thread propria, com throttle de 1 aviso/tipo/5 min e corpo sem dados
  sensiveis. No-op com `EMAIL_ENABLED=false`. `EMAIL_SENT/FAILED` agora ficam em `security_events.py`.
- B-1 rate limit 10/h em imports preview/confirm (600/h em items); B-2 `ImportItemsQuery` + `reject_any_body`
  no preview; B-4 `Flask(static_folder=None)`; B-7 cliente Redis reutilizado por URL (`rate_limit.py`).
- Apoio ao B-3: `POST /api/v1/security/mfa/factor-added-notice` (o frontend chama apos o enroll); ADM em AAL1
  gera o evento HIGH `ADM_TOTP_ENROLL_AAL1`. Fluxo de enroll inalterado.
