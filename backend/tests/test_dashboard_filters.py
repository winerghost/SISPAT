"""Filtros do dashboard (`DashboardFilters`) e painéis novos.

SQLite com o schema real, `require_auth` real, sem rede. Cobre cada filtro e
combinações, validação (400 sem eco), período, escopo (alheio = inexistente),
paridade com `GET /api/v1/assets`, top N + resto exato, `__none__`, inventário
pela conferência mais recente, movimentação pendente, RH/USER no escopo e
rótulos hostis (sala/vínculo) devolvidos como texto JSON.
"""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlencode

import pytest
import test_assets_api as taa
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.api.v1 import dashboard as dashboard_api
from app.api.v1.catalog_http import LIST_LIMIT
from app.models.assets import AssetMovement
from app.models.inventory import Inventory, InventoryItem
from app.models.units import UnitAlias
from app.services import dashboard_service as ds

BASE = "/api/v1/dashboard"
EXTRA = ("unit_aliases", "asset_movements", "inventories", "inventory_items")
SUBS = {"ua": "flt-a", "ub": "flt-b", "rh": "flt-rh", "adm": "flt-adm", "uab": "flt-ab"}
ALL = (
    "resumo", "por-unidade", "por-situacao", "aquisicoes-mensais", "localizacao-por-unidade",
    "por-vinculo", "pendencias-cadastro", "por-sala", "inventario", "tipos",
)


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read",))
    world = taa.AssetWorld(taa._build_engine())
    with ExitStack() as stack:
        for target in (
            "app.api.v1.dashboard.get_db_session",
            "app.api.v1.assets.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(patch("app.authorization.security_events._dispatch"))
        ua, ub = world.unit("UA"), world.unit("UB")
        world.user("User A", role="USER", units=[ua], auth_user_id=SUBS["ua"])
        world.user("User B", role="USER", units=[ub], auth_user_id=SUBS["ub"])
        world.user("Rita RH", role="RH", units=[ua], auth_user_id=SUBS["rh"])
        world.user("Adm A", role="ADM", units=[ua], auth_user_id=SUBS["adm"])
        world.user("User AB", role="USER", units=[ua, ub], auth_user_id=SUBS["uab"])
        yield SimpleNamespace(client=create_app().test_client(), world=world, ua=ua, ub=ub)


def get(api, path, who="ua", aal="aal1", **params):
    query = f"?{urlencode(params)}" if params else ""
    return api.client.get(f"{BASE}/{path}{query}", headers=auth_headers(SUBS[who], aal=aal))


def total(api, who="ua", **params) -> int:
    response = get(api, "resumo", who, **params)
    assert response.status_code == 200, response.get_json()
    return response.get_json()["total_bens"]


def asset(api, unit, number, **kw):
    kw.setdefault("description", "(1) NOTEBOOK X")
    return api.world.asset(unit, number, **kw)


def put(api, *rows):
    with api.world.session() as db:
        for row in rows:
            db.add(row)


def inventory(api, unit, *, status="CONCLUIDO"):
    inv_id = uuid.uuid4()
    put(api, Inventory(id=inv_id, name="i", unit_id=unit, start_date=date.today(), status=status,
                       created_by=uuid.uuid4()))
    return inv_id


def check(api, inv_id, asset_id, *, found, when):
    put(api, InventoryItem(id=uuid.uuid4(), inventory_id=inv_id, asset_id=asset_id, found=found,
                           checked_at=when, checked_by=uuid.uuid4()))


def movement(api, asset_id, status, unit):
    put(api, AssetMovement(id=uuid.uuid4(), asset_id=asset_id, origin_unit_id=unit,
                           destination_unit_id=unit, movement_type="TRANSFERENCIA", status=status,
                           requested_by=uuid.uuid4()))


# --- cada filtro ------------------------------------------------------------------


def test_filtros_de_igualdade_e_presenca(api):
    room = api.world.room(api.ua, "Sala 1")
    person = api.world.person(api.ua, "Fulano")
    asset(api, api.ua, "1", room_id=room, responsible_person_id=person, located="SIM")
    asset(api, api.ua, "2", located="NAO", owner_unit_id=api.ua)
    asset(api, api.ua, "3", located="DESCONHECIDO", room_id=room)
    assert total(api) == 3
    assert total(api, unit_id=api.ua) == 3
    assert total(api, owner_unit_id=api.ua) == 1
    assert total(api, room_id=room) == 2
    assert total(api, responsible_person_id=person) == 1
    assert total(api, has_room="true") == 2 and total(api, has_room="false") == 1
    assert total(api, has_responsible="true") == 1 and total(api, has_responsible="false") == 2
    assert total(api, located="SIM") == 1
    assert total(api, located="NAO") == 1
    assert total(api, located="DESCONHECIDO") == 1


def test_filtro_vinculo_sem_caixa_e_none(api):
    asset(api, api.ua, "1", bond_status="Ocioso")
    asset(api, api.ua, "2", bond_status="OCIOSO")
    asset(api, api.ua, "3", bond_status="Servidor")
    asset(api, api.ua, "4")
    assert total(api, bond_status="ocioso") == 2
    assert total(api, bond_status="  Ocioso ") == 2
    assert total(api, bond_status="Servi") == 0
    assert total(api, bond_status="__none__") == 1


def test_filtro_tipo_em_todos_os_endpoints(api):
    asset(api, api.ua, "1", description="(1) Notebook Dell", located="SIM",
          registration_date=date.today(), bond_status="Servidor")
    asset(api, api.ua, "2", description="(2) NOTEBOOK HP", located="NAO", registration_date=date.today())
    asset(api, api.ua, "3", description="(3) Mesa", located="SIM", registration_date=date.today())
    asset(api, api.ua, "4", description=None, located="SIM", registration_date=date.today())
    assert total(api, tipo="NOTEBOOK") == 2
    assert total(api, tipo="MESA") == 1
    assert total(api, tipo="NAO_CLASSIFICADO") == 1
    assert total(api, tipo="INEXISTENTE") == 0
    unidades = get(api, "por-unidade", tipo="NOTEBOOK").get_json()
    assert unidades == [{"unidade": "UA", "total": 2, "tipos": {"NOTEBOOK": 2}}]
    assert get(api, "por-situacao", tipo="NOTEBOOK").get_json() == [
        {"id": "Localizado", "value": 1}, {"id": "Não localizado", "value": 1}]
    series = get(api, "aquisicoes-mensais", tipo="MESA", meses=2).get_json()
    assert [s["id"] for s in series] == ["MESA"]
    loc = get(api, "localizacao-por-unidade", tipo="NOTEBOOK").get_json()
    assert loc == [{"unidade": "UA", "sim": 1, "nao": 1, "desconhecido": 0, "total": 2}]
    assert get(api, "por-vinculo", tipo="NOTEBOOK").get_json() == [
        {"id": "Servidor", "label": "Servidor", "value": 1},
        {"id": "__none__", "label": "Sem vínculo", "value": 1}]
    assert get(api, "pendencias-cadastro", tipo="NOTEBOOK").get_json()["nao_localizados"] == 1
    assert get(api, "por-sala", tipo="NOTEBOOK").get_json() == [
        {"id": "__none__", "label": "Sem sala", "value": 2}]
    assert get(api, "inventario", tipo="NOTEBOOK").get_json()["nao_conferidos"] == 2


def test_tipos_ignora_o_proprio_tipo_e_respeita_os_demais(api):
    asset(api, api.ua, "1", description="(1) Notebook", located="SIM")
    asset(api, api.ua, "2", description="(1) Notebook", located="NAO")
    asset(api, api.ua, "3", description="(2) Mesa", located="SIM")
    asset(api, api.ub, "4", description="(2) Cadeira", located="SIM")
    expected = [{"value": "NOTEBOOK", "count": 2}, {"value": "MESA", "count": 1}]
    assert get(api, "tipos").get_json() == expected
    assert get(api, "tipos", tipo="MESA").get_json() == expected
    assert get(api, "tipos", located="SIM").get_json() == [
        {"value": "MESA", "count": 1}, {"value": "NOTEBOOK", "count": 1}]


def test_tipos_top_50(api):
    for i in range(55):
        for k in range(1 + (i < 5)):
            asset(api, api.ua, f"T{i}-{k}", description=f"(1) TIPO{i:02d} x")
    data = get(api, "tipos").get_json()
    assert len(data) == ds.TOP_TIPOS == 50
    assert [d["value"] for d in data[:5]] == [f"TIPO{i:02d}" for i in range(5)]
    assert all(d["count"] == 2 for d in data[:5])


def test_periodo_por_registration_date(api):
    asset(api, api.ua, "1", registration_date=date(2024, 1, 10))
    asset(api, api.ua, "2", registration_date=date(2024, 6, 30))
    asset(api, api.ua, "3", registration_date=date(2025, 1, 1))
    asset(api, api.ua, "4", registration_date=None)
    assert total(api, registrado_desde="2024-06-30") == 2
    assert total(api, registrado_ate="2024-06-30") == 2
    assert total(api, registrado_desde="2024-01-10", registrado_ate="2024-06-30") == 2
    assert total(api, registrado_desde="2024-02-01", registrado_ate="2024-02-01") == 0
    # janela de exatamente 5 anos é aceita
    assert get(api, "resumo", registrado_desde="2020-02-29", registrado_ate="2025-02-28").status_code == 200


def test_inventario_pela_conferencia_mais_recente(api):
    now = datetime.now(timezone.utc)
    nunca = asset(api, api.ua, "nunca")
    achado = asset(api, api.ua, "achado")
    perdido = asset(api, api.ua, "perdido")  # achado antes, NÃO achado na mais recente
    cancelado = asset(api, api.ua, "cancelado")  # só conferência de inventário cancelado
    nulo = asset(api, api.ua, "nulo")  # conferido com found nulo
    old, new, canc = inventory(api, api.ua), inventory(api, api.ua), inventory(api, api.ua, status="CANCELADO")
    check(api, old, achado, found=False, when=now - timedelta(days=30))
    check(api, new, achado, found=True, when=now - timedelta(days=1))
    check(api, old, perdido, found=True, when=now - timedelta(days=30))
    check(api, new, perdido, found=False, when=now - timedelta(days=1))
    check(api, canc, cancelado, found=True, when=now)
    check(api, new, nulo, found=None, when=now)
    assert get(api, "inventario").get_json() == {
        "conferidos": 3, "nao_conferidos": 2, "encontrados": 1, "nao_encontrados": 1}
    assert total(api, inventario="conferido") == 3
    assert total(api, inventario="nao_conferido") == 2  # nunca + cancelado
    assert total(api, inventario="encontrado") == 1
    assert total(api, inventario="nao_encontrado") == 1
    assert get(api, "inventario", inventario="encontrado").get_json() == {
        "conferidos": 1, "nao_conferidos": 0, "encontrados": 1, "nao_encontrados": 0}
    del nunca, cancelado, nulo


def test_movimentacao_pendente(api):
    a1 = asset(api, api.ua, "1")
    a2 = asset(api, api.ua, "2")
    asset(api, api.ua, "3")
    movement(api, a1, "PENDENTE", api.ua)
    movement(api, a2, "CONCLUIDA", api.ua)
    assert total(api, movimentacao_pendente="true") == 1
    assert total(api, movimentacao_pendente="false") == 2
    body = get(api, "resumo", movimentacao_pendente="false").get_json()
    assert body["movimentacoes_pendentes"] == 0  # com filtro: só dos bens filtrados
    assert get(api, "resumo").get_json()["movimentacoes_pendentes"] == 1


def test_combinacao_e_logico_e_filtros_aplicados(api):
    room = api.world.room(api.ua, "Sala 1")
    asset(api, api.ua, "1", located="NAO", bond_status="Ocioso")
    asset(api, api.ua, "2", located="NAO", bond_status="Ocioso", room_id=room)
    asset(api, api.ua, "3", located="SIM", bond_status="Ocioso")
    asset(api, api.ua, "4", located="NAO", bond_status="Servidor")
    body = get(api, "resumo", located="NAO", bond_status="ocioso", has_room="false").get_json()
    assert body["total_bens"] == 1
    assert body["filtros_aplicados"] == ["has_room", "located", "bond_status"]
    assert "ocioso" not in str(body["filtros_aplicados"]).lower()
    assert get(api, "resumo").get_json()["filtros_aplicados"] == []


def test_inventarios_abertos_respeitam_so_unit_id(api):
    inventory(api, api.ua, status="ABERTO")
    assert get(api, "resumo").get_json()["inventarios_abertos"] == 1
    assert get(api, "resumo", unit_id=api.ub).get_json()["inventarios_abertos"] == 0
    assert get(api, "resumo", unit_id=api.ua).get_json()["inventarios_abertos"] == 1


# --- validação ----------------------------------------------------------------------

INVALID = [
    {"unit_id": "nao-uuid"}, {"owner_unit_id": "1"}, {"room_id": "' OR 1=1"},
    {"responsible_person_id": "x"}, {"has_room": "sim"}, {"has_responsible": "1"},
    {"located": "sim"}, {"located": "TALVEZ"}, {"bond_status": "a\x00b"}, {"bond_status": "   "},
    {"bond_status": "x" * 65}, {"tipo": "notebook"}, {"tipo": "__OUTROS__"}, {"tipo": "OUTROS"},
    {"tipo": "A" * 41}, {"tipo": "NOTE BOOK"}, {"tipo": "<script>"},
    {"registrado_desde": "10/01/2024"}, {"registrado_ate": "2024-13-01"},
    {"registrado_desde": "1700000000"}, {"registrado_desde": "1899-12-31"},
    {"registrado_desde": "2024-01-01T00:00"},
    {"registrado_desde": "2024-06-01", "registrado_ate": "2024-05-31"},
    {"registrado_desde": "2019-01-01", "registrado_ate": "2024-01-02"},
    {"inventario": "sim"}, {"movimentacao_pendente": "1"}, {"meses": "3"}, {"foo": "1"},
]


@pytest.mark.parametrize("params", INVALID)
@pytest.mark.parametrize("path", ["resumo", "por-vinculo", "tipos"])
def test_filtro_invalido_400_sem_eco(api, path, params):
    response = get(api, path, **params)
    assert response.status_code == 400
    body = response.get_json()
    assert body["error"]["code"] == "validation_error"
    text = response.get_data(as_text=True)
    for value in params.values():
        if len(value) > 3:
            assert value not in text


@pytest.mark.parametrize("path", ALL)
def test_todos_endpoints_validam_filtros(api, path):
    assert get(api, path, located="X").status_code == 400
    assert get(api, path, located="SIM").status_code == 200
    response = api.client.get(f"{BASE}/{path}?located=SIM&located=NAO", headers=auth_headers(SUBS["ua"]))
    assert response.status_code == 400


def test_aquisicoes_aceita_meses_e_filtros(api):
    asset(api, api.ua, "1", description="(1) MESA", registration_date=date.today(), located="SIM")
    asset(api, api.ua, "2", description="(1) MESA", registration_date=date.today(), located="NAO")
    data = get(api, "aquisicoes-mensais", meses=2, located="NAO").get_json()
    assert data[0]["id"] == "MESA" and data[0]["data"][-1]["y"] == 1


# --- escopo -------------------------------------------------------------------------


@pytest.mark.parametrize("params", [
    {"bond_status": "SegredoB"}, {"tipo": "SEGREDOB"}, {"located": "NAO"},
])
def test_valor_so_existente_em_unidade_alheia_igual_a_inexistente(api, params):
    asset(api, api.ua, "A1", located="SIM")
    asset(api, api.ub, "B1", description="(9) SegredoB", bond_status="SegredoB", located="NAO")
    for path in ALL:
        ghost = dict(params)
        ghost.update({k: "Inexistente" for k in params if k == "bond_status"})
        ghost.update({k: "INEXISTENTE" for k in params if k == "tipo"})
        if "located" in params:  # nenhum bem NAO no escopo de A: vazio
            ghost = {"located": "NAO"}
        assert get(api, path, **params).get_json() == get(api, path, **ghost).get_json(), path
        assert "SegredoB".lower() not in get(api, path, **params).get_data(as_text=True).lower()


@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")])
def test_perfis_veem_so_o_escopo(api, who, aal):
    asset(api, api.ua, "A1", bond_status="Ocioso", located="NAO")
    asset(api, api.ub, "B1", bond_status="Ocioso", located="NAO")
    asset(api, api.ub, "B2", bond_status="Ocioso", located="NAO")
    assert get(api, "resumo", who, aal, bond_status="Ocioso").get_json()["total_bens"] == 1
    assert get(api, "pendencias-cadastro", who, aal).get_json()["ociosos"] == 1
    assert get(api, "por-vinculo", who, aal).get_json() == [{"id": "Ocioso", "label": "Ocioso", "value": 1}]


def test_adm_aal1_negado_nos_endpoints_novos(api):
    for path in ("localizacao-por-unidade", "por-vinculo", "pendencias-cadastro", "por-sala",
                 "inventario", "tipos"):
        assert get(api, path, "adm", "aal1").status_code in (401, 403)


# --- paridade com /assets ----------------------------------------------------------


def _assets_total(api, **params) -> int:
    query = urlencode({**params, "page_size": 1})
    response = api.client.get(f"/api/v1/assets?{query}", headers=auth_headers(SUBS["uab"]))
    assert response.status_code == 200
    return response.get_json()["total"]


def test_paridade_com_lista_de_bens_nos_filtros_comuns(api):
    room = api.world.room(api.ua, "Sala 1")
    person = api.world.person(api.ub, "Pessoa")
    asset(api, api.ua, "1", room_id=room, located="SIM", bond_status="Ocioso")
    asset(api, api.ua, "2", located="NAO", bond_status="OCIOSO", owner_unit_id=api.ub)
    asset(api, api.ub, "3", located="NAO", responsible_person_id=person, bond_status="Servidor")
    asset(api, api.ub, "4", located="DESCONHECIDO")
    asset(api, api.ub, "5", located="SIM", deleted_at=datetime.now(timezone.utc), deleted_by=uuid.uuid4())
    cases = [
        {}, {"unit_id": api.ua}, {"unit_id": api.ub}, {"owner_unit_id": api.ub}, {"room_id": room},
        {"responsible_person_id": person}, {"located": "NAO"}, {"bond_status": "ocioso"},
        {"bond_status": "__none__"}, {"unit_id": api.ub, "located": "NAO"},
        {"unit_id": str(uuid.uuid4())},
    ]
    for params in cases:
        assert total(api, "uab", **params) == _assets_total(api, **params), params


# --- top N + resto -------------------------------------------------------------------


def test_por_vinculo_top8_outros_e_sem_vinculo(api):
    n = 0
    for i in range(10):
        for _ in range(12 - i):
            n += 1
            asset(api, api.ua, f"V{n}", bond_status=f"Vinculo {i:02d}" if i else "Ocioso")
    asset(api, api.ua, "V-low", bond_status="ocioso")  # mesma chave sem caixa
    asset(api, api.ua, "N1")
    asset(api, api.ua, "N2")
    data = get(api, "por-vinculo").get_json()
    assert len(data) == 10
    assert data[0] == {"id": "Ocioso", "label": "Ocioso", "value": 13}
    assert data[-2] == {"id": "__outros__", "label": "Outros", "value": (12 - 8) + (12 - 9)}
    assert data[-1] == {"id": "__none__", "label": "Sem vínculo", "value": 2}
    assert sum(d["value"] for d in data) == total(api)
    # o `id` serve de filtro e devolve o mesmo valor
    assert total(api, bond_status=data[1]["id"]) == data[1]["value"]


def test_por_sala_top15_outras_sem_sala_e_ambiguidade(api):
    api.world.user("Duplo", role="USER", units=[api.ua, api.ub], auth_user_id="flt-duplo")
    SUBS["duplo"] = "flt-duplo"
    try:
        put(api, UnitAlias(id=uuid.uuid4(), alias="SIGB", unit_id=api.ub))
        n = 0
        for i in range(17):
            room = api.world.room(api.ua, f"Sala {i:02d}")
            for _ in range(20 - i):
                n += 1
                asset(api, api.ua, f"S{n}", room_id=room)
        twin_a = api.world.room(api.ua, "Recepção")
        twin_b = api.world.room(api.ub, "recepção")
        for k in range(30):
            asset(api, api.ua, f"RA{k}", room_id=twin_a)
            asset(api, api.ub, f"RB{k}", room_id=twin_b)
        asset(api, api.ub, "SEM")
        data = get(api, "por-sala", "duplo").get_json()
        assert len(data) == 17
        labels = [d["label"] for d in data]
        assert labels[:2] == ["recepção (SIGB)", "Recepção (UA)"]  # desempate pelo rótulo final
        assert data[-2]["id"] == "__outras__" and data[-2]["value"] == sum(20 - i for i in range(13, 17))  # 2 gêmeas + Sala 00..12 no top
        assert data[-1] == {"id": "__none__", "label": "Sem sala", "value": 1}
        assert sum(d["value"] for d in data) == total(api, "duplo")
        assert total(api, "duplo", room_id=data[2]["id"]) == data[2]["value"]
    finally:
        SUBS.pop("duplo")


def test_localizacao_por_unidade_top15_e_outras(api):
    units = [api.world.unit(f"U{i:02d}") for i in range(17)]
    api.world.user("Muitas", role="USER", units=units, auth_user_id="flt-muitas")
    SUBS["muitas"] = "flt-muitas"
    try:
        for i, unit in enumerate(units):
            for k in range(20 - i):
                asset(api, unit, f"L{i}-{k}", located=("SIM", "NAO", "DESCONHECIDO")[k % 3])
        data = get(api, "localizacao-por-unidade", "muitas").get_json()
        assert len(data) == 16
        assert data[0]["unidade"] == "U00" and data[0]["total"] == 20
        assert data[-1]["unidade"] == "Outras" and data[-1]["total"] == 5 + 4
        for item in data:
            assert item["sim"] + item["nao"] + item["desconhecido"] == item["total"]
        assert sum(i["total"] for i in data) == total(api, "muitas")
    finally:
        SUBS.pop("muitas")


def test_pendencias_cadastro(api):
    room = api.world.room(api.ua, "Sala")
    person = api.world.person(api.ua, "P")
    asset(api, api.ua, "1", room_id=room, responsible_person_id=person, located="SIM")
    asset(api, api.ua, "2", bond_status="OCIOSO", located="NAO")
    asset(api, api.ua, "3", bond_status="Ocioso Temporário", room_id=room)
    assert get(api, "pendencias-cadastro").get_json() == {
        "sem_responsavel": 2, "sem_sala": 1, "ociosos": 1, "nao_localizados": 1}
    assert get(api, "pendencias-cadastro", has_room="true").get_json() == {
        "sem_responsavel": 1, "sem_sala": 0, "ociosos": 0, "nao_localizados": 0}


# --- rótulos hostis ------------------------------------------------------------------

XSS = '<img src=x onerror=alert(1)>"\'&'


def test_sala_e_vinculo_hostis_saem_como_texto_json(api):
    room = api.world.room(api.ua, XSS + "​\x07fim")
    asset(api, api.ua, "1", room_id=room, bond_status=XSS)
    for path in ("por-sala", "por-vinculo"):
        response = get(api, path)
        assert response.status_code == 200 and response.mimetype == "application/json"
        assert response.headers["Cache-Control"] == "no-store"
    sala = get(api, "por-sala").get_json()[0]
    assert sala["label"] == XSS + "fim"  # texto puro: controle/invisíveis removidos
    vinculo = get(api, "por-vinculo").get_json()[0]
    assert vinculo == {"id": XSS, "label": XSS, "value": 1}
    assert total(api, bond_status=XSS) == 1


def test_clean_label():
    assert ds.clean_label("  a\x00b‮ c\n\td ") == "ab c d"
    assert len(ds.clean_label("x" * 500)) == ds.LABEL_MAX


# --- limite ---------------------------------------------------------------------------


def test_limite_proprio_do_dashboard():
    assert dashboard_api.DASHBOARD_READ_LIMIT == LIST_LIMIT == 1200
