"""ONDA 4 (QA): lacunas de regressão de painéis, fila, override e exportações.

Reaproveita o mundo de `test_dashboard_equipment` (SQLite com o schema real, Redis
falso, sem rede). Complementa o que a Onda 2 já cobre com:

- GRAVAÇÃO REAL em `audit_logs` (os testes da Onda 2 só substituem `_dispatch`;
  aqui `_dispatch` chama `_persist_event`, a função que o escritor em segundo plano
  executa em produção) para mass assignment e acessos negados;
- mesma resposta E mesmo evento para ID alheio, inexistente, excluído e painel proibido;
- override: vocabulário fechado, versão estrita, repetição idempotente;
- `csv_safety` com `-`, TAB e CR (CSV e XLSX), inclusive no nº patrimonial;
- nenhum dado pessoal nas respostas nem na auditoria da exportação (inclusive RH);
- ADM sem AAL2 negado em TODAS as rotas administrativas novas.
"""
from __future__ import annotations

import io
import uuid
import zipfile
from contextlib import ExitStack
from unittest.mock import patch

import pytest
from sqlalchemy import select
from test_dashboard_equipment import (  # noqa: F401  (fixture `api` reutilizada)
    BASE,
    SUBS,
    add,
    api,
    data,
    hdr,
    queue,
    seed,
)
from test_user_admin_db import auth_headers

from app.authorization import security_events as se
from app.models.audit import AuditLog

OVERRIDE = "/api/v1/assets/{}/category-override"
ADM_ONLY = ("unclassified_review", "classification_overrides", "sync_status")


@pytest.fixture()
def real_audit(api):
    """Faz `_dispatch` GRAVAR de fato (síncrono) em `audit_logs`, como o escritor real."""

    def persist(event):
        se._persist_event(event)

    with ExitStack() as stack:
        stack.enter_context(patch("app.authorization.security_events._dispatch", side_effect=persist))
        stack.enter_context(patch("app.database.session.get_db_session", api.world.session))
        yield api


def security_rows(api, operation=None):
    with api.world.session() as db:
        stmt = select(AuditLog).where(AuditLog.entity_type == "security_event")
        if operation:
            stmt = stmt.where(AuditLog.operation == operation)
        return list(db.execute(stmt).scalars())


def override(api, asset_id, body, who="adm", aal=None):
    return api.client.post(OVERRIDE.format(asset_id), json=body, headers=hdr(who, aal))


def mk(api, number="Q1", **kw):
    return add(api, api.ua, number, "OUTROS", conf="BAIXA", desc="(1) HUB 16 PORTAS HUB", **kw)


# --- 2. mass assignment: gravação REAL em audit_logs ---------------------------------


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", str(uuid.uuid4())),
        ("role", "ADM"),
        ("unit_id", str(uuid.uuid4())),
        ("deleted_at", "2026-01-01T00:00:00Z"),
    ],
)
def test_override_mass_assignment_grava_de_fato_em_audit_logs(real_audit, field, value):
    api = real_audit
    asset_id = mk(api)
    r = override(api, asset_id, {"category": "REDE", "version": 1, field: value})
    assert r.status_code == 400
    saved = api.world.row(asset_id)
    assert saved.category_override is None and saved.version == 1 and saved.deleted_at is None
    rows = security_rows(api, "PRIVILEGE_ESCALATION_ATTEMPT")
    assert len(rows) == 1, "o evento foi despachado mas NÃO persistido em audit_logs"
    assert rows[0].result == "FALHA"
    assert rows[0].new_values["details"]["fields"] == [field]
    assert rows[0].new_values["details"]["context"] == "assets.category_override"
    assert value not in str(rows[0].new_values)  # valor do atacante nunca é gravado
    assert str(rows[0].actor_user_id) != value


# --- 1. IDOR/BOLA: mesma resposta E mesmo evento ---------------------------------------


def _denied(api, since):
    return [r for r in security_rows(api) if r.id not in since]


