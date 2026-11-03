"""Painel `located_summary`: quantitativo GLOBAL por situação de localização.

Reusa o mundo SQLite de `test_dashboard_equipment` (schema real, `require_auth`
real). Cobre o contrato congelado (três séries sempre, na ordem fixa, soma ==
`total`, percentual arredondado e `null` sem acervo), escopo/IDOR, RBAC
(ADM/USER/RH, AAL2, `reports.read`), filtros, a ausência de rota de registros e
a normalização das preferências já salvas.
"""
from __future__ import annotations

import uuid

import pytest
from test_user_admin_db import auth_headers
from test_dashboard_equipment import BASE, add, api, hdr  # noqa: F401  (fixture `api`)

from app.services import dashboard_equipment_service as des
from app.services import dashboard_panels_service as dps

PANEL = "located_summary"
SERIES = [("SIM", "Localizados"), ("NAO", "Não localizados"), ("DESCONHECIDO", "Não informado")]


def _hdr(who, aal=None):
    if who == "multi":  # ADM com UA e UB (escopo multiunidade; ADM nao tem bypass)
        return auth_headers("ls-multi", aal=aal or "aal2")
    return hdr(who, aal)


def multi(api):
    api.world.user("Multi", role="ADM", units=[api.ua, api.ub], auth_user_id="ls-multi")


def chart(api, who="ua", query="", aal=None):
    return api.client.get(f"{BASE}/panels/{PANEL}/data{query}", headers=_hdr(who, aal))


def records(api, who="ua", panel=PANEL):
    url = f"{BASE}/panels/{panel}/records?unit_id=outras"
    return api.client.get(url, headers=_hdr(who))


def series(body) -> dict[str, dict]:
    return {s["id"]: s for s in body["dados"]["series"]}


def seed(api):
    """UA: 2 SIM, 1 NAO (+1 SIM excluído, fora da conta). UB: 1 SIM, 2 NAO."""
    for i in range(2):
        add(api, api.ua, f"A-S{i}", "NOTEBOOK", located="SIM")
    add(api, api.ua, "A-N0", "MESA", located="NAO")
    add(api, api.ua, "A-X", "NOTEBOOK", located="SIM", deleted=True)
    add(api, api.ub, "B-S0", "NOTEBOOK", located="SIM")
    for i in range(2):
        add(api, api.ub, f"B-N{i}", "MONITOR", located="NAO")


# --- catálogo -----------------------------------------------------------------------


def test_catalogo_posicao_perfis_e_builder():
    ids = list(dps.PANEL_IDS)
    assert ids.index(PANEL) == ids.index("located_by_unit_chart") + 1
    assert ids.index(PANEL) + 1 == ids.index("category_distribution")
    panel = dps.PANELS_BY_ID[PANEL]
    assert panel.roles == frozenset({"ADM", "USER", "RH"}) and panel.sizes == ("P", "M", "G")
    assert panel.default_size == "M" and panel.exportable is False and panel.group == "graficos"
    assert panel.label == "Situação de localização (gráfico)"
    assert PANEL in set(des.PANEL_BUILDERS)
    assert PANEL not in des.EXPORT_TABLES
    for role in ("ADM", "USER", "RH"):
        assert {"id": PANEL, "visible": True, "size": "M"} in dps.default_layout([role])
    assert PANEL not in set(dps.LEGACY_PANEL_MAP.values())


# --- contrato ------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_painel_disponivel_aos_tres_perfis_com_a_forma_fixa(api, who):
    seed(api)
    response = chart(api, who)
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert set(body) == {"panel_id", "tipo", "dados", "filtros_aplicados"}
    assert body["panel_id"] == PANEL and body["tipo"] == "grafico"
    assert set(body["dados"]) == {"total", "series"}
    assert [(s["id"], s["label"]) for s in body["dados"]["series"]] == SERIES
    for item in body["dados"]["series"]:
        assert set(item) == {"id", "label", "value", "percentual"}


