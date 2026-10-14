"""Testes de segurança — validação do JWT do Supabase Auth (A07 / API2).

Confirma a correção de `require_auth` (`app.auth.supabase_auth`): exige
`exp`, `iat`, `sub`, `aud="authenticated"`, `role="authenticated"`, `iss`
(quando configurado) e somente HS256. Tokens sintéticos assinados com o
segredo FICTÍCIO de `tests/conftest.py`; nenhum acesso a banco/Supabase.
"""
from __future__ import annotations

import base64
import json
import time
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import jwt
import pytest

from app import create_app
from app.config.settings import Settings, get_settings

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"
ME_URL = "/api/v1/me"


def _claims(**overrides):
    now = int(time.time())
    claims = {
        "sub": "auth-user-1",
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        "aal": "aal1",
    }
    for key, value in overrides.items():
        if value is _DROP:
            claims.pop(key, None)
        else:
            claims[key] = value
    return claims


_DROP = object()


def _token(**overrides) -> str:
    return jwt.encode(_claims(**overrides), JWT_SECRET, algorithm="HS256")


@pytest.fixture()
def client():
    return create_app().test_client()


@pytest.fixture(autouse=True)
def _authenticated_user():
    fake_user = SimpleNamespace(id=uuid.uuid4(), active=True, name="X", email="x@exemplo.com")
    with patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, {"USER"}, set()),
    ) as loader:
        yield loader


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


def _get_me(client, token):
    return client.get(ME_URL, headers={"Authorization": f"Bearer {token}"})


def test_token_valido_completo_e_aceito(client):
    assert _get_me(client, _token()).status_code == 200


@pytest.mark.parametrize("missing", ["exp", "iat", "sub", "aud", "role"])
def test_token_sem_claim_obrigatorio_e_rejeitado(client, events, missing):
    response = _get_me(client, _token(**{missing: _DROP}))
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "unauthorized"
    assert events and events[0]["event_type"] == "AUTH_FAILED"


@pytest.mark.parametrize(
    "overrides",
    [
        {"exp": int(time.time()) - 3600},  # expirado (fora do leeway)
        {"aud": "anon"},
        {"aud": "outro-projeto"},
        {"role": "anon"},
        {"role": "service_role"},
        {"sub": ""},
        {"sub": "x" * 300},
        {"iat": "agora"},
    ],
)
def test_claims_invalidos_sao_rejeitados(client, overrides):
    assert _get_me(client, _token(**overrides)).status_code == 401


def test_chave_service_role_do_supabase_nao_autentica(client):
    """Chaves `anon`/`service_role` (JWTs sem `sub`) nunca valem como usuário."""
    service_role_like = jwt.encode(
        {"iss": "supabase", "ref": "projeto", "role": "service_role",
         "iat": int(time.time()), "exp": int(time.time()) + 10**8},
        JWT_SECRET,
        algorithm="HS256",
    )
    assert _get_me(client, service_role_like).status_code == 401


def test_token_expirado_dentro_do_leeway_e_aceito(client):
    assert _get_me(client, _token(exp=int(time.time()) - 5)).status_code == 200


def test_alg_none_e_rejeitado(client):
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).rstrip(b"=")
    payload = base64.urlsafe_b64encode(json.dumps(_claims()).encode()).rstrip(b"=")
    unsigned = f"{header.decode()}.{payload.decode()}."
    assert _get_me(client, unsigned).status_code == 401


def test_hs512_com_mesmo_segredo_e_rejeitado(client):
    token = jwt.encode(_claims(), JWT_SECRET, algorithm="HS512")
    assert _get_me(client, token).status_code == 401


def test_token_gigante_e_rejeitado_sem_decodificar(client, events):
    response = _get_me(client, "a" * 9000)
    assert response.status_code == 401
    assert events[0]["details"]["reason"] == "token_too_large"


def test_usuario_inexistente_ou_inativo_retorna_401_identico(client, _authenticated_user):
    _authenticated_user.return_value = None
    r_missing = _get_me(client, _token())
    _authenticated_user.return_value = (SimpleNamespace(id=uuid.uuid4(), active=False), {"ADM"}, set())
    r_inactive = _get_me(client, _token())
    assert r_missing.status_code == r_inactive.status_code == 401
    assert r_missing.get_json() == r_inactive.get_json()


@pytest.fixture()
def settings_with_issuer():
    base = get_settings()
    custom = base.model_copy(update={"supabase_url": "https://projeto-ficticio.supabase.co/"})
    with patch("app.auth.supabase_auth.get_settings", return_value=custom):
        yield custom


def test_issuer_derivado_de_supabase_url_e_exigido(client, settings_with_issuer):
    expected_iss = "https://projeto-ficticio.supabase.co/auth/v1"
    assert settings_with_issuer.supabase_jwt_expected_issuer == expected_iss
    assert _get_me(client, _token(iss=expected_iss)).status_code == 200
    assert _get_me(client, _token(iss="https://atacante.example/auth/v1")).status_code == 401
    assert _get_me(client, _token()).status_code == 401  # sem `iss`


def test_evento_de_falha_nao_contem_token(client, events):
    token = _token(aud="anon")
    _get_me(client, token)
    assert events
    assert token not in repr(events)
    assert "Bearer" not in repr(events)


# --- Settings: segredos curtos recusados em produção ------------------------


def _settings_kwargs(**overrides):
    base = {
        "database_url": "postgresql+psycopg2://user:pass@localhost:5432/test",
        "secret_key": "s" * 40,
        "supabase_jwt_secret": "j" * 40,
        "flask_env": "production",
        "_env_file": None,
    }
    base.update(overrides)
    return base


def test_producao_recusa_jwt_secret_curto():
    with pytest.raises(ValueError):
        Settings(**_settings_kwargs(supabase_jwt_secret="curto"))


def test_producao_recusa_secret_key_vazia_ou_curta():
    with pytest.raises(ValueError):
        Settings(**_settings_kwargs(secret_key=""))
    with pytest.raises(ValueError):
        Settings(**_settings_kwargs(secret_key="curta"))


def test_producao_aceita_segredos_longos_e_testing_nao_exige():
    assert Settings(**_settings_kwargs()).is_production
    assert not Settings(**_settings_kwargs(flask_env="testing", secret_key="x", supabase_jwt_secret="y")).is_production


def test_producao_recusa_db_echo():
    with pytest.raises(ValueError):
        Settings(**_settings_kwargs(db_echo=True))


def test_campos_antes_lidos_via_getattr_estao_declarados():
    fields = Settings.model_fields
    for name in ("google_sheets_timeout_seconds", "db_sslmode", "db_sslrootcert",
                 "google_sheets_credentials_json", "google_sheets_spreadsheet_id"):
        assert name in fields
