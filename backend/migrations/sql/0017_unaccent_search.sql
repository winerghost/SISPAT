-- 0017_unaccent_search — busca sem acento (espelho de 0014_unaccent_search.py)
-- NAO aplicada em producao: aplicar so com autorizacao explicita.
-- Aditiva e idempotente. Cria a extensao unaccent e um wrapper IMMUTABLE usado
-- pelo backend (app.security.text_search): sispat_unaccent(texto).
-- ATENCAO: o backend novo exige esta funcao; aplique ANTES do deploy do backend.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION public.sispat_unaccent(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = public, extensions
AS $$ SELECT unaccent($1) $$;
-- Rollback: DROP FUNCTION IF EXISTS public.sispat_unaccent(text);
