"""Factory, status, circuit breaker e uso (cota/rate limit) — sem rede nem Redis real."""
from __future__ import annotations

from types import SimpleNamespace
from datetime import datetime, timezone

import pytest

from app.services.ai.base import (
    ERROR_CIRCUIT_OPEN,
    ERROR_DEEPSEEK_ACK_REQUIRED,
    ERROR_DISABLED,
    ERROR_INVALID_MODEL,
    ERROR_NOT_CONFIGURED,
    ERROR_QUOTA_EXCEEDED,
)
from app.services.ai.circuit_breaker import CircuitBreaker
from app.services.ai.factory import (
    AIConfig,
    compute_status,
    effective_token_cap,
    key_status,
    resolve_provider,
)
from app.services.ai.models import AI_FEATURES
from app.services.ai.null_provider import NullProvider
from app.services.ai.openai_provider import OpenAIProvider
from app.services.ai.anthropic_provider import AnthropicProvider
from app.services.ai.deepseek_provider import DeepSeekProvider
from app.services.ai.usage import (
    add_monthly_tokens,
    check_ai_rate_limit,
    get_monthly_tokens,
    monthly_quota_exhausted,
    monthly_tokens_key,
)
from test_ai_support import ALL_FAKE_KEYS, BrokenRedis, FakeRedis, make_settings


def _config(**overrides) -> AIConfig:
    base = dict(enabled=True, provider="openai", model=None, features={f: True for f in AI_FEATURES},
                deepseek_acknowledged=False, monthly_token_cap=None)
    base.update(overrides)
    return AIConfig(**base)


def _resolve(config: AIConfig, settings=None, redis_client=None, **kw):
    return resolve_provider(
        config, settings=settings or make_settings(),
        redis_client=FakeRedis() if redis_client is None else redis_client, **kw,
    )


# ---------------------------------------------------------------------------
# resolve_provider / get_provider
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "provider,cls,ack",
    [("openai", OpenAIProvider, False), ("anthropic", AnthropicProvider, False), ("deepseek", DeepSeekProvider, True)],
)
def test_ai_factory_returns_real_provider_when_all_ok(provider, cls, ack) -> None:
    prov, reason = _resolve(_config(provider=provider, deepseek_acknowledged=ack))
    assert reason is None and isinstance(prov, cls)


def test_ai_env_disabled_wins_over_database() -> None:
    redis = BrokenRedis()  # nem é tocado quando o env está desligado
    prov, reason = _resolve(_config(), settings=make_settings(ai_enabled=False), redis_client=redis)
    assert isinstance(prov, NullProvider) and reason == ERROR_DISABLED


@pytest.mark.parametrize("config", [_config(enabled=False), _config(provider="none")])
def test_ai_database_flag_off_is_disabled(config) -> None:
    prov, reason = _resolve(config)
    assert isinstance(prov, NullProvider) and reason == ERROR_DISABLED


@pytest.mark.parametrize("key", [None, "", "  "])
def test_ai_missing_key_is_not_configured(key) -> None:
    prov, reason = _resolve(_config(), settings=make_settings(openai_api_key=key))
    assert isinstance(prov, NullProvider) and reason == ERROR_NOT_CONFIGURED


def test_ai_deepseek_without_ack_is_refused() -> None:
    prov, reason = _resolve(_config(provider="deepseek", deepseek_acknowledged=False))
    assert isinstance(prov, NullProvider) and reason == ERROR_DEEPSEEK_ACK_REQUIRED


@pytest.mark.parametrize("model", ["gpt-qualquer", "claude-opus-5-5", ""])
def test_ai_model_outside_allowlist_degrades(model) -> None:
    prov, reason = _resolve(_config(model=model or "x" * 101))
    assert isinstance(prov, NullProvider) and reason == ERROR_INVALID_MODEL


def test_ai_unknown_provider_value_degrades() -> None:
    prov, reason = _resolve(_config(provider="evilcorp"))
    assert isinstance(prov, NullProvider) and reason == ERROR_INVALID_MODEL


@pytest.mark.parametrize("redis_client", [BrokenRedis(), "none"])
def test_ai_redis_down_means_circuit_open(redis_client) -> None:
    client = None if redis_client == "none" else redis_client
    prov, reason = resolve_provider(_config(), settings=make_settings(), redis_client=client)
    assert isinstance(prov, NullProvider) and reason == ERROR_CIRCUIT_OPEN


def test_ai_open_circuit_degrades() -> None:
    redis = FakeRedis()
    settings = make_settings()
    breaker = CircuitBreaker(redis, provider="openai", failure_threshold=3, open_seconds=300)
    for _ in range(3):
        breaker.record_failure()
    prov, reason = _resolve(_config(), settings=settings, redis_client=redis)
    assert isinstance(prov, NullProvider) and reason == ERROR_CIRCUIT_OPEN
    # outro provedor não é afetado
    prov2, reason2 = _resolve(_config(provider="anthropic"), settings=settings, redis_client=redis)
    assert reason2 is None
    # teste de conexão pode ignorar o circuito
    _, reason3 = _resolve(_config(), settings=settings, redis_client=redis, ignore_circuit=True)
    assert reason3 is None


def test_ai_monthly_quota_exhausted_degrades() -> None:
    redis = FakeRedis()
    add_monthly_tokens(redis, 1000)
    prov, reason = _resolve(_config(monthly_token_cap=1000), redis_client=redis)
    assert isinstance(prov, NullProvider) and reason == ERROR_QUOTA_EXCEEDED
    # o teto do env também limita (o menor vale)
    _, reason_env = _resolve(_config(), settings=make_settings(ai_monthly_token_cap=500), redis_client=redis)
    assert reason_env == ERROR_QUOTA_EXCEEDED


