"""API de configuração da IA (`/api/v1/settings/ai`) — contrato da Etapa 1.

Contrato: `docs/architecture/modulo-configuracoes.md`. Banco, Redis e
provedores são sempre mockados (sem rede, sem chamada real de IA). Chaves
FICTÍCIAS montadas em tempo de execução.
"""
from __future__ import annotations

import logging
import uuid
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.exc import IntegrityError

from app import create_app
from app.models.audit import AuditLog
from app.models.settings import AISettings
from app.services.ai.models import AI_FEATURES, ALLOWED_MODELS, default_model
from test_ai_support import FakeRedis, FakeResponse, FakeSession, make_settings
from test_sec_authz import as_user, call, make_token

SECRET_MARK = "SEGREDO"
FAKE_KEYS = {
    "openai_api_key": "sk-test-" + SECRET_MARK + "-openai",
    "anthropic_api_key": "sk-ant-test-" + SECRET_MARK + "-anthropic",
    "deepseek_api_key": "sk-test-" + SECRET_MARK + "-deepseek",
}
PERM = "settings.ai.manage"
URL = "/api/v1/settings/ai"
TEST_URL = "/api/v1/settings/ai/test"
ENDPOINTS = [("GET", URL, None), ("PATCH", URL, {"version": 1}), ("POST", TEST_URL, None)]
UPDATED_AT = datetime(2026, 10, 14, 15, 0, 0, tzinfo=timezone.utc)


def _row(**overrides) -> AISettings:
    values = dict(
        id=1,
        enabled=True,
        provider="openai",
        model=default_model("openai"),
        features={name: False for name in AI_FEATURES},
        deepseek_acknowledged_at=None,
        deepseek_acknowledged_by=None,
        monthly_token_cap=200_000,
        version=3,
        updated_by=None,
        created_at=UPDATED_AT,
        updated_at=UPDATED_AT,
    )
    values.update(overrides)
    return AISettings(**values)


@contextmanager
def _session_cm(session):
    yield session


@pytest.fixture()
def client():
    return create_app().test_client()


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


@pytest.fixture()
def env():
    """Banco (sessão MagicMock), Redis em memória e Settings com chaves falsas."""
    state = SimpleNamespace(
        session=MagicMock(),
        redis=FakeRedis(),
        settings=make_settings(**FAKE_KEYS),
        usage_rows=[],
    )

    def set_row(row):
        state.session.execute.return_value.scalars.return_value.first.return_value = row

    state.set_row = set_row
    set_row(_row())
    with ExitStack() as stack:
        stack.enter_context(patch("redis.Redis.from_url", return_value=state.redis))
        stack.enter_context(
            patch("app.api.v1.ai_settings.get_db_session", lambda: _session_cm(state.session))
        )
        stack.enter_context(
            patch("app.services.ai_settings_service.get_settings", lambda: state.settings)
        )
        stack.enter_context(
            patch("app.services.ai.usage._default_writer", side_effect=state.usage_rows.append)
        )
        yield state


def _audit_rows(session) -> list[AuditLog]:
    return [c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], AuditLog)]


def _adm(**kwargs):
    return as_user({"ADM"}, {PERM}, **kwargs)


# ---------------------------------------------------------------------------
# Autorização
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["USER", "RH"])
@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_user_e_rh_negados_e_auditados(client, env, events, role, method, url, body):
    with as_user({role}, {PERM}):
        response = call(client, method, url, body, token=make_token(aal="aal2"))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert any(e["event_type"] == "ACCESS_DENIED" for e in events)
    env.session.execute.assert_not_called()


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_adm_sem_aal2_negado_e_auditado(client, env, events, method, url, body):
    with _adm():
        response = call(client, method, url, body, token=make_token(aal="aal1"))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert any(e["event_type"] == "AAL2_REQUIRED" for e in events)
    env.session.execute.assert_not_called()


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_adm_sem_permissao_negado(client, env, events, method, url, body):
    with as_user({"ADM"}, {"users.manage"}):
        response = call(client, method, url, body, token=make_token())
    assert response.status_code == 403
    assert any(e["event_type"] == "ACCESS_DENIED" for e in events)
    env.session.execute.assert_not_called()


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_sem_token_401(client, env, method, url, body):
    response = call(client, method, url, body, token=None)
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


