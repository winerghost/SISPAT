"""Revisão AppSec (Fase 3, 2026-10-22): classificação de bens de TI.

Trava que `asset_category`, `tech_type` e `operational_status` NÃO são aceitos do
cliente na CRIAÇÃO (400) e, na EDIÇÃO (PATCH), só dentro da allowlist (valor
fora dela -> 400, sem gravação; contrato de 2026-10-23, ver
test_asset_classification_edit.py). Campos realmente privilegiados continuam
rejeitados. Só SQLite local; nada toca Supabase.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from test_assets_api import ADM, USER_A, h
from test_assets_api import ast  # noqa: F401  (fixture)

from app.models.assets import Asset

CLASSIFICATION_FIELDS = [
    ("asset_category", "TECNOLOGIA"),
    ("tech_type", "NOTEBOOK"),
    ("operational_status", "EM_USO"),
    ("asset_category", "'; DROP TABLE assets;--"),
]


@pytest.mark.parametrize("field,value", CLASSIFICATION_FIELDS)
def test_classificacao_nao_vem_do_cliente_na_criacao(ast, field, value):  # noqa: F811
    for sub in (USER_A, ADM):
        r = ast.client.post(
            "/api/v1/assets",
            headers=h(sub),
            json={"unit_id": str(ast.a), "patrimony_number": "CL-1", field: value},
        )
        assert r.status_code == 400, r.get_data(as_text=True)
        assert r.get_json()["error"]["code"] == "validation_error"
    with ast.w.session() as db:
        assert db.execute(select(Asset)).first() is None


FORGED_VALUES = [
    ("asset_category", "'; DROP TABLE assets;--"),
    ("asset_category", "tecnologia"),
    ("asset_category", 1),
    ("tech_type", "SERVIDOR_X"),
    ("operational_status", "EM_USO; --"),
    ("operational_status", ["EM_USO"]),
]


@pytest.mark.parametrize(
    "field,value", [("role", "ADM"), ("unit_id", str(uuid.uuid4())), ("deleted_at", "2026-01-01"), ("deleted_by", "x")]
)
def test_edicao_continua_rejeitando_campos_realmente_privilegiados(ast, field, value):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CL-8")
    r = ast.client.patch(
        f"/api/v1/assets/{asset_id}", headers=h(ADM),
        json={"version": 1, "asset_category": "OUTROS", field: value},
    )
    assert r.status_code == 400
    row = ast.w.row(asset_id)
    assert row.version == 1 and row.asset_category is None and row.deleted_at is None


@pytest.mark.parametrize("field,value", FORGED_VALUES)
def test_edicao_rejeita_valores_fora_da_allowlist(ast, field, value):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CL-9")
    for sub in (USER_A, ADM):
        r = ast.client.patch(
            f"/api/v1/assets/{asset_id}", headers=h(sub), json={"version": 1, field: value}
        )
        assert r.status_code == 400, r.get_data(as_text=True)
        assert r.get_json()["error"]["code"] == "validation_error"
    row = ast.w.row(asset_id)
    assert row.version == 1
    assert row.asset_category is None and row.tech_type is None and row.operational_status is None


def test_filtros_de_classificacao_nao_valem_na_listagem_de_bens(ast):  # noqa: F811
    r = ast.client.get("/api/v1/assets?asset_category=TECNOLOGIA", headers=h(USER_A))
    assert r.status_code == 400
    assert r.get_json()["error"]["code"] == "validation_error"
    assert str(uuid.uuid4()) not in r.get_data(as_text=True)
