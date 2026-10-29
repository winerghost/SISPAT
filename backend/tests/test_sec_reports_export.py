"""Regressão de segurança das exportações `/api/v1/reports` (revisão AppSec 2026-10-21).

Complementa `test_reports_api.py` (que tem uma asserção fraca de XLSX: `... or True`).
Reutiliza o mundo/fixture `api` daquele módulo (SQLite + auth real, sem rede).
"""
from __future__ import annotations

import io
import logging
import re
import uuid
import zipfile
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import select
from test_reports_api import (  # noqa: F401  (api = fixture)
    BASE,
    NOT_FOUND,
    SUBS,
    add_asset,
    api,
    csv_rows,
    export,
    get,
    types,
    xlsx_cells,
)
from test_user_admin_db import auth_headers

from app.models.assets import AssetMovement
from app.models.audit import AuditLog
from app.models.inventory import Inventory, InventoryItem

TRIGGERS = ("=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠")
PAYLOADS = ["=1+1", "+1", "-1", "@SUM(1)", "\t=1", "  =1", '"=1', "＝1+1", "=cmd|' /C calc'!A0"]


def _dangerous(text: str) -> bool:
    if text.startswith("'"):  # prefixo de neutralização aplicado por csv_safety
        return False
    stripped = text.lstrip(" \"' ")
    return bool(text) and (text[0] in TRIGGERS or (bool(stripped) and stripped[0] in TRIGGERS))


def _seed_all_kinds(api, payload: str):
    asset = add_asset(api, api.ua, payload, description=payload, notes=payload)
    with api.w.session() as db:
        db.add(AssetMovement(
            id=uuid.uuid4(), asset_id=asset, origin_unit_id=api.ua, destination_unit_id=api.ua,
            movement_type="MUDANCA_SALA", status="PENDENTE", requested_by=api.users["ua"], reason=payload))
        inv = Inventory(id=uuid.uuid4(), name=payload, unit_id=api.ua, start_date=date.today(),
                        status="EM_ANDAMENTO", created_by=api.users["ua"])
        db.add(inv)
        db.flush()
        db.add(InventoryItem(id=uuid.uuid4(), inventory_id=inv.id, asset_id=asset, found=True,
                             checked_at=datetime.now(timezone.utc), notes=payload))


@pytest.mark.parametrize("payload", PAYLOADS)
@pytest.mark.parametrize("kind", ["assets", "movements", "inventory-items"])
def test_sec_nenhuma_celula_perigosa_em_csv_nem_xlsx(api, payload, kind):
    _seed_all_kinds(api, payload)
    csv_all = [c for r in csv_rows(export(api, kind)) for c in r]
    xlsx_all = [t for r in xlsx_cells(export(api, kind, "?format=xlsx")) for _, t in r]
    assert csv_all and xlsx_all
    assert not [c for c in csv_all if _dangerous(c)]
    assert not [c for c in xlsx_all if _dangerous(c)]


def test_sec_xlsx_xml_injection_nao_cria_formula(api):
    evil = 'x</t></is></c><c r="Z9"><f>1+1</f></c><is><t>'
    add_asset(api, api.ua, "1", description=evil + "\x00\x1f")
    response = export(api, "assets", "?format=xlsx")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.data)) as z:
        xml = z.read("xl/worksheets/sheet1.xml").decode()
        assert set(z.namelist()) == {
            "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"}  # sem macros/vbaProject/externos
    import xml.etree.ElementTree as ET

    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    root = ET.fromstring(xml)  # XML bem formado: a carga ficou como TEXTO escapado
    assert not list(root.iter(ns + "f"))
    assert {c.get("r") for c in root.iter(ns + "c")}.isdisjoint({"Z9"})
    assert {c.get("t") for c in root.iter(ns + "c")} == {"inlineStr"}
    assert "\x00" not in xml


@pytest.mark.parametrize("kind", ["movements", "inventory-items"])
@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1")])
def test_sec_include_deleted_negado_para_nao_adm_em_todos_os_tipos(api, kind, who, aal):
    response = export(api, kind, "?include_deleted=true", who, aal)
    assert response.status_code == 403
    assert types(api, "ACCESS_DENIED")
    with api.w.session() as db:
        assert not db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()


@pytest.mark.parametrize("kind", ["assets", "movements", "inventory-items"])
def test_sec_adm_sem_aal2_negado_e_nao_exporta(api, kind):
    add_asset(api, api.ua, "1")
    for query in ("", "?include_deleted=true", "?format=xlsx"):
        response = export(api, kind, query, "adm", "aal1")
        assert response.status_code == 403 and response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    with api.w.session() as db:
        assert not db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()


