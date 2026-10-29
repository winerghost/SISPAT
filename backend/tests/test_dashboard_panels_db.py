"""Testes ESTÁTICOS da migração 0017_dashboard_panel_prefs (sem conexão a banco).

Verificam, a partir do arquivo de migração, do espelho `.sql` e dos modelos:
    - a migração encadeia no head atual (0016_asset_search_key) e é aditiva;
    - a tabela NOVA nasce com RLS habilitado SEM políticas e REVOKE de
      anon/authenticated (padrão da 0004_db_security_hardening);
    - `version` (controle otimista) e timestamps timestamptz (UTC);
    - idempotência por construção (IF NOT EXISTS, guardas em pg_constraint,
      `ON CONFLICT DO NOTHING`);
    - a tradução dos IDs antigos espelha EXATAMENTE `LEGACY_PANEL_MAP` e os
      tamanhos/ordem do catálogo, e os dez IDs descartados não aparecem;
    - a migração de dados NÃO apaga nem altera `user_preferences`;
    - o downgrade remove apenas a tabela que esta migração cria;
    - o espelho `.sql` corresponde ao upgrade e registra que está PENDENTE;
    - o modelo SQLAlchemy corresponde à migração.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import DateTime, Integer
from sqlalchemy.dialects.postgresql import JSONB

from app.models.settings import UserDashboardPreferences
from app.services import dashboard_panels_service as dps

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
PANELS_PY = MIGRATIONS_DIR / "versions" / "0017_dashboard_panel_prefs.py"
PANELS_SQL = MIGRATIONS_DIR / "sql" / "0020_dashboard_panel_prefs.sql"
TABLE = "public.user_dashboard_preferences"


def _load_module(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"_mig_{path.stem}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def panels_migration() -> ModuleType:
    return _load_module(PANELS_PY)


@pytest.fixture(scope="module")
def upgrade_sql(panels_migration) -> str:
    return "\n".join(panels_migration.UPGRADE_STATEMENTS)


# ---------------------------------------------------------------------------
# Encadeamento e tabela nova
# ---------------------------------------------------------------------------


def test_db_0017_revises_0016(panels_migration) -> None:
    assert panels_migration.revision == "0017_dashboard_panel_prefs"
    assert panels_migration.down_revision == "0016_asset_search_key"
    assert panels_migration.NEW_TABLES == ("user_dashboard_preferences",)


def test_db_0017_cria_tabela_com_version_e_timestamptz(panels_migration) -> None:
    sql = panels_migration.CREATE_TABLE_SQL
    assert f"CREATE TABLE IF NOT EXISTS {TABLE} (" in sql
    assert "user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE" in sql
    assert "panels jsonb NOT NULL DEFAULT '[]'::jsonb" in sql
    assert "version integer NOT NULL DEFAULT 1" in sql
    assert "created_at timestamptz NOT NULL DEFAULT now()" in sql
    assert "updated_at timestamptz NOT NULL DEFAULT now()" in sql


def test_db_0017_checks_de_conteudo(panels_migration) -> None:
    for sql in (panels_migration.CREATE_TABLE_SQL, panels_migration.ADD_CHECKS_SQL):
        assert "jsonb_typeof(panels) = ''array''" in sql or "jsonb_typeof(panels) = 'array'" in sql
    checks = panels_migration.ADD_CHECKS_SQL
    for name in (
        "ck_user_dashboard_preferences_panels_array",
        "ck_user_dashboard_preferences_panels_count",
        "ck_user_dashboard_preferences_panels_size",
        "ck_user_dashboard_preferences_version",
    ):
        assert f"'{name}'" in checks
        assert name in panels_migration.CREATE_TABLE_SQL
    # idempotente: cada CHECK protegido por consulta a pg_constraint
    assert "FROM pg_constraint" in checks
    assert "conrelid = 'public.user_dashboard_preferences'::regclass" in checks


def test_db_0017_rls_e_revoke_no_padrao_da_0004(panels_migration) -> None:
    assert (
        f"ALTER TABLE {TABLE} ENABLE ROW LEVEL SECURITY"
        in panels_migration.ENABLE_RLS_NEW_TABLES_SQL
    )
    revoke = panels_migration.REVOKE_API_ROLES_NEW_TABLES_SQL
    assert f"REVOKE ALL ON TABLE {TABLE} FROM anon, authenticated" in revoke
    assert "pg_roles WHERE rolname = 'anon'" in revoke
    assert "pg_roles WHERE rolname = 'authenticated'" in revoke
    # nenhuma POLICY: sem políticas, RLS é deny-all para quem não tem BYPASSRLS
    todo = "\n".join(panels_migration.UPGRADE_STATEMENTS)
    assert "CREATE POLICY" not in todo.upper()
    assert not re.search(r"\bGRANT\b|DISABLE\s+ROW\s+LEVEL", todo, re.IGNORECASE)


def test_db_0017_ordem_dos_passos(panels_migration) -> None:
    assert panels_migration.UPGRADE_STATEMENTS == (
        panels_migration.CREATE_TABLE_SQL,
        panels_migration.ADD_CHECKS_SQL,
        panels_migration.ENABLE_RLS_NEW_TABLES_SQL,
        panels_migration.REVOKE_API_ROLES_NEW_TABLES_SQL,
        panels_migration.MIGRATE_LEGACY_LAYOUT_SQL,
    )


# ---------------------------------------------------------------------------
# Aditiva e idempotente
# ---------------------------------------------------------------------------


def test_db_0017_upgrade_e_aditivo(upgrade_sql) -> None:
    assert not re.search(r"\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b", upgrade_sql, re.IGNORECASE)
    assert not re.search(r"^\s*DELETE\s+FROM\b", upgrade_sql, re.IGNORECASE | re.MULTILINE)
    assert not re.search(r"(^|;)\s*TRUNCATE\b", upgrade_sql, re.IGNORECASE | re.MULTILINE)
    # a única escrita é o INSERT na tabela NOVA
    assert len(re.findall(r"\bINSERT\s+INTO\b", upgrade_sql, re.IGNORECASE)) == 1
    assert f"INSERT INTO {TABLE}" in upgrade_sql
    assert not re.search(r"\bUPDATE\s+public\.", upgrade_sql, re.IGNORECASE)


def test_db_0017_e_idempotente_por_construcao(upgrade_sql) -> None:
    assert "CREATE TABLE IF NOT EXISTS" in upgrade_sql
    assert "ON CONFLICT (user_id) DO NOTHING" in upgrade_sql
    assert upgrade_sql.count("IF NOT EXISTS") >= 2


def test_db_0017_nao_toca_user_preferences(upgrade_sql) -> None:
    """A linha antiga é LIDA, nunca apagada ou alterada."""
    for match in re.finditer(r"public\.user_preferences", upgrade_sql):
        janela = upgrade_sql[max(0, match.start() - 120): match.start()]
        assert re.search(r"\bFROM\s*$", janela.rstrip() + " ", re.IGNORECASE) or "FROM" in janela
    assert not re.search(
        r"\b(UPDATE|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE)\s+public\.user_preferences",
        upgrade_sql,
        re.IGNORECASE,
    )


# ---------------------------------------------------------------------------
# Migração das preferências antigas: mapa EXATO do serviço
# ---------------------------------------------------------------------------


def _mapping_rows(sql: str) -> list[tuple[str, str, str, int]]:
    pattern = re.compile(
        r"\(\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([PMG])',\s*(\d+)\s*\)"
    )
    return [(a, b, c, int(d)) for a, b, c, d in pattern.findall(sql)]


def test_db_0017_mapa_espelha_o_servico(panels_migration) -> None:
    rows = _mapping_rows(panels_migration.MIGRATE_LEGACY_LAYOUT_SQL)
    assert len(rows) == len(dps.LEGACY_PANEL_MAP) == 5
    assert {old: new for old, new, _s, _p in rows} == dict(dps.LEGACY_PANEL_MAP)
    # tamanho e posição de catálogo iguais aos do catálogo do backend. A 0017 (já aplicada,
    # imutável) é um instantâneo do catálogo de 12 painéis; `located_by_unit_chart` (Onda A)
    # foi inserido depois dele, então a posição histórica ignora esse painel.
    historico = [pid for pid in dps.PANEL_IDS if pid != "located_by_unit_chart"]
    assert len(historico) == 12
    for _old, new, size, pos in rows:
        panel = dps.PANELS_BY_ID[new]
        assert size == panel.default_size, new
        assert pos == historico.index(new) + 1, new


def test_db_0017_ids_descartados_nao_aparecem(panels_migration) -> None:
    from app.services.preferences_service import DEFAULT_DASHBOARD_ORDER

    sql = panels_migration.MIGRATE_LEGACY_LAYOUT_SQL
    for old_id in set(DEFAULT_DASHBOARD_ORDER) - set(dps.LEGACY_PANEL_MAP):
        assert f"'{old_id}'" not in sql, old_id


def test_db_0017_migracao_le_order_e_hidden_com_tolerancia(panels_migration) -> None:
    sql = panels_migration.MIGRATE_LEGACY_LAYOUT_SQL
    # só objetos com `order`/`hidden` em formato de array são considerados
    assert "jsonb_typeof(up.dashboard_layout) = 'object'" in sql
    assert "jsonb_typeof(l.layout -> 'order') = 'array'" in sql
    assert "jsonb_typeof(l.layout -> 'hidden') = 'array'" in sql
    # a ordem do array antigo é preservada (WITH ORDINALITY) e sem repetição
    assert "WITH ORDINALITY" in sql
    assert "MIN(pos) AS pos" in sql
    # ao menos um painel visível, senão nenhuma linha é criada
    assert """p.panels @> '[{"visible": true}]'::jsonb""" in sql
    assert "jsonb_array_length(p.panels) > 0" in sql
    # a saída tem exatamente as três chaves do contrato
    assert "'id', c.new_id" in sql and "'visible'," in sql and "'size', c.default_size" in sql


# ---------------------------------------------------------------------------
# Downgrade e espelho SQL
# ---------------------------------------------------------------------------


def test_db_0017_downgrade_so_remove_a_propria_tabela(panels_migration) -> None:
    sql = panels_migration.DOWNGRADE_SQL
    assert re.findall(r"DROP TABLE IF EXISTS ([\w.]+)", sql) == [
        "public.user_dashboard_preferences"
    ]
    assert "user_preferences" not in sql.replace("user_dashboard_preferences", "")
    assert "dashboard_layout" not in sql
    assert not re.search(r"^\s*DELETE\s+FROM|TRUNCATE", sql, re.IGNORECASE | re.MULTILINE)


def test_db_0017_sql_mirror_matches_alembic(panels_migration) -> None:
    mirror = PANELS_SQL.read_text(encoding="utf-8")
    for statement in panels_migration.UPGRADE_STATEMENTS:
        assert statement.strip("\n") in mirror
    assert not re.search(r"^\s*(BEGIN|COMMIT)\s*;", mirror, re.IGNORECASE | re.MULTILINE)


def test_db_0017_registra_aplicacao_carimbo_e_downgrade(panels_migration) -> None:
    """O DDL foi aplicado à mão no Supabase em 2026-10-27 (autorização explícita).

    O cabeçalho dos dois arquivos registra isso, que o `alembic_version` ainda
    NÃO foi carimbado (`alembic stamp`, sem upgrade) e como reverter.
    """
    py_text = PANELS_PY.read_text(encoding="utf-8")
    mirror = PANELS_SQL.read_text(encoding="utf-8")
    assert "APLICADA" in py_text and "autorização explícita" in py_text
    assert "APLICADA" in mirror and "autorizacao explicita" in mirror
    for text_ in (py_text, mirror):
        assert "2026-10-27" in text_
        assert "alembic stamp 0017_dashboard_panel_prefs" in text_
        assert "alembic downgrade 0016_asset_search_key" in text_
    # `alembic upgrade` desta revisão NÃO deve ser sugerido (DDL já aplicado)
    assert "alembic upgrade 0017_dashboard_panel_prefs" not in mirror


# ---------------------------------------------------------------------------
# Modelo x migração
# ---------------------------------------------------------------------------


def test_db_0017_model_matches_migration() -> None:
    table = UserDashboardPreferences.__table__
    assert table.name == "user_dashboard_preferences"
    assert list(table.primary_key.columns.keys()) == ["user_id"]
    panels = table.c.panels
    assert isinstance(panels.type, JSONB) and not panels.nullable
    assert "[]" in str(panels.server_default.arg)
    assert isinstance(table.c.version.type, Integer) and not table.c.version.nullable
    for name in ("created_at", "updated_at"):
        column = table.c[name]
        assert isinstance(column.type, DateTime) and column.type.timezone, name
        assert not column.nullable, name
    checks = {c.name: str(c.sqltext) for c in table.constraints if c.name}
    assert checks["ck_user_dashboard_preferences_panels_array"] == "jsonb_typeof(panels) = 'array'"
    assert checks["ck_user_dashboard_preferences_panels_count"] == "jsonb_array_length(panels) <= 32"
    assert checks["ck_user_dashboard_preferences_panels_size"] == "octet_length(panels::text) <= 2048"
    assert checks["ck_user_dashboard_preferences_version"] == "version >= 1"
    # FK com ON DELETE CASCADE (igual à migração)
    (fk,) = list(table.c.user_id.foreign_keys)
    assert fk.target_fullname == "users.id" and fk.ondelete == "CASCADE"
