"""Consultas (repositório) dos relatórios exportáveis -- somente leitura.

Cada função devolve `(total, linhas)`; `linhas` é uma lista de `dict` indexados
pela `key` das colunas de `report_catalog` e SÓ contém as colunas permitidas
ao perfil. Quando `total > limit` nenhuma linha é carregada (o serviço responde
413): nunca há truncamento silencioso.

Regras comuns:
- Escopo de unidade SEMPRE no banco (`asset_scope_clause`/`apply_unit_scope`/
  `get_accessible_unit_ids`); escopo vazio => nenhuma linha.
- Ordenação e filtros por ALLOWLIST (mapas abaixo); valores só como parâmetros.
- Exclusão lógica: bens com `deleted_at` ficam FORA, salvo `include_deleted`
  (decidido pelo chamador; só ADM).
- Perfil RH: colunas de texto livre (`notes`, `reason`) NEM são consultadas.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, aliased

from app.authorization.rbac import apply_unit_scope, get_accessible_unit_ids
from app.models.assets import Asset, AssetMovement
from app.models.inventory import Inventory, InventoryItem
from app.models.people import ResponsiblePerson
from app.models.units import Location, Room, Unit
from app.services.asset_service import (
    asset_filter_clauses, asset_scope_clause, asset_search_clause,
)
from app.services.import_normalizer import normalize_bond_status
from app.services.inventory_service import item_result_expr
from app.services.local_dates import local_day_end_exclusive_utc, local_day_start_utc
from app.services.report_export import utc_iso


@dataclass(frozen=True)
class AssetFilters:
    q: str | None = None
    unit_id: uuid.UUID | None = None
    owner_unit_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    responsible_person_id: uuid.UUID | None = None
    located: str | None = None
    bond: str | None = None  # vínculo (somente leitura; ver `bond_status`)

    @property
    def bond_status(self) -> str | None:
        """Nome esperado por `asset_filter_clauses` (filtro, nunca gravação)."""
        return self.bond


@dataclass(frozen=True)
class MovementFilters:
    status: str | None = None
    movement_type: str | None = None
    origin_unit_id: uuid.UUID | None = None
    destination_unit_id: uuid.UUID | None = None
    created_from: str | None = None
    created_to: str | None = None


@dataclass(frozen=True)
class InventoryItemFilters:
    inventory_id: uuid.UUID | None = None
    unit_id: uuid.UUID | None = None
    inventory_status: str | None = None
    result: str | None = None
    checked_from: str | None = None
    checked_to: str | None = None


def _name(value: Any) -> str:
    return "" if value is None else str(value)


def _order(mapping: dict[str, tuple[Any, ...]], key: str) -> tuple[Any, ...]:
    """Ordenação por ALLOWLIST: chave fora do mapa nunca chega ao SQL (KeyError)."""
    return mapping[key]


# ---------------------------------------------------------------------------
# Patrimônios
# ---------------------------------------------------------------------------


def _asset_sorts() -> dict[str, tuple[Any, ...]]:
    desc = func.lower(func.coalesce(Asset.description, ""))
    bond = func.lower(func.coalesce(Asset.bond_status, ""))
    return {
        "patrimony_number": (Asset.patrimony_number, Asset.id),
        "-patrimony_number": (Asset.patrimony_number.desc(), Asset.id),
        "description": (desc, Asset.id),
        "-description": (desc.desc(), Asset.id),
        "created_at": (Asset.created_at, Asset.id),
        "-created_at": (Asset.created_at.desc(), Asset.id),
        "updated_at": (Asset.updated_at, Asset.id),
        "-updated_at": (Asset.updated_at.desc(), Asset.id),
        "bond_status": (bond, Asset.patrimony_number, Asset.id),
        "-bond_status": (bond.desc(), Asset.patrimony_number, Asset.id),
    }


def fetch_assets(
    db: Session, actor_id: Any, flt: AssetFilters, *, sort: str, include_deleted: bool,
    can_view_internal: bool, limit: int,
) -> tuple[int, list[dict[str, str]]]:
    where: list[Any] = [asset_scope_clause(actor_id, db), *asset_filter_clauses(flt)]
    if not include_deleted:
        where.append(Asset.deleted_at.is_(None))
    # Mesma busca da tela /assets (paridade tela x exportação); só adiciona
    # restrição AND ao escopo de unidade já aplicado acima.
    search = asset_search_clause(flt.q) if flt.q else None
    if search is not None:
        where.append(search)
    total = int(db.execute(select(func.count(Asset.id)).where(*where)).scalar_one())
    if total > limit:
        return total, []
    owner = aliased(Unit)
    columns = [
        Asset.patrimony_number, Asset.description, Asset.bond_status, Unit.code, Unit.name,
        owner.code, Room.name, Location.name, ResponsiblePerson.name, Asset.located,
        Asset.registration_date, Asset.created_at, Asset.updated_at, Asset.deleted_at,
    ]
    if can_view_internal:
        columns.append(Asset.notes)
    stmt = (
        select(*columns)
        .select_from(Asset)
        .join(Unit, Unit.id == Asset.unit_id)
        .outerjoin(owner, owner.id == Asset.owner_unit_id)
        .outerjoin(Room, Room.id == Asset.room_id)
        .outerjoin(Location, Location.id == Asset.location_id)
        .outerjoin(ResponsiblePerson, ResponsiblePerson.id == Asset.responsible_person_id)
        .where(*where)
        .order_by(*_order(_asset_sorts(), sort))
        .limit(limit)
    )
    rows = []
    for r in db.execute(stmt).all():
        row = {
            "patrimony_number": r[0], "description": _name(r[1]),
            "bond_status": _name(normalize_bond_status(r[2])), "unit_code": r[3], "unit_name": r[4],
            "owner_unit_code": _name(r[5]), "room": _name(r[6]), "location": _name(r[7]),
            "responsible": _name(r[8]), "located": r[9], "registration_date": utc_iso(r[10]),
            "created_at": utc_iso(r[11]), "updated_at": utc_iso(r[12]), "deleted_at": utc_iso(r[13]),
        }
        if can_view_internal:
            row["notes"] = _name(r[14])
        rows.append(row)
    return total, rows


# ---------------------------------------------------------------------------
# Movimentações
# ---------------------------------------------------------------------------


def _movement_sorts() -> dict[str, tuple[Any, ...]]:
    return {
        "created_at": (AssetMovement.created_at, AssetMovement.id),
        "-created_at": (AssetMovement.created_at.desc(), AssetMovement.id),
        "status": (AssetMovement.status, AssetMovement.created_at.desc(), AssetMovement.id),
        "-status": (AssetMovement.status.desc(), AssetMovement.created_at.desc(), AssetMovement.id),
    }


def fetch_movements(
    db: Session, actor_id: Any, flt: MovementFilters, *, sort: str, include_deleted: bool,
    can_view_internal: bool, limit: int,
) -> tuple[int, list[dict[str, str]]]:
    accessible = get_accessible_unit_ids(actor_id, db)
    ids = sorted(accessible, key=str)
    if not ids:
        return 0, []
    where: list[Any] = [or_(
        AssetMovement.origin_unit_id.in_(ids), AssetMovement.destination_unit_id.in_(ids)
    )]
    if not include_deleted:
        where.append(Asset.deleted_at.is_(None))
    for field in ("status", "movement_type", "origin_unit_id", "destination_unit_id"):
        value = getattr(flt, field)
        if value is not None:
            where.append(getattr(AssetMovement, field) == value)
    if flt.created_from:
        where.append(AssetMovement.created_at >= local_day_start_utc(flt.created_from))
    if flt.created_to:
        where.append(AssetMovement.created_at < local_day_end_exclusive_utc(flt.created_to))
    total = int(db.execute(
        select(func.count(AssetMovement.id)).join(Asset, Asset.id == AssetMovement.asset_id).where(*where)
    ).scalar_one())
    if total > limit:
        return total, []
    origin_unit, dest_unit = aliased(Unit), aliased(Unit)
    origin_room, dest_room = aliased(Room), aliased(Room)
    prev_person, new_person = aliased(ResponsiblePerson), aliased(ResponsiblePerson)
    columns = [
        Asset.patrimony_number, Asset.description, AssetMovement.movement_type, AssetMovement.status,
        origin_unit.code, origin_unit.name, origin_room.name, prev_person.name, dest_unit.code,
        dest_unit.name, dest_room.name, new_person.name, AssetMovement.created_at,
        AssetMovement.approved_at, AssetMovement.completed_at, AssetMovement.origin_unit_id,
    ]
    if can_view_internal:
        columns.append(AssetMovement.reason)
    stmt = (
        select(*columns)
        .select_from(AssetMovement)
        .join(Asset, Asset.id == AssetMovement.asset_id)
        .join(origin_unit, origin_unit.id == AssetMovement.origin_unit_id)
        .join(dest_unit, dest_unit.id == AssetMovement.destination_unit_id)
        .outerjoin(origin_room, origin_room.id == AssetMovement.origin_room_id)
        .outerjoin(dest_room, dest_room.id == AssetMovement.destination_room_id)
        .outerjoin(prev_person, prev_person.id == AssetMovement.previous_responsible_id)
        .outerjoin(new_person, new_person.id == AssetMovement.new_responsible_id)
        .where(*where)
        .order_by(*_order(_movement_sorts(), sort))
        .limit(limit)
    )
    rows = []
    for r in db.execute(stmt).all():
        # SEC-MOV-01: dados da ORIGEM (sala, responsável anterior, motivo) só com escopo na origem.
        origin_in_scope = r[15] in accessible
        row = {
            "patrimony_number": r[0], "asset_description": _name(r[1]), "movement_type": r[2],
            "status": r[3], "origin_unit": f"{r[4]} - {r[5]}",
            "origin_room": _name(r[6]) if origin_in_scope else "",
            "previous_responsible": _name(r[7]) if origin_in_scope else "",
            "destination_unit": f"{r[8]} - {r[9]}", "destination_room": _name(r[10]),
            "new_responsible": _name(r[11]), "created_at": utc_iso(r[12]),
            "approved_at": utc_iso(r[13]), "completed_at": utc_iso(r[14]),
        }
        if can_view_internal:
            row["reason"] = _name(r[16]) if origin_in_scope else ""
        rows.append(row)
    return total, rows


# ---------------------------------------------------------------------------
# Inventários (itens conferidos)
# ---------------------------------------------------------------------------


def _item_sorts(result: Any) -> dict[str, tuple[Any, ...]]:
    return {
        "checked_at": (InventoryItem.checked_at, InventoryItem.id),
        "-checked_at": (InventoryItem.checked_at.desc(), InventoryItem.id),
        "patrimony_number": (Asset.patrimony_number, InventoryItem.id),
        "-patrimony_number": (Asset.patrimony_number.desc(), InventoryItem.id),
        "result": (result, Asset.patrimony_number, InventoryItem.id),
        "-result": (result.desc(), Asset.patrimony_number, InventoryItem.id),
    }


def fetch_inventory_items(
    db: Session, actor_id: Any, flt: InventoryItemFilters, *, sort: str, include_deleted: bool,
    can_view_internal: bool, limit: int,
) -> tuple[int, list[dict[str, str]]]:
    result = item_result_expr()
    where: list[Any] = []
    if not include_deleted:
        where.append(Asset.deleted_at.is_(None))
    if flt.inventory_id is not None:
        where.append(Inventory.id == flt.inventory_id)
    if flt.unit_id is not None:
        where.append(Inventory.unit_id == flt.unit_id)
    if flt.inventory_status is not None:
        where.append(Inventory.status == flt.inventory_status)
    if flt.result is not None:
        where.append(result == flt.result)
    if flt.checked_from:
        where.append(InventoryItem.checked_at >= local_day_start_utc(flt.checked_from))
    if flt.checked_to:
        where.append(InventoryItem.checked_at < local_day_end_exclusive_utc(flt.checked_to))

    def scoped(stmt: Any) -> Any:
        stmt = stmt.select_from(InventoryItem).join(
            Inventory, Inventory.id == InventoryItem.inventory_id
        ).join(Asset, Asset.id == InventoryItem.asset_id)
        return apply_unit_scope(stmt, Inventory.unit_id, actor_id, db).where(*where)

    total = int(db.execute(scoped(select(func.count(InventoryItem.id)))).scalar_one())
    if total > limit:
        return total, []
    registered, observed = aliased(Location), aliased(Location)
    columns = [
        Inventory.name, Inventory.status, Unit.code, Asset.patrimony_number, Asset.description,
        result.label("result"), registered.name, observed.name, InventoryItem.checked_at,
    ]
    if can_view_internal:
        columns.append(InventoryItem.notes)
    stmt = (
        scoped(select(*columns))
        .join(Unit, Unit.id == Inventory.unit_id)
        .outerjoin(registered, registered.id == Asset.location_id)
        .outerjoin(observed, observed.id == InventoryItem.observed_location_id)
        .order_by(*_order(_item_sorts(result), sort))
        .limit(limit)
    )
    rows = []
    for r in db.execute(stmt).all():
        row = {
            "inventory_name": r[0], "inventory_status": r[1], "unit_code": r[2],
            "patrimony_number": r[3], "asset_description": _name(r[4]), "result": r[5],
            "registered_location": _name(r[6]), "observed_location": _name(r[7]),
            "checked_at": utc_iso(r[8]),
        }
        if can_view_internal:
            row["notes"] = _name(r[9])
        rows.append(row)
    return total, rows


__all__ = [
    "AssetFilters", "InventoryItemFilters", "MovementFilters",
    "fetch_assets", "fetch_inventory_items", "fetch_movements",
]
