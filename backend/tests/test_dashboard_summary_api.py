"""Leituras agregadas do dashboard (`/api/v1/dashboard/resumo|por-unidade|por-situacao|
aquisicoes-mensais`): SQLite com o schema real, `require_auth` real, sem rede.

Cobre 401, perfis ADM/USER/RH, escopo de unidade (sem vazamento), vazio,
validação da consulta, valores, soft delete e ausência de PII.
"""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import test_assets_api as taa
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.models.assets import Asset, AssetMovement
from app.models.inventory import Inventory
from app.models.units import UnitAlias
from app.services import dashboard_service as ds

BASE = "/api/v1/dashboard"
NOW = datetime.now(timezone.utc)
EXTRA = ("unit_aliases", "asset_movements", "inventories")
SUBS = {"ua": "dsh-a", "ub": "dsh-b", "rh": "dsh-rh", "adm": "dsh-adm", "none": "dsh-none"}


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read",))
    world = taa.AssetWorld(taa._build_engine())
    with ExitStack() as stack:
        for target in ("app.api.v1.dashboard.get_db_session", "app.auth.supabase_auth.get_db_session"):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(patch("app.authorization.security_events._dispatch"))
        client = create_app().test_client()
        ua, ub = world.unit("UA"), world.unit("UB")
        world.user("User A", role="USER", units=[ua], auth_user_id=SUBS["ua"])
        world.user("User B", role="USER", units=[ub], auth_user_id=SUBS["ub"])
        world.user("Rita RH", role="RH", units=[ua], auth_user_id=SUBS["rh"])
        world.user("Adm A", role="ADM", units=[ua], auth_user_id=SUBS["adm"])
        world.user("Sem Unidade", role="USER", units=[], auth_user_id=SUBS["none"])
        yield SimpleNamespace(client=client, world=world, ua=ua, ub=ub)


def get(api, path, who="ua", aal="aal1", query=""):
    return api.client.get(f"{BASE}/{path}{query}", headers=auth_headers(SUBS[who], aal=aal))


def add(api, unit, number, *, description=None, located="DESCONHECIDO", created=None, reg=None, deleted=False):
    kw = {}
    if created is not None:
        kw["created_at"] = created
    if deleted:
        kw.update(deleted_at=NOW, deleted_by=uuid.uuid4())
    api.world.asset(unit, number, description=description, located=located, registration_date=reg, **kw)


ENDPOINTS = ("resumo", "por-unidade", "por-situacao", "aquisicoes-mensais")


# --- autenticação / perfis --------------------------------------------------------


@pytest.mark.parametrize("path", ENDPOINTS)
def test_sem_token_401(api, path):
    assert api.client.get(f"{BASE}/{path}").status_code == 401
    assert api.client.get(f"{BASE}/{path}", headers={"Authorization": "Bearer x"}).status_code == 401


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")])
def test_perfis_com_permissao_200_e_no_store(api, path, who, aal):
    response = get(api, path, who, aal)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("path", ENDPOINTS)
def test_adm_sem_aal2_negado(api, path):
    assert get(api, path, "adm", "aal1").status_code in (401, 403)


# --- vazio / escopo -------------------------------------------------------------


def test_banco_vazio(api):
    body = get(api, "resumo").get_json()
    assert body == {
        "total_bens": 0, "localizados": 0, "nao_localizados": 0, "desconhecidos": 0,
        "movimentacoes_pendentes": 0, "inventarios_abertos": 0, "novos_30d": 0,
        "valor_total": None, "em_manutencao": None, "baixas_ano": None,
        "variacao": {"total_bens": None, "valor_total": None, "em_manutencao": None, "baixas_ano": None},
    }
    assert get(api, "por-unidade").get_json() == []
    assert get(api, "por-situacao").get_json() == []
    assert get(api, "aquisicoes-mensais").get_json() == []


def test_sem_unidades_zeros_nunca_404(api):
    add(api, api.ua, "1", description="(1) NOTEBOOK X", located="SIM")
    assert get(api, "resumo", "none").get_json()["total_bens"] == 0
    for path in ("por-unidade", "por-situacao", "aquisicoes-mensais"):
        response = get(api, path, "none")
        assert response.status_code == 200 and response.get_json() == []


def test_escopo_nao_vaza_bens_de_outra_unidade(api):
    add(api, api.ua, "1", description="(1) NOTEBOOK A", located="SIM")
    for n in range(3):
        add(api, api.ub, f"B{n}", description="(2) IMPRESSORA B", located="NAO")
    a, b = get(api, "resumo", "ua").get_json(), get(api, "resumo", "ub").get_json()
    assert (a["total_bens"], a["localizados"], a["nao_localizados"]) == (1, 1, 0)
    assert (b["total_bens"], b["localizados"], b["nao_localizados"]) == (3, 0, 3)
    assert [i["unidade"] for i in get(api, "por-unidade", "ua").get_json()] == ["UA"]
    assert get(api, "por-situacao", "ua").get_json() == [{"id": "Localizado", "value": 1}]
    series = get(api, "aquisicoes-mensais", "ua").get_json()
    assert [s["id"] for s in series] == ["NOTEBOOK"]


