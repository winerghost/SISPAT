"""Testes de segurança — JWT ES256 via JWKS (Supabase Auth).

Chaves EC geradas no próprio teste; JWKS mockado (sem rede).
"""
from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import jwt
import pytest
import requests
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from app import create_app
from app.auth import jwks as jwks_mod
from app.config.settings import Settings, get_settings

HS_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"
SB_URL = "https://projeto-ficticio.supabase.co"
ISS = f"{SB_URL}/auth/v1"
JWKS_URL = f"{SB_URL}/auth/v1/.well-known/jwks.json"


def _gen(kid: str):
    priv = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(ECAlgorithm.to_jwk(priv.public_key()))
    jwk.update({"kid": kid, "use": "sig", "alg": "ES256"})
    return priv, jwk


KEY_A, JWK_A = _gen("kid-a")
KEY_B, JWK_B = _gen("kid-b")  # "outra chave"


def _claims(**over):
    now = int(time.time())
    c = {"sub": "auth-user-1", "aud": "authenticated", "role": "authenticated",
         "iat": now, "exp": now + 3600, "iss": ISS, "aal": "aal1"}
    c.update(over)
    return c


def _es(key=KEY_A, kid="kid-a", **over):
    headers = {"kid": kid} if kid else None
    return jwt.encode(_claims(**over), key, algorithm="ES256", headers=headers)


class FakeResp:
    def __init__(self, body=b"", status=200, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._body = body

    def iter_content(self, chunk_size=8192):
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i : i + chunk_size]

    def close(self):
        pass


def _jwks_body(*jwks):
    return json.dumps({"keys": list(jwks)}).encode()


@pytest.fixture()
def fetch():
    """Mock de requests.get no módulo jwks; `fetch.responses` define o retorno."""
    state = SimpleNamespace(calls=[], responses=[FakeResp(_jwks_body(JWK_A))])

    def fake_get(url, **kwargs):
        state.calls.append((url, kwargs))
        r = state.responses[min(len(state.calls) - 1, len(state.responses) - 1)]
        if isinstance(r, Exception):
            raise r
        return r

    jwks_mod.reset_jwks_cache()
    with patch("app.auth.jwks.requests.get", side_effect=fake_get):
        yield state
    jwks_mod.reset_jwks_cache()


@pytest.fixture()
def clock():
    t = SimpleNamespace(now=1000.0)
    with patch("app.auth.jwks.time.monotonic", side_effect=lambda: t.now):
        yield t


@pytest.fixture()
def client():
    custom = get_settings().model_copy(update={"supabase_url": SB_URL})
    fake_user = SimpleNamespace(id=uuid.uuid4(), active=True, name="X", email="x@exemplo.com")
    with patch("app.auth.supabase_auth.get_settings", return_value=custom), patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(fake_user, {"USER"}, set()),
    ):
        yield create_app().test_client()


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


def _me(client, token):
    return client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})


def test_es256_valido_e_aceito(client, fetch):
    assert _me(client, _es()).status_code == 200
    url, kwargs = fetch.calls[0]
    assert url == JWKS_URL
    assert kwargs["allow_redirects"] is False and kwargs["timeout"] <= 3


def test_es256_kid_desconhecido_rejeitado_sem_refetch_extra(client, fetch, events):
    t = _es(key=KEY_B, kid="kid-x")
    assert _me(client, t).status_code == 401
    assert _me(client, t).status_code == 401
    assert len(fetch.calls) == 1  # refetch limitado
    assert events[0]["details"]["reason"] == "invalid_token:UnknownKid"


def test_rotacao_um_refetch_depois_do_intervalo(client, fetch, clock):
    fetch.responses = [FakeResp(_jwks_body(JWK_A)), FakeResp(_jwks_body(JWK_A, JWK_B))]
    assert _me(client, _es()).status_code == 200
    clock.now += 31  # dentro do TTL, acima do intervalo mínimo
    assert _me(client, _es(key=KEY_B, kid="kid-b")).status_code == 200
    assert len(fetch.calls) == 2


def test_es256_assinado_por_outra_chave_rejeitado(client, fetch):
    assert _me(client, _es(key=KEY_B, kid="kid-a")).status_code == 401


def test_es256_sem_kid_rejeitado(client, fetch):
    assert _me(client, _es(kid=None)).status_code == 401
    assert fetch.calls == []


def test_hs256_com_segredo_correto_aceito(client, fetch):
    token = jwt.encode(_claims(), HS_SECRET, algorithm="HS256")
    assert _me(client, token).status_code == 200
    assert fetch.calls == []


