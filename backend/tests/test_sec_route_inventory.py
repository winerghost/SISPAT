"""Teste-guarda: TODA rota do backend exige autenticação (auditoria pré-deploy 2026-10-14).

Objetivo (pedido explícito do usuário): provar que o sistema identifica que o
usuário está logado ANTES de executar qualquer ação, e que isso continua
verdadeiro quando surgirem rotas novas.

Como funciona:
    1. Percorre `create_app().url_map` (inventário DINÂMICO — nada é listado à mão
       para o teste de 401). Cada par (regra, método), exceto OPTIONS, que não
       esteja na `PUBLIC_ALLOWLIST` é tratado como protegido.
    2. Monta a URL com IDs sintéticos válidos (uuid4) para cada conversor.
    3. Para cada rota protegida e cada cenário de credencial inválida, exige 401
       com o corpo padronizado, sem tocar o banco (`SessionLocal` substituído por
       um sentinela que FALHA se for chamado) e sem executar a view.
    4. `EXPECTED_POLICY` classifica cada rota (auth / aal2 / admin+permissão). Uma
       rota nova que não for classificada aqui faz `test_inventario_*` FALHAR:
       quem criar a rota precisa decidir, explicitamente, a política dela.

Allowlist pública (justificativa, revisar a cada rota nova):
    - GET/HEAD /api/health e /api/v1/health: healthcheck do Docker/CloudPanel;
      resposta fixa `{"status":"ok"}` ou 503 genérico, sem dados.
    - (removida) /static/<path:filename>: a rota implícita do Flask foi
      eliminada com `Flask(__name__, static_folder=None)` (PREDEPLOY-07/B-4,
      ver `test_api_nao_registra_rota_static`).

Tokens: JWT sintéticos assinados com o segredo FICTÍCIO de `tests/conftest.py`
(ou com chaves de "atacante" geradas aqui). Nenhum acesso a banco, Redis,
Supabase, VPS, Google ou n8n.
"""
from __future__ import annotations

import base64
import json
import re
import time
import uuid
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from app import create_app
from app.config.settings import get_settings

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # = tests/conftest.py
ISSUER_BASE = "https://projeto-ficticio.supabase.co"
ISSUER = f"{ISSUER_BASE}/auth/v1"
AUTH_SUB = "auth-user-inventario-1"

# ---------------------------------------------------------------------------
# Allowlist pública e política esperada por rota
# ---------------------------------------------------------------------------

PUBLIC_ALLOWLIST: dict[tuple[str, str], str] = {
    ("/api/health", "GET"): "healthcheck legado (Dockerfile/compose)",
    ("/api/health", "HEAD"): "healthcheck legado (Dockerfile/compose)",
    ("/api/v1/health", "GET"): "healthcheck versionado",
    ("/api/v1/health", "HEAD"): "healthcheck versionado",
}

AUTH = "auth"  # só exige usuário autenticado e ativo (por design)
AAL2 = "aal2"  # autenticado + MFA concluído (qualquer perfil)
ADMIN = "admin"  # ADM + AAL2 + permissão granular

