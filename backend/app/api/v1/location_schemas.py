"""Schemas de consulta de locais (`GET /api/v1/locations`): allowlists, `extra="forbid"`."""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.v1.catalog_schemas import collapse_spaces

LocationSortKey = Literal["name", "-name", "created_at", "-created_at", "updated_at", "-updated_at"]


class _Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LocationListQuery(_Query):
    q: str | None = Field(default=None, max_length=100)
    unit_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    active: Literal["true", "false"] | None = None
    sort: LocationSortKey = "name"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=25, ge=1, le=100)

    @field_validator("q")
    @classmethod
    def _q(cls, value: str | None) -> str | None:
        return None if value is None else (collapse_spaces(value) or None)


class LocationGetQuery(_Query):
    """`GET /locations/<id>`: sem parâmetros."""


__all__ = ["LocationGetQuery", "LocationListQuery"]
