"""Testes de segurança — autorização, IDOR/BOLA e mass assignment (auditoria 2026-10-13).

Cobre, para TODOS os endpoints existentes da API v1, os cenários
obrigatórios da auditoria (ver `docs/security/evidence/backend-authz.md`):

    1/2. Acesso/alteração entre unidades -> endpoints patrimoniais ainda não
         existem (N/A); cobertos aqui pelo convite (concessão de unidade fora
         do escopo do ADM) e pelo decorator reutilizável
         `require_unit_access` (ver `test_sec_unit_scope.py`).
    3.   USER/RH em endpoints administrativos -> 403 (mesmo com permissão e AAL2).
    4.   Exportações -> N/A (endpoint inexistente).
    5.   Enumeração de IDs (sequenciais, UUID válido inexistente/existente).
    6.   Mass assignment (`role`, `is_admin`, `unit_id`, `created_by`,
         `deleted_at`, `owner_unit_id`, `permissions`).
    7.   Autoatribuição de ADM -> negada E registrada em `audit_logs`.

Tokens: JWT HS256 sintéticos assinados com o segredo FICTÍCIO de
`tests/conftest.py`. Banco, Supabase e Redis são sempre mockados. Os eventos
de segurança são capturados substituindo
`app.authorization.security_events._dispatch`.
"""
from __future__ import annotations

import time
import uuid
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest

from app import create_app

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # igual ao default de tests/conftest.py

ALL_ADMIN_PERMISSIONS = {
    "users.invite",
    "users.revoke_access",
    "users.manage",
    "imports.execute",
    "settings.ai.manage",
}

MASS_ASSIGNMENT_FIELDS = [
    "role",
    "is_admin",
    "unit_id",
    "created_by",
    "deleted_at",
    "owner_unit_id",
    "permissions",
]

_TARGET_USER_ID = "8d4b5f1e-0000-4000-8000-0000000000aa"
_PREVIEW_ID = "8d4b5f1e-0000-4000-8000-0000000000bb"
_UNIT_A = "8d4b5f1e-0000-4000-8000-00000000000a"
_UNIT_B = "8d4b5f1e-0000-4000-8000-00000000000b"

_VALID_INVITE_BODY = {
    "email": "novo@exemplo.com",
    "name": "Novo Usuário",
    "intended_role_code": "USER",
    "unit_ids": [_UNIT_A],
}
_VALID_CONFIRM_BODY = {"preview_id": _PREVIEW_ID, "selected_item_ids": []}

# (método, url, corpo JSON, permissão granular exigida)
ADMIN_ENDPOINTS = [
    ("POST", "/api/v1/users/invite", _VALID_INVITE_BODY, "users.invite"),
    ("POST", f"/api/v1/users/{_TARGET_USER_ID}/revoke", None, "users.revoke_access"),
    ("GET", "/api/v1/users", None, "users.manage"),
    ("POST", "/api/v1/imports/google-sheets/preview", None, "imports.execute"),
    ("GET", f"/api/v1/imports/google-sheets/preview/{_PREVIEW_ID}/items", None, "imports.execute"),
    ("POST", "/api/v1/imports/google-sheets/confirm", _VALID_CONFIRM_BODY, "imports.execute"),
    ("GET", "/api/v1/settings/ai", None, "settings.ai.manage"),
    ("PATCH", "/api/v1/settings/ai", {"version": 1}, "settings.ai.manage"),
    ("POST", "/api/v1/settings/ai/test", None, "settings.ai.manage"),
]

