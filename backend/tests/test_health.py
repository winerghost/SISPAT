"""Testes do endpoint de healthcheck (`app.api.v1.health`).

Usa `app.test_client()`. A sessão de banco de dados é sempre mockada — este
arquivo nunca abre uma conexão real. Cobre tanto `GET /api/v1/health`
(rota versionada) quanto `GET /api/health` (alias legado referenciado no
`docker-compose.yml`/`Dockerfile`), nos caminhos de sucesso (200) e de
falha de conectividade (503).

Observação sobre o ambiente deste sandbox: este arquivo foi de fato
executado com `pytest` neste ambiente (SQLAlchemy/Flask/PyJWT instalados
sob demanda) — ver relatório da tarefa para o resultado real da execução.
"""
from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from app import create_app


@pytest.fixture()
def app():
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


@contextmanager
def _fake_get_db_session(session):
    """Substitui `get_db_session()` por um context manager que apenas entrega `session`."""
    yield session


def test_health_v1_sucesso_retorna_200(client):
    fake_session = MagicMock()

    with patch("app.api.v1.health.get_db_session", lambda: _fake_get_db_session(fake_session)):
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}
    fake_session.execute.assert_called_once()


def test_health_legacy_alias_sucesso_retorna_200(client):
    """`GET /api/health` (alias legado) deve responder da mesma forma que `/api/v1/health`."""
    fake_session = MagicMock()

    with patch("app.api.v1.health.get_db_session", lambda: _fake_get_db_session(fake_session)):
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_health_v1_falha_conectividade_retorna_503(client):
    @contextmanager
    def _raise_get_db_session():
        raise RuntimeError("conexão recusada")
        yield  # pragma: no cover - nunca alcançado; mantém a forma de gerador.

    with patch("app.api.v1.health.get_db_session", _raise_get_db_session):
        response = client.get("/api/v1/health")

    assert response.status_code == 503
    body = response.get_json()
    assert body["error"]["code"] == "service_unavailable"
    # Nenhum detalhe interno (ex.: a mensagem "conexão recusada") deve
    # aparecer na resposta ao cliente.
    assert "conexão recusada" not in str(body)


def test_health_legacy_falha_conectividade_retorna_503(client):
    @contextmanager
    def _raise_get_db_session():
        raise RuntimeError("conexão recusada")
        yield  # pragma: no cover

    with patch("app.api.v1.health.get_db_session", _raise_get_db_session):
        response = client.get("/api/health")

    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "service_unavailable"
