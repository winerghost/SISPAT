"""Testes dos endpoints de importação (`app.api.v1.imports`).

Usa `app.test_client()`. Autenticação é simulada emitindo um JWT HS256 real
(assinado com o mesmo `SUPABASE_JWT_SECRET` fictício definido em
`backend/tests/conftest.py`) e mockando
`app.auth.supabase_auth._load_user_with_roles_and_permissions` para
controlar o usuário/papéis/permissões retornados — sem abrir nenhuma
conexão real de banco (mesmo espírito de `test_rbac.py`/`test_health.py`).

A camada de serviço (`ImportService`) é sempre mockada aqui — sua lógica de
negócio já é testada isoladamente em `test_import_service.py`. Este arquivo
cobre apenas o contrato HTTP: autenticação/autorização (401/403) e o
mapeamento de erros de domínio para códigos HTTP (404/409/502).
"""
from __future__ import annotations

import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest

from app import create_app
from app.services.import_service import (
    PreviewNotConfirmableError,
    PreviewNotFoundError,
    UpstreamSourceError,
)

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # igual ao default de backend/tests/conftest.py


@pytest.fixture(autouse=True)
def fake_redis():
    """Redis em memória p/ o rate limit (B-1); o fail-closed é testado à parte."""
    from test_ai_support import FakeRedis

    fake = FakeRedis()
    with patch("redis.Redis.from_url", return_value=fake):
        yield fake


@pytest.fixture()
def app():
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


def _make_token(sub: str = "auth-user-1") -> str:
    # Claims mínimos de um JWT real do Supabase Auth, em sessão AAL2 (as
    # rotas de importação exigem `require_aal2` desde a auditoria 2026-10-13).
    now = int(time.time())
    claims = {
        "sub": sub,
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        "aal": "aal2",
    }
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def _auth_headers(token: str | None) -> dict[str, str]:
    if token is None:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _fake_user(user_id: uuid.UUID | None = None, active: bool = True) -> SimpleNamespace:
    return SimpleNamespace(id=user_id or uuid.uuid4(), active=active)


@contextmanager
def _fake_get_db_session(session):
    yield session


@contextmanager
def _patch_authenticated(role_codes: set[str], permission_codes: set[str], user=None):
    """Faz `require_auth` "autenticar com sucesso" como um usuário com os
    papéis/permissões informados, sem tocar o banco."""
    fake_user = user or _fake_user()
    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, set(role_codes), set(permission_codes)),
    ):
        yield fake_user


def _patch_db_and_service(mock_service_instance: MagicMock):
    """Patcha `get_db_session` (sessão fake) e `ImportService` (classe
    mockada, cuja instância é `mock_service_instance`) dentro de
    `app.api.v1.imports`."""
    fake_session = MagicMock()
    mock_service_class = MagicMock(return_value=mock_service_instance)
    return (
        patch("app.api.v1.imports.get_db_session", lambda: _fake_get_db_session(fake_session)),
        patch("app.api.v1.imports.ImportService", mock_service_class),
        patch("app.api.v1.imports.GoogleSheetsClient", MagicMock()),
    )


PREVIEW_URL = "/api/v1/imports/google-sheets/preview"
CONFIRM_URL = "/api/v1/imports/google-sheets/confirm"


def _items_url(preview_id: uuid.UUID) -> str:
    return f"/api/v1/imports/google-sheets/preview/{preview_id}/items"


# ---------------------------------------------------------------------------
# POST /google-sheets/preview
# ---------------------------------------------------------------------------


def test_preview_sem_token_retorna_401(client):
    response = client.post(PREVIEW_URL)
    assert response.status_code == 401


def test_preview_sem_papel_adm_retorna_403(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"USER"}, permission_codes={"imports.execute"}):
        response = client.post(PREVIEW_URL, headers=_auth_headers(token))
    assert response.status_code == 403


def test_preview_com_papel_adm_mas_sem_permissao_retorna_403(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=set()):
        response = client.post(PREVIEW_URL, headers=_auth_headers(token))
    assert response.status_code == 403