def test_soma_exata_e_percentual_arredondado(api):
    seed(api)
    body = chart(api, "ua").get_json()
    rows = series(body)
    assert body["dados"]["total"] == 3  # excluído fora
    assert sum(s["value"] for s in body["dados"]["series"]) == body["dados"]["total"]
    assert (rows["SIM"]["value"], rows["NAO"]["value"], rows["DESCONHECIDO"]["value"]) == (2, 1, 0)
    assert rows["SIM"]["percentual"] == 66.7 and rows["NAO"]["percentual"] == 33.3
    assert rows["DESCONHECIDO"]["percentual"] == 0.0  # série zerada ainda sai (total > 0)


def test_acervo_vazio_devolve_200_com_tres_series_zeradas_e_percentual_nulo(api):
    body = chart(api, "ua").get_json()
    assert body["dados"]["total"] == 0
    assert [s["value"] for s in body["dados"]["series"]] == [0, 0, 0]
    assert [s["percentual"] for s in body["dados"]["series"]] == [None, None, None]
    assert [s["id"] for s in body["dados"]["series"]] == [i for i, _ in SERIES]


def test_situacao_nao_informada_cai_em_desconhecido(api):
    add(api, api.ua, "A-D0", None)  # sem `located`: server_default DESCONHECIDO
    add(api, api.ua, "A-S0", "NOTEBOOK", located="SIM")
    rows = series(chart(api, "ua").get_json())
    assert rows["DESCONHECIDO"]["value"] == 1 and rows["SIM"]["value"] == 1
    assert rows["DESCONHECIDO"]["percentual"] == 50.0


# --- escopo / IDOR -------------------------------------------------------------------


def test_escopo_de_unidade_e_adm_sem_bypass(api):
    seed(api)
    assert chart(api, "ua").get_json()["dados"]["total"] == 3
    assert chart(api, "ub").get_json()["dados"]["total"] == 3
    assert chart(api, "adm").get_json()["dados"]["total"] == 3  # ADM só nas suas unidades
    assert series(chart(api, "adm").get_json())["SIM"]["value"] == 2
    assert chart(api, "none").get_json()["dados"]["total"] == 0  # sem unidade: nada
    multi(api)
    body = chart(api, "multi").get_json()
    rows = series(body)
    assert body["dados"]["total"] == 6
    assert (rows["SIM"]["value"], rows["NAO"]["value"]) == (3, 3)
    assert rows["SIM"]["percentual"] == 50.0


def test_unidade_alheia_e_inexistente_tem_a_mesma_resposta(api):
    seed(api)
    alheia = chart(api, "ua", f"?unit_id={api.ub}")
    ghost = chart(api, "ua", f"?unit_id={uuid.uuid4()}")
    assert alheia.status_code == ghost.status_code == 200
    assert alheia.get_json() == ghost.get_json()
    assert alheia.get_json()["dados"]["total"] == 0


# --- filtros -------------------------------------------------------------------------


def test_filtros_aplicam_e_aparecem_por_nome(api):
    seed(api)
    multi(api)
    body = chart(api, "multi", "?familia=TI").get_json()
    assert body["filtros_aplicados"] == ["familia"]
    rows = series(body)
    assert (rows["SIM"]["value"], rows["NAO"]["value"]) == (3, 2) and body["dados"]["total"] == 5
    body = chart(api, "multi", f"?unit_id={api.ub}&categoria=MONITOR").get_json()
    assert body["filtros_aplicados"] == ["unit_id", "categoria"]
    assert body["dados"]["total"] == 2 and series(body)["NAO"]["value"] == 2
    assert series(body)["SIM"] == {"id": "SIM", "label": "Localizados", "value": 0, "percentual": 0.0}
    vazio = chart(api, "multi", "?familia=NAO_CLASSIFICADO").get_json()
    assert vazio["dados"]["total"] == 0 and vazio["dados"]["series"][0]["percentual"] is None


@pytest.mark.parametrize(
    "query",
    [
        "?foo=1", "?familia=BOGUS", "?categoria=notebook", "?unit_id=nao-uuid",
        "?user_id=1", "?located=SIM", "?familia=TI&familia=OUTROS", "?format=csv",
    ],
)
def test_filtro_invalido_400_sem_eco(api, query):
    response = chart(api, "ua", query)
    assert response.status_code == 400
    text = response.get_data(as_text=True)
    for leaked in ("BOGUS", "notebook", "nao-uuid"):
        assert leaked not in text