def test_ai_zero_cap_means_exhausted() -> None:
    _, reason = _resolve(_config(monthly_token_cap=0))
    assert reason == ERROR_QUOTA_EXCEEDED


def test_ai_factory_never_raises(monkeypatch) -> None:
    import app.services.ai.factory as factory

    def boom(*a, **k):
        raise RuntimeError("x")

    monkeypatch.setattr(factory, "_degradation_reason", boom)
    prov, reason = _resolve(_config())
    assert isinstance(prov, NullProvider) and reason == "internal_error"
    monkeypatch.setattr(factory, "_degradation_reason", boom)
    assert compute_status(_config(), settings=make_settings(), redis_client=FakeRedis()) == "unavailable"


# ---------------------------------------------------------------------------
# compute_status / key_status / AIConfig
# ---------------------------------------------------------------------------


def test_ai_compute_status_values() -> None:
    s = make_settings()
    assert compute_status(_config(), settings=s, redis_client=FakeRedis()) == "active"
    assert compute_status(_config(), settings=make_settings(ai_enabled=False), redis_client=None) == "disabled"
    assert compute_status(_config(enabled=False), settings=s, redis_client=FakeRedis()) == "disabled"
    assert compute_status(_config(provider="none"), settings=s, redis_client=FakeRedis()) == "disabled"
    assert compute_status(_config(), settings=make_settings(openai_api_key=None), redis_client=FakeRedis()) == "unavailable"
    assert compute_status(_config(), settings=s, redis_client=BrokenRedis()) == "unavailable"
    assert compute_status(_config(provider="deepseek"), settings=s, redis_client=FakeRedis()) == "unavailable"


def test_ai_key_status_never_exposes_keys() -> None:
    status = key_status(make_settings(anthropic_api_key=None, deepseek_api_key="  "))
    assert status == {"openai": "configured", "anthropic": "not_configured", "deepseek": "not_configured"}
    for key in ALL_FAKE_KEYS:
        assert key not in repr(status)


def test_ai_settings_repr_hides_keys() -> None:
    s = make_settings()
    text = repr(s) + str(s)
    for key in ALL_FAKE_KEYS:
        assert key not in text


def test_ai_config_from_row_filters_features() -> None:
    row = SimpleNamespace(
        enabled=True, provider="openai", model=None,
        features={"assistant": True, "data_quality": "true", "inventada": True},
        deepseek_acknowledged_at=None, monthly_token_cap=10,
    )
    config = AIConfig.from_row(row)
    assert config.feature_enabled("assistant")
    assert not config.feature_enabled("data_quality")  # só o booleano True
    assert not config.feature_enabled("inventada")
    assert "inventada" not in config.features
    assert AIConfig.from_row(None).enabled is False
    assert effective_token_cap(config, make_settings()) == 10


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


def test_ai_circuit_breaker_opens_after_threshold_and_success_resets() -> None:
    redis = FakeRedis()
    breaker = CircuitBreaker(redis, provider="openai", failure_threshold=3, open_seconds=60)
    breaker.record_failure()
    breaker.record_failure()
    breaker.record_success()  # zera
    breaker.record_failure()
    breaker.record_failure()
    assert not breaker.is_open()
    breaker.record_failure()
    assert breaker.is_open()


def test_ai_circuit_breaker_fails_closed_without_redis() -> None:
    assert CircuitBreaker(None, provider="openai", failure_threshold=3, open_seconds=60).is_open()
    broken = CircuitBreaker(BrokenRedis(), provider="openai", failure_threshold=3, open_seconds=60)
    assert broken.is_open()
    broken.record_failure()  # não lança
    broken.record_success()


# ---------------------------------------------------------------------------
# Uso: cota mensal e rate limit
# ---------------------------------------------------------------------------


def test_ai_monthly_counter_is_per_utc_month() -> None:
    redis = FakeRedis()
    oct_ = datetime(2026, 10, 31, 23, 0, tzinfo=timezone.utc)
    nov = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
    add_monthly_tokens(redis, 50, now=oct_)
    assert get_monthly_tokens(redis, now=oct_) == 50
    assert get_monthly_tokens(redis, now=nov) == 0
    assert monthly_tokens_key(oct_).endswith("2026-10")


def test_ai_quota_fails_closed_when_redis_down() -> None:
    assert get_monthly_tokens(BrokenRedis()) is None
    assert monthly_quota_exhausted(BrokenRedis(), 1000)
    assert monthly_quota_exhausted(None, 1000)
    add_monthly_tokens(BrokenRedis(), 10)  # não lança


def test_ai_rate_limit_per_user_and_unit() -> None:
    redis = FakeRedis()
    for _ in range(2):
        assert check_ai_rate_limit(redis, user_id="u1", unit_id="un1", per_user=2, per_unit=10)
    assert not check_ai_rate_limit(redis, user_id="u1", unit_id="un1", per_user=2, per_unit=10)
    # outro usuário da mesma unidade ainda pode, até o limite da unidade
    redis2 = FakeRedis()
    assert check_ai_rate_limit(redis2, user_id="a", unit_id="X", per_user=5, per_unit=1)
    assert not check_ai_rate_limit(redis2, user_id="b", unit_id="X", per_user=5, per_unit=1)


def test_ai_rate_limit_denies_when_redis_down() -> None:
    assert not check_ai_rate_limit(BrokenRedis(), user_id="u", unit_id=None, per_user=5, per_unit=5)
    assert not check_ai_rate_limit(None, user_id="u", unit_id=None, per_user=5, per_unit=5)
