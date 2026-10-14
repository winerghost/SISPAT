"""Testes de regressão — utilitários de sanitização e CSV/Formula Injection.

Auditoria AppSec 2026-10-13 (backend-data): `app.security.sanitize` e
`app.security.csv_safety`. Sem rede, sem banco.
"""
from __future__ import annotations

import csv
import io
from decimal import Decimal

import pytest
from sqlalchemy import Column, MetaData, Table, Text, select
from sqlalchemy.dialects import postgresql

from app.security.csv_safety import (
    build_safe_csv,
    escape_formula,
    escape_row,
    is_formula_like,
)
from app.security.sanitize import (
    LIKE_ESCAPE_CHAR,
    canonical_header,
    escape_like,
    has_control_chars,
    make_db_safe,
    normalize_free_text,
    normalize_identifier,
)

# ---------------------------------------------------------------------------
# escape_like (CWE-89 / wildcard injection em ILIKE)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("100%", "100\\%"),
        ("a_b", "a\\_b"),
        ("c:\\x", "c:\\\\x"),
        ("%_%", "\\%\\_\\%"),
        ("normal", "normal"),
        ("' OR 1=1 --", "' OR 1=1 --"),  # sem metacaractere LIKE: inalterado
    ],
)
def test_escape_like_escapa_metacaracteres(term: str, expected: str) -> None:
    assert escape_like(term) == expected


def test_ilike_com_escape_gera_bind_parameter_e_clausula_escape() -> None:
    """O termo vai como bind parameter (nunca concatenado) e com ESCAPE."""
    table = Table("t", MetaData(), Column("description", Text))
    malicious = "x%' OR '1'='1"
    stmt = select(table).where(
        table.c.description.ilike(f"%{escape_like(malicious)}%", escape=LIKE_ESCAPE_CHAR)
    )
    compiled = stmt.compile(dialect=postgresql.dialect())
    sql = str(compiled)
    assert "OR '1'='1" not in sql
    assert "ESCAPE" in sql
    assert list(compiled.params.values()) == ["%x\\%' OR '1'='1%"]


# ---------------------------------------------------------------------------
# make_db_safe / normalização
# ---------------------------------------------------------------------------


def test_make_db_safe_substitui_nul_e_surrogate_preservando_o_resto() -> None:
    value = "abc\x00<b>def\ud800"
    safe, changed = make_db_safe(value)
    assert changed is True
    assert safe == "abc\ufffd<b>def\ufffd"
    # texto já seguro é devolvido idêntico (mesmo objeto)
    original = "Mesa <madeira> = 'ok'"
    same, changed2 = make_db_safe(original)
    assert changed2 is False and same is original


def test_normalize_free_text_nao_e_destrutivo() -> None:
    texto = "  <script>alert(1)</script> =SOMA(A1) \u00e7\u00e3o  "
    assert normalize_free_text(texto) == "<script>alert(1)</script> =SOMA(A1) ção"


def test_normalize_free_text_aplica_nfc() -> None:
    decomposed = "Cadeira girato\u0301ria"  # 'o' + acento combinante
    assert normalize_free_text(decomposed) == "Cadeira giratória"


def test_normalize_identifier_remove_invisiveis_e_bom() -> None:
    assert normalize_identifier("\ufeff\u200b000123\u200d\u00a0") == "000123"


def test_has_control_chars_detecta_cc_e_cf() -> None:
    assert has_control_chars("12\t3")
    assert has_control_chars("12\u202e3")  # RLO (bidi spoofing)
    assert not has_control_chars("000123-A/2")


def test_canonical_header_casa_variacoes() -> None:
    for header in ("PATRIMONIO", " patrimonio ", "\ufeffPatrimônio", "PATRIMO\u0302NIO"):
        assert canonical_header(header) == "PATRIMONIO"
    assert canonical_header(None) == ""


# ---------------------------------------------------------------------------
# CSV / Formula Injection (CWE-1236)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        "=1+1",
        "+1+1",
        "-1+1",
        "@SUM(A1)",
        "\t=1",
        "\r=1",
        '=HYPERLINK("http://evil","x")',
        "=cmd|' /C calc'!A0",
        " =1+1",  # espaço inicial
        '"=1+1',  # aspas iniciais
        "'=1+1",
        "\uff1d1+1",  # sinal de igual de largura total
    ],
)
def test_escape_formula_neutraliza_payloads(payload: str) -> None:
    assert is_formula_like(payload)
    escaped = escape_formula(payload)
    assert escaped == "'" + payload


@pytest.mark.parametrize("value", ["Mesa", "000123", "a=b", "email@exemplo.com", "", "R$ -5"])
def test_escape_formula_preserva_textos_benignos(value: str) -> None:
    assert escape_formula(value) == value


def test_escape_formula_preserva_tipos_numericos_e_none() -> None:
    assert escape_formula(-5) == -5
    assert escape_formula(1.5) == 1.5
    assert escape_formula(Decimal("-2.10")) == Decimal("-2.10")
    assert escape_formula(True) is True
    assert escape_formula(None) == ""


def test_build_safe_csv_quote_all_e_escape_em_cabecalho_e_linhas() -> None:
    content = build_safe_csv(
        ["PATRIMONIO", "=DESCRICAO"],
        [["000123", '=HYPERLINK("http://x";"y")'], ["-10", 'texto "com" aspas;e delimitador']],
    )
    rows = list(csv.reader(io.StringIO(content), delimiter=";"))
    assert rows[0] == ["PATRIMONIO", "'=DESCRICAO"]
    assert rows[1] == ["000123", '\'=HYPERLINK("http://x";"y")']
    assert rows[2] == ["'-10", 'texto "com" aspas;e delimitador']
    # QUOTE_ALL: toda célula entre aspas
    assert content.splitlines()[0] == '"PATRIMONIO";"\'=DESCRICAO"'


def test_escape_row_aplica_em_todas_as_celulas() -> None:
    assert escape_row(["=a", "b", None, 3]) == ["'=a", "b", "", 3]
