"""Registros por trás de uma barra do gráfico `located_by_unit_chart` (ONDA A).

Contrato: `docs/architecture/dashboard-api.md` ("Registros do gráfico de
localização"). Regras:
    - só bens ativos e SEMPRE no escopo de unidade (`_active_assets` aplica
      `asset_scope_clause`/`apply_unit_scope`; ADM sem bypass). Unidade alheia,
      inexistente ou sem bens => página vazia (mesma resposta, sem eco);
    - "Outras": `unit_id = "outras"` reconstrói o MESMO ranking do gráfico
      (mesmos filtros `familia`/`categoria`) e lista os bens das unidades que
      ficaram fora do top N;
    - só identificação do BEM (nº patrimonial, descrição, unidade, rótulo da
      sala, situação, categoria efetiva e confiança). Nenhum dado pessoal;
    - ordenação por ALLOWLIST; paginação 50/100/200;
    - leitura de consulta: não é auditada (acesso negado segue o pipeline).
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Iterable

from sqlalchemy import func

from app.models.assets import Asset
from app.models.units import Room
from app.services.dashboard_equipment_service import (
    EFFECTIVE_CATEGORY,
    PanelNotFoundError,
    filter_where,
    located_unit_ranking,
)
from app.services.dashboard_panels_service import PANELS_BY_ID, allowed_panel_ids
from app.services.dashboard_service import TOP_UNIDADES, _active_assets, _unit_labels, clean_label
from app.services.pagination import page_count

RECORDS_PANEL = "located_by_unit_chart"
OUTRAS = "outras"

_LOWER_DESC = func.lower(func.coalesce(Asset.description, ""))
_SORTS: dict[str, tuple[Any, ...]] = {
    "patrimony_number": (Asset.patrimony_number, Asset.id),
    "-patrimony_number": (Asset.patrimony_number.desc(), Asset.id),
    "description": (_LOWER_DESC, Asset.id),
    "-description": (_LOWER_DESC.desc(), Asset.id),
    "located": (Asset.located, Asset.patrimony_number, Asset.id),
    "-located": (Asset.located.desc(), Asset.patrimony_number, Asset.id),
}


def authorize_records_panel(panel_id: Any, roles: Iterable[str] | None) -> str:
    """Só o painel com cliques e liberado ao perfil; senão o MESMO 404 do inexistente."""
    if (
        panel_id != RECORDS_PANEL
        or panel_id not in PANELS_BY_ID
        or panel_id not in allowed_panel_ids(roles)
    ):
        raise PanelNotFoundError()
    return panel_id


def _unit_clause(db: Any, actor_id: Any, query: Any, base_where: tuple[Any, ...]) -> Any:
    if query.unit_id == OUTRAS:
        ranking = located_unit_ranking(db, actor_id, base_where)
        return Asset.unit_id.in_([i["unit_id"] for i in ranking[TOP_UNIDADES:]])
    return Asset.unit_id == query.unit_id


def located_records(db: Any, actor_id: Any, roles: Iterable[str] | None, panel_id: Any, query: Any) -> dict[str, Any]:
    authorize_records_panel(panel_id, roles)
    base = filter_where(
        SimpleNamespace(unit_id=None, familia=query.familia, categoria=query.categoria)
    )
    where = [*base, _unit_clause(db, actor_id, query, base)]
    if query.located is not None:
        where.append(Asset.located == query.located)
    where_t = tuple(where)

    total = int(_active_assets(db, actor_id, func.count(Asset.id), where=where_t).scalar() or 0)
    rows = (
        _active_assets(
            db, actor_id, Asset.id, Asset.patrimony_number, Asset.description, Asset.unit_id,
            Asset.located, Room.name.label("room_name"), EFFECTIVE_CATEGORY.label("category"),
            Asset.classification_confidence, where=where_t,
        )
        .outerjoin(Room, Room.id == Asset.room_id)
        .order_by(*_SORTS[query.sort])
        .offset((query.page - 1) * query.page_size)
        .limit(query.page_size)
        .all()
    )
    names = _unit_labels(db, sorted({r.unit_id for r in rows}, key=str))
    return {
        "items": [
            {
                "id": str(r.id),
                "patrimony_number": r.patrimony_number,
                "description": clean_label(r.description),
                "unidade": names[r.unit_id],
                "sala": clean_label(r.room_name) if r.room_name else None,
                "located": r.located,
                "equipment_category": r.category,
                "classification_confidence": r.classification_confidence,
            }
            for r in rows
        ],
        "total": total,
        "page": query.page,
        "page_size": query.page_size,
        "pages": page_count(total, query.page_size),
    }
