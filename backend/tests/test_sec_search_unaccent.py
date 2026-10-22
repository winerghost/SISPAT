"""Regressão de segurança: busca sem acento (contains_ci), paginação e migração 0014.

Cobre injeção/curingas, escopo de unidade preservado com a busca, visão mínima
para USER (sem e-mail/identificador), teto de tamanho do termo e a migração.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.models.units import Unit
from app.security.text_search import contains_ci
from test_catalog_api import adm, as_, cat  # noqa: F401  (fixture `cat`)

URL = "/api/v1/responsible-people"
ROOT = Path(__file__).resolve().parents[1]
PAYLOADS = ["' OR 1=1 --", "%", "_", "\\", "%' OR '1'='1", "a'; DROP TABLE users;--", "\x00"]


def _seed(cat):
    cat.w.person(cat.a, "José Ávila", email="jose@agu.gov.br", identifier="SIAPE-JOSE")
    cat.w.person(cat.b, "Joana Alheia", email="joana@agu.gov.br")


def _names(r):
    return sorted(p["name"] for p in r.get_json()["people"])


@pytest.mark.parametrize("payload", PAYLOADS)
def test_payloads_de_injecao_nao_quebram_nem_vazam(cat, payload):
    _seed(cat)
    r = cat.client.get(URL, query_string={"q": payload}, headers=adm())
    assert r.status_code in (200, 400)
    if r.status_code == 200:
        # Curingas/aspas são literais. NUL é removido pelo schema (q vazio = sem filtro),
        # mas o escopo da unidade continua valendo: nunca aparece a pessoa alheia.
        assert "Joana Alheia" not in _names(r)
        assert r.get_json()["total"] == (1 if payload == "\x00" else 0)


def test_busca_sem_acento_respeita_escopo_de_unidade(cat):
    _seed(cat)
    # "jo" casa José e Joana, mas o ator (unidade A) só vê a pessoa da própria unidade.
    r = cat.client.get(URL, query_string={"q": "jose avila"}, headers=adm())
    assert _names(r) == ["José Ávila"]
    r = cat.client.get(URL, query_string={"q": "joana"}, headers=adm())
    assert r.get_json()["total"] == 0, "busca não pode vazar pessoa de unidade alheia"


def test_user_nao_enumera_email_ou_identificador_com_acento_ou_caixa(cat):
    _seed(cat)
    h = as_("auth-user-a", aal="aal1")
    for q in ("JOSE@AGU", "siape-jose", "gov.br"):
        assert cat.client.get(URL, query_string={"q": q}, headers=h).get_json()["total"] == 0, q


def test_termo_acima_de_100_caracteres_e_rejeitado(cat):
    r = cat.client.get(URL, query_string={"q": "a" * 101}, headers=adm())
    assert r.status_code == 400


@pytest.mark.parametrize("bad", ["25", "0", "500", "-1", "201", "abc"])
def test_page_size_fora_da_allowlist_e_400_na_api(cat, bad):
    r = cat.client.get(URL, query_string={"page_size": bad}, headers=adm())
    assert r.status_code == 400


def test_contains_ci_postgres_usa_bind_e_escape():
    stmt = select(Unit.id).where(contains_ci(Unit.name, "x%_\\'; DROP"))
    sql = str(stmt.compile(dialect=postgresql.dialect()))
    assert "DROP" not in sql and "ESCAPE" in sql.upper()
    params = stmt.compile(dialect=postgresql.dialect()).params
    assert list(params.values()) == ["%x\\%\\_\\\\'; DROP%"]


def test_fullwidth_percent_nao_vira_curinga():
    # NFKD transforma U+FF05 em "%"; o escape deve vir DEPOIS da normalização.
    stmt = select(Unit.id).where(contains_ci(Unit.name, "％"))
    assert list(stmt.compile(dialect=postgresql.dialect()).params.values()) == ["%\\%%"]


def test_migracao_0014_segura_idempotente_nao_destrutiva_e_espelhada():
    py = (ROOT / "migrations/versions/0014_unaccent_search.py").read_text(encoding="utf-8")
    sql = (ROOT / "migrations/sql/0017_unaccent_search.sql").read_text(encoding="utf-8")
    up = re.search(r'UP_SQL = """(.*?)"""', py, re.S).group(1)
    for text in (up, sql):
        assert "CREATE EXTENSION IF NOT EXISTS unaccent" in text
        assert "CREATE OR REPLACE FUNCTION public.sispat_unaccent" in text
        assert "CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions" in text
        # search_path fixo e minimo (sem public) + chamada qualificada.
        assert re.search(r"SET search_path\s*=\s*extensions,\s*pg_catalog\s*\n", text)
        assert "public, extensions" not in text
        assert re.search(r"AS \$\$ SELECT extensions\.unaccent\(\$1\) \$\$;", text)
        assert not re.search(r"SELECT\s+unaccent\(", text)
        assert "IMMUTABLE" in text and "PARALLEL SAFE" in text and "STRICT" in text
        assert not re.search(r"SECURITY\s+DEFINER", text, re.I)
        text = re.sub(r"--[^\n]*", "", text)  # comentários (rollback documentado)
        assert not re.search(r"\b(DROP|DELETE|TRUNCATE|ALTER\s+TABLE)\b", text, re.I)


def test_header_sem_html_perigoso_e_rota_fixa():
    header = (ROOT.parent / "frontend/src/components/layout/header.tsx").read_text(encoding="utf-8")
    assert "dangerouslySetInnerHTML" not in header and "eval(" not in header
    assert 'GLOBAL_SEARCH_ROUTE = "/patrimonios"' in header
    assert "encodeURIComponent(query)" in header
