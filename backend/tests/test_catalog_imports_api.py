"""Testes da API de importação dos cadastros de apoio (`/api/v1/catalog-imports`).

Banco SQLite em memória (schema real, ver `_catalog_db`), serviço REAL
(`CatalogImportService`) com o cliente do Google Sheets substituído por um
dublê — nenhuma rede, nenhum banco real. Autenticação simulada como em
`test_imports_api.py` (JWT HS256 sintético + carregador de usuário mockado).
"""
from __future__ import annotations

import json
import logging
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest
from sqlalchemy import select

from _catalog_db import build_engine, new_session
from test_catalog_import_service import (
    PESSOAS,
    _client,
    _people_result,
    _rooms_result,
    _seed_units,
    _settings,
    _units_result,
)
from test_imports_api import JWT_SECRET, _auth_headers, _make_token, _patch_authenticated

from app import create_app
from app.integrations.google_sheets_client import GoogleSheetsClientError
from app.models.audit import AuditLog
from app.models.imports import ImportPreview
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit
from app.services.catalog_import_service import (
    CatalogImportService,
    CatalogSchemaError,
    CatalogSourceNotConfiguredError,
)

MOD = "app.api.v1.catalog_imports"
ALL_PERMS = {"units.update", "rooms.manage", "responsible.manage"}
PHONES = ("5563984069566", "984069566", "5563991027317", "5563992488867")
EMAILS = ("cleiton.bandera@agu.gov.br", "joao.vidal@agu.gov.br", "keily.leite@agu.gov.br")


@pytest.fixture(autouse=True)
def fake_redis():
    from test_ai_support import FakeRedis

    fake = FakeRedis()
    with patch("redis.Redis.from_url", return_value=fake):
        yield fake


@pytest.fixture()
def env():
    engine = build_engine()
    db = new_session(engine)
    _seed_units(db)
    holder = SimpleNamespace(result=_rooms_result(), settings=_settings())
    events: list[dict] = []

    @contextmanager
    def fake_session():
        yield db

    def build_service(session, sheets_client):
        return CatalogImportService(session, _client(holder.result), settings=holder.settings)

    app = create_app()
    with (
        patch(f"{MOD}.get_db_session", fake_session),
        patch(f"{MOD}.GoogleSheetsClient", MagicMock()),
        patch(f"{MOD}.CatalogImportService", build_service),
        patch("app.authorization.security_events._dispatch", side_effect=events.append),
        patch(
            "app.authorization.rbac.get_accessible_unit_ids",
            side_effect=lambda _user, session: {u.id for u in session.execute(select(Unit)).scalars()},
        ),
    ):
        yield SimpleNamespace(client=app.test_client(), db=db, holder=holder, events=events)
    db.close()


ADM_ID = uuid.uuid4()  # ADM estável: a prévia é do AUTOR (SEC-CAT-02)


def _adm(perms=ALL_PERMS, roles=frozenset({"ADM"}), user_id=None):
    return _patch_authenticated(
        role_codes=set(roles),
        permission_codes=set(perms),
        user=SimpleNamespace(id=user_id or ADM_ID, active=True),
    )


def _post_preview(env, kind, perms=ALL_PERMS, token=None, **kw):
    with _adm(perms):
        return env.client.post(
            f"/api/v1/catalog-imports/{kind}/preview",
            headers=_auth_headers(token or _make_token()),
            **kw,
        )


def _create(env, kind="rooms", result=None):
    if result is not None:
        env.holder.result = result
    response = _post_preview(env, kind)
    assert response.status_code == 201, response.get_data(as_text=True)
    return response.get_json()["preview_id"]


def _get(env, path, perms=ALL_PERMS, **kw):
    with _adm(perms):
        return env.client.get(f"/api/v1/catalog-imports/{path}", headers=_auth_headers(_make_token()), **kw)


def _confirm(env, preview_id, body, perms=ALL_PERMS):
    with _adm(perms):
        return env.client.post(
            f"/api/v1/catalog-imports/{preview_id}/confirm",
            headers=_auth_headers(_make_token()),
            json=body,
        )


