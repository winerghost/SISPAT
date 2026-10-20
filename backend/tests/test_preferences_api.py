"""`GET/PATCH /api/v1/me/preferences` (Etapa 3 — Aparência), SQLite com schema real."""
from __future__ import annotations

import pytest
from sqlalchemy import select
from test_user_admin_db import api, auth_headers, world  # noqa: F401

from app.models.settings import UserPreferences

URL = "/api/v1/me/preferences"
SUB_A = "auth-pref-a"
SUB_B = "auth-pref-b"


@pytest.fixture()
def people(api):
    unit = api.world.unit("A")
    a = api.world.user("Pref A", role="USER", units=[unit], auth_user_id=SUB_A)
    b = api.world.user("Pref B", role="RH", units=[unit], auth_user_id=SUB_B)
    return api, a, b


def _get(api, sub=SUB_A):
    return api.client.get(URL, headers=auth_headers(sub, aal="aal1"))


def _patch(api, body, sub=SUB_A):
    return api.client.patch(URL, json=body, headers=auth_headers(sub, aal="aal1"))


def _rows(api):
    with api.world.session() as db:
        return list(db.execute(select(UserPreferences)).scalars().all())


def test_get_sem_linha_devolve_padroes_sem_criar(people):
    api, _a, _b = people
    response = _get(api)
    assert response.status_code == 200
    assert response.get_json() == {"density": "comfortable", "font_scale": 100, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 0}
    assert _rows(api) == []


def test_nao_autenticado_401(people):
    api, _a, _b = people
    assert api.client.get(URL).status_code == 401
    assert api.client.patch(URL, json={"version": 0, "density": "compact"}).status_code == 401


def test_upsert_cria_e_atualiza(people):
    api, a, _b = people
    first = _patch(api, {"version": 0, "density": "compact"})
    assert first.status_code == 200
    assert first.get_json() == {"density": "compact", "font_scale": 100, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 1}
    second = _patch(api, {"version": 1, "font_scale": 125})
    assert second.get_json() == {"density": "compact", "font_scale": 125, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 2}
    assert _get(api).get_json() == second.get_json()
    (row,) = _rows(api)
    assert row.user_id == a


def test_conflito_de_versao_409(people):
    api, _a, _b = people
    _patch(api, {"version": 0, "density": "compact"})
    for stale in (0, 5):
        response = _patch(api, {"version": stale, "font_scale": 112})
        assert response.status_code == 409
        assert response.get_json()["error"]["code"] == "version_conflict"
    assert _get(api).get_json()["font_scale"] == 100
    assert len(api.world.audits("USER_PREFERENCES_UPDATED")) == 1


def test_versao_positiva_sem_linha_e_conflito(people):
    api, _a, _b = people
    assert _patch(api, {"version": 1, "density": "compact"}).status_code == 409
    assert _rows(api) == []


@pytest.mark.parametrize(
    "body",
    [
        {"version": 0},
        {"density": "compact"},
        {"version": 0, "density": "grande"},
        {"version": 0, "density": 1},
        {"version": 0, "density": None},
        {"version": 0, "font_scale": 90},
        {"version": 0, "font_scale": "112"},
        {"version": 0, "font_scale": True},
        {"version": 0, "font_scale": 112.5},
        {"version": -1, "density": "compact"},
        {"version": "0", "density": "compact"},
        {"version": True, "density": "compact"},
        {"version": 2**40, "density": "compact"},
        [],
        "x",
    ],
)
def test_valores_invalidos_400(people, body):
    api, _a, _b = people
    response = _patch(api, body)
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert _rows(api) == []


def test_campo_extra_rejeitado_e_auditado(people):
    api, _a, _b = people
    response = _patch(api, {"version": 0, "density": "compact", "tema": "x"})
    assert response.status_code == 400
    assert any(e["event_type"] == "MASS_ASSIGNMENT_REJECTED" for e in api.events)
    assert _rows(api) == []


@pytest.mark.parametrize("field", ["user_id", "role", "unit_id", "version_id", "deleted_at"])
def test_mass_assignment_rejeitado_e_auditado(people, field):
    api, _a, b = people
    response = _patch(api, {"version": 0, "density": "compact", field: str(b)})
    assert response.status_code == 400
    assert any(
        e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT")
        for e in api.events
    )
    assert _rows(api) == []
    assert str(b) not in response.get_data(as_text=True)


def test_isolamento_entre_usuarios(people):
    api, a, b = people
    _patch(api, {"version": 0, "density": "compact", "font_scale": 125}, sub=SUB_A)
    assert _get(api, SUB_B).get_json() == {"density": "comfortable", "font_scale": 100, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 0}
    assert _patch(api, {"version": 0, "font_scale": 112}, sub=SUB_B).status_code == 200
    assert _get(api, SUB_A).get_json() == {"density": "compact", "font_scale": 125, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 1}
    assert {r.user_id for r in _rows(api)} == {a, b}


def test_auditoria_na_mesma_transacao_com_previous_new(people):
    api, a, _b = people
    _patch(api, {"version": 0, "density": "compact"})
    _patch(api, {"version": 1, "font_scale": 112})
    first, second = api.world.audits("USER_PREFERENCES_UPDATED")
    assert first.entity_type == "user_preferences" and first.entity_id == str(a)
    assert first.actor_user_id == a
    assert first.previous_values == {"density": "comfortable", "font_scale": 100, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 0}
    assert first.new_values == {"density": "compact", "font_scale": 100, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 1}
    assert second.previous_values == first.new_values
    assert second.new_values == {"density": "compact", "font_scale": 112, "dashboard_charts": {"units": "grouped", "status": "pie", "monthly": "line"}, "version": 2}


def test_qualquer_perfil_pode_usar(people):
    api, _a, _b = people
    assert _patch(api, {"version": 0, "density": "compact"}, sub=SUB_B).status_code == 200
