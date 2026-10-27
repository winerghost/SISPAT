"""ONDA 2: `POST /api/v1/assets/<id>/category-override` (override manual do ADM).

Só ADM + AAL2; `version` otimista (409); auditoria `ASSET_CATEGORY_OVERRIDDEN` na MESMA
transação; confiança ALTA; o override prevalece sobre a regra e o motor não o sobrescreve;
mass assignment rejeitado com evento; bem alheio == inexistente == excluído.
"""
from __future__ import annotations

import json
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import test_assets_api as taa
from sqlalchemy import select
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.services import asset_classification as ac

SUBS = {"ua": "ov-a", "ub": "ov-b", "rh": "ov-rh", "adm": "ov-adm", "adm_b": "ov-adm-b"}
OP = "ASSET_CATEGORY_OVERRIDDEN"


@pytest.fixture()
def api(monkeypatch):
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read", "exports.create"))
    world = taa.AssetWorld(taa._build_engine())
    with ExitStack() as stack:
        for target in (
            "app.api.v1.assets.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        events = stack.enter_context(patch("app.authorization.security_events._dispatch"))
        client = create_app().test_client()
        ua, ub = world.unit("UA"), world.unit("UB")
        world.user("User A", role="USER", units=[ua], auth_user_id=SUBS["ua"])
        world.user("User B", role="USER", units=[ub], auth_user_id=SUBS["ub"])
        world.user("Rita RH", role="RH", units=[ua], auth_user_id=SUBS["rh"])
        world.user("Adm A", role="ADM", units=[ua], auth_user_id=SUBS["adm"])
        world.user("Adm B", role="ADM", units=[ub], auth_user_id=SUBS["adm_b"])
        yield SimpleNamespace(client=client, world=world, ua=ua, ub=ub, events=events)


def put(api, asset_id, body, who="adm", aal=None):
    aal = aal or ("aal2" if who.startswith("adm") else "aal1")
    return api.client.post(
        f"/api/v1/assets/{asset_id}/category-override", json=body, headers=auth_headers(SUBS[who], aal=aal)
    )


def mk(api, number="Q1", **kw):
    values = dict(
        description="(1) HUB 16 PORTAS HUB", equipment_family="OUTROS", equipment_category="OUTROS",
        classification_confidence="BAIXA", classification_rule="99_SEM_REGRA", classification_rules_version="2",
    )
    values.update(kw)
    return api.world.asset(api.ua, number, **values)


def audits(api, operation=OP):
    with api.world.session() as db:
        return list(db.execute(select(AuditLog).where(AuditLog.operation == operation)).scalars())


def row(api, asset_id) -> Asset:
    return api.world.row(asset_id)


def test_adm_aal2_aplica_override_confianca_alta_e_versao(api):
    asset_id = mk(api)
    r = put(api, asset_id, {"category": "REDE", "version": 1})
    assert r.status_code == 200, r.get_json()
    assert r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == {
        "id": str(asset_id), "patrimony_number": "Q1", "category_override": "REDE",
        "equipment_category": "OUTROS", "categoria_efetiva": "REDE", "familia_efetiva": "TI",
        "classification_confidence": "ALTA", "version": 2,
    }
    saved = row(api, asset_id)
    assert (saved.category_override, saved.classification_confidence, saved.version) == ("REDE", "ALTA", 2)
    # as colunas da REGRA ficam intactas (rastreabilidade)
    assert (saved.equipment_category, saved.classification_rule) == ("OUTROS", "99_SEM_REGRA")
    assert saved.updated_by is not None


def test_auditoria_na_mesma_transacao_sem_dado_pessoal(api):
    asset_id = mk(api)
    put(api, asset_id, {"category": "REDE", "version": 1})
    [log] = audits(api)
    assert log.entity_type == "asset" and log.entity_id == str(asset_id) and log.result == "SUCESSO"
    assert log.actor_user_id is not None
    assert log.previous_values == {
        "category_override": None, "effective_category": "OUTROS", "equipment_category": "OUTROS",
        "classification_confidence": "BAIXA", "classification_rule": "99_SEM_REGRA", "version": 1,
    }
    assert log.new_values == {
        "category_override": "REDE", "effective_category": "REDE", "effective_family": "TI",
        "classification_confidence": "ALTA", "version": 2,
    }
    blob = json.dumps([log.previous_values, log.new_values])
    assert "HUB" not in blob and "Adm A" not in blob


def test_falha_na_auditoria_desfaz_o_override(api):
    asset_id = mk(api)

    class Boom:
        def __init__(self, **_kw):
            raise RuntimeError("falha simulada")

    with patch("app.services.dashboard_classification_service.AuditLog", Boom):
        api.client.application.config["PROPAGATE_EXCEPTIONS"] = False
        r = put(api, asset_id, {"category": "REDE", "version": 1})
    assert r.status_code >= 500
    saved = row(api, asset_id)
    assert saved.category_override is None and saved.version == 1 and saved.classification_confidence == "BAIXA"
    assert audits(api) == []


def test_override_prevalece_e_motor_nao_sobrescreve(api):
    asset_id = mk(api)
    put(api, asset_id, {"category": "MESA", "version": 1})
    saved = row(api, asset_id)
    assert ac.effective_equipment_category(saved) == "MESA" and ac.effective_equipment_family(saved) == "MOBILIARIO"
    assert ac.apply_equipment_classification(saved, "(1) NOTEBOOK DELL") is False
    assert ac.would_reclassify(saved, "(1) NOTEBOOK DELL") is False
    assert saved.category_override == "MESA"


def test_mesma_categoria_de_novo_nao_grava_nem_audita(api):
    asset_id = mk(api)
    put(api, asset_id, {"category": "REDE", "version": 1})
    again = put(api, asset_id, {"category": "REDE", "version": 2})
    assert again.status_code == 200 and again.get_json()["version"] == 2
    assert len(audits(api)) == 1 and row(api, asset_id).version == 2
    change = put(api, asset_id, {"category": "NOTEBOOK", "version": 2})
    assert change.status_code == 200 and change.get_json()["version"] == 3
    assert len(audits(api)) == 2


def test_conflito_de_versao_409_sem_alterar_nem_auditar(api):
    asset_id = mk(api)
    assert put(api, asset_id, {"category": "REDE", "version": 1}).status_code == 200
    stale = put(api, asset_id, {"category": "MESA", "version": 1})
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"
    future = put(api, asset_id, {"category": "MESA", "version": 99})
    assert future.status_code == 409
    assert row(api, asset_id).category_override == "REDE" and len(audits(api)) == 1


def test_stale_data_do_orm_vira_409(api):
    from sqlalchemy.orm.exc import StaleDataError

    asset_id = mk(api)
    with taa._flush_raises(StaleDataError()):
        r = put(api, asset_id, {"category": "REDE", "version": 1})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "version_conflict"
    assert audits(api) == []


# --- autorização --------------------------------------------------------------------


def test_sem_token_401(api):
    url = f"/api/v1/assets/{uuid.uuid4()}/category-override"
    assert api.client.post(url, json={"category": "REDE", "version": 1}).status_code == 401


def test_adm_sem_aal2_negado_e_nada_muda(api):
    asset_id = mk(api)
    r = put(api, asset_id, {"category": "REDE", "version": 1}, who="adm", aal="aal1")
    assert r.status_code in (401, 403)
    assert row(api, asset_id).category_override is None and audits(api) == []


@pytest.mark.parametrize("who", ["ua", "rh"])
def test_user_e_rh_nao_aplicam_override(api, who):
    asset_id = mk(api)
    r = put(api, asset_id, {"category": "REDE", "version": 1}, who=who)
    assert r.status_code == 403
    assert row(api, asset_id).category_override is None and audits(api) == []


def test_adm_sem_permissao_assets_update_403(api):
    from app.models.rbac import Permission, Role, RolePermission

    asset_id = mk(api)
    with api.world.session() as db:
        role = db.execute(select(Role).where(Role.code == "ADM")).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == "assets.update")).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
        ).scalars():
            db.delete(rp)
    assert put(api, asset_id, {"category": "REDE", "version": 1}).status_code == 403
    assert row(api, asset_id).category_override is None