def test_preview_adm_com_permissao_retorna_201(client):
    token = _make_token()
    preview_id = uuid.uuid4()
    fake_preview = SimpleNamespace(
        id=preview_id,
        total_rows=10,
        count_novo=4,
        count_existente=3,
        count_duplicado=1,
        count_invalido=1,
        count_conflitante=1,
        expires_at=datetime.now(timezone.utc),
    )
    mock_service = MagicMock()
    mock_service.create_preview.return_value = fake_preview

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}) as user:
        with patches[0], patches[1], patches[2]:
            response = client.post(PREVIEW_URL, headers=_auth_headers(token))

    assert response.status_code == 201
    body = response.get_json()
    assert body["preview_id"] == str(preview_id)
    assert body["summary"] == {
        "total": 10,
        "novo": 4,
        "existente": 3,
        "duplicado": 1,
        "invalido": 1,
        "conflitante": 1,
    }
    mock_service.create_preview.assert_called_once_with(requested_by_user_id=user.id)


def test_preview_falha_upstream_retorna_502(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.create_preview.side_effect = UpstreamSourceError("boom")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(PREVIEW_URL, headers=_auth_headers(token))

    assert response.status_code == 502
    body = response.get_json()
    # Nenhum detalhe interno ("boom") deve aparecer na resposta ao cliente.
    assert "boom" not in str(body)


# ---------------------------------------------------------------------------
# GET /google-sheets/preview/<id>/items
# ---------------------------------------------------------------------------


def test_list_items_sem_token_retorna_401(client):
    response = client.get(_items_url(uuid.uuid4()))
    assert response.status_code == 401


def test_list_items_sem_permissao_retorna_403(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"RH"}, permission_codes=set()):
        response = client.get(_items_url(uuid.uuid4()), headers=_auth_headers(token))
    assert response.status_code == 403


def test_list_items_sucesso_retorna_200(client):
    token = _make_token()
    preview_id = uuid.uuid4()
    item = SimpleNamespace(
        id=uuid.uuid4(),
        source_record_id="1",
        patrimony_number="100",
        description="desc",
        classification="NOVO",
        selected=True,
        matched_asset_id=None,
        validation_errors=None,
    )
    mock_service = MagicMock()
    mock_service.list_preview_items.return_value = {
        "total": 1,
        "page": 1,
        "page_size": 50,
        "pages": 1,
        "items": [item],
    }

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        with patches[0], patches[1], patches[2], patch(
            "app.api.v1.imports._bens_preview_exists", return_value=True
        ):
            response = client.get(
                _items_url(preview_id) + "?status=NOVO&search=100&page=1&page_size=50",
                headers=_auth_headers(token),
            )

    assert response.status_code == 200
    body = response.get_json()
    assert body["total"] == 1
    assert body["items"][0]["patrimony_number"] == "100"
    mock_service.list_preview_items.assert_called_once_with(
        preview_id, status="NOVO", search="100", page=1, page_size=50
    )


def test_list_items_preview_inexistente_retorna_404(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.list_preview_items.side_effect = PreviewNotFoundError("não encontrada")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        with patches[0], patches[1], patches[2]:
            response = client.get(_items_url(uuid.uuid4()), headers=_auth_headers(token))

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /google-sheets/confirm
# ---------------------------------------------------------------------------


def test_confirm_sem_token_retorna_401(client):
    response = client.post(CONFIRM_URL, json={"preview_id": str(uuid.uuid4()), "selected_item_ids": []})
    assert response.status_code == 401


def test_confirm_sem_papel_adm_retorna_403(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"USER"}, permission_codes={"imports.execute"}):
        response = client.post(
            CONFIRM_URL,
            json={"preview_id": str(uuid.uuid4()), "selected_item_ids": []},
            headers=_auth_headers(token),
        )
    assert response.status_code == 403


def test_confirm_corpo_invalido_retorna_400(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        response = client.post(CONFIRM_URL, json={"preview_id": 123}, headers=_auth_headers(token))
    assert response.status_code == 400


def test_confirm_adm_com_permissao_sucesso_200(client):
    token = _make_token()
    preview_id = uuid.uuid4()
    item_id = uuid.uuid4()
    sync_job_id = uuid.uuid4()

    mock_service = MagicMock()
    mock_service.confirm_preview.return_value = {
        "sync_job_id": sync_job_id,
        "status": "CONCLUIDO",
        "created": 1,
        "updated": 0,
        "ignorados": 0,
        "inalterados": 0,
        "nao_gravados": {
            "total": 0, "por_classificacao": {}, "por_motivo": {}, "nao_selecionados": 0,
        },
        "pendencias_vinculo": {},
        "falhas_total": 0,
        "falhas": [],
    }

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}) as user:
        with patches[0], patches[1], patches[2]:
            response = client.post(
                CONFIRM_URL,
                json={"preview_id": str(preview_id), "selected_item_ids": [str(item_id)]},
                headers=_auth_headers(token),
            )

    assert response.status_code == 200
    body = response.get_json()
    assert body["sync_job_id"] == str(sync_job_id)
    assert body["created"] == 1 and body["status"] == "CONCLUIDO" and body["degraded"] is False
    mock_service.confirm_preview.assert_called_once_with(
        preview_id=preview_id, confirmed_by_user_id=user.id, selected_item_ids=[item_id]
    )


