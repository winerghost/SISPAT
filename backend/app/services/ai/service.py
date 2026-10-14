"""`AIService`: fachada fina que encadeia toda a camada de IA.

    run_feature(feature, payload_dto, actor) -> AIResult
        flag da funcionalidade -> redação LGPD -> prompt -> provedor (factory:
        env, banco, aceite DeepSeek, modelo, chave, circuito, cota) -> rate
        limit por usuário/unidade -> reserva atômica de tokens -> chamada ->
        circuito/ajuste da reserva ao consumo real -> truncagem
        -> auditoria AI_USAGE (sem conteúdo). SEMPRE devolve `AIResult`;
        nunca lança.

    test_connection(actor) -> ConnectionTestResult
        Prompt fixo SEM dados do sistema; ignora o circuito aberto (permite
        ao ADM verificar uma chave corrigida) mas respeita env/banco/chave/
        cota. `result`: "ok" | "disabled" | "not_configured" | "unavailable".

Uso típico (endpoint):
    config = AIConfig.from_row(db.get(AISettings, 1))
    result = AIService(config).run_feature("alerts_explain", dto, AIActor(user.id, unit_id))
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Literal, Mapping

import requests

from app.config.settings import Settings, get_settings
from app.services.ai.base import (
    ERROR_BLOCKED_SENSITIVE,
    ERROR_FEATURE_DISABLED,
    ERROR_INTERNAL,
    ERROR_INVALID_FEATURE,
    ERROR_LOCAL_RATE_LIMITED,
    ERROR_NOT_CONFIGURED,
    ERROR_QUOTA_EXCEEDED,
    PROVIDER_FAILURE_KINDS,
    AIRequest,
    AIResult,
)
from app.services.ai.factory import (
    _AUTO,
    AIConfig,
    build_circuit_breaker,
    build_redis_client,
    effective_token_cap,
    resolve_provider,
    status_for_reason,
)
from app.services.ai.models import AI_FEATURES
from app.services.ai.null_provider import NullProvider
from app.services.ai.prompting import (
    CONNECTION_TEST_PROMPT,
    SYSTEM_PROMPT,
    build_prompt,
    sanitize_output,
)
from app.services.ai.redaction import redact_payload
from app.services.ai.usage import (
    build_usage_values,
    check_ai_rate_limit,
    estimate_tokens,
    record_ai_usage,
    reserve_monthly_tokens,
    settle_token_reservation,
)

logger = logging.getLogger(__name__)

CONNECTION_TEST_FEATURE = "connection_test"
CONNECTION_TEST_MAX_TOKENS = 16

TestResultValue = Literal["ok", "disabled", "not_configured", "unavailable"]


@dataclass(frozen=True)
class AIActor:
    """Quem pede (id do usuário local) e a unidade de escopo (opcional)."""

    user_id: Any
    unit_id: Any | None = None


@dataclass(frozen=True)
class ConnectionTestResult:
    result: TestResultValue
    latency_ms: int | None = None


class AIService:
    def __init__(
        self,
        config: AIConfig,
        *,
        settings: Settings | None = None,
        redis_client: Any = _AUTO,
        http_session: requests.Session | None = None,
        db_session: Any | None = None,
        audit_writer: Any | None = None,
    ) -> None:
        self._config = config
        self._settings = settings
        self._redis = redis_client
        self._http_session = http_session
        self._db_session = db_session
        self._audit_writer = audit_writer

    def __repr__(self) -> str:
        return f"<AIService provider={self._config.provider!r} enabled={self._config.enabled}>"

    # ------------------------------------------------------------------
    def _get_settings(self) -> Settings:
        return self._settings or get_settings()

    def _get_redis(self, settings: Settings) -> Any | None:
        if self._redis is _AUTO:
            self._redis = build_redis_client(settings) if settings.ai_enabled else None
        return self._redis

    def _audit(self, actor: AIActor, feature: str, result: AIResult) -> None:
        values = build_usage_values(
            provider=result.provider,
            model=result.model,
            feature=feature,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            ok=result.ok,
            error_kind=result.error_kind,
            unit_id=actor.unit_id,
        )
        record_ai_usage(
            actor_user_id=actor.user_id,
            values=values,
            ok=result.ok,
            db_session=self._db_session,
            writer=self._audit_writer,
        )

    # ------------------------------------------------------------------
    def run_feature(self, feature: str, payload_dto: Mapping[str, Any], actor: AIActor) -> AIResult:
        try:
            result = self._run_feature(feature, payload_dto, actor)
        except Exception as exc:  # noqa: BLE001 - nunca lança
            logger.error("ai_service: erro inesperado (%s)", type(exc).__name__)
            result = AIResult.neutral(ERROR_INTERNAL)
        try:
            self._audit(actor, feature if feature in AI_FEATURES else "invalid", result)
        except Exception:  # noqa: BLE001  # pragma: no cover - record_ai_usage já não lança
            pass
        return result

    def _run_feature(self, feature: str, payload_dto: Mapping[str, Any], actor: AIActor) -> AIResult:
        if feature not in AI_FEATURES:
            return AIResult.neutral(ERROR_INVALID_FEATURE)
        if not self._config.feature_enabled(feature):
            return AIResult.neutral(ERROR_FEATURE_DISABLED)

        redacted = redact_payload(feature, payload_dto)
        if not redacted.ok or redacted.payload is None:
            logger.warning(
                "ai_service: payload bloqueado pela redação feature=%s categorias=%s",
                feature, ",".join(redacted.blocked_categories),
            )
            return AIResult.neutral(ERROR_BLOCKED_SENSITIVE)

        system, user = build_prompt(feature, redacted.payload)

        settings = self._get_settings()
        redis_client = self._get_redis(settings)
        provider, reason = resolve_provider(
            self._config, settings=settings, redis_client=redis_client, session=self._http_session
        )
        if reason is not None or isinstance(provider, NullProvider):
            return provider.complete(AIRequest(model="", system=system, user=user, feature=feature))

        if not check_ai_rate_limit(
            redis_client,
            user_id=actor.user_id,
            unit_id=actor.unit_id,
            per_user=settings.ai_rate_limit_per_user,
            per_unit=settings.ai_rate_limit_per_unit,
        ):
            return AIResult.neutral(ERROR_LOCAL_RATE_LIMITED, provider=self._config.provider)

        model = self._config.effective_model or ""
        result = self._call(provider, AIRequest(
            model=model, system=system, user=user,
            max_tokens=settings.ai_max_tokens, feature=feature,
        ), settings, redis_client)
        return result

    def _call(self, provider: Any, request: AIRequest, settings: Settings, redis_client: Any) -> AIResult:
        # AI-QUOTA-01: reserva atômica do teto estimado ANTES da rede; sem
        # reserva (teto atingido ou Redis fora) => NullProvider, sem chamada.
        reservation = reserve_monthly_tokens(
            redis_client,
            request.max_tokens + estimate_tokens(request.system, request.user),
            effective_token_cap(self._config, settings),
        )
        if reservation is None:
            return NullProvider(ERROR_QUOTA_EXCEEDED).complete(request)
        consumed = 0
        try:
            result = provider.complete(request)
            if result.ok:
                consumed = max(0, result.tokens_in) + max(0, result.tokens_out)
        finally:
            # Ajusta a reserva ao consumo real (falha => devolve tudo).
            settle_token_reservation(redis_client, reservation, consumed)
        breaker = build_circuit_breaker(self._config.provider, settings, redis_client)
        if result.ok:
            breaker.record_success()
            text = sanitize_output(result.text)
            return AIResult(
                ok=True, text=text, tokens_in=result.tokens_in, tokens_out=result.tokens_out,
                provider=result.provider, model=result.model, latency_ms=result.latency_ms,
            )
        if result.error_kind in PROVIDER_FAILURE_KINDS:
            breaker.record_failure()
        return AIResult(
            ok=False, text="", tokens_in=0, tokens_out=0, error_kind=result.error_kind,
            provider=result.provider, model=result.model, latency_ms=result.latency_ms,
        )

    # ------------------------------------------------------------------
    def test_connection(self, actor: AIActor) -> ConnectionTestResult:
        try:
            outcome = self._test_connection()
        except Exception as exc:  # noqa: BLE001
            logger.error("ai_service: erro no teste de conexão (%s)", type(exc).__name__)
            outcome = (ConnectionTestResult("unavailable"), AIResult.neutral(ERROR_INTERNAL))
        test_result, ai_result = outcome
        try:
            values = build_usage_values(
                provider=ai_result.provider, model=ai_result.model,
                feature=CONNECTION_TEST_FEATURE, tokens_in=ai_result.tokens_in,
                tokens_out=ai_result.tokens_out, ok=ai_result.ok,
                error_kind=ai_result.error_kind, unit_id=actor.unit_id,
            )
            record_ai_usage(
                actor_user_id=actor.user_id, values=values, ok=ai_result.ok,
                db_session=self._db_session, writer=self._audit_writer,
            )
        except Exception:  # noqa: BLE001  # pragma: no cover
            pass
        return test_result

    def _test_connection(self) -> tuple[ConnectionTestResult, AIResult]:
        settings = self._get_settings()
        redis_client = self._get_redis(settings)
        provider, reason = resolve_provider(
            self._config, settings=settings, redis_client=redis_client,
            session=self._http_session, ignore_circuit=True,
        )
        if reason is not None:
            neutral = AIResult.neutral(reason)
            if reason == ERROR_NOT_CONFIGURED:
                return ConnectionTestResult("not_configured"), neutral
            status = status_for_reason(reason)
            return ConnectionTestResult("disabled" if status == "disabled" else "unavailable"), neutral

        started = time.monotonic()
        request = AIRequest(
            model=self._config.effective_model or "",
            system=SYSTEM_PROMPT,
            user=CONNECTION_TEST_PROMPT,
            max_tokens=CONNECTION_TEST_MAX_TOKENS,
            feature=CONNECTION_TEST_FEATURE,
        )
        result = self._call(provider, request, settings, redis_client)
        latency = int((time.monotonic() - started) * 1000)
        return ConnectionTestResult("ok" if result.ok else "unavailable", latency), result
