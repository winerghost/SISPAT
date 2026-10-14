-- SISPAT-AGU - Pré-visualização de importação de dados (Google Sheets)
--
-- Este arquivo espelha SEMANTICAMENTE a migração Alembic
-- backend/migrations/versions/0002_import_previews.py. Use-o apenas quando
-- não houver conectividade Python -> Postgres (ex.: aplicar manualmente via
-- Supabase SQL Editor / MCP). Qualquer alteração aqui deve ser replicada na
-- migração Alembic correspondente (e vice-versa).
--
-- Cria import_previews e import_preview_items, usadas pelos botões
-- "Pré-visualizar Importação" e "Confirmar Importação" do módulo
-- Administração -> Importação de Dados -> Google Sheets. A pré-visualização
-- nunca grava em assets; serve apenas para mostrar o que seria importado
-- antes de uma confirmação explícita do usuário.
--
-- Idempotência: as instruções abaixo assumem que o schema inicial (ver
-- 0001_initial_schema.sql) já foi aplicado. Para reexecução segura em
-- ambiente já criado, use IF NOT EXISTS / DO $$ ... $$ blocks conforme
-- necessário antes de reaplicar.

BEGIN;

-- ============================================================
-- import_previews
-- ============================================================
CREATE TABLE IF NOT EXISTS import_previews (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source            text NOT NULL DEFAULT 'google_sheets',
    status            text NOT NULL DEFAULT 'CONCLUIDA',
    total_rows        integer NOT NULL DEFAULT 0,
    count_novo        integer NOT NULL DEFAULT 0,
    count_existente   integer NOT NULL DEFAULT 0,
    count_duplicado   integer NOT NULL DEFAULT 0,
    count_invalido    integer NOT NULL DEFAULT 0,
    count_conflitante integer NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    -- Calculado pela aplicação (ex.: created_at + 1h); sem default no banco.
    expires_at        timestamptz NOT NULL,
    confirmed_at      timestamptz,
    confirmed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT ck_import_previews_status CHECK (status IN ('PROCESSANDO','CONCLUIDA','FALHOU','EXPIRADA','CONFIRMADA'))
);
COMMENT ON TABLE import_previews IS 'Pré-visualizações de importação de dados (ex.: Google Sheets). Nunca gravam em assets; representam apenas o que seria importado até uma confirmação explícita do usuário.';

CREATE INDEX IF NOT EXISTS ix_import_previews_requested_by ON import_previews (requested_by);
CREATE INDEX IF NOT EXISTS ix_import_previews_confirmed_by ON import_previews (confirmed_by);
CREATE INDEX IF NOT EXISTS ix_import_previews_status ON import_previews (status);

-- ============================================================
-- import_preview_items
-- ============================================================
CREATE TABLE IF NOT EXISTS import_preview_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    preview_id         uuid NOT NULL REFERENCES import_previews(id) ON DELETE CASCADE,
    source_record_id   text,
    patrimony_number   text,
    description        text,
    raw_values         jsonb NOT NULL,
    normalized_values  jsonb,
    classification     text NOT NULL,
    validation_errors  jsonb,
    matched_asset_id   uuid REFERENCES assets(id) ON DELETE SET NULL,
    selected           boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_import_preview_items_classification CHECK (classification IN ('NOVO','EXISTENTE','DUPLICADO','INVALIDO','CONFLITANTE'))
);
COMMENT ON TABLE import_preview_items IS 'Linhas individuais de uma pré-visualização de importação, já classificadas (NOVO/EXISTENTE/DUPLICADO/INVALIDO/CONFLITANTE) frente aos bens já cadastrados.';

CREATE INDEX IF NOT EXISTS ix_import_preview_items_preview_id ON import_preview_items (preview_id);
CREATE INDEX IF NOT EXISTS ix_import_preview_items_matched_asset_id ON import_preview_items (matched_asset_id);
CREATE INDEX IF NOT EXISTS ix_import_preview_items_classification ON import_preview_items (classification);
-- Índice composto: suporta a listagem paginada de itens de uma prévia
-- filtrada por classificação (caso de uso principal da tela de revisão).
CREATE INDEX IF NOT EXISTS ix_import_preview_items_preview_classification ON import_preview_items (preview_id, classification);

COMMIT;
