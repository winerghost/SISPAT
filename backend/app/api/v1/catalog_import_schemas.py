"""Schemas Pydantic (`extra="forbid"`) da API de importação dos cadastros de apoio.

Mesma política de `app.api.v1.schemas`: campo desconhecido -> 400 auditado
(`parse_body`/`parse_query`), mensagens citam só NOMES de campo. `kind`
nunca vem do corpo: é a allowlist da rota (`CATALOG_KINDS`).
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field, field_validator

from app.api.v1.schemas import _StrictModel

CATALOG_KINDS = ("units", "rooms", "people")

# Permissão exigida para operar cada cadastro (além de ADM + AAL2).
KIND_PERMISSION: dict[str, str] = {
    "units": "units.update",
    "rooms": "rooms.manage",
    "people": "responsible.manage",
}

CatalogItemSort = Literal[
    "label",
    "-label",
    "classification",
    "-classification",
    "source_id",
    "-source_id",
]


class CatalogConfirmRequest(_StrictModel):
    """Corpo de `POST /catalog-imports/<preview_id>/confirm` (mesmo limite de bens)."""

    item_ids: list[uuid.UUID] = Field(max_length=10000)
    # Opt-in explícito (SEC-CAT-04): só estes itens de UNIDADES criam alias de sigla.
    alias_item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10000)


class CatalogItemsQuery(_StrictModel):
    """Query string de `GET /catalog-imports/<preview_id>/items` (allowlist)."""

    status: str | None = Field(default=None, max_length=32)
    search: str | None = Field(default=None, max_length=100)
    sort: CatalogItemSort = "label"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=25, ge=1, le=100)

    @field_validator("status", "search", mode="after")
    @classmethod
    def _blank_to_none(cls, value: str | None) -> str | None:
        return value or None