def test_adm_sem_bypass_de_escopo(api):
    add(api, api.ua, "1", located="SIM")
    add(api, api.ub, "2", located="SIM")
    assert get(api, "resumo", "adm", "aal2").get_json()["total_bens"] == 1


def test_parametro_unit_id_e_extra_rejeitados_400(api):
    for path in ENDPOINTS:
        assert get(api, path, query=f"?unit_id={api.ub}").status_code == 400
        assert get(api, path, query="?foo=1").status_code == 400


@pytest.mark.parametrize("meses", ["0", "25", "-1", "abc", "", "1.5"])
def test_meses_invalido_400(api, meses):
    assert get(api, "aquisicoes-mensais", query=f"?meses={meses}").status_code == 400


def test_meses_repetido_400(api):
    assert get(api, "aquisicoes-mensais", query="?meses=3&meses=4").status_code == 400


# --- valores --------------------------------------------------------------------


def test_resumo_valores(api):
    old = NOW - timedelta(days=200)
    add(api, api.ua, "1", located="SIM", created=old)
    add(api, api.ua, "2", located="NAO", created=old)
    add(api, api.ua, "3", located="DESCONHECIDO", created=NOW - timedelta(days=5))
    add(api, api.ua, "4", located="SIM", created=NOW - timedelta(days=45))
    add(api, api.ua, "5", located="SIM", created=NOW - timedelta(days=50))
    add(api, api.ua, "6", located="SIM", created=NOW - timedelta(days=1), deleted=True)
    add(api, api.ub, "7", located="SIM", created=NOW)
    with api.world.session() as db:
        for status, o, d in (
            ("PENDENTE", api.ua, api.ub), ("PENDENTE", api.ub, api.ua), ("PENDENTE", api.ub, api.ub),
            ("CONCLUIDA", api.ua, api.ua),
        ):
            db.add(AssetMovement(
                id=uuid.uuid4(), asset_id=uuid.uuid4(), origin_unit_id=o, destination_unit_id=d,
                movement_type="TRANSFERENCIA", status=status, requested_by=uuid.uuid4()))
        for status, unit in (("ABERTO", api.ua), ("ABERTO", api.ub), ("CONCLUIDO", api.ua)):
            db.add(Inventory(
                id=uuid.uuid4(), name="i", unit_id=unit, start_date=date.today(),
                status=status, created_by=uuid.uuid4()))
    body = get(api, "resumo").get_json()
    assert body["total_bens"] == 5
    assert (body["localizados"], body["nao_localizados"], body["desconhecidos"]) == (3, 1, 1)
    assert body["novos_30d"] == 1
    assert body["variacao"]["total_bens"] == -50.0  # 1 recente vs 2 anteriores (45d e 50d)
    assert body["movimentacoes_pendentes"] == 2
    assert body["inventarios_abertos"] == 1
    assert body["valor_total"] is None and body["em_manutencao"] is None and body["baixas_ano"] is None


def test_variacao_percentual(api):
    add(api, api.ua, "1", created=NOW - timedelta(days=5))
    add(api, api.ua, "2", created=NOW - timedelta(days=6))
    add(api, api.ua, "3", created=NOW - timedelta(days=7))
    add(api, api.ua, "4", created=NOW - timedelta(days=40))
    add(api, api.ua, "5", created=NOW - timedelta(days=41))
    assert get(api, "resumo").get_json()["variacao"]["total_bens"] == 50.0


def test_infer_type():
    assert ds.infer_type("(123) Notebook Dell") == "NOTEBOOK"
    assert ds.infer_type("  (9)   Câmera, digital") == "CAMERA"
    assert ds.infer_type("Cadeira giratória") == "CADEIRA"
    assert ds.infer_type(None) == ds.NAO_CLASSIFICADO
    assert ds.infer_type("   ") == ds.NAO_CLASSIFICADO
    assert ds.infer_type("(12)") == ds.NAO_CLASSIFICADO


