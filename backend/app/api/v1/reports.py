"""Relatórios e exportações: `GET /api/v1/reports` e `GET /api/v1/reports/<kind>/export`.

Ambas: `require_auth -> require_aal2_for_adm -> require_permission(...) -> rate_limit`
(USER/RH/ADM; AAL2 só para ADM, como as demais leituras compartilhadas).

- `GET /reports`: catálogo (permissão `reports.read`); colunas conforme o perfil e
  opções dos filtros dinâmicos (`bond_status`) conforme o ESCOPO DE UNIDADE do ator.
- `GET /reports/<kind>/export?format=csv|xlsx&...` com `kind` em
  `assets | movements | inventory-items` (permissão `exports.create`). Filtros e
  ordenação por allowlist (`report_schemas`), `columns=a,b` opcional (allowlist do catálogo, 400 `invalid_columns`), escopo de unidade sempre, bens
  excluídos fora (`include_deleted=true` só ADM -> senão 403 + evento), no máximo
  `MAX_EXPORT_ROWS` linhas (acima: 413), toda célula passa por `csv_safety`, auditoria
  `REPORT_EXPORTED` na mesma transação. Corpo = arquivo (`attachment`, `no-store`).
  `kind` desconhecido, unidade/inventário/sala/responsável alheios, inexistentes ou
  malformados => 404 igual.

Regras em `app.services.report_service`; contrato em `docs/architecture/reports-api.md`.
"""
from __future__ import annotations

from flask import Blueprint, Response, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import READ_LIMIT, WINDOW, is_adm, require_aal2_for_adm
from app.api.v1.report_schemas import QUERY_MODELS, ReportCatalogQuery
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_permission
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    EVENT_UNIT_SCOPE_DENIED,
    SEVERITY_MEDIUM,
    get_request_id,
    record_security_event,
)
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.report_service import ReportError, ReportNotFoundError, ReportService

reports_bp = Blueprint("reports", __name__, url_prefix="/reports")

EXPORT_LIMIT = 30  # exportações por usuário/hora (cada uma pode ter até MAX_EXPORT_ROWS linhas)


def _service(db) -> ReportService:
    return ReportService(db, roles=set(getattr(g, "current_user_roles", set())), request_id=get_request_id())


def _fail(exc: ReportError, *, kind: str):
    if isinstance(exc, ReportNotFoundError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="report",
            details={"context": "reports.export", "report": kind[:32]},
        )
    return error_response(exc.status_code, exc.code, exc.message)


@reports_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def list_reports_endpoint():
    try:
        parse_query(ReportCatalogQuery, request.args, context="reports.list")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _service(db).catalog(g.current_user.id)
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response, 200


@reports_bp.route("/<kind>/export", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("exports.create")
@rate_limit(admin_rate_limit_key, limit=EXPORT_LIMIT, window_seconds=WINDOW)
def export_report_endpoint(kind: str):
    model = QUERY_MODELS.get(kind)
    if model is None:
        return _fail(ReportNotFoundError(), kind=kind)
    try:
        query = parse_query(model, request.args, context=f"reports.export.{kind}")
    except BadRequest as exc:
        if isinstance(exc.description, str) and "columns" in exc.description.split(":")[-1]:
            return error_response(400, "invalid_columns", "Seleção de colunas inválida.")
        return validation_error(exc)
    if query.include_deleted == "true" and not is_adm():
        record_security_event(
            EVENT_ACCESS_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="report",
            details={"context": "reports.export", "reason": "include_deleted_requires_adm"},
        )
        return error_response(403, "forbidden", "Acesso negado.")
    try:
        with get_db_session() as db:
            result = _service(db).export(g.current_user.id, kind, query)
    except ReportError as exc:
        if getattr(exc, "forbidden", False):
            record_security_event(
                EVENT_ACCESS_DENIED,
                severity=SEVERITY_MEDIUM,
                actor_user_id=g.current_user.id,
                target_type="report",
                details={"context": "reports.export", "reason": "column_not_allowed_for_role",
                         "report": kind[:32]},
            )
        return _fail(exc, kind=kind)
    response = Response(result.content, status=200, content_type=result.mimetype)
    response.headers["Content-Disposition"] = f'attachment; filename="{result.filename}"'
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Report-Rows"] = str(result.rows)
    return response
