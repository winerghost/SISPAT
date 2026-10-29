"""Dados dos 12 painéis, fila de revisão de classificação e exportações (ONDA 2).

Rotas registradas no `dashboard_bp` (prefixo `/api/v1/dashboard`):

    GET /dashboard/panels/<panel_id>/data    leitura (`reports.read`)
    GET /dashboard/panels/<panel_id>/records leitura dos bens de uma barra (`reports.read`)
    GET /dashboard/panels/<panel_id>/export  CSV/XLSX das tabelas (`exports.create`)
    GET /dashboard/classificacao/revisao          fila OUTROS+BAIXA (ADM + AAL2, `reports.read`)
    GET /dashboard/classificacao/revisao/export   CSV/XLSX da fila (ADM + AAL2, `exports.create`)

Leituras de painel: `require_auth -> require_aal2_for_adm -> require_permission
-> rate_limit` (como as demais leituras do dashboard). A fila e sua exportação
são só do ADM (`require_role("ADM") -> require_aal2`), como o painel
`unclassified_review`. Escopo de unidade sempre, só bens ativos, `no-store`,
nenhum dado pessoal. Painel inexistente, malformado OU proibido ao perfil =>
a MESMA resposta 404 (e o mesmo evento de segurança). Contrato:
`docs/architecture/dashboard-api.md`.
"""
from __future__ import annotations

from flask import Response, g, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import WINDOW, require_aal2_for_adm
from app.api.v1.dashboard import (
    DASHBOARD_READ_LIMIT,
    TECH_EXPORT_LIMIT,
    _current_roles,
    _no_store,
    dashboard_bp,
)
from app.api.v1.dashboard_schemas import (
    LocatedRecordsQuery,
    PanelDataOut,
    PanelDataQuery,
    PanelExportQuery,
    ReviewExportQuery,
    ReviewQueueQuery,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    SEVERITY_MEDIUM,
    get_request_id,
    record_security_event,
)
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services import dashboard_classification_service as classification
from app.services import dashboard_equipment_service as equipment
from app.services import dashboard_located_service as located
from app.services.report_service import ReportError


def _panel_not_found(exc: equipment.PanelNotFoundError, context: str):
    # Mesmo evento e mesma resposta para inexistente, malformado e proibido.
    record_security_event(
        EVENT_ACCESS_DENIED,
        severity=SEVERITY_MEDIUM,
        actor_user_id=g.current_user.id,
        target_type="dashboard_panel",
        details={"context": context},
    )
    return error_response(exc.status_code, exc.code, exc.message)


def _file_response(result) -> Response:
    response = Response(result.content, status=200, content_type=result.mimetype)
    response.headers["Content-Disposition"] = f'attachment; filename="{result.filename}"'
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Report-Rows"] = str(result.rows)
    return response


@dashboard_bp.route("/dashboard/panels/<panel_id>/data", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_panel_data(panel_id: str):
    try:
        query = parse_query(PanelDataQuery, request.args, context="dashboard.panel_data")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            data = equipment.panel_data(db, g.current_user.id, _current_roles(), panel_id, query)
    except equipment.PanelNotFoundError as exc:
        return _panel_not_found(exc, "dashboard.panel_data")
    return _no_store(PanelDataOut.model_validate(data).model_dump())


@dashboard_bp.route("/dashboard/panels/<panel_id>/records", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_panel_records(panel_id: str):
    try:
        # Painel sem registros/proibido/inexistente: 404 idêntico ANTES de validar a query.
        located.authorize_records_panel(panel_id, _current_roles())
    except equipment.PanelNotFoundError as exc:
        return _panel_not_found(exc, "dashboard.panel_records")
    try:
        query = parse_query(LocatedRecordsQuery, request.args, context="dashboard.panel_records")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = located.located_records(db, g.current_user.id, _current_roles(), panel_id, query)
    return _no_store(payload)


@dashboard_bp.route("/dashboard/panels/<panel_id>/export", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("exports.create")
@rate_limit(admin_rate_limit_key, limit=TECH_EXPORT_LIMIT, window_seconds=WINDOW)
def export_panel(panel_id: str):
    try:
        query = parse_query(PanelExportQuery, request.args, context="dashboard.panel_export")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            result = classification.export_panel_table(
                db, g.current_user.id, _current_roles(), panel_id, query,
                request_id=get_request_id(),
            )
    except equipment.PanelNotFoundError as exc:
        return _panel_not_found(exc, "dashboard.panel_export")
    except ReportError as exc:
        return error_response(exc.status_code, exc.code, exc.message)
    return _file_response(result)


@dashboard_bp.route("/dashboard/classificacao/revisao", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_review_queue():
    try:
        query = parse_query(ReviewQueueQuery, request.args, context="dashboard.review_queue")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = classification.review_queue(db, g.current_user.id, query)
    return _no_store(payload)


@dashboard_bp.route("/dashboard/classificacao/revisao/export", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("exports.create")
@rate_limit(admin_rate_limit_key, limit=TECH_EXPORT_LIMIT, window_seconds=WINDOW)
def export_review_queue():
    try:
        query = parse_query(ReviewExportQuery, request.args, context="dashboard.review_export")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            result = classification.export_review_queue(
                db, g.current_user.id, query, request_id=get_request_id()
            )
    except ReportError as exc:
        return error_response(exc.status_code, exc.code, exc.message)
    return _file_response(result)
