"""Inventários (campanhas de conferência física por unidade) e seus itens.

ESTADOS (allowlist, `inventories.status`): ABERTO -> EM_ANDAMENTO -> CONCLUIDO;
ABERTO | EM_ANDAMENTO -> CANCELADO. CONCLUIDO e CANCELADO são terminais e IMUTÁVEIS
(guardas ORM abaixo); conferências só entram em EM_ANDAMENTO.

CONFERÊNCIA: 1 por bem por inventário (`uq_inventory_items_inventory_asset`); repetir =>
409 `already_checked` (sem reconferência; mudar a política exige migração). O bem precisa
ser da unidade do inventário e não estar excluído; senão => 404 uniforme. O conferidor é
sempre o usuário autenticado. Resultado: `found` + `observed_location_id`; DIVERGENTE é
derivado (encontrado em local diferente do cadastrado), NUNCA vindo do cliente.

DECISÃO `assets.located`: a matriz não define que a conferência atualiza o bem; portanto
NENHUM bem é alterado por este módulo (a conferência é evidência registrada). Pendência
institucional registrada em `docs/architecture/inventories-api.md`.

ESCOPO: unidade do inventário no escopo do ator; inexistente/malformado/alheio => mesma 404.
AUDITORIA: `AuditLog` na MESMA transação, só ids/estados/contagens (sem observações).
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import and_, case, event, func, inspect, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.authorization.rbac import apply_unit_scope
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.inventory import Inventory, InventoryItem
from app.models.units import Location, Unit
from app.services.pagination import page_count
from app.security.text_search import contains_ci
from app.services.catalog_service import _iso, _parse_uuid

logger = logging.getLogger(__name__)

ENTITY_INVENTORY = "inventory"
ENTITY_ITEM = "inventory_item"
OP_CREATED = "INVENTORY_CREATED"
OP_STARTED = "INVENTORY_STARTED"
OP_CLOSED = "INVENTORY_CLOSED"
OP_CANCELLED = "INVENTORY_CANCELLED"
OP_ITEM_CHECKED = "INVENTORY_ITEM_CHECKED"

OPEN, IN_PROGRESS, DONE, CANCELLED = "ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"
TRANSITIONS: dict[str, frozenset[str]] = {
    OPEN: frozenset({IN_PROGRESS, CANCELLED}),
    IN_PROGRESS: frozenset({DONE, CANCELLED}),
}
_ZERO_UUID = uuid.UUID(int=0)
_IMMUTABLE_COLUMNS = ("id", "name", "unit_id", "start_date", "created_by", "created_at")

_SORTS = {
    "created_at": (Inventory.created_at, Inventory.id),
    "-created_at": (Inventory.created_at.desc(), Inventory.id),
    "name": (func.lower(Inventory.name), Inventory.id),
    "-name": (func.lower(Inventory.name).desc(), Inventory.id),
    "start_date": (Inventory.start_date, Inventory.id),
    "-start_date": (Inventory.start_date.desc(), Inventory.id),
    "status": (Inventory.status, Inventory.created_at.desc(), Inventory.id),
    "-status": (Inventory.status.desc(), Inventory.created_at.desc(), Inventory.id),
}


# ---------------------------------------------------------------------------
# Guardas de imutabilidade (ORM)
# ---------------------------------------------------------------------------


@event.listens_for(Inventory, "before_update")
def _guard_inventory_update(_mapper, _connection, target: Inventory) -> None:  # pragma: no cover
    state = inspect(target)
    for name in _IMMUTABLE_COLUMNS:
        if state.attrs[name].history.has_changes():
            raise RuntimeError("inventories: dados da campanha são imutáveis.")
    hist = state.attrs.status.history
    if hist.has_changes():
        old = hist.deleted[0] if hist.deleted else None
        new = hist.added[0] if hist.added else None
        if new not in TRANSITIONS.get(old, frozenset()):
            raise RuntimeError("inventories: transição de estado inválida.")
    elif any(state.attrs[n].history.has_changes() for n in ("closed_at", "end_date")):
        raise RuntimeError("inventories: encerramento só acompanha mudança de estado.")


@event.listens_for(Inventory, "before_delete")
def _guard_inventory_delete(_mapper, _connection, _target) -> None:  # pragma: no cover
    raise RuntimeError("inventories: exclusão proibida.")


@event.listens_for(InventoryItem, "before_update")
def _guard_item_update(_mapper, _connection, _target) -> None:  # pragma: no cover
    raise RuntimeError("inventory_items: conferência é imutável.")


@event.listens_for(InventoryItem, "before_delete")
def _guard_item_delete(_mapper, _connection, _target) -> None:  # pragma: no cover
    raise RuntimeError("inventory_items: exclusão proibida.")


# ---------------------------------------------------------------------------
# Erros de domínio
# ---------------------------------------------------------------------------


class InventoryError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class InventoryNotFoundError(InventoryError):
    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


class InventoryInvalidTransitionError(InventoryError):
    status_code = 409
    code = "invalid_transition"
    message = "Transição de estado não permitida para o inventário."


class InventoryClosedError(InventoryError):
    status_code = 409
    code = "inventory_closed"
    message = "O inventário está encerrado e não aceita conferências."


class InventoryNotStartedError(InventoryError):
    status_code = 409
    code = "inventory_not_started"
    message = "O inventário ainda não foi iniciado."


class AlreadyCheckedError(InventoryError):
    status_code = 409
    code = "already_checked"
    message = "O bem já foi conferido neste inventário."


class InventoryUnitInactiveError(InventoryError):
    status_code = 409
    code = "unit_inactive"
    message = "A unidade está inativa."


class InventoryLinkInactiveError(InventoryError):
    status_code = 409
    code = "link_inactive"
    message = "O local informado está inativo."


class InventoryConflictError(InventoryError):
    status_code = 409
    code = "conflict"
    message = "Conflito ao registrar o inventário."


# ---------------------------------------------------------------------------
# Serviço
# ---------------------------------------------------------------------------


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _result_expr():
    divergent = and_(
        InventoryItem.found.is_(True),
        InventoryItem.observed_location_id.is_not(None),
        or_(Asset.location_id.is_(None), Asset.location_id != InventoryItem.observed_location_id),
    )
    return case(
        (InventoryItem.found.is_(False), "NAO_ENCONTRADO"),
        (divergent, "DIVERGENTE"),
        else_="ENCONTRADO",
    )


# Expressão pública do resultado derivado (reutilizada pelos relatórios).
item_result_expr = _result_expr


class InventoryService:
    def __init__(self, db: Session, *, request_id: str | None = None) -> None:
        self._db = db
        self._request_id = request_id

    # -- infraestrutura ------------------------------------------------------

    def _load(self, actor_id: Any, inventory_id: uuid.UUID, *, for_update: bool = False) -> Inventory:
        query = apply_unit_scope(
            self._db.query(Inventory).filter(Inventory.id == inventory_id),
            Inventory.unit_id, actor_id, self._db,
        )
        if for_update:
            query = query.with_for_update()
        inventory = query.first()
        if inventory is None:
            raise InventoryNotFoundError()
        return inventory

    def _audit(self, entity_type: str, entity_id: Any, operation: str, actor_id: Any,
               previous: dict[str, Any] | None, new: dict[str, Any] | None) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(), actor_user_id=actor_id, entity_type=entity_type,
                entity_id=str(entity_id), operation=operation, previous_values=previous,
                new_values=new, request_id=self._request_id, result="SUCESSO",
            )
        )

    def _flush(self, *, on_conflict: type[InventoryError] = InventoryConflictError) -> None:
        try:
            self._db.flush()
        except IntegrityError as exc:
            logger.warning("inventory_service: violação de integridade (%s).", exc.__class__.__name__)
            self._db.rollback()
            raise on_conflict() from exc

    def _asset_total(self, inventory: Inventory) -> int:
        return int(self._db.execute(
            select(func.count(Asset.id)).where(
                Asset.unit_id == inventory.unit_id, Asset.deleted_at.is_(None)
            )
        ).scalar_one())

    # -- serialização --------------------------------------------------------

    def _serialize(self, rows: list[Inventory]) -> list[dict[str, Any]]:
        unit_ids = {r.unit_id for r in rows}
        units: dict[Any, dict[str, Any]] = {}
        if unit_ids:
            for u in self._db.execute(
                select(Unit.id, Unit.code, Unit.name).where(Unit.id.in_(sorted(unit_ids, key=str)))
            ):
                units[u.id] = {"id": str(u.id), "code": u.code, "name": u.name}
        return [
            {
                "id": str(r.id), "name": r.name, "unit_id": str(r.unit_id), "unit": units.get(r.unit_id),
                "start_date": r.start_date.isoformat() if r.start_date else None,
                "end_date": r.end_date.isoformat() if r.end_date else None,
                "status": r.status, "created_by": str(r.created_by),
                "created_at": _iso(r.created_at), "closed_at": _iso(r.closed_at),
            }
            for r in rows
        ]

    @staticmethod
    def _serialize_item(item: InventoryItem, asset: Asset, result: str) -> dict[str, Any]:
        return {
            "id": str(item.id),
            "inventory_id": str(item.inventory_id),
            "asset": {"id": str(asset.id), "patrimony_number": asset.patrimony_number,
                      "description": asset.description, "deleted": asset.deleted_at is not None},
            "found": item.found,
            "result": result,
            "registered_location_id": str(asset.location_id) if asset.location_id else None,
            "observed_location_id": str(item.observed_location_id) if item.observed_location_id else None,
            "checked_by": str(item.checked_by) if item.checked_by else None,
            "checked_at": _iso(item.checked_at),
            "notes": item.notes,
        }

    # -- leitura -------------------------------------------------------------

    def list(self, actor_id: Any, query: Any) -> dict[str, Any]:
        scoped = apply_unit_scope(self._db.query(Inventory), Inventory.unit_id, actor_id, self._db)
        if query.unit_id is not None:
            scoped = scoped.filter(Inventory.unit_id == query.unit_id)
        if query.status:
            scoped = scoped.filter(Inventory.status == query.status)
        if query.q:
            scoped = scoped.filter(
                contains_ci(Inventory.name, query.q)
            )
        total = scoped.with_entities(func.count(Inventory.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size).limit(query.page_size).all()
        )
        return {"total": int(total), "page": query.page, "page_size": query.page_size, "pages": page_count(total, query.page_size),
                "inventories": self._serialize(list(rows))}

    def get(self, actor_id: Any, inventory_id: uuid.UUID) -> dict[str, Any]:
        return self._serialize([self._load(actor_id, inventory_id)])[0]

    def summary(self, actor_id: Any, inventory_id: uuid.UUID) -> dict[str, Any]:
        inventory = self._load(actor_id, inventory_id)
        total = self._asset_total(inventory)
        result = _result_expr()
        rows = self._db.execute(
            select(result.label("result"), func.count(InventoryItem.id))
            .select_from(InventoryItem)
            .join(Asset, Asset.id == InventoryItem.asset_id)
            .where(InventoryItem.inventory_id == inventory.id)
            .group_by(result)
        ).all()
        counts = {name: int(n) for name, n in rows}
        found = counts.get("ENCONTRADO", 0)
        not_found = counts.get("NAO_ENCONTRADO", 0)
        divergent = counts.get("DIVERGENTE", 0)
        checked = found + not_found + divergent
        return {
            "inventory_id": str(inventory.id),
            "status": inventory.status,
            "total_assets": total,
            "checked": checked,
            "pending": max(total - checked, 0),
            "found": found,
            "not_found": not_found,
            "divergent": divergent,
            "progress_percent": round(100 * checked / total, 1) if total else 0.0,
        }

    def list_items(self, actor_id: Any, inventory_id: uuid.UUID, query: Any) -> dict[str, Any]:
        inventory = self._load(actor_id, inventory_id)
        result = _result_expr()
        base = (
            select(InventoryItem, Asset, result.label("result"))
            .join(Asset, Asset.id == InventoryItem.asset_id)
            .where(InventoryItem.inventory_id == inventory.id)
        )
        if query.result:
            base = base.where(result == query.result)
        total = self._db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
        order = InventoryItem.checked_at.desc() if query.sort == "-checked_at" else InventoryItem.checked_at
        rows = self._db.execute(
            base.order_by(order, InventoryItem.id)
            .offset((query.page - 1) * query.page_size).limit(query.page_size)
        ).all()
        return {"total": int(total), "page": query.page, "page_size": query.page_size, "pages": page_count(total, query.page_size),
                "items": [self._serialize_item(i, a, r) for i, a, r in rows]}

    # -- escrita -------------------------------------------------------------

    def create(self, actor_id: Any, body: Any) -> dict[str, Any]:
        parsed = _parse_uuid(body.unit_id)
        unit = apply_unit_scope(
            self._db.query(Unit).filter(Unit.id == (parsed or _ZERO_UUID)), Unit.id, actor_id, self._db
        ).first()
        if unit is None or parsed is None:
            raise InventoryNotFoundError()
        if not unit.active:
            raise InventoryUnitInactiveError()
        inventory = Inventory(
            id=uuid.uuid4(), name=body.name, unit_id=unit.id,
            start_date=date.fromisoformat(body.start_date) if body.start_date else _today(),
            status=OPEN, created_by=actor_id, created_at=datetime.now(timezone.utc),
        )
        self._db.add(inventory)
        self._flush()
        self._audit(ENTITY_INVENTORY, inventory.id, OP_CREATED, actor_id, None,
                    {"unit_id": str(unit.id), "status": OPEN})
        return self._serialize([inventory])[0]

    def _move(self, actor_id: Any, inventory_id: uuid.UUID, target: str, operation: str, body: Any,
              *, terminal: bool) -> dict[str, Any]:
        inventory = self._load(actor_id, inventory_id, for_update=True)
        if target not in TRANSITIONS.get(inventory.status, frozenset()):
            raise InventoryInvalidTransitionError()
        previous = inventory.status
        new: dict[str, Any] = {"status": target, "has_reason": bool(body.reason)}
        if target == DONE:
            new["total_assets"] = self._asset_total(inventory)
        if terminal:
            inventory.closed_at = datetime.now(timezone.utc)
            inventory.end_date = _today()
        inventory.status = target
        self._flush()
        self._audit(ENTITY_INVENTORY, inventory.id, operation, actor_id, {"status": previous}, new)
        return self._serialize([inventory])[0]

    def start(self, actor_id: Any, inventory_id: uuid.UUID, body: Any) -> dict[str, Any]:
        return self._move(actor_id, inventory_id, IN_PROGRESS, OP_STARTED, body, terminal=False)

    def close(self, actor_id: Any, inventory_id: uuid.UUID, body: Any) -> dict[str, Any]:
        return self._move(actor_id, inventory_id, DONE, OP_CLOSED, body, terminal=True)

    def cancel(self, actor_id: Any, inventory_id: uuid.UUID, body: Any) -> dict[str, Any]:
        return self._move(actor_id, inventory_id, CANCELLED, OP_CANCELLED, body, terminal=True)

    def check_item(self, actor_id: Any, inventory_id: uuid.UUID, body: Any) -> dict[str, Any]:
        inventory = self._load(actor_id, inventory_id, for_update=True)
        if inventory.status in (DONE, CANCELLED):
            raise InventoryClosedError()
        if inventory.status != IN_PROGRESS:
            raise InventoryNotStartedError()
        asset_id = _parse_uuid(body.asset_id)
        asset = self._db.query(Asset).filter(
            Asset.id == (asset_id or _ZERO_UUID), Asset.unit_id == inventory.unit_id,
            Asset.deleted_at.is_(None),
        ).first()
        if asset is None or asset_id is None:
            raise InventoryNotFoundError()
        observed_id = None
        if body.observed_location_id is not None:
            loc_id = _parse_uuid(body.observed_location_id)
            loc = self._db.query(Location).filter(
                Location.id == (loc_id or _ZERO_UUID), Location.unit_id == inventory.unit_id
            ).first()
            if loc is None or loc_id is None:
                raise InventoryNotFoundError()
            if not loc.active:
                raise InventoryLinkInactiveError()
            observed_id = loc.id
        exists = self._db.execute(
            select(InventoryItem.id).where(
                InventoryItem.inventory_id == inventory.id, InventoryItem.asset_id == asset.id
            ).limit(1)
        ).first()
        if exists is not None:
            raise AlreadyCheckedError()
        item = InventoryItem(
            id=uuid.uuid4(), inventory_id=inventory.id, asset_id=asset.id, found=body.found,
            observed_location_id=observed_id, checked_by=actor_id,
            checked_at=datetime.now(timezone.utc), notes=body.notes,
        )
        self._db.add(item)
        self._flush(on_conflict=AlreadyCheckedError)
        if not body.found:
            result = "NAO_ENCONTRADO"
        elif observed_id is not None and observed_id != asset.location_id:
            result = "DIVERGENTE"
        else:
            result = "ENCONTRADO"
        self._audit(
            ENTITY_ITEM, item.id, OP_ITEM_CHECKED, actor_id, None,
            {"inventory_id": str(inventory.id), "asset_id": str(asset.id), "result": result,
             "observed_location_id": str(observed_id) if observed_id else None,
             "has_notes": body.notes is not None},
        )
        return self._serialize_item(item, asset, result)