EXPECTED_POLICY: dict[tuple[str, str], tuple[str, str | None]] = {
    ("/api/v1/me", "GET"): (AUTH, None),
    ("/api/v1/me", "HEAD"): (AUTH, None),
    ("/api/v1/users/activate-invite", "POST"): (AUTH, None),
    ("/api/v1/security/mfa/factors/<uuid:factor_id>", "DELETE"): (AAL2, None),
    ("/api/v1/users", "GET"): (ADMIN, "users.manage"),
    ("/api/v1/users", "HEAD"): (ADMIN, "users.manage"),
    ("/api/v1/users/invite", "POST"): (ADMIN, "users.invite"),
    ("/api/v1/users/<uuid:user_id>/revoke", "POST"): (ADMIN, "users.revoke_access"),
    ("/api/v1/imports/google-sheets/preview", "POST"): (ADMIN, "imports.execute"),
    ("/api/v1/imports/google-sheets/preview/<uuid:preview_id>/items", "GET"): (ADMIN, "imports.execute"),
    ("/api/v1/imports/google-sheets/preview/<uuid:preview_id>/items", "HEAD"): (ADMIN, "imports.execute"),
    ("/api/v1/imports/google-sheets/confirm", "POST"): (ADMIN, "imports.execute"),
    ("/api/v1/settings/ai", "GET"): (ADMIN, "settings.ai.manage"),
    ("/api/v1/settings/ai", "HEAD"): (ADMIN, "settings.ai.manage"),
    ("/api/v1/settings/ai", "PATCH"): (ADMIN, "settings.ai.manage"),
    ("/api/v1/settings/ai/test", "POST"): (ADMIN, "settings.ai.manage"),
    ("/api/v1/settings/email/test", "POST"): (ADMIN, "settings.email.manage"),
    ("/api/v1/security/mfa/factor-added-notice", "POST"): (AUTH, None),
    # --- Gestão de usuários (Etapa 2) ---
    ("/api/v1/me/avatar", "PUT"): (AUTH, None),
    ("/api/v1/me/avatar", "DELETE"): (AUTH, None),
    ("/api/v1/me/avatar-url", "GET"): (AUTH, None),
    ("/api/v1/me/avatar-url", "HEAD"): (AUTH, None),
    ("/api/v1/me/preferences", "GET"): (AUTH, None),
    ("/api/v1/me/preferences", "HEAD"): (AUTH, None),
    ("/api/v1/me/preferences", "PATCH"): (AUTH, None),
    ("/api/v1/units", "GET"): (ADMIN, "users.manage"),
    ("/api/v1/units", "HEAD"): (ADMIN, "users.manage"),
    ("/api/v1/users/<uuid:user_id>", "GET"): (ADMIN, "users.manage"),
    ("/api/v1/users/<uuid:user_id>", "HEAD"): (ADMIN, "users.manage"),
    # PATCH: users.manage no decorator + users.assign_role/assign_unit por campo.
    ("/api/v1/users/<uuid:user_id>", "PATCH"): (ADMIN, "users.manage"),
    ("/api/v1/users/<uuid:user_id>/deactivate", "POST"): (ADMIN, "users.deactivate"),
    ("/api/v1/users/<uuid:user_id>/activate", "POST"): (ADMIN, "users.activate"),
    ("/api/v1/users/<uuid:user_id>/revoke-sessions", "POST"): (ADMIN, "users.revoke_sessions"),
    ("/api/v1/users/<uuid:user_id>/password-reset", "POST"): (ADMIN, "users.reset_password"),
    ("/api/v1/users/<uuid:user_id>/mfa-reset", "POST"): (ADMIN, "users.reset_mfa"),
    ("/api/v1/users/<uuid:user_id>/audit", "GET"): (ADMIN, "audit.read"),
    ("/api/v1/users/<uuid:user_id>/audit", "HEAD"): (ADMIN, "audit.read"),
    ("/api/v1/users/<uuid:user_id>/avatar", "PUT"): (ADMIN, "users.avatar.manage"),
    ("/api/v1/users/<uuid:user_id>/avatar", "DELETE"): (ADMIN, "users.avatar.manage"),
    ("/api/v1/users/<uuid:user_id>/avatar-url", "GET"): (ADMIN, "users.manage"),
    ("/api/v1/users/<uuid:user_id>/avatar-url", "HEAD"): (ADMIN, "users.manage"),
}

ALL_PERMISSIONS = {perm for _, perm in EXPECTED_POLICY.values() if perm} | {
    "users.deactivate",
    "users.assign_role",
    "users.assign_unit",
    "audit.read",
    "users.activate",
    "users.reset_password",
    "users.reset_mfa",
    "users.revoke_sessions",
    "users.avatar.manage",
}

_CONVERTER_RE = re.compile(r"<(?:(?P<conv>[a-zA-Z_][a-zA-Z0-9_]*)(?:\([^)]*\))?:)?(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)>")


