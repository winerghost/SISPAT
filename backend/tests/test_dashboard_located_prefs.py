"""ONDA C: preferencias de usuario existentes recebem `located_by_unit_chart` no fim,
sem perder ordem/tamanho/visibilidade, e USER/RH nunca ganham paineis so-ADM."""
from __future__ import annotations

import pytest
from test_dashboard_panels_api import SUBS, api, get_panels, put_prefs, seed_panels  # noqa: F401

from app.services import dashboard_panels_service as dps

PANEL = "located_by_unit_chart"
COUNTS = {"ADM": 13, "USER": 10, "RH": 8}
ADM_ONLY = ("unclassified_review", "classification_overrides", "sync_status")


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_catalogo_por_perfil_e_sem_painel_adm_para_user_rh(api, role):
    ids = [p["id"] for p in get_panels(api, role).get_json()["panels"]]
    assert len(ids) == COUNTS[role] and PANEL in ids
    if role != "ADM":
        assert not set(ADM_ONLY) & set(ids)


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_layout_salvo_antigo_recebe_painel_novo_no_fim_sem_perder_ordem_nem_tamanho(api, role):
    old = [p for p in dps.allowed_panel_ids([role]) if p != PANEL]
    saved = [
        {"id": pid, "visible": i % 4 != 1, "size": dps.PANELS_BY_ID[pid].sizes[-1]}
        for i, pid in enumerate(reversed(old))
    ]
    seed_panels(api, api.users[role], saved)
    got = get_panels(api, role).get_json()["preferences"]["panels"]
    assert got[:-1] == saved
    assert got[-1] == {"id": PANEL, "visible": True, "size": "G"}
    assert len(got) == COUNTS[role]


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_put_sem_o_painel_novo_o_acrescenta_e_restore_default_inclui(api, role):
    first = dps.allowed_panel_ids([role])[0]
    r = put_prefs(api, {"version": 0, "panels": [{"id": first, "visible": True, "size": "G"}]}, role)
    assert r.status_code == 200 and PANEL in [p["id"] for p in r.get_json()["panels"]]
    r = put_prefs(api, {"version": 1, "restore_default": True}, role)
    assert r.status_code == 200
    ids = [p["id"] for p in r.get_json()["panels"]]
    assert PANEL in ids and len(ids) == COUNTS[role]


@pytest.mark.parametrize("role", ["USER", "RH"])
@pytest.mark.parametrize("panel", ADM_ONLY)
def test_user_rh_nao_conseguem_gravar_painel_so_adm(api, role, panel):
    r = put_prefs(api, {"version": 0, "panels": [{"id": panel, "visible": True, "size": "M"}]}, role)
    assert r.status_code in (400, 403, 404)
