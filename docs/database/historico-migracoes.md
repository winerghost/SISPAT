# Históricos de migração (Supabase x Alembic)

Atualizado em 2026-10-29 (reconciliação do estado: carimbo de produção, tabela
completa 0001-0019 e entrada da 0019). Toda seção datada mais abaixo é
**histórico** do dia em que foi escrita e não descreve o estado atual.

> **Estado atual (2026-10-29)**
>
> - **Head do código:** `0019_user_soft_delete`
>   (`backend/migrations/versions/0019_user_soft_delete.py`). Cadeia Alembic
>   **linear** `0001` → `0019`, sem ramificação (conferido nos campos
>   `revision`/`down_revision` de `backend/migrations/versions/*.py`).
> - **`alembic_version` em produção: `0019_user_soft_delete`** — verificado em
>   2026-10-29 por consulta somente-leitura ao Supabase. Ficam **SUPERADAS** as
>   afirmações de "0019 pendente de aplicação", "banco carimbado em 0018" e
>   "falta o `alembic stamp` da 0012/0013" que aparecem nas seções datadas
>   abaixo e nos cabeçalhos de alguns arquivos `.py`/`.sql` (os cabeçalhos
>   guardam o texto do dia em que foram escritos; não foram reescritos).
> - Projeto Supabase único (`tocbtonqnahmtegfkrmn`): **dev = prod**. O padrão de
>   aplicação é o responsável executar o espelho `.sql` no SQL Editor e só
>   depois carimbar (`alembic stamp <revisão>`, **sem** `upgrade`). **Nunca**
>   rodar `alembic upgrade` / `upgrade head` sobre este banco: o DDL já foi
>   aplicado à mão e migração em produção exige autorização explícita.
> - Carimbo em `0019` significa que o Alembic considera 0001-0019 aplicadas. Ele
>   **não prova** que cada objeto exista no esquema: para cada revisão, rode a
>   consulta de verificação da sua seção antes de confiar.
> - Backup obrigatório antes de qualquer reaplicação ou downgrade: ver o
>   `pg_dump` em "Backup antes de reaplicar ou reverter".

## Mapa 0001-0019: espelho `.sql` e estado conferido

A numeração do espelho `.sql` **não** coincide com a do Alembic: a defasagem é de
+1 a partir da 0002, +2 a partir da 0004 e +3 a partir da 0006 (os espelhos
`0002`, `0005` e `0008` não têm migração Alembic correspondente). "DDL conferido" = objeto observado no banco em 2026-10-29 por
consulta somente-leitura (`information_schema` / `pg_indexes` / `pg_proc`);
"a confirmar" = ainda não consultado nesta rodada — use a consulta da seção
correspondente.

