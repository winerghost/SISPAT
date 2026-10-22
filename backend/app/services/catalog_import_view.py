"""Leitura paginada e projeção SEGURA dos itens de prévias de cadastros.

Somente leitura. A projeção é uma ALLOWLIST: `raw_values` e
`normalized_values` completos nunca saem daqui. Em especial, o telefone
(dado pessoal, LGPD) NUNCA é devolvido — só `has_phone` — e o e-mail sai
mascarado (`a***@dominio`), nunca completo.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.imports import ImportPreviewItem
from app.services.pagination import coerce_page_size, page_count
from app.security.text_search import contains_ci

_CLASSIFICATIONS = frozenset({"NOVO", "EXISTENTE", "DUPLICADO", "INVALIDO", "CONFLITANTE"})

_SORT_COLUMNS = {
    "label": ImportPreviewItem.description,
    "classification": ImportPreviewItem.classification,
    "source_id": ImportPreviewItem.source_record_id,
}

# Campos de `normalized_values` expostos (texto não pessoal ou nome já visível no cadastro).
_COMMON_FIELDS = ("unidade_sigla",)
_KIND_FIELDS: dict[str, tuple[str, ...]] = {
    "units": ("unit_code", "unit_name", "create_alias"),
    "rooms": ("room_name", "probable_duplicate"),
    "people": ("person_name", "suspect"),
}


def mask_email(email: Any) -> str | None:
    """`maria.silva@agu.gov.br` -> `m***@agu.gov.br` (nunca o e-mail completo)."""
    if not isinstance(email, str) or "@" not in email:
        return None
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}" if local and domain else None


def serialize_item(kind: str, item: ImportPreviewItem) -> dict[str, Any]:
    nv = item.normalized_values or {}
    details: dict[str, Any] = {
        name: nv.get(name) for name in (*_COMMON_FIELDS, *_KIND_FIELDS.get(kind, ()))
    }
    if kind == "people":
        details["email_masked"] = mask_email(nv.get("email"))
        details["has_email"] = bool(nv.get("email"))
        details["has_phone"] = bool(nv.get("phone"))
    errors = [e for e in (item.validation_errors or []) if isinstance(e, str)]
    return {
        "id": str(item.id),
        "row": nv.get("_row"),
        "source_record_id": item.source_record_id,
        "label": item.description,
        "classification": item.classification,
        "selected": bool(item.selected),
        "existing": bool(nv.get("existing_id")),
        "id_conflict": bool(nv.get("id_conflict")),
        "pendencias": [p for p in (nv.get("_pend") or []) if isinstance(p, str)],
        "validation_errors": errors,
        "details": details,
    }


def list_items(
    db: Session,
    preview_id: uuid.UUID,
    *,
    status: str | None,
    search: str | None,
    sort: str,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    """Itens da prévia (já validada/autorizada pelo chamador), com filtros por allowlist."""
    page = max(page, 1)
    page_size = coerce_page_size(page_size)
    normalized = status.strip().upper() if isinstance(status, str) else None
    if normalized and normalized not in _CLASSIFICATIONS:
        return {"total": 0, "page": page, "page_size": page_size, "pages": 0, "items": []}

    conditions = [ImportPreviewItem.preview_id == preview_id]
    if normalized:
        conditions.append(ImportPreviewItem.classification == normalized)
    term = search.strip()[:100] if isinstance(search, str) else ""
    if term:
        conditions.append(
            contains_ci(ImportPreviewItem.description, term)
            | contains_ci(ImportPreviewItem.source_record_id, term)
        )

    descending = sort.startswith("-")
    column = _SORT_COLUMNS[sort.lstrip("-")]
    order = column.desc() if descending else column.asc()

    total = db.execute(select(func.count()).select_from(ImportPreviewItem).where(*conditions)).scalar_one()
    rows = (
        db.execute(
            select(ImportPreviewItem)
            .where(*conditions)
            .order_by(order, ImportPreviewItem.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return {"total": int(total), "page": page, "page_size": page_size, "pages": page_count(total, page_size), "items": list(rows)}