# --- IDOR / BOLA --------------------------------------------------------------------


def test_bem_alheio_igual_a_inexistente_e_a_excluido(api):
    asset_id = mk(api)
    deleted = mk(api, "Q2", deleted_at=datetime.now(timezone.utc), deleted_by=uuid.uuid4())
    other = put(api, asset_id, {"category": "REDE", "version": 1}, who="adm_b")  # ADM de outra unidade
    missing = put(api, uuid.uuid4(), {"category": "REDE", "version": 1}, who="adm_b")
    gone = put(api, deleted, {"category": "REDE", "version": 1})
    assert other.status_code == missing.status_code == gone.status_code == 404
    assert other.get_json() == missing.get_json() == gone.get_json()
    assert row(api, asset_id).category_override is None and row(api, deleted).category_override is None
    assert audits(api) == []


def test_id_malformado_nao_chega_ao_servico(api):
    r = api.client.post(
        "/api/v1/assets/nao-e-uuid/category-override", json={"category": "REDE", "version": 1},
        headers=auth_headers(SUBS["adm"], aal="aal2"),
    )
    assert r.status_code == 404


# --- validação / mass assignment ----------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"category": "rede", "version": 1},
        {"category": " REDE", "version": 1},
        {"category": "TI", "version": 1},  # família, não categoria
        {"category": "NAO_CLASSIFICADO", "version": 1},
        {"category": "BOGUS'; DROP TABLE assets;--", "version": 1},
        {"category": None, "version": 1},
        {"category": ["REDE"], "version": 1},
        {"category": "REDE"},
        {"version": 1},
        {"category": "REDE", "version": 0},
        {"category": "REDE", "version": "1"},
        {"category": "REDE", "version": 1.5},
        {"category": "REDE", "version": True},
        {"category": "REDE", "version": 2**40},
        {},
    ],
)
def test_corpo_invalido_400_sem_eco(api, body):
    asset_id = mk(api)
    r = put(api, asset_id, body)
    assert r.status_code == 400
    text = r.get_data(as_text=True)
    assert "DROP TABLE" not in text and "BOGUS" not in text
    assert row(api, asset_id).category_override is None and audits(api) == []


