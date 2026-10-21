"""`dashboard_charts` em `GET/PATCH /api/v1/me/preferences` (SQLite, schema real)."""
from __future__ import annotations

import json

import pytest
from sqlalchemy import select
from test_user_admin_db import api, auth_headers, world  # noqa: F401

from app.models.settings import UserPreferences

URL = "/api/v1/me/preferences"
SUBS = {"USER": "auth-dc-user", "RH": "auth-dc-rh", "ADM": "auth-dc-adm"}
DEFAULTS = {
    "units": "grouped",
    "status": "pie",
    "monthly": "line",
    "location": "stacked",
    "bond": "donut",
    "rooms": "horizontal",
}


@pytest.fixture()
def people(api):
    unit = api.world.unit("A")
    users = {
        role: api.world.user(f"DC {role}", role=role, units=[unit], auth_user_id=sub)
        for role, sub in SUBS.items()
    }
    return api, users


def _get(api, sub=SUBS["USER"]):
    return api.client.get(URL, headers=auth_headers(sub, aal="aal1"))


def _patch(api, body, sub=SUBS["USER"]):
    return api.client.patch(URL, json=body, headers=auth_headers(sub, aal="aal1"))


def _rows(api):
    with api.world.session() as db:
        return list(db.execute(select(UserPreferences)).scalars().all())


def _stored(api, user_id):
    return next(r.dashboard_charts for r in _rows(api) if r.user_id == user_id)


def test_get_devolve_padroes(people):
    api, _ = people
    body = _get(api).get_json()
    assert body["dashboard_charts"] == DEFAULTS
    assert _rows(api) == []


@pytest.mark.parametrize(
    ("panel", "values"),
    [
        ("units", ["grouped", "stacked", "horizontal"]),
        ("status", ["pie", "donut", "bar"]),
        ("monthly", ["line", "area", "bar"]),
        ("location", ["grouped", "horizontal", "stacked"]),
        ("bond", ["pie", "bar", "donut"]),
        ("rooms", ["bar", "horizontal"]),
    ],
)
def test_allowlist_aceita_todos_os_valores(people, panel, values):
    api, _ = people
    version = 0
    for value in values:
        response = _patch(api, {"version": version, "dashboard_charts": {panel: value}})
        assert response.status_code == 200
        version += 1
        assert response.get_json()["dashboard_charts"] == {**DEFAULTS, panel: value}
    assert _get(api).get_json()["dashboard_charts"] == {**DEFAULTS, panel: values[-1]}


@pytest.mark.parametrize(
    "charts",
    [
        {"desconhecido": "pie"},
        {"units": "pie"},
        {"status": "line"},
        {"monthly": "stacked"},
        {"units": "GROUPED"},
        {"units": 1},
        {"units": True},
        {"units": ["grouped"]},
        {"units": {"type": "grouped"}},
        {"status": {"a": {"b": "pie"}}},
        {"units": ""},
        {"location": "pie"},
        {"location": "line"},
        {"bond": "line"},
        {"bond": "stacked"},
        {"rooms": "grouped"},
        {"rooms": "pie"},
        {"rooms": "BAR"},
        {"bond": 0},
        {"location": ["stacked"]},
        "pie",
        ["units"],
        1,
        None,
        {},
    ],
)
def test_valores_invalidos_400(people, charts):
    api, _ = people
    response = _patch(api, {"version": 0, "dashboard_charts": charts})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert _rows(api) == []


def test_chave_desconhecida_e_auditada(people):
    api, _ = people
    assert _patch(api, {"version": 0, "dashboard_charts": {"x": "pie"}}).status_code == 400
    assert any(e["event_type"] == "MASS_ASSIGNMENT_REJECTED" for e in api.events)


