"""Testes do endpoint `GET /api/v1/me` (`app.api.v1.me`).

Usa `app.test_client()`. Autenticação é simulada emitindo um JWT HS256 real
(assinado com o mesmo `SUPABASE_JWT_SECRET` fictício definido em
`backend/tests/conftest.py`), incluindo o claim `aal` quando relevante, e
mockando `app.auth.supabase_auth._load_user_with_roles_and_permissions` para
controlar o usuário/papéis/permissões retornados — sem abrir nenhuma
conexão real de banco (mesmo espírito de `test_imports_api.py`).
"""
from __future__ import annotations

import time
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import jwt
import pytest

from app import create_app

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # igual ao default de backend/tests/conftest.py


@pytest.fixture()
def app():
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


def _make_token(sub: str = "auth-user-1", aal: str | None = None) -> str:
    # Claims mínimos de um JWT real do Supabase Auth (exp/iat/aud/role são
    # exigidos por `require_auth` desde a auditoria 2026-10-13).
    now = int(time.time())
    claims: dict[str, object] = {
        "sub": sub,
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
    }
    if aal is not None:
        claims["aal"] = aal
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _fake_user(name: str = "Fulano", email: str = "fulano@exemplo.com") -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(), name=name, email=email, active=True, auth_user_id="auth-user-1"
    )


ME_URL = "/api/v1/me"


def test_me_sem_token_retorna_401(client):
    response = client.get(ME_URL)
    assert response.status_code == 401


def test_me_usuario_adm_sem_aal2_mfa_required_true_current_aal_aal1(client):
    token = _make_token(aal="aal1")
    fake_user = _fake_user()

    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, {"ADM"}, {"users.invite"}),
    ):
        response = client.get(ME_URL, headers=_auth_headers(token))

    assert response.status_code == 200
    body = response.get_json()
    assert body["current_aal"] == "aal1"
    assert body["mfa_required"] is True
    assert body["roles"] == ["ADM"]
    assert body["permissions"] == ["users.invite"]
    assert body["email"] == fake_user.email
    assert body["name"] == fake_user.name
    assert body["id"] == str(fake_user.id)


def test_me_usuario_user_mfa_required_false(client):
    token = _make_token(aal="aal1")
    fake_user = _fake_user(name="Usuário Comum", email="user@exemplo.com")

    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, {"USER"}, {"assets.read"}),
    ):
        response = client.get(ME_URL, headers=_auth_headers(token))

    assert response.status_code == 200
    body = response.get_json()
    assert body["mfa_required"] is False
    assert body["roles"] == ["USER"]


def test_me_usuario_adm_com_aal2_mfa_required_ainda_true(client):
    """`mfa_required` reflete a política (papel ADM), não o AAL atual da
    sessão — mesmo já em aal2, a flag continua true para um ADM."""
    token = _make_token(aal="aal2")
    fake_user = _fake_user()

    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, {"ADM"}, {"users.invite"}),
    ):
        response = client.get(ME_URL, headers=_auth_headers(token))

    assert response.status_code == 200
    body = response.get_json()
    assert body["current_aal"] == "aal2"
    assert body["mfa_required"] is True


def test_me_claim_aal_ausente_vira_aal1(client):
    token = _make_token(aal=None)
    fake_user = _fake_user()

    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, {"USER"}, set()),
    ):
        response = client.get(ME_URL, headers=_auth_headers(token))

    assert response.status_code == 200
    body = response.get_json()
    assert body["current_aal"] == "aal1"
