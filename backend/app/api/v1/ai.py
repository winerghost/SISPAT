"""IA consultiva no dashboard (Etapa 4b): `/api/v1/ai/insights` e `/api/v1/ai/ask`.

    GET  /ai/insights  qualquer perfil autenticado; escopo = unidades do usuário;
         SÓ LÊ o cache gerado pelas tasks (nunca chama o provedor). Contrato:
         {"status": "ok"|"unavailable", "generated_at": ISO|null,
          "items": [{"kind","title","text"}]}. IA desligada/sem cache => 200
         {"status":"unavailable","generated_at":null,"items":[]}.
    POST /ai/ask       exige AAL2 (MFA) + permissão `ai.use` + flag `assistant`. Corpo
         {"question": str 1..500} (`extra="forbid"`). Resposta 200
         {"status":"ok","answer","tools_used"} ou {"status":"unavailable"};
         429 quando o rate limit (por usuário/unidade) estoura.

Ambas: `Cache-Control: no-store`; texto sempre puro; falhas de IA nunca viram
5xx (degradação para "unavailable").
"""
from __future__ import annotations

import logging
from typing import Any

from flask import Blueprint, g, jsonify, request
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import parse_body
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import get_accessible_unit_ids, require_aal2, require_permission
from app.config.settings import get_settings
from app.database.session import get_db_session
from app.models.units import Unit
from app.security.rate_limit import rate_limit
from app.services.ai.assistant import MAX_QUESTION_CHARS, ask
from app.services.ai.factory import build_redis_client
from app.services.ai.insights import FEATURE_BY_KIND, KINDS, UnitRef, read_insights
from app.services.ai.models import FEATURE_ASSISTANT, PROVIDER_NONE
from app.services.ai_settings_service import AISettingsService

logger = logging.getLogger(__name__)

ai_bp = Blueprint("ai", __name__, url_prefix="/ai")

_PERMISSION = "ai.use"
_WINDOW_SECONDS = 3600
_INSIGHTS_LIMIT = 300
# Redis fora NÃO vira 503: a IA falha fechada por conta própria (circuito/rate limit
# do serviço negam) e a rota responde 200 "unavailable" (degradação graciosa).
_FAIL_OPEN = True
_ASK_LIMIT = 60  # guarda barata de rota; os limites de IA (usuário/unidade) vêm do serviço


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question: StrictStr = Field(min_length=1, max_length=MAX_QUESTION_CHARS)


def _no_store(payload: dict[str, Any], status: int = 200):
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    response.status_code = status
    return response


def _unavailable_insights():
    return _no_store({"status": "unavailable", "generated_at": None, "items": []})


@ai_bp.route("/insights", methods=["GET"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_INSIGHTS_LIMIT, window_seconds=_WINDOW_SECONDS, fail_open=_FAIL_OPEN)
def get_insights():
    try:
        settings = get_settings()
        if not settings.ai_enabled:
            return _unavailable_insights()
        with get_db_session() as db:
            config = AISettingsService(db).load_config()
            if not config.enabled or config.provider == PROVIDER_NONE:
                return _unavailable_insights()
            kinds = [k for k in KINDS if config.feature_enabled(FEATURE_BY_KIND[k])]
            if not kinds:
                return _unavailable_insights()
            unit_ids = get_accessible_unit_ids(g.current_user.id, db)
            rows = (
                db.query(Unit.id, Unit.code, Unit.name).filter(Unit.id.in_(sorted(unit_ids, key=str))).all()
                if unit_ids
                else []
            )
        units = [UnitRef(id=r[0], code=str(r[1]), name=str(r[2])) for r in rows]
        items = read_insights(build_redis_client(settings), units, kinds) if units else []
    except Exception as exc:  # noqa: BLE001 - degradação graciosa
        logger.error("ai_api: insights indisponíveis (%s)", type(exc).__name__)
        return _unavailable_insights()
    if not items:
        return _unavailable_insights()
    generated_at = max(item["generated_at"] for item in items)
    return _no_store(
        {
            "status": "ok",
            "generated_at": generated_at,
            "items": [{"kind": i["kind"], "title": i["title"], "text": i["text"]} for i in items],
        }
    )


@ai_bp.route("/ask", methods=["POST"])
@require_auth
@require_aal2
@require_permission(_PERMISSION)
@rate_limit(admin_rate_limit_key, limit=_ASK_LIMIT, window_seconds=_WINDOW_SECONDS, fail_open=_FAIL_OPEN)
def post_ask():
    try:
        body = parse_body(AskRequest, request.get_json(silent=True), context="ai.ask")
    except BadRequest as exc:
        return validation_error(exc)

    user = g.current_user
    roles = frozenset(getattr(g, "current_user_roles", set()))
    try:
        settings = get_settings()
        if not settings.ai_enabled:
            return _no_store({"status": "unavailable"})
        with get_db_session() as db:
            config = AISettingsService(db).load_config()
            if not config.feature_enabled(FEATURE_ASSISTANT):
                return _no_store({"status": "unavailable"})
            unit_ids = sorted(get_accessible_unit_ids(user.id, db), key=str)
        if not unit_ids:
            return _no_store({"status": "unavailable"})
        outcome = ask(
            body.question,
            config=config,
            user_id=user.id,
            unit_id=unit_ids[0],
            role_codes=roles,
            session_factory=get_db_session,
            settings=settings,
        )
    except Exception as exc:  # noqa: BLE001 - degradação graciosa
        logger.error("ai_api: ask indisponível (%s)", type(exc).__name__)
        return _no_store({"status": "unavailable"})
    if outcome.status == "rate_limited":
        response = error_response(429, "rate_limited", "Muitas perguntas. Tente novamente mais tarde.")
        response.headers["Cache-Control"] = "no-store"
        return response
    if outcome.status != "ok":
        return _no_store({"status": "unavailable"})
    return _no_store({"status": "ok", "answer": outcome.answer, "tools_used": list(outcome.tools_used)})
