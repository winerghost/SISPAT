"""Fila de revisão, override manual de categoria e exportações (ONDA 2).

Contrato: `docs/architecture/dashboard-api.md`.

FILA DE REVISÃO: bens ativos, no escopo de unidade, com `equipment_category =
'OUTROS'`, `classification_confidence = 'BAIXA'` e SEM `category_override`.
Só identifica o BEM (nº patrimonial, descrição, unidade, regra); nenhum dado
pessoal. Ordenação por ALLOWLIST; paginação 50/100/200.

OVERRIDE MANUAL (`category_override`): só ADM (a rota exige AAL2). Regras:
    - o bem é buscado com escopo de unidade e `deleted_at IS NULL` (alheio,
      inexistente e excluído => `AssetNotFoundError`, mesma resposta);
    - controle otimista por `version` (divergência => 409), `FOR UPDATE` e
      `version_id_col` do ORM cobrindo a corrida;
    - grava `category_override`, define `classification_confidence = 'ALTA'` e
      incrementa `version`; as colunas da REGRA (`equipment_*`,
      `classification_rule*`) ficam intactas (o motor nunca escreve o
      override e nunca reclassifica um bem que o tenha; o override prevalece);
    - auditoria `ASSET_CATEGORY_OVERRIDDEN` na MESMA transação (valores
      anteriores/novos de categoria, confiança, regra e versão; sem segredos
      nem dado pessoal). Sem mudança real => nada é gravado nem auditado.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from app.models.assets import Asset
from app.models.audit import AuditLog
from app.services.asset_classification import (
    CATEGORY_FAMILY,
    EQUIPMENT_CATEGORIES,
    EQUIPMENT_CATEGORY_LABELS,
    EQUIPMENT_FAMILY_LABELS,
    HIGH,
    effective_equipment_category,
)
from app.services.asset_service import (
    AssetConflictError,
    AssetNotFoundError,
    AssetVersionConflictError,
    asset_scope_clause,
)
from app.services.dashboard_equipment_service import (
    OVERRIDE_OPERATION,
    filter_where,
    review_clauses,
)
from app.services.dashboard_service import _active_assets, _unit_labels, clean_label
from app.services.pagination import page_count

logger = logging.getLogger(__name__)

ENTITY_TYPE = "asset"
EXPORT_ENTITY_TYPE = "dashboard_equipment_export"
OP_PANEL_EXPORTED = "DASHBOARD_EQUIPMENT_EXPORTED"
OP_REVIEW_EXPORTED = "DASHBOARD_REVIEW_QUEUE_EXPORTED"

_SORTS: dict[str, tuple[Any, ...]] = {
    "patrimony_number": (Asset.patrimony_number, Asset.id),
    "-patrimony_number": (Asset.patrimony_number.desc(), Asset.id),
    "description": (func.lower(func.coalesce(Asset.description, "")), Asset.id),
    "-description": (func.lower(func.coalesce(Asset.description, "")).desc(), Asset.id),
    "updated_at": (Asset.updated_at, Asset.id),
    "-updated_at": (Asset.updated_at.desc(), Asset.id),
}


def category_vocabulary() -> list[dict[str, str]]:
    """Vocabulário aceito pelo override (fonte única: o backend)."""
    return [
        {
            "id": c,
            "label": EQUIPMENT_CATEGORY_LABELS[c],
            "familia": CATEGORY_FAMILY[c],
            "familia_label": EQUIPMENT_FAMILY_LABELS[CATEGORY_FAMILY[c]],
        }
        for c in EQUIPMENT_CATEGORIES
    ]


# ---------------------------------------------------------------------------
# Fila de revisão
# ---------------------------------------------------------------------------


def _review_where(query: Any) -> tuple[Any, ...]:
    return (*filter_where(query), *review_clauses())


def _review_rows(db: Any, actor_id: Any, query: Any, *, offset: int, limit: int) -> list[Any]:
    return (
        _active_assets(
            db, actor_id, Asset.id, Asset.patrimony_number, Asset.description, Asset.unit_id,
            Asset.equipment_family, Asset.equipment_category, Asset.classification_confidence,
            Asset.classification_rule, Asset.version, where=_review_where(query),
        )
        .order_by(*_SORTS[query.sort])
        .offset(offset)
        .limit(limit)
        .all()
    )


def review_queue(db: Any, actor_id: Any, query: Any) -> dict[str, Any]:
    total = int(
        _active_assets(db, actor_id, func.count(Asset.id), where=_review_where(query)).scalar() or 0
    )
    rows = _review_rows(
        db, actor_id, query, offset=(query.page - 1) * query.page_size, limit=query.page_size
    )
    names = _unit_labels(db, sorted({r.unit_id for r in rows}, key=str))
    return {
        "items": [
            {
                "id": str(r.id),
                "patrimony_number": r.patrimony_number,
                "description": clean_label(r.description),
                "unit_id": str(r.unit_id),
                "unidade": names[r.unit_id],
                "equipment_family": r.equipment_family,
                "equipment_category": r.equipment_category,
                "classification_confidence": r.classification_confidence,
                "classification_rule": r.classification_rule,
                "version": int(r.version),
            }
            for r in rows
        ],
        "total": total,
        "page": query.page,
        "page_size": query.page_size,
        "pages": page_count(total, query.page_size),
        "categorias": category_vocabulary(),
    }


# ---------------------------------------------------------------------------
# Override manual
# ---------------------------------------------------------------------------


def _view(asset: Asset) -> dict[str, Any]:
    effective = effective_equipment_category(asset)
    return {
        "id": str(asset.id),
        "patrimony_number": asset.patrimony_number,
        "category_override": asset.category_override,
        "equipment_category": asset.equipment_category,
        "categoria_efetiva": effective,
        "familia_efetiva": CATEGORY_FAMILY.get(effective) if effective else None,
        "classification_confidence": asset.classification_confidence,
        "version": int(asset.version),
    }


def override_category(
    db: Any, actor_id: Any, asset_id: uuid.UUID, category: str, version: int,
    *, request_id: str | None = None,
) -> dict[str, Any]:
    """Aplica o override do ADM (ver docstring do módulo)."""
    asset = (
        db.query(Asset)
        .filter(Asset.id == asset_id, Asset.deleted_at.is_(None), asset_scope_clause(actor_id, db))
        .with_for_update()
        .first()
    )
    if asset is None:
        raise AssetNotFoundError()
    if asset.version != version:
        raise AssetVersionConflictError()
    if asset.category_override == category and asset.classification_confidence == HIGH:
        return _view(asset)  # já está assim: nada a gravar nem auditar
    previous = {
        "category_override": asset.category_override,
        "effective_category": effective_equipment_category(asset),
        "equipment_category": asset.equipment_category,
        "classification_confidence": asset.classification_confidence,
        "classification_rule": asset.classification_rule,
        "version": int(asset.version),
    }
    asset.category_override = category
    asset.classification_confidence = HIGH
    asset.updated_by = actor_id
    asset.version = asset.version + 1
    try:
        db.flush()
    except StaleDataError as exc:
        db.rollback()
        raise AssetVersionConflictError() from exc
    except IntegrityError as exc:
        logger.warning("category_override: violação de integridade (%s).", exc.__class__.__name__)
        db.rollback()
        raise AssetConflictError() from exc
    db.add(
        AuditLog(
            id=uuid.uuid4(),
            actor_user_id=actor_id,
            entity_type=ENTITY_TYPE,
            entity_id=str(asset.id),
            operation=OVERRIDE_OPERATION,
            previous_values=previous,
            new_values={
                "category_override": category,
                "effective_category": category,
                "effective_family": CATEGORY_FAMILY[category],
                "classification_confidence": HIGH,
                "version": int(asset.version),
            },
            request_id=request_id,
            result="SUCESSO",
        )
    )
    return _view(asset)


# ---------------------------------------------------------------------------
# Exportação (CSV/XLSX via `csv_safety`, auditada na MESMA transação)
# ---------------------------------------------------------------------------


def _export_result(db, actor_id, header, table, fmt, *, sheet, slug, operation, entity_id,
                   filter_names, request_id):
    from app.services import report_export as export
    from app.services.report_catalog import MAX_EXPORT_ROWS
    from app.services.report_service import ExportResult, ReportTooLargeError

    if len(table) > MAX_EXPORT_ROWS:
        raise ReportTooLargeError()
    if fmt == "xlsx":
        content, mimetype = export.to_xlsx_bytes(header, table, sheet_name=sheet), export.XLSX_MIMETYPE
    else:
        content, mimetype = export.to_csv_bytes(header, table), export.CSV_MIMETYPE
    db.add(
        AuditLog(
            id=uuid.uuid4(),
            actor_user_id=actor_id,
            entity_type=EXPORT_ENTITY_TYPE,
            entity_id=entity_id,
            operation=operation,
            previous_values=None,
            new_values={"format": fmt, "rows": len(table), "filters": filter_names},
            request_id=request_id,
            result="SUCESSO",
        )
    )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ExportResult(content, mimetype, f"sispat-{slug}-{stamp}.{fmt}", len(table))


def export_panel_table(
    db, actor_id, roles, panel_id: Any, query: Any, *, request_id: str | None = None
):
    """Tabela de unidade x categoria (painéis `exportable`) em CSV/XLSX."""
    from app.services.dashboard_equipment_service import (
        EXPORT_TABLES,
        PanelNotFoundError,
        panel_data,
    )

    if panel_id not in EXPORT_TABLES:
        raise PanelNotFoundError()
    dados = panel_data(db, actor_id, roles, panel_id, query)["dados"]  # autoriza pelo perfil
    columns = dados["colunas"]
    header = ["Unidade", *[c["label"] for c in columns], "Total"]
    table = [
        [row["unidade"], *[str(row["valores"][c["id"]]) for c in columns], str(row["total"])]
        for row in dados["linhas"]
    ]
    return _export_result(
        db, actor_id, header, table, query.format, sheet="Equipamentos", slug=panel_id.replace("_", "-"),
        operation=OP_PANEL_EXPORTED, entity_id=panel_id, filter_names=query.active_names(),
        request_id=request_id,
    )


def export_review_queue(db, actor_id, query: Any, *, request_id: str | None = None):
    from app.services.report_catalog import MAX_EXPORT_ROWS

    rows = _review_rows(db, actor_id, query, offset=0, limit=MAX_EXPORT_ROWS + 1)
    names = _unit_labels(db, sorted({r.unit_id for r in rows}, key=str))
    header = ["Patrimônio", "Descrição", "Unidade", "Família sugerida", "Categoria sugerida",
              "Confiança", "Regra"]
    table = [
        [
            r.patrimony_number,
            clean_label(r.description),
            names[r.unit_id],
            EQUIPMENT_FAMILY_LABELS.get(r.equipment_family or "", ""),
            EQUIPMENT_CATEGORY_LABELS.get(r.equipment_category or "", ""),
            r.classification_confidence or "",
            r.classification_rule or "",
        ]
        for r in rows
    ]
    return _export_result(
        db, actor_id, header, table, query.format, sheet="Revisao", slug="revisao-classificacao",
        operation=OP_REVIEW_EXPORTED, entity_id="unclassified_review",
        filter_names=["unit_id"] if query.unit_id is not None else [],
        request_id=request_id,
    )
