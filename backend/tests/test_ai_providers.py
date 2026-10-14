"""Provedores de IA e cliente HTTP: cada falha vira AIResult neutro, sem exceção.

Sem rede: `requests.Session` substituída por `FakeSession`.
"""
from __future__ import annotations

import logging

import pytest

from app.services.ai.anthropic_provider import AnthropicProvider
from app.services.ai.base import (
    ERROR_AUTH,
    ERROR_BAD_REQUEST,
    ERROR_BAD_RESPONSE,
    ERROR_CONNECTION,
    ERROR_INVALID_MODEL,
    ERROR_NOT_CONFIGURED,
    ERROR_RATE_LIMITED,
    ERROR_REDIRECT,
    ERROR_TIMEOUT,
    ERROR_UPSTREAM,
    AIRequest,
    AIResult,
)
from app.services.ai.deepseek_provider import DeepSeekProvider
from app.services.ai.http import AIHttpClient
from app.services.ai.models import ALLOWED_MODELS, is_allowed_model
from app.services.ai.null_provider import NullProvider
from app.services.ai.openai_provider import OpenAIProvider
from test_ai_support import (
    ALL_FAKE_KEYS,
    CONN_ERROR,
    FAKE_ANTHROPIC_KEY,
    FAKE_DEEPSEEK_KEY,
    FAKE_OPENAI_KEY,
    TIMEOUT,
    FakeResponse,
    FakeSession,
    anthropic_ok,
    openai_ok,
)

OPENAI_MODEL = ALLOWED_MODELS["openai"][0]
ANTHROPIC_MODEL = ALLOWED_MODELS["anthropic"][0]
DEEPSEEK_MODEL = ALLOWED_MODELS["deepseek"][0]


def _request(model: str) -> AIRequest:
    return AIRequest(model=model, system="sys", user="usr", max_tokens=50, feature="assistant")


def _no_sleep(_: float) -> None:
    return None


def _openai(session: FakeSession, key: str | None = FAKE_OPENAI_KEY) -> OpenAIProvider:
    http = AIHttpClient("openai", OpenAIProvider.path, timeout=5, session=session, sleep=_no_sleep)
    return OpenAIProvider(key, timeout=5, http_client=http)


def _anthropic(session: FakeSession, key: str | None = FAKE_ANTHROPIC_KEY) -> AnthropicProvider:
    http = AIHttpClient("anthropic", AnthropicProvider.path, timeout=5, session=session, sleep=_no_sleep)
    return AnthropicProvider(key, timeout=5, http_client=http)


def _deepseek(session: FakeSession, key: str | None = FAKE_DEEPSEEK_KEY) -> DeepSeekProvider:
    http = AIHttpClient("deepseek", DeepSeekProvider.path, timeout=5, session=session, sleep=_no_sleep)
    return DeepSeekProvider(key, timeout=5, http_client=http)


PROVIDER_CASES = [
    pytest.param(_openai, OPENAI_MODEL, openai_ok, id="openai"),
    pytest.param(_anthropic, ANTHROPIC_MODEL, anthropic_ok, id="anthropic"),
    pytest.param(_deepseek, DEEPSEEK_MODEL, openai_ok, id="deepseek"),
]


# ---------------------------------------------------------------------------
# Sucesso e formato da requisição
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("factory,model,ok_response", PROVIDER_CASES)
def test_ai_provider_success_parses_text_and_tokens(factory, model, ok_response) -> None:
    session = FakeSession(ok_response("Olá", 12, 7))
    result = factory(session).complete(_request(model))
    assert result.ok and result.text == "Olá"
    assert (result.tokens_in, result.tokens_out) == (12, 7)
    call = session.calls[0]
    assert call["url"].startswith("https://")
    assert call["allow_redirects"] is False
    assert call["timeout"] == 5


def test_ai_provider_hosts_are_fixed() -> None:
    urls = []
    for factory, model, ok in [(_openai, OPENAI_MODEL, openai_ok), (_anthropic, ANTHROPIC_MODEL, anthropic_ok),
                               (_deepseek, DEEPSEEK_MODEL, openai_ok)]:
        session = FakeSession(ok())
        factory(session).complete(_request(model))
        urls.append(session.calls[0]["url"])
    assert urls == [
        "https://api.openai.com/v1/chat/completions",
        "https://api.anthropic.com/v1/messages",
        "https://api.deepseek.com/chat/completions",
    ]


def test_ai_openai_body_uses_store_false_and_bearer() -> None:
    session = FakeSession(openai_ok())
    _openai(session).complete(_request(OPENAI_MODEL))
    call = session.calls[0]
    assert call["json"]["store"] is False
    assert call["json"]["max_completion_tokens"] == 50
    assert call["headers"]["Authorization"] == f"Bearer {FAKE_OPENAI_KEY}"


def test_ai_anthropic_body_and_headers() -> None:
    session = FakeSession(anthropic_ok())
    _anthropic(session).complete(_request(ANTHROPIC_MODEL))
    call = session.calls[0]
    assert call["headers"]["x-api-key"] == FAKE_ANTHROPIC_KEY
    assert call["headers"]["anthropic-version"] == "2023-06-01"
    assert call["json"]["system"] == "sys"
    assert call["json"]["messages"] == [{"role": "user", "content": "usr"}]


def test_ai_http_client_rejects_unknown_provider_and_bad_path() -> None:
    with pytest.raises(ValueError):
        AIHttpClient("evil", "/x", timeout=1)
    for path in ("x", "//evil.com/x", "/a@b", "/x?u=1"):
        with pytest.raises(ValueError):
            AIHttpClient("openai", path, timeout=1)


