"""Testes de regressão — Google Sheets como entrada NÃO confiável.

Auditoria AppSec 2026-10-13 (backend-data). Sem rede/credenciais reais:
`googleapiclient.discovery.build` e `Credentials.from_service_account_file`
são sempre mockados. Dados 100% sintéticos.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from app.integrations.google_sheets_client import (
    GoogleSheetsClient,
    GoogleSheetsClientError,
    _column_letter,
    _disambiguate_headers,
    _quote_sheet_title,
)

_PATCH_CREDS = (
    "app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file"
)
_PATCH_BUILD = "googleapiclient.discovery.build"


class _FakeSettings:
    def __init__(self, **overrides: Any) -> None:
        self.google_sheets_credentials_json = "/run/secrets/sintetico.json"
        self.google_sheets_spreadsheet_id = "planilha-sintetica"
        self.google_sheets_sheet_name = overrides.get("sheet_name", "Patrimonio")
        self.google_sheets_sheet_gid = overrides.get("sheet_gid")
        self.google_sheets_max_rows = overrides.get("max_rows")
        self.google_sheets_max_columns = overrides.get("max_columns")
        self.google_sheets_timeout_seconds = overrides.get("timeout")


def _service_returning(response: Any) -> MagicMock:
    service = MagicMock()
    service.spreadsheets.return_value.values.return_value.get.return_value.execute.return_value = (
        response
    )
    return service


def _read(values: list[list[Any]] | Any, **settings_overrides: Any):
    response = {"values": values} if isinstance(values, list) else values
    service = _service_returning(response)
    with patch(_PATCH_CREDS), patch(_PATCH_BUILD, return_value=service):
        client = GoogleSheetsClient(settings=_FakeSettings(**settings_overrides))
        result = client.read_patrimony_rows()
    return result, service


def _errors(row: dict) -> list[str]:
    return [e for e in row["validation_errors"] if e.startswith("erro:")]


# ---------------------------------------------------------------------------
# Número patrimonial: texto, zeros à esquerda, FORMATTED_VALUE
# ---------------------------------------------------------------------------


def test_usa_formatted_value_e_faixa_limitada_com_titulo_citado() -> None:
    _, service = _read(
        [["ID", "PATRIMONIO"], ["1", "000123"]], sheet_name="Aba d'Ouro", max_rows=50
    )
    kwargs = service.spreadsheets.return_value.values.return_value.get.call_args.kwargs
    assert kwargs["valueRenderOption"] == "FORMATTED_VALUE"
    # aspas simples do título duplicadas; faixa limitada (max_rows + 2, colunas + 1)
    assert kwargs["range"] == "'Aba d''Ouro'!A1:CW52"


def test_zeros_a_esquerda_preservados_como_texto() -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", "000123"], ["2", " 0007 "]])
    assert result.rows[0]["normalized_values"]["PATRIMONIO"] == "000123"
    assert result.rows[1]["normalized_values"]["PATRIMONIO"] == "0007"
    assert result.rows[1]["raw_values"]["PATRIMONIO"] == " 0007 "  # bruto intacto


def test_patrimonio_float_vindo_da_api_e_rejeitado() -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", 123.0]])
    row = result.rows[0]
    assert row["normalized_values"]["PATRIMONIO"] is None
    assert any("ponto flutuante" in e for e in _errors(row))


def test_patrimonio_em_notacao_cientifica_e_rejeitado() -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", "1,23457E+11"]])
    row = result.rows[0]
    assert row["normalized_values"]["PATRIMONIO"] is None
    assert any("notação científica" in e for e in _errors(row))
    assert row["raw_values"]["PATRIMONIO"] == "1,23457E+11"


@pytest.mark.parametrize("value", ["=IMPORTXML(\"http://x\")", "+123", "-123", "@SOMA"])
def test_patrimonio_com_prefixo_de_formula_e_rejeitado(value: str) -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", value]])
    row = result.rows[0]
    assert row["normalized_values"]["PATRIMONIO"] is None
    assert any("formato inesperado" in e for e in _errors(row))
    assert row["raw_values"]["PATRIMONIO"] == value  # bruto preservado


def test_patrimonio_com_controle_ou_muito_longo_e_rejeitado() -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", "12\x0734"], ["2", "9" * 65]])
    assert any("controle" in e for e in _errors(result.rows[0]))
    assert any("excede" in e for e in _errors(result.rows[1]))


def test_patrimonio_so_com_invisiveis_vira_ausente() -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", "​﻿"]])
    assert result.rows[0]["normalized_values"]["PATRIMONIO"] is None
    assert "erro: campo PATRIMONIO ausente ou vazio" in result.rows[0]["validation_errors"]


def test_patrimonio_com_zero_width_e_normalizado() -> None:
    result, _ = _read([["ID", "PATRIMONIO"], ["1", "​000123​"]])
    assert result.rows[0]["normalized_values"]["PATRIMONIO"] == "000123"
    assert _errors(result.rows[0]) == []


# ---------------------------------------------------------------------------
# Cabeçalhos: BOM/acentos, duplicados, colisão de chaves
# ---------------------------------------------------------------------------


def test_cabecalho_com_bom_e_acento_e_reconhecido() -> None:
    result, _ = _read([["﻿ID", "Patrimônio"], ["1", "000123"]])
    row = result.rows[0]
    assert _errors(row) == []
    assert result.headers == ["ID", "Patrimônio"]


def test_cabecalho_patrimonio_duplicado_gera_erro_bloqueante() -> None:
    result, _ = _read([["ID", "PATRIMONIO", "PATRIMONIO"], ["1", "100", "200"]])
    row = result.rows[0]
    assert row["raw_values"] == {"ID": "1", "PATRIMONIO_1": "100", "PATRIMONIO_2": "200"}
    assert any("PATRIMONIO duplicado" in e for e in _errors(row))


def test_cabecalho_id_duplicado_gera_erro_bloqueante() -> None:
    result, _ = _read([["ID", "ID", "PATRIMONIO"], ["1", "2", "100"]])
    assert any("ID duplicado" in e for e in _errors(result.rows[0]))


def test_desambiguacao_nao_sobrescreve_cabecalho_literal_existente() -> None:
    headers = ["RESPONSAVEL_1", "RESPONSAVEL", "RESPONSAVEL"]
    keys = _disambiguate_headers(headers)
    assert len(set(keys)) == 3
    assert keys[0] == "RESPONSAVEL_1"


# ---------------------------------------------------------------------------
# Conteúdo livre: preservado (sem sanitização destrutiva), NUL tratado
# ---------------------------------------------------------------------------


def test_descricao_com_html_e_formula_e_preservada() -> None:
    payload = "<img src=x onerror=alert(1)> =HYPERLINK(\"x\")"
    result, _ = _read([["ID", "PATRIMONIO", "DESCRICAO"], ["1", "100", payload]])
    row = result.rows[0]
    assert row["raw_values"]["DESCRICAO"] == payload
    assert row["normalized_values"]["DESCRICAO"] == payload
    assert _errors(row) == []


def test_nul_e_substituido_com_aviso_para_nao_derrubar_o_postgres() -> None:
    result, _ = _read([["ID", "PATRIMONIO", "DESCRICAO"], ["1", "100", "Mesa\x00azul"]])
    row = result.rows[0]
    assert row["raw_values"]["DESCRICAO"] == "Mesa�azul"
    assert row["normalized_values"]["DESCRICAO"] == "Mesa�azul"
    assert any("NUL" in e and e.startswith("aviso:") for e in row["validation_errors"])
    assert _errors(row) == []


def test_celula_gigante_e_truncada_e_bloqueia_a_linha() -> None:
    result, _ = _read([["ID", "PATRIMONIO", "DESCRICAO"], ["1", "100", "A" * 6000]])
    row = result.rows[0]
    assert len(row["raw_values"]["DESCRICAO"]) == 5000
    assert any("DESCRICAO excede" in e for e in _errors(row))


# ---------------------------------------------------------------------------
# Limites de consumo (API4) e resposta upstream inesperada (API10)
# ---------------------------------------------------------------------------


def test_excesso_de_linhas_falha_fechado() -> None:
    values = [["ID", "PATRIMONIO"]] + [[str(i), str(i)] for i in range(4)]
    with pytest.raises(GoogleSheetsClientError):
        _read(values, max_rows=3)


def test_excesso_de_colunas_falha_fechado() -> None:
    values = [["ID", "PATRIMONIO", "X", "Y"], ["1", "1", "a", "b"]]
    with pytest.raises(GoogleSheetsClientError):
        _read(values, max_columns=3)


@pytest.mark.parametrize("response", [{"values": "nao-e-lista"}, {"values": [["ok"], "x"]}, ["x"]])
def test_resposta_upstream_malformada_vira_erro_de_dominio(response: Any) -> None:
    with pytest.raises(GoogleSheetsClientError):
        _read(response)


def test_timeout_http_explicito_na_construcao_do_servico() -> None:
    with patch(_PATCH_CREDS), patch(_PATCH_BUILD) as mock_build, patch(
        "app.integrations.google_sheets_client.httplib2.Http"
    ) as mock_http:
        mock_build.return_value = _service_returning({"values": []})
        GoogleSheetsClient(settings=_FakeSettings(timeout=7)).read_patrimony_rows()
    mock_http.assert_called_once_with(timeout=7)
    assert "credentials" not in mock_build.call_args.kwargs
    assert "http" in mock_build.call_args.kwargs


def test_gid_configurado_como_string_casa_com_sheetid_inteiro() -> None:
    service = _service_returning({"values": [["ID", "PATRIMONIO"], ["1", "100"]]})
    service.spreadsheets.return_value.get.return_value.execute.return_value = {
        "sheets": [
            {"properties": {"sheetId": 0, "title": "Outra", "index": 0}},
            {"properties": {"sheetId": 123456, "title": "Bens", "index": 1}},
        ]
    }
    with patch(_PATCH_CREDS), patch(_PATCH_BUILD, return_value=service):
        result = GoogleSheetsClient(
            settings=_FakeSettings(sheet_name=None, sheet_gid="123456")
        ).read_patrimony_rows()
    assert result.sheet_title == "Bens"


def test_helpers_de_notacao_a1() -> None:
    assert _column_letter(1) == "A"
    assert _column_letter(26) == "Z"
    assert _column_letter(27) == "AA"
    assert _column_letter(101) == "CW"
    assert _quote_sheet_title("a'b") == "'a''b'"
