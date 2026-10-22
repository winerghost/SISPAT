"""Revisão AppSec 2026-10-21 — `dashboard_layout`/`dashboard_charts` (forma do corpo).

Complementa `test_sec_preferences.py` e `test_dashboard_layout_preferences.py`:
IDs de painel "perigosos" para o cliente JS (`__proto__`, `constructor`),
caixa/espaço, tipos errados, listas acima do teto, `null` fora do único campo
anulável, e nenhuma escrita/auditoria de sucesso quando o corpo é recusado.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from test_user_admin_db import api, auth_headers, world  # noqa: F401

from app.models.settings import UserPreferences

URL = "/api/v1/me/preferences"
SUB = "auth-sec-1021"


@pytest.fixture()
def user(api):
    unit = api.world.unit("A")
    api.world.user("Sec 1021", role="USER", units=[unit], auth_user_id=SUB)
    return api


def _rows(api):
    with api.world.session() as db:
        return list(db.execute(select(UserPreferences)).scalars().all())


@pytest.mark.parametrize(
    "layout",
    [
        {"order": ["__proto__"]},
        {"order": ["constructor"]},
        {"hidden": ["prototype"]},
        {"order": ["KPIS"]},
        {"order": [" kpis"]},
        {"order": ["kpis", "kpis"]},
        {"order": "kpis"},
        {"order": [{"id": "kpis"}]},
        {"order": [1]},
        {"order": ["kpis"] * 10},
        {
            "hidden": [
                "kpis", "units", "status", "monthly", "location", "bond", "pending", "rooms", "inventory",
                "tech_summary", "tech_category", "tech_units", "tech_status", "tech_no_owner", "tech_age",
            ]
        },
        ["kpis"],
        "kpis",
        1,
        True,
    ],
)
def test_layout_malformado_400_sem_gravar(user, layout):
    api = user
    response = api.client.patch(
        URL, json={"version": 0, "dashboard_layout": layout}, headers=auth_headers(SUB, aal="aal1")
    )
    assert response.status_code == 400
    assert _rows(api) == []
    assert api.world.audits("USER_PREFERENCES_UPDATED") == []


@pytest.mark.parametrize(
    "charts",
    [None, {"units": "pie"}, {"bond": "line"}, {"rooms": "donut"}, {"__proto__": "bar"}, ["units"], {"units": ["grouped"]}],
)
def test_charts_malformado_400_sem_gravar(user, charts):
    """Só `dashboard_layout` aceita `null`; `dashboard_charts: null` -> 400."""
    api = user
    response = api.client.patch(
        URL, json={"version": 0, "dashboard_charts": charts}, headers=auth_headers(SUB, aal="aal1")
    )
    assert response.status_code == 400
    assert _rows(api) == []


@pytest.mark.parametrize("version", [-1, "0", 0.0, True, None, 2_147_483_648])
def test_version_forjada_400(user, version):
    api = user
    response = api.client.patch(
        URL, json={"version": version, "dashboard_layout": None}, headers=auth_headers(SUB, aal="aal1")
    )
    assert response.status_code == 400
    assert _rows(api) == []


def test_null_restaura_padrao_e_resposta_so_com_allowlist(user):
    api = user
    h = auth_headers(SUB, aal="aal1")
    first = api.client.patch(
        URL, json={"version": 0, "dashboard_layout": {"order": ["inventory"], "hidden": ["kpis"]}}, headers=h
    )
    assert first.status_code == 200
    second = api.client.patch(URL, json={"version": 1, "dashboard_layout": None}, headers=h)
    assert second.status_code == 200
    body = second.get_json()
    assert body["dashboard_layout"]["hidden"] == []
    assert body["dashboard_layout"]["order"][0] == "kpis"
    (row,) = _rows(api)
    assert row.dashboard_layout == {}
