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

from sqlalchemy import func, literal
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


ALNUM_KEY_FUNCTION = "sispat_alnum_key"
MAX_SEARCH_TOKENS = 8


def alnum_key(value: str | None) -> str | None:
    """Chave alfanumérica: sem acento, minúsculas, só letras/dígitos (sem
    pontuação, espaços, NBSP). Espelha `public.sispat_alnum_key` (migração 0016)."""
    if value is None:
        return None
    return "".join(ch for ch in strip_accents(value).lower() if ch.isalnum())


class sispat_alnum_key(FunctionElement):  # noqa: N801 - nome = função SQL
    type = String()
    name = ALNUM_KEY_FUNCTION
    inherit_cache = True


@compiles(sispat_alnum_key)
def _compile_alnum_key(element: Any, compiler: Any, **kw: Any) -> str:
    return f"{ALNUM_KEY_FUNCTION}({compiler.process(element.clauses, **kw)})"


def search_tokens(term: str) -> list[str]:
    """Divide o termo em tokens por qualquer espaço Unicode (inclui NBSP).

    Tokens só de pontuação são descartados, exceto se TODOS forem assim (então
    ficam como estão, p.ex. `%` buscado literalmente). Limite: `MAX_SEARCH_TOKENS`.
    """
    # Controles (inclui NUL, que o PostgreSQL recusa em texto) viram separador.
    tokens = "".join(" " if ch.isprintable() is False and not ch.isspace() else ch for ch in term).split()
    useful = [t for t in tokens if any(ch.isalnum() for ch in t)]
    return (useful or tokens)[:MAX_SEARCH_TOKENS]


def contains_ci_db(column_expr: Any, token: str) -> Any:
    """Como `contains_ci`, mas o termo passa pelo MESMO `sispat_unaccent` da
    coluna e o escape de `\\`, `%` e `_` é feito no banco (bind único)."""
    escaped = func.replace(
        func.replace(
            func.replace(sispat_unaccent(literal(token, String())), LIKE_ESCAPE_CHAR,
                         LIKE_ESCAPE_CHAR * 2),
            "%", f"{LIKE_ESCAPE_CHAR}%"),
        "_", f"{LIKE_ESCAPE_CHAR}_")
    pattern = literal("%", String()).concat(escaped).concat(literal("%", String()))
    return sispat_unaccent(column_expr).ilike(pattern, escape=LIKE_ESCAPE_CHAR)


def key_contains(column_expr: Any, token: str) -> Any:
    """`sispat_alnum_key(coluna)` contém a chave do token (índice trigram 0016)."""
    pattern = literal("%", String()).concat(sispat_alnum_key(literal(token, String()))).concat(
        literal("%", String()))
    return sispat_alnum_key(column_expr).like(pattern)


def register_sqlite_functions(dbapi_connection: Any) -> None:
    """Registra `sispat_unaccent`/`sispat_alnum_key` numa conexão sqlite3 (testes)."""
    dbapi_connection.create_function(
        UNACCENT_FUNCTION, 1, lambda v: None if v is None else strip_accents(v), deterministic=True
    )
    dbapi_connection.create_function(ALNUM_KEY_FUNCTION, 1, alnum_key, deterministic=True)
