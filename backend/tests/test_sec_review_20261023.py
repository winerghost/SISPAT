"""Revisão AppSec final (2026-10-23): lacunas de regressão da edição manual de
classificação (PATCH /assets) e da resposta degradada da confirmação de bens.

Só SQLite local / unidades; nada toca Supabase.
"""
from __future__ import annotations

import json
import logging
import uuid

import pytest

from test_assets_api import ADM, RH_A, USER_A, h, types
from test_assets_api import ast  # noqa: F401  (fixture)

from app.api.v1.import_confirm_common import safe_confirm_payload
from app.api.v1.import_confirm_schemas import AssetImportConfirmResponse

PRIVILEGED = [
    ("role", "ADM"),
    ("unit_id", str(uuid.uuid4())),
    ("deleted_at", "2026-01-01T00:00:00Z"),
    ("deleted_by", str(uuid.uuid4())),
    ("auth_user_id", "x"),
    ("active", True),
]


@pytest.mark.parametrize("sub", [USER_A, ADM])
@pytest.mark.parametrize("field,value", PRIVILEGED)
def test_patch_com_campo_privilegiado_e_rejeitado_e_auditado(ast, sub, field, value):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "RV-1")
    r = ast.client.patch(
        f"/api/v1/assets/{asset_id}", headers=h(sub),
        json={"version": 1, "asset_category": "OUTROS", field: value},
    )
    assert r.status_code == 400
    row = ast.w.row(asset_id)
    assert row.version == 1 and row.asset_category is None and row.deleted_at is None
    assert ast.w.audits() == []
    emitted = len(types(ast, "PRIVILEGE_ESCALATION_ATTEMPT")) + len(types(ast, "MASS_ASSIGNMENT_REJECTED"))
    assert emitted == 1, ast.events


def test_rh_negado_na_edicao_emite_evento_sem_eco_do_corpo(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "RV-2")
    r = ast.client.patch(
        f"/api/v1/assets/{asset_id}", headers=h(RH_A),
        json={"version": 1, "asset_category": "OUTROS"},
    )
    assert r.status_code == 403
    assert "OUTROS" not in r.get_data(as_text=True)
    assert len(types(ast, "ACCESS_DENIED")) >= 1
    assert "OUTROS" not in json.dumps(ast.events, default=str)
    assert ast.w.row(asset_id).asset_category is None


def test_adm_sem_aal2_nao_edita_classificacao(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "RV-3")
    r = ast.client.patch(
        f"/api/v1/assets/{asset_id}", headers=h(ADM, aal="aal1"),
        json={"version": 1, "asset_category": "OUTROS"},
    )
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert ast.w.row(asset_id).asset_category is None and ast.w.audits() == []


def test_auditoria_da_classificacao_nao_leva_descricao_nem_notas(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "RV-4", description="DescricaoSigilosa", notes="NotaSigilosa")
    r = ast.client.patch(
        f"/api/v1/assets/{asset_id}", headers=h(USER_A),
        json={"version": 1, "asset_category": "TECNOLOGIA", "tech_type": "NOTEBOOK"},
    )
    assert r.status_code == 200
    blob = json.dumps([[a.previous_values, a.new_values] for a in ast.w.audits()])
    assert "Sigilosa" not in blob and "RV-4" not in blob


def test_confirmacao_degradada_nao_vaza_valores_no_log_e_valida_o_schema(caplog):
    secret = "Fulano de Tal fulano@agu.gov.br 123.456.789-09"
    result = {
        "sync_job_id": uuid.uuid4(), "status": "PARCIAL", "created": 2, "updated": 1,
        "ignorados": 0, "inalterados": 3, "falhas_total": 1,
        "falhas": [{"item_id": "i", "patrimony_number": "0001", "reason": secret}],
        "nao_gravados": {"total": 0},  # malformado de propósito (campos faltando)
    }

    def build():
        return {**result, "sync_job_id": str(result["sync_job_id"]), "reason_extra": secret}

    with caplog.at_level(logging.DEBUG):
        payload = safe_confirm_payload(
            AssetImportConfirmResponse, build, identity={}, result=result, context="imports"
        )
    assert payload["degraded"] is True and payload["falhas"] == []
    assert payload["created"] == 2 and payload["inalterados"] == 3 and payload["falhas_total"] == 1
    assert payload["status"] == "PARCIAL"
    assert AssetImportConfirmResponse.model_validate(payload)
    assert secret not in caplog.text and "fulano@agu" not in caplog.text and "123.456" not in caplog.text
    assert secret not in json.dumps(payload, default=str)


def test_confirmacao_degradada_satura_contadores_hostis():
    result = {"status": "XPTO", "created": -5, "updated": True, "ignorados": 10**12,
              "inalterados": "7", "falhas": "nao-lista", "sync_job_id": "a" * 500}
    payload = safe_confirm_payload(
        AssetImportConfirmResponse, lambda: 1 / 0, identity={}, result=result, context="imports"
    )
    assert payload["created"] == 0 and payload["updated"] == 0 and payload["inalterados"] == 0
    assert payload["ignorados"] == 1_000_000 and len(payload["sync_job_id"]) <= 64
    assert payload["status"] in ("CONCLUIDO", "PARCIAL", "FALHOU") and payload["degraded"] is True
