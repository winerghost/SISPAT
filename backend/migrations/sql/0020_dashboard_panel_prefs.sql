-- SISPAT-AGU - user_dashboard_preferences (paineis do dashboard por usuario)
--
-- APLICADA manualmente no Supabase (projeto tocbtonqnahmtegfkrmn) em
-- 2026-10-27, com autorizacao explicita, por este espelho (SQL Editor): a
-- tabela existe com os quatro CHECKs, RLS habilitado SEM politicas
-- (deny-all) e sem grants para anon/authenticated; o passo de migracao dos
-- dados inseriu 0 linhas. O DDL esta CONGELADO.
--
-- CARIMBO: ja feito. O alembic_version do banco esta em
-- 0018_equipment_classification, que sucede esta revisao na cadeia linear;
-- NAO rodar `alembic upgrade` sobre ela. Para recompor o carimbo nesta
-- revisao: `alembic stamp 0017_dashboard_panel_prefs` (sem upgrade).
--
-- Espelha a migracao Alembic
-- backend/migrations/versions/0017_dashboard_panel_prefs.py -- o teste
-- backend/tests/test_dashboard_panels_db.py verifica que cada bloco do
-- upgrade esta presente aqui. Qualquer alteracao deve ser feita nos dois
-- arquivos.
--
-- Pre-requisito: 0019_asset_search_key.sql (Alembic 0016) e a tabela
-- user_preferences (0007_settings_ai_users.sql).
-- Tabela NOVA: RLS habilitado SEM politicas (deny-all) e REVOKE de
-- anon/authenticated, no padrao da 0006_db_security_hardening.sql.
-- Aditivo e idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
--
-- Downgrade (ver DOWNGRADE_SQL na migracao Alembic; nunca em producao sem
-- autorizacao explicita):
--   alembic downgrade 0016_asset_search_key

CREATE TABLE IF NOT EXISTS public.user_dashboard_preferences (
    user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    panels jsonb NOT NULL DEFAULT '[]'::jsonb,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_user_dashboard_preferences_panels_array CHECK (jsonb_typeof(panels) = 'array'),
    CONSTRAINT ck_user_dashboard_preferences_panels_count CHECK (jsonb_array_length(panels) <= 32),
    CONSTRAINT ck_user_dashboard_preferences_panels_size CHECK (octet_length(panels::text) <= 2048),
    CONSTRAINT ck_user_dashboard_preferences_version CHECK (version >= 1)
);

COMMENT ON TABLE public.user_dashboard_preferences IS
    'Paineis do dashboard por usuario: array JSONB ordenado de {id,visible,size}; [] = layout padrao do perfil. Catalogo, permissoes por perfil e tamanhos (P/M/G) validados no backend.';

COMMENT ON COLUMN public.user_dashboard_preferences.panels IS
    'Array JSONB ORDENADO (a ordem do array e a ordem de exibicao) de objetos {"id","visible","size"}.';
DO $do$
DECLARE
    item record;
BEGIN
    FOR item IN
        SELECT * FROM (VALUES
            ('ck_user_dashboard_preferences_panels_array', 'jsonb_typeof(panels) = ''array'''),
            ('ck_user_dashboard_preferences_panels_count', 'jsonb_array_length(panels) <= 32'),
            ('ck_user_dashboard_preferences_panels_size', 'octet_length(panels::text) <= 2048'),
            ('ck_user_dashboard_preferences_version', 'version >= 1')
        ) AS v(conname, expr)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = item.conname
              AND conrelid = 'public.user_dashboard_preferences'::regclass
        ) THEN
            EXECUTE format(
                'ALTER TABLE public.user_dashboard_preferences ADD CONSTRAINT %I CHECK (%s)',
                item.conname, item.expr
            );
        END IF;
    END LOOP;
END
$do$;
ALTER TABLE public.user_dashboard_preferences ENABLE ROW LEVEL SECURITY;
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.user_dashboard_preferences FROM anon, authenticated;
    END IF;
END
$do$;
WITH mapa(old_id, new_id, default_size, catalog_pos) AS (
    VALUES
        ('kpis',          'kpi_workstations',        'G', 1),
        ('tech_summary',  'kpi_infrastructure',      'G', 2),
        ('tech_units',    'equipment_by_unit_table', 'G', 4),
        ('units',         'equipment_by_unit_chart', 'G', 6),
        ('tech_category', 'category_distribution',   'M', 7)
),
legado AS (
    SELECT up.user_id, up.dashboard_layout AS layout
    FROM public.user_preferences up
    WHERE jsonb_typeof(up.dashboard_layout) = 'object'
      AND (jsonb_typeof(up.dashboard_layout -> 'order') = 'array'
           OR jsonb_typeof(up.dashboard_layout -> 'hidden') = 'array')
),
ordem AS (
    SELECT l.user_id, m.new_id, m.default_size, o.pos::int AS pos
    FROM legado l
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(l.layout -> 'order') = 'array'
             THEN l.layout -> 'order' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS o(old_id, pos)
    JOIN mapa m ON m.old_id = o.old_id
),
ocultos AS (
    SELECT DISTINCT l.user_id, m.new_id, m.default_size, 1000 + m.catalog_pos AS pos
    FROM legado l
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(l.layout -> 'hidden') = 'array'
             THEN l.layout -> 'hidden' ELSE '[]'::jsonb END
    ) AS h(old_id)
    JOIN mapa m ON m.old_id = h.old_id
),
candidatos AS (
    SELECT user_id, new_id, default_size, MIN(pos) AS pos
    FROM (
        SELECT user_id, new_id, default_size, pos FROM ordem
        UNION ALL
        SELECT user_id, new_id, default_size, pos FROM ocultos
    ) AS t
    GROUP BY user_id, new_id, default_size
),
paineis AS (
    SELECT c.user_id,
           jsonb_agg(
               jsonb_build_object(
                   'id', c.new_id,
                   'visible', NOT EXISTS (
                       SELECT 1 FROM ocultos oc
                       WHERE oc.user_id = c.user_id AND oc.new_id = c.new_id
                   ),
                   'size', c.default_size
               )
               ORDER BY c.pos, c.new_id
           ) AS panels
    FROM candidatos c
    GROUP BY c.user_id
)
INSERT INTO public.user_dashboard_preferences (user_id, panels, version)
SELECT p.user_id, p.panels, 1
FROM paineis p
WHERE jsonb_array_length(p.panels) > 0
  AND p.panels @> '[{"visible": true}]'::jsonb
ON CONFLICT (user_id) DO NOTHING;
