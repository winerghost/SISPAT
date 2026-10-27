-- SISPAT-AGU - assets: classificação família/categoria + override do ADM
--
-- DDL APLICADO NO SUPABASE EM 2026-10-27 (autorizado pelo usuário, por este
-- espelho no SQL Editor). Reexecutar é seguro (aditivo e idempotente), mas
-- não deve ser feito sem autorização. No deploy, carimbar o Alembic com
-- `alembic stamp 0018_equipment_classification` (SEM upgrade).
-- O DDL está CONGELADO: as colunas, os CHECKs e o índice já existem no banco
-- e não podem mais ser renomeados ou ter a expressão alterada aqui.
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0018_equipment_classification.py -- o teste
-- backend/tests/test_asset_classification_migration.py verifica que cada
-- bloco do upgrade está presente aqui. Qualquer alteração deve ser feita nos
-- dois arquivos.
--
-- Colunas SEM default: NULL = "não informado". Sem backfill: a classificação
-- inicial é o comando `flask classify-equipment` (dry-run por padrão) e, no
-- banco, as colunas seguem todas NULL.
-- `category_override` é do ADM: o motor nunca escreve nessa coluna.
--
-- Pré-requisito: 0020_dashboard_panel_prefs.sql (Alembic 0017). Tabela existente:
-- RLS/REVOKE já vêm de 0006_db_security_hardening.sql (no Alembic: 0004; as
-- numerações do espelho .sql e do Alembic diferem; nenhuma tabela nova aqui).
-- Aditivo e idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Rollback: ver DOWNGRADE_SQL na migração Alembic correspondente
-- (`alembic downgrade 0017_dashboard_panel_prefs`).

ALTER TABLE public.assets
    ADD COLUMN IF NOT EXISTS equipment_family text NULL,
    ADD COLUMN IF NOT EXISTS equipment_category text NULL,
    ADD COLUMN IF NOT EXISTS classification_confidence text NULL,
    ADD COLUMN IF NOT EXISTS classification_rule text NULL,
    ADD COLUMN IF NOT EXISTS classification_rules_version text NULL,
    ADD COLUMN IF NOT EXISTS category_override text NULL;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_equipment_family'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_equipment_family
            CHECK (equipment_family IS NULL OR equipment_family IN ('TI','MOBILIARIO','OUTROS'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_equipment_category'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_equipment_category
            CHECK (equipment_category IS NULL OR ((equipment_family = 'TI' AND equipment_category IN ('COMPUTADOR','NOTEBOOK','MONITOR','IMPRESSORA','NOBREAK','ESTABILIZADOR','DOCKING','REDE','OUTRO_TI')) OR (equipment_family = 'MOBILIARIO' AND equipment_category IN ('MESA','ARMARIO','GAVETEIRO','ESTACAO_TRABALHO','CADEIRA','POLTRONA','SOFA','ESTANTE','OUTRO_MOB')) OR (equipment_family = 'OUTROS' AND equipment_category IN ('EQUIPAMENTO','OUTROS'))));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_classification_confidence'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_classification_confidence
            CHECK (classification_confidence IS NULL OR classification_confidence IN ('ALTA','BAIXA'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_category_override'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_category_override
            CHECK (category_override IS NULL OR category_override IN ('COMPUTADOR','NOTEBOOK','MONITOR','IMPRESSORA','NOBREAK','ESTABILIZADOR','DOCKING','REDE','OUTRO_TI','MESA','ARMARIO','GAVETEIRO','ESTACAO_TRABALHO','CADEIRA','POLTRONA','SOFA','ESTANTE','OUTRO_MOB','EQUIPAMENTO','OUTROS'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_classification_rule_len'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_classification_rule_len
            CHECK (classification_rule IS NULL OR (char_length(classification_rule) BETWEEN 1 AND 64 AND classification_rule = btrim(classification_rule)));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_assets_classification_rules_version_len'
          AND conrelid = 'public.assets'::regclass
    ) THEN
        ALTER TABLE public.assets
            ADD CONSTRAINT ck_assets_classification_rules_version_len
            CHECK (classification_rules_version IS NULL OR (char_length(classification_rules_version) BETWEEN 1 AND 16 AND classification_rules_version = btrim(classification_rules_version)));
    END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS ix_assets_equipment_active
    ON public.assets (equipment_family, equipment_category, unit_id)
    WHERE deleted_at IS NULL AND equipment_category IS NOT NULL;
