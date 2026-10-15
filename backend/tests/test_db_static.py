"""Testes ESTÁTICOS de banco de dados (sem conexão a Postgres/Supabase).

Verificam invariantes do CLAUDE.md a partir dos modelos SQLAlchemy e dos
arquivos de migração versionados:
    - migrações (upgrade) nunca são destrutivas (DROP TABLE/COLUMN, DELETE,
      TRUNCATE);
    - número patrimonial é texto, nunca ponto flutuante/numérico;
    - timestamps são timestamptz;
    - controle otimista `assets.version` está ligado ao mapper do ORM;
    - histórico de movimentações não é apagado em cascata pelo ORM;
    - a migração 0004_db_security_hardening cobre todas as tabelas dos
      modelos com RLS, torna audit_logs append-only, bloqueia DELETE físico
      patrimonial, revoga anon/authenticated e tem downgrade;
    - a migração 0005_settings_ai_users cria ai_settings/user_preferences
      com RLS + REVOKE, é aditiva/idempotente, semeia permissões só para o
      ADM e tem downgrade que só remove o que ela criou;
    - o espelho .sql corresponde à migração Alembic;
    - nenhuma função SECURITY DEFINER sem search_path fixo.
"""
from __future__ import annotations

import ast
import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import DateTime, Float, Numeric, Text
from sqlalchemy.orm import class_mapper

import app.models  # noqa: F401  (popula Base.metadata)
from app.database.session import Base
from app.models.assets import Asset
from app.models.imports import ImportPreviewItem

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
VERSIONS_DIR = MIGRATIONS_DIR / "versions"
SQL_DIR = MIGRATIONS_DIR / "sql"
HARDENING_PY = VERSIONS_DIR / "0004_db_security_hardening.py"
HARDENING_SQL = SQL_DIR / "0006_db_security_hardening.sql"
SETTINGS_PY = VERSIONS_DIR / "0005_settings_ai_users.py"
SETTINGS_SQL = SQL_DIR / "0007_settings_ai_users.sql"

_DESTRUCTIVE_SQL = [
    re.compile(r"\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b", re.IGNORECASE),
    re.compile(r"^\s*DELETE\s+FROM\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"(^|;)\s*TRUNCATE\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"\bop\.(drop_table|drop_column|bulk_delete)\s*\("),
]


def _load_module(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"_mig_{path.stem}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _upgrade_text(path: Path) -> str:
    """Código de `upgrade()` + constantes de string do módulo que não sejam
    de downgrade (onde o SQL de upgrade costuma ficar)."""
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    parts: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade":
            parts.append(ast.get_source_segment(source, node) or "")
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if any("DOWNGRADE" in n.upper() for n in names):
                continue
            segment = ast.get_source_segment(source, node) or ""
            parts.append(segment)
    return "\n".join(parts)


def _strip_sql_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


@pytest.mark.parametrize("path", sorted(VERSIONS_DIR.glob("*.py")), ids=lambda p: p.name)
def test_db_alembic_upgrade_is_not_destructive(path: Path) -> None:
    text = _upgrade_text(path)
    for pattern in _DESTRUCTIVE_SQL:
        assert not pattern.search(text), f"{path.name}: padrão destrutivo {pattern.pattern!r} no upgrade"


@pytest.mark.parametrize("path", sorted(SQL_DIR.glob("*.sql")), ids=lambda p: p.name)
def test_db_sql_mirror_is_not_destructive(path: Path) -> None:
    text = _strip_sql_comments(path.read_text(encoding="utf-8"))
    for pattern in _DESTRUCTIVE_SQL:
        assert not pattern.search(text), f"{path.name}: padrão destrutivo {pattern.pattern!r}"


def test_db_no_security_definer_without_search_path() -> None:
    files = list(VERSIONS_DIR.glob("*.py")) + list(SQL_DIR.glob("*.sql"))
    for path in files:
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"SECURITY\s+DEFINER", text, re.IGNORECASE):
            window = text[match.start(): match.start() + 400]
            assert re.search(r"SET\s+search_path", window, re.IGNORECASE), (
                f"{path.name}: SECURITY DEFINER sem SET search_path"
            )


