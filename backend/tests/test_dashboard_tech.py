"""Painéis de Tecnologia: `/api/v1/dashboard/tecnologia/*` (SQLite com o schema real,
`require_auth` real, sem rede). Cobre 401/403/AAL2, escopo (ID alheio == inexistente),
400 sem eco, no-store, agregados exatos, `deleted_at`, não classificados, paridade com
`/assets`, RH sem PII, regressão de `/dashboard/tipos`, `ResumoOut` e `by_unit`,
exportação (injeção de fórmula, auditoria) e a regra de classificação.
"""
from __future__ import annotations

import csv
import io
import uuid
import zipfile
from contextlib import ExitStack
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import test_assets_api as taa
from sqlalchemy import select
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.models.audit import AuditLog
from app.models.units import UnitAlias
from app.services import asset_classification as ac
from app.services import dashboard_tech_service as dts

BASE = "/api/v1/dashboard"
NOW = datetime.now(timezone.utc)
EXTRA = ("unit_aliases", "asset_movements", "inventories", "inventory_items")
SUBS = {"ua": "tch-a", "ub": "tch-b", "rh": "tch-rh", "adm": "tch-adm", "none": "tch-none"}
PATHS = ("resumo", "por-categoria", "por-unidade", "por-status", "sem-responsavel", "tempo-registro")
TI = "TECNOLOGIA"


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read", "exports.create"))
    world = taa.AssetWorld(taa._build_engine())
    with ExitStack() as stack:
        for target in (
            "app.api.v1.dashboard.get_db_session",
            "app.auth.supabase_auth.get_db_session",
            "app.api.v1.assets.get_db_session",
        ):
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
    return api.client.get(f"{BASE}/tecnologia/{path}{query}", headers=auth_headers(SUBS[who], aal=aal))


def add(api, unit, number, *, category=None, tech=None, status=None, description=None,
        person=None, reg=None, deleted=False, **kw):
    if deleted:
        kw.update(deleted_at=NOW, deleted_by=uuid.uuid4())
    return api.world.asset(
        unit, number, description=description, asset_category=category, tech_type=tech,
        operational_status=status, responsible_person_id=person, registration_date=reg, **kw,
    )


def seed(api):
    """UA: 3 notebooks (1 sem responsável), 1 monitor sem status, 1 TI sem tipo, 2 mobiliário,
    1 sem classificação, 1 notebook excluído. UB: 2 computadores."""
    person = api.world.person(api.ua, "Fulano de Tal")
    add(api, api.ua, "N1", category=TI, tech="NOTEBOOK", status="EM_USO", person=person)
    add(api, api.ua, "N2", category=TI, tech="NOTEBOOK", status="EM_USO", person=person)
    add(api, api.ua, "N3", category=TI, tech="NOTEBOOK", status="MANUTENCAO")  # sem responsável
    add(api, api.ua, "M1", category=TI, tech="MONITOR", person=person)  # status nulo
    add(api, api.ua, "T1", category=TI, status="ESTOQUE", person=person)  # tipo nulo
    add(api, api.ua, "F1", category="MOBILIARIO", status="EM_USO")
    add(api, api.ua, "F2", category="MOBILIARIO")
    add(api, api.ua, "X1")  # não classificado
    add(api, api.ua, "D1", category=TI, tech="NOTEBOOK", status="EM_USO", deleted=True)
    add(api, api.ub, "B1", category=TI, tech="COMPUTADOR", status="EM_USO")
    add(api, api.ub, "B2", category=TI, tech="COMPUTADOR", status="EM_USO")
    return person


# --- autenticação / autorização / contrato HTTP -------------------------------------


