"""AUD-14-03 — decisão sobre `security.manage_mfa` na remoção de fator MFA.

A rota `DELETE /api/v1/security/mfa/factors/<uuid>` é autosserviço: NÃO exige
`security.manage_mfa` (exclusiva do ADM, reservada à futura recuperação
administrativa). Estes testes fixam o comportamento para evitar regressão
silenciosa em qualquer direção. Supabase e Redis mockados.
"""
from __future__ import annotations

import time
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest

from app import create_app

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"
FACTOR_ID = "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
OTHER_FACTOR_ID = "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5c"
URL = f"/api/v1/security/mfa/factors/{FACTOR_ID}"


def _token(aal: str = "aal2") -> dict:
    now = int(time.time())
    token = jwt.encode(
        {"sub": "auth-user-1", "aud": "authenticated", "role": "authenticated",
         "iat": now, "exp": now + 3600, "aal": aal},
        JWT_SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _as(roles: set[str], permissions: set[str]):
    user = SimpleNamespace(id=uuid.uuid4(), active=True, auth_user_id="auth-user-1")
    return patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(user, roles, permissions),
    )


@pytest.fixture()
def client():
    return create_app().test_client()


@pytest.fixture(autouse=True)
def redis_mock():
    fake = MagicMock()
    fake.incr.return_value = 1
    with patch("redis.Redis.from_url", return_value=fake):
        yield fake


@pytest.fixture()
def admin_client():
    mock = MagicMock()
    mock.list_mfa_factors.return_value = [
        {"id": FACTOR_ID, "status": "verified"},
        {"id": OTHER_FACTOR_ID, "status": "verified"},
    ]
    with patch("app.api.v1.security.SupabaseAdminClient", MagicMock(return_value=mock)):
        yield mock


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


def test_adm_aal2_com_permissao_remove_fator_proprio(client, admin_client, events):
    with _as({"ADM"}, {"security.manage_mfa"}):
        response = client.delete(URL, headers=_token("aal2"))
    assert response.status_code == 204
    admin_client.delete_mfa_factor.assert_called_once_with("auth-user-1", FACTOR_ID)
    assert any(e["event_type"] == "MFA_FACTOR_DELETED" for e in events)


def test_autosservico_user_sem_permissao_continua_permitido(client, admin_client):
    # Decisão AUD-14-03: permissão exclusiva do ADM não é exigida no autosserviço.
    with _as({"USER"}, set()):
        response = client.delete(URL, headers=_token("aal2"))
    assert response.status_code == 204
    admin_client.delete_mfa_factor.assert_called_once_with("auth-user-1", FACTOR_ID)


def test_sem_aal2_negado_mesmo_com_permissao(client, admin_client, events):
    with _as({"ADM"}, {"security.manage_mfa"}):
        response = client.delete(URL, headers=_token("aal1"))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    admin_client.list_mfa_factors.assert_not_called()
    admin_client.delete_mfa_factor.assert_not_called()
    assert any(e["event_type"] == "AAL2_REQUIRED" for e in events)


def test_sem_token_negado(client, admin_client):
    response = client.delete(URL)
    assert response.status_code == 401
    admin_client.delete_mfa_factor.assert_not_called()


def test_adm_nao_remove_unico_fator_verificado(client, admin_client, events):
    admin_client.list_mfa_factors.return_value = [{"id": FACTOR_ID, "status": "verified"}]
    with _as({"ADM"}, {"security.manage_mfa"}):
        response = client.delete(URL, headers=_token("aal2"))
    assert response.status_code == 409
    admin_client.delete_mfa_factor.assert_not_called()


def test_bootstrap_nao_depende_da_rota_de_remocao(client):
    """O cadastro do primeiro fator é feito no Supabase Auth; o backend não
    expõe rota de enroll/verify de fator (nada a quebrar em AAL1)."""
    rules = {r.rule for r in client.application.url_map.iter_rules()}
    assert not any("enroll" in r for r in rules)
    mfa_rules = [r for r in client.application.url_map.iter_rules() if "mfa/factors" in r.rule]
    assert [sorted(r.methods - {"HEAD", "OPTIONS"}) for r in mfa_rules] == [["DELETE"]]
