"""Notificacao por e-mail dos ADMs ativos para eventos criticos de seguranca.

Gancho: `app.authorization.security_events._dispatch` chama
`notify_admins_of_event(event)` para todo evento com `notify=True`
(severidade high/critical). Garantias:

    - DESLIGADO por padrao: com EMAIL_ENABLED=false e no-op (sem banco, sem
      rede, sem thread).
    - Destinatarios resolvidos NO BANCO (usuarios ativos, nao desativados,
      com o papel ADM); nada vem do cliente. Limitado a `MAX_RECIPIENTS`.
    - Nunca bloqueia nem derruba a operacao: a resolucao/envio roda em uma
      thread propria (executor de 1 worker, patchavel em testes) e toda
      excecao e engolida (apenas o tipo da excecao e logado).
    - Anti-inundacao: no maximo 1 e-mail por TIPO de evento a cada
      `THROTTLE_SECONDS` (por processo), alem do teto global
      EMAIL_MAX_PER_HOUR de `send_email_safely`.
    - Corpo SEM dados sensiveis: so tipo, severidade, resultado, horario UTC
      e id da requisicao. Nunca IP, caminho, ator, alvo, detalhes, tokens.
    - Todo envio passa por `render_email` + `send_email_safely` (que mascara
      o destinatario na auditoria `EMAIL_SENT`/`EMAIL_FAILED`).
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import Executor, ThreadPoolExecutor
from threading import Lock
from typing import Any

from sqlalchemy import select

from app.authorization.security_events import EVENT_EMAIL_FAILED, EVENT_EMAIL_SENT
from app.config.settings import get_settings
from app.database.session import get_db_session
from app.models.rbac import Role, User, UserRole
from app.services.email.dispatch import send_email_safely
from app.services.email.sender import EmailMessageData
from app.services.email.templates import clean_text, render_email

logger = logging.getLogger(__name__)

ADMIN_ROLE_CODE = "ADM"
MAX_RECIPIENTS = 20
THROTTLE_SECONDS = 300
PURPOSE = "security_alert"

# Eventos de e-mail nunca disparam e-mail (evita laco).
_NEVER_NOTIFY = frozenset({EVENT_EMAIL_SENT, EVENT_EMAIL_FAILED})

_executor: Executor | None = None
_lock = Lock()
_last_sent: dict[str, float] = {}


def _get_executor() -> Executor:
    """Executor de 1 thread, criado sob demanda. Patchavel em testes."""
    global _executor
    with _lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sispat-secmail")
        return _executor


def reset_throttle() -> None:
    """Zera o anti-inundacao (testes)."""
    with _lock:
        _last_sent.clear()


def _throttled(event_type: str) -> bool:
    now = time.monotonic()
    with _lock:
        last = _last_sent.get(event_type)
        if last is not None and now - last < THROTTLE_SECONDS:
            return True
        _last_sent[event_type] = now
        return False


def resolve_admin_recipients() -> list[str]:
    """E-mails dos ADMs ativos, lidos do banco (ordem estavel, sem duplicatas)."""
    with get_db_session() as db:
        rows = db.execute(
            select(User.email)
            .join(UserRole, UserRole.user_id == User.id)
            .join(Role, Role.id == UserRole.role_id)
            .where(
                Role.code == ADMIN_ROLE_CODE,
                Role.active.is_(True),
                User.active.is_(True),
                User.deactivated_at.is_(None),
            )
            .order_by(User.email)
            .limit(MAX_RECIPIENTS)
        ).scalars()
        emails = [str(e) for e in rows if e]
    return list(dict.fromkeys(emails))


def build_alert_message(event: dict[str, Any], recipient: str) -> EmailMessageData:
    """Mensagem fixa e minima (template `notification`, autoescape)."""
    event_type = clean_text(event.get("event_type", "EVENTO"), limit=64)
    request_id = clean_text((event.get("request") or {}).get("request_id") or "n/d", limit=64)
    rendered = render_email(
        "notification",
        {
            "title": f"Alerta de seguranca: {event_type}",
            "paragraphs": [
                "Um evento critico de seguranca foi registrado no SISPAT-AGU.",
                f"Tipo: {event_type}. Severidade: {clean_text(event.get('severity', 'n/d'), limit=16)}. "
                f"Resultado: {clean_text(event.get('result', 'n/d'), limit=16)}.",
                f"Horario (UTC): {clean_text(event.get('occurred_at', 'n/d'), limit=40)}. "
                f"Requisicao: {request_id}.",
                "Consulte os registros de auditoria (audit_logs) para os detalhes. "
                "Nenhum dado sensivel e enviado por e-mail.",
            ],
        },
    )
    return EmailMessageData(
        to=recipient, subject=rendered.subject, text_body=rendered.text, html_body=rendered.html
    )


def _send_to_admins(event: dict[str, Any]) -> None:
    try:
        recipients = resolve_admin_recipients()
    except Exception as exc:  # noqa: BLE001
        logger.error("security_notifications: falha ao resolver ADMs (%s).", type(exc).__name__)
        return
    for recipient in recipients:
        try:
            send_email_safely(build_alert_message(event, recipient), purpose=PURPOSE)
        except Exception as exc:  # noqa: BLE001 - send_email_safely ja nao levanta
            logger.error("security_notifications: falha de envio (%s).", type(exc).__name__)


def notify_admins_of_event(event: dict[str, Any]) -> bool:
    """Agenda o aviso aos ADMs. Retorna True se agendou. Nunca levanta."""
    try:
        if not event.get("notify") or event.get("event_type") in _NEVER_NOTIFY:
            return False
        if not get_settings().email_enabled:
            return False
        if _throttled(str(event.get("event_type"))):
            return False
        _get_executor().submit(_send_to_admins, event)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error("security_notifications: falha ao agendar (%s).", type(exc).__name__)
        return False