def _build_url(rule: str) -> str:
    """Substitui cada conversor por um valor sintético VÁLIDO para ele."""

    def repl(match: re.Match[str]) -> str:
        conv = match.group("conv") or "default"
        if conv == "uuid":
            return str(uuid.uuid4())
        if conv in {"int"}:
            return "1"
        if conv in {"path", "string", "default"}:
            return "x"
        raise AssertionError(
            f"conversor desconhecido <{conv}:...> em {rule}: atualize _build_url "
            "para gerar um valor válido (senão o 401 poderia ser 404 por engano)."
        )

    return _CONVERTER_RE.sub(repl, rule)


def _route_inventory() -> list[tuple[str, str]]:
    app = create_app()
    pairs: set[tuple[str, str]] = set()
    for rule in app.url_map.iter_rules():
        for method in rule.methods or ():
            if method == "OPTIONS":
                continue
            pairs.add((rule.rule, method))
    return sorted(pairs)


INVENTORY = _route_inventory()
PROTECTED = [pair for pair in INVENTORY if pair not in PUBLIC_ALLOWLIST]


def _ids(pairs):
    return [f"{method} {rule}" for rule, method in pairs]


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


def _claims(**overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": AUTH_SUB,
        "aud": "authenticated",
        "role": "authenticated",
        "iss": ISSUER,
        "iat": now,
        "exp": now + 3600,
        "aal": "aal2",
    }
    for key, value in overrides.items():
        if value is _DROP:
            claims.pop(key, None)
        else:
            claims[key] = value
    return claims


_DROP = object()


def _hs256(**overrides: Any) -> str:
    return jwt.encode(_claims(**overrides), JWT_SECRET, algorithm="HS256")


