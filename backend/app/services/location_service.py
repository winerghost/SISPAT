"""Locais de guarda (`locations`): somente leitura, com escopo de unidade.

Alvo inexistente, malformado ou alheio => `NotFoundError` (mesma 404). Gravação de
locais não faz parte deste contrato (ver `docs/architecture/cadastros-apoio-api.md`).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.authorization.rbac import apply_unit_scope
from app.models.units import Location
from app.security.sanitize import LIKE_ESCAPE_CHAR, escape_like
from app.services.catalog_service import NotFoundError, _iso

_SORTS = {
    "name": (func.lower(Location.name), Location.id),
    "-name": (func.lower(Location.name).desc(), Location.id),
    "created_at": (Location.created_at, Location.id),
    "-created_at": (Location.created_at.desc(), Location.id),
    "updated_at": (Location.updated_at, Location.id),
    "-updated_at": (Location.updated_at.desc(), Location.id),
}


def serialize_location(loc: Location) -> dict[str, Any]:
    return {
        "id": str(loc.id),
        "unit_id": str(loc.unit_id),
        "room_id": str(loc.room_id) if loc.room_id else None,
        "name": loc.name,
        "description": loc.description,
        "active": bool(loc.active),
        "created_at": _iso(loc.created_at),
        "updated_at": _iso(loc.updated_at),
    }


class LocationService:
    def __init__(self, db: Session) -> None:
        self._db = db

    def _scoped(self, actor_id: Any):
        return apply_unit_scope(self._db.query(Location), Location.unit_id, actor_id, self._db)

    def list(self, actor_id: Any, query: Any) -> dict[str, Any]:
        scoped = self._scoped(actor_id)
        if query.q:
            scoped = scoped.filter(
                Location.name.ilike(f"%{escape_like(query.q)}%", escape=LIKE_ESCAPE_CHAR)
            )
        if query.unit_id is not None:
            scoped = scoped.filter(Location.unit_id == query.unit_id)
        if query.room_id is not None:
            scoped = scoped.filter(Location.room_id == query.room_id)
        if query.active is not None:
            scoped = scoped.filter(Location.active.is_(query.active == "true"))
        total = scoped.with_entities(func.count(Location.id)).order_by(None).scalar()
        rows = (
            scoped.order_by(*_SORTS[query.sort])
            .offset((query.page - 1) * query.page_size)
            .limit(query.page_size)
            .all()
        )
        return {"total": int(total), "page": query.page, "page_size": query.page_size,
                "locations": [serialize_location(r) for r in rows]}

    def get(self, actor_id: Any, location_id: uuid.UUID) -> dict[str, Any]:
        loc = self._scoped(actor_id).filter(Location.id == location_id).first()
        if loc is None:
            raise NotFoundError()
        return serialize_location(loc)