@pytest.mark.parametrize("path", PATHS + ("export",))
def test_sem_token_401(api, path):
    assert api.client.get(f"{BASE}/tecnologia/{path}").status_code == 401
    assert api.client.get(f"{BASE}/tecnologia/{path}", headers={"Authorization": "Bearer x"}).status_code == 401


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("who,aal", [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")])
def test_perfis_200_e_no_store(api, path, who, aal):
    response = get(api, path, who, aal)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("path", PATHS + ("export",))
def test_adm_sem_aal2_negado(api, path):
    assert get(api, path, "adm", "aal1").status_code in (401, 403)


@pytest.mark.parametrize("path", PATHS)
def test_sem_permissao_reports_read_403(api, path, monkeypatch):
    # USER sem unidades continua 200 (zeros); a negação por permissão é testada
    # removendo a permissão de um perfil novo.
    with api.world.session() as db:
        from app.models.rbac import Permission, Role, RolePermission

        role = db.execute(select(Role).where(Role.code == "RH")).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == "reports.read")).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
        ).scalars():
            db.delete(rp)
    assert get(api, path, "rh").status_code == 403


@pytest.mark.parametrize("path", PATHS + ("export",))
@pytest.mark.parametrize(
    "query",
    [
        "?foo=1",
        "?categoria=BOGUS",
        "?categoria=tecnologia",
        "?tipo_ti=Notebook",
        "?status=em_uso",
        "?status=EM_USO&status=ESTOQUE",
        "?unit_id=nao-uuid",
        "?meses=3",
        "?registrado_desde=2020-01-01&registrado_ate=2030-01-02",  # > 5 anos
        "?registrado_desde=2025-01-02&registrado_ate=2025-01-01",  # invertido
        "?registrado_desde=01/01/2025",
        "?categoria=%27%3Bdrop%20table%20assets%3B--",
    ],
)
def test_filtro_invalido_400_sem_eco(api, path, query):
    response = get(api, path, query=query)
    assert response.status_code == 400
    body = response.get_data(as_text=True)
    for fragment in ("BOGUS", "drop table", "Notebook", "em_uso", "nao-uuid"):
        assert fragment not in body


def test_formato_de_exportacao_invalido_400(api):
    assert get(api, "export", query="?format=pdf").status_code == 400
    assert get(api, "resumo", query="?format=csv").status_code == 400  # só na exportação


def test_periodo_ate_5_anos_aceito(api):
    assert get(api, "resumo", query="?registrado_desde=2021-03-01&registrado_ate=2026-03-01").status_code == 200


# --- vazio / escopo -----------------------------------------------------------------


def test_banco_vazio(api):
    assert get(api, "resumo").get_json() == {
        "total_bens": 0, "tecnologia": 0, "nao_classificados": 0, "tecnologia_sem_responsavel": 0,
        "tecnologia_sem_tipo": 0, "tecnologia_sem_status": 0, "filtros_aplicados": [],
    }
    assert get(api, "por-categoria").get_json() == {"categorias": [], "tipos_ti": []}
    assert get(api, "por-unidade").get_json() == []
    assert get(api, "por-status").get_json() == []
    assert get(api, "tempo-registro").get_json() == []
    assert get(api, "sem-responsavel").get_json() == {
        "tecnologia": 0, "sem_responsavel": 0, "percentual": None, "por_unidade": [],
    }


def test_sem_unidades_zeros_nunca_404(api):
    seed(api)
    assert get(api, "resumo", "none").get_json()["total_bens"] == 0
    assert get(api, "por-categoria", "none").get_json() == {"categorias": [], "tipos_ti": []}
    for path in ("por-unidade", "por-status", "tempo-registro"):
        response = get(api, path, "none")
        assert response.status_code == 200 and response.get_json() == []


def test_escopo_nao_vaza_e_adm_sem_bypass(api):
    seed(api)
    a = get(api, "resumo", "ua").get_json()
    b = get(api, "resumo", "ub").get_json()
    assert (a["total_bens"], a["tecnologia"]) == (8, 5)
    assert (b["total_bens"], b["tecnologia"]) == (2, 2)
    assert [i["unidade"] for i in get(api, "por-unidade", "ua").get_json()] == ["UA"]
    assert [i["unidade"] for i in get(api, "por-unidade", "ub").get_json()] == ["UB"]
    assert get(api, "resumo", "adm", "aal2").get_json()["total_bens"] == 8  # ADM sem bypass


def test_unit_id_alheio_igual_a_inexistente(api):
    seed(api)
    other = get(api, "resumo", "ua", query=f"?unit_id={api.ub}").get_json()
    ghost = get(api, "resumo", "ua", query=f"?unit_id={uuid.uuid4()}").get_json()
    assert other == ghost
    assert other["total_bens"] == 0


