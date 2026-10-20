"""Dashboard: `GET /api/v1/dashboard/alerts` e leituras agregadas.

`/alerts` (Etapa 4a): qualquer perfil autenticado (USER/RH/ADM), sem AAL2 e sem
permissão granular; limitado, no banco, às unidades do próprio usuário
(`apply_unit_scope`). Funciona sem IA. Resposta:

    {"generated_at": ISO-UTC,
     "items": [{"code","severity","title","description","count"}],
     "unavailable": [codes de regras que falharam]}

Leituras agregadas (`/resumo`, `/por-unidade`, `/por-situacao`,
`/aquisicoes-mensais`, `/localizacao-por-unidade`, `/por-vinculo`,
`/pendencias-cadastro`, `/por-sala`, `/inventario`, `/tipos`):
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

from flask import Blueprint, g, jsonify, request
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
    TipoItem,
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