def test_corpo_nao_objeto_400(api):
    asset_id = mk(api)
    for body in ([], "REDE", 1, None):
        assert put(api, asset_id, body).status_code == 400


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", str(uuid.uuid4())), ("role", "ADM"), ("unit_id", str(uuid.uuid4())),
        ("deleted_at", "2026-01-01T00:00:00Z"), ("deleted_by", str(uuid.uuid4())),
        ("classification_confidence", "BAIXA"), ("equipment_category", "MESA"),
        ("category_override", "MESA"), ("created_by", str(uuid.uuid4())), ("id", str(uuid.uuid4())),
    ],
)
def test_mass_assignment_rejeitado_e_auditado(api, field, value):
    asset_id = mk(api)
    r = put(api, asset_id, {"category": "REDE", "version": 1, field: value})
    assert r.status_code == 400
    saved = row(api, asset_id)
    assert saved.category_override is None and saved.version == 1 and saved.deleted_at is None
    sent = [c.args[0] for c in api.events.call_args_list]
    flagged = [e for e in sent if e["event_type"] in ("PRIVILEGE_ESCALATION_ATTEMPT", "MASS_ASSIGNMENT_REJECTED")]
    assert len(flagged) == 1 and flagged[0]["details"]["fields"] == [field]
    assert flagged[0]["details"]["context"] == "assets.category_override"
    if field in ("user_id", "role", "unit_id", "deleted_at"):
        assert flagged[0]["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"
    assert audits(api) == []


def test_override_nao_expoe_nem_altera_outros_bens(api):
    first, second = mk(api, "Q1"), mk(api, "Q2")
    put(api, first, {"category": "REDE", "version": 1})
    assert row(api, second).category_override is None and row(api, second).version == 1


def test_rota_nao_aceita_outros_metodos(api):
    asset_id = mk(api)
    for method in ("put", "patch", "delete", "get"):
        r = getattr(api.client, method)(
            f"/api/v1/assets/{asset_id}/category-override", headers=auth_headers(SUBS["adm"], aal="aal2")
        )
        assert r.status_code in (404, 405)
