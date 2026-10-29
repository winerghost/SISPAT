"""ONDA A: painel `located_by_unit_chart` e registros do clique na barra.

Reusa o mundo SQLite de `test_dashboard_equipment` (schema real, `require_auth`
real). Cobre agregados exatos, "Outras", RBAC (ADM/USER/RH), IDOR/escopo,
400 sem eco, paginação/ordenação, ausência de dados pessoais, 401/AAL2,
contagem de painéis e preferências existentes.
"""
from __future__ import annotations

import uuid

import pytest
from test_user_admin_db import auth_headers
from test_dashboard_equipment import BASE, add, api, hdr  # noqa: F401  (fixture `api`)

from app.services import dashboard_equipment_service as des
from app.services import dashboard_located_service as dls
from app.services import dashboard_panels_service as dps

PANEL = "located_by_unit_chart"
SECRET = ("Fulano Segredo", "fulano.segredo@agu.gov.br", "123.456.789-09", "(63) 99999-0000")
PERSONAL_KEYS = {"responsible", "responsavel", "responsible_person_id", "email", "phone", "notes", "cpf"}


def _hdr(who, aal=None):
    if who == "multi":  # ADM com UA, UB e UC (escopo multiunidade; ADM nao tem bypass)
        return auth_headers("loc-multi", aal=aal or "aal2")
    return hdr(who, aal)


def multi(api, *units):
    api.world.user("Multi", role="ADM", units=[api.ua, api.ub, *units], auth_user_id="loc-multi")


def chart(api, who="ua", query=""):
    return api.client.get(f"{BASE}/panels/{PANEL}/data{query}", headers=_hdr(who))


def records(api, who="ua", query="", panel=PANEL, aal=None):
    return api.client.get(f"{BASE}/panels/{panel}/records{query}", headers=_hdr(who, aal))


def seed(api):
    """UA: 3 SIM, 2 NAO, 1 DESCONHECIDO (+1 SIM excluído). UB: 1 SIM, 2 NAO."""
    for i in range(3):
        add(api, api.ua, f"A-S{i}", "NOTEBOOK", located="SIM")
    for i in range(2):
        add(api, api.ua, f"A-N{i}", "MESA", located="NAO")
    add(api, api.ua, "A-D0", None, located="DESCONHECIDO")
    add(api, api.ua, "A-X", "NOTEBOOK", located="SIM", deleted=True)
    add(api, api.ub, "B-S0", "NOTEBOOK", located="SIM")
    for i in range(2):
        add(api, api.ub, f"B-N{i}", "MONITOR", located="NAO")


def by_unit(body):
    return {u["unidade"]: u for u in body["dados"]["unidades"]}


# --- painel -------------------------------------------------------------------------


def test_catalogo_contagens_por_perfil_e_posicao():
    assert len(dps.PANEL_CATALOG) == 13
    assert len(dps.allowed_panel_ids(["ADM"])) == 13
    assert len(dps.allowed_panel_ids(["USER"])) == 10
    assert len(dps.allowed_panel_ids(["RH"])) == 8
    ids = list(dps.PANEL_IDS)
    assert ids.index(PANEL) == ids.index("equipment_by_unit_chart") + 1
    p = dps.PANELS_BY_ID[PANEL]
    assert p.roles == frozenset({"ADM", "USER", "RH"}) and p.sizes == ("P", "M", "G")
    assert p.exportable is False and p.group == "graficos"
    assert PANEL in set(des.PANEL_BUILDERS)
    for role in ("ADM", "USER", "RH"):
        assert {"id": PANEL, "visible": True, "size": "G"} in dps.default_layout([role])
    assert dps.allowed_panel_ids(["OUTRO"]) == ()


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_painel_disponivel_aos_tres_perfis(api, who):
    seed(api)
    r = chart(api, who)
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    body = r.get_json()
    assert body["tipo"] == "grafico" and body["panel_id"] == PANEL
    assert [s["id"] for s in body["dados"]["series"]] == ["SIM", "NAO", "DESCONHECIDO"]


def test_agregados_exatos_e_escopo(api):
    seed(api)
    ua = by_unit(chart(api, "ua").get_json())
    assert set(ua) == {"UA"}
    assert ua["UA"]["valores"] == {"SIM": 3, "NAO": 2, "DESCONHECIDO": 1} and ua["UA"]["total"] == 6
    assert set(by_unit(chart(api, "adm").get_json())) == {"UA"}  # ADM sem bypass: so suas unidades
    multi(api)
    body = chart(api, "multi").get_json()
    rows = by_unit(body)
    assert rows["UB"]["valores"] == {"SIM": 1, "NAO": 2, "DESCONHECIDO": 0}
    assert body["dados"]["total"] == 9  # excluído fora
    for r in body["dados"]["unidades"]:
        assert sum(r["valores"].values()) == r["total"]
    ub = by_unit(chart(api, "ub").get_json())
    assert set(ub) == {"UB"}


