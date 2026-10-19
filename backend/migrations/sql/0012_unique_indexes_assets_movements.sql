-- SISPAT-AGU - Índices únicos parciais: número patrimonial ativo e uma
-- movimentação PENDENTE por bem (SEC-AST-01 / SEC-MOV-02)
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado em banco
-- algum.
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0009_unique_indexes_assets_movements.py -- o
-- teste backend/tests/test_db_static.py verifica que cada bloco do upgrade
-- está presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisito: 0011_catalog_source_ids_permissions.sql (Alembic 0008).
-- Idempotente e aditivo. Sem BEGIN/COMMIT (SQL Editor do Supabase). Se houver
-- duplicatas, o bloco de verificação aborta com mensagem (só contagem, sem
-- dados pessoais) ANTES de criar o índice correspondente.
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

DO $do$
DECLARE
    dup_count integer;
BEGIN
    SELECT count(*) INTO dup_count FROM (
        SELECT 1 FROM public.assets
        WHERE deleted_at IS NULL
        GROUP BY lower(btrim(patrimony_number))
        HAVING count(*) > 1
    ) d;
    IF dup_count > 0 THEN
        RAISE EXCEPTION 'SEC-AST-01: % numero(s) patrimonial(is) duplicado(s) entre bens ativos; resolva antes de aplicar (nenhum indice foi criado)', dup_count;
    END IF;
END
$do$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_patrimony_number_active
    ON public.assets (lower(btrim(patrimony_number))) WHERE deleted_at IS NULL;

DO $do$
DECLARE
    dup_count integer;
BEGIN
    SELECT count(*) INTO dup_count FROM (
        SELECT 1 FROM public.asset_movements
        WHERE status = 'PENDENTE'
        GROUP BY asset_id
        HAVING count(*) > 1
    ) d;
    IF dup_count > 0 THEN
        RAISE EXCEPTION 'SEC-MOV-02: % bem(ns) com mais de uma movimentacao PENDENTE; resolva antes de aplicar (nenhum indice foi criado)', dup_count;
    END IF;
END
$do$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_movements_one_pending
    ON public.asset_movements (asset_id) WHERE status = 'PENDENTE';
