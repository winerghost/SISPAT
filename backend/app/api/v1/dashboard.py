"""Dashboard: `GET /api/v1/dashboard/alerts` e leituras agregadas.

`/alerts` (Etapa 4a): qualquer perfil autenticado (USER/RH/ADM), sem AAL2 e sem
permissão granular; limitado, no banco, às unidades do próprio usuário
(`apply_unit_scope`). Funciona sem IA. Resposta:

    {"generated_at": ISO-UTC,
     "items": [{"code","severity","title","description","count"}],
     "unavailable": [codes de regras que falharam]}

Leituras agregadas (`/resumo`, `/por-unidade`, `/por-situacao`,
`/aquisicoes-mensais`): `require_auth -> require_aal2_for_adm ->
require_permission("reports.read") -> rate_limit`; escopo de unidade sempre
(ADM sem bypass), só bens ativos, `Cache-Control: no-store`. Regras em
`app.services.dashboard_service`; contrato em `docs/architecture/dashboard-api.md`.

Nenhum dado pessoal é devolvido (só contagens), inclusive para RH. Acessos
sem autenticação são negados/auditados por `require_auth`.
"""
from __future__ import annotations

from typing import Any

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import READ_LIMIT, WINDOW, require_aal2_for_adm
from app.api.v1.dashboard_schemas import (
    AquisicoesQuery,
    DashboardNoQuery,
    PorSituacaoItem,
    PorUnidadeItem,
    ResumoOut,
    SerieMensal,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_permission
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services import dashboard_service
from app.services.alerts import evaluate_alerts

dashboard_bp = Blueprint("dashboard", __name__)

_ALERTS_LIMIT = 120
_WINDOW_SECONDS = 3600


def _no_store(payload: Any):
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response, 200


@dashboard_bp.route("/dashboard/alerts", methods=["GET"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_ALERTS_LIMIT, window_seconds=_WINDOW_SECONDS)
def get_alerts():
    return _no_store(evaluate_alerts(g.current_user.id))


@dashboard_bp.route("/dashboard/resumo", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_summary():
    try:
        parse_query(DashboardNoQuery, request.args, context="dashboard.resumo")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        data = dashboard_service.summary(db, g.current_user.id)
    return _no_store(ResumoOut.model_validate(data).model_dump())


@dashboard_bp.route("/dashboard/por-unidade", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_by_unit():
    try:
        parse_query(DashboardNoQuery, request.args, context="dashboard.por_unidade")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        data = dashboard_service.by_unit(db, g.current_user.id)
    return _no_store([PorUnidadeItem.model_validate(i).model_dump() for i in data])


@dashboard_bp.route("/dashboard/por-situacao", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_by_situation():
    try:
        parse_query(DashboardNoQuery, request.args, context="dashboard.por_situacao")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        data = dashboard_service.by_situation(db, g.current_user.id)
    return _no_store([PorSituacaoItem.model_validate(i).model_dump() for i in data])


@dashboard_bp.route("/dashboard/aquisicoes-mensais", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_monthly_acquisitions():
    try:
        query = parse_query(AquisicoesQuery, request.args, context="dashboard.aquisicoes_mensais")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        data = dashboard_service.monthly_acquisitions(db, g.current_user.id, query.meses)
    return _no_store([SerieMensal.model_validate(i).model_dump() for i in data])