def test_override_alheio_inexistente_excluido_malformado_mesma_resposta_e_evento(real_audit):
    api = real_audit
    own_unit_b = add(api, api.ub, "B-ALHEIO", "OUTROS", conf="BAIXA", desc="HUB")
    gone = mk(api, "Q-GONE", deleted=True)
    api.world.user("Adm B", role="ADM", units=[api.ub], auth_user_id="eq-adm-b")
    adm_b = auth_headers("eq-adm-b", aal="aal2")
    body = {"category": "REDE", "version": 1}
    targets = {
        "alheio": (own_unit_b, hdr("adm")),  # bem da UB, ADM da UA
        "inexistente": (uuid.uuid4(), hdr("adm")),
        "excluido": (gone, hdr("adm")),
    }
    seen, responses = [], {}
    for name, (asset_id, headers) in targets.items():
        before = {r.id for r in security_rows(api)}
        resp = api.client.post(OVERRIDE.format(asset_id), json=body, headers=headers)
        new = _denied(api, before)
        responses[name] = (resp.status_code, resp.get_json())
        assert len(new) == 1, f"{name}: esperado exatamente 1 evento persistido"
        e = new[0].new_values
        seen.append((new[0].operation, e["severity"], e["details"], e["target"]["type"]))
    assert len({str(v) for v in responses.values()}) == 1, responses
    assert responses["alheio"][0] == 404
    assert len({str(s) for s in seen}) == 1, seen  # eventos indistinguíveis
    assert api.world.row(own_unit_b).category_override is None
    assert adm_b  # ADM da UB existe (poderia agir sobre o bem, mas não sobre o da UA)


def test_override_de_um_adm_nao_alcanca_bem_de_outra_unidade_mesmo_com_aal2(api):
    alien = add(api, api.ub, "B-1", "OUTROS", conf="BAIXA", desc="HUB")
    r = override(api, alien, {"category": "REDE", "version": 1})  # ADM da UA (sem bypass)
    assert r.status_code == 404 and api.world.row(alien).category_override is None


def test_painel_proibido_inexistente_e_malformado_mesma_resposta_e_mesmo_evento_persistido(real_audit):
    api = real_audit
    results = []
    for panel in ("sync_status", "nao_existe", "SYNC_STATUS", "sync_status%20", "x" * 200):
        for who in ("ua", "rh"):
            before = {r.id for r in security_rows(api)}
            resp = data(api, panel, who)
            new = _denied(api, before)
            assert resp.status_code == 404
            assert len(new) == 1
            e = new[0].new_values
            results.append((str(resp.get_json()), new[0].operation, str(e["details"]), e["target"]["type"]))
    assert len(set(results)) == 1, results


@pytest.mark.parametrize("panel", ADM_ONLY)
@pytest.mark.parametrize("who", ["ua", "rh"])
def test_exportacao_de_painel_adm_negada_a_user_e_rh_igual_a_inexistente(real_audit, panel, who):
    api = real_audit
    a = api.client.get(f"{BASE}/panels/{panel}/export", headers=hdr(who))
    b = api.client.get(f"{BASE}/panels/inexistente/export", headers=hdr(who))
    assert a.status_code == b.status_code == 404 and a.get_json() == b.get_json()
    assert api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED") == []


def test_fila_unit_id_alheio_igual_a_inexistente_na_lista_e_na_exportacao(api):
    add(api, api.ub, "B-OUT", "OUTROS", conf="BAIXA", desc="SEGREDO-UB")
    mk(api)
    for path in ("/classificacao/revisao", "/classificacao/revisao/export"):
        alien = api.client.get(f"{BASE}{path}?unit_id={api.ub}", headers=hdr("adm"))
        ghost = api.client.get(f"{BASE}{path}?unit_id={uuid.uuid4()}", headers=hdr("adm"))
        assert alien.status_code == ghost.status_code == 200
        if path.endswith("revisao"):
            assert alien.get_json() == ghost.get_json() and alien.get_json()["total"] == 0
        else:
            assert alien.get_data() == ghost.get_data() or alien.get_data(as_text=True).count("\n") == ghost.get_data(
                as_text=True
            ).count("\n")
        assert "SEGREDO-UB" not in alien.get_data(as_text=True)


