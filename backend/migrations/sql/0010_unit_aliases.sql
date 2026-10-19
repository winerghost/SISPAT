-- SISPAT-AGU - Tabela unit_aliases (siglas de unidade da planilha -> units)
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado em banco
-- algum (nem Supabase de produção).
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0007_unit_aliases.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisito: 0009_email_settings_permission.sql (Alembic 0006) e as
-- tabelas units/users (0001). Idempotente e aditivo. Sem BEGIN/COMMIT: no SQL
-- Editor do Supabase a transação explícita não gravou (ver backend/README.md).
-- Seed: PF/PU/CJU/UEA -> codes 023401..023404 (unidade inexistente é ignorada).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.


CREATE TABLE IF NOT EXISTS public.unit_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alias text NOT NULL,
    unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT ck_unit_aliases_alias_length CHECK (char_length(alias) BETWEEN 1 AND 32),
    CONSTRAINT ck_unit_aliases_alias_trimmed CHECK (alias = btrim(alias))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_aliases_alias_lower
    ON public.unit_aliases (lower(alias));

CREATE INDEX IF NOT EXISTS ix_unit_aliases_unit_id
    ON public.unit_aliases (unit_id);

COMMENT ON TABLE public.unit_aliases IS
    'Siglas de unidade usadas na planilha de origem (coluna UNIDADE) -> units. Unicidade case-insensitive.';

ALTER TABLE public.unit_aliases ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.unit_aliases FROM anon, authenticated;
    END IF;
END
$do$;

INSERT INTO public.unit_aliases (alias, unit_id)
SELECT v.alias, u.id
FROM (VALUES ('PF', '023401'), ('PU', '023402'), ('CJU', '023403'), ('UEA', '023404')) AS v(alias, code)
JOIN public.units u ON u.code = v.code
ON CONFLICT DO NOTHING;