def test_filtros_existentes_aplicam(api):
    seed(api)
    multi(api)
    body = chart(api, "multi", "?familia=TI").get_json()
    assert body["dados"]["total"] == 6 and body["filtros_aplicados"] == ["familia"]
    body = chart(api, "multi", f"?unit_id={api.ub}&categoria=MONITOR").get_json()
    assert by_unit(body)["UB"]["valores"] == {"SIM": 0, "NAO": 2, "DESCONHECIDO": 0}
    assert chart(api, "adm", f"?unit_id={uuid.uuid4()}").get_json()["dados"]["unidades"] == []


def test_outras_soma_exata(api, monkeypatch):
    seed(api)
    uc = api.world.unit("UC")
    multi(api, uc)
    add(api, uc, "C-S0", "NOTEBOOK", located="SIM")
    monkeypatch.setattr(des, "TOP_UNIDADES", 1)
    monkeypatch.setattr(dls, "TOP_UNIDADES", 1)
    body = chart(api, "multi").get_json()
    rows = body["dados"]["unidades"]
    assert [r["unidade"] for r in rows] == ["UA", "Outras"]
    outras = rows[1]
    assert outras["unit_id"] is None
    assert outras["valores"] == {"SIM": 2, "NAO": 2, "DESCONHECIDO": 0} and outras["total"] == 4
    assert body["dados"]["total"] == 10  # fecha com o acervo ativo
    got = records(api, "multi", "?unit_id=outras&page_size=50").get_json()
    assert got["total"] == 4
    assert {i["unidade"] for i in got["items"]} == {"UB", "UC"}
    only_nao = records(api, "multi", "?unit_id=outras&located=NAO").get_json()
    assert only_nao["total"] == 2 and {i["located"] for i in only_nao["items"]} == {"NAO"}
    # sem excedente: "outras" e vazio
    monkeypatch.setattr(dls, "TOP_UNIDADES", 15)
    assert records(api, "multi", "?unit_id=outras").get_json()["total"] == 0


# --- registros ----------------------------------------------------------------------


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_registros_por_perfil_e_cabecalhos(api, who):
    seed(api)
    r = records(api, who, f"?unit_id={api.ua}")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    body = r.get_json()
    assert set(body) == {"items", "total", "page", "page_size", "pages"}
    assert body["total"] == 6 and body["pages"] == 1 and body["page"] == 1 and body["page_size"] == 50
    assert set(body["items"][0]) == {
        "id", "patrimony_number", "description", "unidade", "sala", "located",
        "equipment_category", "classification_confidence",
    }
    assert "A-X" not in {i["patrimony_number"] for i in body["items"]}  # excluido


def test_registros_filtro_located_sala_e_categoria_efetiva(api):
    room = api.world.room(api.ua, "Sala 101")
    add(api, api.ua, "R1", "OUTROS", located="NAO", room_id=room, override="IMPRESSORA", conf="ALTA")
    seed(api)
    body = records(api, "ua", f"?unit_id={api.ua}&located=NAO&sort=patrimony_number").get_json()
    assert body["total"] == 3
    first = body["items"][0]
    assert first["patrimony_number"] == "A-N0" and first["sala"] is None
    r1 = body["items"][-1]
    assert r1["patrimony_number"] == "R1" and r1["sala"] == "Sala 101"
    assert r1["equipment_category"] == "IMPRESSORA" and r1["classification_confidence"] == "ALTA"


def test_idor_unidade_alheia_inexistente_mesma_resposta(api):
    seed(api)
    alheia = records(api, "ua", f"?unit_id={api.ub}")
    ghost = records(api, "ua", f"?unit_id={uuid.uuid4()}")
    assert alheia.status_code == ghost.status_code == 200
    assert alheia.get_json() == ghost.get_json()
    assert alheia.get_json()["total"] == 0 and alheia.get_json()["items"] == []
    assert "B-S0" not in alheia.get_data(as_text=True)
    assert records(api, "ub", f"?unit_id={api.ua}").get_json()["total"] == 0
    assert records(api, "adm", f"?unit_id={api.ub}").get_json()["total"] == 0  # ADM sem bypass
    multi(api)
    assert records(api, "multi", f"?unit_id={api.ub}").get_json()["total"] == 3
    assert records(api, "none", f"?unit_id={api.ua}").get_json()["total"] == 0


@pytest.mark.parametrize(
    "query",
    [
        "", "?unit_id=nao-e-uuid", "?unit_id=OUTRAS", "?unit_id=__SEGREDO__",
        "?unit_id=outras&located=TALVEZ", "?unit_id=outras&page_size=7",
        "?unit_id=outras&page=0", "?unit_id=outras&sort=password",
        "?unit_id=outras&sort=-updated_at", "?unit_id=outras&user_id=x",
        "?unit_id=outras&role=ADM", "?unit_id=outras&deleted_at=1",
        "?unit_id=outras&version=2", "?unit_id=outras&familia=XYZ",
        "?unit_id=outras&unit_id=outras",
    ],
)
def test_400_sem_eco(api, query):
    r = records(api, "ua", query)
    assert r.status_code == 400
    text = r.get_data(as_text=True)
    for leaked in ("__SEGREDO__", "nao-e-uuid", "TALVEZ", "password", "XYZ"):
        assert leaked not in text


