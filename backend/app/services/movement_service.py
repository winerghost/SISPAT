"""Movimentações de bens (`asset_movements`): solicitar, aprovar, rejeitar, cancelar, ler.

Regra de negócio das rotas `/api/v1/movements` (rotas finas em `app/api/v1/movements.py`).

HISTÓRICO IMUTÁVEL: a movimentação nunca é apagada (o banco também bloqueia DELETE) e
seus dados (bem, origem, destino, tipo, solicitante, motivo, criação) nunca mudam. A
ÚNICA mutação permitida é a transição de estado de uma linha `PENDENTE` para um
estado terminal (`status` + campos de decisão), uma vez só; estados terminais não
mudam mais. Guardas ORM abaixo (`before_update`/`before_delete`) reforçam isso.

ESTADOS (allowlist): PENDENTE -> APROVADA | REJEITADA | CANCELADA. `CONCLUIDA` existe
no CHECK do banco mas não é usada: a aprovação aplica o bem na mesma transação e
grava `completed_at` junto de `approved_at`.

ESCOPO: bem visível pelo escopo da unidade ATUAL (origem). Destino precisa estar no
escopo do solicitante E do aprovador (decisão registrada: aprovar exige escopo sobre
origem e destino; ver matriz de permissões). Leitura: origem OU destino no escopo.
Alvo alheio/inexistente/malformado/bem excluído => `MovementNotFoundError` (mesma 404).

CONCORRÊNCIA: o bem é lido com `FOR UPDATE`; `asset_version` é conferido na
solicitação e na aprovação. Como a tabela não guarda a versão do bem, a aprovação
também confere o INSTANTÂNEO gravado na movimentação (unidade/sala/responsável de
origem): se o bem mudou desde a solicitação => 409 `version_conflict`.

AUDITORIA: `AuditLog` (`asset_movement`; na aprovação também `asset`/`ASSET_MOVED`) na
MESMA transação; só ids/estados. O texto livre do motivo da solicitação não é copiado.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import event, false, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.authorization.rbac import apply_unit_scope, get_accessible_unit_ids, units_outside_scope
from app.models.assets import Asset, AssetMovement
from app.models.audit import AuditLog
from app.models.people import ResponsiblePerson
from app.models.units import Location, Room, Unit
from app.services.asset_service import _Lookups, _iso, _parse_uuid

logger = logging.getLogger(__name__)

ENTITY_TYPE = "asset_movement"
OP_REQUESTED = "MOVEMENT_REQUESTED"
OP_APPROVED = "MOVEMENT_APPROVED"
OP_REJECTED = "MOVEMENT_REJECTED"
OP_CANCELLED = "MOVEMENT_CANCELLED"
OP_ASSET_MOVED = "ASSET_MOVED"

PENDING, APPROVED, REJECTED, CANCELLED = "PENDENTE", "APROVADA", "REJEITADA", "CANCELADA"
TRANSITIONS: dict[str, frozenset[str]] = {PENDING: frozenset({APPROVED, REJECTED, CANCELLED})}
TYPE_UNIT, TYPE_ROOM, TYPE_RESPONSIBLE = "TRANSFERENCIA_UNIDADE", "MUDANCA_SALA", "TROCA_RESPONSAVEL"

_ZERO_UUID = uuid.UUID(int=0)
_IMMUTABLE_COLUMNS = (
    "id", "asset_id", "origin_unit_id", "destination_unit_id", "origin_room_id",
    "destination_room_id", "previous_responsible_id", "new_responsible_id", "movement_type",
    "reason", "requested_by", "created_at",
)
_SORTS = {
    "created_at": (AssetMovement.created_at, AssetMovement.id),
    "-created_at": (AssetMovement.created_at.desc(), AssetMovement.id),
    "status": (AssetMovement.status, AssetMovement.created_at.desc(), AssetMovement.id),
    "-status": (AssetMovement.status.desc(), AssetMovement.created_at.desc(), AssetMovement.id),
}


# ---------------------------------------------------------------------------
# Guardas de imutabilidade (ORM)
# ---------------------------------------------------------------------------


@event.listens_for(AssetMovement, "before_update")
def _guard_update(_mapper, _connection, target: AssetMovement) -> None:  # pragma: no cover - via serviço
    from sqlalchemy import inspect

    state = inspect(target)
    for name in _IMMUTABLE_COLUMNS:
        if state.attrs[name].history.has_changes():
            raise RuntimeError("asset_movements: colunas do histórico são imutáveis.")
    status_hist = state.attrs.status.history
    if status_hist.has_changes():
        old = status_hist.deleted[0] if status_hist.deleted else None
        new = status_hist.added[0] if status_hist.added else None
        if new not in TRANSITIONS.get(old, frozenset()):
            raise RuntimeError("asset_movements: transição de estado inválida.")
    elif any(state.attrs[n].history.has_changes() for n in ("approved_by", "approved_at", "completed_at")):
        raise RuntimeError("asset_movements: decisão só acompanha mudança de estado.")


@event.listens_for(AssetMovement, "before_delete")
def _guard_delete(_mapper, _connection, _target) -> None:  # pragma: no cover - via serviço
    raise RuntimeError("asset_movements: exclusão proibida (histórico imutável).")


# ---------------------------------------------------------------------------
# Erros de domínio
# ---------------------------------------------------------------------------


class MovementError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class MovementNotFoundError(MovementError):
    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


class MovementForbiddenError(MovementError):
    status_code = 403
    code = "forbidden"
    message = "Acesso negado."


class MovementVersionConflictError(MovementError):
    status_code = 409
    code = "version_conflict"
    message = "O bem foi alterado por outra pessoa. Recarregue e tente novamente."


class MovementPendingError(MovementError):
    status_code = 409
    code = "movement_pending"
    message = "O bem já possui uma movimentação pendente."


class MovementInvalidTransitionError(MovementError):
    status_code = 409
    code = "invalid_transition"
    message = "A movimentação não está mais pendente."


class MovementNoChangeError(MovementError):
    status_code = 409
    code = "no_change"
    message = "A movimentação não altera a unidade, a sala nem o responsável do bem."


class MovementAssetUnavailableError(MovementError):
    status_code = 409
    code = "asset_unavailable"
    message = "O bem não está disponível para movimentação."


class MovementUnitInactiveError(MovementError):
    status_code = 409
    code = "unit_inactive"
    message = "A unidade está inativa."


class MovementLinkInactiveError(MovementError):
    status_code = 409
    code = "link_inactive"
    message = "O vínculo informado está inativo."


class MovementLinkMismatchError(MovementError):
    status_code = 409
    code = "link_unit_mismatch"
    message = "O vínculo informado pertence a outra unidade."


class MovementConflictError(MovementError):
    status_code = 409
    code = "conflict"
    message = "Conflito ao registrar a movimentação."


# ---------------------------------------------------------------------------
# Serviço
# ---------------------------------------------------------------------------


def _day_start(raw: str) -> datetime:
    return datetime.combine(date.fromisoformat(raw), time.min, tzinfo=timezone.utc)


def _jv(value: Any) -> Any:
    return str(value) if isinstance(value, uuid.UUID) else value


class MovementService:
    """`is_adm`/`can_view_internal` vêm dos papéis do servidor (nunca do cliente)."""

    def __init__(
        self, db: Session, *, is_adm: bool, can_view_internal: bool, request_id: str | None = None
    ) -> None:
        self._db = db
        self._is_adm = is_adm
        self._can_view_internal = can_view_internal  # RH: sem motivo nem autoria
        self._request_id = request_id

    # -- infraestrutura ------------------------------------------------------

    def _scope(self, actor_id: Any) -> Any:
        accessible = sorted(get_accessible_unit_ids(actor_id, self._db), key=str)
        if not accessible:
            return false()
        return or_(
            AssetMovement.origin_unit_id.in_(accessible),
            AssetMovement.destination_unit_id.in_(accessible),
        )

    def _load(self, actor_id: Any, movement_id: uuid.UUID, *, for_update: bool = False) -> AssetMovement:
        query = self._db.query(AssetMovement).filter(AssetMovement.id == movement_id, self._scope(actor_id))
        if for_update:
            query = query.with_for_update()
        movement = query.first()
        if movement is None:
            raise MovementNotFoundError()
        return movement

    def _load_asset_in_scope(self, actor_id: Any, raw: Any) -> Asset:
        parsed = _parse_uuid(raw)
        query = apply_unit_scope(
            self._db.query(Asset).filter(Asset.id == (parsed or _ZERO_UUID), Asset.deleted_at.is_(None)),
            Asset.unit_id, actor_id, self._db,
        ).with_for_update()
        asset = query.first()
        if asset is None or parsed is None:
            raise MovementNotFoundError()
        return asset

    def _scoped_unit(self, actor_id: Any, raw: Any) -> Unit:
        parsed = _parse_uuid(raw)
        unit = apply_unit_scope(
            self._db.query(Unit).filter(Unit.id == (parsed or _ZERO_UUID)), Unit.id, actor_id, self._db
        ).first()
        if unit is None or parsed is None:
            raise MovementNotFoundError()
        return unit

    def _resolve_link(self, actor_id: Any, model: Any, raw: Any, unit_id: uuid.UUID,
                      current_id: uuid.UUID | None) -> uuid.UUID:
        parsed = _parse_uuid(raw)
        row = apply_unit_scope(
            self._db.query(model.id, model.unit_id, model.active).filter(model.id == (parsed or _ZERO_UUID)),
            model.unit_id, actor_id, self._db,
        ).first()
        if row is None or parsed is None:
            raise MovementNotFoundError()
        if row.unit_id != unit_id:
            raise MovementLinkMismatchError()
        if not row.active and row.id != current_id:
            raise MovementLinkInactiveError()
        return row.id

    def _audit(self, entity_type: str, entity_id: Any, operation: str, actor_id: Any,
               previous: dict[str, Any] | None, new: dict[str, Any] | None) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(), actor_user_id=actor_id, entity_type=entity_type,
                entity_id=str(entity_id), operation=operation, previous_values=previous,
                new_values=new, request_id=self._request_id, result="SUCESSO",
            )
        )

    def _flush(self) -> None:
        try:
            self._db.flush()
        except StaleDataError as exc:
            self._db.rollback()
            raise MovementVersionConflictError() from exc
        except IntegrityError as exc:
            logger.warning("movement_service: violação de integridade (%s).", exc.__class__.__name__)
            self._db.rollback()
            raise MovementConflictError() from exc

    @staticmethod
    def _transition(movement: AssetMovement, target: str) -> None:
        if target not in TRANSITIONS.get(movement.status, frozenset()):
            raise MovementInvalidTransitionError()
        movement.status = target

    # -- serialização --------------------------------------------------------

    def _serialize_many(self, rows: list[AssetMovement], actor_id: Any) -> list[dict[str, Any]]:
        db = self._db
        accessible = {str(u) for u in get_accessible_unit_ids(actor_id, db)}
        fetch = _Lookups._fetch
        units = fetch(db, Unit, {x for m in rows for x in (m.origin_unit_id, m.destination_unit_id)},
                      (Unit.id, Unit.code, Unit.name))
        rooms = fetch(db, Room, {x for m in rows for x in (m.origin_room_id, m.destination_room_id)},
                      (Room.id, Room.name))
        people = fetch(db, ResponsiblePerson,
                       {x for m in rows for x in (m.previous_responsible_id, m.new_responsible_id)},
                       (ResponsiblePerson.id, ResponsiblePerson.name))
        asset_ids = {m.asset_id for m in rows}
        assets = {}
        if asset_ids:
            for a in db.execute(
                select(Asset.id, Asset.patrimony_number, Asset.description, Asset.deleted_at)
                .where(Asset.id.in_(sorted(asset_ids, key=str)))
            ):
                assets[a.id] = {"id": str(a.id), "patrimony_number": a.patrimony_number,
                                "description": a.description, "deleted": a.deleted_at is not None}
        out = []
        for m in rows:
            data: dict[str, Any] = {
                "id": str(m.id),
                "asset_id": str(m.asset_id),
                "asset": assets.get(m.asset_id),
                "movement_type": m.movement_type,
                "status": m.status,
                "origin_unit_id": str(m.origin_unit_id),
                "origin_unit": units.get(m.origin_unit_id),
                "destination_unit_id": str(m.destination_unit_id),
                "destination_unit": units.get(m.destination_unit_id),
                "destination_room_id": str(m.destination_room_id) if m.destination_room_id else None,
                "destination_room": rooms.get(m.destination_room_id),
                "new_responsible_id": str(m.new_responsible_id) if m.new_responsible_id else None,
                "new_responsible": people.get(m.new_responsible_id),
                "created_at": _iso(m.created_at),
                "approved_at": _iso(m.approved_at),
                "completed_at": _iso(m.completed_at),
            }
            # SEC-MOV-01: dados da ORIGEM (sala, responsável anterior, motivo livre) só para
            # quem tem escopo na unidade de origem; leitor só do destino não os recebe.
            origin_in_scope = str(m.origin_unit_id) in accessible
            if origin_in_scope:
                data.update(
                    origin_room_id=str(m.origin_room_id) if m.origin_room_id else None,
                    origin_room=rooms.get(m.origin_room_id),
                    previous_responsible_id=(
                        str(m.previous_responsible_id) if m.previous_responsible_id else None
                    ),
                    previous_responsible=people.get(m.previous_responsible_id),
                )
            if self._can_view_internal:  # RH não recebe motivo nem autoria
                if origin_in_scope:
                    data["reason"] = m.reason
                data.update(
                    requested_by=str(m.requested_by),
                    approved_by=str(m.approved_by) if m.approved_by else None,
                )
            out.append(data)
        return out

    # -- leitura -------------------------------------------------------------

    def list(self, actor_id: Any, query: Any) -> dict[str, Any]:
        scoped = self._db.query(AssetMovement).filter(self._scope(actor_id))
        if query.status:
            scoped = scoped.filter(AssetMovement.status == query.status)
        for field in ("asset_id", "origin_unit_id", "destination_unit_id"):
            value = getattr(query, field)
            if value is not None:
                scoped = scoped.filter(getattr(AssetMovement, field) == value)
        if query.created_from:
            scoped = scoped.filter(AssetMovement.created_at >= _day_start(query.created_from))
        if query.created_to:
            scoped = scoped.filter(AssetMovement.created_at < _day_start(query.created_to) + timedelta(days=1))
        total = scoped.with_entities(func.count(AssetMovement.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
            .all()
        )
        return {"total": int(total), "page": query.page, "page_size": query.page_size,
                "movements": self._serialize_many(list(rows), actor_id)}

    def get(self, actor_id: Any, movement_id: uuid.UUID) -> dict[str, Any]:
        return self._serialize_many([self._load(actor_id, movement_id)], actor_id)[0]

    # -- solicitação ---------------------------------------------------------

    def create(self, actor_id: Any, body: Any) -> dict[str, Any]:
        asset = self._load_asset_in_scope(actor_id, body.asset_id)
        if asset.version != body.asset_version:
            raise MovementVersionConflictError()
        pending = self._db.execute(
            select(AssetMovement.id).where(
                AssetMovement.asset_id == asset.id, AssetMovement.status == PENDING
            ).limit(1)
        ).first()
        if pending is not None:
            raise MovementPendingError()
        dest = self._scoped_unit(actor_id, body.destination_unit_id)
        if not dest.active:
            raise MovementUnitInactiveError()
        same_unit = dest.id == asset.unit_id
        sent = body.model_fields_set
        room_id, person_id = (asset.room_id, asset.responsible_person_id) if same_unit else (None, None)
        if "destination_room_id" in sent or not same_unit:
            room_id = None
            if body.destination_room_id is not None:
                room_id = self._resolve_link(
                    actor_id, Room, body.destination_room_id, dest.id,
                    asset.room_id if same_unit else None,
                )
        if "new_responsible_id" in sent or not same_unit:
            person_id = None
            if body.new_responsible_id is not None:
                person_id = self._resolve_link(
                    actor_id, ResponsiblePerson, body.new_responsible_id, dest.id,
                    asset.responsible_person_id if same_unit else None,
                )
        if same_unit and room_id == asset.room_id and person_id == asset.responsible_person_id:
            raise MovementNoChangeError()
        kind = TYPE_UNIT if not same_unit else (TYPE_ROOM if room_id != asset.room_id else TYPE_RESPONSIBLE)
        movement = AssetMovement(
            id=uuid.uuid4(), asset_id=asset.id, origin_unit_id=asset.unit_id, destination_unit_id=dest.id,
            origin_room_id=asset.room_id, destination_room_id=room_id,
            previous_responsible_id=asset.responsible_person_id, new_responsible_id=person_id,
            movement_type=kind, status=PENDING, reason=body.reason, requested_by=actor_id,
            created_at=datetime.now(timezone.utc),
        )
        self._db.add(movement)
        self._flush()
        self._audit(
            ENTITY_TYPE, movement.id, OP_REQUESTED, actor_id, None,
            {
                "asset_id": str(asset.id), "asset_version": asset.version, "movement_type": kind,
                "origin_unit_id": str(asset.unit_id), "destination_unit_id": str(dest.id),
                "origin_room_id": _jv(asset.room_id), "destination_room_id": _jv(room_id),
                "previous_responsible_id": _jv(asset.responsible_person_id),
                "new_responsible_id": _jv(person_id), "has_reason": body.reason is not None,
            },
        )
        return self._serialize_many([movement], actor_id)[0]

    # -- decisões ------------------------------------------------------------

    def approve(self, actor_id: Any, movement_id: uuid.UUID, body: Any) -> dict[str, Any]:
        movement = self._load(actor_id, movement_id, for_update=True)
        if units_outside_scope(actor_id, [movement.origin_unit_id, movement.destination_unit_id], self._db):
            raise MovementForbiddenError()
        if movement.status != PENDING:
            raise MovementInvalidTransitionError()
        asset = self._db.query(Asset).filter(Asset.id == movement.asset_id).with_for_update().first()
        if asset is None or asset.deleted_at is not None:
            raise MovementAssetUnavailableError()
        if (
            asset.version != body.asset_version
            or asset.unit_id != movement.origin_unit_id
            or asset.room_id != movement.origin_room_id
            or asset.responsible_person_id != movement.previous_responsible_id
        ):
            raise MovementVersionConflictError()
        dest = self._db.get(Unit, movement.destination_unit_id)
        if dest is None or not dest.active:
            raise MovementUnitInactiveError()
        unit_changed = dest.id != asset.unit_id
        if movement.destination_room_id is not None:
            self._resolve_link(actor_id, Room, movement.destination_room_id, dest.id,
                               asset.room_id if not unit_changed else None)
        if movement.new_responsible_id is not None:
            self._resolve_link(actor_id, ResponsiblePerson, movement.new_responsible_id, dest.id,
                               asset.responsible_person_id if not unit_changed else None)
        location_id = asset.location_id
        if unit_changed:
            location_id = None
        elif location_id is not None and movement.destination_room_id != asset.room_id:
            loc_room = self._db.query(Location.room_id).filter(Location.id == location_id).scalar()
            if loc_room is not None and loc_room != movement.destination_room_id:
                location_id = None
        previous = {
            "unit_id": str(asset.unit_id), "room_id": _jv(asset.room_id),
            "responsible_person_id": _jv(asset.responsible_person_id), "location_id": _jv(asset.location_id),
        }
        new = {
            "unit_id": str(dest.id), "room_id": _jv(movement.destination_room_id),
            "responsible_person_id": _jv(movement.new_responsible_id), "location_id": _jv(location_id),
            "movement_id": str(movement.id),
        }
        now = datetime.now(timezone.utc)
        self._transition(movement, APPROVED)
        movement.approved_by, movement.approved_at, movement.completed_at = actor_id, now, now
        asset.unit_id = dest.id
        asset.room_id = movement.destination_room_id
        asset.responsible_person_id = movement.new_responsible_id
        asset.location_id = location_id
        asset.updated_by = actor_id
        asset.version = asset.version + 1
        self._flush()
        self._audit(ENTITY_TYPE, movement.id, OP_APPROVED, actor_id, {"status": PENDING},
                    {"status": APPROVED, "asset_id": str(asset.id)})
        self._audit("asset", asset.id, OP_ASSET_MOVED, actor_id, previous, new)
        return self._serialize_many([movement], actor_id)[0]

    def _close(self, actor_id: Any, movement: AssetMovement, target: str, operation: str, body: Any,
               *, decided: bool) -> dict[str, Any]:
        self._transition(movement, target)
        if decided:
            movement.approved_by, movement.approved_at = actor_id, datetime.now(timezone.utc)
        self._flush()
        new: dict[str, Any] = {"status": target, "asset_id": str(movement.asset_id)}
        if body.reason:
            new["reason"] = body.reason
        self._audit(ENTITY_TYPE, movement.id, operation, actor_id, {"status": PENDING}, new)
        return self._serialize_many([movement], actor_id)[0]

    def reject(self, actor_id: Any, movement_id: uuid.UUID, body: Any) -> dict[str, Any]:
        movement = self._load(actor_id, movement_id, for_update=True)
        if units_outside_scope(actor_id, [movement.origin_unit_id, movement.destination_unit_id], self._db):
            raise MovementForbiddenError()
        return self._close(actor_id, movement, REJECTED, OP_REJECTED, body, decided=True)

    def cancel(self, actor_id: Any, movement_id: uuid.UUID, body: Any) -> dict[str, Any]:
        movement = self._load(actor_id, movement_id, for_update=True)
        if movement.requested_by != actor_id and not self._is_adm:
            raise MovementForbiddenError()
        return self._close(actor_id, movement, CANCELLED, OP_CANCELLED, body, decided=False)
