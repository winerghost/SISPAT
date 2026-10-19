"""Unidades do ESCOPO do usuário autenticado (qualquer perfil com `units.read`).

Alimenta os seletores de unidade do frontend (filtros e formulários de
patrimônio). Só `id`, `code`, `name`, `active` -- nunca `address`,
`source_record_id` ou dados administrativos --, apenas unidades presentes em
`user_unit_access` do próprio usuário (`apply_unit_scope`), ordenadas por `code`.
Escopo vazio => lista vazia (negar por padrão).
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.authorization.rbac import apply_unit_scope
from app.models.units import Unit


def list_accessible_units(db: Session, actor_id: Any) -> dict[str, Any]:
    query = apply_unit_scope(
        db.query(Unit.id, Unit.code, Unit.name, Unit.active), Unit.id, actor_id, db
    )
    rows = query.order_by(Unit.code, Unit.id).all()
    return {
        "units": [
            {"id": str(r.id), "code": r.code, "name": r.name, "active": bool(r.active)}
            for r in rows
        ]
    }