def _b64(obj: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def _unsigned(alg: str) -> str:
    return f"{_b64({'alg': alg, 'typ': 'JWT'})}.{_b64(_claims())}."


def _hmac_with_header_alg(alg: str) -> str:
    """Confusão de algoritmo: header diz RS/ES, assinatura é HMAC com o segredo."""
    import hashlib
    import hmac

    signing_input = f"{_b64({'alg': alg, 'typ': 'JWT'})}.{_b64(_claims())}"
    sig = hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def _tampered_payload() -> str:
    """Assinatura válida de um token, payload trocado (sub de outra pessoa)."""
    header, _payload, sig = _hs256().split(".")
    return f"{header}.{_b64(_claims(sub='auth-outra-pessoa'))}.{sig}"


_ATTACKER_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_ATTACKER_EC = ec.generate_private_key(ec.SECP256R1())


# Cada cenário devolve (headers, query_string, cookies, loader_result_factory).
# loader_result_factory=None => o carregador de usuário NÃO pode ser chamado.
Scenario = Callable[[], dict[str, Any]]


def _bearer(token: str) -> dict[str, Any]:
    return {"headers": {"Authorization": f"Bearer {token}"}}


SCENARIOS: dict[str, Scenario] = {
    # --- ausência / formato do header ---
    "sem_credencial": lambda: {},
    "bearer_vazio": lambda: {"headers": {"Authorization": "Bearer "}},
    "bearer_so_espacos": lambda: {"headers": {"Authorization": "Bearer      "}},
    "esquema_minusculo": lambda: {"headers": {"Authorization": f"bearer {_hs256()}"}},
    "esquema_token": lambda: {"headers": {"Authorization": f"Token {_hs256()}"}},
    "esquema_basic": lambda: {"headers": {"Authorization": "Basic dXN1YXJpbzpzZW5oYQ=="}},
    "sem_esquema": lambda: {"headers": {"Authorization": _hs256()}},
    "dois_tokens": lambda: _bearer(f"{_hs256()} {_hs256()}"),
    "token_lixo": lambda: _bearer("abc.def.ghi"),
    "token_sem_pontos": lambda: _bearer("x" * 40),
    # --- token fora do header (não aceito) ---
    "query_access_token": lambda: {"query_string": {"access_token": _hs256()}},
    "query_token": lambda: {"query_string": {"token": _hs256(), "jwt": _hs256()}},
    "cookie_sb_access_token": lambda: {"cookies": {"sb-access-token": _hs256()}},
    "cookie_access_token": lambda: {"cookies": {"access_token": _hs256(), "sispat-auth": _hs256()}},
    "cookie_authorization": lambda: {"cookies": {"Authorization": f"Bearer {_hs256()}"}},
    "header_x_access_token": lambda: {"headers": {"X-Access-Token": _hs256(), "X-Auth-Token": _hs256()}},
    "header_apikey": lambda: {"headers": {"apikey": _hs256()}},
    # --- validade temporal ---
    "expirado": lambda: _bearer(_hs256(exp=int(time.time()) - 3600)),
    "exp_ausente": lambda: _bearer(_hs256(exp=_DROP)),
    "iat_ausente": lambda: _bearer(_hs256(iat=_DROP)),
    "nbf_no_futuro": lambda: _bearer(_hs256(nbf=int(time.time()) + 3600)),
    "iat_no_futuro": lambda: _bearer(_hs256(iat=int(time.time()) + 3600)),
    # --- assinatura / algoritmo ---
    "assinatura_outro_segredo": lambda: _bearer(
        jwt.encode(_claims(), "segredo-do-atacante-com-mais-de-32-caracteres", algorithm="HS256")
    ),
    "payload_adulterado": lambda: _bearer(_tampered_payload()),
    "alg_none": lambda: _bearer(_unsigned("none")),
    "alg_None_maiusculo": lambda: _bearer(_unsigned("None")),
    "alg_HS512_mesmo_segredo": lambda: _bearer(jwt.encode(_claims(), JWT_SECRET, algorithm="HS512")),
    "alg_RS256_confusao_hmac": lambda: _bearer(_hmac_with_header_alg("RS256")),
    "alg_ES256_confusao_hmac": lambda: _bearer(_hmac_with_header_alg("ES256")),
    "alg_RS256_chave_atacante": lambda: _bearer(jwt.encode(_claims(), _ATTACKER_RSA, algorithm="RS256")),
    "alg_ES256_chave_atacante": lambda: _bearer(jwt.encode(_claims(), _ATTACKER_EC, algorithm="ES256")),
    # --- audiência / emissor ---
    "aud_errado": lambda: _bearer(_hs256(aud="outro-projeto")),
    "aud_anon": lambda: _bearer(_hs256(aud="anon")),
    "aud_ausente": lambda: _bearer(_hs256(aud=_DROP)),
    "iss_errado": lambda: _bearer(_hs256(iss="https://atacante.example/auth/v1")),
    "iss_ausente": lambda: _bearer(_hs256(iss=_DROP)),
    # --- sujeito / papel ---
    "sub_ausente": lambda: _bearer(_hs256(sub=_DROP)),
    "sub_vazio": lambda: _bearer(_hs256(sub="")),
    "sub_numerico": lambda: _bearer(_hs256(sub=12345)),
    "sub_gigante": lambda: _bearer(_hs256(sub="s" * 300)),
    "role_ausente": lambda: _bearer(_hs256(role=_DROP)),
    "role_anon": lambda: _bearer(_hs256(role="anon")),
    "role_service_role": lambda: _bearer(_hs256(role="service_role")),
    "role_ADM_no_jwt": lambda: _bearer(_hs256(role="ADM")),
    # --- tamanho ---
    "token_gigante_assinado": lambda: _bearer(_hs256(padding="p" * 9000)),
}

# Cenários em que o token é VÁLIDO, mas o usuário local não pode entrar.
USER_STATE_SCENARIOS = {
    "usuario_inexistente_local": None,
    "usuario_inativo": "inactive",
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def guarded(monkeypatch):
    """App + sentinelas: banco, carregador de usuário e eventos de segurança."""
    custom = get_settings().model_copy(update={"supabase_url": ISSUER_BASE})
    db_sentinel = MagicMock(side_effect=AssertionError("o banco NÃO pode ser tocado sem autenticação"))
    loader = MagicMock(return_value=None)
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        stack.enter_context(patch("app.auth.supabase_auth.get_settings", return_value=custom))
        stack.enter_context(patch("app.database.session.SessionLocal", db_sentinel))
        stack.enter_context(
            patch("app.auth.supabase_auth._load_user_with_roles_and_permissions", loader)
        )
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=events.append)
        )
        redis_sentinel = stack.enter_context(
            patch("redis.Redis.from_url", side_effect=AssertionError("Redis não pode ser tocado"))
        )
        app = create_app()
        yield SimpleNamespace(
            client=app.test_client(),
            db=db_sentinel,
            loader=loader,
            events=events,
            redis=redis_sentinel,
        )