# --- 3. AAL2 em todas as rotas administrativas novas ------------------------------------


def test_adm_aal1_negado_em_todas_as_rotas_administrativas_e_nada_vaza(api):
    seed(api)
    asset_id = mk(api, "Q-AAL")
    paths = [f"/panels/{p}/data" for p in ADM_ONLY] + [
        "/panels/kpi_workstations/data",
        "/panels/equipment_by_unit_table/export",
        "/classificacao/revisao",
        "/classificacao/revisao/export",
    ]
    for path in paths:
        r = api.client.get(BASE + path, headers=hdr("adm", "aal1"))
        assert r.status_code in (401, 403), path
        assert "dados" not in r.get_data(as_text=True) and "items" not in r.get_data(as_text=True)
    r = override(api, asset_id, {"category": "REDE", "version": 1}, aal="aal1")
    assert r.status_code in (401, 403)
    assert api.world.row(asset_id).category_override is None
    assert api.world_audits("ASSET_CATEGORY_OVERRIDDEN") == []


@pytest.mark.parametrize("who", ["ua", "rh"])
def test_user_e_rh_nunca_leem_a_fila_nem_aplicam_override(api, who):
    asset_id = mk(api)
    assert queue(api, who).status_code in (401, 403)
    assert api.client.get(f"{BASE}/classificacao/revisao/export", headers=hdr(who)).status_code in (401, 403)
    assert override(api, asset_id, {"category": "REDE", "version": 1}, who).status_code in (401, 403)
    assert api.world.row(asset_id).category_override is None


# --- 5. override: vocabulário, versão, idempotência ----------------------------------------


@pytest.mark.parametrize(
    "category",
    ["NAO_CLASSIFICADO", "TI", "MOBILIARIO", "mesa", " MESA", "MESA ", "", None, 1, ["MESA"], "REDE;DROP", "A" * 500],
)
def test_override_categoria_fora_do_vocabulario_400_sem_eco_e_sem_efeito(api, category):
    asset_id = mk(api)
    r = override(api, asset_id, {"category": category, "version": 1})
    assert r.status_code == 400
    if isinstance(category, str) and len(category) > 3:
        assert category not in r.get_data(as_text=True)
    assert api.world.row(asset_id).category_override is None
    assert api.world_audits("ASSET_CATEGORY_OVERRIDDEN") == []


@pytest.mark.parametrize("version", [0, -1, "1", 1.5, True, None, 2**31, [1]])
def test_override_versao_estrita(api, version):
    asset_id = mk(api)
    body = {"category": "REDE"} if version is None else {"category": "REDE", "version": version}
    assert override(api, asset_id, body).status_code == 400
    assert api.world.row(asset_id).version == 1


def test_override_sem_version_400(api):
    asset_id = mk(api)
    assert override(api, asset_id, {"category": "REDE"}).status_code == 400


def test_override_repetir_com_versao_antiga_409_e_com_versao_nova_e_idempotente(api):
    asset_id = mk(api)
    first = override(api, asset_id, {"category": "REDE", "version": 1})
    assert first.status_code == 200 and first.get_json()["version"] == 2
    stale = override(api, asset_id, {"category": "REDE", "version": 1})
    assert stale.status_code == 409
    again = override(api, asset_id, {"category": "REDE", "version": 2})
    assert again.status_code == 200 and again.get_json()["version"] == 2  # nada gravado
    assert len(api.world_audits("ASSET_CATEGORY_OVERRIDDEN")) == 1
    other = override(api, asset_id, {"category": "MESA", "version": 2})
    assert other.status_code == 200 and other.get_json()["version"] == 3
    assert len(api.world_audits("ASSET_CATEGORY_OVERRIDDEN")) == 2


def test_override_para_outros_tambem_tira_o_bem_da_fila(api):
    asset_id = mk(api)
    assert queue(api).get_json()["total"] == 1
    assert override(api, asset_id, {"category": "OUTROS", "version": 1}).status_code == 200
    assert queue(api).get_json()["total"] == 0


