"""Envio "seguro" de e-mail para uso por rotas/servicos de dominio.

`send_email_safely` NUNCA levanta para o chamador: o envio de e-mail jamais
bloqueia nem derruba a operacao de negocio. Ele:
    1. devolve `disabled` (sem rede, sem evento) quando EMAIL_ENABLED=false;
    2. aplica o teto global EMAIL_MAX_PER_HOUR (contador Redis, FAIL-CLOSED:
       Redis indisponivel => nao envia), reutilizando o cliente Redis de
       `app.security.rate_limit`;
    3. executa o SMTP num executor com prazo total (timeout*3 + retry), de
       modo que a requisicao espera no maximo esse prazo. O executor e criado
       sob demanda por `_get_executor()` (patchavel; nos testes e substituido
       por um executor sincrono, evitando threads vazadas entre testes como
       em AUD-14-04). Eventos de auditoria sao gravados na thread CHAMADORA;
       a thread do executor so faz SMTP;
    4. registra EMAIL_SENT / EMAIL_FAILED via `record_security_event`, SEM
       corpo, SEM senha e com o destinatario mascarado (m***@agu.gov.br).
"""
from __future__ import annotations

import logging
from concurrent.futures import Executor, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import datetime, timezone
from threading import Lock
from typing import Any

import redis

from app.authorization.security_events import (
    EVENT_EMAIL_FAILED,
    EVENT_EMAIL_SENT,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.config.settings import Settings, get_settings
from app.security.rate_limit import _build_redis_client
from app.services.email.address import mask_address
from app.services.email.sender import (
    RETRY_DELAY_SECONDS,
    EmailMessageData,
    EmailResult,
    EmailSendError,
    NullEmailSender,
    build_email_sender,
)

logger = logging.getLogger(__name__)

_KEY_PREFIX = "sispat:email:hourly"
_executor: Executor | None = None
_executor_lock = Lock()


def _get_executor() -> Executor:
    """Executor limitado (2 threads), criado sob demanda. Patchavel em testes."""
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sispat-email")
        return _executor


def _reserve_slot(settings: Settings, redis_client: Any | None) -> None:
    """Conta 1 envio na hora UTC corrente; levanta EmailSendError se acima do teto."""
    try:
        client = redis_client or _build_redis_client(settings.redis_url)
        hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
        key = f"{_KEY_PREFIX}:{hour}"
        count = client.incr(key)
        if count == 1:
            client.expire(key, 3700)
    except (redis.exceptions.RedisError, OSError, ValueError):
        raise EmailSendError("rate_limit_unavailable") from None  # fail-closed
    if count > settings.email_max_per_hour:
        raise EmailSendError("hourly_cap_exceeded")


def _audit(event: str, masked: str, purpose: str, *, ok: bool, code: str | None) -> None:
    details: dict[str, Any] = {"recipient": masked, "purpose": purpose}
    if code:
        details["error_code"] = code
    record_security_event(
        event,
        severity=SEVERITY_LOW if ok else SEVERITY_MEDIUM,
        target_type="email",
        target_id=masked,
        details=details,
        result="SUCESSO" if ok else "FALHA",
    )


def send_email_safely(
    message: EmailMessageData,
    *,
    purpose: str = "generic",
    settings: Settings | None = None,
    redis_client: Any | None = None,
) -> EmailResult:
    """Envia e-mail sem nunca levantar. Retorna EmailResult (sent/disabled/failed)."""
    masked = "***"
    try:
        s = settings or get_settings()
        sender = build_email_sender(s)
        if isinstance(sender, NullEmailSender):
            return sender.send(message)
        masked = mask_address(message.to)
        purpose = str(purpose)[:50]
        _reserve_slot(s, redis_client)
        deadline = s.email_timeout_seconds * 3 + RETRY_DELAY_SECONDS
        future = _get_executor().submit(sender.send, message)
        try:
            result = future.result(timeout=deadline)
        except FutureTimeout:
            raise EmailSendError("timeout") from None
        _audit(EVENT_EMAIL_SENT, masked, purpose, ok=True, code=None)
        return result
    except EmailSendError as exc:
        code = exc.code
    except Exception as exc:  # noqa: BLE001 - nunca propaga
        logger.error("email: erro inesperado (%s).", type(exc).__name__)
        code = "unexpected_error"
    try:
        _audit(EVENT_EMAIL_FAILED, masked, str(purpose)[:50], ok=False, code=code)
    except Exception:  # noqa: BLE001
        pass
    return EmailResult(status="failed", error_code=code)