| Alembic (`versions/`) | Espelho (`sql/`) | O que entrega | Estado em 2026-10-29 |
|---|---|---|---|
| `0001_initial_schema` | `0001_initial_schema.sql` | 20 tabelas iniciais, extensões (`pg_trgm`), índices (inclui `ix_assets_description_trgm`) | carimbada; `ix_assets_description_trgm` conferido |
| `0002_import_previews` | `0003_import_previews.sql` | `import_previews`, `import_preview_items` | carimbada; tabelas conferidas (2026-10-30) |
| `0003_invites` | `0004_invites.sql` | `invites`, `invite_units` | carimbada; tabelas conferidas (2026-10-30) |
| `0004_db_security_hardening` | `0006_db_security_hardening.sql` | append-only de `audit_logs`, bloqueio de DELETE/TRUNCATE, RLS + `REVOKE` | carimbada; gatilhos `trg_audit_logs_block_update_delete` e `trg_audit_logs_block_truncate` conferidos (2026-10-30) |
| `0005_settings_ai_users` | `0007_settings_ai_users.sql` | `ai_settings`, `user_preferences`; colunas `users.version`, `sessions_revoked_at`, `avatar_object_key`, `deactivated_at/by` | carimbada; tabelas e as 5 colunas de `users` conferidas (2026-10-30) |
| `0006_email_settings_permission` | `0009_email_settings_permission.sql` | permissão `settings.email.manage` (só ADM) | carimbada; seed conferido — `settings.email.manage` só no ADM (2026-10-30) |
| `0007_unit_aliases` | `0010_unit_aliases.sql` | `unit_aliases` | carimbada; `unit_aliases` conferida (2026-10-30) |
| `0008_catalog_source_ids_perms` | `0011_catalog_source_ids_permissions.sql` | IDs de origem dos cadastros, `users.phone`, `responsible_people.phone` e CHECKs de formato | carimbada; `users.phone`, `responsible_people.phone` e `assets.source_*` conferidos (2026-10-30) |
| `0009_uniq_idx_assets_movements` | `0012_unique_indexes_assets_movements.sql` | índices únicos de bens/movimentações | carimbada; `uq_assets_patrimony_number_active` e `uq_asset_movements_one_pending` conferidos (2026-10-30) |
| `0010_seed_permission_corrections` | `0013_seed_permission_corrections.sql` | correções de seed de permissões | carimbada; seed efetivo — USER sem `rooms.manage`/`inventory.create` (2026-10-30) |
| `0011_dashboard_charts_prefs` | `0014_user_preferences_dashboard_charts.sql` | `user_preferences.dashboard_charts` + 2 CHECKs | carimbada; coluna conferida |
| `0012_asset_bond_status` | `0015_asset_bond_status.sql` | `assets.bond_status`, CHECK de tamanho, `ix_assets_bond_status_lower`, backfill do vínculo | carimbada; coluna e `ix_assets_bond_status_lower` conferidos (2026-10-30) |
| `0013_dashboard_layout_prefs` | `0016_dashboard_layout_prefs.sql` | `user_preferences.dashboard_layout` + 2 CHECKs | carimbada; coluna conferida |
| `0014_unaccent_search` | `0017_unaccent_search.sql` | extensão `unaccent` + função `public.sispat_unaccent(text)` | carimbada; `public.sispat_unaccent` conferida (2026-10-30) |
| `0015_asset_tech_classification` | `0018_asset_tech_classification.sql` | `assets.asset_category`, `tech_type`, `operational_status`, 3 CHECKs, `ix_assets_category_active` | carimbada; as 3 colunas e `ix_assets_category_active` conferidos (2026-10-30) |
| `0016_asset_search_key` | `0019_asset_search_key.sql` | função `public.sispat_alnum_key(text)` + `ix_assets_patrimony_key_trgm` (**nenhuma coluna nova**) | carimbada; função e índice conferidos |
| `0017_dashboard_panel_prefs` | `0020_dashboard_panel_prefs.sql` | tabela `user_dashboard_preferences` (4 CHECKs, RLS deny-all) + migração do layout legado | carimbada; tabela conferida |
| `0018_equipment_classification` | `0021_equipment_classification.sql` | 6 colunas de classificação em `assets`, 6 CHECKs, `ix_assets_equipment_active` | carimbada; as 6 colunas e `ix_assets_equipment_active` conferidos (2026-10-30) |
| `0019_user_soft_delete` | `0022_user_soft_delete.sql` | `users.deleted_at`, `deleted_by`, `anonymized_at`, CHECK e permissão `users.delete` | carimbada; as 3 colunas e a permissão `users.delete` (só ADM) conferidas (2026-10-30) |

Fora da cadeia Alembic (aplicados à mão, idempotentes): `sql/0002_seeds_roles_permissions.sql`,
`sql/0005_seed_security_permissions.sql` e `sql/0008_storage_avatars.sql` (script do
Supabase Storage). A tabela equivalente em `backend/README.md` só vai até a 0013 e
está defasada.

## Backup antes de reaplicar ou reverter

