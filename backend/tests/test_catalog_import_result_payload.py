"""Regressão: payload da confirmação de cadastros reflete o resultado REAL.

Cobre status do SyncJob (CONCLUIDO/PARCIAL/FALHOU), `inalterados`, itens não
gravados por classificação/motivo e total de falhas, sem PII.
"""
from __future__ import annotations

import json
import uuid

from sqlalchemy import select

from app.models.sync import RawImportRecord, SyncJob
from app.models.units import Room, Unit
from test_catalog_import_service import _rooms_result
from test_catalog_imports_api import (  # noqa: F401  (fixtures)
    _confirm,
    _create,
    _get,
    env,
    fake_redis,
)


def _ids(env, preview_id: str) -> list[str]:
    return [i["id"] for i in _get(env, f"{preview_id}/items?page_size=100").get_json()["items"]]


def _uea(env) -> uuid.UUID:
    return next(u.id for u in env.db.execute(select(Unit)).scalars() if u.code == "023404")


def test_sucesso_total_status_concluido(env):
    preview_id = _create(env, "rooms", _rooms_result([["1", "Sala A", "UEA"], ["2", "Sala B", "UEA"]]))
    body = _confirm(env, preview_id, {"item_ids": _ids(env, preview_id)}).get_json()
    assert body["status"] == "CONCLUIDO"
    assert body["created"] == 2 and body["falhas_total"] == 0 and body["inalterados"] == 0
    assert body["nao_gravados"]["total"] == 0


def test_todos_falham_status_falhou_e_rejeitados(env):
    preview_id = _create(env, "rooms", _rooms_result([["1", "Sala A", "UEA"], ["2", "Sala B", "UEA"]]))
    uea = _uea(env)
    for name in ("Sala A", "Sala B"):  # condição de corrida após a prévia
        env.db.add(Room(id=uuid.uuid4(), unit_id=uea, name=name, active=True))
    env.db.commit()
    response = _confirm(env, preview_id, {"item_ids": _ids(env, preview_id)})
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "FALHOU"
    assert body["created"] == 0 and body["updated"] == 0
    assert body["falhas_total"] == 2 and len(body["falhas"]) == 2
    assert all("condição de corrida" in f["reason"] for f in body["falhas"])
    job = env.db.execute(select(SyncJob)).scalars().one()
    assert job.status == "FALHOU" and job.records_failed == 2
    statuses = {r.import_status for r in env.db.execute(select(RawImportRecord)).scalars()}
    assert statuses == {"REJEITADO"}


def test_falha_parcial_status_parcial(env):
    preview_id = _create(env, "rooms", _rooms_result([["1", "Sala A", "UEA"], ["2", "Sala B", "UEA"]]))
    env.db.add(Room(id=uuid.uuid4(), unit_id=_uea(env), name="Sala A", active=True))
    env.db.commit()
    body = _confirm(env, preview_id, {"item_ids": _ids(env, preview_id)}).get_json()
    assert body["status"] == "PARCIAL"
    assert body["created"] == 1 and body["falhas_total"] == 1
    statuses = sorted(r.import_status for r in env.db.execute(select(RawImportRecord)).scalars())
    assert statuses == ["IMPORTADO", "REJEITADO"]


def test_existente_sem_mudanca_conta_inalterado(env):
    env.db.add(Room(id=uuid.uuid4(), unit_id=_uea(env), name="Sala A", active=True, source_record_id="1"))
    env.db.commit()
    preview_id = _create(env, "rooms", _rooms_result([["1", "Sala A", "UEA"]]))
    body = _confirm(env, preview_id, {"item_ids": _ids(env, preview_id)}).get_json()
    assert body["status"] == "CONCLUIDO"
    assert body["created"] == 0 and body["updated"] == 0 and body["inalterados"] == 1
    assert body["falhas_total"] == 0


def test_nao_gravados_por_classificacao_e_motivo(env):
    rows = [
        ["1", "Sala A", "UEA"],
        ["2", "Sala A", "UEA"],  # DUPLICADO
        ["3", "Sala C", "ZZZ"],  # sigla sem alias -> INVALIDO
        ["4", "Sala D", "UEA"],  # NOVO, mas não selecionada
    ]
    preview_id = _create(env, "rooms", _rooms_result(rows))
    items = _get(env, f"{preview_id}/items?page_size=100").get_json()["items"]
    chosen = [i["id"] for i in items if i["label"] == "Sala A" and i["classification"] == "NOVO"]
    body = _confirm(env, preview_id, {"item_ids": chosen}).get_json()
    unwritten = body["nao_gravados"]
    assert unwritten["por_classificacao"]["DUPLICADO"] == 1
    assert unwritten["por_classificacao"]["INVALIDO"] == 1
    assert unwritten["por_motivo"]["unidade_sem_alias"] == 1
    assert unwritten["por_motivo"]["duplicado_na_origem"] == 1
    assert unwritten["total"] == 2 and unwritten["nao_selecionados"] == 1
    assert body["created"] == 1 and body["status"] == "CONCLUIDO"
    assert "ZZZ" not in json.dumps(unwritten)


def test_resposta_sem_campos_extras_nem_pii(env):
    preview_id = _create(env, "rooms", _rooms_result([["1", "Sala A", "UEA"]]))
    body = _confirm(env, preview_id, {"item_ids": _ids(env, preview_id)}).get_json()
    assert set(body) == {
        "preview_id", "kind", "sync_job_id", "status", "created", "updated", "ignorados",
        "inalterados", "nao_gravados", "falhas_total", "falhas",
    }