# --- agregados -----------------------------------------------------------------------


def test_resumo_valores_e_deleted_at_fora(api):
    seed(api)
    body = get(api, "resumo").get_json()
    assert body == {
        "total_bens": 8,  # o notebook excluído (D1) não conta
        "tecnologia": 5,
        "nao_classificados": 1,
        "tecnologia_sem_responsavel": 1,  # N3
        "tecnologia_sem_tipo": 1,  # T1
        "tecnologia_sem_status": 1,  # M1
        "filtros_aplicados": [],
    }


def test_por_categoria_soma_exata_e_nao_classificados(api):
    seed(api)
    body = get(api, "por-categoria").get_json()
    cats = {c["id"]: c["value"] for c in body["categorias"]}
    assert cats == {"TECNOLOGIA": 5, "MOBILIARIO": 2, "NAO_CLASSIFICADO": 1}
    assert sum(cats.values()) == get(api, "resumo").get_json()["total_bens"]
    labels = {c["id"]: c["label"] for c in body["categorias"]}
    assert labels["NAO_CLASSIFICADO"] == "Não classificado" and labels["MOBILIARIO"] == "Mobiliário"
    tipos = {t["id"]: t["value"] for t in body["tipos_ti"]}
    assert tipos == {"NOTEBOOK": 3, "MONITOR": 1, "NAO_INFORMADO": 1}
    assert sum(tipos.values()) == 5


def test_outros_e_categoria_propria_com_soma_exata(api):
    for i in range(4):
        add(api, api.ua, f"O{i}", category="OUTROS")
    add(api, api.ua, "V1", category="VEICULO")
    add(api, api.ua, "E1", category="EQUIPAMENTO")
    cats = {c["id"]: c["value"] for c in get(api, "por-categoria").get_json()["categorias"]}
    assert cats == {"EQUIPAMENTO": 1, "VEICULO": 1, "OUTROS": 4}
    assert sum(cats.values()) == get(api, "resumo").get_json()["total_bens"] == 6


def test_por_unidade_tipos_e_outras_com_soma_exata(api, monkeypatch):
    seed(api)
    rows = get(api, "por-unidade").get_json()
    assert rows == [
        {"unidade": "UA", "total": 5, "tipos": {"Notebook": 3, "Monitor": 1, "Tipo não informado": 1}}
    ]
    # teto de unidades: o excedente vira "Outras", somando exatamente
    monkeypatch.setattr(dts, "TOP_UNIDADES", 1)
    unit_c = api.world.unit("UC")
    api.world.user("Multi", role="USER", units=[api.ua, api.ub, unit_c], auth_user_id="tch-multi")
    add(api, unit_c, "C1", category=TI, tech="MONITOR")
    SUBS["multi"] = "tch-multi"
    result = get(api, "por-unidade", "multi").get_json()
    assert [r["unidade"] for r in result] == ["UA", "Outras"]
    outras = result[1]
    assert outras["total"] == 3 and outras["tipos"] == {"Computador": 2, "Monitor": 1}
    assert sum(r["total"] for r in result) == get(api, "resumo", "multi").get_json()["tecnologia"]


def test_por_status_com_nao_informado(api):
    seed(api)
    body = get(api, "por-status").get_json()
    assert body == [
        {"id": "EM_USO", "label": "Em uso", "value": 2},
        {"id": "ESTOQUE", "label": "Em estoque", "value": 1},
        {"id": "MANUTENCAO", "label": "Em manutenção", "value": 1},
        {"id": "NAO_INFORMADO", "label": "Não informado", "value": 1},
    ]


def test_sem_responsavel_so_contagens_sem_pii(api):
    seed(api)
    for who, aal in (("ua", "aal1"), ("rh", "aal1")):
        response = get(api, "sem-responsavel", who, aal)
        assert response.get_json() == {
            "tecnologia": 5, "sem_responsavel": 1, "percentual": 20.0,
            "por_unidade": [{"unidade": "UA", "value": 1}],
        }
        assert "Fulano" not in response.get_data(as_text=True)


