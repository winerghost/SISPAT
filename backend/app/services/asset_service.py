"""Patrimônios (`assets`): leitura, criação, edição e exclusão LÓGICA com escopo.

Regra de negócio das rotas `/api/v1/assets` (rotas finas em `app/api/v1/assets.py`).

ESCOPO (matriz de permissões, `assets.*`): o bem é visível/editável quando
`unit_id` OU `owner_unit_id` está em `user_unit_access` do usuário -- inclusive
para ADM (princípio 3). Alvo alheio, inexistente, malformado ou excluído
logicamente (sem `include_deleted` de ADM) => `AssetNotFoundError` (mesma
resposta 404 e mesma consulta, sem oráculo). Na CRIAÇÃO, `unit_id` precisa estar
no escopo e ativa.

CAMPOS POR PERFIL (decisão registrada em docs/architecture/assets-api.md):
    - RH (somente leitura): vê a identificação do bem e do responsável; a coluna
      `notes` NEM é carregada (`defer`) e as chaves `notes`, `assigned_user_id`,
      `source_*`, `created_by`, `updated_by` e `deleted_by` não existem na resposta.
    - USER: edita `description`, `notes`, `room_id`, `location_id`,
      `responsible_person_id`, `registration_date`. NÃO envia `owner_unit_id`,
      `located` nem (em edição) `patrimony_number`: tentativa => 400 + evento.
    - ADM: todos os anteriores + `owner_unit_id`, `located`, `patrimony_number`,
      exclusão/restauração lógicas.
    - Nunca editáveis aqui: `id`, `unit_id` (após criar), `assigned_user_id`,
      `source_*`, `created_*`, `updated_*`, `deleted_*`, `version`.

CONCORRÊNCIA: `version` obrigatório no corpo; divergência => 409
`version_conflict` (e o `version_id_col` do ORM cobre a corrida entre a leitura
e o UPDATE). Linha lida com `FOR UPDATE`.

UNICIDADE: `patrimony_number` (texto; comparação sem caixa e sem espaços nas
pontas) é único entre bens NÃO excluídos. Não há índice único no banco (sem
migração nesta tarefa): a checagem é serializada por advisory lock transacional
no PostgreSQL. Violação => 409 genérico `conflict`, sem dizer o campo.

VÍNCULOS: sala/local/responsável precisam existir NO ESCOPO e pertencer à MESMA
unidade do bem (`link_unit_mismatch` 409); inativos só são aceitos se já eram o
vínculo atual (`link_inactive` 409). Inexistente/alheio/malformado => 404.

AUDITORIA: `AuditLog` de negócio na MESMA transação (`entity_type="asset"`).
Valores só de campos não sensíveis; `notes` entra apenas como NOME do campo.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import false, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer
from sqlalchemy.orm.exc import StaleDataError

from app.authorization.rbac import apply_unit_scope, get_accessible_unit_ids
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.people import ResponsiblePerson
from app.models.units import Location, Room, Unit
from app.security.sanitize import LIKE_ESCAPE_CHAR, escape_like
from app.services.patrimony_lock import (
    acquire_patrimony_lock,
    normalize_patrimony_number,
    normalized_column,
)

logger = logging.getLogger(__name__)

ENTITY_TYPE = "asset"
OP_CREATED = "ASSET_CREATED"
OP_UPDATED = "ASSET_UPDATED"
OP_DELETED = "ASSET_DELETED"
OP_RESTORED = "ASSET_RESTORED"

_ZERO_UUID = uuid.UUID(int=0)
_DEFAULT_LOCATED = "DESCONHECIDO"
_ADM_ONLY_CREATE = frozenset({"owner_unit_id", "located"})
_ADM_ONLY_UPDATE = frozenset({"owner_unit_id", "located", "patrimony_number"})
_LINK_MODELS = {
    "responsible_person_id": ResponsiblePerson,
    "room_id": Room,
    "location_id": Location,
}
_PLAIN_FIELDS = ("patrimony_number", "description", "notes", "located", "registration_date")
_SORTS = {
    "patrimony_number": (Asset.patrimony_number, Asset.id),
    "-patrimony_number": (Asset.patrimony_number.desc(), Asset.id),
    "description": (func.lower(func.coalesce(Asset.description, "")), Asset.id),
    "-description": (func.lower(func.coalesce(Asset.description, "")).desc(), Asset.id),
    "created_at": (Asset.created_at, Asset.id),
    "-created_at": (Asset.created_at.desc(), Asset.id),
    "updated_at": (Asset.updated_at, Asset.id),
    "-updated_at": (Asset.updated_at.desc(), Asset.id),
    # Vínculo: sem caixa; bens sem vínculo ("") primeiro em ordem crescente.
    "bond_status": (func.lower(func.coalesce(Asset.bond_status, "")), Asset.patrimony_number, Asset.id),
    "-bond_status": (func.lower(func.coalesce(Asset.bond_status, "")).desc(), Asset.patrimony_number, Asset.id),
}
BOND_STATUS_NONE = "__none__"  # filtro `bond_status=__none__` => sem vínculo
BOND_STATUS_GROUPS_MAX = 100


# ---------------------------------------------------------------------------
# Erros de domínio
# ---------------------------------------------------------------------------


class AssetError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class AssetNotFoundError(AssetError):
    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


class AssetConflictError(AssetError):
    status_code = 409
    code = "conflict"
    message = "Já existe um registro com estes dados."


class AssetVersionConflictError(AssetError):
    status_code = 409
    code = "version_conflict"
    message = "O registro foi alterado por outra pessoa. Recarregue e tente novamente."


class AssetUnitInactiveError(AssetError):
    status_code = 409
    code = "unit_inactive"
    message = "A unidade está inativa."


class AssetLinkInactiveError(AssetError):
    status_code = 409
    code = "link_inactive"
    message = "O vínculo informado está inativo."


class AssetLinkMismatchError(AssetError):
    status_code = 409
    code = "link_unit_mismatch"
    message = "O vínculo informado pertence a outra unidade."


class AssetFieldForbiddenError(AssetError):
    """Perfil enviou campo que não pode alterar (mass assignment; auditado na borda)."""

    status_code = 400
    code = "validation_error"

    def __init__(self, fields: list[str]) -> None:
        self.fields = sorted(fields)
        super().__init__("Campo(s) não permitido(s) no corpo da requisição: " + ", ".join(self.fields) + ".")


# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------


def _iso(value: datetime | date | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse_uuid(raw: Any) -> uuid.UUID | None:
    if isinstance(raw, uuid.UUID):
        return raw
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def _json_value(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def _like(column_expr: Any, term: str) -> Any:
    return column_expr.ilike(f"%{escape_like(term)}%", escape=LIKE_ESCAPE_CHAR)


def asset_scope_clause(actor_id: Any, db: Session) -> Any:
    """Escopo canônico de bens: `unit_id` OU `owner_unit_id` acessíveis.

    Fonte única usada por `/assets` e pelo dashboard (paridade de contagem).
    """
    accessible = sorted(get_accessible_unit_ids(actor_id, db), key=str)
    if not accessible:
        return false()
    return or_(Asset.unit_id.in_(accessible), Asset.owner_unit_id.in_(accessible))


ASSET_EQ_FILTERS = ("unit_id", "owner_unit_id", "room_id", "responsible_person_id", "located")


def bond_status_clause(bond: str | None) -> Any:
    """Filtro de vínculo: `__none__` => sem vínculo; senão exato e sem caixa."""
    if bond is None:
        return None
    if bond == BOND_STATUS_NONE:
        return Asset.bond_status.is_(None)
    # `lower()` dos DOIS lados no banco (mesma regra de caixa) e o lado da
    # coluna usa `ix_assets_bond_status_lower`.
    return func.lower(Asset.bond_status) == func.lower(bond)


def asset_filter_clauses(query: Any) -> list[Any]:
    """Filtros comuns da lista de bens e do dashboard (fonte única => paridade).

    Lê, por nome, os atributos opcionais de `query` (`None` = sem filtro):
    `unit_id`, `owner_unit_id`, `room_id`, `responsible_person_id`, `located`
    (igualdade) e `bond_status`. Não aplica escopo nem `deleted_at`.
    """
    clauses = [
        getattr(Asset, field) == getattr(query, field)
        for field in ASSET_EQ_FILTERS
        if getattr(query, field, None) is not None
    ]
    bond = bond_status_clause(getattr(query, "bond_status", None))
    if bond is not None:
        clauses.append(bond)
    return clauses


class _Lookups:
    """Nomes de unidade/sala/local/responsável dos bens listados (lote)."""

    def __init__(self, db: Session, assets: list[Asset]) -> None:
        self.units = self._fetch(db, Unit, {x for a in assets for x in (a.unit_id, a.owner_unit_id)},
                                 (Unit.id, Unit.code, Unit.name))
        self.rooms = self._fetch(db, Room, {a.room_id for a in assets}, (Room.id, Room.name))
        self.locations = self._fetch(db, Location, {a.location_id for a in assets},
                                     (Location.id, Location.name))
        self.people = self._fetch(db, ResponsiblePerson, {a.responsible_person_id for a in assets},
                                  (ResponsiblePerson.id, ResponsiblePerson.name))

    @staticmethod
    def _fetch(db: Session, model: Any, ids: set[Any], columns: tuple[Any, ...]) -> dict[Any, dict[str, Any]]:
        wanted = {i for i in ids if i is not None}
        if not wanted:
            return {}
        rows = db.execute(select(*columns).where(model.id.in_(sorted(wanted, key=str)))).all()
        return {row[0]: {"id": str(row[0]), **dict(zip(("code", "name") if len(row) == 3 else ("name",), row[1:]))}
                for row in rows}


# ---------------------------------------------------------------------------
# Serviço
# ---------------------------------------------------------------------------


class AssetService:
    """`is_adm`/`can_view_notes` vêm dos papéis do servidor (nunca do cliente)."""

    def __init__(
        self, db: Session, *, is_adm: bool, can_view_notes: bool, request_id: str | None = None
    ) -> None:
        self._db = db
        self._is_adm = is_adm
        self._can_view_notes = can_view_notes
        self._request_id = request_id

    # -- infraestrutura ------------------------------------------------------

    def _scope(self, actor_id: Any) -> Any:
        return asset_scope_clause(actor_id, self._db)

    def _base_query(self) -> Any:
        query = self._db.query(Asset)
        if not self._can_view_notes:
            query = query.options(defer(Asset.notes))  # RH: a coluna nem é consultada
        return query

    def _load(
        self, actor_id: Any, asset_id: uuid.UUID, *, include_deleted: bool = False,
        only_deleted: bool = False, for_update: bool = False,
    ) -> Asset:
        query = self._base_query().filter(Asset.id == asset_id, self._scope(actor_id))
        if only_deleted:
            query = query.filter(Asset.deleted_at.is_not(None))
        elif not (include_deleted and self._is_adm):
            query = query.filter(Asset.deleted_at.is_(None))
        if for_update:
            query = query.with_for_update()
        asset = query.first()
        if asset is None:
            raise AssetNotFoundError()
        return asset

    def _audit(self, asset_id: uuid.UUID, operation: str, actor_id: Any,
               previous: dict[str, Any] | None, new: dict[str, Any] | None) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(), actor_user_id=actor_id, entity_type=ENTITY_TYPE,
                entity_id=str(asset_id), operation=operation, previous_values=previous,
                new_values=new, request_id=self._request_id, result="SUCESSO",
            )
        )

    def _flush_or_conflict(self) -> None:
        try:
            self._db.flush()
        except StaleDataError as exc:
            self._db.rollback()
            raise AssetVersionConflictError() from exc
        except IntegrityError as exc:
            logger.warning("asset_service: violação de integridade (%s).", exc.__class__.__name__)
            self._db.rollback()
            raise AssetConflictError() from exc

    @staticmethod
    def _guard_fields(body: Any, adm_only: frozenset[str], is_adm: bool) -> None:
        if is_adm:
            return
        denied = sorted(body.model_fields_set & adm_only)
        if denied:
            raise AssetFieldForbiddenError(denied)

    def _scoped_unit(self, actor_id: Any, raw: Any) -> Unit:
        parsed = _parse_uuid(raw)
        query = apply_unit_scope(
            self._db.query(Unit).filter(Unit.id == (parsed or _ZERO_UUID)), Unit.id, actor_id, self._db
        )
        unit = query.first()
        if unit is None or parsed is None:
            raise AssetNotFoundError()
        return unit

    def _resolve_link(self, actor_id: Any, field: str, raw: Any, unit_id: uuid.UUID,
                      current_id: uuid.UUID | None) -> Any:
        """Vínculo no escopo e na unidade do bem; devolve a linha (`id`, `room_id?`)."""
        model = _LINK_MODELS[field]
        parsed = _parse_uuid(raw)
        columns = [model.id, model.unit_id, model.active]
        if model is Location:
            columns.append(Location.room_id)
        query = apply_unit_scope(
            self._db.query(*columns).filter(model.id == (parsed or _ZERO_UUID)),
            model.unit_id, actor_id, self._db,
        )
        row = query.first()
        if row is None or parsed is None:
            raise AssetNotFoundError()
        if row.unit_id != unit_id:
            raise AssetLinkMismatchError()
        if not row.active and row.id != current_id:
            raise AssetLinkInactiveError()
        return row

    def _lock_number(self, number: str) -> None:
        acquire_patrimony_lock(self._db, number)  # mesma chave da importação (SEC-AST-01)

    def _number_taken(self, number: str, *, exclude: uuid.UUID | None) -> bool:
        stmt = select(Asset.id).where(
            Asset.deleted_at.is_(None),
            normalized_column(Asset.patrimony_number) == normalize_patrimony_number(number),
        )
        if exclude is not None:
            stmt = stmt.where(Asset.id != exclude)
        return self._db.execute(stmt.limit(1)).first() is not None

    # -- serialização --------------------------------------------------------

    def _serialize_many(self, assets: list[Asset]) -> list[dict[str, Any]]:
        look = _Lookups(self._db, assets)
        return [self._serialize(a, look) for a in assets]

    def _serialize(self, asset: Asset, look: _Lookups) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": str(asset.id),
            "patrimony_number": asset.patrimony_number,
            "description": asset.description,
            "unit_id": str(asset.unit_id),
            "unit": look.units.get(asset.unit_id),
            "owner_unit_id": str(asset.owner_unit_id) if asset.owner_unit_id else None,
            "owner_unit": look.units.get(asset.owner_unit_id),
            "responsible_person_id": str(asset.responsible_person_id) if asset.responsible_person_id else None,
            "responsible_person": look.people.get(asset.responsible_person_id),
            "room_id": str(asset.room_id) if asset.room_id else None,
            "room": look.rooms.get(asset.room_id),
            "location_id": str(asset.location_id) if asset.location_id else None,
            "location": look.locations.get(asset.location_id),
            "located": asset.located,
            "bond_status": asset.bond_status,  # vínculo (da planilha); não é dado pessoal
            "registration_date": _iso(asset.registration_date),
            "created_at": _iso(asset.created_at),
            "updated_at": _iso(asset.updated_at),
            "deleted_at": _iso(asset.deleted_at),
            "version": asset.version,
        }
        if self._can_view_notes:  # ADM/USER; RH não recebe nenhuma destas chaves
            data.update(
                notes=asset.notes,
                assigned_user_id=str(asset.assigned_user_id) if asset.assigned_user_id else None,
                source_record_id=asset.source_record_id,
                source_system=asset.source_system,
                source_updated_at=_iso(asset.source_updated_at),
                created_by=str(asset.created_by) if asset.created_by else None,
                updated_by=str(asset.updated_by) if asset.updated_by else None,
            )
            if self._is_adm:
                data["deleted_by"] = str(asset.deleted_by) if asset.deleted_by else None
        return data

    # -- leitura -------------------------------------------------------------

    def list(self, actor_id: Any, query: Any) -> dict[str, Any]:
        scoped = self._base_query().filter(self._scope(actor_id))
        if not (query.include_deleted == "true" and self._is_adm):
            scoped = scoped.filter(Asset.deleted_at.is_(None))
        if query.q:
            scoped = scoped.filter(
                or_(_like(Asset.patrimony_number, query.q),
                    _like(func.coalesce(Asset.description, ""), query.q))
            )
        scoped = scoped.filter(*asset_filter_clauses(query))
        total = scoped.with_entities(func.count(Asset.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
            .all()
        )
        return {
            "total": int(total), "page": query.page, "page_size": query.page_size,
            "assets": self._serialize_many(list(rows)),
        }

    def bond_statuses(self, actor_id: Any) -> dict[str, Any]:
        """Opções do filtro "Vínculo": grupos sem caixa dos bens NO ESCOPO.

        Só bens não excluídos e com vínculo. `value` = grafia mais frequente do
        grupo (desempate alfabético); no máximo `BOND_STATUS_GROUPS_MAX` grupos
        (os primeiros em ordem alfabética sem caixa). Duas consultas agregadas,
        sem carregar bens.
        """
        key = func.lower(Asset.bond_status)
        base = (Asset.deleted_at.is_(None), Asset.bond_status.is_not(None), self._scope(actor_id))
        keys = [
            row[0] for row in self._db.execute(
                select(key).where(*base).group_by(key).order_by(key).limit(BOND_STATUS_GROUPS_MAX)
            ).all()
        ]
        if not keys:
            return {"items": []}
        groups: dict[str, dict[str, int]] = {}
        rows = self._db.execute(
            select(key, Asset.bond_status, func.count(Asset.id))
            .where(*base, key.in_(keys))
            .group_by(key, Asset.bond_status)
        ).all()
        for group_key, spelling, count in rows:
            groups.setdefault(group_key, {})[spelling] = int(count)
        items = []
        for spellings in groups.values():
            value = min(spellings, key=lambda s: (-spellings[s], s))
            items.append({"value": value, "count": sum(spellings.values())})
        items.sort(key=lambda item: (item["value"].casefold(), item["value"]))
        return {"items": items}

    def get(self, actor_id: Any, asset_id: uuid.UUID, *, include_deleted: bool = False) -> dict[str, Any]:
        asset = self._load(actor_id, asset_id, include_deleted=include_deleted)
        return self._serialize_many([asset])[0]

    def _without_reason(self, values: Any) -> Any:
        """SEC-REV-03: `reason` é texto livre; RH (sem acesso a notas) não o recebe."""
        if self._can_view_notes or not isinstance(values, dict):
            return values
        return {k: v for k, v in values.items() if k != "reason"}

    def history(self, actor_id: Any, asset_id: uuid.UUID, query: Any) -> dict[str, Any]:
        """Trilha do bem (somente leitura); exige poder LER o bem (escopo)."""
        self._load(actor_id, asset_id, include_deleted=query.include_deleted == "true")
        base = select(AuditLog).where(
            AuditLog.entity_type == ENTITY_TYPE, AuditLog.entity_id == str(asset_id)
        )
        total = self._db.execute(
            select(func.count()).select_from(base.subquery())
        ).scalar_one()
        rows = self._db.execute(
            base.order_by(AuditLog.occurred_at.desc(), AuditLog.id)
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
        ).scalars().all()
        entries = []
        for r in rows:
            entry = {
                "id": str(r.id),
                "operation": r.operation,
                "occurred_at": _iso(r.occurred_at),
                "result": r.result,
                "previous_values": self._without_reason(r.previous_values),
                "new_values": self._without_reason(r.new_values),
            }
            if self._can_view_notes:  # SEC-AST-02: RH não recebe autoria (como created_by/updated_by)
                entry["actor_user_id"] = str(r.actor_user_id) if r.actor_user_id else None
            entries.append(entry)
        return {
            "total": int(total), "page": query.page, "page_size": query.page_size,
            "entries": entries,
        }

    # -- escrita -------------------------------------------------------------

    def create(self, actor_id: Any, body: Any) -> dict[str, Any]:
        self._guard_fields(body, _ADM_ONLY_CREATE, self._is_adm)
        unit = self._scoped_unit(actor_id, body.unit_id)
        if not unit.active:
            raise AssetUnitInactiveError()
        owner_id = None
        if body.owner_unit_id is not None:
            owner = self._scoped_unit(actor_id, body.owner_unit_id)
            if not owner.active:
                raise AssetUnitInactiveError()
            owner_id = owner.id
        links: dict[str, Any] = {}
        rows: dict[str, Any] = {}
        for field in _LINK_MODELS:
            raw = getattr(body, field)
            if raw is not None:
                rows[field] = self._resolve_link(actor_id, field, raw, unit.id, None)
                links[field] = rows[field].id
        self._check_location_room(rows.get("location_id"), links.get("room_id"))
        self._lock_number(body.patrimony_number)
        if self._number_taken(body.patrimony_number, exclude=None):
            raise AssetConflictError()
        asset = Asset(
            id=uuid.uuid4(), patrimony_number=body.patrimony_number, description=body.description,
            notes=body.notes, unit_id=unit.id, owner_unit_id=owner_id,
            responsible_person_id=links.get("responsible_person_id"), room_id=links.get("room_id"),
            location_id=links.get("location_id"),
            located=body.located if (self._is_adm and body.located) else _DEFAULT_LOCATED,
            registration_date=body.registration_date, created_by=actor_id, updated_by=actor_id,
            version=1,
        )
        self._db.add(asset)
        self._flush_or_conflict()
        self._audit(
            asset.id, OP_CREATED, actor_id, None,
            {
                "patrimony_number": asset.patrimony_number, "unit_id": str(unit.id),
                "owner_unit_id": _json_value(owner_id), "located": asset.located,
                "changed_fields": sorted(body.model_fields_set),
            },
        )
        return self._serialize_many([asset])[0]

    @staticmethod
    def _check_location_room(location_row: Any, effective_room_id: Any) -> None:
        if location_row is None or effective_room_id is None:
            return
        if location_row.room_id is not None and location_row.room_id != effective_room_id:
            raise AssetLinkMismatchError()

    def update(self, actor_id: Any, asset_id: uuid.UUID, body: Any) -> tuple[dict[str, Any], bool]:
        self._guard_fields(body, _ADM_ONLY_UPDATE, self._is_adm)
        asset = self._load(actor_id, asset_id, for_update=True)
        if asset.version != body.version:
            raise AssetVersionConflictError()
        requested = body.model_fields_set - {"version"}
        changes: dict[str, Any] = {}
        for field in _PLAIN_FIELDS:
            if field in requested and getattr(asset, field) != getattr(body, field):
                changes[field] = getattr(body, field)
        rows: dict[str, Any] = {}
        if "owner_unit_id" in requested:
            raw = body.owner_unit_id
            new_owner = None
            if raw is not None:
                owner = self._scoped_unit(actor_id, raw)
                if owner.id != asset.owner_unit_id and not owner.active:
                    raise AssetUnitInactiveError()
                new_owner = owner.id
            if new_owner != asset.owner_unit_id:
                changes["owner_unit_id"] = new_owner
        for field in _LINK_MODELS:
            if field not in requested:
                continue
            raw = getattr(body, field)
            new_value = None
            if raw is not None:
                rows[field] = self._resolve_link(actor_id, field, raw, asset.unit_id, getattr(asset, field))
                new_value = rows[field].id
            if new_value != getattr(asset, field):
                changes[field] = new_value
        if "location_id" in changes:
            effective_room = changes["room_id"] if "room_id" in changes else asset.room_id
            self._check_location_room(rows.get("location_id"), effective_room)
        elif "room_id" in changes and asset.location_id is not None:
            # Só a sala mudou: o local ATUAL precisa continuar coerente com a nova sala.
            current = self._db.query(Location.id, Location.room_id).filter(
                Location.id == asset.location_id
            ).first()
            self._check_location_room(current, changes["room_id"])
        if not changes:
            return self._serialize_many([asset])[0], False
        if "patrimony_number" in changes:
            self._lock_number(changes["patrimony_number"])
            if self._number_taken(changes["patrimony_number"], exclude=asset.id):
                raise AssetConflictError()
        previous = {f: _json_value(getattr(asset, f)) for f in changes if f != "notes"}
        new = {f: _json_value(v) for f, v in changes.items() if f != "notes"}
        new["changed_fields"] = sorted(changes)  # `notes`: só o nome do campo
        for field, value in changes.items():
            setattr(asset, field, value)
        asset.version = asset.version + 1
        asset.updated_by = actor_id
        self._flush_or_conflict()
        self._audit(asset.id, OP_UPDATED, actor_id, previous, new)
        return self._serialize_many([asset])[0], True

    def delete(self, actor_id: Any, asset_id: uuid.UUID, body: Any) -> dict[str, Any]:
        """Exclusão LÓGICA (`deleted_at`/`deleted_by`); nunca física."""
        asset = self._load(actor_id, asset_id, for_update=True)
        if asset.version != body.version:
            raise AssetVersionConflictError()
        asset.deleted_at = datetime.now(timezone.utc)
        asset.deleted_by = actor_id
        asset.updated_by = actor_id
        asset.version = asset.version + 1
        self._flush_or_conflict()
        new: dict[str, Any] = {"deleted": True}
        if body.reason:
            new["reason"] = body.reason
        self._audit(asset.id, OP_DELETED, actor_id, {"deleted": False}, new)
        return self._serialize_many([asset])[0]

    def restore(self, actor_id: Any, asset_id: uuid.UUID, body: Any) -> dict[str, Any]:
        asset = self._load(actor_id, asset_id, only_deleted=True, for_update=True)
        if asset.version != body.version:
            raise AssetVersionConflictError()
        self._lock_number(asset.patrimony_number)
        if self._number_taken(asset.patrimony_number, exclude=asset.id):
            raise AssetConflictError()
        asset.deleted_at = None
        asset.deleted_by = None
        asset.updated_by = actor_id
        asset.version = asset.version + 1
        self._flush_or_conflict()
        new: dict[str, Any] = {"deleted": False}
        if body.reason:
            new["reason"] = body.reason
        self._audit(asset.id, OP_RESTORED, actor_id, {"deleted": True}, new)
        return self._serialize_many([asset])[0]
