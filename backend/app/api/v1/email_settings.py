"""Teste administrativo do envio de e-mail (`POST /api/v1/settings/email/test`).

Contrato:
    - Pilha: `require_auth -> require_role("ADM") -> require_aal2 ->
      require_permission("settings.email.manage") -> rate_limit` (3/h por ADM,
      fail-closed).
    - Corpo vazio (`EmptyBody`, `extra="forbid"`): qualquer campo -> 400
      auditado. NENHUM destinatario, assunto ou texto vem do cliente.
    - Envia SOMENTE ao e-mail do proprio ADM autenticado (lido do banco por
      `require_auth`), com template fixo, via `render_email` +
      `send_email_safely` (nunca contorna o modulo).
    - Resposta generica `{"result": "sent" | "disabled" | "failed"}` (200),
      sem detalhe SMTP, host, codigo de erro ou endereco.
    - Auditoria: `EMAIL_TEST_REQUESTED` (+ `EMAIL_SENT`/`EMAIL_FAILED` do
      proprio modulo de e-mail, com destinatario mascarado).
"""
from __future__ import annotations

import logging
from typing import Any

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import EmptyBody, get_json_body, parse_body
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import (
    EVENT_EMAIL_TEST_REQUESTED,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.config.settings import get_settings
from app.security.rate_limit import rate_limit
from app.services.email.dispatch import send_email_safely
from app.services.email.sender import EmailMessageData, EmailResult
from app.services.email.templates import TemplateError, render_email

logger = logging.getLogger(__name__)

email_settings_bp = Blueprint("email_settings", __name__, url_prefix="/settings/email")

_PERMISSION = "settings.email.manage"
_TEST_LIMIT_PER_HOUR = 3
_WINDOW_SECONDS = 3600
_PURPOSE = "admin_test"

RESULT_SENT = "sent"
RESULT_DISABLED = "disabled"
RESULT_FAILED = "failed"


def _body_or_empty() -> Any:
    """Sem corpo -> `{}`; corpo presente é validado por `parse_body`."""
    if not request.get_data(cache=True).strip():
        return {}
    return get_json_body()


def _audit(actor_id: Any, result: str) -> None:
    record_security_event(
        EVENT_EMAIL_TEST_REQUESTED,
        severity=SEVERITY_LOW if result != RESULT_FAILED else SEVERITY_MEDIUM,
        actor_user_id=actor_id,
        target_type="email_settings",
        details={"outcome": result},
        result="FALHA" if result == RESULT_FAILED else "SUCESSO",
    )


def _classify(result: EmailResult) -> str:
    if result.status == "sent":
        return RESULT_SENT
    if result.status == "disabled":
        return RESULT_DISABLED
    return RESULT_FAILED


@email_settings_bp.route("/test", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission(_PERMISSION)
@rate_limit(admin_rate_limit_key, limit=_TEST_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def test_email_endpoint():
    try:
        parse_body(EmptyBody, _body_or_empty(), context="settings.email.test")
    except BadRequest as exc:
        return validation_error(exc)

    actor = g.current_user
    # Destinatário = e-mail do PRÓPRIO ADM autenticado (nunca do cliente).
    recipient = getattr(actor, "email", None)
    settings = get_settings()
    if not settings.email_enabled:
        _audit(actor.id, RESULT_DISABLED)
        return jsonify({"result": RESULT_DISABLED}), 200
    try:
        rendered = render_email(
            "notification",
            {
                "title": "Teste de envio de e-mail",
                "paragraphs": [
                    "Esta e uma mensagem de teste solicitada por um administrador do SISPAT-AGU.",
                    "Se voce a recebeu, o envio de e-mail esta funcionando. Nenhuma acao e necessaria.",
                ],
            },
        )
        message = EmailMessageData(
            to=str(recipient or ""),
            subject=rendered.subject,
            text_body=rendered.text,
            html_body=rendered.html,
        )
        outcome = _classify(send_email_safely(message, purpose=_PURPOSE, settings=settings))
    except TemplateError:
        outcome = RESULT_FAILED
    except Exception as exc:  # noqa: BLE001 - resposta genérica, sem detalhes
        logger.error("settings.email.test: erro inesperado (%s).", type(exc).__name__)
        outcome = RESULT_FAILED
    _audit(actor.id, outcome)
    return jsonify({"result": outcome}), 200

