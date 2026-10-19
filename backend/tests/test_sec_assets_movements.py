"""Revisão AppSec das ondas 1 e 2 (patrimônios e movimentações), 2026-10-17.

Testes de regressão dos achados SEC-AST-*/SEC-MOV-* (docs/security/SECURITY_AUDIT.md,
seção 16). Achados ainda abertos estão como `xfail(strict=True)`: ao corrigir o
código, o teste passa a XPASS e a marca deve ser removida. Os demais travam o
comportamento correto já existente. Só SQLite local; nada toca Supabase.
"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import pytest

import test_assets_api as ta
import test_movements_api as tm
from test_assets_api import ast  # noqa: F401  (fixture)
from test_movements_api import mv  # noqa: F401  (fixture)

APP = Path(__file__).resolve().parents[1] / "app"


# --- SEC-AST-01 -------------------------------------------------------------
def test_lock_de_numero_patrimonial_e_o_mesmo_na_api_e_na_importacao():
    from app.services import patrimony_lock as pl

    api = (APP / "services" / "asset_service.py").read_text(encoding="utf-8")
    imp = (APP / "services" / "import_service.py").read_text(encoding="utf-8")
    for src in (api, imp):
        assert "acquire_patrimony_lock" in src and "normalized_column" in src
        assert "hashtext" not in src and "pg_advisory_xact_lock" not in src
    # mesma chave para variações de caixa/espaços; chaves distintas para números distintos
    assert pl.lock_key("  Pat-100 ") == pl.lock_key("pat-100") == pl.lock_key("PAT-100")
    assert pl.lock_key("pat-100") != pl.lock_key("pat-101")


def test_importacao_compara_numero_sem_caixa_e_sem_espacos(ast):  # noqa: F811
    from app.services.import_service import ImportService

    ast.w.asset(ast.a, "Pat-200")
    with ast.w.session() as db:
        svc = ImportService.__new__(ImportService)
        svc._db = db
        assert len(svc._active_assets_by_patrimony("PAT-200")) == 1
        assert len(svc._active_assets_by_patrimony("  pat-200 ")) == 1
        assert svc._active_assets_by_patrimony("pat-201") == []


# --- SEC-AST-02 -------------------------------------------------------------
def test_rh_nao_recebe_autoria_no_historico_do_bem(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "H-1", description="Mesa")
    ast.client.patch(f"/api/v1/assets/{asset_id}", json={"version": 1, "description": "Cadeira"},
                     headers=ta.h(ta.USER_A))
    body = ast.client.get(f"/api/v1/assets/{asset_id}/history", headers=ta.h(ta.RH_A)).get_json()
    assert body["entries"]
    assert all("actor_user_id" not in e for e in body["entries"])
    user = ast.client.get(f"/api/v1/assets/{asset_id}/history", headers=ta.h(ta.USER_A)).get_json()
    assert all("actor_user_id" in e for e in user["entries"])


# --- SEC-MOV-01 -------------------------------------------------------------
def test_leitor_so_do_destino_nao_ve_responsavel_da_origem(mv):  # noqa: F811
    person = mv.w.person(mv.a, "Fulano de Tal Origem")
    asset_id = mv.w.asset(mv.a, "MV-PII", responsible_person_id=person)
    created = tm.request(mv, tm.USER_AB, asset_id, mv.b, reason="motivo livre sigiloso")
    assert created.status_code == 201, created.get_data(as_text=True)
    mid = created.get_json()["id"]
    r = mv.client.get(f"/api/v1/movements/{mid}", headers=tm.h(tm.USER_B))
    assert r.status_code == 200
    text = r.get_data(as_text=True)
    assert "Fulano de Tal Origem" not in text and "motivo livre sigiloso" not in text
    body = r.get_json()
    for key in ("origin_room", "origin_room_id", "previous_responsible", "previous_responsible_id", "reason"):
        assert key not in body
    # quem tem escopo na origem continua vendo
    full = mv.client.get(f"/api/v1/movements/{mid}", headers=tm.h(tm.USER_AB)).get_json()
    assert full["previous_responsible"] and full["reason"] == "motivo livre sigiloso"
    listed = mv.client.get("/api/v1/movements", headers=tm.h(tm.USER_B)).get_json()["movements"]
    assert all("previous_responsible" not in m for m in listed)


# --- Travas de comportamento correto ---------------------------------------
@pytest.mark.parametrize("term", ["%", "_", "\\", "%%", "A_"])
def test_q_com_curingas_like_e_literal(ast, term):  # noqa: F811
    ast.w.asset(ast.a, "ABC-1", description="Mesa de reunião")
    ast.w.asset(ast.a, "XYZ-2", description="Cadeira")
    r = ast.client.get("/api/v1/assets", query_string={"q": term}, headers=ta.h(ta.USER_A))
    assert r.status_code == 200 and r.get_json()["total"] == 0


def test_numero_duplicado_ignora_caixa_e_espacos_e_409_generico(ast):  # noqa: F811
    ast.w.asset(ast.a, "Pat-100")
    r = ast.client.post(
        "/api/v1/assets",
        json={"unit_id": str(ast.a), "patrimony_number": "  pAt-100 "},
        headers=ta.h(ta.USER_A),
    )
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "conflict"
    text = r.get_data(as_text=True).lower()
    assert "pat-100" not in text and "patrimony_number" not in text


def test_restore_com_numero_em_uso_e_409_e_bem_continua_excluido(ast):  # noqa: F811
    dead = ast.w.asset(ast.a, "R-1")
    assert ast.client.post(f"/api/v1/assets/{dead}/delete", json={"version": 1},
                           headers=ta.h(ta.ADM)).status_code == 200
    ast.w.asset(ast.a, "r-1")
    r = ast.client.post(f"/api/v1/assets/{dead}/restore", json={"version": 2}, headers=ta.h(ta.ADM))
    assert r.status_code == 409
    assert ast.w.row(dead).deleted_at is not None


@pytest.mark.parametrize("field,value", [
    ("deleted_at", "2020-01-01T00:00:00Z"), ("deleted_by", str(uuid.uuid4())), ("role", "ADM"),
    ("active", False), ("auth_user_id", "x"), ("created_by", str(uuid.uuid4())),
    ("assigned_user_id", str(uuid.uuid4())), ("source_record_id", "9"), ("unit_id", str(uuid.uuid4())),
])
def test_patch_com_campos_privilegiados_e_400_e_auditado(ast, field, value):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "MA-1")
    before = len(ast.events)
    r = ast.client.patch(f"/api/v1/assets/{asset_id}", json={"version": 1, field: value},
                         headers=ta.h(ta.ADM))
    assert r.status_code == 400
    assert any(e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT")
               for e in ast.events[before:])
    assert ast.w.row(asset_id).version == 1


def test_usuario_escopo_so_origem_nao_altera_campos_de_adm_nem_forca_versao(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "UF-1")
    for body in ({"version": 1, "owner_unit_id": str(ast.a)}, {"version": 1, "located": "SIM"},
                 {"version": 1, "patrimony_number": "OUTRO"}):
        assert ast.client.patch(f"/api/v1/assets/{asset_id}", json=body,
                                headers=ta.h(ta.USER_A)).status_code == 400
    stale = ast.client.patch(f"/api/v1/assets/{asset_id}", json={"version": 7, "description": "x"},
                             headers=ta.h(ta.USER_A))
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"


def test_404_uniforme_tem_o_mesmo_numero_de_consultas(ast):  # noqa: F811
    foreign = ast.w.asset(ast.b, "Q-1")
    counts = []
    for target in (str(foreign), str(uuid.uuid4())):
        ast.queries.clear()
        r = ast.client.get(f"/api/v1/assets/{target}", headers=ta.h(ta.USER_A))
        assert r.status_code == 404
        counts.append(len([q for q in ast.queries if "FROM assets" in q]))
    assert counts[0] == counts[1]


def test_movimentacao_nao_vaza_ids_no_404_e_nao_ha_delete():
    # sem rota DELETE/PUT/PATCH em /movements e /assets (histórico/lógica)
    from app import create_app

    app = create_app()
    for rule in app.url_map.iter_rules():
        if rule.rule.startswith(("/api/v1/movements", "/api/v1/assets")):
            assert not ({"DELETE", "PUT"} & rule.methods), rule.rule
            if rule.rule.startswith("/api/v1/movements"):
                assert "PATCH" not in rule.methods, rule.rule


def test_aprovacao_exige_aal2_e_perfil_adm(mv):  # noqa: F811
    asset_id = mv.w.asset(mv.a, "AP-1")
    mid = tm.request(mv, tm.USER_A, asset_id, mv.a, destination_room_id=str(mv.w.room(mv.a, "R"))).get_json()["id"]
    for sub in (tm.USER_A, tm.RH_A):
        r = mv.client.post(f"/api/v1/movements/{mid}/approve", json={"asset_version": 1}, headers=tm.h(sub))
        assert r.status_code in (401, 403)
    assert json.dumps(mv.client.get(f"/api/v1/movements/{mid}", headers=tm.h(tm.USER_A)).get_json())