def test_null_restaura_padrao_e_remove_do_json(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_charts": {"units": "stacked", "status": "donut"}})
    assert _stored(api, users["USER"]) == {"units": "stacked", "status": "donut"}
    response = _patch(api, {"version": 1, "dashboard_charts": {"units": None}})
    assert response.status_code == 200
    assert response.get_json()["dashboard_charts"] == {**DEFAULTS, "status": "donut"}
    assert _stored(api, users["USER"]) == {"status": "donut"}


def test_valor_padrao_nao_e_gravado(people):
    api, users = people
    response = _patch(api, {"version": 0, "dashboard_charts": {"monthly": "line", "units": "stacked"}})
    assert response.status_code == 200
    assert _stored(api, users["USER"]) == {"units": "stacked"}


def test_merge_parcial_preserva_demais_chaves(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_charts": {"units": "horizontal"}})
    second = _patch(api, {"version": 1, "dashboard_charts": {"monthly": "area"}})
    assert second.get_json()["dashboard_charts"] == {**DEFAULTS, "units": "horizontal", "monthly": "area"}
    # alterar só densidade não toca nos gráficos
    third = _patch(api, {"version": 2, "density": "compact"})
    assert third.get_json()["dashboard_charts"]["units"] == "horizontal"
    assert _stored(api, users["USER"]) == {"units": "horizontal", "monthly": "area"}


def test_conflito_de_versao_409(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_charts": {"units": "stacked"}})
    for stale in (0, 7):
        response = _patch(api, {"version": stale, "dashboard_charts": {"units": "horizontal"}})
        assert response.status_code == 409
        assert response.get_json()["error"]["code"] == "version_conflict"
    assert _stored(api, users["USER"]) == {"units": "stacked"}


@pytest.mark.parametrize("field", ["user_id", "role", "unit_id", "deleted_at"])
def test_mass_assignment_rejeitado(people, field):
    api, users = people
    response = _patch(
        api,
        {"version": 0, "dashboard_charts": {"units": "stacked"}, field: str(users["ADM"])},
    )
    assert response.status_code == 400
    assert any(
        e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT")
        for e in api.events
    )
    assert _rows(api) == []


def test_isolamento_entre_usuarios(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_charts": {"units": "stacked"}}, sub=SUBS["USER"])
    assert _get(api, SUBS["RH"]).get_json()["dashboard_charts"] == DEFAULTS
    # B tem a própria versão 0 e não enxerga/altera a linha de A
    assert _patch(api, {"version": 0, "dashboard_charts": {"status": "bar"}}, sub=SUBS["RH"]).status_code == 200
    assert _stored(api, users["USER"]) == {"units": "stacked"}
    assert _stored(api, users["RH"]) == {"status": "bar"}
    # id alheio na query/cabeçalho é ignorado: alvo é sempre o JWT
    headers = {**auth_headers(SUBS["USER"], aal="aal1"), "X-User-Id": str(users["RH"])}
    api.client.patch(
        f"{URL}?user_id={users['RH']}",
        json={"version": 1, "dashboard_charts": {"monthly": "bar"}},
        headers=headers,
    )
    assert _stored(api, users["RH"]) == {"status": "bar"}
    assert _stored(api, users["USER"]) == {"units": "stacked", "monthly": "bar"}


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_todos_os_perfis_alteram_so_o_proprio(people, role):
    api, users = people
    response = _patch(api, {"version": 0, "dashboard_charts": {"status": "donut"}}, sub=SUBS[role])
    assert response.status_code == 200
    assert {r.user_id for r in _rows(api)} == {users[role]}


def test_auditoria_sem_dados_sensiveis(people):
    api, users = people
    token = auth_headers(SUBS["USER"], aal="aal1")
    api.client.patch(URL, json={"version": 0, "dashboard_charts": {"units": "stacked"}}, headers=token)
    (audit,) = api.world.audits("USER_PREFERENCES_UPDATED")
    assert audit.actor_user_id == users["USER"]
    assert audit.previous_values["dashboard_charts"] == DEFAULTS
    assert audit.new_values["dashboard_charts"] == {**DEFAULTS, "units": "stacked"}
    dumped = json.dumps([audit.previous_values, audit.new_values])
    assert token["Authorization"].split()[1] not in dumped
    assert "@" not in dumped
