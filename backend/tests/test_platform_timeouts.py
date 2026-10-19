"""Falhas de timeout/infra do banco devem virar JSON padronizado (sem 500 vazio)."""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from flask import Flask
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app.errors import register_error_handlers

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


class _PgError(Exception):
    def __init__(self, pgcode):
        super().__init__("SELECT secret FROM x -- detalhe interno")
        self.pgcode = pgcode


class _PgConnError(Exception):
    pgcode = "08006"


_PgConnError.__module__ = "psycopg2.errors"


@pytest.fixture()
def client():
    app = Flask(__name__)
    register_error_handlers(app)

    def _raiser(exc):
        def view():
            raise exc

        return view

    cases = {
        "cancel": DBAPIError("SELECT 1", {}, _PgError("57014")),
        "pool": PoolTimeoutError("QueuePool limit"),
        "oper": OperationalError("SELECT 1", {}, _PgConnError("SELECT 1")),
        "schema": OperationalError("SELECT 1", {}, _PgError(None)),
        "builtin": TimeoutError("socket detalhe"),
        "other": RuntimeError("boom"),
    }
    for name, exc in cases.items():
        app.add_url_rule(f"/{name}", name, _raiser(exc))
    return app.test_client()


def _assert_safe(resp):
    body = resp.get_json()
    assert set(body["error"]) == {"code", "message"}
    text = resp.get_data(as_text=True)
    assert "SELECT" not in text and "QueuePool" not in text and "socket" not in text
    return body["error"]["code"]


def test_statement_timeout_vira_504(client):
    resp = client.get("/cancel")
    assert resp.status_code == 504
    assert _assert_safe(resp) == "request_timeout"


def test_builtin_timeout_vira_504(client):
    resp = client.get("/builtin")
    assert resp.status_code == 504
    assert _assert_safe(resp) == "request_timeout"


@pytest.mark.parametrize("path", ["pool", "oper"])
def test_banco_indisponivel_vira_503(client, path):
    resp = client.get(f"/{path}")
    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "5"
    assert _assert_safe(resp) == "database_unavailable"


def test_erro_de_esquema_nao_driver_continua_500(client):
    assert client.get("/schema").status_code == 500


def test_erro_inesperado_continua_500(client):
    resp = client.get("/other")
    assert resp.status_code == 500
    assert _assert_safe(resp) == "internal_error"


def test_dockerfile_timeout_maior_que_statement_timeout():
    text = DOCKERFILE.read_text(encoding="utf-8")
    timeout = int(re.search(r'"--timeout", "(\d+)"', text).group(1))
    assert timeout >= 150  # > DB_STATEMENT_TIMEOUT_MS (120 s) + folga
    assert '"--graceful-timeout"' in text
