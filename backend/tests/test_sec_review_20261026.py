"""Rodada de segurança 2026-10-26: reconciliação, confirmação em lotes e busca nova.

Somente leitura do código de produção. Zero rede. Achados em docs/security.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

import test_assets_api as base
from app.models.assets import Asset
from app.security.text_search import MAX_SEARCH_TOKENS, search_tokens
from app.services.asset_service import asset_search_clause
from test_assets_api import ADM, RH_A, USER_A, USER_B, ast, h  # noqa: F401
from test_imports_api import (  # noqa: F401  (fixtures e helpers)
    _auth_headers,
    _make_token,
    _patch_authenticated,
    _patch_db_and_service,
    app,
    client,
    fake_redis,
)

ROOT = Path(__file__).resolve().parents[2]
CONFIRM = "/api/v1/imports/google-sheets/confirm"


def _recon(pid) -> str:
    return f"/api/v1/imports/google-sheets/{pid}/reconciliation"


# -- reconciliação: authz, AAL2, 404 uniforme, query estrita -------------------


@pytest.mark.parametrize("roles", [{"USER"}, {"RH"}, set()])
def test_reconciliacao_nao_adm_recebe_403(client, roles):
    with _patch_authenticated(roles, {"imports.execute"}):
        r = client.get(_recon(uuid.uuid4()), headers=_auth_headers(_make_token()))
    assert r.status_code == 403


def test_reconciliacao_adm_sem_permissao_recebe_403(client):
    with _patch_authenticated({"ADM"}, set()):
        r = client.get(_recon(uuid.uuid4()), headers=_auth_headers(_make_token()))
    assert r.status_code == 403


def test_reconciliacao_adm_sem_aal2_recebe_403(client):
    import time
    import jwt
    from test_imports_api import JWT_SECRET

    now = int(time.time())
    token = jwt.encode(
        {"sub": "x", "aud": "authenticated", "role": "authenticated", "iat": now,
         "exp": now + 600, "aal": "aal1"},
        JWT_SECRET, algorithm="HS256",
    )
    service = MagicMock()
    p1, p2, p3 = _patch_db_and_service(service)
    with p1, p2, p3, patch("app.api.v1.imports._bens_preview_exists", return_value=True), \
            _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = client.get(_recon(uuid.uuid4()), headers=_auth_headers(token))
    assert r.status_code == 403
    service.reconciliation_report.assert_not_called()


def test_reconciliacao_previa_inexistente_ou_de_cadastro_tem_a_mesma_404(client):
    service = MagicMock()
    p1, p2, p3 = _patch_db_and_service(service)
    with p1, p2, p3, patch("app.api.v1.imports._bens_preview_exists", return_value=False), \
            _patch_authenticated({"ADM"}, {"imports.execute"}):
        a = client.get(_recon(uuid.uuid4()), headers=_auth_headers(_make_token()))
        b = client.get(_recon(uuid.uuid4()), headers=_auth_headers(_make_token()))
    assert a.status_code == b.status_code == 404
    assert a.get_data() == b.get_data()
    service.reconciliation_report.assert_not_called()


@pytest.mark.parametrize(
    "qs",
    ["page_size=1000", "page_size=7", "page=0", "page=abc", "reason=" + "x" * 41,
     "page=1&page=2", "role=ADM", "unit_id=1", "deleted_at=1"],
)
def test_reconciliacao_query_invalida_ou_privilegiada_e_400(client, qs):
    with _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = client.get(_recon(uuid.uuid4()) + "?" + qs, headers=_auth_headers(_make_token()))
    assert r.status_code == 400
    assert "Traceback" not in r.get_data(as_text=True)


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_reconciliacao_e_somente_get(client, method):
    with _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = getattr(client, method)(_recon(uuid.uuid4()), headers=_auth_headers(_make_token()))
    assert r.status_code in (404, 405)


def test_resposta_da_reconciliacao_nao_traz_descricao_nem_pessoa(client):
    service = MagicMock()
    service.reconciliation_report.return_value = {
        "preview_id": str(uuid.uuid4()), "total_itens": 1, "localizados": 0, "nao_importados": 1,
        "por_motivo": {"novo_pendente": 1}, "total": 1, "page": 1, "page_size": 50, "pages": 1,
        "items": [{"item_id": str(uuid.uuid4()), "row": 2, "patrimony_number": "0001",
                   "classification": "NOVO", "reason_code": "novo_pendente",
                   "description": "Notebook do Fulano", "email": "f@agu.gov.br"}],
    }
    p1, p2, p3 = _patch_db_and_service(service)
    with p1, p2, p3, patch("app.api.v1.imports._bens_preview_exists", return_value=True), \
            _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = client.get(_recon(uuid.uuid4()), headers=_auth_headers(_make_token()))
    # extra="forbid" no modelo de resposta: campo extra nunca passa para o cliente
    text = r.get_data(as_text=True)
    assert "Fulano" not in text and "agu.gov.br" not in text


# -- confirmação: mass assignment e limites ------------------------------------------


@pytest.mark.parametrize(
    "extra",
    [{"role": "ADM"}, {"unit_id": str(uuid.uuid4())}, {"version": 99}, {"deleted_at": "2026-01-01"},
     {"created_by": str(uuid.uuid4())}, {"status": "CONCLUIDA"}, {"auth_user_id": "x"}],
)
def test_confirmacao_rejeita_campos_privilegiados(client, extra):
    service = MagicMock()
    p1, p2, p3 = _patch_db_and_service(service)
    body = {"preview_id": str(uuid.uuid4()), "selected_item_ids": [], **extra}
    with p1, p2, p3, _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = client.post(CONFIRM, json=body, headers=_auth_headers(_make_token()))
    assert r.status_code == 400
    service.confirm_preview.assert_not_called()


@pytest.mark.parametrize(
    "body",
    [
        {"selected_item_ids": [], "excluded_item_ids": ["nao-uuid"]},
        {"selected_item_ids": [], "excluded_item_ids": [str(uuid.uuid4())] * 10001},
        {"selected_item_ids": [str(uuid.uuid4())] * 10001},
        {"selected_item_ids": [], "excluded_item_ids": "x"},
        {"selected_item_ids": [], "select_all_eligible": {"a": 1}},
    ],
)
def test_confirmacao_limites_de_listas_e_tipos(client, body):
    service = MagicMock()
    p1, p2, p3 = _patch_db_and_service(service)
    with p1, p2, p3, _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = client.post(CONFIRM, json={"preview_id": str(uuid.uuid4()), **body},
                        headers=_auth_headers(_make_token()))
    assert r.status_code == 400
    service.confirm_preview.assert_not_called()


def test_confirmacao_sem_aal2_ou_nao_adm_nao_chega_ao_servico(client):
    service = MagicMock()
    p1, p2, p3 = _patch_db_and_service(service)
    with p1, p2, p3, _patch_authenticated({"RH"}, {"imports.execute"}):
        r = client.post(CONFIRM, json={"preview_id": str(uuid.uuid4()), "selected_item_ids": [],
                                       "select_all_eligible": True},
                        headers=_auth_headers(_make_token()))
    assert r.status_code == 403
    service.confirm_preview.assert_not_called()


def test_409_de_previa_processando_nao_vaza_detalhes_internos(client):
    from app.services.import_service import PreviewNotConfirmableError

    service = MagicMock()
    service.confirm_preview.side_effect = PreviewNotConfirmableError(
        "pré-visualização não pode ser confirmada (status atual: 'PROCESSANDO')")
    p1, p2, p3 = _patch_db_and_service(service)
    with p1, p2, p3, _patch_authenticated({"ADM"}, {"imports.execute"}):
        r = client.post(CONFIRM, json={"preview_id": str(uuid.uuid4()), "selected_item_ids": []},
                        headers=_auth_headers(_make_token()))
    assert r.status_code == 409
    text = r.get_data(as_text=True)
    assert "Traceback" not in text and "SELECT" not in text


# -- busca: injeção, curingas, DoS, escopo ---------------------------------------------


@pytest.fixture(autouse=True)
def _tabelas(monkeypatch):
    monkeypatch.setattr(base, "TABLES", (*base.TABLES, "asset_movements", "inventories"))


HOSTILE = ["' OR 1=1 --", "%", "_", "\\", "%_%", "'; DROP TABLE assets; --", "\" OR \"\"=\"",
           "a\\", "[[:alnum:]]", ".*", "(a+)+$"]


@pytest.mark.parametrize("term", HOSTILE)
def test_busca_hostil_e_literal_nao_vira_curinga_nem_quebra(ast, term):
    ast.w.asset(ast.a, "AAA111", description="Mesa comum")
    ast.w.asset(ast.a, "BBB222", description="100% literal_x")
    r = ast.client.get("/api/v1/assets", query_string={"q": term}, headers=h(ADM))
    assert r.status_code in (200, 400)
    if r.status_code == 200:
        nums = {x["patrimony_number"] for x in r.get_json()["assets"]}
        # nenhum termo hostil casa "tudo": curingas são literais
        assert nums != {"AAA111", "BBB222"}
    assert "Traceback" not in r.get_data(as_text=True)
    # tabela continua existindo
    assert ast.client.get("/api/v1/assets", headers=h(ADM)).get_json()["total"] == 2


def test_percent_e_underscore_so_casam_literalmente(ast):
    ast.w.asset(ast.a, "P1", description="desconto 100% hoje")
    ast.w.asset(ast.a, "P2", description="desconto 1000 hoje")
    ast.w.asset(ast.a, "U1", description="item a_b")
    ast.w.asset(ast.a, "U2", description="item axb")

    def nums(q):
        r = ast.client.get("/api/v1/assets", query_string={"q": q}, headers=h(ADM))
        return sorted(x["patrimony_number"] for x in r.get_json()["assets"])

    assert nums("100%") == ["P1"]
    assert nums("a_b") == ["U1"]


def test_busca_limita_tokens_e_tamanho_de_sql():
    assert len(search_tokens(" ".join(f"t{i}" for i in range(500)))) == MAX_SEARCH_TOKENS
    sql = str(select(Asset.id).where(asset_search_clause(" ".join(["ab1"] * 500)))
              .compile(dialect=postgresql.dialect()))
    # 8 tokens x (3 ILIKE + 2 EXISTS + chave) = limite fixo, independente do tamanho da entrada
    assert sql.count("EXISTS") == 2 * MAX_SEARCH_TOKENS
    assert len(sql) < 30_000


def test_q_acima_de_100_chars_e_400(ast):
    r = ast.client.get("/api/v1/assets", query_string={"q": "a" * 101}, headers=h(ADM))
    assert r.status_code == 400


def test_busca_por_responsavel_sala_e_source_record_respeita_escopo(ast):
    w = ast.w
    pb = w.person(ast.b, "Hermenegildo Exclusivo")
    rb = w.room(ast.b, "Sala Cofre Exclusiva")
    w.asset(ast.b, "ONLYB", description="X", responsible_person_id=pb, room_id=rb,
            source_record_id="SRC-SECRETO-9")
    for term in ("hermenegildo", "cofre", "SRC-SECRETO-9"):
        for sub in (USER_A, RH_A):
            r = ast.client.get("/api/v1/assets", query_string={"q": term}, headers=h(sub))
            assert r.status_code == 200 and r.get_json()["assets"] == [], (term, sub)
            assert r.get_json()["total"] == 0
        r = ast.client.get("/api/v1/assets", query_string={"q": term}, headers=h(USER_B))
        assert r.get_json()["total"] == 1, term


def test_busca_inexistente_e_fora_do_escopo_dao_a_mesma_resposta(ast):
    ast.w.asset(ast.b, "ONLYB2", description="Segredo de B")
    a = ast.client.get("/api/v1/assets", query_string={"q": "segredo de b"}, headers=h(USER_A))
    b = ast.client.get("/api/v1/assets", query_string={"q": "nada existe assim"}, headers=h(USER_A))
    assert a.status_code == b.status_code == 200
    ja, jb = a.get_json(), b.get_json()
    assert ja["assets"] == jb["assets"] == [] and ja["total"] == jb["total"] == 0


def test_exportacao_usa_a_mesma_busca_e_o_mesmo_escopo(ast):
    """report_repository reutiliza asset_search_clause AND escopo (paridade)."""
    src = (ROOT / "backend/app/services/report_repository.py").read_text(encoding="utf-8")
    assert "asset_search_clause(flt.q)" in src and "asset_scope_clause(actor_id, db)" in src
    assert not re.search(r"contains_ci\(", src.split("def fetch_assets", 1)[1].split("def ", 1)[0])


# -- frontend: contrato e sinks -----------------------------------------------------------


def test_contrato_reconciliacao_frontend_usa_items_como_o_backend():
    api = (ROOT / "frontend/src/lib/imports-api.ts").read_text(encoding="utf-8")
    panel = (ROOT / "frontend/src/components/features/imports/reconciliation-panel.tsx").read_text(
        encoding="utf-8")
    assert not re.search(r"(?<![\w])itens:", api) and "data.itens" not in panel


FRONT_FILES = [
    "frontend/src/components/features/imports/reconciliation-panel.tsx",
    "frontend/src/components/features/imports/preview-items-table.tsx",
    "frontend/src/components/features/imports/confirm-import-dialog.tsx",
    "frontend/src/lib/imports-api.ts",
    "frontend/src/components/features/assets/assets-table.tsx",
    "frontend/src/components/features/assets/patrimonios-page.tsx",
    "frontend/src/components/features/assets/use-asset-filters.ts",
]


@pytest.mark.parametrize("rel", FRONT_FILES)
def test_frontend_novo_sem_sinks_perigosos(rel):
    code = "\n".join(
        ln for ln in (ROOT / rel).read_text(encoding="utf-8").splitlines()
        if not ln.strip().startswith(("//", "*", "/*"))
    )
    for sink in ("dangerouslySetInnerHTML", "eval(", "innerHTML", "localStorage", "sessionStorage",
                 "document.write", "new Function"):
        assert sink not in code, (rel, sink)


def test_q_com_byte_nul_e_rejeitado_com_400(ast):
    ast.w.asset(ast.a, "AAA111", description="Mesa comum")
    r = ast.client.get("/api/v1/assets", query_string={"q": "\x00abc"}, headers=h(ADM))
    assert r.status_code == 400
