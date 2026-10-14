"""Testes de autorização RBAC (`app.authorization.rbac`).

Testa `require_permission`, `require_role` (incluindo a combinação dos
dois, o padrão recomendado para endpoints administrativos críticos) e
`has_unit_access`, com usuários mockados (`unittest.mock`) — nenhuma
conexão real de banco é aberta.

Os decorators são testados diretamente (sem passar por `require_auth`):
simula-se o estado que `require_auth` deixaria em `flask.g` em caso de
sucesso, dentro de um `app.test_request_context()`.
"""
from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask, g
from werkzeug.exceptions import Forbidden, Unauthorized

from app.authorization.rbac import has_unit_access, require_permission, require_role


@pytest.fixture()
def app() -> Flask:
    return Flask(__name__)


def _dummy_view():
    return "ok", 200


# --- require_permission --------------------------------------------------


def test_require_permission_sem_usuario_autenticado_retorna_401(app):
    view = require_permission("assets.read")(_dummy_view)
    with app.test_request_context("/"):
        with pytest.raises(Unauthorized):
            view()


def test_require_permission_usuario_sem_permissao_retorna_403(app):
    view = require_permission("assets.read")(_dummy_view)
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_permissions = {"assets.write"}
        with pytest.raises(Forbidden):
            view()


def test_require_permission_usuario_com_permissao_executa_view(app):
    view = require_permission("assets.read")(_dummy_view)
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_permissions = {"assets.read"}
        assert view() == ("ok", 200)


# --- require_role ----------------------------------------------------------


def test_require_role_sem_usuario_autenticado_retorna_401(app):
    view = require_role("ADM")(_dummy_view)
    with app.test_request_context("/"):
        with pytest.raises(Unauthorized):
            view()


def test_require_role_usuario_sem_papel_exigido_retorna_403(app):
    view = require_role("ADM")(_dummy_view)
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"USER"}
        with pytest.raises(Forbidden):
            view()


def test_require_role_usuario_com_um_dos_papeis_executa_view(app):
    view = require_role("ADM", "RH")(_dummy_view)
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"RH"}
        assert view() == ("ok", 200)


# --- combinação require_role + require_permission (padrão administrativo) --


def test_require_role_adm_e_require_permission_combinados_sucesso(app):
    """Padrão recomendado para endpoints administrativos críticos (ex.:
    confirmar importação): exige papel ADM E a permissão granular."""
    view = require_role("ADM")(require_permission("imports.execute")(_dummy_view))
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"ADM"}
        g.current_user_permissions = {"imports.execute"}
        assert view() == ("ok", 200)


def test_require_role_adm_e_require_permission_combinados_sem_permissao_falha(app):
    """Tem o papel ADM mas não a permissão granular -> 403 (ambos são exigidos)."""
    view = require_role("ADM")(require_permission("imports.execute")(_dummy_view))
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"ADM"}
        g.current_user_permissions = set()
        with pytest.raises(Forbidden):
            view()


def test_require_role_adm_e_require_permission_combinados_sem_papel_falha(app):
    """Tem a permissão granular mas não o papel ADM -> 403 (ambos são exigidos)."""
    view = require_role("ADM")(require_permission("imports.execute")(_dummy_view))
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"USER"}
        g.current_user_permissions = {"imports.execute"}
        with pytest.raises(Forbidden):
            view()


# --- has_unit_access ---------------------------------------------------------


@contextmanager
def _fake_get_db_session(session):
    yield session


def test_has_unit_access_true_quando_vinculo_existe():
    user = SimpleNamespace(id="u1")
    fake_session = MagicMock()
    fake_session.query.return_value.filter.return_value.first.return_value = MagicMock()

    with patch(
        "app.authorization.rbac.get_db_session", lambda: _fake_get_db_session(fake_session)
    ):
        assert has_unit_access(user, "6f1c2a4e-0000-4000-8000-000000000001") is True


def test_has_unit_access_false_quando_vinculo_nao_existe():
    user = SimpleNamespace(id="u1")
    fake_session = MagicMock()
    fake_session.query.return_value.filter.return_value.first.return_value = None

    with patch(
        "app.authorization.rbac.get_db_session", lambda: _fake_get_db_session(fake_session)
    ):
        assert has_unit_access(user, "6f1c2a4e-0000-4000-8000-000000000001") is False
