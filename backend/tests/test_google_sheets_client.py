"""Testes do cliente de leitura da Google Sheets (`app.integrations.google_sheets_client`).

Nenhuma chamada de rede real é feita e nenhuma credencial real é necessária:
tanto `googleapiclient.discovery.build` quanto
`google.oauth2.service_account.Credentials.from_service_account_file` são
sempre mockados via `unittest.mock.patch`.

Observação sobre o ambiente deste sandbox: `pytest`, `google-api-python-client`
e `google-auth` podem não estar instalados aqui. Este arquivo foi validado com
`python -m py_compile` (sintaxe); se o ambiente de execução tiver as
dependências de `requirements.txt` instaladas, os testes podem ser
executados de fato com:

    pip install -r backend/requirements.txt
    pytest backend/tests/test_google_sheets_client.py -v
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from googleapiclient.errors import HttpError

from app.config.settings import Settings
from app.integrations.google_sheets_client import (
    GoogleSheetsClient,
    GoogleSheetsClientError,
    GoogleSheetsReadResult,
)

CREDENTIALS_PATH_SENTINEL = "/run/secrets/google_sheets_credentials.json"


class _FakeSettings:
    """Settings mínimo, duck-typed, usado nos testes (não depende de
    `google_sheets_*` já estar declarado em `app.config.settings.Settings`)."""

    def __init__(self, **overrides: object) -> None:
        self.google_sheets_credentials_json = overrides.get(
            "google_sheets_credentials_json", CREDENTIALS_PATH_SENTINEL
        )
        self.google_sheets_spreadsheet_id = overrides.get(
            "google_sheets_spreadsheet_id", "SINTETICO-planilha-de-teste-000000000000000"
        )
        self.google_sheets_sheet_name = overrides.get("google_sheets_sheet_name", "Patrimonio")
        self.google_sheets_sheet_gid = overrides.get("google_sheets_sheet_gid", None)


def _make_mock_service(values_rows: list[list[str]]) -> MagicMock:
    """Cria um mock do recurso da Sheets API v4 que responde a
    `spreadsheets().values().get(...).execute()` com `values_rows`."""
    mock_service = MagicMock()
    mock_values_get = mock_service.spreadsheets.return_value.values.return_value.get
    mock_values_get.return_value.execute.return_value = {"values": values_rows}
    return mock_service


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_mapeamento_das_duas_colunas_responsavel(mock_build, mock_from_file) -> None:
    """A primeira coluna RESPONSAVEL deve virar `responsavel_original` e a
    segunda `responsavel_unidade`, na ordem em que aparecem no cabeçalho."""
    headers = ["ID", "PATRIMONIO", "RESPONSAVEL", "RESPONSAVEL", "UNIDADE"]
    data_row = ["1", "00123", "Joao da Silva", "Setor de Compras", "SEDE"]
    mock_build.return_value = _make_mock_service([headers, data_row])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    assert isinstance(result, GoogleSheetsReadResult)
    assert len(result.rows) == 1
    row = result.rows[0]
    assert row["normalized_values"]["responsavel_original"] == "Joao da Silva"
    assert row["normalized_values"]["responsavel_unidade"] == "Setor de Compras"
    # raw_values deve preservar ambas as colunas lado a lado, sob chaves distintas.
    assert row["raw_values"]["RESPONSAVEL_1"] == "Joao da Silva"
    assert row["raw_values"]["RESPONSAVEL_2"] == "Setor de Compras"


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_qt_nunca_e_interpretado_apenas_repassado(mock_build, mock_from_file) -> None:
    """QT deve ser repassado tal como lido, nunca convertido/interpretado."""
    headers = ["ID", "PATRIMONIO", "QT"]
    data_row = ["1", "123", "3"]
    mock_build.return_value = _make_mock_service([headers, data_row])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    row = result.rows[0]
    assert row["raw_values"]["QT"] == "3"
    assert row["normalized_values"]["qt_raw"] == "3"
    # Nunca deve aparecer como int/float em nenhum dos dois dicionários.
    assert isinstance(row["raw_values"]["QT"], str)
    assert isinstance(row["normalized_values"]["qt_raw"], str)
    # Nenhuma chave "quantity"/"qt" numérica deve ser inventada.
    assert "quantity" not in row["normalized_values"]


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_patrimonio_com_zeros_a_esquerda_permanece_string_identica(
    mock_build, mock_from_file
) -> None:
    """PATRIMONIO "00123" deve permanecer exatamente "00123" (string), sem
    perda dos zeros à esquerda e sem conversão para número."""
    headers = ["ID", "PATRIMONIO"]
    data_row = ["1", "00123"]
    mock_build.return_value = _make_mock_service([headers, data_row])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    row = result.rows[0]
    assert row["raw_values"]["PATRIMONIO"] == "00123"
    assert row["normalized_values"]["PATRIMONIO"] == "00123"
    assert isinstance(row["normalized_values"]["PATRIMONIO"], str)


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_linha_sem_patrimonio_gera_validation_errors(mock_build, mock_from_file) -> None:
    """Uma linha sem PATRIMONIO deve gerar erro em validation_errors, mas não
    deve impedir a leitura das demais linhas."""
    headers = ["ID", "PATRIMONIO", "UNIDADE"]
    data_rows = [
        ["1", "", "SEDE"],
        ["2", "456", "SEDE"],
    ]
    mock_build.return_value = _make_mock_service([headers, *data_rows])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    assert len(result.rows) == 2
    first_row = result.rows[0]
    assert any("PATRIMONIO" in err for err in first_row["validation_errors"])
    assert any(err.startswith("erro:") for err in first_row["validation_errors"])

    second_row = result.rows[1]
    assert not any("PATRIMONIO" in err for err in second_row["validation_errors"])


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_linha_sem_id_gera_validation_errors(mock_build, mock_from_file) -> None:
    """Uma linha sem ID também deve gerar erro em validation_errors."""
    headers = ["ID", "PATRIMONIO"]
    data_row = ["", "123"]
    mock_build.return_value = _make_mock_service([headers, data_row])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    row = result.rows[0]
    assert any("ID" in err and err.startswith("erro:") for err in row["validation_errors"])


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_campo_opcional_vazio_gera_apenas_aviso(mock_build, mock_from_file) -> None:
    """Um campo que não seja ID/PATRIMONIO, quando vazio, deve gerar apenas um
    aviso (não um erro bloqueante)."""
    headers = ["ID", "PATRIMONIO", "UNIDADE"]
    data_row = ["1", "123", ""]
    mock_build.return_value = _make_mock_service([headers, data_row])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    row = result.rows[0]
    assert any(
        err.startswith("aviso:") and "UNIDADE" in err for err in row["validation_errors"]
    )
    assert not any(err.startswith("erro:") for err in row["validation_errors"])


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_falha_da_api_e_capturada_e_vira_google_sheets_client_error(
    mock_build, mock_from_file
) -> None:
    """Uma falha simulada da API (HttpError) deve ser capturada e convertida
    em `GoogleSheetsClientError`, sem propagar a exceção original."""
    mock_service = MagicMock()
    mock_response = MagicMock()
    mock_response.status = 404
    mock_response.reason = "Not Found"
    http_error = HttpError(resp=mock_response, content=b'{"error": "not found"}')
    mock_service.spreadsheets.return_value.values.return_value.get.return_value.execute.side_effect = (
        http_error
    )
    mock_build.return_value = mock_service

    client = GoogleSheetsClient(settings=_FakeSettings())

    with pytest.raises(GoogleSheetsClientError):
        client.read_patrimony_rows()


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_falha_de_autenticacao_e_capturada_e_vira_google_sheets_client_error(
    mock_build, mock_from_file
) -> None:
    """Uma falha ao construir as credenciais (ex.: arquivo inválido/ausente)
    também deve virar `GoogleSheetsClientError`, nunca propagar a exceção
    original (ex.: `FileNotFoundError`)."""
    mock_from_file.side_effect = FileNotFoundError("arquivo de credenciais não encontrado")

    client = GoogleSheetsClient(settings=_FakeSettings())

    with pytest.raises(GoogleSheetsClientError):
        client.read_patrimony_rows()

    mock_build.assert_not_called()


def test_sem_credenciais_configuradas_levanta_erro_de_dominio_sem_chamar_rede() -> None:
    """Sem `google_sheets_credentials_json` configurado, nenhuma chamada de
    rede deve ocorrer; o erro deve ser de domínio, não `AttributeError`."""
    settings = _FakeSettings(google_sheets_credentials_json=None)
    client = GoogleSheetsClient(settings=settings)

    with patch("googleapiclient.discovery.build") as mock_build:
        with pytest.raises(GoogleSheetsClientError):
            client.read_patrimony_rows()

    mock_build.assert_not_called()


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_celula_ausente_e_celula_em_branco_sao_tratadas_como_none(
    mock_build, mock_from_file
) -> None:
    """Uma célula omitida pela API (linha mais curta que o cabeçalho) e uma
    célula presente mas em branco devem ser tratadas de forma idêntica
    (ambas None), nunca como string vazia."""
    headers = ["ID", "PATRIMONIO", "UNIDADE", "OBSERVACAO"]
    # Linha mais curta que o cabeçalho: OBSERVACAO é omitida pela API.
    data_row = ["1", "123", "   "]
    mock_build.return_value = _make_mock_service([headers, data_row])

    client = GoogleSheetsClient(settings=_FakeSettings())
    result = client.read_patrimony_rows()

    row = result.rows[0]
    assert row["raw_values"]["UNIDADE"] is None
    assert row["raw_values"]["OBSERVACAO"] is None
    assert row["normalized_values"]["UNIDADE"] is None
    assert row["normalized_values"]["OBSERVACAO"] is None


def _make_settings_for_env_test() -> Settings:
    """Confirma que um `Settings` real (pydantic) do projeto, sem os campos
    `google_sheets_*` declarados, gera `GoogleSheetsClientError` (não
    `AttributeError`) em vez de quebrar — o cliente é tolerante via `getattr`.
    """
    return Settings(
        database_url="postgresql+psycopg2://user:pass@localhost:5432/test",
        secret_key="test-secret-key",
    )  # type: ignore[call-arg]


def test_settings_real_do_projeto_sem_campos_google_sheets_nao_quebra_com_attributeerror() -> None:
    settings = _make_settings_for_env_test()
    client = GoogleSheetsClient(settings=settings)

    with patch("googleapiclient.discovery.build") as mock_build:
        with pytest.raises(GoogleSheetsClientError):
            client.read_patrimony_rows()

    mock_build.assert_not_called()
