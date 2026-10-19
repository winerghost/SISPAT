"""Schemas de consulta (query string) das APIs administrativas de LEITURA.

Cobre `GET /api/v1/admin/audit-logs`, `GET /api/v1/admin/unit-access` e as
rotas sem parâmetros (`/admin/roles`, `/admin/permissions`, detalhe de log).
Mesma política de `app.api.v1.schemas.parse_query`: `extra="forbid"`
(parâmetro desconhecido -> 400 auditado), parâmetro repetido -> 400, valores
nunca ecoados. Filtros são validados por FORMA (padrões restritos) ou
enumeração fechada e SEMPRE chegam ao banco como parâmetros vinculados.

`from`/`to` são palavras reservadas/curtas demais para campos Python: os
campos internos são `from_`/`to_` e `parse_admin_query` traduz os nomes
públicos. Depois da validação os dois estão SEMPRE preenchidos (janela
resolvida e limitada a `MAX_WINDOW`).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from werkzeug.datastructures import MultiDict
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import parse_query

# Janela máxima consultável de uma vez e janela padrão (últimos 30 dias).
MAX_WINDOW = timedelta(days=90)
DEFAULT_WINDOW = timedelta(days=30)

EVENT_TYPE_PATTERN = r"^[A-Z][A-Z0-9_]{1,63}$"
ENTITY_TYPE_PATTERN = r"^[a-z][a-z0-9_]{1,39}$"
ENTITY_ID_PATTERN = r"^[A-Za-z0-9_.:\-]{1,100}$"

SEVERITIES = ("low", "medium", "high", "critical")

_PUBLIC_TO_INTERNAL = {"from": "from_", "to": "to_"}
_INTERNAL_NAME_RE = re.compile(r"\b(from|to)_(?=[,.]|$)")


class _ReadModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class NoQuery(_ReadModel):
    """Rotas sem parâmetros: qualquer parâmetro -> 400 auditado."""


class PageFields(_ReadModel):
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=25, ge=1, le=100)


def _parse_utc(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        if not isinstance(value, str) or not 1 <= len(value) <= 40:
            raise ValueError("data inválida")
        text = value.strip()
        if text[-1:] in {"Z", "z"}:
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
    try:
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (OverflowError, ValueError) as exc:
        raise ValueError("data inválida") from exc


class AuditListQuery(PageFields):
    """Query string de `GET /api/v1/admin/audit-logs` (allowlist)."""

    event_type: str | None = Field(default=None, pattern=EVENT_TYPE_PATTERN)
    entity_type: str | None = Field(default=None, pattern=ENTITY_TYPE_PATTERN)
    entity_id: str | None = Field(default=None, pattern=ENTITY_ID_PATTERN)
    actor_user_id: uuid.UUID | None = None
    from_: datetime | None = None
    to_: datetime | None = None
    result: Literal["SUCESSO", "FALHA"] | None = None
    severity: Literal["low", "medium", "high", "critical"] | None = None
    sort: Literal["occurred_at", "-occurred_at"] = "-occurred_at"

    @field_validator("from_", "to_", mode="before")
    @classmethod
    def _utc(cls, value: Any) -> datetime | None:
        return None if value is None else _parse_utc(value)

    @model_validator(mode="after")
    def _resolve_window(self) -> "AuditListQuery":
        end = self.to_ or datetime.now(timezone.utc)
        start = self.from_ or end - DEFAULT_WINDOW
        if start > end:
            raise ValueError("from deve ser anterior a to")
        if end - start > MAX_WINDOW:
            raise ValueError("janela máxima excedida")
        self.from_, self.to_ = start, end
        return self


class UnitAccessQuery(PageFields):
    """Query string de `GET /api/v1/admin/unit-access` (allowlist)."""

    unit_id: uuid.UUID | None = None
    role: Literal["ADM", "USER", "RH"] | None = None
    active: Literal["true", "false"] | None = None
    sort: Literal["name", "-name"] = "name"


def parse_admin_query(model: type, args: Any, *, context: str):
    """`parse_query` com tradução `from`/`to` -> `from_`/`to_`.

    Os nomes internos digitados pelo cliente (`from_`, `to_`) NÃO são aceitos
    (viram desconhecidos -> 400 auditado). Erros de validação citam os nomes
    públicos.
    """
    renamed: MultiDict = MultiDict()
    for key, values in args.lists():
        if key in _PUBLIC_TO_INTERNAL.values():
            new_key = f"{key}(invalid)"
        else:
            new_key = _PUBLIC_TO_INTERNAL.get(key, key)
        for value in values:
            renamed.add(new_key, value)
    try:
        return parse_query(model, renamed, context=context)
    except BadRequest as exc:
        if isinstance(exc.description, str):
            exc.description = _INTERNAL_NAME_RE.sub(r"\1", exc.description)
        raise
