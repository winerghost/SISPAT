"""Schemas Pydantic da API de inventários (`/api/v1/inventories`).

`extra="forbid"` (campo desconhecido -> 400 auditado por `parse_body`).
Campos que NUNCA vêm do cliente (inexistem nos schemas; enviá-los é 400 + evento):
`id`, `status`, `created_by`, `created_at`, `closed_at`, `checked_by`, `checked_at`,
`inventory_id`, `version`, `result`. `unit_id` só na criação, como TEXTO (malformado,
inexistente ou alheio => mesma 404 no serviço). Resultado da conferência = `found` +
`observed_location_id`; "divergente" é derivado pelo servidor.
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator
from app.api.v1.pagination import DEFAULT_PAGE_SIZE, PageSize

from app.api.v1.catalog_schemas import clean_text, collapse_spaces

NAME_MAX = 200
NOTES_MAX = 500
REASON_MAX = 500
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
InventoryStatus = Literal["ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"]
InventorySortKey = Literal[
    "created_at", "-created_at", "name", "-name", "start_date", "-start_date", "status", "-status"
]
ItemResult = Literal["ENCONTRADO", "NAO_ENCONTRADO", "DIVERGENTE"]
ItemSortKey = Literal["checked_at", "-checked_at"]


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("name", "notes", "reason", check_fields=False)
    @classmethod
    def _text(cls, value: str | None) -> str | None:
        return None if value is None else (clean_text(value) or None)


class InventoryCreateRequest(_Body):
    name: str = Field(min_length=1, max_length=NAME_MAX)
    unit_id: str = Field(min_length=1, max_length=64)
    start_date: str | None = Field(default=None, max_length=10)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("name não pode ser vazio")
        return value

    @field_validator("start_date")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not _ISO_DATE_RE.match(value):
            raise ValueError("data deve ser AAAA-MM-DD")
        if date.fromisoformat(value).year < 2000:
            raise ValueError("data inválida")
        return value


class InventoryActionRequest(_Body):
    """start/close/cancel: motivo opcional (só `has_reason` vai para a auditoria)."""

    reason: str | None = Field(default=None, max_length=REASON_MAX)


class InventoryItemCheckRequest(_Body):
    asset_id: str = Field(min_length=1, max_length=64)
    found: StrictBool
    observed_location_id: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=NOTES_MAX)

    @field_validator("observed_location_id")
    @classmethod
    def _loc(cls, value: str | None) -> str | None:
        return value or None

    @model_validator(mode="after")
    def _coherent(self) -> "InventoryItemCheckRequest":
        if not self.found and self.observed_location_id is not None:
            raise ValueError("observed_location_id só vale quando found=true")
        return self


class _Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class InventoryListQuery(_Query):
    q: str | None = Field(default=None, max_length=100)
    unit_id: uuid.UUID | None = None
    status: InventoryStatus | None = None
    sort: InventorySortKey = "-created_at"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE

    @field_validator("q")
    @classmethod
    def _q(cls, value: str | None) -> str | None:
        return None if value is None else (collapse_spaces(value) or None)


class InventoryItemsQuery(_Query):
    result: ItemResult | None = None
    sort: ItemSortKey = "-checked_at"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE


class InventoryGetQuery(_Query):
    """`GET /inventories/<id>` e `/summary`: sem parâmetros."""


__all__ = [
    "InventoryActionRequest",
    "InventoryCreateRequest",
    "InventoryGetQuery",
    "InventoryItemCheckRequest",
    "InventoryItemsQuery",
    "InventoryListQuery",
]
