"""Revisão AppSec (Fase 3, 2026-10-22): classificação de bens de TI.

Trava que `asset_category`, `tech_type` e `operational_status` NÃO são aceitos do
cliente em nenhum endpoint de escrita de bens (mass assignment -> 400, sem
gravação) e que o contrato da API de leitura de bens não mudou de forma que
permita escrita. Só SQLite local; nada toca Supabase.
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


@pytest.mark.parametrize("field,value", CLASSIFICATION_FIELDS)
def test_classificacao_nao_vem_do_cliente_na_edicao(ast, field, value):  # noqa: F811
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
