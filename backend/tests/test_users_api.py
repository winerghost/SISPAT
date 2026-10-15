"""Testes dos endpoints de gestão de usuários (`app.api.v1.users`).

Mesmo espírito de `test_imports_api.py`: usa `app.test_client()`,
autenticação simulada via JWT HS256 real (assinado com o mesmo
`SUPABASE_JWT_SECRET` fictício de `backend/tests/conftest.py`) e mock de
`app.auth.supabase_auth._load_user_with_roles_and_permissions`, sem abrir
nenhuma conexão real de banco. A camada de serviço (`InviteService`) é
sempre mockada aqui -- sua lógica de negócio já é testada isoladamente em
`test_invite_service.py`. Este arquivo cobre apenas o contrato HTTP:
autenticação/autorização (401/403, inclusive AAL2) e o mapeamento de erros
de domínio para códigos HTTP.

O endpoint `POST /invite` é decorado com `app.security.rate_limit.
rate_limit`, que por padrão construiria um cliente Redis real a partir de
`settings.redis_url` -- a fixture `_mock_redis_for_rate_limit` (autouse)
substitui essa construção por um Redis falso que nunca bloqueia, para que
estes testes nunca dependam de uma instância Redis real.
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
from app.services.invite_service import (
    InviteAlreadyPendingError,
    InviteExpiredError,
    InviteNotFoundError,
    InviteValidationError,
    LastAdminError,
    UserNotFoundError,
)

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # igual ao default de backend/tests/conftest.py

INVITE_URL = "/api/v1/users/invite"
ACTIVATE_URL = "/api/v1/users/activate-invite"
LIST_USERS_URL = "/api/v1/users"


def _revoke_url(user_id: uuid.UUID) -> str:
    return f"/api/v1/users/{user_id}/revoke"


@pytest.fixture()
def app():
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def _mock_redis_for_rate_limit():
    """Substitui a construção do cliente Redis real de `rate_limit` por um
    mock que sempre permite a requisição (contador sempre `1`), para que
    nenhum teste deste arquivo dependa de uma instância Redis real.

    Patcha `redis.Redis.from_url` diretamente (em vez de
    `app.security.rate_limit._build_redis_client`) porque
    `app/security/__init__.py` faz `from app.security.rate_limit import
    rate_limit`, o que REBINDA o nome `rate_limit` no NAMESPACE do pacote
    `app.security` para a própria função decorator -- `unittest.mock.patch`
    resolve `"app.security.rate_limit.<algo>"` percorrendo atributos
    (`app` -> `.security` -> `.rate_limit`), e encontraria essa função em
    vez do submódulo, falhando com `AttributeError`. Patchar o próprio
    `redis.Redis.from_url` evita esse problema por completo.
    """
    fake_redis = MagicMock()
    fake_redis.incr.return_value = 1
    with patch("redis.Redis.from_url", return_value=fake_redis):
        yield fake_redis


@pytest.fixture(autouse=True)
def _mock_unit_scope_ok():
    """O ADM convidante administra todas as unidades usadas nestes testes.

    `POST /invite` verifica o escopo de unidade do ADM
    (`app.authorization.rbac.units_outside_scope`, auditoria 2026-10-13);
    o comportamento de negação é coberto em `test_sec_authz.py`.
    """
    with patch("app.api.v1.users.units_outside_scope", return_value=[]), patch(
        "app.api.v1.users._target_in_actor_scope", return_value=True
    ):
        yield


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
    """Patcha `get_db_session` (sessão fake) e `InviteService` (classe
    mockada, cuja instância é `mock_service_instance`) dentro de
    `app.api.v1.users`."""
    fake_session = MagicMock()
    mock_service_class = MagicMock(return_value=mock_service_instance)
    return (
        patch("app.api.v1.users.get_db_session", lambda: _fake_get_db_session(fake_session)),
        patch("app.api.v1.users.InviteService", mock_service_class),
        patch("app.api.v1.users.SupabaseAdminClient", MagicMock()),
    )


_VALID_INVITE_BODY = {
    "email": "novo@exemplo.com",
    "name": "Novo Usuário",
    "intended_role_code": "USER",
    "unit_ids": [str(uuid.uuid4())],
}


# ---------------------------------------------------------------------------
# 401 sem token, em TODAS as rotas protegidas
# ---------------------------------------------------------------------------


def test_invite_sem_token_retorna_401(client):
    response = client.post(INVITE_URL, json=_VALID_INVITE_BODY)
    assert response.status_code == 401


def test_activate_invite_sem_token_retorna_401(client):
    response = client.post(ACTIVATE_URL)
    assert response.status_code == 401


def test_revoke_sem_token_retorna_401(client):
    response = client.post(_revoke_url(uuid.uuid4()))
    assert response.status_code == 401


def test_list_users_sem_token_retorna_401(client):
    response = client.get(LIST_USERS_URL)
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# POST /invite -- autorização (403 papel/AAL2) e sucesso (201)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role_code", ["USER", "RH"])
def test_invite_sem_papel_adm_retorna_403(client, role_code):
    token = _make_token(aal="aal2")
    with _patch_authenticated(role_codes={role_code}, permission_codes={"users.invite"}):
        response = client.post(
            INVITE_URL, json=_VALID_INVITE_BODY, headers=_auth_headers(token)
        )
    assert response.status_code == 403


def test_invite_adm_sem_permissao_retorna_403(client):
    token = _make_token(aal="aal2")
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=set()):
        response = client.post(
            INVITE_URL, json=_VALID_INVITE_BODY, headers=_auth_headers(token)
        )
    assert response.status_code == 403


def test_invite_adm_sem_aal2_retorna_403_com_codigo_aal2_required(client):
    """ADM com permissão correta, mas sessão em aal1 (claim 'aal' ausente do
    JWT) -- deve ser bloqueado com o código específico AAL2_REQUIRED, ANTES
    de chegar à checagem de permissão granular ou ao rate limit (mesmo
    espírito de `test_aal2.py`)."""
    token = _make_token(aal=None)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.invite"}):
        response = client.post(
            INVITE_URL, json=_VALID_INVITE_BODY, headers=_auth_headers(token)
        )
    assert response.status_code == 403
    body = response.get_json()
    assert body["error"]["code"] == "AAL2_REQUIRED"


def test_invite_adm_com_aal2_e_permissao_retorna_201(client):
    token = _make_token(aal="aal2")
    invite_id = uuid.uuid4()
    unit_id = uuid.UUID(_VALID_INVITE_BODY["unit_ids"][0])
    fake_invite = SimpleNamespace(
        id=invite_id,
        email=_VALID_INVITE_BODY["email"],
        name=_VALID_INVITE_BODY["name"],
        intended_role_code=_VALID_INVITE_BODY["intended_role_code"],
        status="PENDENTE",
        created_at=datetime.now(timezone.utc),
        expires_at=datetime.now(timezone.utc),
    )
    mock_service = MagicMock()
    mock_service.create_invite.return_value = fake_invite

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.invite"}) as user:
        with patches[0], patches[1], patches[2]:
            response = client.post(
                INVITE_URL, json=_VALID_INVITE_BODY, headers=_auth_headers(token)
            )

    assert response.status_code == 201
    body = response.get_json()
    assert body["id"] == str(invite_id)
    assert body["email"] == _VALID_INVITE_BODY["email"]
    assert body["unit_ids"] == [str(unit_id)]
    # Nenhum token/segredo/link de ativação deve aparecer na resposta.
    assert "token" not in body
    assert "link" not in body
    mock_service.create_invite.assert_called_once_with(
        invited_by_user_id=user.id,
        email=_VALID_INVITE_BODY["email"],
        name=_VALID_INVITE_BODY["name"],
        intended_role_code=_VALID_INVITE_BODY["intended_role_code"],
        unit_ids=[unit_id],
        justification=None,
    )


def test_invite_corpo_invalido_retorna_400(client):
    token = _make_token(aal="aal2")
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.invite"}):
        response = client.post(
            INVITE_URL,
            json={"email": "novo@exemplo.com"},  # faltam campos obrigatórios
            headers=_auth_headers(token),
        )
    assert response.status_code == 400


def test_invite_role_adm_no_corpo_retorna_400(client):
    """`intended_role_code='ADM'` no corpo é um erro de VALIDAÇÃO (400) --
    mapeado a partir de `InviteValidationError` levantado pelo serviço."""
    token = _make_token(aal="aal2")
    body = {**_VALID_INVITE_BODY, "intended_role_code": "ADM"}

    mock_service = MagicMock()
    mock_service.create_invite.side_effect = InviteValidationError("papel não permitido")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.invite"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(INVITE_URL, json=body, headers=_auth_headers(token))

    assert response.status_code == 400


def test_invite_convite_duplicado_retorna_409(client):
    token = _make_token(aal="aal2")
    mock_service = MagicMock()
    mock_service.create_invite.side_effect = InviteAlreadyPendingError("já pendente")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.invite"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(
                INVITE_URL, json=_VALID_INVITE_BODY, headers=_auth_headers(token)
            )

    assert response.status_code == 409


# ---------------------------------------------------------------------------
# POST /activate-invite
# ---------------------------------------------------------------------------


def test_activate_invite_sucesso_retorna_200(client):
    token = _make_token(aal="aal1")  # qualquer sessão autenticada, sem exigir aal2
    mock_service = MagicMock()
    mock_service.activate_invite.return_value = {"role": "USER", "units": [str(uuid.uuid4())]}

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes=set(), permission_codes=set()) as user:
        with patches[0], patches[1], patches[2]:
            response = client.post(ACTIVATE_URL, headers=_auth_headers(token))

    assert response.status_code == 200
    body = response.get_json()
    assert body["role"] == "USER"
    mock_service.activate_invite.assert_called_once_with(current_user_id=user.id)


def test_activate_invite_nao_encontrado_retorna_404(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.activate_invite.side_effect = InviteNotFoundError("não encontrado")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes=set(), permission_codes=set()):
        with patches[0], patches[1], patches[2]:
            response = client.post(ACTIVATE_URL, headers=_auth_headers(token))

    assert response.status_code == 404


def test_activate_invite_expirado_retorna_409(client):
    token = _make_token()
    mock_service = MagicMock()
    mock_service.activate_invite.side_effect = InviteExpiredError("expirado")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes=set(), permission_codes=set()):
        with patches[0], patches[1], patches[2]:
            response = client.post(ACTIVATE_URL, headers=_auth_headers(token))

    assert response.status_code == 409


# ---------------------------------------------------------------------------
# POST /<user_id>/revoke
# ---------------------------------------------------------------------------


def test_revoke_sem_papel_adm_retorna_403(client):
    token = _make_token(aal="aal2")
    with _patch_authenticated(role_codes={"USER"}, permission_codes={"users.revoke_access"}):
        response = client.post(_revoke_url(uuid.uuid4()), headers=_auth_headers(token))
    assert response.status_code == 403


def test_revoke_sucesso_retorna_200(client):
    token = _make_token(aal="aal2")
    target_user_id = uuid.uuid4()
    mock_service = MagicMock()
    mock_service.revoke_access.return_value = None

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.revoke_access"}) as user:
        with patches[0], patches[1], patches[2]:
            response = client.post(
                _revoke_url(target_user_id),
                json={"reason": "saiu da instituição"},
                headers=_auth_headers(token),
            )

    assert response.status_code == 200
    mock_service.revoke_access.assert_called_once_with(
        target_user_id=target_user_id,
        revoked_by_user_id=user.id,
        reason="saiu da instituição",
    )


def test_revoke_usuario_inexistente_retorna_404(client):
    token = _make_token(aal="aal2")
    mock_service = MagicMock()
    mock_service.revoke_access.side_effect = UserNotFoundError("não encontrado")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.revoke_access"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(_revoke_url(uuid.uuid4()), headers=_auth_headers(token))

    assert response.status_code == 404


def test_revoke_ultimo_adm_retorna_409(client):
    token = _make_token(aal="aal2")
    mock_service = MagicMock()
    mock_service.revoke_access.side_effect = LastAdminError("último admin")

    patches = _patch_db_and_service(mock_service)
    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.revoke_access"}):
        with patches[0], patches[1], patches[2]:
            response = client.post(_revoke_url(uuid.uuid4()), headers=_auth_headers(token))

    assert response.status_code == 409


# ---------------------------------------------------------------------------
# GET /users
# ---------------------------------------------------------------------------


def test_list_users_sem_papel_adm_retorna_403(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"USER"}, permission_codes={"users.manage"}):
        response = client.get(LIST_USERS_URL, headers=_auth_headers(token))
    assert response.status_code == 403


def test_list_users_sem_permissao_retorna_403(client):
    token = _make_token()
    with _patch_authenticated(role_codes={"ADM"}, permission_codes=set()):
        response = client.get(LIST_USERS_URL, headers=_auth_headers(token))
    assert response.status_code == 403


def test_list_users_sucesso_retorna_200(client):
    """GET /users devolve o `UserSummary` do contrato da Etapa 2 (campo `role`
    único, unidades, versão). Regra/consulta testadas em
    `test_user_admin_service.py` (SQL real em SQLite)."""
    token = _make_token(aal="aal2")  # GET /users exige AAL2 (auditoria 2026-10-13)
    summary = {
        "id": str(uuid.uuid4()),
        "name": "Administradora",
        "email": "adm@exemplo.com",
        "active": True,
        "role": "ADM",
        "units": [],
        "has_avatar": False,
        "created_at": "2026-10-14T12:00:00Z",
        "last_login_at": None,
        "deactivated_at": None,
        "version": 1,
    }
    service = MagicMock()
    service.list_users.return_value = {"total": 1, "page": 1, "page_size": 25, "users": [summary]}
    fake_redis = MagicMock()
    fake_redis.incr.return_value = 1

    with _patch_authenticated(role_codes={"ADM"}, permission_codes={"users.manage"}):
        with patch(
            "app.api.v1.users.get_db_session", lambda: _fake_get_db_session(MagicMock())
        ), patch("app.api.v1.users.UserAdminService", MagicMock(return_value=service)), patch(
            "redis.Redis.from_url", return_value=fake_redis
        ):
            response = client.get(LIST_USERS_URL, headers=_auth_headers(token))

    assert response.status_code == 200
    body = response.get_json()
    assert body["total"] == 1
    assert body["users"][0]["email"] == "adm@exemplo.com"
    assert body["users"][0]["role"] == "ADM"
    query = service.list_users.call_args.args[1]
    assert (query.page, query.page_size, query.sort) == (1, 25, "name")


# ---------------------------------------------------------------------------
# Cadastro público: nenhuma rota /register ou /signup é exposta (ver
# docstring de app.api.v1.users sobre a pendência de configuração manual no
# painel do Supabase -- Authentication > Settings > "Allow new users to
# sign up").
# ---------------------------------------------------------------------------


def test_nenhuma_rota_register_ou_signup_esta_registrada(app):
    forbidden_fragments = ("register", "signup", "sign-up", "sign_up")
    offending_rules = [
        rule.rule
        for rule in app.url_map.iter_rules()
        if any(fragment in rule.rule.lower() for fragment in forbidden_fragments)
    ]
    assert offending_rules == [], (
        "O backend nunca deve expor rotas de cadastro público "
        f"(/register ou /signup); encontradas: {offending_rules}"
    )
