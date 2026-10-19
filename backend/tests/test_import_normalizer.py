"""Testes do normalizador puro da planilha MConferencia.

Usa as linhas de AMOSTRA fornecidas pelo usuário em 2026-10-16 (ver
`docs/architecture/plano-importacao-mconferencia.md`) e casos de borda.
Sem DB, sem rede.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.integrations.google_sheets_client import GoogleSheetsClient
from app.services.import_normalizer import (
    normalize_row,
    parse_coordinates,
    parse_date,
    parse_datetime_utc,
    parse_description,
    parse_email,
    parse_located,
    parse_owner_unit,
    person_match_key,
)

HEADERS = [
    "ID", "UNIDADE", "DESCRICAO", "PATRIMONIO", "RESPONSAVEL", "LOCALIZADO",
    "SALA", "USUARIO", "UNIDADE_PERTENCENTE", "RESPONSAVEL", "OBSERVACAO",
    "DATA_REGISTRO", "LOCALIZACAO", "DATA_ALTERACAO", "PESQUISADOR", "QT",
]
UNIT = "023404 - UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"
DESC_A = (
    "(00138020-6) NOTEBOOK . VAIO FE14 VJFE49F11X- BO111H PROC AMD RYZEM 5 "
    "5500UWINDOWS 11 PRO MEMORIA 16 GB SSD 256GB PLACA REDE |"
)
DESC_HUB = (
    "(00025927-6) HUB DOCKING STATION MULTIFUNCIONAL: INUPT: 20V_5A, "
    "PD(100W)OUTPUT: 5V_1A: 12 EM 1 SENDO 1SD 3.0, 1MICRO SD 3. |"
)
COORD0 = "0.000000, 0.000000"

SAMPLE = {
    "A": ["cc7c22e2", "UEA", DESC_A, "13300830", "Terceirizado", "S", "3",
          "hepta.maycon.o@agu.gov.br", UNIT, "Phillipe Farias Ferreira", "", "",
          COORD0, "15/10/2026 22:18:21", "Developer", "25"],
    "B": ["2a489a5a", "UEA", DESC_HUB, "13318651", "Ocioso", "S", "3",
          "Ocioso@ocioso", UNIT, "Phillipe Farias Ferreira", "", "",
          COORD0, "15/10/2026 22:38:20", "Developer", "30"],
    "C": ["f0f92e93", "UEA", DESC_HUB, "13318653", "Servidor", "S", "11",
          "phillipe.ferreira@agu.gov.br", UNIT, "PHILLIPE FARIAS FERREIRA", "", "",
          COORD0, "15/10/2026 22:36:39", "Developer", "32"],
    "D": ["301cf3fc", "UEA", DESC_HUB, "13318661", "Terceirizado", "S", "13",
          "bartolomeu.freitas@agu.gov.br", UNIT, "Phillipe Farias Ferreira", "", "",
          COORD0, "15/10/2026 22:37:29", "Developer", "38"],
}


def _kwargs(row: list[str]) -> dict[str, str]:
    d = dict(zip(HEADERS, row))
    return dict(
        descricao=row[2], localizado=d["LOCALIZADO"], sala=d["SALA"],
        usuario=d["USUARIO"], unidade_pertencente=d["UNIDADE_PERTENCENTE"],
        responsavel_vinculo=row[4], responsavel_pessoa=row[9],
        data_registro=d["DATA_REGISTRO"], localizacao=d["LOCALIZACAO"],
        data_alteracao=d["DATA_ALTERACAO"], pesquisador=d["PESQUISADOR"],
    )


def test_linha_a_completa() -> None:
    values, warnings = normalize_row(**_kwargs(SAMPLE["A"]))
    assert values["codigo_material"] == "00138020-6"
    assert values["descricao_limpa"].startswith("NOTEBOOK . VAIO")
    assert not values["descricao_limpa"].endswith("|")
    assert values["owner_unit_code"] == "023404"
    assert values["owner_unit_name"] == "UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"
    assert values["located_enum"] == "SIM"
    assert values["sala_codigo"] == "3"
    assert values["usuario_email"] == "hepta.maycon.o@agu.gov.br"
    assert values["vinculo_situacao"] == "Terceirizado"
    assert values["responsavel_pessoa"] == "Phillipe Farias Ferreira"
    assert values["responsavel_pessoa_key"] == "phillipe farias ferreira"
    assert values["latitude"] is None and values["longitude"] is None
    # 22:18:21 em UTC-3 -> 01:18:21 UTC do dia seguinte
    assert values["source_updated_at_utc"] == "2026-10-16T01:18:21+00:00"
    assert values["registration_date"] is None
    assert values["pesquisador"] == "Developer"
    assert warnings == []


def test_linha_b_placeholder_usuario_e_vinculo_ocioso() -> None:
    values, warnings = normalize_row(**_kwargs(SAMPLE["B"]))
    assert values["usuario_email"] is None
    assert values["vinculo_situacao"] == "Ocioso"
    assert values["codigo_material"] == "00025927-6"
    assert values["source_updated_at_utc"] == "2026-10-16T01:38:20+00:00"
    assert warnings == []  # placeholder conhecido é silencioso


def test_linhas_c_d_chave_de_pessoa_igual_apesar_da_caixa() -> None:
    a, _ = normalize_row(**_kwargs(SAMPLE["A"]))
    c, _ = normalize_row(**_kwargs(SAMPLE["C"]))
    d, _ = normalize_row(**_kwargs(SAMPLE["D"]))
    assert c["responsavel_pessoa"] == "PHILLIPE FARIAS FERREIRA"
    assert a["responsavel_pessoa_key"] == c["responsavel_pessoa_key"] == d["responsavel_pessoa_key"]
    assert c["vinculo_situacao"] == "Servidor"
    assert c["sala_codigo"] == "11" and d["sala_codigo"] == "13"
    assert d["usuario_email"] == "bartolomeu.freitas@agu.gov.br"


def test_normalize_row_e_json_safe() -> None:
    import json

    values, _ = normalize_row(**_kwargs(SAMPLE["A"]))
    json.dumps(values)


def test_vazios() -> None:
    values, warnings = normalize_row()
    assert values["located_enum"] == "DESCONHECIDO"
    for key, val in values.items():
        if key != "located_enum":
            assert val is None, key
    assert warnings == []
    assert normalize_row(descricao="   ", sala="  ")[0]["sala_codigo"] is None


@pytest.mark.parametrize(
    "raw,expected",
    [("S", "SIM"), ("s", "SIM"), (" n ", "NAO"), ("N", "NAO")],
)
def test_located_caixa_mista(raw: str, expected: str) -> None:
    w: list[str] = []
    assert parse_located(raw, w) == expected and w == []


def test_located_outro_valor_vira_desconhecido_com_aviso() -> None:
    w: list[str] = []
    assert parse_located("talvez", w) == "DESCONHECIDO"
    assert w and w[0].startswith("aviso:")


def test_codigo_material_e_pipe_final() -> None:
    m = parse_description("(00000001-2) ITEM X |")
    assert (m.codigo_material, m.descricao_limpa) == ("00000001-2", "ITEM X")
    m = parse_description("ITEM SEM CODIGO|")
    assert (m.codigo_material, m.descricao_limpa) == (None, "ITEM SEM CODIGO")
    # parênteses/pipe no meio não são tocados
    m = parse_description("(1234-5) NAO CODIGO | MEIO")
    assert m.codigo_material is None and m.descricao_limpa == "(1234-5) NAO CODIGO | MEIO"


def test_unidade_pertencente_invalida() -> None:
    w: list[str] = []
    assert parse_owner_unit("UEA", w) == (None, None)
    assert parse_owner_unit("23404 - X", w) == (None, None)
    assert len(w) == 2 and all(x.startswith("aviso:") for x in w)


@pytest.mark.parametrize(
    "raw", ["Ocioso@ocioso", "semarroba", "a@b", "a@b..com", "x y@agu.gov.br"]
)
def test_email_invalido_ou_placeholder(raw: str) -> None:
    assert parse_email(raw, []) is None


def test_email_caixa_mista() -> None:
    assert parse_email("  Fulano.Silva@AGU.gov.br ", []) == "fulano.silva@agu.gov.br"


def test_email_invalido_nao_placeholder_gera_aviso() -> None:
    w: list[str] = []
    assert parse_email("lixo", w) is None
    assert w and w[0].startswith("aviso:")


def test_coordenadas() -> None:
    w: list[str] = []
    assert parse_coordinates("-10.184500, -48.333600", w) == (-10.1845, -48.3336)
    assert parse_coordinates("0,0", w) == (None, None)
    assert parse_coordinates("0.000000, 0.000000", w) == (None, None)
    assert w == []
    assert parse_coordinates("abc", w) == (None, None)
    assert parse_coordinates("91.0, 10.0", w) == (None, None)
    assert len(w) == 2


def test_datas_invalidas() -> None:
    w: list[str] = []
    assert parse_date("31/02/2026", w) is None
    assert parse_date("2026-10-15", w) is None
    assert parse_datetime_utc("15/10/2026", w) is None
    assert parse_datetime_utc("32/10/2026 10:00:00", w) is None
    assert len(w) == 4 and all(x.startswith("aviso:") for x in w)
    assert parse_date("05/03/2025", []).isoformat() == "2025-03-05"
    assert parse_datetime_utc("15/10/2026 22:18:21", []) == datetime(
        2026, 10, 16, 1, 18, 21, tzinfo=timezone.utc
    )


def test_person_match_key() -> None:
    assert person_match_key("  JOSÉ   da  Silva ") == person_match_key("jose da silva")
    assert person_match_key("") is None and person_match_key(None) is None


def test_nunca_emite_erro_bloqueante() -> None:
    _, warnings = normalize_row(
        descricao="x", localizado="?", usuario="!", unidade_pertencente="?",
        localizacao="?", data_alteracao="?", data_registro="?",
    )
    assert warnings and all(w.startswith("aviso:") for w in warnings)


# ---- Integração com o cliente (sem rede) ----------------------------------

class _Settings:
    google_sheets_credentials_json = "/x.json"
    google_sheets_spreadsheet_id = "SINTETICO"
    google_sheets_sheet_name = "Aba"
    google_sheets_sheet_gid = None


@patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file")
@patch("googleapiclient.discovery.build")
def test_cliente_integra_amostra_preservando_raw_e_chaves_antigas(mock_build, _creds) -> None:
    svc = MagicMock()
    svc.spreadsheets.return_value.values.return_value.get.return_value.execute.return_value = {
        "values": [HEADERS] + [SAMPLE[k] for k in "ABCD"]
    }
    mock_build.return_value = svc
    rows = GoogleSheetsClient(settings=_Settings()).read_patrimony_rows().rows
    assert len(rows) == 4
    a = rows[0]
    nv, raw = a["normalized_values"], a["raw_values"]
    # Contrato anterior preservado
    assert nv["PATRIMONIO"] == "13300830" and nv["ID"] == "cc7c22e2"
    assert nv["UNIDADE"] == "UEA" and nv["qt_raw"] == "25"
    assert nv["responsavel_original"] == "Terceirizado"
    assert nv["responsavel_unidade"] == "Phillipe Farias Ferreira"
    # Novas chaves
    assert nv["vinculo_situacao"] == "Terceirizado"
    assert nv["responsavel_pessoa"] == "Phillipe Farias Ferreira"
    assert nv["codigo_material"] == "00138020-6"
    assert nv["owner_unit_code"] == "023404"
    assert nv["located_enum"] == "SIM"
    # raw intacto
    assert raw["DESCRICAO"] == DESC_A
    assert raw["USUARIO"] == "hepta.maycon.o@agu.gov.br"
    assert raw["RESPONSAVEL_1"] == "Terceirizado"
    assert raw["LOCALIZACAO"] == COORD0
    assert raw["QT"] == "25"
    assert not any(e.startswith("erro:") for e in a["validation_errors"])
    assert rows[1]["normalized_values"]["usuario_email"] is None
    assert rows[2]["normalized_values"]["responsavel_pessoa_key"] == "phillipe farias ferreira"
