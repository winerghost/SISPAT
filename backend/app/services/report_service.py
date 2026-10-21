"""Relatórios e exportações CSV/XLSX (`/api/v1/reports`): orquestração.

Rotas finas em `app/api/v1/reports.py`; consultas em `report_repository`;
formatos em `report_export`; catálogo em `report_catalog`.

REGRAS
- Escopo de unidade sempre (ADM sem bypass). Unidade/inventário informado como
  filtro que seja alheio, inexistente ou malformado => `ReportNotFoundError`
  (MESMA 404, sem oráculo).
- Exclusão lógica respeitada: bens com `deleted_at` ficam fora; `include_deleted`
  só vale para ADM (a rota nega e audita os demais; aqui há defesa em profundidade).
- Perfil RH: colunas de texto livre (observações/motivo) não são consultadas.
- Limite de `MAX_EXPORT_ROWS` linhas; acima disso => 413 (`row_limit_exceeded`),
  nunca truncamento silencioso.
- AUDITORIA: `AuditLog` (`entity_type="report_export"`, `operation=
  "REPORT_EXPORTED"`) na MESMA transação da leitura, só com tipo, formato,
  contagem, ordenação e NOMES dos filtros usados (nunca valores, nunca conteúdo).
- Timestamps em UTC (ISO-8601).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.authorization.rbac import apply_unit_scope, units_outside_scope
from app.models.audit import AuditLog
from app.models.inventory import Inventory
from app.services import report_export as export
from app.services import report_repository as repo
from app.services.report_catalog import (
    EXPORT_FORMATS,
    MAX_EXPORT_ROWS,
    REPORTS,
    visible_columns,
)

ENTITY_TYPE = "report_export"
OP_EXPORTED = "REPORT_EXPORTED"
_FILTER_FIELDS = {
    "assets": ("q", "unit_id", "owner_unit_id", "room_id", "responsible_person_id", "located", "bond_status"),
    "movements": ("status", "movement_type", "origin_unit_id", "destination_unit_id",
                  "created_from", "created_to"),
    "inventory-items": ("inventory_id", "unit_id", "inventory_status", "result",
                        "checked_from", "checked_to"),
}


class ReportError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class ReportNotFoundError(ReportError):
    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


class ReportTooLargeError(ReportError):
    status_code = 413
    code = "row_limit_exceeded"
    message = (
        f"O relatório excede o limite de {MAX_EXPORT_ROWS} linhas. Refine os filtros e tente novamente."
    )


@dataclass(frozen=True)
class ExportResult:
    content: bytes
    mimetype: str
    filename: str
    rows: int


def _parse_uuid(raw: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


class ReportService:
    """`roles` vem do servidor (nunca do cliente)."""

    def __init__(self, db: Session, *, roles: set[str], request_id: str | None = None) -> None:
        self._db = db
        self._is_adm = "ADM" in roles
        self._can_view_internal = bool(roles & {"ADM", "USER"})  # RH: sem texto livre
        self._request_id = request_id

    # -- catálogo ------------------------------------------------------------

    def catalog(self) -> dict[str, Any]:
        reports = []
        for report in REPORTS.values():
            reports.append({
                "id": report.id,
                "title": report.title,
                "description": report.description,
                "export_path": f"/api/v1/reports/{report.id}/export",
                "formats": list(EXPORT_FORMATS),
                "columns": [{"key": c.key, "label": c.label}
                            for c in visible_columns(report, can_view_internal=self._can_view_internal)],
                "filters": list(report.filters),
                "sorts": list(report.sorts),
                "default_sort": report.default_sort,
                "include_deleted_allowed": report.supports_deleted and self._is_adm,
            })
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "max_rows": MAX_EXPORT_ROWS,
            "formats": list(EXPORT_FORMATS),
            "reports": reports,
        }

    # -- escopo dos filtros --------------------------------------------------

    def _scoped_unit(self, actor_id: Any, raw: Any) -> uuid.UUID | None:
        if raw is None:
            return None
        parsed = _parse_uuid(raw)
        if parsed is None or units_outside_scope(actor_id, [parsed], self._db):
            raise ReportNotFoundError()
        return parsed

    def _scoped_inventory(self, actor_id: Any, raw: Any) -> uuid.UUID | None:
        if raw is None:
            return None
        parsed = _parse_uuid(raw)
        found = None
        if parsed is not None:
            found = apply_unit_scope(
                self._db.query(Inventory.id).filter(Inventory.id == parsed), Inventory.unit_id,
                actor_id, self._db,
            ).first()
        if found is None:
            raise ReportNotFoundError()
        return parsed

    # -- exportação ----------------------------------------------------------

    def export(self, actor_id: Any, kind: str, query: Any) -> ExportResult:
        report = REPORTS.get(kind)
        if report is None:
            raise ReportNotFoundError()
        include_deleted = query.include_deleted == "true" and self._is_adm
        common = dict(
            sort=query.sort, include_deleted=include_deleted,
            can_view_internal=self._can_view_internal, limit=MAX_EXPORT_ROWS,
        )
        if kind == "assets":
            flt = repo.AssetFilters(
                q=query.q, unit_id=self._scoped_unit(actor_id, query.unit_id),
                owner_unit_id=self._scoped_unit(actor_id, query.owner_unit_id),
                room_id=query.room_id, responsible_person_id=query.responsible_person_id,
                located=query.located, bond=query.bond_status,
            )
            total, rows = repo.fetch_assets(self._db, actor_id, flt, **common)
        elif kind == "movements":
            flt = repo.MovementFilters(
                status=query.status, movement_type=query.movement_type,
                origin_unit_id=self._scoped_unit(actor_id, query.origin_unit_id),
                destination_unit_id=self._scoped_unit(actor_id, query.destination_unit_id),
                created_from=query.created_from, created_to=query.created_to,
            )
            total, rows = repo.fetch_movements(self._db, actor_id, flt, **common)
        else:
            flt = repo.InventoryItemFilters(
                inventory_id=self._scoped_inventory(actor_id, query.inventory_id),
                unit_id=self._scoped_unit(actor_id, query.unit_id),
                inventory_status=query.inventory_status, result=query.result,
                checked_from=query.checked_from, checked_to=query.checked_to,
            )
            total, rows = repo.fetch_inventory_items(self._db, actor_id, flt, **common)
        if total > MAX_EXPORT_ROWS:
            raise ReportTooLargeError()

        columns = visible_columns(report, can_view_internal=self._can_view_internal)
        if not include_deleted:
            columns = tuple(c for c in columns if c.key != "deleted_at")
        header = [c.label for c in columns]
        table = [[row.get(c.key, "") for c in columns] for row in rows]
        if query.format == "xlsx":
            content, mimetype = export.to_xlsx_bytes(header, table), export.XLSX_MIMETYPE
        else:
            content, mimetype = export.to_csv_bytes(header, table), export.CSV_MIMETYPE

        used = [name for name in _FILTER_FIELDS[kind] if getattr(query, name, None) is not None]
        self._db.add(
            AuditLog(
                id=uuid.uuid4(), actor_user_id=actor_id, entity_type=ENTITY_TYPE, entity_id=kind,
                operation=OP_EXPORTED, previous_values=None,
                new_values={
                    "report": kind, "format": query.format, "rows": len(rows), "sort": query.sort,
                    "filters": used, "include_deleted": include_deleted,
                },
                request_id=self._request_id, result="SUCESSO",
            )
        )
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return ExportResult(content, mimetype, f"sispat-{kind}-{stamp}.{query.format}", len(rows))