AUTHENTICATED_ENDPOINTS = ADMIN_ENDPOINTS + [
    ("GET", "/api/v1/me", None, None),
    ("POST", "/api/v1/users/activate-invite", None, None),
    ("DELETE", f"/api/v1/security/mfa/factors/{uuid.uuid4()}", None, None),
]


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def make_token(sub: str = "auth-user-1", aal: str | None = "aal2", **extra) -> str:
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
    claims.update(extra)
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def auth(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


@pytest.fixture()
def app():
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def events():
    """Captura os eventos de segurança despachados (sem tocar o banco)."""
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


@contextmanager
def _fake_session_cm(session):
    yield session


@pytest.fixture()
def backend_mocks():
    """Mocka Redis, serviços, clientes externos e sessões de banco das rotas."""
    fake_redis = MagicMock()
    fake_redis.incr.return_value = 1
    session = MagicMock()
    invite_service = MagicMock()
    import_service = MagicMock()
    admin_client = MagicMock()
    with ExitStack() as stack:
        stack.enter_context(patch("redis.Redis.from_url", return_value=fake_redis))
        stack.enter_context(
            patch("app.api.v1.users.get_db_session", lambda: _fake_session_cm(session))
        )
        stack.enter_context(
            patch("app.api.v1.imports.get_db_session", lambda: _fake_session_cm(session))
        )
        stack.enter_context(
            patch("app.api.v1.ai_settings.get_db_session", lambda: _fake_session_cm(session))
        )
        stack.enter_context(
            patch("app.api.v1.users.InviteService", MagicMock(return_value=invite_service))
        )
        stack.enter_context(
            patch("app.api.v1.imports.ImportService", MagicMock(return_value=import_service))
        )
        stack.enter_context(patch("app.api.v1.users.SupabaseAdminClient", MagicMock()))
        stack.enter_context(patch("app.api.v1.imports.GoogleSheetsClient", MagicMock()))
        stack.enter_context(
            patch("app.api.v1.security.SupabaseAdminClient", MagicMock(return_value=admin_client))
        )
        scope = stack.enter_context(
            patch("app.api.v1.users.units_outside_scope", return_value=[])
        )
        # Escopo do alvo do revoke (AUD-14-01) coberto em test_sec_revoke_scope.py.
        stack.enter_context(patch("app.api.v1.users._target_in_actor_scope", return_value=True))
        yield SimpleNamespace(
            session=session,
            invite_service=invite_service,
            import_service=import_service,
            admin_client=admin_client,
            units_outside_scope=scope,
            redis=fake_redis,
        )


@contextmanager
def as_user(role_codes: set[str], permission_codes: set[str], user_id: uuid.UUID | None = None):
    fake_user = SimpleNamespace(
        id=user_id or uuid.uuid4(),
        active=True,
        auth_user_id="auth-user-1",
        name="Usuário Sintético",
        email="sintetico@exemplo.com",
    )
    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, set(role_codes), set(permission_codes)),
    ):
        yield fake_user


def call(client, method: str, url: str, body=None, token: str | None = None):
    kwargs = {"headers": auth(token)}
    if body is not None:
        kwargs["json"] = body
    return client.open(url, method=method, **kwargs)


def _no_service_called(mocks) -> bool:
    return not (
        mocks.session.execute.called
        or mocks.invite_service.method_calls
        or mocks.import_service.method_calls
        or mocks.admin_client.method_calls
    )


# ---------------------------------------------------------------------------
# A07 / API2 — autenticação obrigatória em todos os endpoints protegidos
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,url,body,_perm", AUTHENTICATED_ENDPOINTS)
def test_sem_token_retorna_401_em_todo_endpoint_protegido(client, backend_mocks, method, url, body, _perm):
    response = call(client, method, url, body, token=None)
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "unauthorized"
    assert _no_service_called(backend_mocks)


@pytest.mark.parametrize("method,url,body,_perm", AUTHENTICATED_ENDPOINTS)
def test_token_assinado_com_outro_segredo_retorna_401(client, backend_mocks, events, method, url, body, _perm):
    forged = jwt.encode(
        {"sub": "auth-user-1", "aud": "authenticated", "role": "authenticated",
         "iat": int(time.time()), "exp": int(time.time()) + 600, "aal": "aal2"},
        "segredo-do-atacante-com-32-caracteres!!",
        algorithm="HS256",
    )
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(client, method, url, body, token=forged)
    assert response.status_code == 401
    assert _no_service_called(backend_mocks)
    assert any(e["event_type"] == "AUTH_FAILED" for e in events)
    # Nenhum evento contém o token.
    assert all(forged not in repr(e) for e in events)