def test_por_unidade_tipos_sigla_e_outros(api):
    with api.world.session() as db:
        db.add(UnitAlias(id=uuid.uuid4(), alias="ZSIGLA", unit_id=api.ua))
        db.add(UnitAlias(id=uuid.uuid4(), alias="ASIGLA", unit_id=api.ua))
    api.world.user("Duplo", role="USER", units=[api.ua, api.ub], auth_user_id="dsh-duplo")
    SUBS["duplo"] = "dsh-duplo"
    types = ["NOTEBOOK", "MESA", "CADEIRA", "ARMARIO", "MONITOR", "TELEFONE", "RARO1", "RARO2"]
    n = 0
    for i, t in enumerate(types):
        for _ in range(10 - i if i < 6 else 1):
            n += 1
            add(api, api.ua, f"A{n}", description=f"({i}) {t.title()} marca")
    add(api, api.ub, "B1", description="(1) Notebook")
    add(api, api.ub, "B2", description=None)
    try:
        data = get(api, "por-unidade", "duplo").get_json()
    finally:
        SUBS.pop("duplo")
    assert [d["unidade"] for d in data] == ["ASIGLA", "UB"]
    first = data[0]
    assert first["total"] == sum(first["tipos"].values()) == 10 + 9 + 8 + 7 + 6 + 5 + 2
    assert len(first["tipos"]) == 7 and first["tipos"]["OUTROS"] == 2
    assert first["tipos"]["NOTEBOOK"] == 10
    assert data[1] == {"unidade": "UB", "total": 2, "tipos": {"NOTEBOOK": 1, "OUTROS": 1}}  # NAO_CLASSIFICADO fora do top 6 global


def test_por_situacao_so_positivos_e_sem_excluidos(api):
    add(api, api.ua, "1", located="SIM")
    add(api, api.ua, "2", located="SIM")
    add(api, api.ua, "3", located="NAO")
    add(api, api.ua, "4", located="DESCONHECIDO", deleted=True)
    assert get(api, "por-situacao").get_json() == [
        {"id": "Localizado", "value": 2}, {"id": "Não localizado", "value": 1},
    ]


def test_aquisicoes_mensais_meses_completos_e_coalesce(api):
    today = NOW.date()
    this_month = today.replace(day=1)
    prev_month = (this_month - timedelta(days=1)).replace(day=1)
    old = this_month - timedelta(days=400)
    add(api, api.ua, "1", description="(1) NOTEBOOK", reg=prev_month)
    add(api, api.ua, "2", description="(1) NOTEBOOK", reg=None, created=NOW)  # cai em created_at
    add(api, api.ua, "3", description="(1) NOTEBOOK", reg=prev_month, created=NOW)  # reg vence
    add(api, api.ua, "4", description="(1) NOTEBOOK", reg=old)  # fora do intervalo
    add(api, api.ua, "5", description="(1) MESA", reg=this_month, deleted=True)  # excluído
    add(api, api.ub, "6", description="(1) MESA", reg=this_month)  # outra unidade
    data = get(api, "aquisicoes-mensais", query="?meses=3").get_json()
    assert [s["id"] for s in data] == ["NOTEBOOK"]
    points = data[0]["data"]
    assert len(points) == 3 and [p["x"] for p in points] == sorted(p["x"] for p in points)
    assert points[-1] == {"x": this_month.strftime("%Y-%m"), "y": 1}
    assert points[-2] == {"x": prev_month.strftime("%Y-%m"), "y": 2}
    assert points[0]["y"] == 0


def test_aquisicoes_ate_3_tipos_mais_outros(api):
    for i, t in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE"]):
        for k in range(5 - i):
            add(api, api.ua, f"{t}{k}", description=f"(1) {t}", reg=NOW.date())
    data = get(api, "aquisicoes-mensais").get_json()
    assert [s["id"] for s in data] == ["AAA", "BBB", "CCC", "OUTROS"]
    assert all(len(s["data"]) == 6 for s in data)
    assert data[-1]["data"][-1]["y"] == 3


def test_month_range_virada_de_ano():
    r = ds.month_range(datetime(2026, 2, 10, tzinfo=timezone.utc), 4)
    assert r == [(2025, 11), (2025, 12), (2026, 1), (2026, 2)]


# --- PII ------------------------------------------------------------------------


def test_nenhum_campo_pii(api):
    with api.world.session() as db:
        pass
    person = api.world.person(api.ua, "Fulano Sigiloso")
    api.world.asset(api.ua, "1", description="(1) NOTEBOOK", located="SIM", responsible_person_id=person)
    for who in ("ua", "rh"):
        for path in ENDPOINTS:
            text = get(api, path, who).get_data(as_text=True)
            for secret in ("Fulano", "exemplo.invalid", "Rita", "User A", "auth_user_id", "email"):
                assert secret not in text
        assert set(get(api, "resumo", who).get_json()) == {
            "total_bens", "localizados", "nao_localizados", "desconhecidos",
            "movimentacoes_pendentes", "inventarios_abertos", "novos_30d",
            "valor_total", "em_manutencao", "baixas_ano", "variacao",
        }
