"""Testes do decorator `require_aal2` (`app.authorization.rbac`) e do
parsing do claim `aal` (`app.auth.supabase_auth`).

Mesmo espírito de `test_rbac.py`: os decorators são testados diretamente
(sem passar por `require_auth`), simulando o estado que `require_auth`
deixaria em `flask.g` em caso de sucesso, dentro de um
`app.test_request_context()`. Nenhuma conexão real de banco é aberta.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from flask import Flask, g
from werkzeug.exceptions import Unauthorized

from app.auth.supabase_auth import _extract_session_aal
from app.authorization.rbac import require_aal2, require_permission


@pytest.fixture()
def app() -> Flask:
    return Flask(__name__)


def _dummy_view():
    return "ok", 200


# --- require_aal2 -----------------------------------------------------------


def test_require_aal2_sem_usuario_autenticado_retorna_401(app):
    view = require_aal2(_dummy_view)
    with app.test_request_context("/"):
        with pytest.raises(Unauthorized):
            view()


def test_require_aal2_sessao_aal1_bloqueada_mesmo_com_permissao_correta(app):
    """Sessão aal1 é bloqueada mesmo que o usuário tenha a permissão exigida
    (a checagem de AAL é independente da checagem de permissão granular)."""
    view = require_role_permission_stack()
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"ADM"}
        g.current_user_permissions = {"users.invite"}
        g.current_session_aal = "aal1"

        response = view()

    assert response.status_code == 403
    body = response.get_json()
    assert body["error"]["code"] == "AAL2_REQUIRED"


def test_require_aal2_sessao_aal2_com_permissao_passa(app):
    """Sessão aal2 com a permissão correta deve executar a view normalmente."""
    view = require_role_permission_stack()
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        g.current_user_roles = {"ADM"}
        g.current_user_permissions = {"users.invite"}
        g.current_session_aal = "aal2"

        assert view() == ("ok", 200)


def test_require_aal2_claim_ausente_de_g_e_tratado_como_aal1_bloqueado(app):
    """Se `flask.g.current_session_aal` nunca foi definido (claim ausente no
    JWT, fallback fail-safe aplicado por `require_auth`), a checagem deve
    tratar isso como `aal1` e bloquear."""
    view = require_aal2(_dummy_view)
    with app.test_request_context("/"):
        g.current_user = SimpleNamespace(id="u1")
        # Note: `g.current_session_aal` deliberadamente NÃO definido.

        response = view()

    assert response.status_code == 403
    body = response.get_json()
    assert body["error"]["code"] == "AAL2_REQUIRED"


def require_role_permission_stack():
    """Monta a pilha `require_aal2` -> `require_permission` sobre a view
    dummy, simulando o padrão recomendado para rotas administrativas
    críticas (ver docstring de `app.authorization.rbac`)."""
    return require_aal2(require_permission("users.invite")(_dummy_view))


# --- _extract_session_aal (app.auth.supabase_auth) --------------------------


def test_extract_session_aal_aal2_explicito():
    assert _extract_session_aal({"aal": "aal2"}) == "aal2"


def test_extract_session_aal_aal1_explicito():
    assert _extract_session_aal({"aal": "aal1"}) == "aal1"


def test_extract_session_aal_claim_ausente_vira_aal1():
    """Claim ausente é tratado como aal1 (fail-safe), nunca como aal2."""
    assert _extract_session_aal({}) == "aal1"


def test_extract_session_aal_valor_inesperado_vira_aal1():
    assert _extract_session_aal({"aal": "algo-inesperado"}) == "aal1"
    assert _extract_session_aal({"aal": None}) == "aal1"