# ---------------------------------------------------------------------------
# Cenário 3 — USER/RH em endpoints administrativos -> 403
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["USER", "RH"])
@pytest.mark.parametrize("method,url,body,_perm", ADMIN_ENDPOINTS)
def test_user_e_rh_em_endpoint_admin_retorna_403_mesmo_com_permissao_e_aal2(
    client, backend_mocks, events, role, method, url, body, _perm
):
    """Mesmo que a matriz de permissões fosse alterada e USER/RH recebessem
    a permissão granular, a exigência explícita do papel ADM continua
    negando (defesa em profundidade)."""
    with as_user({role}, ALL_ADMIN_PERMISSIONS):
        response = call(client, method, url, body, token=make_token(aal="aal2"))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert _no_service_called(backend_mocks)
    denied = [e for e in events if e["event_type"] == "ACCESS_DENIED"]
    assert denied and denied[0]["details"]["reason"] == "missing_role"


@pytest.mark.parametrize("method,url,body,perm", ADMIN_ENDPOINTS)
def test_adm_sem_a_permissao_granular_retorna_403(client, backend_mocks, method, url, body, perm):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS - {perm}):
        response = call(client, method, url, body, token=make_token(aal="aal2"))
    assert response.status_code == 403
    assert _no_service_called(backend_mocks)


@pytest.mark.parametrize("method,url,body,_perm", ADMIN_ENDPOINTS)
def test_adm_sem_aal2_retorna_403_aal2_required_em_todo_endpoint_admin(
    client, backend_mocks, events, method, url, body, _perm
):
    """Confirma a correção: importações e `GET /users` também exigem AAL2."""
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(client, method, url, body, token=make_token(aal="aal1"))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert _no_service_called(backend_mocks)
    assert any(e["event_type"] == "AAL2_REQUIRED" for e in events)


def test_usuario_sem_papel_recem_convidado_nao_acessa_nenhum_endpoint_admin(client, backend_mocks):
    for method, url, body, _perm in ADMIN_ENDPOINTS:
        with as_user(set(), set()):
            response = call(client, method, url, body, token=make_token(aal="aal2"))
        assert response.status_code == 403, url
    assert _no_service_called(backend_mocks)


# ---------------------------------------------------------------------------
# Cenário 5 — enumeração de IDs
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["USER", "RH"])
def test_revoke_nao_admin_mesma_resposta_para_id_existente_e_inexistente(client, backend_mocks, role):
    """Para quem não é ADM, a negação ocorre ANTES de qualquer consulta: o
    corpo/status é idêntico para UUID existente ou inexistente."""
    responses = []
    for target in (_TARGET_USER_ID, str(uuid.uuid4())):
        with as_user({role}, ALL_ADMIN_PERMISSIONS):
            responses.append(
                call(client, "POST", f"/api/v1/users/{target}/revoke", token=make_token())
            )
    assert {r.status_code for r in responses} == {403}
    assert responses[0].get_json() == responses[1].get_json()
    assert _no_service_called(backend_mocks)


@pytest.mark.parametrize(
    "path_id", ["1", "2", "0", "-1", "00000000", "..", "%2E%2E", "1%20OR%201=1", "not-a-uuid"]
)
def test_ids_sequenciais_ou_malformados_retornam_404_sem_tocar_servico(client, backend_mocks, path_id):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        r1 = call(client, "POST", f"/api/v1/users/{path_id}/revoke", token=make_token())
        r2 = call(
            client, "GET", f"/api/v1/imports/google-sheets/preview/{path_id}/items", token=make_token()
        )
    assert r1.status_code == 404
    assert r2.status_code == 404
    assert r1.get_json()["error"]["code"] == "not_found"
    assert _no_service_called(backend_mocks)


def test_preview_inexistente_e_404_generico_sem_detalhes(client, backend_mocks):
    from app.services.import_service import PreviewNotFoundError

    backend_mocks.import_service.list_preview_items.side_effect = PreviewNotFoundError("x")
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "GET", f"/api/v1/imports/google-sheets/preview/{uuid.uuid4()}/items",
            token=make_token(),
        )
    assert response.status_code == 404
    assert response.get_json() == {
        "error": {"code": "not_found", "message": "Pré-visualização não encontrada."}
    }


