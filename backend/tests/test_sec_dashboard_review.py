"""Revisao AppSec dos endpoints de agregacao `/api/v1/dashboard/*` (resumo, por-unidade,
por-situacao, aquisicoes-mensais, localizacao-por-unidade, por-vinculo,
pendencias-cadastro, por-sala, inventario, tipos): regressao de seguranca (IDOR,
allowlist, DoS, XSS, PII, logs). Filtros: `test_dashboard_filters.py`.

Reaproveita o mundo SQLite de `test_dashboard_summary_api`. Achados ABERTOS usam
`xfail(strict=True)`: quando forem corrigidos o teste passa a falhar como XPASS e
o marcador deve ser removido. Relatorio: docs/security/dashboard-appsec-review.md.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest
from test_dashboard_summary_api import (  # noqa: F401  (fixture `api` reutilizada)
    BASE,
    ENDPOINTS,
    SUBS,
    add,
    api,
    get,
)
from test_user_admin_db import auth_headers

from app.models.assets import Asset, AssetMovement
from app.models.units import UnitAlias
from app.services import dashboard_service as ds

ROOT = Path(__file__).resolve().parents[2]
TYPE_RE = re.compile(r"^[A-Z0-9]{1,40}$")


def _put(api, rows):
    with api.world.session() as db:
        for row in rows:
            db.add(row)


# --- IDOR / escopo ------------------------------------------------------------


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("param", ["unit_id", "owner_unit_id", "room_id", "responsible_person_id"])
def test_id_alheio_e_inexistente_mesma_resposta(api, path, param):
    """Filtro por ID fora do escopo = resultado vazio identico a ID inexistente."""
    add(api, api.ua, "A1", description="(1) NOTEBOOK", located="SIM")
    room_b = api.world.room(api.ub, "Sala B")
    person_b = api.world.person(api.ub, "Pessoa B")
    api.world.asset(api.ub, "B1", description="(2) MESA", located="NAO", room_id=room_b,
                    responsible_person_id=person_b, owner_unit_id=api.ub)
    alien = {"unit_id": api.ub, "owner_unit_id": api.ub, "room_id": room_b,
             "responsible_person_id": person_b}[param]
    other = get(api, path, query=f"?{param}={alien}")
    ghost = get(api, path, query=f"?{param}={uuid.uuid4()}")
    assert other.status_code == ghost.status_code == 200
    assert other.get_json() == ghost.get_json()
    assert str(alien) not in other.get_data(as_text=True)


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("param", ["unidade", "user_id", "role", "limit", "sort", "deleted_at", "q"])
def test_query_fora_da_allowlist_400_auditada_sem_eco(api, path, param):
    with patch("app.authorization.security_events._dispatch") as dispatch:
        response = get(api, path, query=f"?{param}=SEGREDO-{uuid.uuid4()}")
    assert response.status_code == 400
    assert "SEGREDO" not in response.get_data(as_text=True)
    assert dispatch.called, "tentativa de parametro privilegiado deve gerar evento"


def test_adm_aal1_negado_e_auditado(api):
    with patch("app.authorization.security_events._dispatch") as dispatch:
        response = get(api, "resumo", "adm", "aal1")
    assert response.status_code in (401, 403)
    assert dispatch.called


@pytest.mark.parametrize("path", ENDPOINTS)
@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_metodos_de_escrita_nao_aceitos(api, path, method):
    response = getattr(api.client, method)(f"{BASE}/{path}", headers=auth_headers(SUBS["ua"]), json={})
    assert response.status_code in (401, 403, 405)


def test_unidade_alheia_nunca_em_agregados(api):
    add(api, api.ua, "1", description="(1) NOTEBOOK", located="SIM")
    for n in range(4):
        add(api, api.ub, f"B{n}", description="(2) SEGREDOBPLUS", located="NAO")
    for path in ENDPOINTS:
        text = get(api, path, "ua").get_data(as_text=True)
        assert "SEGREDOBPLUS" not in text and "UB" not in text


def test_movimentacao_pendente_sem_identificar_unidade_alheia(api):
    # origem no escopo, destino alheio: conta (paridade com movement_service),
    # mas a resposta traz so um inteiro.
    _put(api, [
        AssetMovement(id=uuid.uuid4(), asset_id=uuid.uuid4(), origin_unit_id=api.ua,
                      destination_unit_id=api.ub, movement_type="TRANSFERENCIA",
                      status="PENDENTE", requested_by=uuid.uuid4()),
        # nenhuma ponta no escopo de A: nao conta
        AssetMovement(id=uuid.uuid4(), asset_id=uuid.uuid4(), origin_unit_id=api.ub,
                      destination_unit_id=api.ub, movement_type="TRANSFERENCIA",
                      status="PENDENTE", requested_by=uuid.uuid4()),
    ])
    body = get(api, "resumo", "ua").get_json()
    assert body["movimentacoes_pendentes"] == 1
    assert str(api.ub) not in get(api, "resumo", "ua").get_data(as_text=True)


def test_divergencia_owner_unit_nao_vaza_apenas_subconta(api):
    """Dashboard e /assets usam o mesmo escopo (unit_id OU owner_unit_id)."""
    add(api, api.ua, "A1", located="SIM")                     # unit_id=UA
    api.world.asset(api.ub, "B-owned-A", located="SIM", owner_unit_id=api.ua)  # dono=UA, local=UB
    api.world.asset(api.ua, "A-owned-B", located="SIM", owner_unit_id=api.ub)  # local=UA, dono=UB
    dash = get(api, "resumo", "ua").get_json()["total_bens"]

    from sqlalchemy import or_
    with api.world.session() as db:
        visible = db.query(Asset).filter(
            or_(Asset.unit_id == api.ua, Asset.owner_unit_id == api.ua)).count()
        dash_set = db.query(Asset).filter(Asset.unit_id == api.ua).count()
    assert dash_set == 2
    assert dash == visible == 3


def test_paridade_total_dashboard_com_escopo_de_assets(api):
    api.world.asset(api.ub, "B-owned-A", located="SIM", owner_unit_id=api.ua)
    add(api, api.ua, "A1", located="SIM")
    from sqlalchemy import or_
    with api.world.session() as db:
        visible = db.query(Asset).filter(
            or_(Asset.unit_id == api.ua, Asset.owner_unit_id == api.ua)).count()
    assert get(api, "resumo", "ua").get_json()["total_bens"] == visible


# --- XSS / dados nao confiaveis ----------------------------------------------------

HOSTILE = [
    "(1) <script>alert(1)</script> X",
    '(2) "><img src=x onerror=alert(1)> Y',
    "(3) =cmd|' /C calc'!A0",
    "(4) ' OR 1=1; DROP TABLE assets;--",
    "(5) javascript:alert(1)",
    "(6) __proto__ polluted",
    "(7) {{7*7}} ${7*7}",
    "",
    "(8)",
    "   ",
]


def test_descricoes_hostis_geram_rotulos_inertes(api):
    for i, text in enumerate(HOSTILE):
        add(api, api.ua, f"H{i}", description=text or None, located="SIM",
            reg=date.today())
    for path in ("por-unidade", "aquisicoes-mensais"):
        data = get(api, path, query="?meses=3" if "aquis" in path else "").get_json()
        labels = []
        for item in data:
            if path == "por-unidade":
                labels += list(item["tipos"])
            else:
                labels.append(item["id"])
        assert labels
        for label in labels:
            assert label in ("NAO_CLASSIFICADO", "OUTROS") or TYPE_RE.match(label), label
    assert "<" not in get(api, "por-unidade").get_data(as_text=True)


def test_alias_de_unidade_hostil_e_limitado_e_json(api):
    _put(api, [UnitAlias(id=uuid.uuid4(), unit_id=api.ua, alias="<img onerror=x>" + "A" * 200)])
    add(api, api.ua, "1", description="(1) NOTEBOOK")
    response = get(api, "por-unidade")
    assert response.status_code == 200
    assert response.mimetype == "application/json"
    assert response.headers.get("X-Content-Type-Options", "nosniff") == "nosniff"
    assert len(response.get_json()[0]["unidade"]) <= 64


def test_alias_de_unidade_sem_marcacao_html(api):
    _put(api, [UnitAlias(id=uuid.uuid4(), unit_id=api.ua, alias="<img onerror=x>")])
    add(api, api.ua, "1", description="(1) NOTEBOOK")
    assert "<" not in get(api, "por-unidade").get_json()[0]["unidade"]


def test_clean_alias_preserva_siglas_legitimas():
    for sigla in ("PU/TO", "SAD-1", "Procuradoria (TO)", "Gestão Nº 2"):
        assert ds.clean_alias(sigla) == sigla
    assert ds.clean_alias("a\x00b\n<c>") == "abc"


def test_tipo_outros_nao_colide_com_balde_outros():
    assert ds.infer_type("(1) OUTROS ITENS") not in (ds.OUTROS, ds._BUCKET)


# --- DoS ------------------------------------------------------------------------


def test_infer_type_linear_em_entrada_gigante():
    start = time.perf_counter()
    for payload in ("(" + "a" * 2_000_000, " " * 2_000_000 + "(", "(" * 500_000 + "x", "x " * 500_000):
        assert len(ds.infer_type(payload)) <= 40
    assert time.perf_counter() - start < 5


def test_respostas_limitadas_com_muitas_descricoes_distintas(api):
    rows = [
        Asset(id=uuid.uuid4(), patrimony_number=f"D{i}", unit_id=api.ua, version=1,
              description=f"(1) TIPO{i} {i}", located="SIM", registration_date=date.today())
        for i in range(1500)
    ]
    _put(api, rows)
    por_unidade = get(api, "por-unidade").get_json()
    assert len(por_unidade) == 1
    assert len(por_unidade[0]["tipos"]) <= ds.MAX_TIPOS_UNIDADE + 1
    series = get(api, "aquisicoes-mensais", query="?meses=24").get_json()
    assert len(series) <= ds.MAX_TIPOS_SERIE + 1
    assert all(len(s["data"]) == 24 for s in series)
    assert len(get(api, "por-unidade").get_data()) < 5_000


def test_agregacao_por_descricao_tem_teto_no_banco():
    src = (ROOT / "backend/app/services/dashboard_service.py").read_text(encoding="utf-8")
    assert re.search(r"\.limit\(MAX_GRUPOS\)", src)


def test_excedente_do_teto_soma_exata(api, monkeypatch):
    monkeypatch.setattr(ds, "MAX_GRUPOS", 3)
    _put(api, [Asset(id=uuid.uuid4(), patrimony_number=f"E{i}", unit_id=api.ua, version=1,
                     description=f"(1) T{i} x", located="SIM", registration_date=date.today())
               for i in range(10)])
    unit = get(api, "por-unidade").get_json()[0]
    assert unit["total"] == sum(unit["tipos"].values()) == 10
    series = get(api, "aquisicoes-mensais", query="?meses=3").get_json()
    assert sum(p["y"] for s_ in series for p in s_["data"]) == 10


@pytest.mark.parametrize("meses", ["99999999999999999999", "1e3", "0x10", " ", "%00", "-0"])
def test_meses_extremos_400(api, meses):
    assert get(api, "aquisicoes-mensais", query=f"?meses={meses}").status_code == 400


# --- PII / logs -----------------------------------------------------------------


def test_sem_token_nem_pii_nos_logs(api, caplog):
    headers = auth_headers(SUBS["ua"])
    token = headers["Authorization"].split()[-1]
    person = api.world.person(api.ua, "Beltrano Confidencial")
    api.world.asset(api.ua, "1", description="(1) NOTEBOOK", responsible_person_id=person, located="SIM")
    with caplog.at_level(logging.DEBUG):
        for path in ENDPOINTS:
            api.client.get(f"{BASE}/{path}", headers=headers)
            api.client.get(f"{BASE}/{path}?unit_id={api.ub}", headers=headers)
    assert token not in caplog.text
    assert "Beltrano" not in caplog.text


def test_erro_de_validacao_nao_vaza_detalhes(api):
    text = get(api, "aquisicoes-mensais", query="?meses=abc").get_data(as_text=True)
    assert "Traceback" not in text and "pydantic" not in text.lower() and "abc" not in text


# --- estaticos (backend e frontend) ----------------------------------------------


def test_servico_sem_sql_bruto():
    src = (ROOT / "backend/app/services/dashboard_service.py").read_text(encoding="utf-8")
    for needle in ("text(", ".execute(", "f\"SELECT", "f'SELECT", "literal_column", "% ("):
        assert needle not in src


def test_rotas_novas_sem_unit_id_vindo_do_cliente():
    src = (ROOT / "backend/app/api/v1/dashboard.py").read_text(encoding="utf-8")
    assert "request.args.get" not in src and "request.json" not in src
    assert src.count('\n@require_permission("reports.read")') == len(ENDPOINTS)
    assert src.count("\n@require_aal2_for_adm") == len(ENDPOINTS)


FRONT_FILES = [
    "frontend/src/lib/dashboard-api.ts",
    "frontend/src/components/dashboard",
    "frontend/src/components/features/dashboard",
    "frontend/src/app/(app)/dashboard",
]
FORBIDDEN = re.compile(
    r"dangerouslySetInnerHTML|\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|"
    r"document\.write|localStorage|sessionStorage|createObjectURL|\bwindow\.open"
)


def _front_sources():
    for rel in FRONT_FILES:
        path = ROOT / rel
        yield from ([path] if path.is_file() else sorted(path.rglob("*.ts*")))


def test_frontend_dashboard_sem_sinks_perigosos():
    files = list(_front_sources())
    assert files
    bad = [f"{p.name}: {m.group(0)}" for p in files
           for m in FORBIDDEN.finditer(p.read_text(encoding="utf-8"))]
    assert not bad, bad


def test_frontend_valida_resposta_por_type_guard():
    src = (ROOT / "frontend/src/lib/dashboard-api.ts").read_text(encoding="utf-8")
    assert src.count("fetchValidated(") >= 4
    assert "if (!guard(data)) throw" in src
    assert "Number.isSafeInteger" in src