def _open(client, rule: str, method: str, *, headers=None, query_string=None, cookies=None):
    for name, value in (cookies or {}).items():
        client.set_cookie(name, value)
    kwargs: dict[str, Any] = {"headers": headers or {}, "query_string": query_string or {}}
    if method in {"POST", "PATCH", "PUT", "DELETE"}:
        kwargs["json"] = {}
    return client.open(_build_url(rule), method=method, **kwargs)


def _assert_401_sem_dados(response, method: str) -> None:
    assert response.status_code == 401, response.get_data(as_text=True)[:300]
    if method == "HEAD":
        assert response.get_data() == b""
        return
    body = response.get_json()
    assert body == {"error": {"code": "unauthorized", "message": body["error"]["message"]}}
    assert response.headers.get("Cache-Control") == "no-store"


# ---------------------------------------------------------------------------
# 1) Inventário: toda rota está classificada (rota nova => teste falha)
# ---------------------------------------------------------------------------


def test_inventario_de_rotas_esta_classificado():
    """Falha quando surge rota/método novo sem política explícita.

    Ao adicionar uma rota: proteja-a com `require_auth` (+ papel/AAL2/permissão)
    e registre-a em `EXPECTED_POLICY`. Rota pública exige justificativa em
    `PUBLIC_ALLOWLIST` e revisão de segurança.
    """
    current = set(INVENTORY)
    declared = set(EXPECTED_POLICY) | set(PUBLIC_ALLOWLIST)
    novas = sorted(current - declared)
    removidas = sorted(declared - current)
    assert not novas, f"rotas sem política declarada (classifique-as): {novas}"
    assert not removidas, f"política declarada para rotas inexistentes: {removidas}"


def test_nao_ha_rota_de_cadastro_publico():
    rules = {rule for rule, _ in INVENTORY}
    for proibida in ("register", "signup", "sign-up", "sign_up"):
        assert not any(proibida in rule.lower() for rule in rules)


def test_inventario_tem_rotas_protegidas_suficientes():
    """Sanidade: o teste dinâmico não pode passar 'vazio'."""
    assert len(PROTECTED) >= 16
    assert all(pair in EXPECTED_POLICY for pair in PROTECTED)


# ---------------------------------------------------------------------------
# 2) 401 em TODA rota protegida, para TODA credencial inválida
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scenario", sorted(SCENARIOS))
@pytest.mark.parametrize("rule,method", PROTECTED, ids=_ids(PROTECTED))
def test_rota_protegida_rejeita_credencial_invalida(guarded, rule, method, scenario):
    request_kwargs = SCENARIOS[scenario]()
    response = _open(guarded.client, rule, method, **request_kwargs)

    _assert_401_sem_dados(response, method)
    guarded.db.assert_not_called()
    guarded.redis.assert_not_called()
    # Nenhum cenário inválido chega a consultar o usuário local.
    guarded.loader.assert_not_called()
    # Nenhum segredo/token ecoado na resposta ou nos eventos.
    blob = response.get_data(as_text=True) + repr(guarded.events)
    for value in (request_kwargs.get("headers") or {}).values():
        token = value.split(" ")[-1]
        if len(token) > 20:
            assert token not in blob


