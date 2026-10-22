"""Cadastros de apoio: salas, pessoas responsáveis e dados cadastrais de unidades.

Regra de negócio das rotas `rooms`, `responsible-people` e `units/<id>`
(rotas finas em `app/api/v1/`). Decisões (usuário, 2026-10-16):

    - SÓ ADM cria/altera/inativa (permissões `rooms.manage`,
      `responsible.manage`, `units.update`, checadas na borda). "Excluir" =
      INATIVAR (`active=false`); nunca há DELETE físico.
    - Inativar sala/pessoa EM USO por bens é permitido: a inativação apenas
      bloqueia NOVAS associações (a importação e as telas de vínculo devem
      filtrar `active=true`); vínculos existentes seguem válidos e legíveis.
      Reativar exige a unidade ativa. Criar sala/pessoa em unidade inativa -> 409.
    - Leitura: `units.read` (salas/unidades) e `responsible.read` (pessoas),
      sempre com ESCOPO DE UNIDADE (`apply_unit_scope`; ADM também -- matriz de
      permissões, princípio 3).
    - Pessoas (SEC-CAT-06): USER vê SÓ pessoas vinculadas (`assets.
      responsible_person_id`, bens não excluídos do seu escopo) e só
      `id/name/unit_id/active`; RH/ADM veem o cadastro completo.
    - `phone` é DADO PESSOAL: só o ADM lê/escreve. Para os demais perfis a
      coluna nem é carregada (`defer`) e a chave não aparece na resposta;
      escrita por não-ADM é recusada (`PhoneForbiddenError` -> 400 + evento).

ANTI-IDOR/BOLA: a carga do alvo é UMA consulta com `apply_unit_scope`; alvo
alheio, inexistente ou `unit_id` do corpo inválido/alheio => `NotFoundError`
(mesma resposta e mesmo número de consultas, sem oráculo).

CONCORRÊNCIA/UNICIDADE: as tabelas não têm coluna `version`; a linha é lida
com `FOR UPDATE` e o cliente pode enviar `expected_updated_at` (pré-condição;
divergência -> 409 `version_conflict`). Unicidade (sala por unidade+nome, e-mail
e identificador da pessoa) é checada antes e garantida pelos índices únicos do
banco; qualquer violação vira o mesmo 409 genérico `conflict`, sem dizer qual
campo nem expor o erro do banco.

AUDITORIA: `AuditLog` de negócio na MESMA transação. Valores antigos/novos
só de campos não pessoais (nome e flags); e-mail, telefone e identificador
entram apenas como NOME do campo alterado, nunca o valor.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer, load_only

from app.authorization.rbac import apply_unit_scope
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit
from app.services.pagination import page_count
from app.security.text_search import contains_ci

logger = logging.getLogger(__name__)

_NOT_FOUND = "Recurso não encontrado."
_ZERO_UUID = uuid.UUID(int=0)

# Operações de auditoria de negócio.
OP_ROOM_CREATED = "ROOM_CREATED"
OP_ROOM_UPDATED = "ROOM_UPDATED"
OP_ROOM_DEACTIVATED = "ROOM_DEACTIVATED"
OP_ROOM_ACTIVATED = "ROOM_ACTIVATED"
OP_PERSON_CREATED = "RESPONSIBLE_PERSON_CREATED"
OP_PERSON_UPDATED = "RESPONSIBLE_PERSON_UPDATED"
OP_PERSON_DEACTIVATED = "RESPONSIBLE_PERSON_DEACTIVATED"
OP_PERSON_ACTIVATED = "RESPONSIBLE_PERSON_ACTIVATED"
OP_UNIT_UPDATED = "UNIT_UPDATED"
OP_UNIT_DEACTIVATED = "UNIT_DEACTIVATED"
OP_UNIT_ACTIVATED = "UNIT_ACTIVATED"

# Campos pessoais: auditados só pelo NOME (nunca o valor).
_PERSONAL_FIELDS = frozenset({"email", "phone", "institutional_identifier"})


# ---------------------------------------------------------------------------
# Erros de domínio
# ---------------------------------------------------------------------------


class CatalogError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class NotFoundError(CatalogError):
    status_code = 404
    code = "not_found"
    message = _NOT_FOUND


class ConflictError(CatalogError):
    status_code = 409
    code = "conflict"
    message = "Já existe um registro com estes dados."


class VersionConflictError(CatalogError):
    status_code = 409
    code = "version_conflict"
    message = "O registro foi alterado por outra pessoa. Recarregue e tente novamente."


class InactiveUnitError(CatalogError):
    status_code = 409
    code = "unit_inactive"
    message = "A unidade está inativa."


class PhoneForbiddenError(CatalogError):
    """Não-ADM tentou gravar `phone` (mass assignment; auditado na borda)."""

    status_code = 400
    code = "validation_error"
    message = "Campo(s) não permitido(s) no corpo da requisição: phone."


# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_uuid(raw: Any) -> uuid.UUID | None:
    if isinstance(raw, uuid.UUID):
        return raw
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


@dataclass(frozen=True)
class MutationResult:
    payload: dict[str, Any]
    changed: bool


def serialize_room(room: Room) -> dict[str, Any]:
    return {
        "id": str(room.id),
        "unit_id": str(room.unit_id),
        "name": room.name,
        "description": room.description,
        "floor": room.floor,
        "active": bool(room.active),
        "source_record_id": room.source_record_id,
        "created_at": _iso(room.created_at),
        "updated_at": _iso(room.updated_at),
    }


def serialize_person(person: ResponsiblePerson, *, include_phone: bool) -> dict[str, Any]:
    data = {
        "id": str(person.id),
        "unit_id": str(person.unit_id),
        "name": person.name,
        "email": person.email,
        "institutional_identifier": person.institutional_identifier,
        "active": bool(person.active),
        "source_record_id": person.source_record_id,
        "created_at": _iso(person.created_at),
        "updated_at": _iso(person.updated_at),
    }
    if include_phone:  # dado pessoal: a chave só existe para ADM
        data["phone"] = person.phone
    return data


def serialize_person_minimal(person: ResponsiblePerson) -> dict[str, Any]:
    """Visão do perfil USER: sem e-mail, identificador, origem, telefone ou datas."""
    return {
        "id": str(person.id),
        "unit_id": str(person.unit_id),
        "name": person.name,
        "active": bool(person.active),
    }


# Ordenações permitidas na visão mínima (campos expostos).
MINIMAL_PERSON_SORTS = frozenset({"name", "-name"})


def serialize_unit(unit: Unit, *, include_address: bool) -> dict[str, Any]:
    data = {
        "id": str(unit.id),
        "code": unit.code,
        "name": unit.name,
        "description": unit.description,
        "active": bool(unit.active),
        "source_record_id": unit.source_record_id,
        "created_at": _iso(unit.created_at),
        "updated_at": _iso(unit.updated_at),
    }
    if include_address:
        data["address"] = unit.address
    return data


_ROOM_SORTS = {
    "name": (func.lower(Room.name), Room.id),
    "-name": (func.lower(Room.name).desc(), Room.id),
    "created_at": (Room.created_at, Room.id),
    "-created_at": (Room.created_at.desc(), Room.id),
    "updated_at": (Room.updated_at, Room.id),
    "-updated_at": (Room.updated_at.desc(), Room.id),
}
_PERSON_SORTS = {
    "name": (func.lower(ResponsiblePerson.name), ResponsiblePerson.id),
    "-name": (func.lower(ResponsiblePerson.name).desc(), ResponsiblePerson.id),
    "email": (func.lower(ResponsiblePerson.email), ResponsiblePerson.id),
    "-email": (func.lower(ResponsiblePerson.email).desc(), ResponsiblePerson.id),
    "created_at": (ResponsiblePerson.created_at, ResponsiblePerson.id),
    "-created_at": (ResponsiblePerson.created_at.desc(), ResponsiblePerson.id),
    "updated_at": (ResponsiblePerson.updated_at, ResponsiblePerson.id),
    "-updated_at": (ResponsiblePerson.updated_at.desc(), ResponsiblePerson.id),
}


_UNIT_SORTS = {
    "name": (func.lower(Unit.name), Unit.id),
    "-name": (func.lower(Unit.name).desc(), Unit.id),
    "code": (func.lower(Unit.code), Unit.id),
    "-code": (func.lower(Unit.code).desc(), Unit.id),
    "updated_at": (Unit.updated_at, Unit.id),
    "-updated_at": (Unit.updated_at.desc(), Unit.id),
}


class _CatalogBase:
    """Operações comuns: escopo, auditoria, pré-condição e gravação."""

    def __init__(self, db: Session, *, request_id: str | None = None) -> None:
        self._db = db
        self._request_id = request_id

    # -- infraestrutura ------------------------------------------------------

    def _audit(
        self,
        entity_type: str,
        entity_id: uuid.UUID,
        operation: str,
        actor_id: Any,
        previous: dict[str, Any] | None,
        new: dict[str, Any] | None,
    ) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=actor_id,
                entity_type=entity_type,
                entity_id=str(entity_id),
                operation=operation,
                previous_values=previous,
                new_values=new,
                request_id=self._request_id,
                result="SUCESSO",
            )
        )

    def _flush_or_conflict(self) -> None:
        """Grava; qualquer violação de integridade vira o 409 genérico."""
        try:
            self._db.flush()
        except IntegrityError as exc:
            logger.warning("catalog_service: violação de integridade (%s).", exc.__class__.__name__)
            self._db.rollback()
            raise ConflictError() from exc

    @staticmethod
    def _check_precondition(entity: Any, expected: datetime | None) -> None:
        if expected is None or entity.updated_at is None:
            return
        if _as_utc(entity.updated_at) != _as_utc(expected):
            raise VersionConflictError()

    def _scoped_unit(self, actor_id: Any, raw_unit_id: Any, *, for_update: bool = False) -> Unit:
        """Unidade do ESCOPO do ator; inválida/inexistente/alheia => NotFoundError.

        Sempre executa a mesma consulta (id inválido usa o UUID nulo).
        """
        unit_id = _parse_uuid(raw_unit_id) or _ZERO_UUID
        query = apply_unit_scope(
            self._db.query(Unit).filter(Unit.id == unit_id), Unit.id, actor_id, self._db
        )
        if for_update:
            query = query.with_for_update()
        unit = query.first()
        if unit is None or _parse_uuid(raw_unit_id) is None:
            raise NotFoundError()
        return unit

    @staticmethod
    def _like(column_expr: Any, term: str) -> Any:
        return contains_ci(column_expr, term)


# ---------------------------------------------------------------------------
# Salas
# ---------------------------------------------------------------------------


class RoomService(_CatalogBase):
    def _load(self, actor_id: Any, room_id: uuid.UUID, *, for_update: bool = False) -> Room:
        query = apply_unit_scope(
            self._db.query(Room).filter(Room.id == room_id), Room.unit_id, actor_id, self._db
        )
        if for_update:
            query = query.with_for_update()
        room = query.first()
        if room is None:
            raise NotFoundError()
        return room

    def _name_taken(self, unit_id: uuid.UUID, name: str, *, exclude: uuid.UUID | None = None) -> bool:
        stmt = select(Room.id).where(
            Room.unit_id == unit_id, func.lower(func.trim(Room.name)) == name.lower()
        )
        if exclude is not None:
            stmt = stmt.where(Room.id != exclude)
        return self._db.execute(stmt.limit(1)).first() is not None

    def list(self, actor_id: Any, query: Any) -> dict[str, Any]:
        scoped = apply_unit_scope(self._db.query(Room), Room.unit_id, actor_id, self._db)
        if query.q:
            scoped = scoped.filter(
                or_(self._like(Room.name, query.q), self._like(func.coalesce(Room.floor, ""), query.q))
            )
        if query.unit_id is not None:
            scoped = scoped.filter(Room.unit_id == query.unit_id)
        if query.active is not None:
            scoped = scoped.filter(Room.active.is_(query.active == "true"))
        total = scoped.with_entities(func.count(Room.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_ROOM_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
            .all()
        )
        return {
            "total": int(total),
            "page": query.page,
            "page_size": query.page_size, "pages": page_count(total, query.page_size),
            "rooms": [serialize_room(r) for r in rows],
        }

    def get(self, actor_id: Any, room_id: uuid.UUID) -> dict[str, Any]:
        return serialize_room(self._load(actor_id, room_id))

    def create(self, actor_id: Any, body: Any) -> dict[str, Any]:
        unit = self._scoped_unit(actor_id, body.unit_id)
        if not unit.active:
            raise InactiveUnitError()
        if self._name_taken(unit.id, body.name):
            raise ConflictError()
        room = Room(
            id=uuid.uuid4(),
            unit_id=unit.id,
            name=body.name,
            description=body.description,
            floor=body.floor,
            active=True,
        )
        self._db.add(room)
        self._flush_or_conflict()
        self._audit(
            "room", room.id, OP_ROOM_CREATED, actor_id, None,
            {"unit_id": str(unit.id), "name": room.name, "active": True},
        )
        return serialize_room(room)

    def update(self, actor_id: Any, room_id: uuid.UUID, body: Any) -> MutationResult:
        room = self._load(actor_id, room_id, for_update=True)
        self._check_precondition(room, body.expected_updated_at)
        previous: dict[str, Any] = {}
        new: dict[str, Any] = {}
        for field in sorted(body.model_fields_set - {"expected_updated_at"}):
            value = getattr(body, field)
            if getattr(room, field) != value:
                previous[field], new[field] = getattr(room, field), value
        if not new:
            return MutationResult(serialize_room(room), False)
        if "name" in new and self._name_taken(room.unit_id, new["name"], exclude=room.id):
            raise ConflictError()
        for field, value in new.items():
            setattr(room, field, value)
        self._flush_or_conflict()
        self._audit("room", room.id, OP_ROOM_UPDATED, actor_id, previous, new)
        return MutationResult(serialize_room(room), True)

    def set_active(
        self, actor_id: Any, room_id: uuid.UUID, active: bool, *, expected_updated_at: datetime | None,
        reason: str | None,
    ) -> MutationResult:
        room = self._load(actor_id, room_id, for_update=True)
        self._check_precondition(room, expected_updated_at)
        if bool(room.active) == active:
            return MutationResult(serialize_room(room), False)
        if active:
            unit = self._db.get(Unit, room.unit_id)
            if unit is None or not unit.active:
                raise InactiveUnitError()
        room.active = active
        self._flush_or_conflict()
        new: dict[str, Any] = {"active": active}
        if reason:
            new["reason"] = reason
        self._audit(
            "room", room.id, OP_ROOM_ACTIVATED if active else OP_ROOM_DEACTIVATED, actor_id,
            {"active": not active}, new,
        )
        return MutationResult(serialize_room(room), True)


# ---------------------------------------------------------------------------
# Pessoas responsáveis
# ---------------------------------------------------------------------------


class ResponsiblePersonService(_CatalogBase):
    """`is_adm` decide a visibilidade de `phone` (nunca vem do cliente)."""

    def __init__(
        self, db: Session, *, is_adm: bool, request_id: str | None = None, minimal: bool = False
    ) -> None:
        super().__init__(db, request_id=request_id)
        self._is_adm = is_adm
        # `minimal` (perfil USER, SEC-CAT-06): só pessoas vinculadas a bens do
        # escopo e só id/name/unit_id/active. Nunca vem do cliente.
        self._minimal = minimal and not is_adm

    @property
    def minimal(self) -> bool:
        return self._minimal

    def _base_query(self) -> Any:
        query = self._db.query(ResponsiblePerson)
        if self._minimal:  # as demais colunas nem são selecionadas
            query = query.options(
                load_only(
                    ResponsiblePerson.id, ResponsiblePerson.name,
                    ResponsiblePerson.unit_id, ResponsiblePerson.active,
                )
            )
        elif not self._is_adm:
            query = query.options(defer(ResponsiblePerson.phone))  # nem é carregado
        return query

    def _serialize(self, person: ResponsiblePerson) -> dict[str, Any]:
        if self._minimal:
            return serialize_person_minimal(person)
        return serialize_person(person, include_phone=self._is_adm)

    def _scoped_people(self, actor_id: Any, query: Any) -> Any:
        """Escopo de unidade; no modo mínimo, só pessoas vinculadas a bens do escopo."""
        scoped = apply_unit_scope(query, ResponsiblePerson.unit_id, actor_id, self._db)
        if not self._minimal:
            return scoped
        linked = apply_unit_scope(
            self._db.query(Asset.responsible_person_id).filter(
                Asset.responsible_person_id.is_not(None), Asset.deleted_at.is_(None)
            ),
            Asset.unit_id, actor_id, self._db,
        )
        return scoped.filter(ResponsiblePerson.id.in_(linked.statement))

    def _load(self, actor_id: Any, person_id: uuid.UUID, *, for_update: bool = False) -> ResponsiblePerson:
        query = self._scoped_people(
            actor_id, self._base_query().filter(ResponsiblePerson.id == person_id)
        )
        if for_update:
            query = query.with_for_update()
        person = query.first()
        if person is None:
            raise NotFoundError()
        return person

    def _guard_phone(self, body: Any) -> None:
        if "phone" in body.model_fields_set and not self._is_adm:
            raise PhoneForbiddenError()

    def _taken(self, *, email: str | None, identifier: str | None, exclude: uuid.UUID | None) -> bool:
        clauses = []
        if email:
            clauses.append(func.lower(func.trim(ResponsiblePerson.email)) == email.lower())
        if identifier:
            clauses.append(ResponsiblePerson.institutional_identifier == identifier)
        if not clauses:
            return False
        stmt = select(ResponsiblePerson.id).where(or_(*clauses))
        if exclude is not None:
            stmt = stmt.where(ResponsiblePerson.id != exclude)
        return self._db.execute(stmt.limit(1)).first() is not None

    def list(self, actor_id: Any, query: Any) -> dict[str, Any]:
        scoped = self._scoped_people(actor_id, self._base_query())
        if query.q and self._minimal:
            scoped = scoped.filter(self._like(ResponsiblePerson.name, query.q))  # só nome
        elif query.q:
            scoped = scoped.filter(
                or_(
                    self._like(ResponsiblePerson.name, query.q),
                    self._like(func.coalesce(ResponsiblePerson.email, ""), query.q),
                    self._like(func.coalesce(ResponsiblePerson.institutional_identifier, ""), query.q),
                )
            )
        if query.unit_id is not None:
            scoped = scoped.filter(ResponsiblePerson.unit_id == query.unit_id)
        if query.active is not None:
            scoped = scoped.filter(ResponsiblePerson.active.is_(query.active == "true"))
        total = scoped.with_entities(func.count(ResponsiblePerson.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_PERSON_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
            .all()
        )
        return {
            "total": int(total),
            "page": query.page,
            "page_size": query.page_size, "pages": page_count(total, query.page_size),
            "people": [self._serialize(p) for p in rows],
        }

    def get(self, actor_id: Any, person_id: uuid.UUID) -> dict[str, Any]:
        return self._serialize(self._load(actor_id, person_id))

    def create(self, actor_id: Any, body: Any) -> dict[str, Any]:
        self._guard_phone(body)
        unit = self._scoped_unit(actor_id, body.unit_id)
        if not unit.active:
            raise InactiveUnitError()
        if self._taken(email=body.email, identifier=body.institutional_identifier, exclude=None):
            raise ConflictError()
        person = ResponsiblePerson(
            id=uuid.uuid4(),
            unit_id=unit.id,
            name=body.name,
            email=body.email,
            phone=body.phone if self._is_adm else None,
            institutional_identifier=body.institutional_identifier,
            active=True,
        )
        self._db.add(person)
        self._flush_or_conflict()
        self._audit(
            "responsible_person", person.id, OP_PERSON_CREATED, actor_id, None,
            {
                "unit_id": str(unit.id),
                "name": person.name,
                "fields": sorted(
                    f for f in ("email", "phone", "institutional_identifier") if getattr(person, f)
                ),
                "active": True,
            },
        )
        return self._serialize(person)

    def update(self, actor_id: Any, person_id: uuid.UUID, body: Any) -> MutationResult:
        self._guard_phone(body)
        person = self._load(actor_id, person_id, for_update=True)
        self._check_precondition(person, body.expected_updated_at)
        changes: dict[str, Any] = {}
        for field in sorted(body.model_fields_set - {"expected_updated_at"}):
            value = getattr(body, field)
            if getattr(person, field) != value:
                changes[field] = value
        if not changes:
            return MutationResult(self._serialize(person), False)
        if self._taken(
            email=changes.get("email"),
            identifier=changes.get("institutional_identifier"),
            exclude=person.id,
        ):
            raise ConflictError()
        previous: dict[str, Any] = {}
        new: dict[str, Any] = {}
        if "name" in changes:
            previous["name"], new["name"] = person.name, changes["name"]
        personal = sorted(f for f in changes if f in _PERSONAL_FIELDS)
        if personal:
            new["changed_fields"] = personal  # só os NOMES; nunca o valor
        for field, value in changes.items():
            setattr(person, field, value)
        self._flush_or_conflict()
        self._audit("responsible_person", person.id, OP_PERSON_UPDATED, actor_id, previous, new)
        return MutationResult(self._serialize(person), True)

    def set_active(
        self, actor_id: Any, person_id: uuid.UUID, active: bool, *,
        expected_updated_at: datetime | None, reason: str | None,
    ) -> MutationResult:
        person = self._load(actor_id, person_id, for_update=True)
        self._check_precondition(person, expected_updated_at)
        if bool(person.active) == active:
            return MutationResult(self._serialize(person), False)
        if active:
            unit = self._db.get(Unit, person.unit_id)
            if unit is None or not unit.active:
                raise InactiveUnitError()
        person.active = active
        self._flush_or_conflict()
        new: dict[str, Any] = {"active": active}
        if reason:
            new["reason"] = reason
        self._audit(
            "responsible_person", person.id,
            OP_PERSON_ACTIVATED if active else OP_PERSON_DEACTIVATED, actor_id,
            {"active": not active}, new,
        )
        return MutationResult(self._serialize(person), True)


# ---------------------------------------------------------------------------
# Unidades (dados cadastrais)
# ---------------------------------------------------------------------------


class UnitCatalogService(_CatalogBase):
    """`code` e `source_record_id` são imutáveis por esta API."""

    def __init__(self, db: Session, *, is_adm: bool, request_id: str | None = None) -> None:
        super().__init__(db, request_id=request_id)
        self._is_adm = is_adm

    def _load(self, actor_id: Any, unit_id: uuid.UUID, *, for_update: bool = False) -> Unit:
        query = apply_unit_scope(
            self._db.query(Unit).filter(Unit.id == unit_id), Unit.id, actor_id, self._db
        )
        if for_update:
            query = query.with_for_update()
        unit = query.first()
        if unit is None:
            raise NotFoundError()
        return unit

    def list_catalog(self, actor_id: Any, query: Any) -> dict[str, Any]:
        """Cadastro de unidades do ESCOPO (ativas e inativas); `address` só ADM."""
        scoped = apply_unit_scope(self._db.query(Unit), Unit.id, actor_id, self._db)
        if query.q:
            scoped = scoped.filter(
                or_(self._like(Unit.name, query.q), self._like(Unit.code, query.q))
            )
        if query.active != "all":
            scoped = scoped.filter(Unit.active.is_(query.active == "true"))
        total = scoped.with_entities(func.count(Unit.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_UNIT_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
            .all()
        )
        units = []
        for unit in rows:
            item = {
                "id": str(unit.id),
                "code": unit.code,
                "name": unit.name,
                "active": bool(unit.active),
                "updated_at": _iso(unit.updated_at),
                "source_record_id": unit.source_record_id,
            }
            if self._is_adm:
                item["address"] = unit.address
            units.append(item)
        return {"total": int(total), "page": query.page, "page_size": query.page_size, "pages": page_count(total, query.page_size), "units": units}

    def get(self, actor_id: Any, unit_id: uuid.UUID) -> dict[str, Any]:
        return serialize_unit(self._load(actor_id, unit_id), include_address=self._is_adm)

    def update(self, actor_id: Any, unit_id: uuid.UUID, body: Any) -> MutationResult:
        unit = self._load(actor_id, unit_id, for_update=True)
        self._check_precondition(unit, body.expected_updated_at)
        previous: dict[str, Any] = {}
        new: dict[str, Any] = {}
        for field in sorted(body.model_fields_set - {"expected_updated_at"}):
            value = getattr(body, field)
            if getattr(unit, field) != value:
                previous[field], new[field] = getattr(unit, field), value
        if not new:
            return MutationResult(serialize_unit(unit, include_address=True), False)
        for field, value in new.items():
            setattr(unit, field, value)
        self._flush_or_conflict()
        self._audit("unit", unit.id, OP_UNIT_UPDATED, actor_id, previous, new)
        return MutationResult(serialize_unit(unit, include_address=True), True)

    def set_active(
        self, actor_id: Any, unit_id: uuid.UUID, active: bool, *,
        expected_updated_at: datetime | None, reason: str | None,
    ) -> MutationResult:
        unit = self._load(actor_id, unit_id, for_update=True)
        self._check_precondition(unit, expected_updated_at)
        if bool(unit.active) == active:
            return MutationResult(serialize_unit(unit, include_address=True), False)
        unit.active = active
        self._flush_or_conflict()
        new: dict[str, Any] = {"active": active}
        if reason:
            new["reason"] = reason
        self._audit(
            "unit", unit.id, OP_UNIT_ACTIVATED if active else OP_UNIT_DEACTIVATED, actor_id,
            {"active": not active}, new,
        )
        return MutationResult(serialize_unit(unit, include_address=True), True)