def test_nenhuma_resposta_contem_dados_pessoais(api):
    seed(api)
    for path in PATHS:
        for who, aal in (("rh", "aal1"), ("ua", "aal1")):
            text = get(api, path, who, aal).get_data(as_text=True)
            assert "Fulano" not in text and "@" not in text


def test_tempo_registro_faixas(api):
    today = datetime.now(timezone(timedelta(hours=-3))).date()
    add(api, api.ua, "R1", category=TI, reg=today - timedelta(days=30))
    add(api, api.ua, "R2", category=TI, reg=dts._years_ago(today, 2))
    add(api, api.ua, "R3", category=TI, reg=dts._years_ago(today, 4))
    add(api, api.ua, "R4", category=TI, reg=dts._years_ago(today, 9))
    add(api, api.ua, "R5", category=TI, reg=today + timedelta(days=40))
    add(api, api.ua, "R6", category=TI)
    add(api, api.ua, "R7", category="MOBILIARIO", reg=today)  # fora da TI
    body = get(api, "tempo-registro").get_json()
    assert {i["id"]: i["value"] for i in body} == {
        "ate_1_ano": 1, "1_a_3_anos": 1, "3_a_5_anos": 1, "mais_de_5_anos": 1,
        "data_futura": 1, "sem_data": 1,
    }
    assert all(i["label"] for i in body)


def test_filtros_de_classificacao_e_periodo(api):
    seed(api)
    q = lambda s: get(api, "resumo", query=s).get_json()  # noqa: E731
    assert q("?categoria=MOBILIARIO")["total_bens"] == 2
    assert q("?categoria=NAO_CLASSIFICADO")["total_bens"] == 1
    assert q("?categoria=TECNOLOGIA&tipo_ti=NOTEBOOK")["total_bens"] == 3
    assert q("?tipo_ti=NAO_INFORMADO")["total_bens"] == 1
    assert q("?status=NAO_INFORMADO")["total_bens"] == 3  # M1, F2, X1 (UB fora do escopo)
    assert q("?status=MANUTENCAO")["tecnologia"] == 1
    assert q("?categoria=TECNOLOGIA&status=EM_USO")["total_bens"] == 2
    assert q("?categoria=MOBILIARIO&tipo_ti=NOTEBOOK")["total_bens"] == 0  # combinação vazia, 200
    names = q("?categoria=TECNOLOGIA&status=EM_USO")["filtros_aplicados"]
    assert names == ["categoria", "status"]  # só NOMES, nunca valores


def test_paridade_com_assets_para_filtros_comuns(api):
    seed(api)
    listed = api.client.get("/api/v1/assets?page_size=100", headers=auth_headers(SUBS["ua"], aal="aal1"))
    total = listed.get_json().get("total", None)
    if total is None:
        total = len(listed.get_json().get("items", []))
    assert get(api, "resumo").get_json()["total_bens"] == total


def test_tipos_e_resumo_existentes_inalterados(api):
    seed(api)
    h = auth_headers(SUBS["ua"], aal="aal1")
    resumo = api.client.get(f"{BASE}/resumo", headers=h)
    assert resumo.status_code == 200
    assert set(resumo.get_json()) == {
        "total_bens", "localizados", "nao_localizados", "desconhecidos", "movimentacoes_pendentes",
        "inventarios_abertos", "novos_30d", "valor_total", "em_manutencao", "baixas_ano", "variacao",
        "filtros_aplicados",
    }
    assert api.client.get(f"{BASE}/resumo?categoria=TECNOLOGIA", headers=h).status_code == 400
    assert api.client.get(f"{BASE}/tipos?status=EM_USO", headers=h).status_code == 400
    tipos = api.client.get(f"{BASE}/tipos", headers=h)
    assert tipos.status_code == 200 and tipos.get_json() == [{"value": "NAO_CLASSIFICADO", "count": 8}]
    by_unit = api.client.get(f"{BASE}/por-unidade", headers=h).get_json()
    assert by_unit == [{"unidade": "UA", "total": 8, "tipos": {"NAO_CLASSIFICADO": 8}}]


# --- exportação ---------------------------------------------------------------------


def _csv_rows(response):
    text = response.get_data(as_text=True).lstrip("﻿")
    return list(csv.reader(io.StringIO(text), delimiter=";"))


