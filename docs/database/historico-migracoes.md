# Históricos de migração (Supabase x Alembic)

Atualizado em 2026-10-20.

> **Estado atual (2026-10-20):** `alembic_version` = `0011_dashboard_charts_prefs`
> (head), carimbado no deploy da VPS com `alembic stamp` (sem DDL). O esquema
> real já continha 0007-0011, aplicadas manualmente pelos espelhos `.sql`. A
> seção "Estado em produção" abaixo é histórica (2026-10-15). A head do código
> passou por `0012_asset_bond_status`, **aplicada no SQL Editor em
> 2026-10-20** (falta o `alembic stamp 0012_asset_bond_status` na VPS), e agora
> é `0013_dashboard_layout_prefs`, **aplicada no SQL Editor em 2026-10-21**
> (falta o `alembic stamp 0013_dashboard_layout_prefs` na VPS).

## Dois históricos distintos

O banco possui dois registros de migração independentes:

- `supabase_migrations` — histórico do Supabase (migrações aplicadas pelo
  painel/MCP/CLI do Supabase).
- `alembic_version` — histórico do Alembic do projeto (`backend/migrations`).

**O Alembic é a fonte de verdade** do schema. Os espelhos em
`backend/migrations/sql/` existem para aplicação manual e devem permanecer
semanticamente idênticos às migrações Alembic (mapeamento em
`backend/README.md`). As divergências entre os dois históricos são esperadas
e não devem ser "corrigidas" apagando registros.

## Propostas pendentes (NÃO aplicadas)

Dependem de autorização explícita e de migração Alembic versionada + espelho:

1. `ALTER TABLE public.alembic_version ENABLE ROW LEVEL SECURITY;`
2. `CREATE INDEX ix_invites_revoked_by ON invites (revoked_by);`

## Estado em produção (histórico, 2026-10-15)

Alembic aplicado até `0005_settings_ai_users` (conforme registrado em
2026-10-15). `0006_email_settings_permission` (head atual) está **escrita e
pendente de aplicação**: semeia a permissão `settings.email.manage` e a
vincula somente ao ADM (aditiva, idempotente, `ON CONFLICT DO NOTHING`).
Espelho SQL: `backend/migrations/sql/0009_email_settings_permission.sql`
(sem `BEGIN`/`COMMIT`). Downgrade remove só essa permissão e seu vínculo.

Aplicar: `cd backend; alembic upgrade head`.

Verificação pós-aplicação:

```sql
SELECT r.code AS role, p.code
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE p.code = 'settings.email.manage';   -- esperado: 1 linha, role = ADM
SELECT version_num FROM alembic_version;  -- esperado: 0006_email_settings_permission
```

## Alembic 0011 – user_preferences.dashboard_charts (APLICADA)

`0011_dashboard_charts_prefs` (head atual no código) foi aplicada
manualmente no Supabase (projeto único, dev = prod) pelo responsável em
2026-10-19, com autorização explícita, via SQL Editor (conteúdo do espelho
abaixo). O carimbo `alembic_version` NÃO foi alterado na aplicação: no deploy,
usar `alembic stamp 0011_dashboard_charts_prefs` (sem `upgrade`).
Aditiva e idempotente: coluna
`dashboard_charts jsonb NOT NULL DEFAULT '{}'` em `user_preferences`, com
CHECKs `ck_user_preferences_dashboard_charts_object` (objeto JSON) e
`ck_user_preferences_dashboard_charts_size` (texto <= 512 bytes). Espelho SQL:
`backend/migrations/sql/0014_user_preferences_dashboard_charts.sql`. Downgrade
remove os CHECKs e a coluna.

## Alembic 0012 – assets.bond_status (APLICADA)

**Aplicada em 2026-10-20** pelo responsável, com autorização, pelo SQL Editor
(espelho `0015`). Antes da importação de bens, portanto o backfill não tinha
linhas a preencher. Pendente: na VPS, `alembic stamp 0012_asset_bond_status`
(sem `upgrade`), junto do deploy do backend que usa a coluna.

`0012_asset_bond_status` (head no código; o banco segue em
`0011_dashboard_charts_prefs`) cria o campo "Vínculo" do bem: valor da 1ª
coluna `RESPONSAVEL` da planilha (ex.: Servidor, Terceirizado, Ocioso), que
até aqui só existia em `raw_import_records.normalized_values->>'vinculo_situacao'`.
Aditiva e idempotente:

- coluna `assets.bond_status text NULL` (sem default);
- CHECK `ck_assets_bond_status_len`: NULL ou 1..64 caracteres, sem espaços nas pontas;
- índice `ix_assets_bond_status_lower` em `lower(bond_status)` `WHERE deleted_at IS NULL`;
- backfill só onde `bond_status IS NULL`, a partir do registro bruto
  `IMPORTADO` mais recente (`created_at DESC, id DESC`) do mesmo
  `source_record_id`, origem `google_sheets`. O texto é normalizado (espaços
  colapsados, truncado em 64 caracteres, `btrim` por último); vazio não grava.
  Não incrementa `assets.version`.

Espelho SQL: `backend/migrations/sql/0015_asset_bond_status.sql`. Downgrade
remove índice, CHECK e coluna (o valor de origem continua em
`raw_import_records`).

**Aplicar somente com autorização explícita** (Supabase é projeto único,
dev = prod), após conferir o backup:

