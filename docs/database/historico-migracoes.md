# Históricos de migração (Supabase x Alembic)

Atualizado em 2026-10-20.

> **Estado atual (2026-10-20):** `alembic_version` = `0011_dashboard_charts_prefs`
> (head), carimbado no deploy da VPS com `alembic stamp` (sem DDL). O esquema
> real já continha 0007-0011, aplicadas manualmente pelos espelhos `.sql`. A
> seção "Estado em produção" abaixo é histórica (2026-10-15).

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