def test_get_formato_do_contrato_sem_chaves(client, env, caplog):
    caplog.set_level(logging.DEBUG)
    with _adm():
        response = call(client, "GET", URL, token=make_token())
    assert response.status_code == 200
    body = response.get_json()
    assert set(body) == {
        "status", "env_enabled", "enabled", "provider", "model", "features",
        "monthly_token_cap", "deepseek_acknowledged", "keys", "models", "version", "updated_at",
    }
    assert body["status"] == "active"
    assert body["env_enabled"] is True
    assert body["provider"] == "openai"
    assert body["features"] == {name: False for name in AI_FEATURES}
    assert body["keys"] == {
        "openai": "configured", "anthropic": "configured", "deepseek": "configured"
    }
    assert body["models"] == {p: list(m) for p, m in ALLOWED_MODELS.items()}
    assert body["version"] == 3
    assert body["updated_at"] == "2026-10-14T15:00:00Z"
    text = response.get_data(as_text=True)
    assert SECRET_MARK not in text and "sk-" not in text
    assert SECRET_MARK not in caplog.text


def test_get_chaves_ausentes_not_configured_e_unavailable(client, env):
    env.settings = make_settings(openai_api_key=None, anthropic_api_key=None, deepseek_api_key=None)
    with _adm():
        body = call(client, "GET", URL, token=make_token()).get_json()
    assert body["keys"] == {
        "openai": "not_configured", "anthropic": "not_configured", "deepseek": "not_configured"
    }
    assert body["status"] == "unavailable"


def test_get_env_desligado_vence_banco(client, env):
    env.settings = make_settings(ai_enabled=False, **FAKE_KEYS)
    with _adm():
        body = call(client, "GET", URL, token=make_token()).get_json()
    assert body["status"] == "disabled"
    assert body["env_enabled"] is False
    assert body["enabled"] is True  # o valor do banco segue visível


def test_get_linha_ausente_responde_padrao_desligado(client, env):
    env.set_row(None)
    with _adm():
        response = call(client, "GET", URL, token=make_token())
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "disabled"
    assert body["enabled"] is False
    assert body["provider"] == "none"
    assert body["model"] is None
    assert body["features"] == {name: False for name in AI_FEATURES}
    assert body["monthly_token_cap"] == 200_000
    assert body["deepseek_acknowledged"] is False
    assert body["version"] == 1
    assert body["updated_at"] is None


# ---------------------------------------------------------------------------
# PATCH
# ---------------------------------------------------------------------------


def test_patch_feliz_incrementa_version_e_audita(client, env, events, caplog):
    caplog.set_level(logging.DEBUG)
    row = _row(enabled=False)
    env.set_row(row)
    with _adm() as actor:
        response = call(
            client, "PATCH", URL,
            {
                "version": 3, "enabled": True, "provider": "anthropic",
                "model": "claude-haiku-5-5", "features": {"assistant": True},
                "monthly_token_cap": 1000,
            },
            token=make_token(),
        )
    assert response.status_code == 200, response.get_json()
    body = response.get_json()
    assert body["version"] == 4
    assert body["provider"] == "anthropic" and body["model"] == "claude-haiku-5-5"
    assert body["features"]["assistant"] is True and body["features"]["data_quality"] is False
    assert body["monthly_token_cap"] == 1000
    assert body["enabled"] is True
    assert row.updated_by == actor.id
    audits = _audit_rows(env.session)
    assert [a.operation for a in audits] == ["AI_SETTINGS_UPDATED"]
    audit = audits[0]
    assert audit.actor_user_id == actor.id and audit.result == "SUCESSO"
    assert audit.previous_values["provider"] == "openai" and audit.previous_values["version"] == 3
    assert audit.new_values["provider"] == "anthropic" and audit.new_values["version"] == 4
    assert SECRET_MARK not in repr(audit.previous_values) + repr(audit.new_values)
    assert SECRET_MARK not in response.get_data(as_text=True)
    assert SECRET_MARK not in caplog.text
    # SELECT ... FOR UPDATE (sem lost update).
    stmt = env.session.execute.call_args.args[0]
    assert stmt._for_update_arg is not None


def test_patch_version_desatualizada_409(client, env):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 2, "enabled": False}, token=make_token())
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "version_conflict"
    assert _audit_rows(env.session) == []


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "openai", "model": "claude-opus-5-5"},
        {"model": "gpt-inexistente"},
        {"provider": "none", "model": "gpt-6.1-sol"},
    ],
)
def test_patch_modelo_fora_da_allowlist_400(client, env, body):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, **body}, token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_model"
    assert _audit_rows(env.session) == []