- SQL Editor do Supabase com o conteúdo do espelho `0015` e, depois, na VPS,
  `alembic stamp 0012_asset_bond_status` (sem `upgrade`); **ou**
- na VPS: `cd backend; alembic upgrade head` (executa DDL + backfill e grava a
  versão).

Verificação pós-aplicação:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'assets'
  AND column_name = 'bond_status';          -- text, YES, NULL
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.assets'::regclass
  AND conname = 'ck_assets_bond_status_len'; -- 1 linha
SELECT indexdef FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'ix_assets_bond_status_lower';
SELECT bond_status, count(*) AS bens
FROM public.assets
WHERE deleted_at IS NULL
GROUP BY bond_status ORDER BY bens DESC;    -- distribuição por vínculo (NULL = sem valor)
SELECT version_num FROM alembic_version;    -- esperado: 0012_asset_bond_status
```

## Alembic 0013 – user_preferences.dashboard_layout (APLICADA 2026-10-21)

**APLICADA manualmente no Supabase em 2026-10-21**, com autorização explícita,
via o espelho `backend/migrations/sql/0016_dashboard_layout_prefs.sql` (SQL
Editor). Na VPS: `alembic stamp 0013_dashboard_layout_prefs` (sem `upgrade`).
Depende de `0012_asset_bond_status`.

Guarda a ordem e a visibilidade dos painéis do dashboard por usuário. Mesmo
padrão da 0011, aditiva e idempotente:

- coluna `user_preferences.dashboard_layout jsonb NOT NULL DEFAULT '{}'::jsonb`
  (`{}` = layout padrão; linhas existentes recebem `{}`);
- CHECK `ck_user_preferences_dashboard_layout_object` (`jsonb_typeof = 'object'`);
- CHECK `ck_user_preferences_dashboard_layout_size` (texto <= 1024 bytes).

O conteúdo (`{"order": [...], "hidden": [...]}`, IDs de painel de uma
allowlist fechada) é validado no backend (`DashboardLayoutPatch` em
`app/api/v1/schemas.py`); o pior caso persistido tem ~220 bytes. Nenhuma tabela
nova (RLS/REVOKE de `user_preferences` já vêm da 0005). Downgrade remove os
dois CHECKs e a coluna (perde só esta preferência).

**Compatibilidade de deploy:** o backend que lê/grava `dashboard_layout` só
pode subir DEPOIS de a coluna existir; com o código novo e o banco sem a
coluna, `GET/PATCH /api/v1/me/preferences` falha (coluna inexistente).

Verificação pós-aplicação:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_preferences'
  AND column_name = 'dashboard_layout';     -- jsonb, NO, '{}'::jsonb
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.user_preferences'::regclass
  AND conname LIKE 'ck_user_preferences_dashboard_layout_%'; -- 2 linhas
SELECT version_num FROM alembic_version;    -- após o stamp: 0013_dashboard_layout_prefs
```

## IDs de revisão encurtados (2026-10-20)

`alembic_version.version_num` é `varchar(32)`. No deploy, o `stamp` da antiga
`0011_user_preferences_dashboard_charts` (38 caracteres) falhou com
`StringDataRightTruncation`; a transação foi desfeita e o banco ficou em `0006`.
Como nenhuma das revisões abaixo tinha sido gravada em `alembic_version`, os IDs
foram encurtados (os nomes de arquivo não mudaram):

| ID antigo | ID novo |
|---|---|
| `0008_catalog_source_ids_permissions` | `0008_catalog_source_ids_perms` |
| `0009_unique_indexes_assets_movements` | `0009_uniq_idx_assets_movements` |
| `0011_user_preferences_dashboard_charts` | `0011_dashboard_charts_prefs` |

Regressão: `test_db_alembic_revision_ids_cabem_em_alembic_version` em
`backend/tests/test_db_static.py` (todo ID com no máximo 32 caracteres).

## Carimbo no deploy (2026-10-20)

Na VPS, com autorização do responsável e após conferir o backup do Supabase:
`alembic current` -> `0006_email_settings_permission`;
`alembic stamp 0011_dashboard_charts_prefs` ->
`Running stamp_revision 0006_email_settings_permission -> 0011_dashboard_charts_prefs`;
`alembic current` -> `0011_dashboard_charts_prefs (head)`. Nenhum DDL executado.

## 0015_asset_tech_classification (2026-10-22) - PENDENTE DE APLICACAO

Aditiva e reversivel: colunas `assets.asset_category`, `assets.tech_type`,
`assets.operational_status` (`text NULL`, sem default), 3 CHECKs fechados e o indice
parcial `ix_assets_category_active`. Espelho: `backend/migrations/sql/0018_asset_tech_classification.sql`
(cabecalho "PENDENTE DE APLICACAO", sem BEGIN/COMMIT). Sem backfill (a classificacao
inicial e o comando `flask classify-assets`, dry-run por padrao). NAO aplicada em banco
algum (o Supabase e unico: dev = prod); so com autorizacao, executar o espelho e depois
`alembic stamp 0015_asset_tech_classification`. Downgrade remove apenas o que criou.
O CHECK de tamanho de `dashboard_layout` (1024) nao mudou (15 ids cabem). Detalhes:
`docs/architecture/dashboard-api.md`.