def _bens_preview(env) -> str:
    now = datetime.now(timezone.utc)
    preview = ImportPreview(
        id=uuid.uuid4(),
        requested_by=uuid.uuid4(),
        source="google_sheets",
        status="CONCLUIDA",
        total_rows=0,
        count_novo=0,
        count_existente=0,
        count_duplicado=0,
        count_invalido=0,
        count_conflitante=0,
        created_at=now,
        expires_at=now + timedelta(hours=1),
    )
    env.db.add(preview)
    env.db.commit()
    return str(preview.id)


def _all_text(env, *responses) -> str:
    audits = [
        json.dumps([a.previous_values, a.new_values, a.entity_type, a.operation, a.entity_id], default=str)
        for a in env.db.execute(select(AuditLog)).scalars().all()
    ]
    return "\n".join([r.get_data(as_text=True) for r in responses] + audits + [repr(env.events)])


def _assert_no_pii(text: str) -> None:
    for secret in (*PHONES, *EMAILS):
        assert secret not in text
    assert "phone" not in text.lower().replace("has_phone", "")


# ---------------------------------------------------------------------------
# 401 / 403 / AAL2
# ---------------------------------------------------------------------------

_ID = str(uuid.uuid4())
ROUTES = [
    ("post", "/api/v1/catalog-imports/rooms/preview"),
    ("get", f"/api/v1/catalog-imports/{_ID}/report"),
    ("get", f"/api/v1/catalog-imports/{_ID}/items"),
    ("post", f"/api/v1/catalog-imports/{_ID}/confirm"),
    ("get", f"/api/v1/imports/google-sheets/{_ID}/pending"),
]


@pytest.mark.parametrize("method,url", ROUTES)
def test_sem_token_401(env, method, url):
    assert getattr(env.client, method)(url).status_code == 401


@pytest.mark.parametrize("role", ["USER", "RH"])
@pytest.mark.parametrize("method,url", ROUTES)
def test_user_e_rh_recebem_403_mesmo_com_todas_as_permissoes(env, method, url, role):
    with _adm(ALL_PERMS | {"imports.execute"}, roles={role}):
        response = getattr(env.client, method)(url, headers=_auth_headers(_make_token()))
    assert response.status_code == 403


@pytest.mark.parametrize("method,url", ROUTES)
def test_adm_sem_permissao_de_cadastro_403(env, method, url):
    with _adm(set()):
        response = getattr(env.client, method)(url, headers=_auth_headers(_make_token()))
    assert response.status_code == 403


@pytest.mark.parametrize("method,url", ROUTES)
def test_aal1_exige_aal2(env, method, url):
    now = int(datetime.now(timezone.utc).timestamp())
    token = jwt.encode(
        {"sub": "u", "aud": "authenticated", "role": "authenticated", "iat": now, "exp": now + 600, "aal": "aal1"},
        JWT_SECRET,
        algorithm="HS256",
    )
    with _adm(ALL_PERMS | {"imports.execute"}):
        response = getattr(env.client, method)(url, headers=_auth_headers(token))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"


# ---------------------------------------------------------------------------
# Prévia
# ---------------------------------------------------------------------------


def test_kind_invalido_404_e_sem_leitura_da_fonte(env):
    for kind in ("assets", "users", "ROOMS", "x" * 80, "units%27--"):
        assert _post_preview(env, kind).status_code == 404
    env.db.rollback()
    assert env.db.execute(select(ImportPreview)).first() is None


@pytest.mark.parametrize(
    "kind,needed,result",
    [
        ("units", "units.update", _units_result()),
        ("rooms", "rooms.manage", _rooms_result()),
        ("people", "responsible.manage", _people_result()),
    ],
)
def test_permissao_do_kind_e_201(env, kind, needed, result):
    env.holder.result = result
    assert _post_preview(env, kind, perms=ALL_PERMS - {needed}).status_code == 403
    # Qualquer outra permissão de cadastro não basta; só a do kind.
    response = _post_preview(env, kind, perms={needed})
    assert response.status_code == 201
    body = response.get_json()
    assert body["kind"] == kind
    assert body["summary"]["total"] == body["report"]["total"] > 0
    assert set(body["report"]) >= {"pendencias", "ids_repetidos", "nomes_suspeitos", "provaveis_duplicatas"}
    audit = env.db.execute(select(AuditLog).where(AuditLog.operation == "CREATE_CATALOG_PREVIEW")).scalar_one()
    assert audit.new_values["kind"] == kind and audit.entity_id == body["preview_id"]


