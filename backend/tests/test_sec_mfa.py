"""Testes de segurança — `DELETE /api/v1/security/mfa/factors/<factor_id>`.

Regressão de:
    - path traversal / injeção na URL da API Admin do Supabase via
      `factor_id` não validado (`..`, `%2E%2E`, `?`, `#`);
    - bypass da regra "ADM não remove o único fator verificado" enviando o
      mesmo UUID em maiúsculas;
    - remoção de fator que não pertence ao usuário;
    - limitação de tentativas e auditoria.
Supabase e Redis sempre mockados.
"""
from __future__ import annotations

import time
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest

from app import create_app
from app.integrations.supabase_admin_client import SupabaseAdminClientError

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"
FACTOR_ID = "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
OTHER_FACTOR_ID = "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5c"


def _token(aal: str = "aal2") -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": "auth-user-1", "aud": "authenticated", "role": "authenticated",
         "iat": now, "exp": now + 3600, "aal": aal},
        JWT_SECRET,
        algorithm="HS256",
    )


def _url(factor_id: str) -> str:
    return f"/api/v1/security/mfa/factors/{factor_id}"


@pytest.fixture()
def client():
    return create_app().test_client()


@pytest.fixture()
def redis_mock():
    fake = MagicMock()
    fake.incr.return_value = 1
    with patch("redis.Redis.from_url", return_value=fake):
        yield fake


@pytest.fixture()
def admin_client():
    client = MagicMock()
    client.list_mfa_factors.return_value = [
        {"id": FACTOR_ID, "status": "verified"},
    ]
    with patch("app.api.v1.security.SupabaseAdminClient", MagicMock(return_value=client)):
        yield client


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


def _as(roles: set[str]):
    user = SimpleNamespace(id=uuid.uuid4(), active=True, auth_user_id="auth-user-1")
    return patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(user, roles, set()),
    )


@pytest.mark.parametrize(
    "malicious",
    ["..", "%2E%2E", "%2e%2e", "abc", "1", "x%3Fy%3D1", "x%23frag", "..%2F..", "%2F", FACTOR_ID + "x"],
)
def test_factor_id_nao_uuid_retorna_404_sem_chamar_supabase(client, redis_mock, admin_client, malicious):
    with _as({"USER"}):
        response = client.delete(_url(malicious), headers={"Authorization": f"Bearer {_token()}"})
    assert response.status_code == 404
    admin_client.delete_mfa_factor.assert_not_called()
    admin_client.list_mfa_factors.assert_not_called()


def test_adm_nao_contorna_regra_do_unico_fator_com_uuid_maiusculo(client, redis_mock, admin_client, events):
    with _as({"ADM"}):
        response = client.delete(
            _url(FACTOR_ID.upper()), headers={"Authorization": f"Bearer {_token()}"}
        )
    assert response.status_code == 409
    admin_client.delete_mfa_factor.assert_not_called()
    assert any(e["event_type"] == "MFA_FACTOR_DELETE_BLOCKED" for e in events)


def test_fator_de_outro_usuario_ou_inexistente_retorna_404(client, redis_mock, admin_client):
    with _as({"USER"}):
        response = client.delete(
            _url(OTHER_FACTOR_ID), headers={"Authorization": f"Bearer {_token()}"}
        )
    assert response.status_code == 404
    admin_client.delete_mfa_factor.assert_not_called()


def test_remocao_valida_usa_uuid_canonico_e_e_auditada(client, redis_mock, admin_client, events):
    admin_client.list_mfa_factors.return_value = [
        {"id": FACTOR_ID, "status": "verified"},
        {"id": OTHER_FACTOR_ID, "status": "verified"},
    ]
    with _as({"ADM"}):
        response = client.delete(
            _url(FACTOR_ID.upper()), headers={"Authorization": f"Bearer {_token()}"}
        )
    assert response.status_code == 204
    admin_client.delete_mfa_factor.assert_called_once_with("auth-user-1", FACTOR_ID)
    deleted = [e for e in events if e["event_type"] == "MFA_FACTOR_DELETED"]
    assert deleted and deleted[0]["notify"] is True and deleted[0]["result"] == "SUCESSO"


def test_sessao_aal1_bloqueada(client, redis_mock, admin_client):
    with _as({"USER"}):
        response = client.delete(_url(FACTOR_ID), headers={"Authorization": f"Bearer {_token('aal1')}"})
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    admin_client.list_mfa_factors.assert_not_called()


def test_rate_limit_aplicado(client, redis_mock, admin_client):
    redis_mock.incr.return_value = 6
    with _as({"USER"}):
        response = client.delete(_url(FACTOR_ID), headers={"Authorization": f"Bearer {_token()}"})
    assert response.status_code == 429
    admin_client.delete_mfa_factor.assert_not_called()


def test_falha_upstream_retorna_502_generico(client, redis_mock, admin_client):
    admin_client.delete_mfa_factor.side_effect = SupabaseAdminClientError(
        "API Admin respondeu 500 para DELETE /auth/v1/admin/users/..."
    )
    admin_client.list_mfa_factors.return_value = [
        {"id": FACTOR_ID, "status": "unverified"},
    ]
    with _as({"USER"}):
        response = client.delete(_url(FACTOR_ID), headers={"Authorization": f"Bearer {_token()}"})
    assert response.status_code == 502
    body = response.get_data(as_text=True)
    assert "/auth/v1" not in body and "500" not in body


def test_identificador_rejeitado_pelo_cliente_vira_404_e_nao_502(client, redis_mock, admin_client):
    from app.integrations.supabase_admin_client import InvalidIdentifierError

    admin_client.list_mfa_factors.return_value = [{"id": FACTOR_ID, "status": "unverified"}]
    admin_client.delete_mfa_factor.side_effect = InvalidIdentifierError("formato inválido")
    with _as({"USER"}):
        response = client.delete(_url(FACTOR_ID), headers={"Authorization": f"Bearer {_token()}"})
    assert response.status_code == 404
