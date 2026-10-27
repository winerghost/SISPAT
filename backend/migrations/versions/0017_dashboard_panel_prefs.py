"""user_dashboard_preferences (painéis do dashboard: visibilidade, ordem e tamanho)

APLICADA manualmente no Supabase (projeto tocbtonqnahmtegfkrmn) em
2026-10-27, com autorização explícita, via o espelho sql/0020 (SQL Editor):
a tabela `user_dashboard_preferences` existe, com os quatro CHECKs, RLS
habilitado sem políticas (deny-all) e sem grants para anon/authenticated; o
passo de migração dos dados rodou e inseriu 0 linhas (nenhum layout legado
aproveitável). O DDL está CONGELADO: não altere nome de tabela/coluna, tipo,
nome ou expressão de CHECK, nem o formato do JSONB `panels`.

CARIMBO: já feito. O `alembic_version` do banco está em
0018_equipment_classification, que SUCEDE esta revisão na cadeia linear —
logo esta revisão conta como aplicada e NÃO se deve rodar `alembic upgrade`
sobre ela. Se for preciso recompor o estado do carimbo nesta revisão, usar
`alembic stamp 0017_dashboard_panel_prefs` (SEM upgrade). Depende de
0016_asset_search_key (a cadeia Alembic é linear).

Reverter com (nunca em produção sem autorização explícita):
    alembic downgrade 0016_asset_search_key

O que faz (aditivo e idempotente — nenhuma tabela, coluna ou linha
preexistente é removida ou alterada):

1. Cria `user_dashboard_preferences` (tabela NOVA): uma linha por usuário,
   `panels jsonb NOT NULL DEFAULT '[]'` (ARRAY ORDENADO de objetos
   `{"id","visible","size"}`; `[]` = layout padrão do perfil), `version`
   (controle otimista) e `created_at`/`updated_at` em timestamptz (UTC).
   CHECKs: `panels` é array, no máximo 32 itens e 2048 bytes, `version >= 1`.
   O catálogo de IDs de painel, as permissões por perfil e os tamanhos
   admitidos (P/M/G) são validados no BACKEND
   (`app.services.dashboard_panels_service`), nunca pelo cliente.
2. RLS habilitado SEM políticas (deny-all para quem não tem BYPASSRLS) e
   REVOKE de anon/authenticated na tabela nova — padrão da
   0004_db_security_hardening para tabelas NOVAS. Os blocos que dependem das
   roles do Supabase (`anon`, `authenticated`) são condicionais à existência
   delas, de modo que a migração também roda em um Postgres local puro.
3. Migra as preferências antigas de `user_preferences.dashboard_layout`
   (`{"order": [...], "hidden": [...]}` com os 15 IDs antigos) para a tabela
   nova, traduzindo APENAS os cinco IDs que têm correspondente no catálogo
   novo (espelha `LEGACY_PANEL_MAP` do serviço; um teste estático compara o
   SQL abaixo com esse dicionário):

       kpis          -> kpi_workstations
       tech_summary  -> kpi_infrastructure
       tech_units    -> equipment_by_unit_table
       units         -> equipment_by_unit_chart
       tech_category -> category_distribution

   Os outros dez IDs antigos (status, monthly, location, bond, pending,
   rooms, inventory, tech_status, tech_no_owner, tech_age) são DESCARTADOS:
   os painéis correspondentes não existem mais. ID desconhecido é ignorado
   em silêncio (nunca erro). A linha de `user_preferences` NÃO é apagada nem
   alterada (`dashboard_layout` continua lá). `INSERT ... ON CONFLICT
   (user_id) DO NOTHING` torna o passo idempotente e nunca sobrescreve uma
   preferência já gravada pela aplicação. Usuários sem nada aproveitável
   (ou cujo layout legado esconderia todos os painéis) não recebem linha:
   caem no layout padrão do perfil, resolvido em tempo de leitura.

Espelho SQL: backend/migrations/sql/0020_dashboard_panel_prefs.sql
(verificado por backend/tests/test_dashboard_panels_db.py).

Downgrade: remove APENAS a tabela criada aqui (perde só esta preferência;
`user_preferences.dashboard_layout` permanece intacto).

Revision ID: 0017_dashboard_panel_prefs
Revises: 0016_asset_search_key
Create Date: 2026-10-27

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0017_dashboard_panel_prefs"
down_revision: Union[str, None] = "0016_asset_search_key"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


# Tabelas criadas por esta migração (RLS + REVOKE aplicados a todas).
NEW_TABLES: tuple[str, ...] = ("user_dashboard_preferences",)

CREATE_TABLE_SQL = """
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
"""

# Idempotência também quando a tabela já existe sem algum CHECK (aplicação
# parcial anterior): cada CHECK é adicionado só se ainda não existir.
ADD_CHECKS_SQL = """
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
"""

ENABLE_RLS_NEW_TABLES_SQL = """
ALTER TABLE public.user_dashboard_preferences ENABLE ROW LEVEL SECURITY;
"""

REVOKE_API_ROLES_NEW_TABLES_SQL = """
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.user_dashboard_preferences FROM anon, authenticated;
    END IF;
END
$do$;
"""

# Tradução dos IDs antigos -> novos (espelha LEGACY_PANEL_MAP do serviço).
# `catalog_pos` é a posição do painel no catálogo novo, usada para ordenar os
# painéis que só aparecem em `hidden` (sem posição em `order`).
MIGRATE_LEGACY_LAYOUT_SQL = """
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
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    CREATE_TABLE_SQL,
    ADD_CHECKS_SQL,
    ENABLE_RLS_NEW_TABLES_SQL,
    REVOKE_API_ROLES_NEW_TABLES_SQL,
    MIGRATE_LEGACY_LAYOUT_SQL,
)

DOWNGRADE_SQL = """
DROP TABLE IF EXISTS public.user_dashboard_preferences;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