def test_db_alembic_revision_chain_is_linear() -> None:
    revisions: dict[str, str | None] = {}
    for path in VERSIONS_DIR.glob("*.py"):
        module = _load_module(path)
        assert module.revision not in revisions, f"revision duplicada: {module.revision}"
        revisions[module.revision] = module.down_revision
        assert callable(getattr(module, "downgrade", None)), f"{path.name}: sem downgrade()"
    down_targets = [d for d in revisions.values() if d is not None]
    assert len(down_targets) == len(set(down_targets)), "ramificação (branch) de revisões"
    heads = set(revisions) - set(down_targets)
    assert heads == {"0006_email_settings_permission"}, heads


# ---------------------------------------------------------------------------
# Modelos
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("model", [Asset, ImportPreviewItem], ids=lambda m: m.__name__)
def test_db_patrimony_number_is_text_never_float(model) -> None:
    column = model.__table__.c.patrimony_number
    assert isinstance(column.type, Text)
    assert not isinstance(column.type, (Float, Numeric))


def test_db_no_patrimony_column_is_numeric_anywhere() -> None:
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if "patrimon" in column.name:
                assert not isinstance(column.type, (Float, Numeric)), f"{table.name}.{column.name}"


def test_db_initial_migration_declares_patrimony_number_as_text() -> None:
    source = (VERSIONS_DIR / "0001_initial_schema.py").read_text(encoding="utf-8")
    assert re.search(r'"patrimony_number",\s*sa\.Text\(\)', source)
    assert not re.search(r'"patrimony_number",\s*sa\.(Float|Numeric|Integer)', source)


def test_db_all_datetime_columns_are_timezone_aware() -> None:
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, DateTime):
                assert column.type.timezone, f"{table.name}.{column.name} não é timestamptz"


def test_db_asset_optimistic_locking_is_wired_to_mapper() -> None:
    mapper = class_mapper(Asset)
    assert mapper.version_id_col is Asset.__table__.c.version
    # incremento explícito pela aplicação (import_service)
    assert mapper.version_id_generator is False


def test_db_asset_soft_delete_columns_and_check() -> None:
    table = Asset.__table__
    assert table.c.deleted_at.nullable and isinstance(table.c.deleted_at.type, DateTime)
    assert table.c.deleted_by.nullable
    names = {c.name for c in table.constraints}
    assert "ck_assets_deleted_by_required" in names


def test_db_asset_movements_are_not_orm_cascade_deleted() -> None:
    cascade = class_mapper(Asset).relationships["movements"].cascade
    assert not cascade.delete
    assert not cascade.delete_orphan


# ---------------------------------------------------------------------------
# Migração 0004_db_security_hardening
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def hardening() -> ModuleType:
    return _load_module(HARDENING_PY)


def test_db_hardening_covers_every_model_table_with_rls(hardening) -> None:
    # Tabelas criadas depois da 0004 têm RLS habilitado na própria migração
    # que as cria (0005: NEW_TABLES); ver testes da 0005 abaixo.
    settings_mig = _load_module(SETTINGS_PY)
    covered = set(hardening.APP_TABLES) | set(settings_mig.NEW_TABLES)
    model_tables = set(Base.metadata.tables)
    assert model_tables <= covered, model_tables - covered
    for table in model_tables & set(hardening.APP_TABLES):
        assert f"'{table}'" in hardening.ENABLE_RLS_SQL


def test_db_hardening_makes_audit_logs_append_only(hardening) -> None:
    sql = hardening.AUDIT_LOGS_TRIGGERS_SQL
    assert re.search(r"BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+public\.audit_logs", sql)
    assert re.search(r"BEFORE\s+TRUNCATE\s+ON\s+public\.audit_logs", sql)
    assert "REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs" in hardening.REVOKE_API_ROLES_SQL


def test_db_hardening_blocks_physical_delete_of_patrimony(hardening) -> None:
    assert {"assets", "asset_movements", "raw_import_records"} <= set(
        hardening.NO_PHYSICAL_DELETE_TABLES
    )
    assert "BEFORE DELETE" in hardening.NO_DELETE_TRIGGERS_SQL
    assert "BEFORE TRUNCATE" in hardening.NO_DELETE_TRIGGERS_SQL
    assert "'assets'" in hardening.NO_DELETE_TRIGGERS_SQL


def test_db_hardening_revokes_data_api_roles(hardening) -> None:
    sql = hardening.REVOKE_API_ROLES_SQL
    assert "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated" in sql
    assert "REVOKE ALL ON TABLES FROM anon, authenticated" in sql  # default privileges