# ---------------------------------------------------------------------------
# Falhas -> AIResult neutro
# ---------------------------------------------------------------------------

FAILURES = [
    pytest.param(FakeResponse(401, {"error": "invalid key"}), ERROR_AUTH, id="401"),
    pytest.param(FakeResponse(403, {"error": "forbidden"}), ERROR_AUTH, id="403"),
    pytest.param(FakeResponse(429, {"error": "quota"}), ERROR_RATE_LIMITED, id="429"),
    pytest.param(FakeResponse(500, {"error": "x"}), ERROR_UPSTREAM, id="500"),
    pytest.param(FakeResponse(503, {"error": "x"}), ERROR_UPSTREAM, id="503"),
    pytest.param(FakeResponse(400, {"error": "x"}), ERROR_BAD_REQUEST, id="400"),
    pytest.param(FakeResponse(302, {}), ERROR_REDIRECT, id="302"),
    pytest.param(FakeResponse(307, {}), ERROR_REDIRECT, id="307"),
    pytest.param(FakeResponse(200, raw="{not json"), ERROR_BAD_RESPONSE, id="json-malformado"),
    pytest.param(FakeResponse(200, ["lista"]), ERROR_BAD_RESPONSE, id="json-nao-objeto"),
    pytest.param(FakeResponse(200, {"inesperado": True}), ERROR_BAD_RESPONSE, id="json-sem-campos"),
    pytest.param(TIMEOUT, ERROR_TIMEOUT, id="timeout"),
    pytest.param(CONN_ERROR, ERROR_CONNECTION, id="connection-error"),
]


@pytest.mark.parametrize("factory,model,_ok", PROVIDER_CASES)
@pytest.mark.parametrize("response,expected_kind", FAILURES)
def test_ai_provider_failures_are_neutral(factory, model, _ok, response, expected_kind) -> None:
    session = FakeSession(response)
    result = factory(session).complete(_request(model))
    assert isinstance(result, AIResult)
    assert result.ok is False and result.text == ""
    assert result.error_kind == expected_kind


def test_ai_retry_only_on_timeout_and_connection_max_two() -> None:
    session = FakeSession(TIMEOUT)
    _openai(session).complete(_request(OPENAI_MODEL))
    assert len(session.calls) == 2

    session = FakeSession(CONN_ERROR, openai_ok("depois"))
    result = _openai(session).complete(_request(OPENAI_MODEL))
    assert result.ok and result.text == "depois" and len(session.calls) == 2

    for status in (401, 429, 500, 302):
        session = FakeSession(FakeResponse(status, {}))
        _openai(session).complete(_request(OPENAI_MODEL))
        assert len(session.calls) == 1, status


def test_ai_unexpected_exception_from_session_is_contained() -> None:
    session = FakeSession(RuntimeError("boom"))
    result = _openai(session).complete(_request(OPENAI_MODEL))
    assert result.ok is False


@pytest.mark.parametrize("factory,model,_ok", PROVIDER_CASES)
@pytest.mark.parametrize("key", [None, "", "   "])
def test_ai_provider_without_key_never_calls_network(factory, model, _ok, key) -> None:
    session = FakeSession(openai_ok())
    result = factory(session, key=key).complete(_request(model))
    assert result.error_kind == ERROR_NOT_CONFIGURED
    assert session.calls == []


@pytest.mark.parametrize("factory,_model,_ok", PROVIDER_CASES)
def test_ai_model_outside_allowlist_is_refused(factory, _model, _ok) -> None:
    session = FakeSession(openai_ok())
    result = factory(session).complete(_request("modelo-livre-qualquer"))
    assert result.error_kind == ERROR_INVALID_MODEL
    assert session.calls == []


def test_ai_allowlist_has_two_to_four_models_per_provider() -> None:
    assert set(ALLOWED_MODELS) == {"openai", "anthropic", "deepseek"}
    for provider, models in ALLOWED_MODELS.items():
        assert 2 <= len(models) <= 4, provider
    assert set(ALLOWED_MODELS["anthropic"]) == {"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}
    assert not is_allowed_model("openai", ALLOWED_MODELS["anthropic"][0])
    assert not is_allowed_model("none", "x")
    assert not is_allowed_model("openai", None)


def test_ai_null_provider_is_neutral() -> None:
    result = NullProvider("disabled").complete(_request("x"))
    assert result == AIResult.neutral("disabled")


# ---------------------------------------------------------------------------
# Chaves nunca aparecem em repr/str/logs
# ---------------------------------------------------------------------------


def test_ai_keys_absent_from_repr_and_logs(caplog) -> None:
    caplog.set_level(logging.DEBUG)
    objects = []
    for factory, model, response in [
        (_openai, OPENAI_MODEL, FakeResponse(401, {"error": {"message": f"bad key {FAKE_OPENAI_KEY}"}})),
        (_anthropic, ANTHROPIC_MODEL, TIMEOUT),
        (_deepseek, DEEPSEEK_MODEL, FakeResponse(500, {})),
    ]:
        provider = factory(FakeSession(response))
        result = provider.complete(_request(model))
        objects += [provider, result, provider._http]
    text = caplog.text + " ".join(repr(o) + str(o) for o in objects)
    for key in ALL_FAKE_KEYS:
        assert key not in text
    assert "bad key" not in caplog.text  # corpo de erro do provedor nunca é logado