def test_patch_troca_provider_sem_model_usa_padrao(client, env):
    with _adm():
        body = call(client, "PATCH", URL, {"version": 3, "provider": "anthropic"}, token=make_token()).get_json()
    assert body["model"] == default_model("anthropic")


def test_patch_provider_none_zera_modelo(client, env):
    with _adm():
        body = call(client, "PATCH", URL, {"version": 3, "provider": "none"}, token=make_token()).get_json()
    assert body["provider"] == "none" and body["model"] is None and body["status"] == "disabled"


def test_patch_deepseek_sem_aceite_400(client, env):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "provider": "deepseek"}, token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "deepseek_ack_required"
    assert _audit_rows(env.session) == []


def test_patch_deepseek_com_aceite_grava_data_e_adm(client, env):
    row = _row()
    env.set_row(row)
    with _adm() as actor:
        response = call(
            client, "PATCH", URL,
            {"version": 3, "provider": "deepseek", "acknowledge_international_transfer": True},
            token=make_token(),
        )
    assert response.status_code == 200
    body = response.get_json()
    assert body["deepseek_acknowledged"] is True and body["model"] == default_model("deepseek")
    assert row.deepseek_acknowledged_by == actor.id
    assert row.deepseek_acknowledged_at is not None
    ops = [a.operation for a in _audit_rows(env.session)]
    assert ops == ["AI_SETTINGS_UPDATED", "AI_DEEPSEEK_ACKNOWLEDGED"]


def test_patch_deepseek_com_aceite_previo_dispensa_flag(client, env):
    previous_ack = datetime(2026, 1, 1, tzinfo=timezone.utc)
    row = _row(deepseek_acknowledged_at=previous_ack)
    env.set_row(row)
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "provider": "deepseek"}, token=make_token())
    assert response.status_code == 200
    assert row.deepseek_acknowledged_at == previous_ack


@pytest.mark.parametrize(
    "field,value,event",
    [
        ("api_key", "sk-x", "PRIVILEGE_ESCALATION_ATTEMPT"),
        ("openai_api_key", "sk-x", "PRIVILEGE_ESCALATION_ATTEMPT"),
        ("updated_by", str(uuid.uuid4()), "PRIVILEGE_ESCALATION_ATTEMPT"),
        ("deepseek_acknowledged_by", str(uuid.uuid4()), "PRIVILEGE_ESCALATION_ATTEMPT"),
        ("id", 2, "MASS_ASSIGNMENT_REJECTED"),
    ],
)
def test_patch_mass_assignment_400_e_evento(client, env, events, field, value, event):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, field: value}, token=make_token())
    assert response.status_code == 400
    error = response.get_json()["error"]
    assert error["code"] == "validation_error"
    assert field in error["message"] and "sk-x" not in error["message"]
    found = [e for e in events if e["event_type"] == event]
    assert found and field in found[0]["details"]["fields"]
    env.session.execute.assert_not_called()


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"enabled": True},
        {"version": 0},
        {"version": "3"},
        {"version": 3, "enabled": "true"},
        {"version": 3, "enabled": None},
        {"version": 3, "provider": "gemini"},
        {"version": 3, "model": "m" * 101},
        {"version": 3, "features": {"assistant": True, "outra": True}},
        {"version": 3, "features": {"assistant": 1}},
        {"version": 3, "monthly_token_cap": -1},
        {"version": 3, "monthly_token_cap": 50_000_001},
    ],
)
def test_patch_validacao_400(client, env, body):
    with _adm():
        response = call(client, "PATCH", URL, body, token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    env.session.execute.assert_not_called()


def test_patch_corpo_nao_objeto_400(client, env):
    with _adm():
        response = call(client, "PATCH", URL, [1, 2], token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"


def test_patch_linha_ausente_cria_com_version_2(client, env):
    env.set_row(None)
    with _adm():
        response = call(client, "PATCH", URL, {"version": 1, "enabled": True}, token=make_token())
    assert response.status_code == 200
    body = response.get_json()
    assert body["version"] == 2 and body["enabled"] is True and body["provider"] == "none"
    created = [c.args[0] for c in env.session.add.call_args_list if isinstance(c.args[0], AISettings)]
    assert len(created) == 1 and created[0].id == 1


def test_patch_insercao_concorrente_vira_409(client, env):
    env.set_row(None)
    env.session.flush.side_effect = IntegrityError("insert", {}, Exception("dup"))
    with _adm():
        response = call(client, "PATCH", URL, {"version": 1}, token=make_token())
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "version_conflict"


def test_patch_env_desligado_responde_disabled(client, env):
    env.settings = make_settings(ai_enabled=False, **FAKE_KEYS)
    with _adm():
        body = call(client, "PATCH", URL, {"version": 3, "enabled": True}, token=make_token()).get_json()
    assert body["status"] == "disabled" and body["env_enabled"] is False


def test_patch_rate_limit_429(client, env):
    env.redis.incrby = lambda key, amount: 31  # type: ignore[method-assign]
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3}, token=make_token())
    assert response.status_code == 429


