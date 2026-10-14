"""Factory de provedores de IA e status consolidado.

API pública (consumida pelos endpoints do agente de domínio):

    AIConfig.from_row(row: AISettings | None) -> AIConfig
        Snapshot imutável de `ai_settings` (None => tudo desligado).

    key_status(settings: Settings | None = None) -> dict[str, str]
        {"openai"|"anthropic"|"deepseek": "configured" | "not_configured"}.
        Nunca devolve a chave nem parte dela.

    effective_token_cap(config: AIConfig, settings: Settings | None = None) -> int
        min(AI_MONTHLY_TOKEN_CAP do env, ai_settings.monthly_token_cap).

    resolve_provider(config, *, settings=None, redis_client=<auto>, session=None,
                     ignore_circuit=False) -> tuple[AIProvider, str | None]
        (provedor real, None) ou (NullProvider(motivo), motivo). Ordem:
        AI_ENABLED=false -> banco desligado/provider none -> DeepSeek sem aceite
        -> modelo fora da allowlist -> chave ausente -> Redis fora/circuito
        aberto -> cota mensal esgotada. Nunca lança.

    get_provider(config, **kwargs) -> AIProvider
        Atalho: só o provedor de `resolve_provider`.

    compute_status(config, *, settings=None, redis_client=<auto>)
        -> Literal["active", "disabled", "unavailable"]
        "disabled": AI_ENABLED=false, banco desligado ou provider "none";
        "unavailable": ligado mas sem chave, sem aceite, modelo inválido,
        circuito aberto/Redis fora ou cota esgotada; "active": caso contrário.
        Não faz chamada de rede ao provedor.

    status_for_reason(reason: str | None) -> Literal["active","disabled","unavailable"]

`redis_client` omitido => cliente criado a partir de REDIS_URL; falha ao
criar => None (tratado como circuito aberto: falha fechada).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Literal, Mapping

import redis
import requests

from app.config.settings import Settings, get_settings
from app.services.ai.anthropic_provider import AnthropicProvider
from app.services.ai.base import (
    DISABLED_KINDS,
    ERROR_CIRCUIT_OPEN,
    ERROR_DEEPSEEK_ACK_REQUIRED,
    ERROR_DISABLED,
    ERROR_INTERNAL,
    ERROR_INVALID_MODEL,
    ERROR_NOT_CONFIGURED,
    ERROR_QUOTA_EXCEEDED,
    AIProvider,
)
from app.services.ai.circuit_breaker import CircuitBreaker
from app.services.ai.deepseek_provider import DeepSeekProvider
from app.services.ai.models import (
    AI_FEATURES,
    AI_PROVIDERS,
    PROVIDER_ANTHROPIC,
    PROVIDER_DEEPSEEK,
    PROVIDER_NONE,
    PROVIDER_OPENAI,
    default_model,
    is_allowed_model,
)
from app.services.ai.null_provider import NullProvider
from app.services.ai.openai_provider import OpenAIProvider
from app.services.ai.usage import monthly_quota_exhausted

logger = logging.getLogger(__name__)

Status = Literal["active", "disabled", "unavailable"]

_AUTO: Any = object()  # sentinela: "construa o cliente Redis a partir do settings"

_PROVIDER_CLASSES = {
    PROVIDER_OPENAI: OpenAIProvider,
    PROVIDER_ANTHROPIC: AnthropicProvider,
    PROVIDER_DEEPSEEK: DeepSeekProvider,
}


@dataclass(frozen=True)
class AIConfig:
    """Snapshot imutável de `ai_settings` (sem chaves)."""

    enabled: bool = False
    provider: str = PROVIDER_NONE
    model: str | None = None
    features: Mapping[str, bool] = field(default_factory=lambda: MappingProxyType({}))
    deepseek_acknowledged: bool = False
    monthly_token_cap: int | None = None

    @classmethod
    def from_row(cls, row: Any | None) -> "AIConfig":
        if row is None:
            return cls()
        raw_features = getattr(row, "features", None)
        # Só chaves da allowlist e só o booleano True liga a funcionalidade.
        features = (
            {name: raw_features.get(name) is True for name in AI_FEATURES}
            if isinstance(raw_features, dict)
            else {}
        )
        return cls(
            enabled=getattr(row, "enabled", False) is True,
            provider=str(getattr(row, "provider", PROVIDER_NONE) or PROVIDER_NONE),
            model=getattr(row, "model", None),
            features=MappingProxyType(features),
            deepseek_acknowledged=getattr(row, "deepseek_acknowledged_at", None) is not None,
            monthly_token_cap=getattr(row, "monthly_token_cap", None),
        )

    def feature_enabled(self, feature: str) -> bool:
        return feature in AI_FEATURES and self.features.get(feature) is True

    @property
    def effective_model(self) -> str | None:
        return self.model or default_model(self.provider)


def _api_key(settings: Settings, provider: str) -> str | None:
    value = getattr(settings, f"{provider}_api_key", None)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def key_status(settings: Settings | None = None) -> dict[str, str]:
    s = settings or get_settings()
    return {
        provider: "configured" if _api_key(s, provider) else "not_configured"
        for provider in AI_PROVIDERS
    }


def effective_token_cap(config: AIConfig, settings: Settings | None = None) -> int:
    s = settings or get_settings()
    caps = [int(s.ai_monthly_token_cap)]
    if isinstance(config.monthly_token_cap, int) and not isinstance(config.monthly_token_cap, bool):
        caps.append(config.monthly_token_cap)
    return max(0, min(caps))


def build_redis_client(settings: Settings | None = None) -> Any | None:
    try:
        s = settings or get_settings()
        return redis.Redis.from_url(s.redis_url, socket_timeout=2, socket_connect_timeout=2)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_factory: Redis indisponível (%s)", type(exc).__name__)
        return None


def build_circuit_breaker(provider: str, settings: Settings, redis_client: Any | None) -> CircuitBreaker:
    return CircuitBreaker(
        redis_client,
        provider=provider,
        failure_threshold=settings.ai_circuit_failure_threshold,
        open_seconds=settings.ai_circuit_open_seconds,
    )


def _degradation_reason(
    config: AIConfig,
    settings: Settings,
    redis_client: Any | None,
    *,
    ignore_circuit: bool,
) -> str | None:
    if not settings.ai_enabled:
        return ERROR_DISABLED
    if not config.enabled or config.provider == PROVIDER_NONE:
        return ERROR_DISABLED
    if config.provider not in AI_PROVIDERS:
        return ERROR_INVALID_MODEL
    if config.provider == PROVIDER_DEEPSEEK and not config.deepseek_acknowledged:
        return ERROR_DEEPSEEK_ACK_REQUIRED
    if not is_allowed_model(config.provider, config.effective_model):
        return ERROR_INVALID_MODEL
    if _api_key(settings, config.provider) is None:
        return ERROR_NOT_CONFIGURED
    if redis_client is None:
        return ERROR_CIRCUIT_OPEN
    if not ignore_circuit and build_circuit_breaker(config.provider, settings, redis_client).is_open():
        return ERROR_CIRCUIT_OPEN
    if monthly_quota_exhausted(redis_client, effective_token_cap(config, settings)):
        return ERROR_QUOTA_EXCEEDED
    return None


def resolve_provider(
    config: AIConfig,
    *,
    settings: Settings | None = None,
    redis_client: Any = _AUTO,
    session: requests.Session | None = None,
    ignore_circuit: bool = False,
) -> tuple[AIProvider, str | None]:
    try:
        s = settings or get_settings()
        if not s.ai_enabled:
            # Sem tocar no Redis quando a IA está desligada no ambiente.
            return NullProvider(ERROR_DISABLED), ERROR_DISABLED
        client = build_redis_client(s) if redis_client is _AUTO else redis_client
        reason = _degradation_reason(config, s, client, ignore_circuit=ignore_circuit)
        if reason is not None:
            return NullProvider(reason), reason
        provider_cls = _PROVIDER_CLASSES[config.provider]
        provider = provider_cls(
            _api_key(s, config.provider), timeout=s.ai_timeout_seconds, session=session
        )
        return provider, None
    except Exception as exc:  # noqa: BLE001 - factory nunca lança
        logger.error("ai_factory: erro ao resolver provedor (%s)", type(exc).__name__)
        return NullProvider(ERROR_INTERNAL), ERROR_INTERNAL


def get_provider(config: AIConfig, **kwargs: Any) -> AIProvider:
    provider, _ = resolve_provider(config, **kwargs)
    return provider


def status_for_reason(reason: str | None) -> Status:
    if reason is None:
        return "active"
    if reason in DISABLED_KINDS:
        return "disabled"
    return "unavailable"


def compute_status(
    config: AIConfig,
    *,
    settings: Settings | None = None,
    redis_client: Any = _AUTO,
) -> Status:
    try:
        s = settings or get_settings()
        if not s.ai_enabled or not config.enabled or config.provider == PROVIDER_NONE:
            return "disabled"
        client = build_redis_client(s) if redis_client is _AUTO else redis_client
        return status_for_reason(_degradation_reason(config, s, client, ignore_circuit=False))
    except Exception as exc:  # noqa: BLE001
        logger.error("ai_factory: erro ao calcular status (%s)", type(exc).__name__)
        return "unavailable"