def test_paginacao_e_ordenacao(api):
    for i in range(120):
        add(api, api.ua, f"P{i:03d}", "NOTEBOOK", located="SIM")
    q = f"?unit_id={api.ua}&located=SIM"
    p1 = records(api, "ua", q).get_json()
    assert (p1["total"], p1["pages"], len(p1["items"])) == (120, 3, 50)
    p3 = records(api, "ua", q + "&page=3").get_json()
    assert len(p3["items"]) == 20 and p3["items"][-1]["patrimony_number"] == "P119"
    big = records(api, "ua", q + "&page_size=200&sort=-patrimony_number").get_json()
    assert big["pages"] == 1 and big["items"][0]["patrimony_number"] == "P119"
    assert records(api, "ua", q + "&page=99").get_json()["items"] == []
    for sort in ("description", "-description", "located", "-located", "patrimony_number"):
        assert records(api, "ua", f"{q}&sort={sort}").status_code == 200


def test_sem_dados_pessoais(api):
    name, email, cpf, phone = SECRET
    person = api.world.person(api.ua, name)
    add(
        api, api.ua, "PII1", "NOTEBOOK", located="SIM", responsible_person_id=person,
        notes=f"{email} {cpf} {phone}", desc="(1) NOTEBOOK DELL",
    )
    for who in ("ua", "rh", "adm"):
        resp = records(api, who, f"?unit_id={api.ua}")
        for text in (resp.get_data(as_text=True), chart(api, who).get_data(as_text=True)):
            for secret in SECRET:
                assert secret not in text
        item = resp.get_json()["items"][0]
        assert not PERSONAL_KEYS & set(item)


# --- autenticacao / autorizacao -----------------------------------------------------


def test_sem_token_401(api):
    url = f"{BASE}/panels/{PANEL}/records?unit_id=outras"
    assert api.client.get(url).status_code == 401
    assert api.client.get(url, headers={"Authorization": "Bearer x"}).status_code == 401


def test_adm_sem_aal2_negado(api):
    assert records(api, "adm", "?unit_id=outras", aal="aal1").status_code in (401, 403)
    assert records(api, "adm", "?unit_id=outras", aal="aal2").status_code == 200


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_painel_sem_registros_ou_inexistente_404_identico(api, who):
    base = records(api, who, "?unit_id=outras", panel="nao_existe")
    assert base.status_code == 404
    for panel in ("sync_status", "kpi_workstations", "equipment_by_unit_chart", "LOCATED_BY_UNIT_CHART", "a" * 300):
        r = records(api, who, "?unit_id=outras", panel=panel)
        assert r.status_code == 404 and r.get_json() == base.get_json()
    # 404 vem antes da validacao da query
    assert records(api, who, "?lixo=1", panel="sync_status").status_code == 404


def test_perfil_sem_acesso_ao_painel_404_e_acesso_negado(api, monkeypatch):
    seed(api)
    # perfil sem o painel no catalogo (simula restricao futura): mesmo 404 do inexistente
    monkeypatch.setattr(dls, "allowed_panel_ids", lambda roles: ())
    monkeypatch.setattr(des, "allowed_panel_ids", lambda roles: ())
    ghost = records(api, "ua", "?unit_id=outras", panel="nao_existe")
    r = records(api, "ua", "?unit_id=outras")
    assert r.status_code == 404 and r.get_json() == ghost.get_json()
    assert chart(api, "ua").status_code == 404
    denied = [c.args[0] for c in api.events.call_args_list if c.args[0]["event_type"] == "ACCESS_DENIED"]
    assert len(denied) == 3 and denied[0]["details"] == denied[1]["details"]


def test_leitura_bem_sucedida_nao_gera_auditoria(api):
    from sqlalchemy import select

    from app.models.audit import AuditLog

    seed(api)
    records(api, "ua", f"?unit_id={api.ua}")
    with api.world.session() as db:
        assert db.execute(select(AuditLog)).scalars().all() == []


# --- preferencias existentes --------------------------------------------------------


def test_preferencia_salva_antiga_recebe_painel_novo_ao_fim(api):
    antigo = [p for p in dps.PANEL_IDS if p != PANEL]
    layout = [
        {"id": p, "visible": p != "kpi_furniture", "size": dps.PANELS_BY_ID[p].default_size}
        for p in antigo
    ]
    resolved = dps.resolve_panels(layout, None, ["ADM"])
    assert resolved[-1] == {"id": PANEL, "visible": True, "size": "G"}
    assert [p["id"] for p in resolved[:-1]] == antigo
    assert next(p for p in resolved if p["id"] == "kpi_furniture")["visible"] is False
    # legado: IDs antigos continuam traduzidos; painel novo completa o catalogo
    legacy = dps.panels_from_legacy_layout({"order": ["units", "kpis"], "hidden": []}, ["RH"])
    assert [p["id"] for p in legacy[:2]] == ["equipment_by_unit_chart", "kpi_workstations"]
    assert PANEL in {p["id"] for p in legacy} and len(legacy) == 8
