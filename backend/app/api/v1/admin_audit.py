"""Leitura da trilha de auditoria: `GET /api/v1/admin/audit-logs[/<id>]`.

SOMENTE LEITURA (`audit_logs` é append-only; nenhuma rota de escrita).
`require_auth -> require_role("ADM") -> require_aal2 ->
require_permission("audit.read") -> rate_limit` (fail-closed). Filtros por
allowlist, parâmetro desconhecido/repetido -> 400. Detalhe de registro
inexistente, malformado ou fora do escopo de unidade => o MESMO 404.
Cada consulta bem-sucedida grava o evento `AUDIT_VIEWED` (sem payload).
Regras de escopo e projeção segura: `app.services.admin_audit_service`.
"""
from __future__ import annotations

import uuid

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.admin_schemas import AuditListQuery, NoQuery, parse_admin_query
from app.api.v1.user_admin_http import admin_rate_limit_key, not_found_response, validation_error
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import (
    EVENT_UNIT_SCOPE_DENIED,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.auth.supabase_auth import require_auth
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.admin_audit_service import AdminAuditService

EVENT_AUDIT_VIEWED = "AUDIT_VIEWED"

admin_audit_bp = Blueprint("admin_audit", __name__, url_prefix="/admin")

_WINDOW = 3600
_LIST_LIMIT = 600
_DETAIL_LIMIT = 1200


@admin_audit_bp.route("/audit-logs", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("audit.read")
@rate_limit(admin_rate_limit_key, limit=_LIST_LIMIT, window_seconds=_WINDOW)
def list_audit_logs_endpoint():
    """Lista paginada (itens resumidos, sem `details`/`changes`)."""
    try:
        query = parse_admin_query(AuditListQuery, request.args, context="admin.audit.list")
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    with get_db_session() as db:
        payload = AdminAuditService(db).list_logs(actor.id, query)
    record_security_event(
        EVENT_AUDIT_VIEWED, severity=SEVERITY_LOW, actor_user_id=actor.id,
        target_type="audit_log", result="SUCESSO",
    )
    return jsonify(payload), 200


@admin_audit_bp.route("/audit-logs/<uuid:log_id>", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("audit.read")
@rate_limit(admin_rate_limit_key, limit=_DETAIL_LIMIT, window_seconds=_WINDOW)
def get_audit_log_endpoint(log_id: uuid.UUID):
    """Detalhe com projeção em allowlist (alheio = inexistente = 404)."""
    try:
        parse_admin_query(NoQuery, request.args, context="admin.audit.detail")
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    with get_db_session() as db:
        payload = AdminAuditService(db).get_log(actor.id, log_id)
    if payload is None:
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor.id,
            target_type="audit_log",
            target_id=log_id,
            details={"context": "admin.audit.detail"},
        )
        return not_found_response()
    record_security_event(
        EVENT_AUDIT_VIEWED, severity=SEVERITY_LOW, actor_user_id=actor.id,
        target_type="audit_log", target_id=log_id, result="SUCESSO",
    )
    return jsonify(payload), 200