# ---------------------------------------------------------------------------
# Cenário 6 — mass assignment
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field", MASS_ASSIGNMENT_FIELDS)
def test_invite_rejeita_campos_privilegiados(client, backend_mocks, events, field):
    body = {**_VALID_INVITE_BODY, field: "ADM" if field == "role" else True}
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(client, "POST", "/api/v1/users/invite", body, token=make_token())
    assert response.status_code == 400
    backend_mocks.invite_service.create_invite.assert_not_called()
    escalation = [e for e in events if e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"]
    assert escalation and field in escalation[0]["details"]["fields"]
    assert escalation[0]["notify"] is True


@pytest.mark.parametrize("field", MASS_ASSIGNMENT_FIELDS)
def test_activate_invite_rejeita_campos_privilegiados(client, backend_mocks, events, field):
    """O convidado não escolhe papel/unidade: o corpo é proibido."""
    with as_user(set(), set()):
        response = call(
            client, "POST", "/api/v1/users/activate-invite", {field: "ADM"}, token=make_token(aal="aal1")
        )
    assert response.status_code == 400
    backend_mocks.invite_service.activate_invite.assert_not_called()
    assert any(e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT" for e in events)


@pytest.mark.parametrize("field", MASS_ASSIGNMENT_FIELDS)
def test_revoke_rejeita_campos_desconhecidos(client, backend_mocks, field):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", f"/api/v1/users/{_TARGET_USER_ID}/revoke",
            {"reason": "x", field: "valor"}, token=make_token(),
        )
    assert response.status_code == 400
    backend_mocks.invite_service.revoke_access.assert_not_called()


@pytest.mark.parametrize("field", MASS_ASSIGNMENT_FIELDS)
def test_confirm_rejeita_campos_desconhecidos(client, backend_mocks, field):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", "/api/v1/imports/google-sheets/confirm",
            {**_VALID_CONFIRM_BODY, field: "valor"}, token=make_token(),
        )
    assert response.status_code == 400
    backend_mocks.import_service.confirm_preview.assert_not_called()


def test_campo_desconhecido_nao_privilegiado_gera_evento_mass_assignment(client, backend_mocks, events):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", "/api/v1/users/invite", {**_VALID_INVITE_BODY, "foo": 1}, token=make_token()
        )
    assert response.status_code == 400
    assert any(e["event_type"] == "MASS_ASSIGNMENT_REJECTED" for e in events)
    # A mensagem cita apenas o NOME do campo, nunca valores enviados.
    assert "foo" in response.get_json()["error"]["message"]


@pytest.mark.parametrize(
    "override",
    [
        {"email": "x" * 300 + "@exemplo.com"},
        {"email": "sem-arroba"},
        {"name": "n" * 201},
        {"justification": "j" * 2001},
        {"unit_ids": []},
        {"unit_ids": [str(uuid.uuid4()) for _ in range(51)]},
        {"unit_ids": ["nao-e-uuid"]},
        {"intended_role_code": "R" * 33},
    ],
)
def test_invite_limites_de_tamanho_e_formato(client, backend_mocks, override):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", "/api/v1/users/invite", {**_VALID_INVITE_BODY, **override}, token=make_token()
        )
    assert response.status_code == 400
    backend_mocks.invite_service.create_invite.assert_not_called()


def test_confirm_lista_de_ids_acima_do_limite_rejeitada(client, backend_mocks):
    ids = [str(uuid.uuid4()) for _ in range(10001)]
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", "/api/v1/imports/google-sheets/confirm",
            {"preview_id": _PREVIEW_ID, "selected_item_ids": ids}, token=make_token(),
        )
    assert response.status_code in (400, 413)
    backend_mocks.import_service.confirm_preview.assert_not_called()


