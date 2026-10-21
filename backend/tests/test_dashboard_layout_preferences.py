"""`dashboard_layout` (+ 6 chaves de `dashboard_charts`) em `/api/v1/me/preferences`.

SQLite com o schema real (CHECKs PostgreSQL removidos só no DDL de teste; os
limites de tamanho dos CHECKs são verificados aqui por cálculo).
"""
from __future__ import annotations

import json
from typing import get_args

import pytest
from sqlalchemy import select
from test_user_admin_db import api, auth_headers, world  # noqa: F401

from app.api.v1.schemas import (
    DASHBOARD_PANEL_IDS,
    DashboardChartsPatch,
    DashboardLayoutPatch,
    DashboardPanelId,
)
from app.models.settings import UserPreferences
from app.services.preferences_service import (
    DASHBOARD_CHART_OPTIONS,
    DEFAULT_DASHBOARD_CHARTS,
    DEFAULT_DASHBOARD_ORDER,
)

URL = "/api/v1/me/preferences"
SUBS = {"USER": "auth-dl-user", "RH": "auth-dl-rh", "ADM": "auth-dl-adm"}
ORDER = ["kpis", "units", "status", "monthly", "location", "bond", "pending", "rooms", "inventory"]
LAYOUT_DEFAULT = {"order": ORDER, "hidden": []}
CHART_DEFAULTS = {
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
        role: api.world.user(f"DL {role}", role=role, units=[unit], auth_user_id=sub)
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
    return next(r.dashboard_layout for r in _rows(api) if r.user_id == user_id)


def _seed_row(api, user_id, *, layout=None, charts=None):
    with api.world.session() as db:
        db.add(
            UserPreferences(
                user_id=user_id,
                density="comfortable",
                font_scale=100,
                dashboard_charts=charts if charts is not None else {},
                dashboard_layout=layout if layout is not None else {},
                version=1,
            )
        )
        db.commit()


# ---------------------------------------------------------------------------
# Contrato / allowlists
# ---------------------------------------------------------------------------


def test_allowlist_de_paineis_e_igual_no_schema_e_no_servico():
    assert list(get_args(DashboardPanelId)) == ORDER
    assert list(DASHBOARD_PANEL_IDS) == ORDER
    assert list(DEFAULT_DASHBOARD_ORDER) == ORDER


def test_allowlist_de_graficos_e_igual_no_schema_e_no_servico():
    assert set(DashboardChartsPatch.model_fields) == set(DASHBOARD_CHART_OPTIONS)
    for panel, options in DASHBOARD_CHART_OPTIONS.items():
        annotation = DashboardChartsPatch.model_fields[panel].annotation
        literal = next(a for a in get_args(annotation) if a is not type(None))
        assert set(get_args(literal)) == set(options), panel
    assert DEFAULT_DASHBOARD_CHARTS == CHART_DEFAULTS
    assert set(DashboardLayoutPatch.model_fields) == {"order", "hidden"}


def test_get_devolve_padroes_sem_criar_linha(people):
    api, _ = people
    body = _get(api).get_json()
    assert body["dashboard_layout"] == LAYOUT_DEFAULT
    assert body["dashboard_charts"] == CHART_DEFAULTS
    assert _rows(api) == []


# ---------------------------------------------------------------------------
# PATCH válido
# ---------------------------------------------------------------------------


def test_ordem_completa_e_oculto(people):
    api, users = people
    order = list(reversed(ORDER))
    response = _patch(api, {"version": 0, "dashboard_layout": {"order": order, "hidden": ["rooms", "kpis"]}})
    assert response.status_code == 200
    # hidden volta normalizado na ordem padrão
    assert response.get_json()["dashboard_layout"] == {"order": order, "hidden": ["kpis", "rooms"]}
    assert _stored(api, users["USER"]) == {"order": order, "hidden": ["kpis", "rooms"]}
    assert _get(api).get_json()["dashboard_layout"] == {"order": order, "hidden": ["kpis", "rooms"]}


def test_ordem_parcial_completa_com_os_demais_na_ordem_padrao(people):
    api, _ = people
    response = _patch(api, {"version": 0, "dashboard_layout": {"order": ["inventory", "bond"]}})
    assert response.status_code == 200
    assert response.get_json()["dashboard_layout"]["order"] == [
        "inventory", "bond", "kpis", "units", "status", "monthly", "location", "pending", "rooms",
    ]


@pytest.mark.parametrize("order", [ORDER, ORDER[:3], [], ["kpis"]])
def test_ordem_igual_a_padrao_nao_e_gravada(people, order):
    api, users = people
    assert _patch(api, {"version": 0, "dashboard_layout": {"order": order, "hidden": []}}).status_code == 200
    assert _stored(api, users["USER"]) == {}


def test_oito_ocultos_permitidos(people):
    api, _ = people
    hidden = ORDER[1:]
    response = _patch(api, {"version": 0, "dashboard_layout": {"hidden": hidden}})
    assert response.status_code == 200
    assert response.get_json()["dashboard_layout"]["hidden"] == hidden


def test_merge_parcial_preserva_a_outra_chave(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_layout": {"order": ["rooms"]}})
    second = _patch(api, {"version": 1, "dashboard_layout": {"hidden": ["pending"]}})
    assert second.get_json()["dashboard_layout"]["order"][0] == "rooms"
    assert second.get_json()["dashboard_layout"]["hidden"] == ["pending"]
    # alterar só densidade/gráficos não toca no layout
    third = _patch(api, {"version": 2, "density": "compact", "dashboard_charts": {"bond": "pie"}})
    assert third.status_code == 200
    assert third.get_json()["dashboard_layout"] == second.get_json()["dashboard_layout"]
    assert third.get_json()["dashboard_charts"] == {**CHART_DEFAULTS, "bond": "pie"}
    assert _stored(api, users["USER"])["hidden"] == ["pending"]


def test_null_restaura_padrao_do_layout(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_layout": {"order": ["rooms"], "hidden": ["kpis"]}})
    response = _patch(api, {"version": 1, "dashboard_layout": None})
    assert response.status_code == 200
    assert response.get_json()["dashboard_layout"] == LAYOUT_DEFAULT
    assert _stored(api, users["USER"]) == {}


def test_null_na_chave_restaura_so_a_chave(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_layout": {"order": ["rooms"], "hidden": ["kpis"]}})
    response = _patch(api, {"version": 1, "dashboard_layout": {"order": None}})
    assert response.status_code == 200
    assert response.get_json()["dashboard_layout"] == {"order": ORDER, "hidden": ["kpis"]}
    assert _stored(api, users["USER"]) == {"hidden": ["kpis"]}
    assert _patch(api, {"version": 2, "dashboard_layout": {"hidden": None}}).status_code == 200
    assert _stored(api, users["USER"]) == {}


def test_novas_chaves_de_graficos_com_null(people):
    api, _ = people
    _patch(api, {"version": 0, "dashboard_charts": {"location": "grouped", "rooms": "bar", "bond": "bar"}})
    response = _patch(api, {"version": 1, "dashboard_charts": {"rooms": None}})
    assert response.get_json()["dashboard_charts"] == {**CHART_DEFAULTS, "location": "grouped", "bond": "bar"}


def test_conflito_de_versao_409(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_layout": {"hidden": ["kpis"]}})
    response = _patch(api, {"version": 0, "dashboard_layout": {"hidden": ["rooms"]}})
    assert response.status_code == 409
    assert _stored(api, users["USER"]) == {"hidden": ["kpis"]}


# ---------------------------------------------------------------------------
# PATCH inválido
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "layout",
    [
        {"order": ["kpis", "kpis"]},
        {"hidden": ["rooms", "rooms"]},
        {"order": ["desconhecido"]},
        {"hidden": ["KPIS"]},
        {"order": [" kpis"]},
        {"order": "kpis"},
        {"order": {"kpis": 1}},
        {"order": [1]},
        {"order": [None]},
        {"order": [["kpis"]]},
        {"hidden": [True]},
        {"order": ORDER + ["kpis"]},
        {"order": ORDER * 100},
        {"hidden": ORDER},
        {"hidden": list(reversed(ORDER))},
        {},
        "kpis",
        ["kpis"],
        1,
        True,
    ],
)
def test_layout_invalido_400(people, layout):
    api, _ = people
    response = _patch(api, {"version": 0, "dashboard_layout": layout})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert _rows(api) == []


def test_ocultar_todos_400_mesmo_com_outros_campos(people):
    api, _ = people
    response = _patch(api, {"version": 0, "density": "compact", "dashboard_layout": {"hidden": ORDER}})
    assert response.status_code == 400
    assert _rows(api) == []


def test_mensagem_de_erro_nao_ecoa_valores(people):
    api, _ = people
    response = _patch(api, {"version": 0, "dashboard_layout": {"order": ["<script>x</script>"]}})
    assert response.status_code == 400
    assert "<script>" not in response.get_data(as_text=True)


@pytest.mark.parametrize("field", ["density", "font_scale", "dashboard_charts", "version"])
def test_null_continua_proibido_nos_demais_campos(people, field):
    api, _ = people
    body = {"version": 0, "dashboard_layout": {"hidden": ["kpis"]}, field: None}
    assert _patch(api, body).status_code == 400
    assert _rows(api) == []


@pytest.mark.parametrize("field", ["user_id", "role", "unit_id", "deleted_at", "version_id"])
def test_mass_assignment_com_layout(people, field):
    api, users = people
    response = _patch(api, {"version": 0, "dashboard_layout": {"hidden": ["kpis"]}, field: str(users["ADM"])})
    assert response.status_code == 400
    assert any(
        e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT") for e in api.events
    )
    assert _rows(api) == []


# ---------------------------------------------------------------------------
# Dado legado/inválido no banco -> padrão, nunca 500
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        ({"order": "kpis"}, LAYOUT_DEFAULT),
        ({"order": [1, None, {"a": 1}, ["x"]]}, LAYOUT_DEFAULT),
        ({"order": ["rooms", "rooms", "xpto"]}, {"order": ["rooms"] + [p for p in ORDER if p != "rooms"], "hidden": []}),
        ({"hidden": ORDER}, LAYOUT_DEFAULT),
        ({"hidden": ["kpis", "kpis", 3, "nada"]}, {"order": ORDER, "hidden": ["kpis"]}),
        ({"hidden": {"kpis": True}}, LAYOUT_DEFAULT),
        ({"desconhecida": [1], "order": None}, LAYOUT_DEFAULT),
        ([], LAYOUT_DEFAULT),
        ("texto", LAYOUT_DEFAULT),
    ],
)
def test_layout_legado_cai_no_padrao(people, stored, expected):
    api, users = people
    _seed_row(api, users["USER"], layout=stored)
    response = _get(api)
    assert response.status_code == 200
    assert response.get_json()["dashboard_layout"] == expected
    # PATCH sobre dado legado funciona e regrava só a forma normalizada
    assert _patch(api, {"version": 1, "density": "compact"}).status_code == 200
    stored_now = _stored(api, users["USER"])
    assert isinstance(stored_now, dict) and set(stored_now) <= {"order", "hidden"}


@pytest.mark.parametrize(
    "charts",
    [
        {"location": "pie", "bond": 1, "rooms": ["bar"], "x": "y"},
        {"rooms": {"a": "b"}, "bond": None},
        ["units"],
        "pie",
    ],
)
def test_graficos_legados_caem_no_padrao(people, charts):
    api, users = people
    _seed_row(api, users["USER"], charts=charts)
    response = _get(api)
    assert response.status_code == 200
    assert response.get_json()["dashboard_charts"] == CHART_DEFAULTS


# ---------------------------------------------------------------------------
# Tamanho (CHECKs de 512/1024 bytes) e auditoria
# ---------------------------------------------------------------------------


def _pg_text(value) -> bytes:
    # jsonb::text do PostgreSQL usa ", " e ": " (igual ao json.dumps padrão).
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def test_pior_caso_de_tamanho_cabe_nos_checks(people):
    api, users = people
    # maior valor NÃO padrão de cada painel (padrões não são gravados)
    longest = {
        panel: max((o for o in options if o != DEFAULT_DASHBOARD_CHARTS[panel]), key=len)
        for panel, options in DASHBOARD_CHART_OPTIONS.items()
    }
    layout = {"order": list(reversed(ORDER)), "hidden": ORDER[1:]}
    response = _patch(api, {"version": 0, "dashboard_charts": longest, "dashboard_layout": layout})
    assert response.status_code == 200
    row = next(r for r in _rows(api) if r.user_id == users["USER"])
    assert set(row.dashboard_charts) == set(DASHBOARD_CHART_OPTIONS)  # 6 chaves gravadas
    assert len(_pg_text(row.dashboard_charts)) <= 512
    assert len(_pg_text(row.dashboard_layout)) <= 1024
    # mesmo um JSON com TODAS as 6 chaves no maior valor possível cabe
    worst = {p: max(o, key=len) for p, o in DASHBOARD_CHART_OPTIONS.items()}
    assert len(_pg_text(worst)) <= 512


def test_auditoria_inclui_layout_sem_dados_sensiveis(people):
    api, users = people
    token = auth_headers(SUBS["USER"], aal="aal1")
    api.client.patch(URL, json={"version": 0, "dashboard_layout": {"hidden": ["kpis"]}}, headers=token)
    (audit,) = api.world.audits("USER_PREFERENCES_UPDATED")
    assert audit.actor_user_id == users["USER"]
    assert audit.previous_values["dashboard_layout"] == LAYOUT_DEFAULT
    assert audit.new_values["dashboard_layout"] == {"order": ORDER, "hidden": ["kpis"]}
    dumped = json.dumps([audit.previous_values, audit.new_values])
    assert token["Authorization"].split()[1] not in dumped
    assert "@" not in dumped and "DL USER" not in dumped


def test_isolamento_entre_usuarios(people):
    api, users = people
    _patch(api, {"version": 0, "dashboard_layout": {"hidden": ["kpis"]}}, sub=SUBS["USER"])
    assert _get(api, SUBS["RH"]).get_json()["dashboard_layout"] == LAYOUT_DEFAULT
    assert {r.user_id for r in _rows(api)} == {users["USER"]}
