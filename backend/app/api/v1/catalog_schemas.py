"""Schemas Pydantic dos cadastros de apoio (salas, pessoas responsáveis, unidades).

Mesma política de `app.api.v1.schemas`: `extra="forbid"` (campo desconhecido ->
400 auditado por `parse_body`), limites de tamanho e nenhum eco de valores
nas mensagens. Normalização feita AQUI (fonte única, aplicada antes do serviço):

    - nomes: espaços colapsados, trim, sem caracteres de controle (1..200);
    - e-mail: minúsculo, formato validado (<= 254);
    - telefone: aceita separadores comuns `() - . +` e espaços, mas só
      dígitos são guardados (10..13) -- DADO PESSOAL, só o ADM lê/escreve;
    - `unit_id` de criação chega como TEXTO: valor malformado, inexistente
      ou alheio tem a MESMA resposta (404) no serviço, sem pista de formato.

Campos privilegiados (`id`, `source_record_id`, `created_at`, `updated_at`,
`active`, `deleted_at`, `code`, `unit_id` em atualização...) NÃO existem nos
schemas de edição: enviá-los é rejeitado (400 + evento). `active` muda apenas
pelas ações dedicadas `deactivate`/`activate`.

Em PATCH, campos opcionais podem ser limpos com `null`; `name` não. Ao menos
um campo editável é exigido. `expected_updated_at` (opcional) é a
pré-condição de concorrência (409 `version_conflict` se o registro mudou).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_MAX = 200
EMAIL_MAX = 254
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
_PHONE_SEPARATORS_RE = re.compile(r"[\s().+\-]")
_PHONE_RE = re.compile(r"^[0-9]{10,13}$")
_WS_RE = re.compile(r"\s+")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def collapse_spaces(value: str) -> str:
    return _WS_RE.sub(" ", value).strip()


def clean_text(value: str, *, label: str = "texto") -> str:
    """Trim + espaços colapsados; rejeita caracteres de controle."""
    cleaned = collapse_spaces(value)
    if _CONTROL_RE.search(cleaned):
        raise ValueError(f"{label} contém caracteres inválidos")
    return cleaned


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if len(email) > EMAIL_MAX or not _EMAIL_RE.match(email):
        raise ValueError("e-mail inválido")
    return email


def normalize_phone(value: str) -> str:
    digits = _PHONE_SEPARATORS_RE.sub("", value)
    if not _PHONE_RE.match(digits):
        raise ValueError("telefone inválido")
    return digits


class _CatalogModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# Campos cujo valor vazio ("" após trim) vira NULL (opcionais de texto livre).
def _blank_to_none(value: str | None) -> str | None:
    return value or None


class _TextFields(_CatalogModel):
    """Validadores compartilhados (aplicados só aos campos presentes)."""

    @field_validator("name", "description", "floor", "address", "institutional_identifier",
                     check_fields=False)
    @classmethod
    def _clean(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _blank_to_none(clean_text(value))

    @field_validator("email", check_fields=False)
    @classmethod
    def _email(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return normalize_email(value)

    @field_validator("phone", check_fields=False)
    @classmethod
    def _phone(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return normalize_phone(value)


class _PatchModel(_TextFields):
    """PATCH: ao menos um campo editável; `name` não pode ser nulo/vazio."""

    expected_updated_at: datetime | None = None

    @model_validator(mode="after")
    def _check(self) -> "_PatchModel":
        editable = self.model_fields_set - {"expected_updated_at"}
        if not editable:
            raise ValueError("informe ao menos um campo para alterar")
        if "name" in editable and getattr(self, "name", None) is None:
            raise ValueError("name não pode ser vazio")
        return self


# ---------------------------------------------------------------------------
# Salas
# ---------------------------------------------------------------------------


class RoomCreateRequest(_TextFields):
    unit_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: str | None = Field(default=None, max_length=1000)
    floor: str | None = Field(default=None, max_length=50)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("name não pode ser vazio")
        return value


class RoomUpdateRequest(_PatchModel):
    name: str | None = Field(default=None, max_length=NAME_MAX)
    description: str | None = Field(default=None, max_length=1000)
    floor: str | None = Field(default=None, max_length=50)


# ---------------------------------------------------------------------------
# Pessoas responsáveis
# ---------------------------------------------------------------------------


class PersonCreateRequest(_TextFields):
    unit_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    email: str | None = Field(default=None, max_length=EMAIL_MAX + 64)
    phone: str | None = Field(default=None, max_length=40)
    institutional_identifier: str | None = Field(default=None, max_length=64)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("name não pode ser vazio")
        return value


class PersonUpdateRequest(_PatchModel):
    name: str | None = Field(default=None, max_length=NAME_MAX)
    email: str | None = Field(default=None, max_length=EMAIL_MAX + 64)
    phone: str | None = Field(default=None, max_length=40)
    institutional_identifier: str | None = Field(default=None, max_length=64)


# ---------------------------------------------------------------------------
# Unidades
# ---------------------------------------------------------------------------


class UnitUpdateRequest(_PatchModel):
    name: str | None = Field(default=None, max_length=NAME_MAX)
    description: str | None = Field(default=None, max_length=1000)
    address: str | None = Field(default=None, max_length=500)


# ---------------------------------------------------------------------------
# Ações (inativar / reativar)
# ---------------------------------------------------------------------------


class ActiveActionRequest(_CatalogModel):
    """Corpo (opcional) de `deactivate`/`activate`."""

    reason: str | None = Field(default=None, max_length=500)
    expected_updated_at: datetime | None = None

    @field_validator("reason")
    @classmethod
    def _reason(cls, value: str | None) -> str | None:
        return None if value is None else _blank_to_none(clean_text(value, label="reason"))


# ---------------------------------------------------------------------------
# Consultas (query string; allowlists)
# ---------------------------------------------------------------------------

RoomSortKey = Literal["name", "-name", "created_at", "-created_at", "updated_at", "-updated_at"]
PersonSortKey = Literal[
    "name", "-name", "email", "-email", "created_at", "-created_at", "updated_at", "-updated_at"
]


class _ListQuery(_CatalogModel):
    q: str | None = Field(default=None, max_length=100)
    unit_id: uuid.UUID | None = None
    active: Literal["true", "false"] | None = None
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=25, ge=1, le=100)

    @field_validator("q")
    @classmethod
    def _q(cls, value: str | None) -> str | None:
        return None if value is None else (collapse_spaces(value) or None)


class RoomListQuery(_ListQuery):
    sort: RoomSortKey = "name"


class PersonListQuery(_ListQuery):
    sort: PersonSortKey = "name"


UnitSortKey = Literal["name", "-name", "code", "-code", "updated_at", "-updated_at"]


class UnitListQuery(_CatalogModel):
    """`GET /units/catalog`: `active=all` (padrão) inclui inativas (para reativar)."""

    q: str | None = Field(default=None, max_length=100)
    active: Literal["true", "false", "all"] = "all"
    sort: UnitSortKey = "name"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=25, ge=1, le=100)

    @field_validator("q")
    @classmethod
    def _q(cls, value: str | None) -> str | None:
        return None if value is None else (collapse_spaces(value) or None)


__all__: list[Any] = [
    "UnitListQuery",
    "ActiveActionRequest",
    "PersonCreateRequest",
    "PersonListQuery",
    "PersonUpdateRequest",
    "RoomCreateRequest",
    "RoomListQuery",
    "RoomUpdateRequest",
    "UnitUpdateRequest",
    "clean_text",
    "collapse_spaces",
    "normalize_email",
    "normalize_phone",
]