# ---------------------------------------------------------------------------
# Cenário 7 — autoatribuição de ADM: negada e registrada
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("requested_role", ["ADM", "adm", "SUPERADMIN"])
def test_invite_com_papel_adm_negado_e_auditado(client, backend_mocks, events, requested_role):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS) as actor:
        response = call(
            client, "POST", "/api/v1/users/invite",
            {**_VALID_INVITE_BODY, "intended_role_code": requested_role}, token=make_token(),
        )
    assert response.status_code == 400
    backend_mocks.invite_service.create_invite.assert_not_called()
    escalation = [e for e in events if e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"]
    assert escalation
    assert escalation[0]["actor_user_id"] == str(actor.id)
    assert escalation[0]["details"]["requested_role"] == requested_role


def test_activate_invite_com_role_adm_no_corpo_negado_e_auditado(client, backend_mocks, events):
    with as_user(set(), set()) as invited:
        response = call(
            client, "POST", "/api/v1/users/activate-invite",
            {"role": "ADM", "unit_ids": [_UNIT_B]}, token=make_token(aal="aal1"),
        )
    assert response.status_code == 400
    backend_mocks.invite_service.activate_invite.assert_not_called()
    escalation = [e for e in events if e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"]
    assert escalation and escalation[0]["actor_user_id"] == str(invited.id)
    assert set(escalation[0]["details"]["fields"]) == {"role", "unit_ids"}


def test_activate_invite_corpo_nao_objeto_rejeitado(client, backend_mocks):
    with as_user(set(), set()):
        response = call(
            client, "POST", "/api/v1/users/activate-invite", ["ADM"], token=make_token(aal="aal1")
        )
    assert response.status_code == 400
    backend_mocks.invite_service.activate_invite.assert_not_called()


@pytest.mark.parametrize(
    "extra_claims",
    [
        {"user_role": "ADM"},
        {"app_metadata": {"role": "ADM", "roles": ["ADM"]}},
        {"user_metadata": {"is_admin": True}},
        {"permissions": ["users.invite", "users.manage"]},
    ],
)
def test_claims_de_perfil_no_jwt_sao_ignorados(client, backend_mocks, extra_claims):
    """Papéis/permissões vêm SEMPRE do banco (nunca do token/cliente)."""
    token = make_token(aal="aal2", **extra_claims)
    with as_user({"USER"}, set()):
        me = call(client, "GET", "/api/v1/me", token=token)
        admin = call(client, "GET", "/api/v1/users", token=token)
    assert me.status_code == 200
    assert me.get_json()["roles"] == ["USER"]
    assert me.get_json()["permissions"] == []
    assert admin.status_code == 403


def test_query_string_com_role_nao_influencia_autorizacao(client, backend_mocks):
    with as_user({"USER"}, set()):
        response = call(client, "GET", "/api/v1/users?role=ADM&is_admin=true", token=make_token())
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# Cenário 1/2 — concessão de acesso a unidade fora do escopo do ADM (convite)
# ---------------------------------------------------------------------------


def test_invite_para_unidade_fora_do_escopo_do_adm_negado_e_auditado(client, backend_mocks, events):
    backend_mocks.units_outside_scope.return_value = [_UNIT_B]
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", "/api/v1/users/invite",
            {**_VALID_INVITE_BODY, "unit_ids": [_UNIT_A, _UNIT_B]}, token=make_token(),
        )
    assert response.status_code == 403
    backend_mocks.invite_service.create_invite.assert_not_called()
    scope_events = [e for e in events if e["event_type"] == "UNIT_SCOPE_DENIED"]
    assert scope_events and scope_events[0]["details"]["unit_ids"] == [_UNIT_B]


def test_invite_unidade_inexistente_e_fora_do_escopo_tem_mesma_resposta(client, backend_mocks):
    responses = []
    for outside in ([_UNIT_B], [str(uuid.uuid4())]):
        backend_mocks.units_outside_scope.return_value = outside
        with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
            responses.append(
                call(
                    client, "POST", "/api/v1/users/invite",
                    {**_VALID_INVITE_BODY, "unit_ids": outside}, token=make_token(),
                )
            )
    assert [r.status_code for r in responses] == [403, 403]
    assert responses[0].get_json() == responses[1].get_json()


def test_invite_usa_escopo_real_do_adm_via_user_unit_access(client, backend_mocks):
    """Sem mock do helper: o ADM só administra a unidade A; convite para B é negado."""
    backend_mocks.units_outside_scope.side_effect = None
    from app.authorization import rbac

    backend_mocks.session.query.return_value.filter.return_value.all.return_value = [
        (uuid.UUID(_UNIT_A),)
    ]
    with patch("app.api.v1.users.units_outside_scope", rbac.units_outside_scope):
        with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
            denied = call(
                client, "POST", "/api/v1/users/invite",
                {**_VALID_INVITE_BODY, "unit_ids": [_UNIT_B]}, token=make_token(),
            )
            backend_mocks.invite_service.create_invite.return_value = SimpleNamespace(
                id=uuid.uuid4(), email="novo@exemplo.com", name="Novo", intended_role_code="USER",
                status="PENDENTE",
                created_at=SimpleNamespace(isoformat=lambda: "2026-10-13T00:00:00+00:00"),
                expires_at=SimpleNamespace(isoformat=lambda: "2026-10-20T00:00:00+00:00"),
            )
            allowed = call(
                client, "POST", "/api/v1/users/invite", _VALID_INVITE_BODY, token=make_token()
            )
    assert denied.status_code == 403
    assert allowed.status_code == 201


# ---------------------------------------------------------------------------
# Revogação — autorrevogação e último ADM auditados
# ---------------------------------------------------------------------------


def test_revoke_proprio_acesso_bloqueado_e_auditado(client, backend_mocks, events):
    actor_id = uuid.UUID(_TARGET_USER_ID)
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS, user_id=actor_id):
        response = call(client, "POST", f"/api/v1/users/{_TARGET_USER_ID}/revoke", token=make_token())
    assert response.status_code == 409
    backend_mocks.invite_service.revoke_access.assert_not_called()
    blocked = [e for e in events if e["event_type"] == "REVOKE_BLOCKED"]
    assert blocked and blocked[0]["details"]["reason"] == "self_revoke"


