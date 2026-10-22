"""Painéis de Tecnologia na allowlist de `dashboard_layout` (versão, auditoria, legado)."""
from __future__ import annotations

from test_dashboard_layout_preferences import (  # noqa: F401
    ORDER,
    SUBS,
    _get,
    _patch,
    _seed_row,
    _stored,
    api,
    people,
    world,
)

from app.services.preferences_service import DEFAULT_DASHBOARD_ORDER

TECH = ["tech_summary", "tech_category", "tech_units", "tech_status", "tech_no_owner", "tech_age"]


def test_paineis_novos_ficam_no_fim_da_ordem_padrao():
    assert list(DEFAULT_DASHBOARD_ORDER[-6:]) == TECH
    assert len(DEFAULT_DASHBOARD_ORDER) == len(set(DEFAULT_DASHBOARD_ORDER)) == 15


def test_usuario_legado_sem_layout_ve_paineis_novos_ao_fim(people):
    api, users = people
    _seed_row(api, users["USER"], layout={"order": ["inventory", "kpis"]})  # só os 9 antigos
    order = _get(api).get_json()["dashboard_layout"]["order"]
    assert order[:2] == ["inventory", "kpis"] and order[-6:] == TECH
    assert len(order) == 15


def test_ocultar_e_reordenar_paineis_novos_com_version_e_auditoria(people):
    api, users = people
    response = _patch(api, {"version": 0, "dashboard_layout": {"order": ["tech_age"], "hidden": ["tech_status"]}})
    assert response.status_code == 200
    layout = response.get_json()["dashboard_layout"]
    assert layout["order"][0] == "tech_age" and layout["hidden"] == ["tech_status"]
    assert _stored(api, users["USER"])["hidden"] == ["tech_status"]
    assert _patch(api, {"version": 0, "dashboard_layout": {"hidden": []}}).status_code == 409  # versão velha
    (audit,) = api.world.audits("USER_PREFERENCES_UPDATED")
    assert audit.new_values["dashboard_layout"]["hidden"] == ["tech_status"]
    assert audit.previous_values["dashboard_layout"]["hidden"] == []


def test_painel_desconhecido_400_e_ocultar_todos_400(people):
    api, _ = people
    assert _patch(api, {"version": 0, "dashboard_layout": {"order": ["tech_bogus"]}}).status_code == 400
    assert _patch(api, {"version": 0, "dashboard_layout": {"hidden": ORDER}}).status_code == 400
    assert _patch(api, {"version": 0, "dashboard_layout": {"hidden": ORDER[:-1]}}).status_code == 200


def test_legado_com_id_invalido_no_banco_cai_no_padrao(people):
    api, users = people
    _seed_row(api, users["USER"], layout={"order": ["tech_bogus", "tech_age"], "hidden": ["x"]})
    layout = _get(api).get_json()["dashboard_layout"]
    assert layout["order"][0] == "tech_age" and layout["hidden"] == []
