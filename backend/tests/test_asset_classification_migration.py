"""Migração 0018_equipment_classification: estática, sem conexão a banco.

Mesmo padrão dos testes da 0015 em `test_db_static.py`: a migração é aditiva,
idempotente, tem downgrade que só remove o que criou, o espelho `.sql`
corresponde ao upgrade e os CHECKs espelham EXATAMENTE o vocabulário em
`app.services.asset_classification` (fonte única).

Nada aqui toca banco: o DDL foi aplicado no Supabase em 2026-10-27 pelo
usuário (pelo espelho .sql) e está CONGELADO — estes testes travam os nomes e
as expressões que já existem no banco.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest
from sqlalchemy import Text

from app.models.assets import Asset
from app.services import asset_classification as ac

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
MIGRATION_PY = MIGRATIONS_DIR / "versions" / "0018_equipment_classification.py"
MIGRATION_SQL = MIGRATIONS_DIR / "sql" / "0021_equipment_classification.sql"

NEW_COLUMNS = (
    "equipment_family",
    "equipment_category",
    "classification_confidence",
    "classification_rule",
    "classification_rules_version",
    "category_override",
)
NEW_CHECKS = (
    "ck_assets_equipment_family",
    "ck_assets_equipment_category",
    "ck_assets_classification_confidence",
    "ck_assets_category_override",
    "ck_assets_classification_rule_len",
    "ck_assets_classification_rules_version_len",
)


def _lf(text: str) -> str:
    return text.replace("\r\n", "\n")


@pytest.fixture(scope="module")
def migration():
    spec = importlib.util.spec_from_file_location("_mig_0018", MIGRATION_PY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _in_list(values: tuple[str, ...]) -> str:
    return "(" + ",".join(f"'{value}'" for value in values) + ")"


def test_encadeada_no_head_atual_e_com_id_curto(migration) -> None:
    assert migration.revision == "0018_equipment_classification"
    # Cadeia LINEAR: encadeada na 0017 (criada em paralelo e já aplicada).
    assert migration.down_revision == "0017_dashboard_panel_prefs"
    assert len(migration.revision) <= 32  # alembic_version.version_num é varchar(32)
    assert callable(migration.upgrade) and callable(migration.downgrade)


def test_upgrade_aditivo_e_idempotente(migration) -> None:
    assert migration.UPGRADE_STATEMENTS == (
        migration.ADD_COLUMNS_SQL,
        migration.ADD_CHECKS_SQL,
        migration.CREATE_INDEX_SQL,
    )
    upgrade_sql = "\n".join(migration.UPGRADE_STATEMENTS)
    for column in NEW_COLUMNS:
        assert f"ADD COLUMN IF NOT EXISTS {column} text NULL" in upgrade_sql
        # sem default: NULL = "não informado", nunca um valor fictício
        assert f"{column} text NULL DEFAULT" not in upgrade_sql
    assert not re.search(r"ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)", upgrade_sql)
    # Nada destrutivo nem de dados no upgrade (`\b` evita casar "deleted_at").
    assert not re.search(
        r"\b(UPDATE|DELETE|INSERT|TRUNCATE|DROP|GRANT)\b", upgrade_sql, re.IGNORECASE
    )
    # CHECKs em bloco DO $do$ guardado por pg_constraint (idempotente)
    assert migration.ADD_CHECKS_SQL.strip().startswith("DO $do$")
    for name in NEW_CHECKS:
        assert f"WHERE conname = '{name}'" in migration.ADD_CHECKS_SQL
        assert f"ADD CONSTRAINT {name}" in migration.ADD_CHECKS_SQL
    index = migration.CREATE_INDEX_SQL
    assert "CREATE INDEX IF NOT EXISTS ix_assets_equipment_active" in index
    assert "WHERE deleted_at IS NULL AND equipment_category IS NOT NULL" in index


def test_downgrade_remove_so_o_que_criou(migration) -> None:
    sql = migration.DOWNGRADE_SQL
    assert re.findall(r"DROP INDEX IF EXISTS public\.(\w+)", sql) == ["ix_assets_equipment_active"]
    assert set(re.findall(r"DROP CONSTRAINT IF EXISTS (\w+)", sql)) == set(NEW_CHECKS)
    assert set(re.findall(r"DROP COLUMN IF EXISTS (\w+)", sql)) == set(NEW_COLUMNS)
    # não toca no vocabulário legado da 0015 nem em dados
    for legado in ("asset_category", "tech_type", "operational_status", "bond_status"):
        assert legado not in sql
    assert "DROP TABLE" not in sql.upper()
    assert not re.search(r"^\s*DELETE\s+FROM|TRUNCATE", sql, re.IGNORECASE | re.MULTILINE)


def test_espelho_sql_corresponde_a_migracao(migration) -> None:
    mirror = _lf(MIGRATION_SQL.read_text(encoding="utf-8"))
    for statement in migration.UPGRADE_STATEMENTS:
        assert _lf(statement).strip("\n") in mirror
    # DDL já aplicado (2026-10-27) e Alembic ainda a carimbar: os dois
    # cabeçalhos dizem isso, e nenhum manda rodar `alembic upgrade`.
    source = MIGRATION_PY.read_text(encoding="utf-8")
    for text in (mirror, source):
        assert "APLICADO NO SUPABASE EM 2026-10-27" in text
        assert "alembic stamp 0018_equipment_classification" in text
    assert "alembic downgrade 0017_dashboard_panel_prefs" in source
    # Sem BEGIN/COMMIT (SQL Editor do Supabase)
    assert not re.search(r"^\s*(BEGIN|COMMIT)\s*;", mirror, re.IGNORECASE | re.MULTILINE)


def test_modelo_corresponde_a_migracao(migration) -> None:
    table = Asset.__table__
    for name in NEW_COLUMNS:
        column = table.c[name]
        assert isinstance(column.type, Text) and column.nullable
        assert column.server_default is None and column.default is None
    checks = {c.name: str(c.sqltext) for c in table.constraints if c.name}
    for name in NEW_CHECKS:
        assert name in checks
    index = {i.name: i for i in table.indexes}["ix_assets_equipment_active"]
    assert not index.unique
    assert [c.name for c in index.columns] == [
        "equipment_family", "equipment_category", "unit_id",
    ]
    assert "equipment_category IS NOT NULL" in str(
        index.dialect_options["postgresql"]["where"]
    )


def test_checks_espelham_o_vocabulario_do_modulo(migration) -> None:
    """O vocabulário em Python é o MESMO dos CHECKs (migração e modelo)."""
    table_checks = "".join(
        str(c.sqltext) for c in Asset.__table__.constraints if c.name in NEW_CHECKS
    )
    for values in (
        ac.EQUIPMENT_FAMILIES,
        ac.TI_CATEGORIES,
        ac.MOBILIARIO_CATEGORIES,
        ac.OUTROS_CATEGORIES,
        ac.EQUIPMENT_CATEGORIES,  # allowlist do override do ADM
        ac.CLASSIFICATION_CONFIDENCES,
    ):
        listed = _in_list(values)
        assert listed in migration.ADD_CHECKS_SQL, listed
        assert listed in table_checks, listed
    # limites de tamanho também espelhados
    for limit in (ac.CLASSIFICATION_RULE_MAX, ac.CLASSIFICATION_RULES_VERSION_MAX):
        assert f"BETWEEN 1 AND {limit}" in migration.ADD_CHECKS_SQL
        assert f"BETWEEN 1 AND {limit}" in table_checks


def test_toda_classificacao_possivel_passa_nos_checks(migration) -> None:
    """Nenhum resultado do motor viola o CHECK família x categoria."""
    for family, categories in ac.EQUIPMENT_CATEGORIES_BY_FAMILY.items():
        for category in categories:
            assert f"'{category}'" in migration.ADD_CHECKS_SQL
            assert ac.CATEGORY_FAMILY[category] == family