def test_db_hardening_function_is_invoker_with_fixed_search_path(hardening) -> None:
    sql = hardening.BLOCK_FUNCTION_SQL
    assert "SECURITY INVOKER" in sql
    assert "SET search_path = ''" in sql
    assert "REVOKE ALL ON FUNCTION public.sispat_block_mutation() FROM PUBLIC" in sql


def test_db_hardening_is_idempotent_by_construction(hardening) -> None:
    upgrade_sql = "\n".join(hardening.UPGRADE_STATEMENTS)
    # Toda criação usa CREATE OR REPLACE ou é protegida por verificação prévia.
    for match in re.finditer(r"\bCREATE\s+(?!OR\s+REPLACE)(\w+)", upgrade_sql):
        pytest.fail(f"CREATE sem OR REPLACE: {match.group(0)!r}")
    assert "IF NOT EXISTS" in hardening.ASSETS_DELETED_BY_CHECK_SQL


def test_db_hardening_sql_mirror_matches_alembic(hardening) -> None:
    mirror = HARDENING_SQL.read_text(encoding="utf-8")
    for statement in hardening.UPGRADE_STATEMENTS:
        assert statement.strip("\n") in mirror
    assert "PENDENTE DE APLICAÇÃO" in mirror


def test_db_hardening_downgrade_never_disables_rls(hardening) -> None:
    assert "DISABLE ROW LEVEL SECURITY" not in hardening.DOWNGRADE_SQL.upper()


# ---------------------------------------------------------------------------
# Migração 0005_settings_ai_users
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def settings_migration() -> ModuleType:
    return _load_module(SETTINGS_PY)


def test_db_0005_revises_0004(settings_migration) -> None:
    assert settings_migration.revision == "0005_settings_ai_users"
    assert settings_migration.down_revision == "0004_db_security_hardening"


def test_db_0005_new_tables_have_rls_and_revoke(settings_migration) -> None:
    assert set(settings_migration.NEW_TABLES) == {"ai_settings", "user_preferences"}
    for table in settings_migration.NEW_TABLES:
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in (
            settings_migration.ENABLE_RLS_NEW_TABLES_SQL
        )
        assert f"REVOKE ALL ON TABLE public.{table} FROM anon, authenticated" in (
            settings_migration.REVOKE_API_ROLES_NEW_TABLES_SQL
        )
    # REVOKE condicionado à existência das roles do Supabase.
    assert "pg_roles WHERE rolname = 'anon'" in settings_migration.REVOKE_API_ROLES_NEW_TABLES_SQL
    # sem políticas permissivas
    assert "CREATE POLICY" not in "\n".join(settings_migration.UPGRADE_STATEMENTS).upper()


def test_db_0005_is_idempotent_by_construction(settings_migration) -> None:
    upgrade_sql = "\n".join(settings_migration.UPGRADE_STATEMENTS)
    for match in re.finditer(r"\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)", upgrade_sql):
        pytest.fail(f"CREATE TABLE sem IF NOT EXISTS: {match.group(0)!r}")
    for match in re.finditer(r"\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)", upgrade_sql):
        pytest.fail(f"ADD COLUMN sem IF NOT EXISTS: {match.group(0)!r}")
    for match in re.finditer(r"\bINSERT\s+INTO\b", upgrade_sql):
        tail = upgrade_sql[match.start():]
        stmt = tail.split(";", 1)[0]
        assert "ON CONFLICT" in stmt, stmt[:80]


def test_db_0005_ai_settings_is_singleton_disabled_and_keyless(settings_migration) -> None:
    sql = settings_migration.CREATE_AI_SETTINGS_SQL
    assert "CHECK (id = 1)" in sql
    assert "enabled boolean NOT NULL DEFAULT false" in sql
    assert "provider IN ('none','openai','anthropic','deepseek')" in sql
    assert "provider <> 'deepseek' OR deepseek_acknowledged_at IS NOT NULL" in sql
    # chaves de API nunca no banco
    assert not re.search(r"api_key|secret|token\s+text", sql, re.IGNORECASE)
    seed = settings_migration.SEED_AI_SETTINGS_SQL
    assert "1, false, 'none'" in seed and "ON CONFLICT (id) DO NOTHING" in seed


def test_db_0005_user_preferences_checks(settings_migration) -> None:
    sql = settings_migration.CREATE_USER_PREFERENCES_SQL
    assert "density IN ('comfortable','compact')" in sql
    assert "font_scale IN (100, 112, 125)" in sql


