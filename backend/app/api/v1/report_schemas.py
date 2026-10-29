"""Schemas Pydantic (query string) da API de relatórios `/api/v1/reports`.

Mesma política de `app.api.v1.schemas.parse_query`: `extra="forbid"` (parâmetro
desconhecido -> 400 auditado; nomes privilegiados como `role`/`deleted_at`
geram `PRIVILEGE_ESCALATION_ATTEMPT`), parâmetro repetido -> 400 e nenhum valor
enviado é ecoado. Filtros e ordenação são ALLOWLISTS fechadas.

Identificadores de unidade, inventário, SALA e RESPONSÁVEL chegam como TEXTO:
malformado, inexistente ou alheio têm a MESMA resposta (404) no serviço, sem
pista de formato (o `<select>` da tela é conveniência, não validação).
"""
from __future__ import annotations

import re
from datetime import date
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.api.v1.asset_schemas import LocatedStatus, clean_bond_status_filter
from app.api.v1.catalog_schemas import collapse_spaces
from app.services.import_normalizer import BOND_STATUS_MAX

ReportKind = Literal["assets", "movements", "inventory-items"]
REPORT_KINDS: tuple[str, ...] = get_args(ReportKind)
ExportFormat = Literal["csv", "xlsx"]

AssetReportSort = Literal[
    "patrimony_number", "-patrimony_number", "description", "-description",
    "created_at", "-created_at", "updated_at", "-updated_at", "bond_status", "-bond_status",
]
MovementReportSort = Literal["created_at", "-created_at", "status", "-status"]
InventoryItemReportSort = Literal[
    "checked_at", "-checked_at", "patrimony_number", "-patrimony_number", "result", "-result"
]
MovementStatus = Literal["PENDENTE", "APROVADA", "REJEITADA", "CONCLUIDA", "CANCELADA"]
MovementType = Literal["TRANSFERENCIA_UNIDADE", "MUDANCA_SALA", "TROCA_RESPONSAVEL"]
InventoryStatus = Literal["ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"]
InventoryItemResult = Literal["ENCONTRADO", "NAO_ENCONTRADO", "DIVERGENTE"]

COLUMNS_PARAM_MAX = 512  # ~15 chaves de até 30 caracteres + vírgulas, com folga

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class _ReportQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    format: ExportFormat = "csv"
    # Chaves separadas por vírgula; validadas contra o catálogo do relatório no serviço
    # (`ReportService.resolve_columns`). Limite de tamanho aqui; ausente => todas.
    columns: str | None = Field(default=None, max_length=COLUMNS_PARAM_MAX)


def _iso_date(value: str | None) -> str | None:
    if value is None:
        return None
    if not _ISO_DATE_RE.match(value):
        raise ValueError("data deve ser AAAA-MM-DD")
    parsed = date.fromisoformat(value)  # ValueError -> 400
    if parsed.year < 1900:
        raise ValueError("data inválida")
    return value


class AssetReportQuery(_ReportQuery):
    q: str | None = Field(default=None, max_length=100)
    unit_id: str | None = Field(default=None, min_length=1, max_length=64)
    owner_unit_id: str | None = Field(default=None, min_length=1, max_length=64)
    # Sala/responsável chegam como TEXTO (como unidade/inventário): malformado,
    # inexistente ou de unidade alheia têm a MESMA 404 no serviço, sem oráculo.
    room_id: str | None = Field(default=None, min_length=1, max_length=64)
    responsible_person_id: str | None = Field(default=None, min_length=1, max_length=64)
    located: LocatedStatus | None = None
    bond_status: str | None = Field(default=None, min_length=1, max_length=BOND_STATUS_MAX)
    include_deleted: Literal["true", "false"] = "false"
    sort: AssetReportSort = "patrimony_number"

    @field_validator("q")
    @classmethod
    def _q(cls, value: str | None) -> str | None:
        return None if value is None else (collapse_spaces(value) or None)

    @field_validator("bond_status")
    @classmethod
    def _bond(cls, value: str | None) -> str | None:
        return clean_bond_status_filter(value)


class MovementReportQuery(_ReportQuery):
    status: MovementStatus | None = None
    movement_type: MovementType | None = None
    origin_unit_id: str | None = Field(default=None, min_length=1, max_length=64)
    destination_unit_id: str | None = Field(default=None, min_length=1, max_length=64)
    created_from: str | None = Field(default=None, max_length=10)
    created_to: str | None = Field(default=None, max_length=10)
    include_deleted: Literal["true", "false"] = "false"
    sort: MovementReportSort = "-created_at"

    @field_validator("created_from", "created_to")
    @classmethod
    def _dates(cls, value: str | None) -> str | None:
        return _iso_date(value)

    @model_validator(mode="after")
    def _ordered(self) -> "MovementReportQuery":
        if self.created_from and self.created_to and self.created_from > self.created_to:
            raise ValueError("intervalo de datas invertido")
        return self


class InventoryItemReportQuery(_ReportQuery):
    inventory_id: str | None = Field(default=None, min_length=1, max_length=64)
    unit_id: str | None = Field(default=None, min_length=1, max_length=64)
    inventory_status: InventoryStatus | None = None
    result: InventoryItemResult | None = None
    checked_from: str | None = Field(default=None, max_length=10)
    checked_to: str | None = Field(default=None, max_length=10)
    include_deleted: Literal["true", "false"] = "false"
    sort: InventoryItemReportSort = "-checked_at"

    @field_validator("checked_from", "checked_to")
    @classmethod
    def _dates(cls, value: str | None) -> str | None:
        return _iso_date(value)

    @model_validator(mode="after")
    def _ordered(self) -> "InventoryItemReportQuery":
        if self.checked_from and self.checked_to and self.checked_from > self.checked_to:
            raise ValueError("intervalo de datas invertido")
        return self


class ReportCatalogQuery(BaseModel):
    """`GET /reports`: sem parâmetros (qualquer um -> 400 auditado)."""

    model_config = ConfigDict(extra="forbid")


QUERY_MODELS: dict[str, type[_ReportQuery]] = {
    "assets": AssetReportQuery,
    "movements": MovementReportQuery,
    "inventory-items": InventoryItemReportQuery,
}
SORT_KEYS: dict[str, tuple[str, ...]] = {
    "assets": get_args(AssetReportSort),
    "movements": get_args(MovementReportSort),
    "inventory-items": get_args(InventoryItemReportSort),
}

__all__ = [
    "AssetReportQuery",
    "InventoryItemReportQuery",
    "MovementReportQuery",
    "QUERY_MODELS",
    "REPORT_KINDS",
    "ReportCatalogQuery",
    "SORT_KEYS",
]