def test_preview_rejeita_qualquer_corpo_e_nao_le_a_fonte(env):
    response = _post_preview(env, "rooms", json={"unit_id": str(uuid.uuid4()), "kind": "people"})
    assert response.status_code == 400
    assert any(e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT" for e in env.events)
    assert env.db.execute(select(ImportPreview)).first() is None


# ---------------------------------------------------------------------------
# Erros de domínio mapeados (mensagem genérica)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "exc,status,code",
    [
        (CatalogSourceNotConfiguredError("aba 'rooms' segredo-interno"), 409, "catalog_source_not_configured"),
        (CatalogSchemaError("coluna 'XPTO' segredo-interno"), 422, "catalog_schema_invalid"),
        (GoogleSheetsClientError("boom segredo-interno https://sheets"), 502, "upstream_unavailable"),
    ],
)
def test_erros_mapeados_sem_vazar_detalhe(env, exc, status, code):
    def boom(session, _client):
        service = MagicMock()
        if isinstance(exc, GoogleSheetsClientError):
            from app.services.import_service import UpstreamSourceError

            service.create_preview.side_effect = UpstreamSourceError(str(exc))
        else:
            service.create_preview.side_effect = exc
        return service

    with patch(f"{MOD}.CatalogImportService", boom):
        response = _post_preview(env, "rooms")
    assert response.status_code == status
    assert response.get_json()["error"]["code"] == code
    assert "segredo-interno" not in response.get_data(as_text=True)
    assert "boom" not in response.get_data(as_text=True)


def test_aba_nao_configurada_real_409(env):
    env.holder.settings = SimpleNamespace(import_preview_ttl_minutes=60)
    assert _post_preview(env, "rooms").status_code == 409


def test_coluna_ausente_real_422(env):
    from test_catalog_import_service import _sheet

    env.holder.result = _sheet(["ID", "SALA"], [["1", "3"]])
    response = _post_preview(env, "rooms")
    assert response.status_code == 422
    assert "SALA" not in response.get_data(as_text=True) or "estrutura" in response.get_data(as_text=True)


def test_falha_do_sheets_real_502(env):
    broken = MagicMock()
    broken.read_tab_rows.side_effect = GoogleSheetsClientError("falha-interna-xyz")
    with patch(
        f"{MOD}.CatalogImportService",
        lambda s, c: CatalogImportService(s, broken, settings=env.holder.settings),
    ):
        response = _post_preview(env, "rooms")
    assert response.status_code == 502
    assert "falha-interna-xyz" not in response.get_data(as_text=True)


# ---------------------------------------------------------------------------
# Relatório / itens
# ---------------------------------------------------------------------------


def test_relatorio_200(env):
    preview_id = _create(env, "rooms")
    response = _get(env, f"{preview_id}/report")
    assert response.status_code == 200
    body = response.get_json()
    assert body["report"]["kind"] == "rooms" and body["status"] == "CONCLUIDA"


def test_404_uniforme_inexistente_malformado_outro_tipo_e_sem_permissao_do_kind(env):
    rooms_id = _create(env, "rooms")
    bens_id = _bens_preview(env)
    people_id = _create(env, "people", _people_result())
    attempts = [
        (str(uuid.uuid4()), ALL_PERMS),
        ("nao-e-uuid", ALL_PERMS),
        ("1; DROP TABLE x", ALL_PERMS),
        (bens_id, ALL_PERMS),
        (people_id, {"rooms.manage"}),  # prévia de pessoas sem responsible.manage
        (rooms_id, {"units.update"}),
    ]
    for suffix in ("report", "items"):
        bodies = set()
        for raw_id, perms in attempts:
            response = _get(env, f"{raw_id}/{suffix}", perms=perms)
            assert response.status_code == 404, (raw_id, suffix)
            bodies.add(response.get_data(as_text=True))
        assert len(bodies) == 1
    bodies = set()
    for raw_id, perms in attempts:
        response = _confirm(env, raw_id, {"item_ids": []}, perms=perms)
        assert response.status_code == 404
        bodies.add(response.get_data(as_text=True))
    assert len(bodies) == 1
    assert any(e["event_type"] == "ACCESS_DENIED" for e in env.events)


