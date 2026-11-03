"""Preferências de painel x `located_summary` (ponta a ponta, via HTTP).

Quem já salvou um layout NÃO o perde: o painel novo entra ao FIM da lista
efetiva, visível e no tamanho padrão (M), para os três perfis; `restore_default`
o devolve na posição de catálogo. Reusa as fixtures de
`test_dashboard_panels_api` (SQLite com o schema real, `require_auth` real).
"""
from __future__ import annotations

import pytest
from test_dashboard_panels_api import api, get_panels, put_prefs, seed_panels  # noqa: F401

from app.services import dashboard_panels_service as dps

PANEL = "located_summary"
COUNTS = {"ADM": 14, "USER": 11, "RH": 9}


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_catalogo_expoe_o_painel_aos_tres_perfis(api, role):
    body = get_panels(api, role).get_json()
    painel = next(p for p in body["panels"] if p["id"] == PANEL)
    assert len(body["panels"]) == COUNTS[role]
    assert painel["label"] == "Situação de localização (gráfico)"
    assert painel["sizes"] == ["P", "M", "G"] and painel["default_size"] == "M"
    assert painel["exportable"] is False and painel["group"] == "graficos"
    assert "roles" not in painel  # o campo de permissão nunca é exposto
    assert {"id": PANEL, "visible": True, "size": "M"} in body["default_layout"]


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_layout_salvo_sem_o_painel_novo_o_recebe_no_fim(api, role):
    antigo = [p for p in dps.allowed_panel_ids([role]) if p != PANEL]
    salvo = [
        {"id": pid, "visible": i % 4 != 1, "size": dps.PANELS_BY_ID[pid].sizes[-1]}
        for i, pid in enumerate(reversed(antigo))
    ]
    seed_panels(api, api.users[role], salvo)
    got = get_panels(api, role).get_json()["preferences"]["panels"]
    assert got[:-1] == salvo  # ordem, tamanho e visibilidade preservados
    assert got[-1] == {"id": PANEL, "visible": True, "size": "M"}
    assert len(got) == COUNTS[role]


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_put_sem_o_painel_o_acrescenta_e_restore_default_o_inclui(api, role):
    primeiro = dps.allowed_panel_ids([role])[0]
    response = put_prefs(
        api, {"version": 0, "panels": [{"id": primeiro, "visible": True, "size": "G"}]}, role
    )
    assert response.status_code == 200
    acrescentado = next(p for p in response.get_json()["panels"] if p["id"] == PANEL)
    assert acrescentado == {"id": PANEL, "visible": True, "size": "M"}
    response = put_prefs(api, {"version": 1, "restore_default": True}, role)
    assert response.status_code == 200
    panels = response.get_json()["panels"]
    assert len(panels) == COUNTS[role]
    assert panels[panels.index({"id": PANEL, "visible": True, "size": "M"}) - 1]["id"] == (
        "located_by_unit_chart"
    )


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
@pytest.mark.parametrize("size", ["P", "M", "G"])
def test_tamanhos_admitidos_aceitos_e_tamanho_invalido_400(api, role, size):
    body = {"version": 0, "panels": [{"id": PANEL, "visible": True, "size": size}]}
    assert put_prefs(api, body, role).status_code == 200
    ruim = {"version": 1, "panels": [{"id": PANEL, "visible": True, "size": "X"}]}
    resposta = put_prefs(api, ruim, role)
    assert resposta.status_code == 400 and "X" not in resposta.get_data(as_text=True)