def test_confirm_preview_inexistente_retorna_404(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.confirm_preview.side_effect = PreviewNotFoundError("não encontrada")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(
                CONFIRM_URL,
                json={"preview_id": str(uuid.uuid4()), "selected_item_ids": []},
                headers=_auth_headers(token),
            )

    assert response.status_code == 404


def test_confirm_preview_expirada_ou_ja_confirmada_retorna_409(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.confirm_preview.side_effect = PreviewNotConfirmableError("expirada")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(
                CONFIRM_URL,
                json={"preview_id": str(uuid.uuid4()), "selected_item_ids": []},
                headers=_auth_headers(token),
            )

    assert response.status_code == 409


# ---------------------------------------------------------------------------
# B-1 / B-2 — rate limit, query estrita e corpo proibido no preview
# ---------------------------------------------------------------------------


def _adm():
    return _patch_authenticated(role_codes={"ADM"}, permission_codes={"imports.execute"})


def test_preview_excedido_retorna_429(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.create_preview.side_effect = UpstreamSourceError("x")
    p = _patch_db_and_service(mock_service)
    codes = []
    with _adm(), p[0], p[1], p[2]:
        for _ in range(12):
            codes.append(client.post(PREVIEW_URL, headers=_auth_headers(token)).status_code)
    assert codes[:10] == [502] * 10 and codes[10:] == [429, 429]


def test_confirm_excedido_retorna_429(client):
    token = _make_token()
    p = _patch_db_and_service(MagicMock(side_effect=PreviewNotFoundError("x")))
    codes = []
    with _adm(), p[0], p[1], p[2]:
        for _ in range(11):
            codes.append(client.post(CONFIRM_URL, headers=_auth_headers(token), json={}).status_code)
    assert codes[-1] == 429 and set(codes[:-1]) == {400}


@pytest.mark.parametrize("url", [PREVIEW_URL, CONFIRM_URL, _items_url(uuid.UUID(int=1))])
def test_imports_redis_fora_bloqueia_503(client, url):
    import redis as redis_lib

    broken = MagicMock()
    broken.incr.side_effect = redis_lib.exceptions.ConnectionError("x")
    mock_service = MagicMock()
    p = _patch_db_and_service(mock_service)
    method = client.get if "items" in url else client.post
    with patch("redis.Redis.from_url", return_value=broken), _adm(), p[0], p[1], p[2]:
        response = method(url, headers=_auth_headers(_make_token()))
    assert response.status_code == 503
    mock_service.assert_not_called()
    assert not mock_service.method_calls


def test_preview_rejeita_qualquer_corpo(client):
    mock_service = MagicMock()
    p = _patch_db_and_service(mock_service)
    with _adm(), p[0], p[1], p[2]:
        response = client.post(PREVIEW_URL, headers=_auth_headers(_make_token()), json={"role": "ADM"})
    assert response.status_code == 400
    mock_service.create_preview.assert_not_called()


@pytest.mark.parametrize(
    "query",
    ["?foo=1", "?role=ADM", "?page=0", "?page=abc", "?page_size=101", "?status=" + "x" * 33,
     "?search=" + "x" * 201, "?page=1&page=2"],
)
def test_items_query_invalida_ou_desconhecida_400(client, query):
    mock_service = MagicMock()
    p = _patch_db_and_service(mock_service)
    with _adm(), p[0], p[1], p[2]:
        response = client.get(_items_url(uuid.uuid4()) + query, headers=_auth_headers(_make_token()))
    assert response.status_code == 400
    mock_service.list_preview_items.assert_not_called()
