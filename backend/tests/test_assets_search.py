"""Busca de `/assets?q=` (chave alfanumérica, tokens, acentos, EXISTS) e migração 0016.

SQLite com o schema real (mesmo harness de `test_assets_api`); `sispat_unaccent` e
`sispat_alnum_key` são registradas em Python (conftest). Zero rede.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

import test_assets_api as base
from app.models.assets import Asset
from app.security.text_search import alnum_key, search_tokens
from app.services import dashboard_service
from app.services.asset_service import asset_search_clause
from test_assets_api import ADM, ADM_B, RH_A, USER_A, USER_B, ast, h  # noqa: F401
from test_db_static import _load_module  # noqa: F401

NBSP = " "
MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def numbers(ast_, term, sub=ADM, **params):
    r = ast_.client.get("/api/v1/assets", query_string={"q": term, **params}, headers=h(sub))
    assert r.status_code == 200, r.get_json()
    return sorted(x["patrimony_number"] for x in r.get_json()["assets"])


@pytest.fixture(autouse=True)
def _com_movimentacoes(monkeypatch):
    """`dashboard_service.summary` também consulta `asset_movements`."""
    monkeypatch.setattr(base, "TABLES", (*base.TABLES, "asset_movements", "inventories"))


@pytest.fixture()
def seeded(ast):
    w = ast.w
    person = w.person(ast.a, "José da Silva")
    room = w.room(ast.a, "Sala Jurídico")
    w.asset(ast.a, "00123", description="Cadeira giratória preta")
    w.asset(ast.a, "AGU-456", description="Mesa de reunião")
    w.asset(ast.a, "12.345", description="Monitor")
    w.asset(ast.a, "AB123", description="Ação Móvel")
    w.asset(ast.a, "XY9", description="Armário 100% aço", source_record_id="SRC-77")
    w.asset(ast.a, "PERS1", description="Notebook", responsible_person_id=person, room_id=room)
    w.asset(ast.a, "NOFK1", description="Sem vínculos")  # FKs nulas
    w.asset(ast.b, "FOREIGN1", description="Cadeira alheia")
    return ast


@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("00123", ["00123"]),
        ("AGU-456", ["AGU-456"]),
        ("AGU456", ["AGU-456"]),          # chave alfanumérica
        ("agu 456", ["AGU-456"]),         # espaço no lugar da pontuação
        ("12.345", ["12.345"]),
        ("12345", ["12.345"]),
        ("AB 123", ["AB123"]),
        ("ab" + NBSP + "123", ["AB123"]),  # NBSP
        ("   AB123   ", ["AB123"]),
        ("ab123", ["AB123"]),              # caixa
        ("acao", ["AB123"]),               # acento só na coluna
        ("AÇÃO", ["AB123"]),               # acento só no termo
        ("movel acao", ["AB123"]),         # tokens fora de ordem
        ("preta cadeira", ["00123"]),
        ("reuniao mesa", ["AGU-456"]),
        ("cadeira alheia", []),            # fora do escopo do ADM A
        ("src-77", ["XY9"]),               # source_record_id
        ("jose silva", ["PERS1"]),         # responsável via EXISTS
        ("juridico", ["PERS1"]),           # sala via EXISTS
        ("jurídico notebook", ["PERS1"]),  # EXISTS + descrição (AND)
        ("100%", ["XY9"]),                 # % literal
        ("%", ["XY9"]),
        ("A_1", []),                       # _ literal, não curinga
        ("\\", []),
        ("inexistente", []),
        ("1 2 3 4 5 6 7 8 9 10", []),     # mais tokens que o limite: não explode
    ],
)
def test_busca_variantes(seeded, term, expected):
    assert numbers(seeded, term) == sorted(expected)


def test_fks_nulas_nao_casam_nem_quebram(seeded):
    assert numbers(seeded, "sem vinculos") == ["NOFK1"]
    assert numbers(seeded, "jose") == ["PERS1"]  # NOFK1 (FKs nulas) fora


def test_escopo_unit_e_owner_na_busca(seeded):
    # bem alocado em B, mas pertencente a A: visível a A; USER_B vê o seu e o owner de A
    seeded.w.asset(seeded.b, "OWN-A", description="Cadeira cedida", owner_unit_id=seeded.a)
    assert numbers(seeded, "cedida", ADM) == ["OWN-A"]
    assert numbers(seeded, "cedida", USER_A) == ["OWN-A"]
    assert numbers(seeded, "cedida", USER_B) == ["OWN-A"]
    assert numbers(seeded, "cedida", RH_A) == ["OWN-A"]
    # A não vê o que é só de B; B não vê o que é só de A
    assert numbers(seeded, "alheia", USER_A) == [] and numbers(seeded, "alheia", ADM_B) == ["FOREIGN1"]
    assert numbers(seeded, "jose", USER_B) == []
    assert numbers(seeded, "jose", ADM) == ["PERS1"]


def test_responsavel_de_outra_unidade_nao_vaza_bem_fora_do_escopo(seeded):
    other_person = seeded.w.person(seeded.b, "Zélia Exclusiva")
    seeded.w.asset(seeded.b, "ONLY-B", description="Teclado", responsible_person_id=other_person)
    assert numbers(seeded, "zelia", USER_A) == []
    assert numbers(seeded, "zelia", USER_B) == ["ONLY-B"]


def test_pagina_fora_do_range(seeded):
    r = seeded.client.get("/api/v1/assets", query_string={"q": "cadeira", "page": 99}, headers=h(ADM))
    body = r.get_json()
    assert r.status_code == 200 and body["assets"] == [] and body["total"] == 1 and body["page"] == 99


@pytest.mark.parametrize("page_size", [50, 100, 200])
def test_uniao_das_paginas_e_total_e_contagem_do_dashboard(ast, page_size):
    with ast.w.session() as db:
        for i in range(123):
            db.add(Asset(id=uuid.uuid4(), patrimony_number=f"N{i:04d}", unit_id=ast.a, version=1,
                         description="Lote"))
    first = ast.client.get("/api/v1/assets", query_string={"page_size": page_size}, headers=h(ADM)).get_json()
    seen, page = [], 1
    while True:
        body = ast.client.get("/api/v1/assets", query_string={"page_size": page_size, "page": page,
                                                              "sort": "patrimony_number"},
                              headers=h(ADM)).get_json()
        seen += [x["id"] for x in body["assets"]]
        if page >= body["pages"]:
            break
        page += 1
    assert first["total"] == 123 == len(seen) == len(set(seen))
    with ast.w.session() as db:
        assert dashboard_service.summary(db, ast.adm)["total_bens"] == first["total"]
    # a busca também particiona sem perder/duplicar
    found = ast.client.get("/api/v1/assets", query_string={"q": "lote", "page_size": 50}, headers=h(ADM)).get_json()
    assert found["total"] == 123


def test_filtro_unit_id_e_alocadora_e_escopo_continua_unit_ou_owner(seeded):
    seeded.w.asset(seeded.b, "OWN-A2", owner_unit_id=seeded.a)
    r = seeded.client.get("/api/v1/assets", query_string={"unit_id": str(seeded.a)}, headers=h(ADM))
    assert "OWN-A2" not in [x["patrimony_number"] for x in r.get_json()["assets"]]
    r = seeded.client.get("/api/v1/assets", query_string={"owner_unit_id": str(seeded.a)}, headers=h(ADM))
    assert [x["patrimony_number"] for x in r.get_json()["assets"]] == ["OWN-A2"]


# -- unidade ---------------------------------------------------------------


def test_alnum_key_e_tokens():
    assert alnum_key("AGU-12.3 Ç x") == "agu123cx"
    assert alnum_key(None) is None
    assert search_tokens("  AB  123 - ") == ["AB", "123"]
    assert search_tokens("%") == ["%"]
    assert search_tokens("   ") == []
    assert len(search_tokens(" ".join("a" * 20)) ) == 8


def test_clausula_postgres_usa_binds_e_funcoes():
    clause = asset_search_clause("x%_\\'; DROP TABLE assets 12-3")
    sql = str(select(Asset.id).where(clause).compile(dialect=postgresql.dialect()))
    assert "DROP" not in sql and "x%" not in sql
    assert "sispat_unaccent" in sql and "sispat_alnum_key" in sql and "EXISTS" in sql
    assert "ESCAPE" in sql
    assert " JOIN " not in sql.upper()


# -- migração 0016 -----------------------------------------------------------


def test_migracao_0016_aditiva_com_downgrade_e_espelho():
    mod = _load_module(MIGRATIONS / "versions" / "0016_asset_search_key.py")
    assert mod.revision == "0016_asset_search_key" and len(mod.revision) <= 32
    assert mod.down_revision == "0015_asset_tech_classification"
    up = "\n".join(mod.UPGRADE_STATEMENTS)
    assert "IMMUTABLE" in up and "SET search_path" in up
    assert "CREATE INDEX IF NOT EXISTS ix_assets_patrimony_key_trgm" in up and "gin_trgm_ops" in up
    assert not re.search(r"\b(UPDATE|DELETE|INSERT|TRUNCATE|DROP|GRANT|ALTER)\b", up, re.IGNORECASE)
    assert re.findall(r"DROP (INDEX|FUNCTION) IF EXISTS", mod.DOWNGRADE_SQL) == ["INDEX", "FUNCTION"]
    assert "DROP TABLE" not in mod.DOWNGRADE_SQL.upper()
    mirror = (MIGRATIONS / "sql" / "0019_asset_search_key.sql").read_text(encoding="utf-8")
    for statement in mod.UPGRADE_STATEMENTS:
        assert statement.strip("\n") in mirror
    assert "PENDENTE DE APLICAÇÃO" in mirror
    assert not re.search(r"^\s*(BEGIN|COMMIT)\s*;", mirror, re.IGNORECASE | re.MULTILINE)