# ---------------------------------------------------------------------------
# POST /test
# ---------------------------------------------------------------------------


def test_test_provedor_falhando_responde_200_neutro(client, env, caplog):
    caplog.set_level(logging.DEBUG)
    leak = f"invalid api key sk-test-{SECRET_MARK} detalhe interno"
    fake_http = FakeSession(FakeResponse(500, {"error": {"message": leak}}))
    with patch("app.services.ai.http.requests.Session", return_value=fake_http):
        with _adm():
            response = call(client, "POST", TEST_URL, token=make_token())
    assert response.status_code == 200
    body = response.get_json()
    assert body["result"] == "unavailable"
    assert set(body) == {"result", "latency_ms"}
    text = response.get_data(as_text=True)
    assert SECRET_MARK not in text and "detalhe interno" not in text
    assert SECRET_MARK not in caplog.text
    assert len(fake_http.calls) == 1
    # Auditoria AI_USAGE sem conteúdo.
    assert env.usage_rows and env.usage_rows[0].operation == "AI_USAGE"


def test_test_sucesso_ok_com_latencia(client, env):
    fake_http = FakeSession(
        FakeResponse(200, {
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1},
        })
    )
    with patch("app.services.ai.http.requests.Session", return_value=fake_http):
        with _adm():
            body = call(client, "POST", TEST_URL, token=make_token()).get_json()
    assert body["result"] == "ok" and isinstance(body["latency_ms"], int)


def test_test_env_desligado_disabled_sem_rede(client, env):
    env.settings = make_settings(ai_enabled=False, **FAKE_KEYS)
    with patch("app.services.ai.http.requests.Session") as session_cls:
        with _adm():
            response = call(client, "POST", TEST_URL, token=make_token())
    assert response.status_code == 200
    assert response.get_json()["result"] == "disabled"
    session_cls.return_value.post.assert_not_called()


def test_test_sem_chave_not_configured(client, env):
    env.settings = make_settings(openai_api_key=None)
    with _adm():
        body = call(client, "POST", TEST_URL, token=make_token()).get_json()
    assert body["result"] == "not_configured"


def test_test_linha_ausente_disabled(client, env):
    env.set_row(None)
    with _adm():
        body = call(client, "POST", TEST_URL, token=make_token()).get_json()
    assert body == {"result": "disabled", "latency_ms": None}


def test_test_excecao_inesperada_vira_unavailable(client, env):
    with patch("app.services.ai_settings_service.AIService", side_effect=RuntimeError(SECRET_MARK)):
        with _adm():
            response = call(client, "POST", TEST_URL, token=make_token())
    assert response.status_code == 200
    assert response.get_json() == {"result": "unavailable", "latency_ms": None}


def test_test_rejeita_corpo_com_evento(client, env, events):
    with _adm():
        response = call(client, "POST", TEST_URL, {"api_key": "sk-x"}, token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert any(e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT" for e in events)


def test_test_rejeita_corpo_nao_objeto(client, env):
    with _adm():
        response = call(client, "POST", TEST_URL, ["x"], token=make_token())
    assert response.status_code == 400


def test_test_rate_limit_5_por_hora(client, env):
    fake_http = FakeSession(FakeResponse(500, {}))
    with patch("app.services.ai.http.requests.Session", return_value=fake_http):
        with _adm():
            statuses = [
                call(client, "POST", TEST_URL, token=make_token()).status_code for _ in range(6)
            ]
    assert statuses == [200] * 5 + [429]


def test_cors_preflight_permite_patch(client):
    response = client.options(
        URL,
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "PATCH",
        },
    )
    methods = {m.strip() for m in response.headers.get("Access-Control-Allow-Methods", "").split(",")}
    assert {"PATCH", "PUT"} <= methods
