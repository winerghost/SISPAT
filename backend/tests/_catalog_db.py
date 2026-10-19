"""Infra de testes (SQLite em memória) das importações de bens e cadastros.

Mesmo racional de `tests/test_user_admin_db.py`: schema REAL dos modelos, com
adaptações apenas no DDL de teste (JSONB -> JSON, defaults PostgreSQL trocados,
CHECKs de sintaxe PostgreSQL removidos). Nenhuma rede, nenhum banco real.
"""
from __future__ import annotations

from sqlalchemy import CheckConstraint, MetaData, create_engine, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import DefaultClause

import app.models  # noqa: F401  (popula Base.metadata)
from app.database.session import Base

TABLES = (
    "users",
    "units",
    "unit_aliases",
    "user_unit_access",
    "rooms",
    "locations",
    "responsible_people",
    "assets",
    "import_previews",
    "import_preview_items",
    "sync_jobs",
    "raw_import_records",
    "audit_logs",
)


@compiles(JSONB, "sqlite")
def _jsonb_as_json(_type, _compiler, **_kw):  # pragma: no cover - trivial
    return "JSON"


def build_engine():
    engine = create_engine(
        "sqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
        future=True,
    )
    metadata = MetaData()
    for name in TABLES:
        table = Base.metadata.tables[name].to_metadata(metadata)
        for constraint in list(table.constraints):
            if isinstance(constraint, CheckConstraint):
                table.constraints.discard(constraint)
        for column in table.columns:
            default = column.server_default
            if default is None:
                continue
            arg = str(getattr(default, "arg", "")).strip().lower()
            if "gen_random_uuid" in arg:
                column.server_default = None
            elif "now()" in arg:
                column.server_default = DefaultClause(text("CURRENT_TIMESTAMP"))
            elif arg == "true":
                column.server_default = DefaultClause(text("1"))
            elif arg == "false":
                column.server_default = DefaultClause(text("0"))
    metadata.create_all(engine)
    return engine


def new_session(engine) -> Session:
    return Session(engine, expire_on_commit=False, future=True)
