"""M-1 (REVISAO_AUTHZ 2026-10-19): JSON profundamente aninhado nunca vira 500.

`get_json_body` (app.api.v1.schemas) e o unico ponto de leitura do corpo JSON
das rotas; `RecursionError` do parser vira o mesmo 400 de corpo invalido.
B-3: `safe_scalar` redige inteiro de 11 digitos (CPF sem mascara).
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from test_imports_api import (  # noqa: F401
    CONFIRM_URL,
    _auth_headers,
    _make_token,
    _patch_authenticated,
    app,
    client,
)
from test_user_admin_db import api, auth_headers, world  # noqa: F401

from app.services.admin_audit_service import REDACTED, safe_scalar

NESTED = b"[" * 50000
_JSON = {"Content-Type": "application/json"}


@pytest.fixture()
def redis_ok():
    from test_ai_support import FakeRedis

    with patch("redis.Redis.from_url", return_value=FakeRedis()):
        yield


def test_get_json_body_converte_recursion_error_em_valor_nao_objeto(app):
    from flask import request

    from app.api.v1.schemas import get_json_body

    with app.test_request_context("/x", method="POST", data=NESTED, headers=_JSON):
        body = get_json_body()
        assert body == [] and not isinstance(body, dict) and body is not None
        assert request.get_data()  # corpo continua legivel


@pytest.mark.parametrize(
    "url,perms",
    [
        ("/api/v1/users/invite", {"users.invite"}),
        (f"/api/v1/users/{uuid.uuid4()}/revoke", {"users.revoke_access"}),
        (f"/api/v1/users/{uuid.uuid4()}/activate-invite", set()),
        (CONFIRM_URL, {"imports.execute"}),
    ],
)
def test_json_aninhado_em_rotas_de_usuarios_e_importacao_e_400(client, redis_ok, url, perms):  # noqa: F811
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=perms):
        response = client.post(url, data=NESTED, headers={**_auth_headers(_make_token()), **_JSON})
    assert response.status_code in (400, 404), (url, response.status_code)
    assert response.status_code != 500
    assert "Traceback" not in response.get_data(as_text=True)


@pytest.mark.parametrize("url", ["/api/v1/users/invite", CONFIRM_URL])
def test_json_aninhado_responde_400_exato_nas_rotas_principais(client, redis_ok, url):  # noqa: F811
    perms = {"users.invite", "imports.execute"}
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=perms):
        response = client.post(url, data=NESTED, headers={**_auth_headers(_make_token()), **_JSON})
    assert response.status_code == 400


def test_json_aninhado_em_me_preferences_e_400(api):  # noqa: F811
    unit = api.world.unit("A")
    api.world.user("Pref", role="USER", units=[unit], auth_user_id="auth-depth")
    response = api.client.patch(
        "/api/v1/me/preferences",
        data=NESTED,
        headers={**auth_headers("auth-depth", aal="aal1"), **_JSON},
    )
    assert response.status_code == 400


def test_revoke_aninhado_e_400_com_adm_real(api):  # noqa: F811
    unit = api.world.unit("A")
    api.world.user("Adm", role="ADM", units=[unit], auth_user_id="auth-depth-adm")
    target = api.world.user("Alvo", role="USER", units=[unit], auth_user_id="auth-depth-alvo")
    response = api.client.post(
        f"/api/v1/users/{target}/revoke",
        data=NESTED,
        headers={**auth_headers("auth-depth-adm", aal="aal2"), **_JSON},
    )
    assert response.status_code == 400


@pytest.mark.parametrize("value", [12345678909, -12345678909])
def test_safe_scalar_redige_inteiro_de_11_digitos(value):
    assert safe_scalar(value) == REDACTED


@pytest.mark.parametrize("value", [0, 42, 1234567890, 123456789012])
def test_safe_scalar_preserva_outros_inteiros(value):
    assert safe_scalar(value) == value
