"""Configuração da IA consultiva (`/api/v1/settings/ai`).

Contrato: `docs/architecture/modulo-configuracoes.md` (Etapa 1). Rotas finas:
toda regra vive em `app.services.ai_settings_service.AISettingsService`.

    - `GET  /api/v1/settings/ai`       estado, provedor, modelo, features,
      `keys` (só "configured"/"not_configured") e allowlist de modelos.
    - `PATCH /api/v1/settings/ai`      atualização com `version` (409
      `version_conflict`), 400 `invalid_model` / `deepseek_ack_required` /
      `validation_error` (campos desconhecidos, auditados).
    - `POST /api/v1/settings/ai/test`  prompt fixo sem dados; sempre 200
      `{result, latency_ms}`; 5/h por ADM.

Todas: `require_auth -> require_role("ADM") -> require_aal2 ->
require_permission("settings.ai.manage") -> rate_limit` (fail_open=False).
Nenhuma resposta contém chave de API nem mensagem do provedor.
"""
from __future__ import annotations

import logging
from typing import Any

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import AISettingsUpdate, parse_body, reject_unexpected_fields
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import get_request_id
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.ai_settings_service import AISettingsError, AISettingsService

logger = logging.getLogger(__name__)

ai_settings_bp = Blueprint("ai_settings", __name__, url_prefix="/settings/ai")

_PERMISSION = "settings.ai.manage"
_WINDOW_SECONDS = 3600
_GET_LIMIT_PER_HOUR = 300
_PATCH_LIMIT_PER_HOUR = 30
_TEST_LIMIT_PER_HOUR = 5

_VALIDATION_FALLBACK_MESSAGE = "Requisição inválida."


def _admin_rate_limit_key(*_args: Any, **_kwargs: Any) -> str:
    """Chave por ADM autenticado (`rate_limit` é o decorator mais interno)."""
    user = getattr(g, "current_user", None)
    return str(getattr(user, "id", "desconhecido"))


def _error(status: int, code: str, message: str):
    response = jsonify({"error": {"code": code, "message": message}})
    response.status_code = status
    return response


def _validation_error(exc: BadRequest):
    """Mesmo 400 de `parse_body`/`reject_unexpected_fields` (já auditado),
    com o código `validation_error` do contrato. A mensagem é a da própria
    aplicação (só nomes de campos, nunca valores)."""
    message = exc.description if isinstance(exc.description, str) else None
    return _error(400, "validation_error", message or _VALIDATION_FALLBACK_MESSAGE)


@ai_settings_bp.route("", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission(_PERMISSION)
@rate_limit(_admin_rate_limit_key, limit=_GET_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def get_ai_settings_endpoint():
    with get_db_session() as db:
        payload = AISettingsService(db).get_view()
    return jsonify(payload), 200


@ai_settings_bp.route("", methods=["PATCH"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission(_PERMISSION)
@rate_limit(_admin_rate_limit_key, limit=_PATCH_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def update_ai_settings_endpoint():
    try:
        changes = parse_body(
            AISettingsUpdate, request.get_json(silent=True), context="settings.ai.update"
        )
    except BadRequest as exc:
        return _validation_error(exc)

    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = AISettingsService(db).update(
                changes, actor_user_id=actor.id, request_id=get_request_id()
            )
    except AISettingsError as exc:
        return _error(exc.status_code, exc.code, exc.message)
    return jsonify(payload), 200


@ai_settings_bp.route("/test", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission(_PERMISSION)
@rate_limit(_admin_rate_limit_key, limit=_TEST_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def test_ai_connection_endpoint():
    body = request.get_json(silent=True)
    if body is not None and body != {}:
        if isinstance(body, dict):
            try:
                reject_unexpected_fields(set(body.keys()), context="settings.ai.test")
            except BadRequest as exc:
                return _validation_error(exc)
        return _error(400, "validation_error", "Este endpoint não aceita corpo na requisição.")

    actor = g.current_user
    # Sessão curta só para ler a config: a chamada ao provedor (até
    # AI_TIMEOUT_SECONDS) não segura transação aberta.
    with get_db_session() as db:
        config = AISettingsService(db).load_config()
    payload = AISettingsService(None).test_connection(config, actor_user_id=actor.id)
    return jsonify(payload), 200
