"""Schemas Pydantic da API de movimentações (`/api/v1/movements`).

`extra="forbid"` (campo desconhecido -> 400 auditado por `parse_body`).

Campos que NUNCA vêm do cliente (inexistem nos schemas; enviá-los é 400 + evento):
`id`, `status`, `movement_type`, `origin_*`, `previous_responsible_id`,
`requested_by`, `approved_by`, `*_at`. A origem e o tipo são derivados do bem pelo
servidor. Vínculos chegam como TEXTO: malformado, inexistente ou alheio tem a mesma
resposta (404) no serviço.
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator
from app.api.v1.pagination import DEFAULT_PAGE_SIZE, PageSize

from app.api.v1.catalog_schemas import clean_text

REASON_MAX = 500
_VERSION = Field(ge=1, le=2_147_483_647)
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MovementStatus = Literal["PENDENTE", "APROVADA", "REJEITADA", "CONCLUIDA", "CANCELADA"]
MovementType = Literal["TRANSFERENCIA_UNIDADE", "MUDANCA_SALA", "TROCA_RESPONSAVEL"]
MovementSortKey = Literal["created_at", "-created_at", "status", "-status"]


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("reason", check_fields=False)
    @classmethod
    def _reason(cls, value: str | None) -> str | None:
        return None if value is None else (clean_text(value) or None)

    @field_validator(
        "asset_id", "destination_unit_id", "destination_room_id", "new_responsible_id",
        check_fields=False,
    )
    @classmethod
    def _link(cls, value: str | None) -> str | None:
        return value or None


class MovementCreateRequest(_Body):
    """Solicitação. Ausente/`null` em sala/responsável: ver `docs/architecture/movements-api.md`."""

    asset_id: str = Field(min_length=1, max_length=64)
    asset_version: StrictInt = _VERSION
    destination_unit_id: str = Field(min_length=1, max_length=64)
    destination_room_id: str | None = Field(default=None, max_length=64)
    new_responsible_id: str | None = Field(default=None, max_length=64)
    reason: str | None = Field(default=None, max_length=REASON_MAX)


class MovementApproveRequest(_Body):
    """Aprovação: `asset_version` = versão do bem que o aprovador está vendo."""

    asset_version: StrictInt = _VERSION


class MovementDecisionRequest(_Body):
    """Rejeição/cancelamento: motivo opcional (vai só para a auditoria)."""

    reason: str | None = Field(default=None, max_length=REASON_MAX)


class _Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class MovementListQuery(_Query):
    status: MovementStatus | None = None
    movement_type: MovementType | None = None
    asset_id: uuid.UUID | None = None
    origin_unit_id: uuid.UUID | None = None
    destination_unit_id: uuid.UUID | None = None
    created_from: str | None = Field(default=None, max_length=10)
    created_to: str | None = Field(default=None, max_length=10)
    sort: MovementSortKey = "-created_at"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE

    @field_validator("created_from", "created_to")
    @classmethod
    def _date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not _ISO_DATE_RE.match(value):
            raise ValueError("data deve ser AAAA-MM-DD")
        parsed = date.fromisoformat(value)
        if parsed.year < 1900:
            raise ValueError("data inválida")
        return value


class MovementGetQuery(_Query):
    """`GET /movements/<id>`: sem parâmetros."""


__all__ = [
    "MovementApproveRequest",
    "MovementCreateRequest",
    "MovementDecisionRequest",
    "MovementGetQuery",
    "MovementListQuery",
]