def test_revoke_ultimo_adm_auditado(client, backend_mocks, events):
    from app.services.invite_service import LastAdminError

    backend_mocks.invite_service.revoke_access.side_effect = LastAdminError("último")
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(client, "POST", f"/api/v1/users/{_TARGET_USER_ID}/revoke", token=make_token())
    assert response.status_code == 409
    assert any(
        e["event_type"] == "REVOKE_BLOCKED" and e["details"]["reason"] == "last_admin" for e in events
    )


def test_revoke_sucesso_gera_evento_notificavel(client, backend_mocks, events):
    with as_user({"ADM"}, ALL_ADMIN_PERMISSIONS):
        response = call(
            client, "POST", f"/api/v1/users/{_TARGET_USER_ID}/revoke", {"reason": "desligamento"},
            token=make_token(),
        )
    assert response.status_code == 200
    revoked = [e for e in events if e["event_type"] == "USER_ACCESS_REVOKED"]
    assert revoked and revoked[0]["result"] == "SUCESSO" and revoked[0]["notify"] is True
    assert revoked[0]["target"] == {"type": "user", "id": _TARGET_USER_ID}


# ---------------------------------------------------------------------------
# Ativação de convite — limitação de tentativas e falhas auditadas
# ---------------------------------------------------------------------------


def test_activate_invite_rate_limited(client, backend_mocks):
    backend_mocks.redis.incr.return_value = 11
    with as_user(set(), set()):
        response = call(client, "POST", "/api/v1/users/activate-invite", token=make_token(aal="aal1"))
    assert response.status_code == 429
    backend_mocks.invite_service.activate_invite.assert_not_called()


def test_activate_invite_expirado_ou_reutilizado_auditado(client, backend_mocks, events):
    from app.services.invite_service import InviteExpiredError, InviteNotFoundError

    for exc, status in ((InviteExpiredError("expirado"), 409), (InviteNotFoundError("já aceito"), 404)):
        backend_mocks.invite_service.activate_invite.side_effect = exc
        with as_user(set(), set()):
            response = call(client, "POST", "/api/v1/users/activate-invite", token=make_token(aal="aal1"))
        assert response.status_code == status
    reasons = [e["details"]["reason"] for e in events if e["event_type"] == "INVITE_ACTIVATION_FAILED"]
    assert reasons == ["expired", "not_found"]
