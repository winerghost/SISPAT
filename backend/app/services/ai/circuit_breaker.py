"""Circuit breaker por provedor, com estado em Redis.

- `failure_threshold` falhas consecutivas do provedor abrem o circuito por
  `open_seconds`; enquanto aberto, a factory devolve NullProvider.
- Sucesso zera o contador de falhas.
- FALHA FECHADA: Redis ausente/indisponível => `is_open()` devolve True
  (a IA fica indisponível, o sistema segue normal). Gravações que falham são
  ignoradas silenciosamente (só `type(exc).__name__` no log).
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_KEY_PREFIX = "sispat:ai:circuit"


class CircuitBreaker:
    def __init__(
        self,
        redis_client: Any | None,
        *,
        provider: str,
        failure_threshold: int,
        open_seconds: int,
    ) -> None:
        self._redis = redis_client
        self.provider = provider
        self._threshold = max(1, int(failure_threshold))
        self._open_seconds = max(1, int(open_seconds))
        self._failures_key = f"{_KEY_PREFIX}:{provider}:failures"
        self._open_key = f"{_KEY_PREFIX}:{provider}:open"

    def __repr__(self) -> str:
        return f"<CircuitBreaker provider={self.provider!r}>"

    def is_open(self) -> bool:
        if self._redis is None:
            return True
        try:
            return bool(self._redis.exists(self._open_key))
        except Exception as exc:  # noqa: BLE001 - Redis fora => aberto
            logger.warning("ai_circuit: Redis indisponível (%s) => circuito aberto", type(exc).__name__)
            return True

    def record_success(self) -> None:
        if self._redis is None:
            return
        try:
            self._redis.delete(self._failures_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("ai_circuit: falha ao registrar sucesso (%s)", type(exc).__name__)

    def record_failure(self) -> None:
        if self._redis is None:
            return
        try:
            failures = int(self._redis.incr(self._failures_key))
            if failures == 1:
                self._redis.expire(self._failures_key, self._open_seconds * 2)
            if failures >= self._threshold:
                self._redis.set(self._open_key, "1", ex=self._open_seconds)
                self._redis.delete(self._failures_key)
                logger.warning(
                    "ai_circuit: circuito ABERTO provider=%s por %ds", self.provider, self._open_seconds
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ai_circuit: falha ao registrar falha (%s)", type(exc).__name__)