def test_itens_paginacao_ordenacao_e_filtro(env):
    preview_id = _create(env, "rooms")
    first = _get(env, f"{preview_id}/items?page=1&page_size=5&sort=label").get_json()
    assert first["kind"] == "rooms" and first["total"] == 12 and len(first["items"]) == 5
    labels = [i["label"] for i in first["items"]]
    assert labels == sorted(labels)
    desc = _get(env, f"{preview_id}/items?page_size=3&sort=-label").get_json()
    assert [i["label"] for i in desc["items"]] == sorted(
        [i["label"] for i in _get(env, f"{preview_id}/items?page_size=100").get_json()["items"]],
        reverse=True,
    )[:3]
    page3 = _get(env, f"{preview_id}/items?page=3&page_size=5").get_json()
    assert len(page3["items"]) == 2
    novo = _get(env, f"{preview_id}/items?status=novo").get_json()
    assert novo["total"] == 12 and all(i["classification"] == "NOVO" for i in novo["items"])
    assert _get(env, f"{preview_id}/items?status=INVENTADO").get_json()["total"] == 0
    found = _get(env, f"{preview_id}/items?search=audit").get_json()
    assert [i["label"] for i in found["items"]] == ["Auditório"]
    assert _get(env, f"{preview_id}/items?search=%25").get_json()["total"] == 0  # '%' literal


@pytest.mark.parametrize(
    "query",
    ["?sort=phone", "?sort=-patrimony_number", "?foo=1", "?unit_id=x", "?page=0", "?page_size=101",
     "?page=1&page=2", "?status=" + "x" * 33, "?search=" + "x" * 101],
)
def test_itens_query_invalida_400(env, query):
    preview_id = _create(env, "rooms")
    assert _get(env, f"{preview_id}/items{query}").status_code == 400


def test_itens_e_relatorio_rejeitam_corpo(env):
    preview_id = _create(env, "rooms")
    with _adm():
        for suffix in ("items", "report"):
            response = env.client.get(
                f"/api/v1/catalog-imports/{preview_id}/{suffix}",
                headers=_auth_headers(_make_token()),
                json={"x": 1},
            )
            assert response.status_code == 400


def test_pessoas_nunca_expoem_telefone_nem_email_completo(env, caplog):
    caplog.set_level(logging.DEBUG)
    env.holder.result = _people_result()
    response = _post_preview(env, "people")
    assert response.status_code == 201
    preview_id = response.get_json()["preview_id"]
    report = _get(env, f"{preview_id}/report")
    items = _get(env, f"{preview_id}/items?page_size=100")
    assert items.status_code == 200
    body = items.get_json()
    cleiton = next(i for i in body["items"] if i["label"] == "CLEITON GOMES BANDEIRA")
    assert cleiton["details"]["has_phone"] is True
    assert cleiton["details"]["email_masked"] == "c***@agu.gov.br"
    assert "phone" not in cleiton["details"] and "email" not in cleiton["details"]
    assert "raw_values" not in json.dumps(body)
    confirm = _confirm(env, preview_id, {"item_ids": [i["id"] for i in body["items"]]})
    assert confirm.status_code == 200
    # O telefone foi gravado no cadastro (confirmação funciona), mas nunca vaza.
    assert env.db.execute(select(ResponsiblePerson).where(ResponsiblePerson.phone == PHONES[0])).first()
    text = _all_text(env, response, report, items, confirm) + caplog.text
    _assert_no_pii(text)
    # Itens do banco sem tipo vazam apenas pelo que a allowlist permite.
    for entry in env.events:
        assert "phone" not in json.dumps(entry, default=str).lower()