Sem credenciais no comando: a URL de conexão vem de variável de ambiente local,
nunca versionada.

```bash
pg_dump "$SUPABASE_DB_URL" --schema=public --format=custom \
  --file=sispat_public_$(date -u +%Y%m%dT%H%M%SZ).dump
```

Verificação do carimbo: `SELECT version_num FROM alembic_version;`
(esperado hoje: `0019_user_soft_delete`).

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

## Alembic 0014 – busca sem acento (`unaccent` + `sispat_unaccent`)

`0014_unaccent_search` (`versions/0014_unaccent_search.py`; espelho
`sql/0017_unaccent_search.sql`; depende de `0013_dashboard_layout_prefs`).
Aditiva e idempotente, sem tocar em tabela, coluna ou dado:

- `CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions`;
- função `public.sispat_unaccent(text)` (`LANGUAGE sql`, `IMMUTABLE`,
  `PARALLEL SAFE`, `STRICT`, `SET search_path = extensions, pg_catalog`), que
  encapsula `extensions.unaccent`.

`app.security.text_search` **chama** a função: o DDL precisa existir ANTES do
deploy do backend. O cabeçalho do arquivo e do espelho ainda dizem "NAO aplicada
em producao" (texto de 2026-10-21); hoje a revisão está coberta pelo carimbo
`0019`. A existência da função é **fortemente indicada** pelo fato de
`public.sispat_alnum_key` (0016) existir no banco — o corpo dela referencia
`public.sispat_unaccent` e não seria criado sem ela —, mas não foi consultada
diretamente nesta rodada: **a confirmar** com

```sql
SELECT proname FROM pg_proc WHERE proname = 'sispat_unaccent';            -- esperado: 1 linha
SELECT extname FROM pg_extension WHERE extname = 'unaccent';              -- esperado: 1 linha
```