@pytest.mark.parametrize("state", sorted(USER_STATE_SCENARIOS))
@pytest.mark.parametrize("rule,method", PROTECTED, ids=_ids(PROTECTED))
def test_rota_protegida_rejeita_usuario_inexistente_ou_inativo(guarded, rule, method, state):
    if USER_STATE_SCENARIOS[state] == "inactive":
        user = SimpleNamespace(id=uuid.uuid4(), active=False, auth_user_id=AUTH_SUB)
        guarded.loader.return_value = (user, {"ADM"}, set(ALL_PERMISSIONS))
    else:
        guarded.loader.return_value = None

    response = _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256()}"})

    _assert_401_sem_dados(response, method)
    guarded.loader.assert_called_once_with(AUTH_SUB)
    guarded.db.assert_not_called()
    guarded.redis.assert_not_called()
    assert any(e["event_type"] == "AUTH_FAILED" for e in guarded.events)


@pytest.mark.parametrize("rule,method", PROTECTED, ids=_ids(PROTECTED))
def test_falhas_com_token_presente_sao_auditadas(guarded, rule, method):
    _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256(aud='anon')}"})
    failed = [e for e in guarded.events if e["event_type"] == "AUTH_FAILED"]
    assert failed and failed[0]["details"]["reason"].startswith("invalid_token")


@pytest.mark.parametrize("rule,method", PROTECTED, ids=_ids(PROTECTED))
def test_respostas_401_sao_identicas_entre_cenarios(guarded, rule, method):
    """Sem oráculo: ausência de token, assinatura inválida e usuário inexistente
    produzem o MESMO status e corpo (não revelam qual verificação falhou)."""
    if method == "HEAD":
        pytest.skip("HEAD não tem corpo")
    bodies = []
    for scenario in ("sem_credencial", "assinatura_outro_segredo", "expirado", "role_anon"):
        bodies.append(_open(guarded.client, rule, method, **SCENARIOS[scenario]()).get_json())
    guarded.loader.return_value = None
    bodies.append(
        _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256()}"}).get_json()
    )
    assert all(b == bodies[0] for b in bodies)


@pytest.mark.parametrize("rule", sorted({r for r, _ in PROTECTED}))
@pytest.mark.parametrize("origin", ["http://localhost:3000", "https://atacante.example"])
def test_preflight_options_nao_executa_view_nem_toca_banco(guarded, rule, origin):
    response = guarded.client.open(
        _build_url(rule),
        method="OPTIONS",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 200
    assert response.get_data() == b""
    guarded.db.assert_not_called()
    guarded.loader.assert_not_called()
    if origin.startswith("https://atacante"):
        assert "Access-Control-Allow-Origin" not in response.headers


def test_controle_positivo_token_valido_passa_pela_autenticacao(guarded):
    """Garante que os 401 acima vêm das falhas injetadas, não de configuração."""
    user = SimpleNamespace(
        id=uuid.uuid4(), active=True, auth_user_id=AUTH_SUB, name="Sintético", email="s@exemplo.invalid"
    )
    guarded.loader.return_value = (user, {"USER"}, set())
    response = guarded.client.get("/api/v1/me", headers={"Authorization": f"Bearer {_hs256()}"})
    assert response.status_code == 200
    assert response.get_json()["current_aal"] == "aal2"


def test_rotas_publicas_nao_retornam_dados(guarded):
    @contextmanager
    def _fake_session():
        yield MagicMock()

    with patch("app.api.v1.health.get_db_session", _fake_session):
        for path in ("/api/health", "/api/v1/health"):
            response = guarded.client.get(path)
            assert response.status_code == 200
            assert response.get_json() == {"status": "ok"}
    response = guarded.client.get("/static/../../app/config/settings.py")
    assert response.status_code == 404
    response = guarded.client.get("/static/x")
    assert response.status_code == 404


def test_api_nao_registra_rota_static():
    """PREDEPLOY-07/B-4 corrigido: `Flask(__name__, static_folder=None)`."""
    app = create_app()
    assert not any(rule.rule.startswith("/static") for rule in app.url_map.iter_rules())


# ---------------------------------------------------------------------------
# 3) Logado não basta: perfil, AAL2 e permissão em cada rota (deny by default)
# ---------------------------------------------------------------------------

ADMIN_ROUTES = [pair for pair in PROTECTED if EXPECTED_POLICY.get(pair, (None, None))[0] == ADMIN]
AAL2_ROUTES = [pair for pair in PROTECTED if EXPECTED_POLICY.get(pair, (None, None))[0] in {ADMIN, AAL2}]


def _as(guarded, roles: set[str], perms: set[str]) -> None:
    user = SimpleNamespace(
        id=uuid.uuid4(), active=True, auth_user_id=AUTH_SUB, name="Sintético", email="s@exemplo.invalid"
    )
    guarded.loader.return_value = (user, set(roles), set(perms))


def _denied(response, method: str, code: str) -> None:
    assert response.status_code == 403, response.get_data(as_text=True)[:300]
    if method != "HEAD":
        assert response.get_json()["error"]["code"] == code


@pytest.mark.parametrize("role", ["USER", "RH"])
@pytest.mark.parametrize("rule,method", ADMIN_ROUTES, ids=_ids(ADMIN_ROUTES))
def test_user_rh_com_todas_permissoes_e_aal2_negados_em_rota_admin(guarded, rule, method, role):
    _as(guarded, {role}, ALL_PERMISSIONS)
    response = _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256()}"})
    _denied(response, method, "forbidden")
    guarded.db.assert_not_called()
    assert any(e["event_type"] == "ACCESS_DENIED" for e in guarded.events)