# --- autenticação / autorização ------------------------------------------------------


def test_sem_token_401(api):
    url = f"{BASE}/panels/{PANEL}/data"
    assert api.client.get(url).status_code == 401
    assert api.client.get(url, headers={"Authorization": "Bearer x"}).status_code == 401


def test_adm_sem_aal2_negado(api):
    assert chart(api, "adm", aal="aal1").status_code in (401, 403)
    assert chart(api, "adm", aal="aal2").status_code == 200


def test_sem_permissao_reports_read_403(api):
    from sqlalchemy import select

    from app.models.rbac import Permission, Role, RolePermission

    with api.world.session() as db:
        role = db.execute(select(Role).where(Role.code == "RH")).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == "reports.read")).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(
                RolePermission.role_id == role.id, RolePermission.permission_id == perm.id
            )
        ).scalars():
            db.delete(rp)
    assert chart(api, "rh").status_code == 403


def test_perfil_sem_o_painel_recebe_404_de_inexistente(api, monkeypatch):
    seed(api)
    monkeypatch.setattr(des, "allowed_panel_ids", lambda roles: ())
    ghost = chart(api, "ua")
    assert ghost.status_code == 404
    assert PANEL not in ghost.get_data(as_text=True)


# --- sem registros e sem exportação --------------------------------------------------


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_sem_endpoint_de_registros_404_identico(api, who):
    seed(api)
    ghost = records(api, who, panel="nao_existe")
    response = records(api, who)
    assert response.status_code == ghost.status_code == 404
    assert response.get_json() == ghost.get_json()
    assert PANEL not in response.get_data(as_text=True)


def test_sem_exportacao_404(api):
    seed(api)
    response = api.client.get(f"{BASE}/panels/{PANEL}/export", headers=hdr("adm"))
    ghost = api.client.get(f"{BASE}/panels/ghost/export", headers=hdr("adm"))
    assert response.status_code == 404 and response.get_json() == ghost.get_json()
    assert api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED") == []


# --- preferências já salvas (normalização) -------------------------------------------


def test_layout_salvo_sem_o_painel_novo_o_recebe_visivel_em_m():
    antigo = [p for p in dps.PANEL_IDS if p != PANEL]
    layout = [
        {"id": p, "visible": p != "kpi_furniture", "size": dps.PANELS_BY_ID[p].default_size}
        for p in antigo
    ]
    resolved = dps.resolve_panels(layout, None, ["ADM"])
    assert [p["id"] for p in resolved[:-1]] == antigo
    assert resolved[-1] == {"id": PANEL, "visible": True, "size": "M"}
    assert next(p for p in resolved if p["id"] == "kpi_furniture")["visible"] is False


@pytest.mark.parametrize("role", ["ADM", "USER", "RH"])
def test_todos_os_perfis_ganham_o_painel_novo_no_fim(role):
    antigo = [p for p in dps.allowed_panel_ids([role]) if p != PANEL]
    layout = [{"id": p, "visible": True, "size": "P"} for p in antigo]
    resolved = dps.resolve_panels(layout, None, [role])
    assert resolved[-1] == {"id": PANEL, "visible": True, "size": "M"}
    assert len(resolved) == len(dps.allowed_panel_ids([role]))
    # layout legado traduzido também é completado com o painel novo
    legacy = dps.panels_from_legacy_layout({"order": ["kpis"], "hidden": []}, [role])
    assert PANEL in {p["id"] for p in legacy}


def test_dado_invalido_do_banco_cai_no_padrao_sem_erro():
    for raw in (None, "lixo", [], [{"id": 1}], [{"id": "painel_fantasma"}], [PANEL]):
        assert dps.resolve_panels(raw, None, ["USER"]) == dps.default_layout(["USER"])
    # tipos errados dentro de uma entrada válida: normalizados (nunca erro)
    primeiro, *resto = dps.resolve_panels(
        [{"id": PANEL, "visible": "sim", "size": 9}], None, ["USER"]
    )
    assert primeiro == {"id": PANEL, "visible": True, "size": "M"}
    assert len(resto) == len(dps.allowed_panel_ids(["USER"])) - 1