Downgrade: `alembic downgrade 0013_dashboard_layout_prefs` (ou, no SQL Editor,
`DROP FUNCTION IF EXISTS public.sispat_unaccent(text);`) — a extensão
`unaccent` NÃO é removida pelo downgrade. **Atenção:** remover a função derruba
`sispat_alnum_key`/`ix_assets_patrimony_key_trgm` (0016) e a busca de bens;
reverta primeiro a 0016. `pg_dump` antes (ver "Backup antes de reaplicar ou
reverter") e só com autorização explícita.

## Alembic 0015 – classificação técnica de bens (APLICADA; sem backfill)

`0015_asset_tech_classification` (`versions/0015_asset_tech_classification.py`;
espelho `sql/0018_asset_tech_classification.sql`, sem `BEGIN`/`COMMIT`; depende
de `0014_unaccent_search`). Escrita em 2026-10-22 como "PENDENTE DE APLICACAO" —
rótulo que o cabeçalho do arquivo e do espelho ainda carregam. **Estado em
2026-10-29:** coberta pelo carimbo `0019` e as três colunas foram observadas no
banco (`assets.asset_category`, `assets.tech_type`, `assets.operational_status`).

Aditiva, idempotente e sem backfill (a classificação inicial é o comando
`flask classify-assets`, dry-run por padrão):

- colunas `asset_category`, `tech_type`, `operational_status` (`text NULL`, sem
  default: `NULL` = "não informado", nunca um valor fictício);
- CHECK `ck_assets_asset_category`
  (`TECNOLOGIA`/`MOBILIARIO`/`VEICULO`/`EQUIPAMENTO`/`OUTROS`);
- CHECK `ck_assets_tech_type`
  (`COMPUTADOR`/`NOTEBOOK`/`MONITOR`/`IMPRESSORA`/`OUTRO_TI`, e **somente**
  quando `asset_category = 'TECNOLOGIA'`);
- CHECK `ck_assets_operational_status`
  (`EM_USO`/`ESTOQUE`/`MANUTENCAO`/`BAIXADO`);
- índice parcial `ix_assets_category_active` em
  `(asset_category, tech_type, unit_id) WHERE deleted_at IS NULL AND asset_category IS NOT NULL`
  — **a confirmar** no banco.

Nenhuma tabela nova (RLS/`REVOKE` de `assets` vêm da 0004). O CHECK de tamanho de
`dashboard_layout` (1024 bytes) não mudou (15 ids cabem). Detalhes de uso nos
painéis: `docs/architecture/dashboard-api.md`.

Downgrade: `alembic downgrade 0014_unaccent_search` (ou o `DOWNGRADE_SQL` do
arquivo no SQL Editor) — remove índice, os 3 CHECKs e as 3 colunas; perde-se a
classificação técnica gravada. `pg_dump` antes; nunca em produção sem
autorização.

Verificação:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'assets'
  AND column_name IN ('asset_category','tech_type','operational_status'); -- 3 linhas, text/YES/NULL
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.assets'::regclass
  AND conname IN ('ck_assets_asset_category','ck_assets_tech_type',
                  'ck_assets_operational_status');                        -- 3 linhas
SELECT indexname FROM pg_indexes WHERE indexname = 'ix_assets_category_active'; -- 1 linha
```

## Estado do carimbo e numeração (Onda 5, 2026-10-27) — HISTÓRICO

> **SUPERADO em 2026-10-29:** o carimbo do banco hoje é `0019_user_soft_delete`
> (ver "Estado atual" no topo). O que segue abaixo é o registro do dia
> 2026-10-27; a orientação de **nunca** rodar `alembic upgrade` neste banco e de
> sempre recompor o carimbo com `alembic stamp` continua valendo.

> **`alembic_version` do banco = `0018_equipment_classification`**, definido por
> `UPDATE` MANUAL (informado pelo responsável; não foi verificado nesta rodada). O
> DDL das revisões 0016, 0017 e 0018 foi aplicado pelos espelhos `.sql` no SQL Editor.
> **NUNCA rodar `alembic upgrade` (nem `upgrade head`) sobre este banco**: o DDL já foi
> aplicado à mão e a regra do projeto é não executar migração em produção sem
> autorização explícita. Recompor o carimbo, se preciso, é sempre `alembic stamp
> <revisão>` (sem DDL). O carimbo em 0018 NÃO prova que 0013-0016 estejam
> no esquema: confira com as consultas de verificação de cada entrada antes de confiar.
> A divergência de numeração é esperada: o ID Alembic e o prefixo do espelho `.sql`
> diferem (0016 -> `sql/0019`, 0017 -> `sql/0020`, 0018 -> `sql/0021`).

Backup antes de qualquer reaplicação ou downgrade (sem credenciais no comando; a URL de
conexão vem de variável de ambiente local, nunca versionada):

```bash
pg_dump "$SUPABASE_DB_URL" --schema=public --format=custom \
  --file=sispat_public_$(date -u +%Y%m%dT%H%M%SZ).dump
```

Verificação do carimbo: `SELECT version_num FROM alembic_version;` (esperado
`0018_equipment_classification`).

## Alembic 0016 – chave alfanumérica do patrimônio (`sispat_alnum_key`)

`0016_asset_search_key` (arquivo `backend/migrations/versions/0016_asset_search_key.py`;
espelho `backend/migrations/sql/0019_asset_search_key.sql`; depende de
`0015_asset_tech_classification`, da função `public.sispat_unaccent` da 0014 e da
extensão `pg_trgm`). Aditiva e idempotente, sem alterar dados nem tabelas:

- função `public.sispat_alnum_key(text)` (`IMMUTABLE`, `PARALLEL SAFE`, `STRICT`,
  `search_path = extensions, pg_catalog`): minúsculas, sem acento e sem
  pontuação/espaços;
- índice GIN trigram funcional `ix_assets_patrimony_key_trgm` sobre
  `sispat_alnum_key(patrimony_number)`.
- **NÃO cria a coluna `search_key`** (a busca usa a função/índice funcional, nada é
  persistido em `assets`).

Uso: `GET /assets?q=` casa `AGU-123`, `12.345`, `AB 123` com `AGU123`, `12345`, `AB-123`.
O backend chama a função: o DDL precisa existir ANTES do deploy do backend.
Rollback: `alembic downgrade 0015_asset_tech_classification` (ou, no SQL Editor,
`DROP INDEX IF EXISTS public.ix_assets_patrimony_key_trgm; DROP FUNCTION IF EXISTS
public.sispat_alnum_key(text);`). Perde apenas índice e função. Backup: `pg_dump` acima.
Os cabeçalhos do arquivo e do espelho ainda dizem "PENDENTE DE APLICAÇÃO" (texto de
quando foram escritos). **Confirmado em 2026-10-29:** a função `sispat_alnum_key` e o
índice `ix_assets_patrimony_key_trgm` existem no banco, e **não existe** coluna
`assets.search_key` (não é criada por esta nem por nenhuma outra migração). Consultas:

```sql
SELECT proname FROM pg_proc WHERE proname = 'sispat_alnum_key';                  -- 1 linha
SELECT indexname FROM pg_indexes WHERE indexname = 'ix_assets_patrimony_key_trgm'; -- 1 linha
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'assets'
  AND column_name = 'search_key';                                               -- 0 linhas
```

## Alembic 0017 – `user_dashboard_preferences` (APLICADA 2026-10-27)

`0017_dashboard_panel_prefs` (`versions/0017_dashboard_panel_prefs.py`; espelho
`sql/0020_dashboard_panel_prefs.sql`; depende de 0016). **Aplicada manualmente no
Supabase em 2026-10-27, com autorização explícita**, pelo SQL Editor. Cria a tabela
NOVA `user_dashboard_preferences` (PK/FK `user_id` -> `users(id)` `ON DELETE CASCADE`,
`panels jsonb NOT NULL DEFAULT '[]'`, `version integer NOT NULL DEFAULT 1`,
`created_at`/`updated_at` `timestamptz`), com quatro CHECKs
(`ck_user_dashboard_preferences_panels_array`, `_panels_count` <= 32 itens,
`_panels_size` <= 2048 bytes, `_version` >= 1). **RLS habilitado SEM políticas
(deny-all)** e `REVOKE ALL` de `anon`/`authenticated` (condicional à existência das
roles). Também migra `user_preferences.dashboard_layout` para a tabela nova pelos cinco
ids com correspondente (`kpis`, `tech_summary`, `tech_units`, `units`, `tech_category`);
os outros dez são descartados; `INSERT ... ON CONFLICT (user_id) DO NOTHING`. Resultado
registrado na aplicação: 0 linhas inseridas. O DDL está CONGELADO.
Rollback: `alembic downgrade 0016_asset_search_key` (remove só a tabela; a coluna
`user_preferences.dashboard_layout` permanece). Só com autorização, após `pg_dump`.

Verificação:

```sql
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_dashboard_preferences'::regclass; -- true
SELECT count(*) FROM pg_policies WHERE tablename = 'user_dashboard_preferences';              -- 0
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.user_dashboard_preferences'::regclass AND contype = 'c';             -- 4 CHECKs
```

## Alembic 0018 – classificação de equipamentos (APLICADA 2026-10-27, SEM backfill)

`0018_equipment_classification` (`versions/0018_equipment_classification.py`; espelho
`sql/0021_equipment_classification.sql`; depende de 0017; era a HEAD do código em
2026-10-27 — hoje a head é `0019_user_soft_delete`). DDL aplicado no Supabase em
2026-10-27 pelo espelho, com autorização; o `alembic_version` ficou em 0018 naquele dia e
hoje está em 0019 (ver "Estado atual"). Aditiva e idempotente, sem backfill:

- **6 colunas** em `assets`, todas `text NULL` sem default: `equipment_family`,
  `equipment_category`, `classification_confidence`, `classification_rule`,
  `classification_rules_version`, `category_override`;
- **6 CHECKs** (o código tem seis, não cinco): `ck_assets_equipment_family`,
  `ck_assets_equipment_category` (categoria só na família correta),
  `ck_assets_classification_confidence` (ALTA/BAIXA), `ck_assets_category_override` (as
  20 categorias), `ck_assets_classification_rule_len` (1..64, sem espaços nas pontas) e
  `ck_assets_classification_rules_version_len` (1..16). Os quatro primeiros espelham as
  tuplas de `app.services.asset_classification`; o teste
  `test_asset_classification_migration.py` garante a igualdade;
- índice parcial `ix_assets_equipment_active` em `(equipment_family, equipment_category,
  unit_id) WHERE deleted_at IS NULL AND equipment_category IS NOT NULL`;
- nenhuma tabela nova (RLS/REVOKE de `assets` já vêm da 0004).

Estado dos dados em 2026-10-27 (data da aplicação): colunas todas NULL até o backfill/1ª
importação — a distribuição de hoje não foi medida nesta rodada; use a última consulta
desta seção. Para **acrescentar uma regra nova de classificação** (onde editar, ordem de
prioridade das regras, teste a criar e como medir o impacto em dry-run antes de aplicar),
siga `docs/architecture/classificacao-patrimonial.md` — nenhuma regra nova exige migração
enquanto a família/categoria já estiver nos CHECKs acima; se exigir um valor novo, ele
entra por **nova** migração Alembic + espelho, porque os CHECKs são fechados.
Rollback: `alembic downgrade 0017_dashboard_panel_prefs` (ou o `DOWNGRADE_SQL` do arquivo
no SQL Editor): remove índice, CHECKs e as 6 colunas — PERDE a classificação e, sobretudo,
os overrides manuais do ADM (`category_override`; só ficam os registros em `audit_logs`). Faça
`pg_dump` antes e nunca em produção sem autorização.

Verificação:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'assets'
  AND column_name IN ('equipment_family','equipment_category','classification_confidence',
                      'classification_rule','classification_rules_version','category_override'); -- 6 linhas
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.assets'::regclass AND conname LIKE 'ck_assets_%'
  AND conname IN ('ck_assets_equipment_family','ck_assets_equipment_category',
                  'ck_assets_classification_confidence','ck_assets_category_override',
                  'ck_assets_classification_rule_len','ck_assets_classification_rules_version_len'); -- 6 linhas
SELECT indexname FROM pg_indexes WHERE indexname = 'ix_assets_equipment_active';                 -- 1 linha
SELECT count(*) FILTER (WHERE equipment_category IS NULL) AS sem_classificacao,
       count(*) AS total FROM public.assets WHERE deleted_at IS NULL;   -- antes do backfill: sem = total
```

## Alembic 0019 – exclusão lógica + anonimização de usuários (HEAD; carimbada em produção)

`0019_user_soft_delete` (`versions/0019_user_soft_delete.py`; espelho
`sql/0022_user_soft_delete.sql`, sem `BEGIN`/`COMMIT`; depende de
`0018_equipment_classification`). **HEAD do código.** Escrita em 2026-10-28 com o
cabeçalho "PENDENTE DE APLICAÇÃO" — rótulo que os dois arquivos ainda carregam.
**Estado em 2026-10-29:** `alembic_version` = `0019_user_soft_delete` e as três
colunas novas foram observadas no banco (`users.deleted_at`, `users.deleted_by`,
`users.anonymized_at`).

O que cria (aditivo, idempotente e **sem backfill** — as três colunas ficam `NULL`;
nenhuma linha preexistente é alterada):

- `users.deleted_at timestamptz NULL` — instante da exclusão lógica. Toda consulta
  de usuário passa a filtrar `deleted_at IS NULL` e `require_auth` responde 401 a
  JWT de usuário excluído;
- `users.deleted_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL` — o
  ADM que executou (mesmo padrão de `deactivated_by`, da 0005);
- `users.anonymized_at timestamptz NULL` — instante da anonimização irreversível de
  `name`/`email`/`phone`/`avatar_object_key`/`auth_user_id`/`last_login_at`
  (`backend/app/services/user_deletion_service.py`). Nenhuma cópia do dado removido
  é guardada: `audit_logs` recebe apenas o e-mail **mascarado**;
- CHECK `ck_users_deleted_requires_anonymized`
  (`deleted_at IS NULL OR anonymized_at IS NOT NULL`) — exclusão lógica sempre vem
  acompanhada de anonimização. Deliberadamente **não** se usou um CHECK sobre
  `deleted_by`, porque aquela coluna pode virar `NULL` por `ON DELETE SET NULL`;
- permissão `users.delete` ligada **exclusivamente** ao papel ADM (exigida por
  `POST /api/v1/users/<id>/delete`, que também exige AAL2 e confirmação textual).

Nenhuma tabela nova (RLS/`REVOKE` de `users` vêm da 0004), nenhuma unicidade
alterada: `users.email` continua `NOT NULL UNIQUE` e a anonimização grava um
endereço único e não roteável derivado do `id` (domínio `.invalid`, RFC 2606), o que
libera o e-mail **original** para um convite futuro.

**Idempotência:** `ADD COLUMN IF NOT EXISTS` nas três colunas, bloco `DO $do$` que
só cria o CHECK se ele ainda não existir e `INSERT ... ON CONFLICT DO NOTHING` na
permissão e no vínculo com o ADM. Reexecutar o espelho é seguro.

**Ordem de implantação (obrigatória):** aplicar o DDL **ANTES** de subir a imagem
nova do backend. `app.models.rbac.User` declara as três colunas e a consulta de
autenticação (`app.auth.supabase_auth`) as seleciona; com o código novo e o banco
sem as colunas, **toda** requisição autenticada falharia (mesma classe de problema
do PREDEPLOY-01, quando `phone` foi adicionado). Nenhuma FK `RESTRICT`, gatilho ou
RLS é removido ou relaxado: a exclusão **física** de `users` continua impossível
(`asset_movements.requested_by`, `import_previews.requested_by`,
`inventories.created_by`, `invites.invited_by` são `RESTRICT`, e o gatilho
append-only `trg_audit_logs_block_update_delete` recusa o `UPDATE` que o
`ON DELETE SET NULL` de `audit_logs.actor_user_id` exigiria). A trilha de auditoria
do usuário excluído permanece intacta, com `actor_user_id` **preservado** — é por
isso que a linha de `users` precisa continuar existindo.

**Backup antes de qualquer reversão:** o `pg_dump` de "Backup antes de reaplicar ou
reverter".

**Downgrade:** `alembic downgrade 0018_equipment_classification` (ou o
`DOWNGRADE_SQL` do arquivo no SQL Editor) — remove só a permissão `users.delete` e
seu vínculo, o CHECK e as três colunas. Nenhuma linha de `users` ou de `audit_logs`
é apagada. Perde-se a marcação de quem excluiu e quando; a anonimização, por
definição, **não** é reversível. Nunca em produção sem autorização explícita.

Verificação:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
  AND column_name IN ('deleted_at','deleted_by','anonymized_at');   -- 3 linhas, todas YES
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.users'::regclass
  AND conname = 'ck_users_deleted_requires_anonymized';             -- 1 linha
SELECT r.code AS role, p.code
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE p.code = 'users.delete';                                      -- esperado: 1 linha, role = ADM
SELECT version_num FROM alembic_version;                            -- esperado: 0019_user_soft_delete
```