def test_exportacao_csv_agregada_auditada(api):
    seed(api)
    response = get(api, "export", query="?format=csv&categoria=TECNOLOGIA")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Content-Disposition"].startswith('attachment; filename="sispat-tecnologia-')
    rows = _csv_rows(response)
    assert rows[0] == ["Unidade", "Categoria", "Tipo de TI", "Situação operacional", "Quantidade"]
    assert sum(int(r[4]) for r in rows[1:]) == 5
    assert ["UA", "Tecnologia", "Notebook", "Em uso", "2"] in rows
    assert "Fulano" not in response.get_data(as_text=True)
    with api.world.session() as db:
        (audit,) = db.execute(select(AuditLog).where(AuditLog.operation == "DASHBOARD_TECH_EXPORTED")).scalars()
    assert audit.new_values == {"format": "csv", "rows": len(rows) - 1, "filters": ["categoria"]}


def test_exportacao_xlsx_so_texto(api):
    seed(api)
    response = get(api, "export", query="?format=xlsx")
    assert response.status_code == 200
    assert response.headers["Content-Disposition"].endswith('.xlsx"')
    with zipfile.ZipFile(io.BytesIO(response.get_data())) as archive:
        sheet = archive.read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in sheet and 't="n"' not in sheet and "inlineStr" in sheet


def test_exportacao_neutraliza_injecao_de_formula(api):
    seed(api)
    with api.world.session() as db:
        db.add(UnitAlias(id=uuid.uuid4(), unit_id=api.ua, alias="-2+3"))
    rows = _csv_rows(get(api, "export"))
    # `clean_alias` remove o "+", sobra "-23" (gatilho de fórmula): `escape_formula` prefixa "'"
    assert all(r[0] != "-23" for r in rows[1:])
    assert any(r[0] == "'-23" for r in rows[1:])


def test_exportacao_respeita_escopo_e_rh_sem_pii(api):
    seed(api)
    rows = _csv_rows(get(api, "export", "rh"))
    assert {r[0] for r in rows[1:]} == {"UA"}
    assert get(api, "export", "none").status_code == 200
    assert _csv_rows(get(api, "export", "none")) == [rows[0]]


def test_exportacao_sem_permissao_exports_create_403(api):
    with api.world.session() as db:
        from app.models.rbac import Permission, Role, RolePermission

        role = db.execute(select(Role).where(Role.code == "RH")).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == "exports.create")).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
        ).scalars():
            db.delete(rp)
    assert get(api, "export", "rh").status_code == 403


# --- regra de classificação ---------------------------------------------------------


@pytest.mark.parametrize(
    "description,expected",
    [
        ("(123) NOTEBOOK DELL LATITUDE", ("TECNOLOGIA", "NOTEBOOK")),
        ("(1) Computador de mesa", ("TECNOLOGIA", "COMPUTADOR")),
        ("MONITOR LCD 22", ("TECNOLOGIA", "MONITOR")),
        ("(9) Impressora laser", ("TECNOLOGIA", "IMPRESSORA")),
        ("(9) Nobreak 1500va", ("TECNOLOGIA", "OUTRO_TI")),
        ("(5) Cadeira giratória", ("MOBILIARIO", None)),
        ("(5) Ar-condicionado split", ("EQUIPAMENTO", None)),
        ("(5) Automóvel sedan", ("VEICULO", None)),
        ("(5) Coisa desconhecida", (None, None)),
        ("", (None, None)),
        (None, (None, None)),
    ],
)
def test_regra_de_classificacao(description, expected):
    assert ac.classify_description(description) == expected


def test_apply_if_unclassified_nunca_sobrescreve():
    asset = SimpleNamespace(asset_category="OUTROS", tech_type=None)
    assert ac.apply_if_unclassified(asset, "NOTEBOOK X") is False
    assert asset.asset_category == "OUTROS"
    blank = SimpleNamespace(asset_category=None, tech_type=None)
    assert ac.apply_if_unclassified(blank, "NOTEBOOK X") is True
    assert (blank.asset_category, blank.tech_type) == ("TECNOLOGIA", "NOTEBOOK")
    unknown = SimpleNamespace(asset_category=None, tech_type=None)
    assert ac.apply_if_unclassified(unknown, "ALGO RARO") is False and unknown.asset_category is None


