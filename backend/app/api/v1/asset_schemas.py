"""Schemas Pydantic da API de patrimônios (`/api/v1/assets`).

Mesma política de `app.api.v1.schemas`: `extra="forbid"` (campo desconhecido ->
400 auditado por `parse_body`), limites de tamanho e nenhum eco de valores.

Campos que NUNCA vêm do cliente (inexistentes nos schemas de escrita; enviá-los
é 400 + evento): `id`, `version` em criação, `source_*`, `created_*`,
`updated_*`, `deleted_*`, `assigned_user_id`. `unit_id` só existe na CRIAÇÃO (o
bem não troca de unidade por esta API; isso é movimentação).

Vínculos (`unit_id`, `owner_unit_id`, `room_id`, `location_id`,
`responsible_person_id`) chegam como TEXTO: valor malformado, inexistente ou
alheio tem a MESMA resposta (404) no serviço, sem pista de formato.

Campos por perfil (aplicado no serviço, não aqui): `owner_unit_id`, `located` e
`patrimony_number` (em edição) só o ADM pode enviar.

PATCH: `version` obrigatório (controle otimista); `null` limpa campos opcionais.
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator
from app.api.v1.pagination import DEFAULT_PAGE_SIZE, PageSize

from app.api.v1.catalog_schemas import clean_text, collapse_spaces
from app.services.import_normalizer import BOND_STATUS_MAX

PATRIMONY_MAX = 64
TEXT_MAX = 2000
LocatedStatus = Literal["SIM", "NAO", "DESCONHECIDO"]
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_VERSION = Field(ge=1, le=2_147_483_647)
_LINK_FIELDS = ("owner_unit_id", "responsible_person_id", "room_id", "location_id")


class _AssetModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("patrimony_number", check_fields=False)
    @classmethod
    def _patrimony(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = clean_text(value, label="patrimony_number")
        if not cleaned:
            raise ValueError("patrimony_number não pode ser vazio")
        return cleaned

    @field_validator("description", "notes", "reason", check_fields=False)
    @classmethod
    def _free_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return clean_text(value) or None

    @field_validator(*_LINK_FIELDS, "unit_id", check_fields=False)
    @classmethod
    def _link(cls, value: str | None) -> str | None:
        return value or None

    @field_validator("registration_date", mode="before", check_fields=False)
    @classmethod
    def _date(cls, value: Any) -> Any:
        if value is None:
            return None
        if not isinstance(value, str) or not _ISO_DATE_RE.match(value.strip()):
            raise ValueError("registration_date deve ser AAAA-MM-DD")
        parsed = date.fromisoformat(value.strip())
        if parsed.year < 1900:
            raise ValueError("registration_date inválida")
        return parsed


class AssetCreateRequest(_AssetModel):
    unit_id: str = Field(min_length=1, max_length=64)
    patrimony_number: str = Field(min_length=1, max_length=PATRIMONY_MAX)
    description: str | None = Field(default=None, max_length=TEXT_MAX)
    notes: str | None = Field(default=None, max_length=TEXT_MAX)
    owner_unit_id: str | None = Field(default=None, max_length=64)
    responsible_person_id: str | None = Field(default=None, max_length=64)
    room_id: str | None = Field(default=None, max_length=64)
    location_id: str | None = Field(default=None, max_length=64)
    located: LocatedStatus | None = None
    registration_date: date | None = None


class AssetUpdateRequest(_AssetModel):
    """Edição parcial; `version` é a pré-condição obrigatória."""

    version: StrictInt = _VERSION
    patrimony_number: str | None = Field(default=None, max_length=PATRIMONY_MAX)
    description: str | None = Field(default=None, max_length=TEXT_MAX)
    notes: str | None = Field(default=None, max_length=TEXT_MAX)
    owner_unit_id: str | None = Field(default=None, max_length=64)
    responsible_person_id: str | None = Field(default=None, max_length=64)
    room_id: str | None = Field(default=None, max_length=64)
    location_id: str | None = Field(default=None, max_length=64)
    located: LocatedStatus | None = None
    registration_date: date | None = None

    @model_validator(mode="after")
    def _check(self) -> "AssetUpdateRequest":
        editable = self.model_fields_set - {"version"}
        if not editable:
            raise ValueError("informe ao menos um campo para alterar")
        for required in ("patrimony_number", "located"):
            if required in editable and getattr(self, required) is None:
                raise ValueError(f"{required} não pode ser nulo")
        return self


class AssetActionRequest(_AssetModel):
    """Corpo de `delete`/`restore`: `version` obrigatório, `reason` opcional."""

    version: StrictInt = _VERSION
    reason: str | None = Field(default=None, max_length=500)


# ---------------------------------------------------------------------------
# Consultas (query string; allowlists)
# ---------------------------------------------------------------------------

AssetSortKey = Literal[
    "patrimony_number", "-patrimony_number", "description", "-description",
    "created_at", "-created_at", "updated_at", "-updated_at",
    "bond_status", "-bond_status",
]


class _Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    include_deleted: Literal["true", "false"] = "false"


class AssetListQuery(_Query):
    q: str | None = Field(default=None, max_length=100)
    unit_id: uuid.UUID | None = None
    owner_unit_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    responsible_person_id: uuid.UUID | None = None
    located: LocatedStatus | None = None
    # Vínculo: comparação exata sem caixa; `__none__` = sem vínculo
    # (`bond_status IS NULL`). Nunca aceito em criação/edição (vem da planilha).
    bond_status: str | None = Field(default=None, min_length=1, max_length=BOND_STATUS_MAX)
    sort: AssetSortKey = "patrimony_number"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE

    @field_validator("q")
    @classmethod
    def _q(cls, value: str | None) -> str | None:
        return None if value is None else (collapse_spaces(value) or None)

    @field_validator("bond_status")
    @classmethod
    def _bond_status(cls, value: str | None) -> str | None:
        return clean_bond_status_filter(value)


def clean_bond_status_filter(value: str | None) -> str | None:
    """Regra única do filtro de vínculo (lista de bens e dashboard).

    Trim + espaços colapsados; controle => erro; vazio => erro. `__none__`
    passa como está (o serviço o traduz para `bond_status IS NULL`).
    """
    if value is None:
        return None
    cleaned = clean_text(value, label="bond_status")  # rejeita controle
    if not cleaned:
        raise ValueError("bond_status não pode ser vazio")
    return cleaned


class AssetBondStatusQuery(BaseModel):
    """`GET /assets/bond-statuses`: sem parâmetros (qualquer um => 400)."""

    model_config = ConfigDict(extra="forbid")


class AssetGetQuery(_Query):
    """`GET /assets/<id>`: só `include_deleted` (ADM)."""


class AssetHistoryQuery(_Query):
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE


__all__ = [
    "AssetActionRequest",
    "AssetBondStatusQuery",
    "AssetCreateRequest",
    "AssetGetQuery",
    "AssetHistoryQuery",
    "AssetListQuery",
    "AssetUpdateRequest",
    "LocatedStatus",
    "clean_bond_status_filter",
]