def test_db_0005_permissions_seeded_only_for_adm(settings_migration) -> None:
    sql = settings_migration.SEED_PERMISSIONS_SQL
    for code in settings_migration.NEW_PERMISSIONS:
        assert f"'{code}'" in sql
    assert re.findall(r"WHERE r\.code = '(\w+)'", sql) == ["ADM"]
    assert "'USER'" not in sql and "'RH'" not in sql


def test_db_0005_downgrade_only_removes_its_own_objects(settings_migration) -> None:
    sql = settings_migration.DOWNGRADE_SQL
    dropped_tables = set(re.findall(r"DROP TABLE IF EXISTS public\.(\w+)", sql))
    assert dropped_tables == set(settings_migration.NEW_TABLES)
    dropped_cols = set(re.findall(r"DROP COLUMN IF EXISTS (\w+)", sql))
    assert dropped_cols == {
        "version", "sessions_revoked_at", "avatar_object_key", "deactivated_at", "deactivated_by"
    }
    assert not re.search(r"^\s*DELETE\s+FROM|TRUNCATE", sql, re.IGNORECASE | re.MULTILINE)
    assert "DISABLE ROW LEVEL SECURITY" not in sql.upper()


def test_db_0005_sql_mirror_matches_alembic(settings_migration) -> None:
    mirror = SETTINGS_SQL.read_text(encoding="utf-8")
    for statement in settings_migration.UPGRADE_STATEMENTS:
        assert statement.strip("\n") in mirror
    assert "PENDENTE DE APLICAÇÃO" in mirror


# ---------------------------------------------------------------------------
# Migração 0006_email_settings_permission
# ---------------------------------------------------------------------------

EMAIL_PERM_PY = VERSIONS_DIR / "0006_email_settings_permission.py"
EMAIL_PERM_SQL = SQL_DIR / "0009_email_settings_permission.sql"


@pytest.fixture(scope="module")
def email_perm_migration() -> ModuleType:
    return _load_module(EMAIL_PERM_PY)


def test_db_0006_revises_0005_and_seeds_only_adm(email_perm_migration) -> None:
    assert email_perm_migration.down_revision == "0005_settings_ai_users"
    assert email_perm_migration.NEW_PERMISSIONS == ("settings.email.manage",)
    sql = email_perm_migration.SEED_PERMISSIONS_SQL
    assert re.findall(r"WHERE r\.code = '(\w+)'", sql) == ["ADM"]
    for stmt in re.findall(r"INSERT INTO[^;]*;", sql):
        assert "ON CONFLICT" in stmt


def test_db_0006_permission_matches_route() -> None:
    route = (Path(__file__).resolve().parents[1] / "app" / "api" / "v1" / "email_settings.py")
    assert '_PERMISSION = "settings.email.manage"' in route.read_text(encoding="utf-8")


def test_db_0006_downgrade_only_removes_its_permission(email_perm_migration) -> None:
    sql = email_perm_migration.DOWNGRADE_SQL
    assert sql.count("settings.email.manage") == 2
    assert "DROP" not in sql.upper() and "TRUNCATE" not in sql.upper()


def test_db_0006_sql_mirror_matches_alembic(email_perm_migration) -> None:
    mirror = EMAIL_PERM_SQL.read_text(encoding="utf-8")
    for statement in email_perm_migration.UPGRADE_STATEMENTS:
        assert statement.strip("\n") in mirror
    assert "PENDENTE DE APLICAÇÃO" in mirror
    assert not re.search(r"^\s*(BEGIN|COMMIT);", mirror, re.MULTILINE)


def test_db_0005_models_match_migration_constraints() -> None:
    from app.models.rbac import User
    from app.models.settings import AISettings, UserPreferences

    assert AISettings.__tablename__ == "ai_settings"
    assert UserPreferences.__tablename__ == "user_preferences"
    ai_checks = {c.name for c in AISettings.__table__.constraints}
    assert {"ck_ai_settings_singleton", "ck_ai_settings_provider", "ck_ai_settings_deepseek_ack"} <= ai_checks
    pref_checks = {c.name for c in UserPreferences.__table__.constraints}
    assert {"ck_user_preferences_density", "ck_user_preferences_font_scale"} <= pref_checks
    cols = User.__table__.c
    for name in ("version", "sessions_revoked_at", "avatar_object_key", "deactivated_at", "deactivated_by"):
        assert name in cols, name
    assert not cols.version.nullable
    assert not any("key" in c.name and c.name != "avatar_object_key" for c in AISettings.__table__.columns)
