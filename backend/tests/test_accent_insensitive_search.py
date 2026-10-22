"""Busca sem acento/caixa com escape de % e _ (regressão)."""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.models.units import Unit
from app.security.text_search import contains_ci, strip_accents
from sqlalchemy import Column, MetaData, String, Table, create_engine, text

meta = MetaData()
T = Table("t", meta, Column("name", String))


@pytest.fixture()
def conn():
    engine = create_engine("sqlite://")
    meta.create_all(engine)
    with engine.begin() as c:
        for n in ("João Silva", "MARIA ÁVILA", "50% off", "a_b", "axb", "Sala Térreo", None):
            c.execute(T.insert().values(name=n))
        yield c


def _find(conn, term):
    return sorted(r[0] for r in conn.execute(select(T.c.name).where(contains_ci(T.c.name, term))))


@pytest.mark.parametrize("term,expected", [
    ("joao", ["João Silva"]), ("JOÃO", ["João Silva"]), ("avila", ["MARIA ÁVILA"]),
    ("terreo", ["Sala Térreo"]),
])
def test_acento_e_caixa(conn, term, expected):
    assert _find(conn, term) == expected


def test_escape_de_curinga(conn):
    assert _find(conn, "%") == ["50% off"]
    assert _find(conn, "a_b") == ["a_b"]  # "_" literal: nao casa "axb"
    assert _find(conn, "\\") == []


def test_strip_accents():
    assert strip_accents("Ação Ünï") == "Acao Uni"


def test_postgres_usa_funcao_e_bind():
    sql = str(select(Unit.id).where(contains_ci(Unit.name, "jo'ao"))
              .compile(dialect=postgresql.dialect()))
    assert "sispat_unaccent(units.name)" in sql and "jo'ao" not in sql
