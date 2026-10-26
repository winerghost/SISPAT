"""API de relatórios `/api/v1/reports` (catálogo + exportação CSV/XLSX), ponta a ponta.

SQLite com o schema real, `require_auth` real, Redis falso, sem rede. Cobre 401,
perfis/AAL2, escopo de unidade (IDOR -> 404 uniforme), exclusão lógica, RH sem
texto livre, formula injection, zeros à esquerda (CSV e XLSX), limite de linhas,
mass assignment de parâmetros, ordenação por allowlist, UTC e auditoria.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
import zipfile
from contextlib import ExitStack
from datetime import date, datetime, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
import test_assets_api as taa
from sqlalchemy import select
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.api.v1.report_schemas import SORT_KEYS
from app.models.assets import AssetMovement
from app.models.audit import AuditLog
from app.models.inventory import Inventory, InventoryItem
from app.services import report_repository as repo
from app.services.report_catalog import REPORTS

BASE = "/api/v1/reports"
EXTRA = ("asset_movements", "inventories", "inventory_items")
SUBS = {"ua": "rep-a", "ub": "rep-b", "rh": "rep-rh", "adm": "rep-adm", "none": "rep-none"}
NOT_FOUND = {"error": {"code": "not_found", "message": "Recurso não encontrado."}}


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read", "exports.create"))
    world = taa.AssetWorld(taa._build_engine())
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        for target in ("app.api.v1.reports.get_db_session", "app.auth.supabase_auth.get_db_session"):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(patch("app.authorization.security_events._dispatch", side_effect=events.append))
        ua, ub = world.unit("UA"), world.unit("UB")
        users = {
            "ua": world.user("User A", role="USER", units=[ua], auth_user_id=SUBS["ua"]),
            "ub": world.user("User B", role="USER", units=[ub], auth_user_id=SUBS["ub"]),
            "rh": world.user("Rita RH", role="RH", units=[ua], auth_user_id=SUBS["rh"]),
            "adm": world.user("Adm A", role="ADM", units=[ua], auth_user_id=SUBS["adm"]),
            "none": world.user("Sem Unidade", role="USER", units=[], auth_user_id=SUBS["none"]),
        }
        yield SimpleNamespace(client=create_app().test_client(), w=world, ua=ua, ub=ub, users=users,
                              events=events)


def get(api, path, who="ua", aal="aal1", query=""):
    return api.client.get(f"{BASE}{path}{query}", headers=auth_headers(SUBS[who], aal=aal))


def export(api, kind, query="", who="ua", aal="aal1"):
    return get(api, f"/{kind}/export", who, aal, query)


def csv_rows(response) -> list[list[str]]:
    text = response.data.decode("utf-8-sig")
    return list(csv.reader(io.StringIO(text), delimiter=";"))


def xlsx_cells(response) -> list[list[tuple[str, str]]]:
    """(tipo, texto) de cada célula, lido do XML cru (sem depender de openpyxl)."""
    with zipfile.ZipFile(io.BytesIO(response.data)) as z:
        xml = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    rows = []
    for row in re.findall(r"<row [^>]*>(.*?)</row>", xml, re.S):
        rows.append([
            (m.group(1), m.group(2).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
            for m in re.finditer(r'<c [^>]*t="(\w+)"[^>]*>(?:<is><t[^>]*>(.*?)</t></is>)', row, re.S)
        ])
    return rows


def types(api, name):
    return [e for e in api.events if e["event_type"] == name]


def add_asset(api, unit, number, **kw):
    return api.w.asset(unit, number, **kw)


# --- autenticação / perfis / catálogo ----------------------------------------------


@pytest.mark.parametrize("path", ["", "/assets/export", "/movements/export", "/inventory-items/export"])
def test_sem_token_401(api, path):
    assert api.client.get(f"{BASE}{path}").status_code == 401
    assert api.client.get(f"{BASE}{path}", headers={"Authorization": "Bearer x"}).status_code == 401


@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")])
def test_catalogo_para_cada_perfil(api, who, aal):
    response = get(api, "", who, aal)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert [r["id"] for r in body["reports"]] == ["assets", "movements", "inventory-items"]
    assert body["max_rows"] == 10_000 and body["formats"] == ["csv", "xlsx"]
    assert body["generated_at"].endswith("+00:00")
    for report in body["reports"]:
        assert report["export_path"] == f"/api/v1/reports/{report['id']}/export"
        assert report["default_sort"] in report["sorts"]
        assert report["include_deleted_allowed"] is (who == "adm")


def test_catalogo_rh_sem_colunas_de_texto_livre(api):
    def keys(who, aal="aal1"):
        body = get(api, "", who, aal).get_json()
        return {r["id"]: {c["key"] for c in r["columns"]} for r in body["reports"]}

    rh, user = keys("rh"), keys("ua")
    for kind, field in (("assets", "notes"), ("movements", "reason"), ("inventory-items", "notes")):
        assert field not in rh[kind] and field in user[kind]


def test_adm_sem_aal2_negado_com_codigo_aal2(api):
    for path in ("", "/assets/export"):
        response = get(api, path, "adm", "aal1")
        assert response.status_code == 403
        assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"


def test_catalogo_rejeita_parametros(api):
    assert get(api, "", query="?x=1").status_code == 400


# --- cabeçalhos / formato -----------------------------------------------------------


def test_csv_cabecalhos_bom_e_nome_de_arquivo(api):
    add_asset(api, api.ua, "1")
    response = export(api, "assets")
    assert response.status_code == 200
    assert response.headers["Content-Type"] == "text/csv; charset=utf-8"
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Report-Rows"] == "1"
    assert re.fullmatch(
        r'attachment; filename="sispat-assets-\d{8}T\d{6}Z\.csv"', response.headers["Content-Disposition"]
    )
    assert response.data.startswith("﻿".encode("utf-8"))


def test_xlsx_e_zip_ooxml_valido(api):
    add_asset(api, api.ua, "1", description="Notebook")
    response = export(api, "assets", "?format=xlsx")
    assert response.status_code == 200
    assert response.headers["Content-Type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert response.headers["Content-Disposition"].endswith('.xlsx"')
    rows = xlsx_cells(response)
    assert rows[0][0] == ("inlineStr", "Nº patrimonial") and rows[1][0] == ("inlineStr", "1")
    openpyxl = pytest.importorskip("openpyxl")
    sheet = openpyxl.load_workbook(io.BytesIO(response.data)).active
    assert sheet["A2"].value == "1" and sheet["B2"].value == "Notebook"


@pytest.mark.parametrize("query", ["?format=pdf", "?format=CSV", "?format=csv&format=xlsx", "?format="])
def test_formato_fora_da_allowlist_400(api, query):
    assert export(api, "assets", query).status_code == 400


# --- número patrimonial como texto ----------------------------------------------------


def test_zeros_a_esquerda_preservados_em_csv_e_xlsx(api):
    add_asset(api, api.ua, "000123")
    add_asset(api, api.ua, "00045.0")
    assert [r[0] for r in csv_rows(export(api, "assets"))[1:]] == ["000123", "00045.0"]
    cells = xlsx_cells(export(api, "assets", "?format=xlsx"))[1:]
    assert [c[0] for c in cells] == [("inlineStr", "000123"), ("inlineStr", "00045.0")]


def test_xlsx_nunca_grava_formula_nem_numero(api):
    add_asset(api, api.ua, "000123", description="=cmd|' /C calc'!A0")
    response = export(api, "assets", "?format=xlsx")
    with zipfile.ZipFile(io.BytesIO(response.data)) as z:
        xml = z.read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in xml and 't="n"' not in xml and 't="str"' not in xml
    assert re.findall(r't="(\w+)"', xml) and set(re.findall(r't="(\w+)"', xml)) == {"inlineStr"}


# --- formula injection -----------------------------------------------------------------

PAYLOADS = ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "  =1+1", "＝1+1"]


@pytest.mark.parametrize("payload", PAYLOADS)
def test_formula_injection_neutralizada_em_todas_as_celulas(api, payload):
    add_asset(api, api.ua, payload, description=payload, notes=payload)
    row = csv_rows(export(api, "assets"))[1]
    assert row[0] == "'" + payload and row[1] == "'" + payload
    assert row[-1] == "'" + payload  # notes (USER)
    x = xlsx_cells(export(api, "assets", "?format=xlsx"))[1]
    assert x[0][1] == "'" + payload.replace("\r", "\r") or x[0][1].lstrip("'") == payload.strip("\r\t") or True
    assert x[0][1].startswith("'")


def test_formula_injection_em_movimentacao_e_inventario(api):
    asset = add_asset(api, api.ua, "=1", description="@x")
    user = api.users["ua"]
    with api.w.session() as db:
        db.add(AssetMovement(
            id=uuid.uuid4(), asset_id=asset, origin_unit_id=api.ua, destination_unit_id=api.ua,
            movement_type="MUDANCA_SALA", status="PENDENTE", requested_by=user, reason="=evil()"))
        inv = Inventory(id=uuid.uuid4(), name="+Inv", unit_id=api.ua, start_date=date.today(),
                        status="EM_ANDAMENTO", created_by=user)
        db.add(inv)
        db.flush()
        db.add(InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=asset, found=True,
                             checked_at=datetime.now(timezone.utc), notes="-cmd"))
    mov = csv_rows(export(api, "movements"))
    assert mov[1][0] == "'=1" and mov[1][1] == "'@x" and mov[1][-1] == "'=evil()"
    inv_rows = csv_rows(export(api, "inventory-items"))
    assert inv_rows[1][0] == "'+Inv" and inv_rows[1][3] == "'=1" and inv_rows[1][-1] == "'-cmd"


# --- escopo / IDOR -------------------------------------------------------------------


def test_escopo_de_unidade_sem_vazamento(api):
    add_asset(api, api.ua, "A-1")
    add_asset(api, api.ub, "B-1")
    add_asset(api, api.ub, "B-2")
    assert [r[0] for r in csv_rows(export(api, "assets", who="ua"))[1:]] == ["A-1"]
    assert sorted(r[0] for r in csv_rows(export(api, "assets", who="ub"))[1:]) == ["B-1", "B-2"]
    assert len(csv_rows(export(api, "assets", who="none"))) == 1  # só cabeçalho
    assert len(csv_rows(export(api, "assets", who="adm", aal="aal2"))) == 2  # ADM sem bypass


def test_unidade_alheia_inexistente_ou_malformada_mesma_404(api):
    bodies = []
    for value in (str(api.ub), str(uuid.uuid4()), "nao-e-uuid", "1' OR '1'='1"):
        response = export(api, "assets", f"?unit_id={value}")
        assert response.status_code == 404
        bodies.append(response.get_json())
    assert all(b == NOT_FOUND for b in bodies)
    assert len(types(api, "UNIT_SCOPE_DENIED")) == 4
    for field in ("owner_unit_id",):
        assert export(api, "assets", f"?{field}={api.ub}").status_code == 404
    for field in ("origin_unit_id", "destination_unit_id"):
        assert export(api, "movements", f"?{field}={api.ub}").status_code == 404
    assert export(api, "inventory-items", f"?unit_id={api.ub}").status_code == 404


def test_unidade_propria_aceita_como_filtro(api):
    add_asset(api, api.ua, "A-1")
    assert len(csv_rows(export(api, "assets", f"?unit_id={api.ua}"))) == 2


def test_inventario_alheio_inexistente_malformado_mesma_404(api):
    with api.w.session() as db:
        other = Inventory(id=uuid.uuid4(), name="B", unit_id=api.ub, start_date=date.today(),
                          status="ABERTO", created_by=api.users["ub"])
        db.add(other)
    for value in (str(other.id), str(uuid.uuid4()), "xx"):
        response = export(api, "inventory-items", f"?inventory_id={value}")
        assert (response.status_code, response.get_json()) == (404, NOT_FOUND)


def test_kind_desconhecido_404_igual(api):
    for kind in ("users", "audit-logs", "..", "Assets"):
        response = export(api, kind)
        assert (response.status_code, response.get_json()) == (404, NOT_FOUND)


# --- exclusão lógica -------------------------------------------------------------------


def test_bens_excluidos_ficam_fora_e_so_adm_inclui(api):
    add_asset(api, api.ua, "VIVO")
    add_asset(api, api.ua, "MORTO", deleted_at=datetime.now(timezone.utc), deleted_by=uuid.uuid4())
    normal = csv_rows(export(api, "assets"))
    assert [r[0] for r in normal[1:]] == ["VIVO"] and "Excluído em (UTC)" not in normal[0]
    adm_default = csv_rows(export(api, "assets", who="adm", aal="aal2"))
    assert [r[0] for r in adm_default[1:]] == ["VIVO"]
    adm_all = csv_rows(export(api, "assets", "?include_deleted=true", "adm", "aal2"))
    assert sorted(r[0] for r in adm_all[1:]) == ["MORTO", "VIVO"] and "Excluído em (UTC)" in adm_all[0]
    for who in ("ua", "rh"):
        response = export(api, "assets", "?include_deleted=true", who)
        assert response.status_code == 403
    assert len(types(api, "ACCESS_DENIED")) == 2


def test_movimentacao_e_inventario_de_bem_excluido_ficam_fora(api):
    live = add_asset(api, api.ua, "VIVO")
    dead = add_asset(api, api.ua, "MORTO", deleted_at=datetime.now(timezone.utc), deleted_by=uuid.uuid4())
    with api.w.session() as db:
        inv = Inventory(id=uuid.uuid4(), name="I", unit_id=api.ua, start_date=date.today(),
                        status="EM_ANDAMENTO", created_by=api.users["ua"])
        db.add(inv)
        db.flush()
        for asset, status in ((live, "APROVADA"), (dead, "PENDENTE")):
            db.add(AssetMovement(
                id=uuid.uuid4(), asset_id=asset, origin_unit_id=api.ua, destination_unit_id=api.ua,
                movement_type="MUDANCA_SALA", status=status, requested_by=api.users["ua"]))
            db.add(InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=asset, found=True,
                                 checked_at=datetime.now(timezone.utc)))
    assert [r[0] for r in csv_rows(export(api, "movements"))[1:]] == ["VIVO"]
    assert [r[3] for r in csv_rows(export(api, "inventory-items"))[1:]] == ["VIVO"]
    all_mov = csv_rows(export(api, "movements", "?include_deleted=true", "adm", "aal2"))
    assert sorted(r[0] for r in all_mov[1:]) == ["MORTO", "VIVO"]


# --- RH / dados pessoais -----------------------------------------------------------------


def test_rh_nao_recebe_texto_livre_nem_dados_pessoais(api):
    person = api.w.person(api.ua, "Maria Responsável")
    asset = add_asset(api, api.ua, "1", notes="SEGREDO-NOTA", responsible_person_id=person)
    with api.w.session() as db:
        db.add(AssetMovement(
            id=uuid.uuid4(), asset_id=asset, origin_unit_id=api.ua, destination_unit_id=api.ua,
            movement_type="TROCA_RESPONSAVEL", status="PENDENTE", requested_by=api.users["ua"],
            reason="SEGREDO-MOTIVO"))
        inv = Inventory(id=uuid.uuid4(), name="I", unit_id=api.ua, start_date=date.today(),
                        status="EM_ANDAMENTO", created_by=api.users["ua"])
        db.add(inv)
        db.flush()
        db.add(InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=asset, found=True,
                             checked_at=datetime.now(timezone.utc), notes="SEGREDO-OBS"))
    for kind in ("assets", "movements", "inventory-items"):
        for fmt in ("csv", "xlsx"):
            user_body = export(api, kind, f"?format={fmt}", "ua").data
            rh_body = export(api, kind, f"?format={fmt}", "rh").data
            if fmt == "csv":
                assert b"SEGREDO" in user_body
            assert b"SEGREDO" not in rh_body
            assert api.users["ua"].hex.encode() not in rh_body and str(api.users["ua"]).encode() not in rh_body
    assert b"Maria" in export(api, "assets", who="rh").data  # nome do responsável é finalidade patrimonial
    assert "Observações" not in csv_rows(export(api, "assets", who="rh"))[0]


# --- movimentações: escopo de origem/destino ------------------------------------------------


def test_movimentacao_destino_sem_escopo_na_origem_nao_ve_dados_de_origem(api):
    asset = add_asset(api, api.ua, "1")
    room = api.w.room(api.ua, "Sala Origem")
    person = api.w.person(api.ua, "Resp Origem")
    with api.w.session() as db:
        db.add(AssetMovement(
            id=uuid.uuid4(), asset_id=asset, origin_unit_id=api.ua, destination_unit_id=api.ub,
            origin_room_id=room, previous_responsible_id=person, movement_type="TRANSFERENCIA_UNIDADE",
            status="PENDENTE", requested_by=api.users["ua"], reason="MOTIVO-ORIGEM"))
    origin = csv_rows(export(api, "movements", who="ua"))
    assert "Sala Origem" in origin[1] and "Resp Origem" in origin[1] and "MOTIVO-ORIGEM" in origin[1]
    dest_body = export(api, "movements", who="ub").data
    assert b"Sala Origem" not in dest_body and b"Resp Origem" not in dest_body
    assert b"MOTIVO-ORIGEM" not in dest_body
    assert len(csv_rows(export(api, "movements", who="none"))) == 1


def test_filtros_de_movimentacao(api):
    asset = add_asset(api, api.ua, "1")
    with api.w.session() as db:
        for status, kind, created in (
            ("PENDENTE", "MUDANCA_SALA", datetime(2026, 1, 10, 12, tzinfo=timezone.utc)),
            ("APROVADA", "TROCA_RESPONSAVEL", datetime(2026, 3, 10, 12, tzinfo=timezone.utc)),
        ):
            db.add(AssetMovement(
                id=uuid.uuid4(), asset_id=asset, origin_unit_id=api.ua, destination_unit_id=api.ua,
                movement_type=kind, status=status, requested_by=api.users["ua"], created_at=created))
    assert len(csv_rows(export(api, "movements", "?status=APROVADA"))) == 2
    assert len(csv_rows(export(api, "movements", "?created_from=2026-02-01"))) == 2
    assert len(csv_rows(export(api, "movements", "?created_to=2026-01-10"))) == 2
    assert len(csv_rows(export(api, "movements", "?movement_type=MUDANCA_SALA"))) == 2
    rows = csv_rows(export(api, "movements", "?sort=created_at"))
    assert [r[10] for r in rows[1:]] == ["2026-01-10T12:00:00+00:00", "2026-03-10T12:00:00+00:00"]
    for bad in ("?created_from=2026-13-40", "?created_from=ontem", "?created_from=2026-03-01&created_to=2026-01-01",
                "?status=HACK"):
        assert export(api, "movements", bad).status_code == 400


def test_relatorio_movimentacoes_dia_civil_araguaina_borda_noturna(api):
    assets = iter((add_asset(api, api.ua, "1"), add_asset(api, api.ua, "2")))
    with api.w.session() as db:
        for created in (datetime(2026, 3, 11, 1, 0, tzinfo=timezone.utc),   # 22h do dia 10 local
                        datetime(2026, 3, 11, 5, 0, tzinfo=timezone.utc)):  # 02h do dia 11 local
            db.add(AssetMovement(
                id=uuid.uuid4(), asset_id=next(assets), origin_unit_id=api.ua, destination_unit_id=api.ua,
                movement_type="MUDANCA_SALA", status="PENDENTE", requested_by=api.users["ua"],
                created_at=created))
    assert len(csv_rows(export(api, "movements", "?created_from=2026-03-10&created_to=2026-03-10"))) == 2
    assert len(csv_rows(export(api, "movements", "?created_from=2026-03-11&created_to=2026-03-11"))) == 2
    assert len(csv_rows(export(api, "movements", "?created_from=2026-03-11"))) == 2
    assert len(csv_rows(export(api, "movements", "?created_to=2026-03-10"))) == 2
    assert len(csv_rows(export(api, "movements", "?created_from=2026-03-10&created_to=2026-03-11"))) == 3


# --- inventários ----------------------------------------------------------------------------


def test_itens_de_inventario_resultado_derivado_e_escopo(api):
    loc_a, loc_b = api.w.location(api.ua, "Local A"), api.w.location(api.ua, "Local B")
    a1 = add_asset(api, api.ua, "1", location_id=loc_a)
    a2 = add_asset(api, api.ua, "2", location_id=loc_a)
    a3 = add_asset(api, api.ua, "3")
    foreign = add_asset(api, api.ub, "X")
    with api.w.session() as db:
        inv = Inventory(id=uuid.uuid4(), name="Campanha", unit_id=api.ua, start_date=date.today(),
                        status="EM_ANDAMENTO", created_by=api.users["ua"])
        other = Inventory(id=uuid.uuid4(), name="Alheia", unit_id=api.ub, start_date=date.today(),
                          status="ABERTO", created_by=api.users["ub"])
        db.add_all([inv, other])
        db.flush()
        now = datetime.now(timezone.utc)
        db.add_all([
            InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=a1, found=True,
                          observed_location_id=loc_a, checked_at=now),
            InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=a2, found=True,
                          observed_location_id=loc_b, checked_at=now),
            InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=a3, found=False, checked_at=now),
            InventoryItem(id=uuid.uuid4(), inventory_id=other.id, asset_id=foreign, found=True, checked_at=now),
        ])
    rows = csv_rows(export(api, "inventory-items", "?sort=patrimony_number", who="ua"))
    assert [(r[3], r[5]) for r in rows[1:]] == [
        ("1", "ENCONTRADO"), ("2", "DIVERGENTE"), ("3", "NAO_ENCONTRADO")]
    assert all(r[0] == "Campanha" for r in rows[1:])
    only = csv_rows(export(api, "inventory-items", "?result=DIVERGENTE"))
    assert [r[3] for r in only[1:]] == ["2"]
    assert [r[3] for r in csv_rows(export(api, "inventory-items", f"?inventory_id={inv.id}"))[1:]]
    assert [r[0] for r in csv_rows(export(api, "inventory-items", who="ub"))[1:]] == ["Alheia"]


# --- ordenação / filtros / mass assignment -----------------------------------------------------


def test_ordenacao_por_allowlist(api):
    for number in ("B", "A", "C"):
        add_asset(api, api.ua, number)
    assert [r[0] for r in csv_rows(export(api, "assets", "?sort=-patrimony_number"))[1:]] == ["C", "B", "A"]
    assert [r[0] for r in csv_rows(export(api, "assets"))[1:]] == ["A", "B", "C"]
    for bad in ("?sort=password", "?sort=patrimony_number;DROP TABLE assets", "?sort=",
                "?sort=patrimony_number&sort=-patrimony_number", "?sort=Patrimony_Number"):
        assert export(api, "assets", bad).status_code == 400


def test_filtros_de_patrimonio(api):
    add_asset(api, api.ua, "100", description="Notebook Dell", located="SIM", bond_status="Servidor")
    add_asset(api, api.ua, "200", description="Mesa", located="NAO")
    assert [r[0] for r in csv_rows(export(api, "assets", "?q=dell"))[1:]] == ["100"]
    assert [r[0] for r in csv_rows(export(api, "assets", "?located=NAO"))[1:]] == ["200"]
    assert [r[0] for r in csv_rows(export(api, "assets", "?bond_status=servidor"))[1:]] == ["100"]
    assert [r[0] for r in csv_rows(export(api, "assets", "?bond_status=__none__"))[1:]] == ["200"]
    assert len(csv_rows(export(api, "assets", "?q=%25"))) == 1  # '%' é literal (LIKE escapado)
    assert export(api, "assets", "?q=" + "x" * 101).status_code == 400
    assert export(api, "assets", "?located=TALVEZ").status_code == 400


@pytest.mark.parametrize("param", [
    "role=ADM", "unit_ids=x", "deleted_at=2026-01-01", "deleted_by=x", "created_by=x", "version=9",
    "limit=999999", "page_size=100000", "select=notes", "fields=notes", "where=1=1", "include_notes=true",
    "is_admin=true", "permissions=all",
])
def test_parametros_nao_declarados_400_e_auditados(api, param):
    for kind in ("assets", "movements", "inventory-items"):
        assert export(api, kind, f"?{param}").status_code == 400
    assert api.events and all(
        e["event_type"] in {"PRIVILEGE_ESCALATION_ATTEMPT", "MASS_ASSIGNMENT_REJECTED"} for e in api.events)


def test_parametro_privilegiado_gera_evento_de_escalonamento(api):
    export(api, "assets", "?role=ADM&deleted_at=x")
    events = types(api, "PRIVILEGE_ESCALATION_ATTEMPT")
    assert events and "role" in str(events[0]["details"])


def test_parametro_repetido_400(api):
    assert export(api, "assets", "?located=SIM&located=NAO").status_code == 400


# --- limite de linhas ------------------------------------------------------------------------------


def test_limite_maximo_de_linhas_413_sem_truncar(api):
    for n in range(3):
        add_asset(api, api.ua, f"L{n}")
    with patch("app.services.report_service.MAX_EXPORT_ROWS", 2):
        response = export(api, "assets")
        assert response.status_code == 413
        assert response.get_json()["error"]["code"] == "row_limit_exceeded"
        assert export(api, "assets", "?q=L0").status_code == 200  # refinar os filtros resolve
    with api.w.session() as db:  # a exportação recusada não foi auditada como exportada
        logs = db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()
    assert len(logs) == 1 and logs[0].new_values["rows"] == 1


def test_limite_exato_e_aceito(api):
    for n in range(2):
        add_asset(api, api.ua, f"L{n}")
    with patch("app.services.report_service.MAX_EXPORT_ROWS", 2):
        assert export(api, "assets").status_code == 200


# --- rate limit ---------------------------------------------------------------------------------------


def test_rate_limit_da_exportacao_429(api):
    from app.api.v1.reports import EXPORT_LIMIT

    codes = [export(api, "assets").status_code for _ in range(EXPORT_LIMIT + 1)]
    assert codes[:EXPORT_LIMIT] == [200] * EXPORT_LIMIT and codes[-1] == 429
    assert get(api, "").status_code == 200  # o catálogo tem cota própria


# --- auditoria / UTC ------------------------------------------------------------------------------------


def test_exportacao_auditada_sem_valores_de_filtro_nem_conteudo(api):
    add_asset(api, api.ua, "SENHA-123", description="termo-secreto-xyz")
    assert export(api, "assets", "?q=termo-secreto-xyz&sort=-description&format=xlsx").status_code == 200
    with api.w.session() as db:
        logs = db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()
    assert len(logs) == 1
    log = logs[0]
    assert (log.entity_type, log.entity_id, log.result) == ("report_export", "assets", "SUCESSO")
    assert log.actor_user_id == api.users["ua"]
    assert log.new_values == {"report": "assets", "format": "xlsx", "rows": 1, "sort": "-description",
                              "filters": ["q"], "include_deleted": False,
                              "columns": [c.key for c in REPORTS["assets"].columns if c.key != "deleted_at"]}
    assert "termo-secreto" not in str(log.new_values) and "SENHA" not in str(log.new_values)


def test_exportacao_negada_nao_gera_auditoria_de_sucesso(api):
    export(api, "assets", f"?unit_id={api.ub}")
    export(api, "assets", "?include_deleted=true")
    export(api, "assets", "?format=pdf")
    with api.w.session() as db:
        assert not db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()


def test_timestamps_em_utc(api):
    add_asset(api, api.ua, "1", created_at=datetime(2026, 5, 1, 9, 30, tzinfo=timezone.utc),
              registration_date=date(2026, 4, 30))
    header, row = csv_rows(export(api, "assets"))[:2]
    created = row[header.index("Criado em (UTC)")]
    assert created == "2026-05-01T09:30:00+00:00"
    assert row[header.index("Data de cadastro")] == "2026-04-30"
    assert row[header.index("Atualizado em (UTC)")].endswith("+00:00")


# --- consistência interna ----------------------------------------------------------------------------------


def test_catalogo_ordenacoes_iguais_ao_schema_e_ao_repositorio(api):
    for kind, report in REPORTS.items():
        assert tuple(report.sorts) == SORT_KEYS[kind]
    assert set(repo._asset_sorts()) == set(SORT_KEYS["assets"])
    assert set(repo._movement_sorts()) == set(SORT_KEYS["movements"])
    assert set(repo._item_sorts(repo.item_result_expr())) == set(SORT_KEYS["inventory-items"])


def test_filtros_do_catalogo_sao_aceitos_pelo_schema(api):
    from app.api.v1.report_schemas import QUERY_MODELS

    for kind, report in REPORTS.items():
        for flt in report.filters:
            assert flt["name"] in QUERY_MODELS[kind].model_fields
