r"""Busca textual case/acento-insensível, parametrizada e com escape de LIKE.

`contains_ci(coluna, termo)` gera `sispat_unaccent(coluna) ILIKE :padrao ESCAPE '\'`,
onde o padrão (bind parameter) é o termo sem acentos, com `%`, `_` e `\` escapados.
Em PostgreSQL `sispat_unaccent` é um wrapper IMMUTABLE de `unaccent` criado pela
migração 0014 (nunca SQL concatenado). Em SQLite (testes) a função é registrada
em Python (`register_sqlite_functions`).
"""
from __future__ import annotations

import unicodedata
from typing import Any

from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.expression import FunctionElement
from sqlalchemy.types import String

from app.security.sanitize import LIKE_ESCAPE_CHAR, escape_like

UNACCENT_FUNCTION = "sispat_unaccent"


def strip_accents(value: str) -> str:
    """Remove marcas diacríticas (NFKD) — equivalente prático ao `unaccent`."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


class sispat_unaccent(FunctionElement):  # noqa: N801 - nome = função SQL
    type = String()
    name = UNACCENT_FUNCTION
    inherit_cache = True


@compiles(sispat_unaccent)
def _compile_unaccent(element: Any, compiler: Any, **kw: Any) -> str:
    return f"{UNACCENT_FUNCTION}({compiler.process(element.clauses, **kw)})"


def contains_ci(column_expr: Any, term: str) -> Any:
    """Predicado "contém `term`" sem caixa e sem acento (valor sempre como bind)."""
    pattern = f"%{escape_like(strip_accents(term))}%"
    return sispat_unaccent(column_expr).ilike(pattern, escape=LIKE_ESCAPE_CHAR)


def register_sqlite_functions(dbapi_connection: Any) -> None:
    """Registra `sispat_unaccent` numa conexão sqlite3 (uso em testes)."""
    dbapi_connection.create_function(
        UNACCENT_FUNCTION, 1, lambda v: None if v is None else strip_accents(v), deterministic=True
    )
