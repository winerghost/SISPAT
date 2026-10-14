"""Testes de segurança — cabeçalhos HTTP, CORS, limites e tratamento de erros.

Regressão de: ausência de cabeçalhos de segurança/`Cache-Control: no-store`,
ausência de `MAX_CONTENT_LENGTH`, CORS com `Allow-Credentials` e métodos não
usados, e vazamento de detalhes internos em respostas de erro (A05/A09/A10).
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from flask import Blueprint

from app import create_app

ALLOWED_ORIGIN = "http://localhost:3000"  # tests/conftest.py


@contextmanager
def _fake_session_cm(session):
    yield session


@pytest.fixture()
def app():
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def healthy_db():
    with patch("app.api.v1.health.get_db_session", lambda: _fake_session_cm(MagicMock())):
        yield


_EXPECTED_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


@pytest.mark.parametrize(
    "method,url",
    [
        ("GET", "/api/v1/health"),
        ("GET", "/api/v1/me"),  # 401
        ("GET", "/api/v1/rota-inexistente"),  # 404
        ("PUT", "/api/v1/users/invite"),  # 405
    ],
)
def test_cabecalhos_de_seguranca_em_todas_as_respostas(client, healthy_db, method, url):
    response = client.open(url, method=method)
    for name, value in _EXPECTED_HEADERS.items():
        assert response.headers.get(name) == value, name
    csp = response.headers.get("Content-Security-Policy", "")
    assert "default-src 'none'" in csp and "frame-ancestors 'none'" in csp
    assert response.headers.get("X-Request-ID")
    assert response.is_json


def test_request_id_do_cliente_nao_e_refletido(client, healthy_db):
    forged = "forjado-pelo-cliente<script>"
    response = client.get("/api/v1/health", headers={"X-Request-ID": forged})
    assert response.headers["X-Request-ID"] != forged
    assert len(response.headers["X-Request-ID"]) == 32  # uuid4().hex gerado pelo servidor


def test_hsts_somente_em_https(client, healthy_db):
    assert "Strict-Transport-Security" not in client.get("/api/v1/health").headers
    https = client.get("/api/v1/health", base_url="https://localhost")
    assert https.headers["Strict-Transport-Security"].startswith("max-age=")


def test_405_padronizado_com_allow(client):
    response = client.put("/api/v1/users/invite")
    assert response.status_code == 405
    assert response.get_json()["error"]["code"] == "method_not_allowed"
    assert "POST" in response.headers.get("Allow", "")


def test_corpo_acima_do_limite_retorna_413_json(client):
    payload = b"{" + b'"a":"' + b"x" * (1_048_576 + 10) + b'"}'
    response = client.post(
        "/api/v1/users/invite", data=payload, content_type="application/json",
        headers={"Authorization": "Bearer x"},
    )
    assert response.status_code in (401, 413)  # auth pode negar antes de ler o corpo
    response = client.post("/api/v1/users/activate-invite", data=payload, content_type="application/json")
    assert response.status_code in (401, 413)


def test_413_padronizado_quando_corpo_e_lido(app):
    bp = Blueprint("t413", __name__)

    @bp.route("/t413", methods=["POST"])
    def _read_body():
        from flask import request

        request.get_data()
        return "ok"

    app.register_blueprint(bp)
    response = app.test_client().post("/t413", data=b"x" * (1_048_576 + 1))
    assert response.status_code == 413
    assert response.get_json()["error"]["code"] == "payload_too_large"


def test_excecao_nao_tratada_nao_vaza_detalhes(app):
    bp = Blueprint("boom", __name__)

    @bp.route("/boom")
    def _boom():
        raise RuntimeError("SELECT * FROM users WHERE senha='segredo' -- /srv/app/x.py")

    app.register_blueprint(bp)
    response = app.test_client().get("/boom")
    assert response.status_code == 500
    body = response.get_data(as_text=True)
    assert response.get_json() == {
        "error": {"code": "internal_error", "message": "Erro interno do servidor."}
    }
    assert "SELECT" not in body and "Traceback" not in body and "segredo" not in body


def test_erro_no_servico_de_usuarios_vira_500_generico(client):
    """Exceção inesperada (ex.: IntegrityError) em rota real -> 500 genérico."""
    import time

    import jwt

    token = jwt.encode(
        {"sub": "a", "aud": "authenticated", "role": "authenticated",
         "iat": int(time.time()), "exp": int(time.time()) + 60, "aal": "aal2"},
        "test-jwt-secret-sintetico-com-32-bytes-ou-mais", algorithm="HS256",
    )
    user = SimpleNamespace(id=uuid.uuid4(), active=True)
    session = MagicMock()
    session.query.side_effect = RuntimeError("psycopg2.errors.UndefinedTable: relation users")
    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(user, {"ADM"}, {"users.manage"}),
    ), patch("app.api.v1.users.get_db_session", lambda: _fake_session_cm(session)):
        response = client.get("/api/v1/users", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 500
    assert "psycopg2" not in response.get_data(as_text=True)


# --- CORS ---------------------------------------------------------------------


def test_cors_origem_permitida_sem_credentials_e_metodos_restritos(client, healthy_db):
    response = client.get("/api/v1/health", headers={"Origin": ALLOWED_ORIGIN})
    assert response.headers["Access-Control-Allow-Origin"] == ALLOWED_ORIGIN
    assert "Access-Control-Allow-Credentials" not in response.headers
    methods = {m.strip() for m in response.headers["Access-Control-Allow-Methods"].split(",")}
    assert methods == {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
    assert "Origin" in response.headers.get("Vary", "")


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "null", "http://localhost:3000.evil.example", "http://LOCALHOST:3000"]
)
def test_cors_origem_nao_permitida_sem_cabecalhos(client, healthy_db, origin):
    response = client.get("/api/v1/health", headers={"Origin": origin})
    assert "Access-Control-Allow-Origin" not in response.headers
    preflight = client.options(
        "/api/v1/users/invite",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )
    assert "Access-Control-Allow-Origin" not in preflight.headers


def test_preflight_origem_permitida(client):
    response = client.options(
        "/api/v1/users/invite",
        headers={"Origin": ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == ALLOWED_ORIGIN