@pytest.mark.parametrize("rule,method", AAL2_ROUTES, ids=_ids(AAL2_ROUTES))
def test_sessao_aal1_negada_em_rota_admin_ou_aal2(guarded, rule, method):
    _as(guarded, {"ADM"}, ALL_PERMISSIONS)
    response = _open(
        guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256(aal='aal1')}"}
    )
    _denied(response, method, "AAL2_REQUIRED")
    guarded.db.assert_not_called()
    assert any(e["event_type"] == "AAL2_REQUIRED" for e in guarded.events)


@pytest.mark.parametrize("aal_claim", [_DROP, "AAL2", "aal3", "", ["aal2"], 2])
@pytest.mark.parametrize("rule,method", AAL2_ROUTES, ids=_ids(AAL2_ROUTES))
def test_aal_ausente_ou_forjado_vale_aal1(guarded, rule, method, aal_claim):
    _as(guarded, {"ADM"}, ALL_PERMISSIONS)
    token = _hs256(aal=aal_claim)
    response = _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {token}"})
    _denied(response, method, "AAL2_REQUIRED")


@pytest.mark.parametrize("rule,method", ADMIN_ROUTES, ids=_ids(ADMIN_ROUTES))
def test_adm_aal2_sem_a_permissao_da_rota_negado(guarded, rule, method):
    _, permission = EXPECTED_POLICY[(rule, method)]
    _as(guarded, {"ADM"}, ALL_PERMISSIONS - {permission})
    response = _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256()}"})
    _denied(response, method, "forbidden")
    guarded.db.assert_not_called()


@pytest.mark.parametrize("rule,method", ADMIN_ROUTES, ids=_ids(ADMIN_ROUTES))
def test_usuario_sem_papel_revogado_ou_recem_convidado_negado(guarded, rule, method):
    _as(guarded, set(), set())
    response = _open(guarded.client, rule, method, headers={"Authorization": f"Bearer {_hs256()}"})
    _denied(response, method, "forbidden")
    guarded.db.assert_not_called()


@pytest.mark.parametrize("rule,method", ADMIN_ROUTES, ids=_ids(ADMIN_ROUTES))
def test_papel_e_permissoes_no_jwt_sao_ignorados(guarded, rule, method):
    """Perfil vem do banco, nunca do cliente (claims forjados não ajudam)."""
    _as(guarded, {"USER"}, set())
    token = _hs256(
        app_metadata={"role": "ADM", "roles": ["ADM"]},
        user_metadata={"role": "ADM"},
        roles=["ADM"],
        permissions=sorted(ALL_PERMISSIONS),
        is_admin=True,
    )
    response = _open(
        guarded.client,
        rule,
        method,
        headers={"Authorization": f"Bearer {token}", "X-Role": "ADM", "X-User-Role": "ADM"},
        query_string={"role": "ADM", "as": "ADM"},
    )
    _denied(response, method, "forbidden")