def test_lacuna_conhecida_nao_existe_remocao_de_override(api):
    """Registro da lacuna: nenhuma rota remove `category_override` (DELETE/PUT/PATCH)."""
    asset_id = mk(api)
    override(api, asset_id, {"category": "REDE", "version": 1})
    for method in ("delete", "put", "patch"):
        r = getattr(api.client, method)(OVERRIDE.format(asset_id), json={"version": 2}, headers=hdr("adm"))
        assert r.status_code in (404, 405)
    assert override(api, asset_id, {"category": None, "version": 2}).status_code == 400
    assert api.world.row(asset_id).category_override == "REDE"


# --- 6. exportações: csv_safety ----------------------------------------------------------

EVIL = ["=1+1", "+1+1", "-1+1", "@SUM(1)", "\t=1+1", "\r=1+1", "\n=1+1", " =1+1", "＝1+1"]


def _csv_cells(response):
    text = response.get_data(as_text=True).lstrip("﻿")
    import csv

    return [c for row in csv.reader(io.StringIO(text), delimiter=";") for c in row]


def _is_dangerous(cell: str) -> bool:
    return bool(cell) and cell.lstrip(" \"' ")[:1] in set("=+-@\t\r\n＝＋－＠") and not cell.startswith("'")


def test_csv_da_fila_neutraliza_todos_os_gatilhos_inclusive_no_patrimonial(api):
    for i, evil in enumerate(EVIL):
        add(api, api.ua, evil + f"#{i}", "OUTROS", conf="BAIXA", desc=evil + " descricao")
    r = api.client.get(f"{BASE}/classificacao/revisao/export", headers=hdr("adm"))
    assert r.status_code == 200
    cells = _csv_cells(r)
    assert len(cells) >= 7 * (len(EVIL) + 1)
    assert [c for c in cells if _is_dangerous(c)] == []


def test_xlsx_da_fila_nunca_grava_formula_nem_texto_perigoso_cru(api):
    for i, evil in enumerate(EVIL):
        add(api, api.ua, evil + f"#{i}", "OUTROS", conf="BAIXA", desc=evil + " descricao")
    r = api.client.get(f"{BASE}/classificacao/revisao/export?format=xlsx", headers=hdr("adm"))
    assert r.status_code == 200 and r.data[:2] == b"PK"
    zf = zipfile.ZipFile(io.BytesIO(r.data))
    xml = zf.read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in xml and "<f " not in xml
    shared = zf.read("xl/sharedStrings.xml").decode() if "xl/sharedStrings.xml" in zf.namelist() else ""
    blob = xml + shared
    for raw in ("=1+1", "+1+1", "-1+1", "@SUM(1)"):
        assert f">{raw}" not in blob, raw  # só aparece com o apóstrofo na frente


def test_exportacao_de_tabela_com_unidade_hostil_nao_gera_formula(api):
    evil_unit = api.world.unit("=CMD|calc")
    add(api, evil_unit, "H1", "NOTEBOOK")
    api.world.user("Hostil", role="ADM", units=[evil_unit], auth_user_id="eq-hostile")
    for fmt in ("csv", "xlsx"):
        r = api.client.get(
            f"{BASE}/panels/equipment_by_unit_table/export?format={fmt}",
            headers=auth_headers("eq-hostile", aal="aal2"),
        )
        assert r.status_code == 200
        if fmt == "csv":
            assert [c for c in _csv_cells(r) if _is_dangerous(c)] == []
        else:
            xml = zipfile.ZipFile(io.BytesIO(r.data)).read("xl/worksheets/sheet1.xml").decode()
            assert "<f>" not in xml


# --- 6. nenhum dado pessoal (inclusive RH) -----------------------------------------------

PII = ("Fulana Sigilosa", "fulana.sigilosa@agu.gov.br", "123.456.789-09")


