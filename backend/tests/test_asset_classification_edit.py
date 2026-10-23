"""Edição manual da classificação de bens (PATCH /assets) e `--list-unclassified`.

SQLite local; nada toca Supabase. Reaproveita o mundo de `test_assets_api`.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import get_args
from unittest.mock import patch

import pytest

from test_assets_api import ADM, ADM_B, RH_A, USER_A, USER_B, h
from test_assets_api import ast  # noqa: F401  (fixture)

from app.api.v1.asset_schemas import AssetCategory, OperationalStatus, TechType
from app.models.assets import Asset
from app.services import asset_classification as vocab


def _patch(ast, asset_id, sub, **fields):  # noqa: F811
    version = fields.pop("version", 1)
    return ast.client.patch(
        f"/api/v1/assets/{asset_id}", headers=h(sub), json={"version": version, **fields}
    )


def test_allowlists_da_api_espelham_o_vocabulario():
    assert get_args(AssetCategory) == vocab.CATEGORIES
    assert get_args(TechType) == vocab.TECH_TYPES
    assert get_args(OperationalStatus) == vocab.OPERATIONAL_STATUSES


@pytest.mark.parametrize("sub", [USER_A, ADM])
def test_perfis_que_editam_alteram_classificacao_com_version_e_auditoria(ast, sub):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CE-1", description="Notebook Fulano", notes="nota interna")
    r = _patch(ast, asset_id, sub, asset_category="TECNOLOGIA", tech_type="NOTEBOOK",
               operational_status="EM_USO")
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert (body["asset_category"], body["tech_type"], body["operational_status"]) == (
        "TECNOLOGIA", "NOTEBOOK", "EM_USO")
    assert body["version"] == 2
    row = ast.w.row(asset_id)
    assert (row.asset_category, row.tech_type, row.operational_status) == ("TECNOLOGIA", "NOTEBOOK", "EM_USO")
    [audit] = ast.w.audits()
    assert audit.operation == "ASSET_CLASSIFICATION_UPDATED"
    assert audit.new_values["changed_fields"] == ["asset_category", "operational_status", "tech_type"]
    blob = json.dumps([audit.previous_values, audit.new_values])
    assert "nota interna" not in blob and "Fulano" not in blob
    assert audit.previous_values == {"asset_category": None, "tech_type": None, "operational_status": None}


def test_null_limpa_e_mistura_com_outros_campos_usa_asset_updated(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CE-2", asset_category="TECNOLOGIA", tech_type="MONITOR",
                           operational_status="ESTOQUE")
    r = _patch(ast, asset_id, USER_A, tech_type=None, operational_status=None, asset_category=None)
    assert r.status_code == 200
    row = ast.w.row(asset_id)
    assert row.asset_category is None and row.tech_type is None and row.operational_status is None
    r = _patch(ast, asset_id, USER_A, version=2, description="x", operational_status="BAIXADO")
    assert r.status_code == 200
    assert sorted(a.operation for a in ast.w.audits()) == ["ASSET_CLASSIFICATION_UPDATED", "ASSET_UPDATED"]


def test_tipo_de_ti_exige_categoria_tecnologia(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CE-3")
    for fields in (
        {"tech_type": "NOTEBOOK"},  # sem categoria
        {"asset_category": "MOBILIARIO", "tech_type": "NOTEBOOK"},
    ):
        r = _patch(ast, asset_id, USER_A, **fields)
        assert r.status_code == 422, r.get_json()
        assert r.get_json()["error"]["code"] == "classification_inconsistent"
        assert "NOTEBOOK" not in r.get_data(as_text=True)
    assert ast.w.row(asset_id).version == 1 and ast.w.audits() == []
    assert _patch(ast, asset_id, USER_A, asset_category="TECNOLOGIA", tech_type="MONITOR").status_code == 200
    assert _patch(ast, asset_id, USER_A, version=2, asset_category="OUTROS").status_code == 422
    assert _patch(ast, asset_id, USER_A, version=2, asset_category="OUTROS", tech_type=None).status_code == 200
    row = ast.w.row(asset_id)
    assert row.asset_category == "OUTROS" and row.tech_type is None


def test_conflito_de_versao_e_409(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CE-4")
    assert _patch(ast, asset_id, USER_A, operational_status="EM_USO").status_code == 200
    r = _patch(ast, asset_id, USER_A, operational_status="BAIXADO")  # version 1 obsoleto
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "version_conflict"
    assert ast.w.row(asset_id).operational_status == "EM_USO"


def test_rh_nao_edita_classificacao(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CE-5")
    assert _patch(ast, asset_id, RH_A, asset_category="OUTROS").status_code == 403
    assert ast.w.row(asset_id).asset_category is None and ast.w.audits() == []


@pytest.mark.parametrize("sub", [USER_B, ADM_B])
def test_bem_alheio_tem_a_mesma_resposta_de_inexistente(ast, sub):  # noqa: F811
    own = ast.w.asset(ast.a, "CE-6")
    other = _patch(ast, own, sub, asset_category="OUTROS")
    missing = _patch(ast, "00000000-0000-4000-8000-000000000000", sub, asset_category="OUTROS")
    assert other.status_code == missing.status_code == 404
    assert other.get_json() == missing.get_json()
    assert ast.w.row(own).asset_category is None


def test_leitura_expoe_a_classificacao(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "CE-7", asset_category="VEICULO", operational_status="EM_USO")
    for sub in (USER_A, RH_A):
        body = ast.client.get(f"/api/v1/assets/{asset_id}", headers=h(sub)).get_json()
        assert body["asset_category"] == "VEICULO" and body["tech_type"] is None
        assert body["operational_status"] == "EM_USO"


# --- flask classify-assets --list-unclassified ------------------------------


def test_cli_list_unclassified_e_somente_leitura(ast):  # noqa: F811
    from app.cli import classify_assets_command

    ok = ast.w.asset(ast.a, "L-1", description="Notebook Dell")
    odd = ast.w.asset(ast.a, "L-2", description="Coisa estranha\x07 " + "x" * 300, notes="segredo")
    done = ast.w.asset(ast.a, "L-3", description="Item raro", asset_category="OUTROS")
    gone = ast.w.asset(ast.a, "L-4", description="Item raro excluido")
    with ast.w.session() as db:
        db.get(Asset, gone).deleted_at = datetime.now(timezone.utc)
    runner = ast.client.application.test_cli_runner()
    with patch("app.cli.get_db_session", ast.w.session):
        result = runner.invoke(classify_assets_command, ["--list-unclassified"])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert any(line.startswith(str(odd) + "\t") for line in lines)
    assert str(ok) not in result.output and str(done) not in result.output and str(gone) not in result.output
    assert "segredo" not in result.output and "L-2" not in result.output and "\x07" not in result.output
    assert max(len(line) for line in lines) < 36 + 1 + 90
    assert "Sem regra: 1" in result.output
    assert ast.w.row(ok).asset_category is None and ast.w.row(odd).asset_category is None
    assert ast.w.row(ok).version == 1 and ast.w.audits() == []
    with patch("app.cli.get_db_session", ast.w.session):
        both = runner.invoke(classify_assets_command, ["--list-unclassified", "--apply"])
    assert both.exit_code != 0 and ast.w.row(ok).asset_category is None
