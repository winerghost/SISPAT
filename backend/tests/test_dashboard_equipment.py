"""ONDA 2: dados dos 12 painéis, fila de revisão e exportações do dashboard.

SQLite com o schema real, `require_auth` real, sem rede. Cobre 401/AAL2/RBAC por perfil,
painel proibido == inexistente, escopo/IDOR, `extra="forbid"` + 400 sem eco, `no-store`,
agregados exatos (override prevalece, `deleted_at` fora, top N + "Outras"), fila de revisão
(paginação, ordenação por allowlist), ausência de dados pessoais, exportação (formula
injection, auditoria, permissão) e guardas estáticos.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
import zipfile
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import get_args
from unittest.mock import patch

import pytest
import test_assets_api as taa
from sqlalchemy import select
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.api.v1 import dashboard_schemas as ds
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.services import asset_classification as ac
from app.services import dashboard_equipment_service as des
from app.services.dashboard_panels_service import PANEL_IDS, PANELS_BY_ID

BASE = "/api/v1/dashboard"
NOW = datetime.now(timezone.utc)
EXTRA = (
    "unit_aliases", "asset_movements", "inventories", "inventory_items",
    "sync_jobs", "sync_conflicts", "import_previews",
)
SUBS = {"ua": "eq-a", "ub": "eq-b", "rh": "eq-rh", "adm": "eq-adm", "none": "eq-none"}
ADM_ONLY = ("unclassified_review", "classification_overrides", "sync_status")
SHARED = tuple(p for p in PANEL_IDS if p not in ADM_ONLY)
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read", "exports.create"))
    world = taa.AssetWorld(taa._build_engine())
    with ExitStack() as stack:
        for target in (
            "app.api.v1.dashboard.get_db_session",
            "app.api.v1.dashboard_equipment.get_db_session",
            "app.auth.supabase_auth.get_db_session",
            "app.api.v1.assets.get_db_session",
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
        world.user("Sem Unidade", role="USER", units=[], auth_user_id=SUBS["none"])
        def world_audits(operation):
            with world.session() as db:
                return list(db.execute(select(AuditLog).where(AuditLog.operation == operation)).scalars())

        yield SimpleNamespace(
            client=client, world=world, ua=ua, ub=ub, events=events, world_audits=world_audits
        )


def hdr(who, aal=None):
    return auth_headers(SUBS[who], aal=aal or ("aal2" if who == "adm" else "aal1"))


def data(api, panel, who="ua", query="", aal=None):
    return api.client.get(f"{BASE}/panels/{panel}/data{query}", headers=hdr(who, aal))


def queue(api, who="adm", query="", aal=None):
    return api.client.get(f"{BASE}/classificacao/revisao{query}", headers=hdr(who, aal))


def add(api, unit, number, category, *, conf="ALTA", override=None, desc=None, deleted=False, **kw):
    if deleted:
        kw.update(deleted_at=NOW, deleted_by=uuid.uuid4())
    family = ac.CATEGORY_FAMILY.get(category) if category else None
    return api.world.asset(
        unit, number, description=desc, equipment_family=family, equipment_category=category,
        classification_confidence=conf if category else None, classification_rule="t" if category else None,
        category_override=override, **kw,
    )


def seed(api):
    """UA: 3 notebooks, 2 computadores, 2 monitores, 1 docking, 2 mesas, 1 armário,
    1 OUTROS/BAIXA (fila), 1 sem classificação, 1 notebook excluído, 1 override. UB: 2 notebooks."""
    for i in range(3):
        add(api, api.ua, f"N{i}", "NOTEBOOK")
    for i in range(2):
        add(api, api.ua, f"C{i}", "COMPUTADOR")
        add(api, api.ua, f"M{i}", "MONITOR")
    add(api, api.ua, "D1", "DOCKING")
    add(api, api.ua, "T1", "MESA")
    add(api, api.ua, "T2", "MESA")
    add(api, api.ua, "A1", "ARMARIO")
    add(api, api.ua, "Q1", "OUTROS", conf="BAIXA", desc="(1) HUB 16 PORTAS HUB")
    add(api, api.ua, "X1", None)
    add(api, api.ua, "Z1", "NOTEBOOK", deleted=True)
    add(api, api.ua, "O1", "OUTROS", conf="ALTA", override="IMPRESSORA")  # regra OUTROS, ADM: impressora
    add(api, api.ub, "B1", "NOTEBOOK")
    add(api, api.ub, "B2", "NOTEBOOK")


# --- autenticação / autorização -------------------------------------------------------

ROUTES = (
    "/panels/kpi_workstations/data",
    "/panels/equipment_by_unit_table/export",
    "/classificacao/revisao",
    "/classificacao/revisao/export",
)


@pytest.mark.parametrize("path", ROUTES)
def test_sem_token_401(api, path):
    assert api.client.get(BASE + path).status_code == 401
    assert api.client.get(BASE + path, headers={"Authorization": "Bearer x"}).status_code == 401


ROLE_OF = {"ua": "USER", "rh": "RH", "adm": "ADM"}


@pytest.mark.parametrize("panel", PANEL_IDS)
@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_paineis_por_perfil_conforme_o_catalogo(api, panel, who):
    response = data(api, panel, who)
    if ROLE_OF[who] in PANELS_BY_ID[panel].roles:
        assert response.status_code == 200
        assert response.headers["Cache-Control"] == "no-store"
        body = response.get_json()
        assert body["panel_id"] == panel and body["filtros_aplicados"] == []
    else:
        # painel proibido ao perfil == painel inexistente (mesmo status e corpo)
        ghost = data(api, "nao_existe", who)
        assert response.status_code == ghost.status_code == 404
        assert response.get_json() == ghost.get_json()
        assert panel not in response.get_data(as_text=True)


@pytest.mark.parametrize("who", ["ua", "rh"])
def test_painel_adm_proibido_igual_a_inexistente_e_malformado(api, who):
    forbidden = data(api, "sync_status", who)
    for ghost in ("nao_existe", "KPI_WORKSTATIONS", "..%2f..", "a" * 300):
        missing = data(api, ghost, who)
        assert forbidden.status_code == missing.status_code == 404
        assert forbidden.get_json() == missing.get_json()


@pytest.mark.parametrize("panel", SHARED[:3])
def test_adm_sem_aal2_negado(api, panel):
    assert data(api, panel, "adm", aal="aal1").status_code in (401, 403)
    assert queue(api, "adm", aal="aal1").status_code in (401, 403)


def test_usuario_sem_permissao_reports_read_403(api):
    from app.models.rbac import Permission, Role, RolePermission

    with api.world.session() as db:
        role = db.execute(select(Role).where(Role.code == "RH")).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == "reports.read")).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
        ).scalars():
            db.delete(rp)
    assert data(api, "kpi_workstations", "rh").status_code == 403


def test_paineis_negados_geram_evento_de_seguranca(api):
    data(api, "sync_status", "ua")
    data(api, "nao_existe", "ua")
    sent = [c.args[0] for c in api.events.call_args_list]
    denied = [e for e in sent if e["event_type"] == "ACCESS_DENIED"]
    assert len(denied) == 2
    assert denied[0]["details"] == denied[1]["details"]  # indistinguíveis também no log


def test_catalogo_cobre_os_13_paineis():
    assert set(des.PANEL_BUILDERS) == set(PANEL_IDS) and len(PANEL_IDS) == 13


# --- contrato de consulta -------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        "?foo=1", "?familia=ti", "?familia=BOGUS", "?categoria=notebook", "?categoria=BOGUS",
        "?unit_id=nao-uuid", "?familia=TI&familia=OUTROS", "?format=csv", "?user_id=1",
        "?categoria=%27%3Bdrop%20table%20assets%3B--",
    ],
)
def test_filtro_invalido_400_sem_eco(api, query):
    response = data(api, "kpi_workstations", query=query)
    assert response.status_code == 400
    body = response.get_data(as_text=True)
    for fragment in ("BOGUS", "drop table", "nao-uuid", "notebook", "'ti'"):
        assert fragment not in body


def test_filtros_validos_so_nomes_em_filtros_aplicados(api):
    body = data(api, "category_distribution", query=f"?familia=TI&categoria=NOTEBOOK&unit_id={api.ua}").get_json()
    assert body["filtros_aplicados"] == ["unit_id", "familia", "categoria"]
    assert str(api.ua) not in str(body["filtros_aplicados"])


# --- agregados -------------------------------------------------------------------------


def test_cartoes_workstations_override_prevalece_e_excluidos_fora(api):
    seed(api)
    dados = data(api, "kpi_workstations").get_json()["dados"]
    assert {i["id"]: i["value"] for i in dados["itens"]} == {"COMPUTADOR": 2, "NOTEBOOK": 3, "MONITOR": 2}
    assert dados["total"] == 7  # o notebook excluído e os de UB não contam
    infra = {i["id"]: i["value"] for i in data(api, "kpi_infrastructure").get_json()["dados"]["itens"]}
    assert infra == {"IMPRESSORA": 1, "NOBREAK": 0, "ESTABILIZADOR": 0, "DOCKING": 1}  # override => impressora
    mob = {i["id"]: i["value"] for i in data(api, "kpi_furniture").get_json()["dados"]["itens"]}
    assert mob == {"GAVETEIRO": 0, "ARMARIO": 1, "MESA": 2, "ESTACAO_TRABALHO": 0}


def test_escopo_adm_sem_bypass_e_usuario_sem_unidade_zeros(api):
    seed(api)
    total = lambda who: data(api, "kpi_workstations", who).get_json()["dados"]["total"]  # noqa: E731
    assert total("ua") == total("adm") == 7  # ADM só enxerga a própria unidade
    assert total("ub") == 2
    assert total("none") == 0
    assert data(api, "kpi_workstations", "none").status_code == 200


def test_unit_id_alheio_igual_a_inexistente(api):
    seed(api)
    other = data(api, "kpi_workstations", query=f"?unit_id={api.ub}").get_json()
    ghost = data(api, "kpi_workstations", query=f"?unit_id={uuid.uuid4()}").get_json()
    assert other == ghost and other["dados"]["total"] == 0
    assert data(api, "kpi_workstations", query=f"?unit_id={api.ua}").get_json()["dados"]["total"] == 7


def test_tabelas_por_unidade(api):
    seed(api)
    ti = data(api, "equipment_by_unit_table").get_json()["dados"]
    assert [c["id"] for c in ti["colunas"]] == list(ac.TI_CATEGORIES)
    [row] = ti["linhas"]
    assert row["unidade"] == "UA" and row["total"] == 3 + 2 + 2 + 1 + 1  # inclui override IMPRESSORA
    assert row["valores"]["NOTEBOOK"] == 3 and row["valores"]["IMPRESSORA"] == 1
    assert row["valores"]["NOBREAK"] == 0 and ti["total"] == row["total"]
    mob = data(api, "furniture_by_unit_table").get_json()["dados"]
    assert mob["linhas"][0]["valores"]["MESA"] == 2 and mob["total"] == 3


def test_grafico_padrao_ti_e_familia_selecionada(api):
    seed(api)
    ti = data(api, "equipment_by_unit_chart").get_json()["dados"]
    assert ti["familia"] == "TI" and [s["id"] for s in ti["series"]] == list(ac.TI_CATEGORIES)
    mob = data(api, "equipment_by_unit_chart", query="?familia=MOBILIARIO").get_json()["dados"]
    assert mob["familia"] == "MOBILIARIO" and mob["unidades"][0]["valores"]["MESA"] == 2
    # NAO_CLASSIFICADO não é uma família de série: cai no padrão
    assert data(api, "equipment_by_unit_chart", query="?familia=NAO_CLASSIFICADO").get_json()["dados"]["familia"] == "TI"


def test_grafico_top_n_mais_outras_com_soma_exata(api):
    units = [api.world.unit(f"G{i:02d}") for i in range(17)]
    api.world.user("Adm Muitas", role="ADM", units=units, auth_user_id="eq-many")
    SUBS["many"] = "eq-many"
    for i, unit in enumerate(units):
        for j in range(i + 1):
            add(api, unit, f"G{i}-{j}", "NOTEBOOK")
    dados = data(api, "equipment_by_unit_chart", "many", aal="aal2").get_json()["dados"]
    assert len(dados["unidades"]) == 16 and dados["unidades"][-1]["unidade"] == "Outras"
    assert dados["total"] == sum(range(1, 18)) == 153
    assert dados["unidades"][-1]["total"] == 1 + 2  # os 2 menores ficaram de fora
    assert dados["unidades"][-1]["valores"]["NOTEBOOK"] == 3


def test_distribuicao_soma_cem_e_nao_classificado(api):
    seed(api)
    dados = data(api, "category_distribution").get_json()["dados"]
    assert dados["total"] == 14  # 13 classificados + 1 sem classificação (excluído e UB fora)
    cats = {c["id"]: c["value"] for c in dados["categorias"]}
    assert cats["NOTEBOOK"] == 3 and cats["NAO_CLASSIFICADO"] == 1 and cats["IMPRESSORA"] == 1
    assert sum(cats.values()) == dados["total"]
    fam = {f["id"]: f["value"] for f in dados["familias"]}
    assert fam == {"TI": 9, "MOBILIARIO": 3, "OUTROS": 1, "NAO_CLASSIFICADO": 1}
    assert abs(sum(f["percentual"] for f in dados["familias"]) - 100) < 0.5
    only_ti = data(api, "category_distribution", query="?familia=TI").get_json()["dados"]
    assert {c["familia"] for c in only_ti["categorias"]} == {"TI"}


def test_distribuicao_vazia_sem_percentual(api):
    assert data(api, "category_distribution").get_json()["dados"] == {
        "total": 0, "familias": [], "categorias": [],
    }


def test_notebooks_sem_docking_e_razao(api):
    seed(api)
    nd = data(api, "notebooks_without_docking").get_json()["dados"]
    assert nd["notebooks"] == 3 and nd["docking"] == 1 and nd["sem_docking"] == 2
    assert nd["por_unidade"] == [{"unidade": "UA", "notebooks": 3, "docking": 1, "sem_docking": 2}]
    ratio = data(api, "workstation_ratio").get_json()["dados"]
    assert ratio == {
        "computadores": 2, "notebooks": 3, "monitores": 2,
        "monitores_por_computador": 1.0, "monitores_por_notebook": 0.67,
    }
    add(api, api.ub, "M9", "MONITOR")
    empty = data(api, "workstation_ratio", "ub").get_json()["dados"]
    assert empty["monitores_por_computador"] is None  # sem divisão por zero


def test_notebooks_sem_docking_nao_fica_negativo(api):
    add(api, api.ua, "N1", "NOTEBOOK")
    add(api, api.ua, "D1", "DOCKING")
    add(api, api.ua, "D2", "DOCKING")
    assert data(api, "notebooks_without_docking").get_json()["dados"]["sem_docking"] == 0


def test_painel_fila_e_overrides_para_adm(api):
    seed(api)
    review = data(api, "unclassified_review", "adm").get_json()["dados"]
    assert review == {"total_pendentes": 1, "por_unidade": [{"unidade": "UA", "value": 1}]}
    ov = data(api, "classification_overrides", "adm").get_json()["dados"]
    assert ov["total"] == 1 and ov["por_categoria"] == [{"id": "IMPRESSORA", "label": "Impressora", "value": 1}]
    assert ov["recentes"] == []  # nenhuma auditoria de override ainda
    sync = data(api, "sync_status", "adm").get_json()["dados"]
    assert sync == {"ultima_importacao": None, "ultimo_job": None, "conflitos_pendentes": 0}


def test_overrides_recentes_vem_da_auditoria_sem_autor(api):
    asset_id = add(api, api.ua, "Q9", "OUTROS", conf="BAIXA", desc="(9) HUB 16 PORTAS HUB")
    r = api.client.post(
        f"/api/v1/assets/{asset_id}/category-override", json={"category": "REDE", "version": 1},
        headers=hdr("adm"),
    )
    assert r.status_code == 200
    body = data(api, "classification_overrides", "adm").get_json()["dados"]
    [item] = body["recentes"]
    assert item["asset_id"] == str(asset_id) and item["patrimony_number"] == "Q9"
    assert item["categoria_anterior"] == "Outros" and item["categoria_nova"] == "Rede"
    blob = str(body)
    assert "Adm A" not in blob and "actor" not in blob and str(SUBS["adm"]) not in blob
    assert data(api, "unclassified_review", "adm").get_json()["dados"]["total_pendentes"] == 0


def test_overrides_de_bem_excluido_ou_alheio_nao_aparecem(api):
    mine = add(api, api.ua, "P1", "OUTROS", conf="BAIXA")
    api.client.post(f"/api/v1/assets/{mine}/category-override", json={"category": "MESA", "version": 1},
                   headers=hdr("adm"))
    with api.world.session() as db:
        db.get(Asset, mine).deleted_at = NOW
        db.get(Asset, mine).deleted_by = uuid.uuid4()
    ov = data(api, "classification_overrides", "adm").get_json()["dados"]
    assert ov["total"] == 0 and ov["recentes"] == []


def test_nenhuma_resposta_contem_dados_pessoais(api):
    person = api.world.person(api.ua, "Fulano de Tal Confidencial")
    add(api, api.ua, "S1", "NOTEBOOK", responsible_person_id=person, desc="(1) NOTEBOOK")
    add(api, api.ua, "S2", "OUTROS", conf="BAIXA", responsible_person_id=person, desc="(2) COISA")
    for who in ("ua", "rh", "adm"):
        for panel in PANEL_IDS:
            r = data(api, panel, who)
            if r.status_code == 200:
                text = r.get_data(as_text=True)
                assert "Fulano" not in text and "@" not in text
    text = queue(api).get_data(as_text=True)
    assert "Fulano" not in text and "responsible" not in text and "@" not in text


# --- fila de revisão -------------------------------------------------------------------


def test_fila_so_outros_baixa_sem_override_ativos_e_no_escopo(api):
    seed(api)
    add(api, api.ua, "Q2", "OUTROS", conf="BAIXA", desc="(2) COISA", deleted=True)
    add(api, api.ub, "Q3", "OUTROS", conf="BAIXA", desc="(3) OUTRA UNIDADE")
    add(api, api.ua, "Q4", "OUTROS", conf="BAIXA", override="MESA")  # já corrigido
    add(api, api.ua, "Q5", "OUTROS", conf="ALTA", desc="(5) CABO")  # acessório (ALTA)
    response = queue(api)
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert body["total"] == 1 and body["page"] == 1 and body["page_size"] == 50 and body["pages"] == 1
    [item] = body["items"]
    assert item["patrimony_number"] == "Q1" and item["description"] == "(1) HUB 16 PORTAS HUB"
    assert item["unidade"] == "UA" and item["version"] == 1 and item["classification_confidence"] == "BAIXA"
    assert set(item) == {
        "id", "patrimony_number", "description", "unit_id", "unidade", "equipment_family",
        "equipment_category", "classification_confidence", "classification_rule", "version",
    }
    assert [c["id"] for c in body["categorias"]] == list(ac.EQUIPMENT_CATEGORIES)


@pytest.mark.parametrize("who", ["ua", "rh", "none"])
def test_fila_so_para_adm(api, who):
    seed(api)
    assert queue(api, who).status_code == 403
    assert api.client.get(f"{BASE}/classificacao/revisao/export", headers=hdr(who)).status_code == 403


def test_fila_paginacao_ordenacao_e_unidade(api):
    for i in range(55):
        add(api, api.ua, f"Q{i:03d}", "OUTROS", conf="BAIXA", desc=f"(x) ITEM {i:03d}")
    add(api, api.ub, "QB", "OUTROS", conf="BAIXA")
    first = queue(api).get_json()
    assert first["total"] == 55 and first["pages"] == 2 and len(first["items"]) == 50
    second = queue(api, query="?page=2").get_json()
    assert len(second["items"]) == 5 and second["items"][0]["patrimony_number"] == "Q050"
    desc = queue(api, query="?sort=-patrimony_number&page_size=100").get_json()
    assert desc["items"][0]["patrimony_number"] == "Q054" and len(desc["items"]) == 55
    assert queue(api, query=f"?unit_id={api.ub}").get_json()["total"] == 0  # ADM sem bypass
    assert queue(api, query=f"?unit_id={api.ub}").get_json() == queue(api, query=f"?unit_id={uuid.uuid4()}").get_json()


@pytest.mark.parametrize(
    "query",
    ["?page_size=7", "?page=0", "?page=x", "?sort=password", "?sort=patrimony_number;drop", "?foo=1",
     "?page=1&page=2", "?role=ADM", "?unit_id=zzz", "?familia=TI"],
)
def test_fila_consulta_invalida_400_sem_eco(api, query):
    response = queue(api, query=query)
    assert response.status_code == 400
    text = response.get_data(as_text=True)
    assert "password" not in text and "drop" not in text and "zzz" not in text


# --- exportação ------------------------------------------------------------------------


def _csv(response):
    text = response.get_data(as_text=True).lstrip("﻿")
    return list(csv.reader(io.StringIO(text), delimiter=";"))


def test_exportacao_da_fila_neutraliza_formula_e_audita(api):
    evil = '=HYPERLINK("http://evil","x")'
    add(api, api.ua, "Q1", "OUTROS", conf="BAIXA", desc=evil)
    add(api, api.ua, "Q2", "OUTROS", conf="BAIXA", desc="+cmd|' /C calc'!A0")
    add(api, api.ua, "Q3", "OUTROS", conf="BAIXA", desc="@SUM(1+1)")
    response = api.client.get(f"{BASE}/classificacao/revisao/export", headers=hdr("adm"))
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store" and "attachment" in response.headers["Content-Disposition"]
    rows = _csv(response)
    assert rows[0][0] == "Patrimônio" and len(rows) == 4
    for row in rows[1:]:
        for cell in row:
            assert not cell.startswith(("=", "+", "-", "@")), cell
    assert any(c.startswith("'=") or c.startswith("'+") for r in rows for c in r)
    [audit] = api.world_audits("DASHBOARD_REVIEW_QUEUE_EXPORTED")
    assert audit.new_values["rows"] == 3 and audit.new_values["format"] == "csv"
    assert "evil" not in str(audit.new_values) and audit.entity_type == "dashboard_equipment_export"


def test_exportacao_xlsx_da_fila_sem_formula(api):
    add(api, api.ua, "Q1", "OUTROS", conf="BAIXA", desc="=1+1")
    response = api.client.get(f"{BASE}/classificacao/revisao/export?format=xlsx", headers=hdr("adm"))
    assert response.status_code == 200 and response.data[:2] == b"PK"
    xml = zipfile.ZipFile(io.BytesIO(response.data)).read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in xml
    assert ">=1+1<" not in xml and ">'=1+1<" in xml  # texto neutralizado, nunca fórmula


def test_exportacao_de_tabela_por_unidade(api):
    seed(api)
    response = api.client.get(f"{BASE}/panels/equipment_by_unit_table/export", headers=hdr("rh"))
    assert response.status_code == 200
    rows = _csv(response)
    assert rows[0] == ["Unidade", *[ac.EQUIPMENT_CATEGORY_LABELS[c] for c in ac.TI_CATEGORIES], "Total"]
    assert rows[1][0] == "UA" and rows[1][-1] == "9"
    [audit] = api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED")
    assert audit.entity_id == "equipment_by_unit_table" and audit.new_values["filters"] == []
    mob = api.client.get(f"{BASE}/panels/furniture_by_unit_table/export?format=xlsx", headers=hdr("ua"))
    assert mob.status_code == 200 and mob.data[:2] == b"PK"


@pytest.mark.parametrize("panel", [p for p in PANEL_IDS if p not in ("equipment_by_unit_table", "furniture_by_unit_table")] + ["nada"])
def test_exportacao_de_painel_nao_exportavel_ou_inexistente_404(api, panel):
    response = api.client.get(f"{BASE}/panels/{panel}/export", headers=hdr("adm"))
    assert response.status_code == 404
    ghost = api.client.get(f"{BASE}/panels/ghost/export", headers=hdr("adm"))
    assert response.get_json() == ghost.get_json()
    assert api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED") == []


def test_exportacao_exige_permissao_exports_create(api):
    from app.models.rbac import Permission, Role, RolePermission

    with api.world.session() as db:
        for code in ("USER", "ADM"):
            role = db.execute(select(Role).where(Role.code == code)).scalar_one()
            perm = db.execute(select(Permission).where(Permission.code == "exports.create")).scalar_one()
            for rp in db.execute(
                select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
            ).scalars():
                db.delete(rp)
    assert api.client.get(f"{BASE}/panels/equipment_by_unit_table/export", headers=hdr("ua")).status_code == 403
    assert api.client.get(f"{BASE}/classificacao/revisao/export", headers=hdr("adm")).status_code == 403
    assert api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED") == []


@pytest.mark.parametrize("query", ["?format=pdf", "?foo=1", "?familia=XX", "?format=csv&format=xlsx"])
def test_exportacao_consulta_invalida_400(api, query):
    assert api.client.get(f"{BASE}/panels/equipment_by_unit_table/export{query}", headers=hdr("ua")).status_code == 400
    assert api.client.get(f"{BASE}/classificacao/revisao/export{query}", headers=hdr("adm")).status_code == 400


def test_exportacao_adm_sem_aal2_negada(api):
    for path in ("/panels/equipment_by_unit_table/export", "/classificacao/revisao/export"):
        assert api.client.get(BASE + path, headers=hdr("adm", "aal1")).status_code in (401, 403)


# --- guardas estáticos ----------------------------------------------------------------


def test_schemas_espelham_o_vocabulario():
    assert get_args(ds.EquipamentoCategoria) == ac.EQUIPMENT_CATEGORIES
    assert get_args(ds.EquipamentoCategoriaFiltro) == (*ac.EQUIPMENT_CATEGORIES, ac.NOT_CLASSIFIED)
    assert get_args(ds.FamiliaFiltro) == (*ac.EQUIPMENT_FAMILIES, ac.NOT_CLASSIFIED)


def test_catalogo_marca_como_exportaveis_so_as_tabelas_suportadas():
    assert {p for p, d in PANELS_BY_ID.items() if d.exportable} == set(des.EXPORT_TABLES)


@pytest.mark.parametrize(
    "rel", ["services/dashboard_equipment_service.py", "services/dashboard_classification_service.py"]
)
def test_servicos_sem_sql_bruto(rel):
    src = (ROOT / "backend/app" / rel).read_text(encoding="utf-8")
    for needle in ("text(", ".execute(db", "f\"SELECT", "f'SELECT", "literal_column", "% ("):
        assert needle not in src
    assert "deleted_at" not in src or "deleted_at.is_(None)" in src or "_active_assets" in src


def test_rotas_novas_decorators_e_sem_parametro_do_cliente():
    src = (ROOT / "backend/app/api/v1/dashboard_equipment.py").read_text(encoding="utf-8")
    assert "request.args.get" not in src and "request.json" not in src
    routes = re.findall(r"@dashboard_bp\.route\(\"([^\"]+)\"[^\n]*\)\n((?:@[^\n]+\n)+)def", src)
    assert len(routes) == 5
    for path, decorators in routes:
        names = [re.match(r"@(\w+)", d).group(1) for d in decorators.strip().split("\n")]
        if "classificacao" in path:
            assert names[:4] == ["require_auth", "require_role", "require_aal2", "require_permission"]
        else:
            assert names[:3] == ["require_auth", "require_aal2_for_adm", "require_permission"]
        assert names[-1] == "rate_limit"
        assert ("exports.create" in decorators) == path.endswith("/export")
        assert ("reports.read" in decorators) == (not path.endswith("/export"))
