"""Dashboard: `GET /api/v1/dashboard/alerts` e leituras agregadas.

`/alerts` (Etapa 4a): qualquer perfil autenticado (USER/RH/ADM), sem AAL2 e sem
permissão granular; limitado, no banco, às unidades do próprio usuário
(`apply_unit_scope`). Funciona sem IA. Resposta:

    {"generated_at": ISO-UTC,
     "items": [{"code","severity","title","description","count"}],
     "unavailable": [codes de regras que falharam]}

Leituras agregadas (`/resumo`, `/por-unidade`, `/por-situacao`,
`/aquisicoes-mensais`, `/localizacao-por-unidade`, `/por-vinculo`,
`/pendencias-cadastro`, `/por-sala`, `/inventario`, `/tipos`) e painéis de
Tecnologia (`/tecnologia/{resumo,por-categoria,por-unidade,por-status,
sem-responsavel,tempo-registro}`; `/tecnologia/export` = CSV/XLSX, permissão
`exports.create`, auditado, via `csv_safety`; filtros `TechFilters`):
`require_auth -> require_aal2_for_adm -> require_permission("reports.read") ->
rate_limit`; escopo de unidade sempre (ADM sem bypass), só bens ativos,
`Cache-Control: no-store`. Todas aceitam os MESMOS filtros opcionais
(`DashboardFilters`, `extra="forbid"`: desconhecido/repetido/inválido -> 400
sem eco de valor); `/aquisicoes-mensais` aceita também `meses`. Regras em
`app.services.dashboard_service`; contrato em `docs/architecture/dashboard-api.md`.

Limite: `DASHBOARD_READ_LIMIT` por usuário/hora e POR ROTA (a chave do
`rate_limit` inclui a view). Cada troca de filtro chama cada painel uma vez;
600/h (10 trocas/min sustentadas) é apertado para exploração interativa, então
o dashboard usa o mesmo teto das listagens (`LIST_LIMIT`, 1200/h = 20/min). As
consultas são agregadas, limitadas (top N) e sem PII.

Nenhum dado pessoal é devolvido (só contagens e rótulos), inclusive para RH.
Acessos sem autenticação são negados/auditados por `require_auth`.
"""
from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, Response, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import LIST_LIMIT, WINDOW, require_aal2_for_adm
from app.api.v1.dashboard_schemas import (
    AquisicoesQuery,
    DashboardFilters,
    InventarioOut,
    LocalizacaoUnidadeItem,
    PendenciasOut,
    PorSituacaoItem,
    PorUnidadeItem,
    ResumoOut,
    RotuloItem,
    SerieMensal,
    TechCategoriaOut,
    TechExportQuery,
    TechFilters,
    TechResumoOut,
    TechSemResponsavelOut,
    TechTempoItem,
    TipoItem,
    TechCountItem,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_permission
from app.authorization.security_events import get_request_id
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services import dashboard_service, dashboard_tech_service
from app.services.report_service import ReportError
from app.services.alerts import evaluate_alerts

dashboard_bp = Blueprint("dashboard", __name__)

_ALERTS_LIMIT = 120
TECH_EXPORT_LIMIT = 30  # exportações por usuário/hora (mesmo teto de /reports)
_WINDOW_SECONDS = 3600
DASHBOARD_READ_LIMIT = LIST_LIMIT


def _no_store(payload: Any):
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response, 200


def _aggregate(
    context: str,
    compute: Callable[[Any, Any, Any], Any],
    out_model: Any,
    *,
    many: bool,
    schema: Any = DashboardFilters,
):
    """Valida os filtros, agrega no escopo do usuário e valida a saída."""
    try:
        query = parse_query(schema, request.args, context=f"dashboard.{context}")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        data = compute(db, g.current_user.id, query)
    if many:
        return _no_store([out_model.model_validate(i).model_dump() for i in data])
    return _no_store(out_model.model_validate(data).model_dump())


@dashboard_bp.route("/dashboard/alerts", methods=["GET"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_ALERTS_LIMIT, window_seconds=_WINDOW_SECONDS)
def get_alerts():
    return _no_store(evaluate_alerts(g.current_user.id))


def _summary(db: Any, actor_id: Any, query: DashboardFilters) -> dict[str, Any]:
    data = dashboard_service.summary(db, actor_id, query)
    data["filtros_aplicados"] = query.active_names()  # só NOMES, nunca valores
    return data


@dashboard_bp.route("/dashboard/resumo", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_summary():
    return _aggregate("resumo", _summary, ResumoOut, many=False)


@dashboard_bp.route("/dashboard/por-unidade", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_by_unit():
    return _aggregate("por_unidade", dashboard_service.by_unit, PorUnidadeItem, many=True)


@dashboard_bp.route("/dashboard/por-situacao", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_by_situation():
    return _aggregate("por_situacao", dashboard_service.by_situation, PorSituacaoItem, many=True)


@dashboard_bp.route("/dashboard/aquisicoes-mensais", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_monthly_acquisitions():
    return _aggregate(
        "aquisicoes_mensais",
        lambda db, actor, q: dashboard_service.monthly_acquisitions(db, actor, q.meses, q),
        SerieMensal,
        many=True,
        schema=AquisicoesQuery,
    )


@dashboard_bp.route("/dashboard/localizacao-por-unidade", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_location_by_unit():
    return _aggregate(
        "localizacao_por_unidade", dashboard_service.location_by_unit, LocalizacaoUnidadeItem, many=True
    )


@dashboard_bp.route("/dashboard/por-vinculo", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_by_bond_status():
    return _aggregate("por_vinculo", dashboard_service.by_bond_status, RotuloItem, many=True)


@dashboard_bp.route("/dashboard/pendencias-cadastro", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_registration_gaps():
    return _aggregate("pendencias_cadastro", dashboard_service.registration_gaps, PendenciasOut, many=False)


@dashboard_bp.route("/dashboard/por-sala", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_by_room():
    return _aggregate("por_sala", dashboard_service.by_room, RotuloItem, many=True)


@dashboard_bp.route("/dashboard/inventario", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_inventory_status():
    return _aggregate("inventario", dashboard_service.inventory_status, InventarioOut, many=False)


@dashboard_bp.route("/dashboard/tipos", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_type_options():
    return _aggregate("tipos", dashboard_service.type_options, TipoItem, many=True)


# ---------------------------------------------------------------------------
# Painéis de Tecnologia (`/dashboard/tecnologia/*`): mesmos decorators e
# política das leituras acima, com `TechFilters` (categoria/tipo_ti/status).
# ---------------------------------------------------------------------------


def _tech_summary(db: Any, actor_id: Any, query: TechFilters) -> dict[str, Any]:
    data = dashboard_tech_service.summary(db, actor_id, query)
    data["filtros_aplicados"] = query.active_names()  # só NOMES, nunca valores
    return data


def _tech(context: str, compute: Callable[[Any, Any, Any], Any], out_model: Any, *, many: bool):
    return _aggregate(f"tecnologia_{context}", compute, out_model, many=many, schema=TechFilters)


@dashboard_bp.route("/dashboard/tecnologia/resumo", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_tech_summary():
    return _tech("resumo", _tech_summary, TechResumoOut, many=False)


@dashboard_bp.route("/dashboard/tecnologia/por-categoria", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_tech_by_category():
    return _tech("por_categoria", dashboard_tech_service.by_category, TechCategoriaOut, many=False)


@dashboard_bp.route("/dashboard/tecnologia/por-unidade", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_tech_by_unit():
    return _tech("por_unidade", dashboard_tech_service.by_unit, PorUnidadeItem, many=True)


@dashboard_bp.route("/dashboard/tecnologia/por-status", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_tech_by_status():
    return _tech("por_status", dashboard_tech_service.by_status, TechCountItem, many=True)


@dashboard_bp.route("/dashboard/tecnologia/sem-responsavel", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_tech_without_owner():
    return _tech("sem_responsavel", dashboard_tech_service.without_owner, TechSemResponsavelOut, many=False)


@dashboard_bp.route("/dashboard/tecnologia/tempo-registro", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("reports.read")
@rate_limit(admin_rate_limit_key, limit=DASHBOARD_READ_LIMIT, window_seconds=WINDOW)
def get_tech_registration_age():
    return _tech("tempo_registro", dashboard_tech_service.registration_age, TechTempoItem, many=True)


@dashboard_bp.route("/dashboard/tecnologia/export", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("exports.create")
@rate_limit(admin_rate_limit_key, limit=TECH_EXPORT_LIMIT, window_seconds=WINDOW)
def export_tech():
    """CSV/XLSX da tabela agregada (sem dados pessoais), via `csv_safety`, auditado."""
    try:
        query = parse_query(TechExportQuery, request.args, context="dashboard.tecnologia_export")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            result = dashboard_tech_service.export_tech(
                db, g.current_user.id, query, request_id=get_request_id()
            )
    except ReportError as exc:
        return error_response(exc.status_code, exc.code, exc.message)
    response = Response(result.content, status=200, content_type=result.mimetype)
    response.headers["Content-Disposition"] = f'attachment; filename="{result.filename}"'
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Report-Rows"] = str(result.rows)
    return response
