"""Contrato da confirmação da importação de BENS (mesmo da D2 dos cadastros).

Serviço (`ImportService.confirm_preview`, sessão mockada como em
`test_import_service.py`) e rota (`POST /imports/google-sheets/confirm`):
status do job CONCLUIDO/PARCIAL/FALHOU, `inalterados`, `nao_gravados` por
classificação/motivo (só contadores), `falhas_total` com lista <= 100, resposta
degradada pós-commit (B-3) e ausência de PII/descrição nas respostas.
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock

from app.services.import_service import (
    _VERSION_AT_PREVIEW_KEY,
    MAX_LISTED_FAILURES,
    ImportService,
)
from test_import_service import (
    _build_item,
    _build_preview,
    _make_asset,
    _make_settings,
    _make_unit,
    _wire_confirm_db,
)
from test_imports_api import (  # noqa: F401  (fixtures e helpers)
    CONFIRM_URL,
    _auth_headers,
    _make_token,
    _patch_authenticated,
    _patch_db_and_service,
    app,
    client,
    fake_redis,
)


def _confirm(preview, items, asset_results, selected, unit=None):
    db, _ = _wire_confirm_db(preview, items, asset_query_results=asset_results, unit=unit)
    service = ImportService(db, MagicMock(), settings=_make_settings())
    return service.confirm_preview(preview.id, uuid.uuid4(), [i.id for i in selected])


# --------------------------------------------------------------------------
# Serviço
# --------------------------------------------------------------------------


def test_ok_status_concluido_e_resumo_zerado() -> None:
    preview = _build_preview()
    novo = _build_item(preview.id, "NOVO", "100")
    result = _confirm(preview, [novo], [[]], [novo], unit=_make_unit())
    assert result["status"] == "CONCLUIDO"
    assert result["created"] == 1 and result["falhas_total"] == 0 and result["inalterados"] == 0
    assert result["nao_gravados"] == {
        "total": 0,
        "por_classificacao": {"DUPLICADO": 0, "INVALIDO": 0, "CONFLITANTE": 0},
        "por_motivo": {},
        "nao_selecionados": 0,
    }


def test_todos_falham_status_falhou() -> None:
    preview = _build_preview()
    a = _build_item(preview.id, "NOVO", "100")
    b = _build_item(preview.id, "NOVO", "101")
    # os dois patrimônios passaram a existir após a prévia (condição de corrida)
    result = _confirm(preview, [a, b], [[_make_asset("100")], [_make_asset("101")]], [a, b])
    assert result["status"] == "FALHOU"
    assert result["created"] == 0 and result["updated"] == 0
    assert result["falhas_total"] == 2 and len(result["falhas"]) == 2
    assert preview.status == "CONFIRMADA"  # prévia consumida mesmo na falha total


def test_parcial_status_parcial() -> None:
    preview = _build_preview()
    ok = _build_item(preview.id, "NOVO", "100")
    ruim = _build_item(preview.id, "NOVO", "101")
    result = _confirm(preview, [ok, ruim], [[], [_make_asset("101")]], [ok, ruim], unit=_make_unit())
    assert result["status"] == "PARCIAL"
    assert result["created"] == 1 and result["falhas_total"] == 1


def test_existente_sem_diferenca_conta_inalterado_e_nao_incrementa_version() -> None:
    preview = _build_preview()
    item = _build_item(
        preview.id, "EXISTENTE", "200", normalized_values={_VERSION_AT_PREVIEW_KEY: 5, "UNIDADE": "SEDE"}
    )
    asset = _make_asset("200", version=5)
    asset.description = item.description
    asset.source_system = "google_sheets"
    asset.source_record_id = item.source_record_id
    asset.asset_category = "MOBILIARIO"  # já classificado: a regra não age
    result = _confirm(preview, [item], [[asset]], [item])
    assert result["status"] == "CONCLUIDO"
    assert result["created"] == 0 and result["updated"] == 0 and result["inalterados"] == 1
    assert asset.version == 5  # idempotente: nada gravado


def test_existente_com_diferenca_conta_atualizado() -> None:
    preview = _build_preview()
    item = _build_item(
        preview.id, "EXISTENTE", "200", normalized_values={_VERSION_AT_PREVIEW_KEY: 5, "UNIDADE": "SEDE"}
    )
    asset = _make_asset("200", version=5)
    asset.description = "descrição antiga"
    result = _confirm(preview, [item], [[asset]], [item])
    assert result["updated"] == 1 and result["inalterados"] == 0
    assert asset.version == 6


def test_falha_de_revalidacao_nao_conta_como_inalterado() -> None:
    preview = _build_preview()
    item = _build_item(preview.id, "NOVO", "100")
    result = _confirm(preview, [item], [[_make_asset("100")]], [item])
    assert result["inalterados"] == 0 and result["falhas_total"] == 1


def test_nao_gravados_por_classificacao_e_motivo_sem_pii() -> None:
    preview = _build_preview()
    ok = _build_item(preview.id, "NOVO", "100")
    solto = _build_item(preview.id, "NOVO", "101")  # elegível, não selecionado
    dup = _build_item(preview.id, "DUPLICADO", "100")
    conf = _build_item(preview.id, "CONFLITANTE", "300")
    invalido = _build_item(preview.id, "INVALIDO", None)
    sem_alias = _build_item(
        preview.id,
        "INVALIDO",
        "102",
        normalized_values={"_links": {"blocking": "unidade_sem_alias", "pendencias": ["unidade_sem_alias"]}},
    )
    items = [ok, solto, dup, conf, invalido, sem_alias]
    result = _confirm(preview, items, [[]], [ok, dup], unit=_make_unit())
    unwritten = result["nao_gravados"]
    assert unwritten["por_classificacao"] == {"DUPLICADO": 1, "INVALIDO": 2, "CONFLITANTE": 1}
    assert unwritten["por_motivo"] == {
        "duplicado_na_origem": 1,
        "patrimonio_conflitante": 1,
        "dados_invalidos": 1,
        "unidade_sem_alias": 1,
    }
    assert unwritten["total"] == 4 and unwritten["nao_selecionados"] == 1
    assert result["ignorados"] == 1  # o DUPLICADO selecionado
    assert "Descrição teste" not in json.dumps(unwritten)


def test_pendencias_de_vinculo_so_dos_bens_criados() -> None:
    preview = _build_preview()
    item = _build_item(preview.id, "NOVO", "100")
    # sala e pessoa não resolvidas: a confirmação cria o bem sem o vínculo
    result = _confirm(preview, [item], [[]], [item], unit=_make_unit())
    assert result["created"] == 1
    assert set(result["pendencias_vinculo"]) >= {"sala_nao_encontrada", "pessoa_nao_encontrada"}
    assert all(isinstance(v, int) and v >= 0 for v in result["pendencias_vinculo"].values())


def test_falhas_limitadas_a_100_com_total_real() -> None:
    preview = _build_preview()
    total = MAX_LISTED_FAILURES + 20
    items = [_build_item(preview.id, "NOVO", str(1000 + n)) for n in range(total)]
    # todos já existem -> todos falham por condição de corrida
    results = [[_make_asset(str(1000 + n))] for n in range(total)]
    result = _confirm(preview, items, results, items)
    assert result["status"] == "FALHOU"
    assert result["falhas_total"] == total
    assert len(result["falhas"]) == MAX_LISTED_FAILURES


# --------------------------------------------------------------------------
# Rota
# --------------------------------------------------------------------------


def _post(client, service_result):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.confirm_preview.return_value = service_result
    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        with patches[0], patches[1], patches[2]:
            return client.post(
                CONFIRM_URL,
                json={"preview_id": str(uuid.uuid4()), "selected_item_ids": [str(uuid.uuid4())]},
                headers=_auth_headers(token),
            )


def _service_result(**over):
    base = {
        "sync_job_id": uuid.uuid4(),
        "status": "FALHOU",
        "created": 0,
        "updated": 0,
        "ignorados": 0,
        "inalterados": 0,
        "nao_gravados": {
            "total": 1,
            "por_classificacao": {"DUPLICADO": 1, "INVALIDO": 0, "CONFLITANTE": 0},
            "por_motivo": {"duplicado_na_origem": 1},
            "nao_selecionados": 0,
        },
        "pendencias_vinculo": {},
        "falhas_total": 2,
        "falhas": [
            {"item_id": str(uuid.uuid4()), "row": 3, "patrimony_number": "000123", "reason": "r1"},
            {"item_id": str(uuid.uuid4()), "row": 4, "patrimony_number": "000124", "reason": "r2"},
        ],
    }
    base.update(over)
    return base


def test_rota_falha_total_responde_200_com_status_falhou(client) -> None:
    response = _post(client, _service_result())
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "FALHOU" and body["degraded"] is False
    assert body["created"] == 0 and body["falhas_total"] == 2 and len(body["falhas"]) == 2
    assert body["falhas"][0]["patrimony_number"] == "000123"  # texto, preserva zeros
    assert set(body) == {
        "sync_job_id", "status", "created", "updated", "ignorados", "inalterados",
        "nao_gravados", "pendencias_vinculo", "falhas_total", "falhas", "degraded",
    }


def test_rota_degradada_apos_commit_nao_vira_500(client) -> None:
    """B-3: resposta inválida pós-commit -> 200 com contadores mínimos e flag."""
    bad = _service_result(
        status="PARCIAL",
        created=7,
        updated=2,
        inalterados=1,
        nao_gravados={"total": "muitos", "por_classificacao": {"X": "y"}},  # inválido
        falhas=[{"item_id": "x", "row": -5, "patrimony_number": "1", "reason": "r"}],  # row < 0
        falhas_total=1,
    )
    response = _post(client, bad)
    assert response.status_code == 200
    body = response.get_json()
    assert body["degraded"] is True
    assert body["status"] == "PARCIAL"
    assert (body["created"], body["updated"], body["inalterados"]) == (7, 2, 1)
    assert body["falhas_total"] == 1 and body["falhas"] == []
    assert body["nao_gravados"]["total"] == 0


def test_rota_degradada_com_status_invalido_deriva_do_contador(client) -> None:
    response = _post(client, _service_result(status="???", created=0, falhas_total=3, falhas=[{"row": "x"}]))
    body = response.get_json()
    assert response.status_code == 200 and body["degraded"] is True
    assert body["status"] == "FALHOU" and body["falhas_total"] == 3


def test_rota_degradada_com_chave_ausente(client) -> None:
    bad = _service_result()
    del bad["inalterados"]  # KeyError ao montar o corpo
    response = _post(client, bad)
    assert response.status_code == 200 and response.get_json()["degraded"] is True
