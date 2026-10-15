# Históricos de migração (Supabase x Alembic)

Atualizado em 2026-10-14.

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

## Estado em produção

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