# ---------------------------------------------------------------------------
# Confirmação
# ---------------------------------------------------------------------------


def test_confirmacao_idempotente(env):
    preview_id = _create(env, "rooms")
    ids = [i["id"] for i in _get(env, f"{preview_id}/items?page_size=100").get_json()["items"]]
    first = _confirm(env, preview_id, {"item_ids": ids})
    assert first.status_code == 200
    body = first.get_json()
    assert body["created"] == 12 and body["falhas"] == [] and body["kind"] == "rooms"
    assert env.db.query(Room).count() == 12
    second = _confirm(env, preview_id, {"item_ids": ids})
    assert second.status_code == 409
    assert env.db.query(Room).count() == 12
    ops = [a.operation for a in env.db.execute(select(AuditLog)).scalars().all()]
    assert ops.count("CONFIRM_CATALOG_IMPORT") == 1


def test_confirmacao_ignora_ids_alheios_e_conta(env):
    preview_id = _create(env, "rooms")
    response = _confirm(env, preview_id, {"item_ids": [str(uuid.uuid4())]})
    assert response.status_code == 200
    assert response.get_json()["ignorados"] == 1 and response.get_json()["created"] == 0


def test_confirmacao_previa_expirada_409(env):
    preview_id = _create(env, "rooms")
    preview = env.db.get(ImportPreview, uuid.UUID(preview_id))
    preview.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    env.db.commit()
    assert _confirm(env, preview_id, {"item_ids": []}).status_code == 409


def test_units_confirma_com_permissao_units_update(env):
    preview_id = _create(env, "units", _units_result())
    ids = [i["id"] for i in _get(env, f"{preview_id}/items").get_json()["items"]]
    assert _confirm(env, preview_id, {"item_ids": ids}, perms={"units.update"}).status_code == 200
    assert env.db.query(Unit).count() == 4


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"item_ids": "x"},
        {"item_ids": ["nao-uuid"]},
        {"item_ids": [str(uuid.uuid4())] * 10001},
        {"item_ids": [], "kind": "people"},
        {"item_ids": [], "unit_id": str(uuid.uuid4())},
        {"item_ids": [], "role": "ADM", "active": True, "created_by": "x"},
        {"item_ids": [], "preview_id": str(uuid.uuid4())},
        [],
    ],
)
def test_confirm_corpo_invalido_ou_mass_assignment_400(env, body):
    preview_id = _create(env, "rooms")
    response = _confirm(env, preview_id, body)
    assert response.status_code == 400
    assert env.db.query(Room).count() == 0


def test_mass_assignment_e_auditado_como_escalonamento(env):
    preview_id = _create(env, "rooms")
    _confirm(env, preview_id, {"item_ids": [], "unit_id": str(uuid.uuid4())})
    assert any(e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT" for e in env.events)


def test_limite_exato_de_10000_itens_e_aceito(env):
    preview_id = _create(env, "rooms")
    response = _confirm(env, preview_id, {"item_ids": [str(uuid.uuid4()) for _ in range(10000)]})
    assert response.status_code == 200 and response.get_json()["ignorados"] == 10000


# ---------------------------------------------------------------------------
# Rate limit / Redis
# ---------------------------------------------------------------------------


def test_preview_excedido_429(env):
    env.holder.settings = SimpleNamespace(import_preview_ttl_minutes=60)  # 409 barato
    me = SimpleNamespace(id=uuid.uuid4(), active=True)
    codes = []
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=ALL_PERMS, user=me):
        for _ in range(12):
            codes.append(
                env.client.post(
                    "/api/v1/catalog-imports/rooms/preview", headers=_auth_headers(_make_token())
                ).status_code
            )
    assert codes[:10] == [409] * 10 and codes[10:] == [429, 429]


