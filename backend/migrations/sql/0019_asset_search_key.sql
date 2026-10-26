-- SISPAT-AGU - assets: chave alfanumérica do número patrimonial (busca)
--
-- PENDENTE DE APLICAÇÃO: NÃO executar em banco algum sem autorização
-- explícita (o Supabase é único: dev = prod). Quando autorizada, rodar este
-- espelho no SQL Editor e, no deploy, usar
-- `alembic stamp 0016_asset_search_key` (sem upgrade).
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0016_asset_search_key.py -- o teste
-- backend/tests/test_assets_search.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Requer 0017_unaccent_search.sql (public.sispat_unaccent) e pg_trgm.
-- Aditiva/idempotente; nenhum dado ou tabela alterado. Aplicar ANTES do
-- deploy do backend (a consulta nova chama sispat_alnum_key).
--
-- Rollback: DROP INDEX IF EXISTS public.ix_assets_patrimony_key_trgm;
--           DROP FUNCTION IF EXISTS public.sispat_alnum_key(text);

CREATE OR REPLACE FUNCTION public.sispat_alnum_key(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = extensions, pg_catalog
AS $$ SELECT lower(regexp_replace(public.sispat_unaccent($1), '[^[:alnum:]]+', '', 'g')) $$;

CREATE INDEX IF NOT EXISTS ix_assets_patrimony_key_trgm
    ON public.assets USING gin (public.sispat_alnum_key(patrimony_number) gin_trgm_ops);