def test_sec_metodos_nao_get_nao_exportam(api):
    headers = auth_headers(SUBS["ua"])
    for method in ("post", "put", "patch", "delete"):
        response = getattr(api.client, method)(f"{BASE}/assets/export", headers=headers, json={})
        assert response.status_code in {404, 405}
        assert "patrimonial".encode() not in response.data


def test_sec_token_na_query_string_nao_autentica(api):
    add_asset(api, api.ua, "1")
    path = f"{BASE}/assets/export"
    for param in ("access_token", "token", "jwt", "Authorization"):
        response = api.client.get(f"{path}?{param}=abc")
        assert response.status_code in {400, 401}
        assert b"patrimonial" not in response.data


def test_sec_respostas_de_erro_nao_ecoam_entrada_nem_segredos(api, caplog):
    marker = "MARCADOR-<script>alert(1)</script>"
    caplog.set_level(logging.DEBUG)
    bodies = []
    for kind, query in (
        ("assets", f"?unit_id={marker}"), ("assets", f"?located={marker}"), ("assets", f"?sort={marker}"),
        ("movements", f"?status={marker}"), (marker, ""),
        ("inventory-items", f"?inventory_id={marker}"),
    ):
        response = export(api, kind, query)
        assert response.status_code in {400, 404}
        bodies.append(response.get_data(as_text=True))
    token = auth_headers(SUBS["ua"])["Authorization"]
    for body in bodies:
        assert "MARCADOR" not in body and "<script>" not in body
        assert "Traceback" not in body and "sqlalchemy" not in body.lower() and ".py" not in body
    assert token.split()[-1] not in caplog.text


def test_sec_evento_de_escopo_nao_grava_valor_do_filtro_nem_token(api):
    foreign = str(api.ub)
    export(api, "assets", f"?unit_id={foreign}")
    events = types(api, "UNIT_SCOPE_DENIED")
    assert events
    dump = str(events)
    assert foreign not in dump and auth_headers(SUBS["ua"])["Authorization"].split()[-1] not in dump


def test_sec_filtros_de_sala_e_responsavel_alheios_nao_vazam(api):
    """Sala/responsável de outra unidade => MESMA 404 de um id inexistente (sem oráculo)."""
    room_b = api.w.room(api.ub, "Sala B")
    person_b = api.w.person(api.ub, "Pessoa B")
    add_asset(api, api.ub, "B-1", room_id=room_b, responsible_person_id=person_b)
    add_asset(api, api.ua, "A-1")
    ghost = uuid.uuid4()
    for query in (f"?room_id={room_b}", f"?responsible_person_id={person_b}",
                  f"?room_id={ghost}", f"?responsible_person_id={ghost}"):
        response = export(api, "assets", query, "ua")
        assert response.status_code == 404
        assert response.get_json() == NOT_FOUND
        assert b"B-1" not in response.data and b"Pessoa B" not in response.data
    assert types(api, "UNIT_SCOPE_DENIED")
    dump = str(types(api, "UNIT_SCOPE_DENIED"))
    assert str(room_b) not in dump and str(person_b) not in dump


def test_sec_cabecalhos_do_arquivo_sem_cookie_e_nome_sem_entrada_do_usuario(api):
    add_asset(api, api.ua, "1")
    response = export(api, "assets", "?q=../../etc/passwd&format=xlsx")
    assert response.status_code == 200
    assert "Set-Cookie" not in response.headers
    assert re.fullmatch(r'attachment; filename="sispat-assets-\d{8}T\d{6}Z\.xlsx"',
                        response.headers["Content-Disposition"])
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "no-store" in response.headers["Cache-Control"]


def test_sec_auditoria_da_exportacao_e_por_ator_e_sem_pii(api):
    person = api.w.person(api.ua, "Fulano Sigiloso")
    add_asset(api, api.ua, "PAT-SECRETO", description="desc-sigilosa", notes="obs-sigilosa",
              responsible_person_id=person)
    export(api, "assets", "?q=sigilosa&unit_id=" + str(api.ua), who="rh")
    with api.w.session() as db:
        logs = db.execute(select(AuditLog).where(AuditLog.operation == "REPORT_EXPORTED")).scalars().all()
    assert len(logs) == 1 and logs[0].actor_user_id == api.users["rh"]
    dump = str(logs[0].new_values) + str(logs[0].previous_values) + str(logs[0].entity_id)
    for secret in ("PAT-SECRETO", "sigilosa", "Fulano", str(api.ua)):
        assert secret not in dump
    assert get(api, "").status_code == 200  # catálogo segue acessível; não é exportação