def test_confirm_excedido_429(env):
    me = SimpleNamespace(id=uuid.uuid4(), active=True)
    codes = []
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=ALL_PERMS, user=me):
        for _ in range(11):
            codes.append(
                env.client.post(
                    f"/api/v1/catalog-imports/{uuid.uuid4()}/confirm",
                    headers=_auth_headers(_make_token()),
                    json={"item_ids": []},
                ).status_code
            )
    assert codes[-1] == 429 and set(codes[:-1]) == {404}


@pytest.mark.parametrize("method,url", ROUTES[:4])
def test_redis_fora_bloqueia_503(env, method, url):
    import redis as redis_lib

    broken = MagicMock()
    broken.incr.side_effect = redis_lib.exceptions.ConnectionError("x")
    with patch("redis.Redis.from_url", return_value=broken), _adm():
        response = getattr(env.client, method)(url, headers=_auth_headers(_make_token()), **(
            {"json": {"item_ids": []}} if method == "post" else {}
        ))
    assert response.status_code == 503
    assert env.db.execute(select(ImportPreview)).first() is None


# ---------------------------------------------------------------------------
# /imports (bens): pending_counts e pendências
# ---------------------------------------------------------------------------

IMP = "app.api.v1.imports"


def _bens_patches(service):
    @contextmanager
    def fake_session():
        yield MagicMock()

    return (
        patch(f"{IMP}.get_db_session", fake_session),
        patch(f"{IMP}.ImportService", MagicMock(return_value=service)),
        patch(f"{IMP}.GoogleSheetsClient", MagicMock()),
    )


def test_preview_de_bens_expoe_pending_counts_sem_quebrar_summary(env):
    preview = SimpleNamespace(
        id=uuid.uuid4(), total_rows=1, count_novo=1, count_existente=0, count_duplicado=0,
        count_invalido=0, count_conflitante=0, expires_at=datetime.now(timezone.utc),
        pending_counts={"sala_nao_encontrada": 2},
    )
    service = MagicMock()
    service.create_preview.return_value = preview
    p = _bens_patches(service)
    with _patch_authenticated({"ADM"}, {"imports.execute"}), p[0], p[1], p[2]:
        response = env.client.post(
            "/api/v1/imports/google-sheets/preview", headers=_auth_headers(_make_token())
        )
    body = response.get_json()
    assert response.status_code == 201
    assert body["pending_counts"] == {"sala_nao_encontrada": 2}
    assert set(body["summary"]) == {"total", "novo", "existente", "duplicado", "invalido", "conflitante"}


def test_pending_de_bens_200_e_404_para_previa_de_cadastro(env):
    bens_id = uuid.UUID(_bens_preview(env))
    catalog_id = uuid.UUID(_create(env, "rooms"))
    service = MagicMock()
    service.pending_report.return_value = {"sala_nao_encontrada": 3}
    p = _bens_patches(service)
    sess = MagicMock()

    @contextmanager
    def real_session():
        yield env.db

    with (
        _patch_authenticated({"ADM"}, {"imports.execute"}),
        patch(f"{IMP}.get_db_session", real_session),
        patch(f"{IMP}.ImportService", MagicMock(return_value=service)),
        patch(f"{IMP}.GoogleSheetsClient", MagicMock()),
    ):
        ok = env.client.get(f"/api/v1/imports/google-sheets/{bens_id}/pending", headers=_auth_headers(_make_token()))
        wrong_type = env.client.get(f"/api/v1/imports/google-sheets/{catalog_id}/pending", headers=_auth_headers(_make_token()))
        missing = env.client.get(f"/api/v1/imports/google-sheets/{uuid.uuid4()}/pending", headers=_auth_headers(_make_token()))
        malformed = env.client.get("/api/v1/imports/google-sheets/abc/pending", headers=_auth_headers(_make_token()))
    del p, sess
    assert ok.status_code == 200 and ok.get_json()["pending_counts"] == {"sala_nao_encontrada": 3}
    assert wrong_type.status_code == missing.status_code == malformed.status_code == 404
    assert wrong_type.get_json() == missing.get_json() == malformed.get_json()
    service.pending_report.assert_called_once_with(bens_id)