def test_nenhuma_resposta_nem_auditoria_contem_dado_pessoal_para_nenhum_perfil(api):
    person = api.world.person(api.ua, PII[0])
    add(
        api, api.ua, "P1", "NOTEBOOK", responsible_person_id=person, notes=" ".join(PII[1:]),
        desc="(1) NOTEBOOK",
    )
    add(api, api.ua, "P2", "OUTROS", conf="BAIXA", desc="HUB", responsible_person_id=person, notes=PII[1])
    from app.services.dashboard_equipment_service import PANEL_BUILDERS

    outputs = []
    for who in ("ua", "rh", "adm"):
        for panel in PANEL_BUILDERS:
            r = data(api, panel, who)
            outputs.append(r.get_data(as_text=True))
            if panel in ("equipment_by_unit_table", "furniture_by_unit_table"):
                for fmt in ("csv", "xlsx"):
                    e = api.client.get(f"{BASE}/panels/{panel}/export?format={fmt}", headers=hdr(who))
                    outputs.append(e.get_data(as_text=True) if fmt == "csv" else e.data.decode("latin-1"))
    outputs.append(queue(api).get_data(as_text=True))
    outputs.append(api.client.get(f"{BASE}/classificacao/revisao/export", headers=hdr("adm")).get_data(as_text=True))
    blob = "\n".join(outputs)
    for pii in PII:
        assert pii not in blob
    with api.world.session() as db:
        logs = "\n".join(str(r.new_values) + str(r.previous_values) for r in db.execute(select(AuditLog)).scalars())
    for pii in PII:
        assert pii not in logs
    assert "responsible" not in blob.lower() and "responsavel" not in blob.lower().replace("sem_responsavel", "")


def test_auditoria_de_exportacao_so_tem_formato_linhas_e_nomes_de_filtro(api):
    seed(api)
    r = api.client.get(f"{BASE}/panels/equipment_by_unit_table/export?unit_id={api.ua}", headers=hdr("ua"))
    assert r.status_code == 200
    [audit] = api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED")
    assert set(audit.new_values) == {"format", "rows", "filters"}
    assert audit.new_values["filters"] == ["unit_id"] and str(api.ua) not in str(audit.new_values)
    assert audit.previous_values is None


def test_exportacao_so_de_paineis_exportaveis_e_resposta_nao_cacheavel(api):
    seed(api)
    ok = api.client.get(f"{BASE}/panels/furniture_by_unit_table/export", headers=hdr("rh"))
    assert ok.status_code == 200
    assert ok.headers["Cache-Control"] == "no-store" and ok.headers["X-Content-Type-Options"] == "nosniff"
    for panel in ("kpi_workstations", "category_distribution", "sync_status"):
        assert api.client.get(f"{BASE}/panels/{panel}/export", headers=hdr("adm")).status_code == 404


# --- 7. frontend: guardas estáticos adicionais ---------------------------------------------


def _frontend_sources():
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "frontend" / "src"
    files = [root / "lib" / "dashboard-equipment-api.ts"]
    files += sorted((root / "components" / "features" / "dashboard").glob("*.ts*"))
    files += sorted((root / "app" / "(app)" / "dashboard").rglob("*.tsx"))
    return [f for f in files if f.is_file()]


def test_frontend_dashboard_sem_storage_nem_sinks_perigosos():
    import re

    bad = re.compile(r"localStorage|sessionStorage|dangerouslySetInnerHTML|\beval\s*\(|new Function\s*\(|document\.write|innerHTML")
    hits = []
    for f in _frontend_sources():
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("//")[0]
            if bad.search(code) and not code.lstrip().startswith(("*", "/*")):
                hits.append(f"{f.name}:{n}: {line.strip()}")
    assert hits == [], hits


def test_frontend_nao_exibe_texto_de_erro_do_servidor():
    import re

    hits = []
    for f in _frontend_sources():
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"\b(?:body|payload|json|data|error)\??\.(?:message|detail|error)\b", text):
            line = text.count("\n", 0, m.start()) + 1
            hits.append(f"{f.name}:{line}: {m.group(0)}")
    assert hits == [], hits