def test_vocabulario_e_rotulos_consistentes():
    assert set(ac.CATEGORY_LABELS) == set(ac.CATEGORIES) | {ac.NOT_CLASSIFIED}
    assert set(ac.TECH_TYPE_LABELS) == set(ac.TECH_TYPES) | {ac.NOT_INFORMED}
    assert set(ac.STATUS_LABELS) == set(ac.OPERATIONAL_STATUSES) | {ac.NOT_INFORMED}
    from app.api.v1 import dashboard_schemas as ds
    from typing import get_args

    assert set(get_args(ds.CategoriaFiltro)) == set(ac.CATEGORIES) | {ac.NOT_CLASSIFIED}
    assert set(get_args(ds.TipoTiFiltro)) == set(ac.TECH_TYPES) | {ac.NOT_INFORMED}
    assert set(get_args(ds.StatusOperacionalFiltro)) == set(ac.OPERATIONAL_STATUSES) | {ac.NOT_INFORMED}
    for rule_category, rule_type in ac._KEYWORDS.values():
        assert rule_category in ac.CATEGORIES
        assert rule_type is None or rule_type in ac.TECH_TYPES


# --- CLI de classificação inicial (dry-run por padrão) -------------------------------


def _run_backfill(api, apply):
    from app.services.asset_classification_backfill import classify_existing_assets

    with api.world.session() as db:
        return classify_existing_assets(db, apply=apply)


def test_backfill_dry_run_nao_grava_e_apply_so_nulos(api):
    add(api, api.ua, "A1", description="(1) NOTEBOOK DELL")
    add(api, api.ua, "A2", description="(2) NOTEBOOK HP")
    add(api, api.ua, "A3", description="(3) CADEIRA AZUL")
    add(api, api.ua, "A4", description="(4) ITEM SEM REGRA")
    add(api, api.ua, "A5", description="(5) NOTEBOOK MANUAL", category="OUTROS")  # manual: preservada
    add(api, api.ua, "A6", description="(6) NOTEBOOK EXCLUIDO", deleted=True)
    dry = _run_backfill(api, False)
    assert dry.dry_run and (dry.candidates, dry.classified, dry.unmatched) == (4, 3, 1)
    assert dict(dry.by_category) == {"TECNOLOGIA": 2, "MOBILIARIO": 1}
    assert get(api, "resumo").get_json()["tecnologia"] == 0  # nada gravado
    applied = _run_backfill(api, True)
    assert not applied.dry_run and applied.classified == 3
    body = get(api, "por-categoria").get_json()
    assert {c["id"]: c["value"] for c in body["categorias"]} == {
        "TECNOLOGIA": 2, "MOBILIARIO": 1, "OUTROS": 1, "NAO_CLASSIFICADO": 1,
    }
    assert _run_backfill(api, True).classified == 0  # idempotente
    with api.world.session() as db:
        deleted = db.execute(
            select(dts.Asset).where(dts.Asset.patrimony_number == "A6")
        ).scalar_one()
        assert deleted.asset_category is None
        (audit,) = db.execute(select(AuditLog).where(AuditLog.operation == "ASSETS_CLASSIFIED")).scalars()
        assert audit.new_values["updated"] == 3


def test_comando_cli_dry_run_por_padrao():
    import click.testing

    from app.cli import classify_assets_command

    calls = []

    class _Report:
        dry_run = True
        candidates, classified, unmatched = 4, 3, 1
        by_category = {"TECNOLOGIA": 2}
        by_tech_type = {"NOTEBOOK": 2}

    from contextlib import contextmanager

    @contextmanager
    def fake_session():
        yield object()

    def fake_classify(db, *, apply):
        calls.append(apply)
        return _Report()

    with patch("app.cli.get_db_session", fake_session), patch("app.cli.classify_existing_assets", fake_classify):
        result = click.testing.CliRunner().invoke(classify_assets_command, [])
        assert result.exit_code == 0 and calls == [False]
        assert "Dry-run" in result.output and "nada foi gravado" in result.output.lower()
        click.testing.CliRunner().invoke(classify_assets_command, ["--apply"])
        assert calls == [False, True]