def _forge_hs256(secret: bytes, kid: str | None = None) -> str:
    """HS256 montado à mão (PyJWT recusa PEM como segredo HMAC)."""
    import hashlib
    import hmac

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    header = {"alg": "HS256", "typ": "JWT"}
    if kid:
        header["kid"] = kid
    signing = f"{b64(json.dumps(header).encode())}.{b64(json.dumps(_claims()).encode())}"
    sig = hmac.new(secret, signing.encode(), hashlib.sha256).digest()
    return f"{signing}.{b64(sig)}"


def test_hs256_forjado_com_chave_publica_como_segredo_rejeitado(client, fetch):
    from cryptography.hazmat.primitives import serialization as ser

    pem = ECAlgorithm.from_jwk(json.dumps(JWK_A)).public_bytes(
        encoding=ser.Encoding.PEM, format=ser.PublicFormat.SubjectPublicKeyInfo
    )
    for secret in (pem, json.dumps(JWK_A).encode(), JWK_A["x"].encode()):
        assert _me(client, _forge_hs256(secret, kid="kid-a")).status_code == 401


def test_alg_none_rejeitado(client, fetch):
    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    token = f"{b64({'alg': 'none', 'typ': 'JWT', 'kid': 'kid-a'})}.{b64(_claims())}."
    assert _me(client, token).status_code == 401


def test_outro_alg_rejeitado(client, fetch):
    token = jwt.encode(_claims(), HS_SECRET, algorithm="HS512")
    assert _me(client, token).status_code == 401


@pytest.mark.parametrize(
    "over",
    [{"aud": "anon"}, {"iss": "https://evil.example/auth/v1"}, {"exp": int(time.time()) - 3600}],
)
def test_claims_invalidos_rejeitados(client, fetch, over):
    assert _me(client, _es(**over)).status_code == 401


@pytest.mark.parametrize(
    "response",
    [
        FakeResp(b"", status=302, headers={"Location": "https://evil.example/"}),
        requests.Timeout("t"),
        FakeResp(b"nao-e-json"),
        FakeResp(b"x" * (200 * 1024)),
        FakeResp(b'{"keys": "nope"}'),
        FakeResp(json.dumps({"keys": [{**JWK_A, "kty": "RSA"}]}).encode()),
    ],
)
def test_jwks_invalido_ou_indisponivel_fail_closed(client, fetch, events, response):
    fetch.responses = [response]
    assert _me(client, _es()).status_code == 401
    assert events[0]["details"]["reason"] == "jwks_unavailable"


def test_cache_unica_busca_para_n_tokens(client, fetch):
    for _ in range(5):
        assert _me(client, _es()).status_code == 200
    assert len(fetch.calls) == 1


def test_cache_usado_se_jwks_cai_apos_expirar(client, fetch, clock):
    assert _me(client, _es()).status_code == 200
    clock.now += 700  # TTL de 600 s expirado
    fetch.responses = [FakeResp(b"", status=503)]
    assert _me(client, _es()).status_code == 200


def test_token_nunca_aparece_em_logs_ou_eventos(client, fetch, events, caplog):
    token = _es(key=KEY_B, kid="kid-a")
    with caplog.at_level(logging.DEBUG):
        assert _me(client, token).status_code == 401
    assert token not in caplog.text
    assert token not in json.dumps(events, default=str)


def test_es256_desabilitado_por_config_rejeita(fetch):
    custom = get_settings().model_copy(
        update={"supabase_url": SB_URL, "supabase_jwt_algorithms": "HS256"}
    )
    with pytest.raises(jwt.InvalidAlgorithmError):
        from app.auth.supabase_auth import _decode_supabase_jwt

        _decode_supabase_jwt(_es(), custom)


def test_producao_so_es256_nao_exige_segredo_hs256():
    kw = dict(
        database_url="postgresql+psycopg2://u:p@localhost/db",
        _env_file=None,
        flask_env="production",
        cors_allowed_origins="https://app.example.test",
        secret_key="s" * 40,
        supabase_jwt_secret="curto",
        supabase_jwt_algorithms="ES256",
    )
    Settings(**kw)
    with pytest.raises(ValueError):
        Settings(**{**kw, "supabase_jwt_algorithms": "HS256,ES256"})
    with pytest.raises(ValueError):
        Settings(**{**kw, "supabase_jwt_algorithms": "none"})


def test_producao_exige_https_no_jwks(fetch):
    custom = get_settings().model_copy(
        update={"supabase_url": "http://x.example", "flask_env": "production"}
    )
    with pytest.raises(jwks_mod.JwksUnavailableError):
        jwks_mod.get_signing_key("kid-a", custom)
    assert fetch.calls == []
