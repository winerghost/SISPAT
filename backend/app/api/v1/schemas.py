"""Schemas Pydantic de entrada da API v1 (validação estrita de payloads).

Princípios (OWASP API3:2023 / API6:2023 — mass assignment):
    - `extra="forbid"`: QUALQUER campo não previsto no contrato é rejeitado
      com 400 — nunca ignorado silenciosamente. Campos privilegiados
      (`role`, `is_admin`, `permissions`, `unit_id`, `created_by`,
      `deleted_at`, `owner_unit_id`, ...) enviados pelo cliente geram, além
      do 400, um evento `PRIVILEGE_ESCALATION_ATTEMPT` em `audit_logs`.
    - Limites de tamanho em todos os campos de texto e listas.
    - Mensagens de erro citam apenas NOMES de campos, nunca valores
      enviados (sem reflexão de entrada do cliente).
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal, TypeVar

from flask import abort
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
    field_validator,
    model_validator,
)

from app.authorization.security_events import (
    EVENT_MASS_ASSIGNMENT_REJECTED,
    EVENT_PRIVILEGE_ESCALATION_ATTEMPT,
    SEVERITY_HIGH,
    SEVERITY_LOW,
    record_security_event,
)

# Nomes de campos cuja simples presença em um corpo não previsto indica
# tentativa de escalonamento de privilégio / alteração de escopo/autoria.
PRIVILEGED_FIELD_NAMES = frozenset(
    {
        "role",
        "roles",
        "role_code",
        "role_id",
        "intended_role_code",
        "is_admin",
        "admin",
        "is_superuser",
        "permissions",
        "permission",
        "unit_id",
        "unit_ids",
        "units",
        "owner_unit_id",
        "created_by",
        "updated_by",
        "deleted_at",
        "deleted_by",
        "invited_by",
        "user_id",
        "auth_user_id",
        "active",
        "status",
        "aal",
        # Configuração de IA: chaves vivem só no ambiente do backend e o
        # aceite DeepSeek/autoria são gravados pelo servidor.
        "api_key",
        "openai_api_key",
        "anthropic_api_key",
        "deepseek_api_key",
        "deepseek_acknowledged_at",
        "deepseek_acknowledged_by",
    }
)

_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
_MAX_EMAIL_LEN = 254
_MAX_FIELD_NAMES_IN_MESSAGE = 10

ModelT = TypeVar("ModelT", bound=BaseModel)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class InviteRequest(_StrictModel):
    """Corpo de `POST /api/v1/users/invite`."""

    email: str = Field(min_length=3, max_length=_MAX_EMAIL_LEN)
    name: str = Field(min_length=1, max_length=200)
    intended_role_code: str = Field(min_length=1, max_length=32)
    unit_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    justification: str | None = Field(default=None, max_length=2000)

    @field_validator("email")
    @classmethod
    def _validate_email(cls, value: str) -> str:
        if not _EMAIL_RE.match(value):
            raise ValueError("e-mail inválido")
        return value


class RevokeRequest(_StrictModel):
    """Corpo (opcional) de `POST /api/v1/users/<id>/revoke`."""

    reason: str | None = Field(default=None, max_length=1000)


class ConfirmImportRequest(_StrictModel):
    """Corpo de `POST /api/v1/imports/google-sheets/confirm`."""

    preview_id: uuid.UUID
    selected_item_ids: list[uuid.UUID] = Field(max_length=10000)


class AIFeaturesUpdate(_StrictModel):
    """Funcionalidades de IA (somente as 4 chaves da allowlist)."""

    alerts_explain: StrictBool | None = None
    executive_summary: StrictBool | None = None
    assistant: StrictBool | None = None
    data_quality: StrictBool | None = None


class AISettingsUpdate(_StrictModel):
    """Corpo de `PATCH /api/v1/settings/ai` (todos opcionais exceto `version`).

    Nunca aceita chave de API, autoria (`updated_by`) ou aceite gravado
    (`deepseek_acknowledged_*`): esses vêm só do servidor. O modelo é
    validado contra a allowlist do provedor no serviço (`invalid_model`).
    """

    version: StrictInt = Field(ge=1, le=2_147_483_647)
    enabled: StrictBool | None = None
    provider: Literal["none", "openai", "anthropic", "deepseek"] | None = None
    model: str | None = Field(default=None, min_length=1, max_length=100)
    features: AIFeaturesUpdate | None = None
    monthly_token_cap: StrictInt | None = Field(default=None, ge=0, le=50_000_000)
    acknowledge_international_transfer: StrictBool | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_nulls(cls, data: Any) -> Any:
        # `null` explícito não tem significado neste contrato (omitir = manter).
        # Com campos desconhecidos, deixa o `extra_forbidden` acontecer (e
        # ser auditado por `parse_body`).
        if isinstance(data, dict) and not (set(data) - set(cls.model_fields)):
            for name in cls.model_fields:
                if name in data and data[name] is None:
                    raise ValueError(f"{name} não pode ser nulo")
        return data


def reject_unexpected_fields(field_names: list[str] | set[str], *, context: str) -> None:
    """Registra evento de segurança e aborta com 400 por campos não permitidos."""
    names = sorted(str(name)[:64] for name in field_names)
    privileged = sorted(set(names) & PRIVILEGED_FIELD_NAMES)
    if privileged:
        record_security_event(
            EVENT_PRIVILEGE_ESCALATION_ATTEMPT,
            severity=SEVERITY_HIGH,
            details={"context": context, "fields": privileged},
        )
    else:
        record_security_event(
            EVENT_MASS_ASSIGNMENT_REJECTED,
            severity=SEVERITY_LOW,
            details={"context": context, "fields": names},
        )
    shown = ", ".join(names[:_MAX_FIELD_NAMES_IN_MESSAGE])
    abort(400, description=f"Campo(s) não permitido(s) no corpo da requisição: {shown}.")


def parse_body(model: type[ModelT], body: Any, *, context: str) -> ModelT:
    """Valida `body` contra `model`; 400 padronizado em qualquer falha.

    Campos extras -> `reject_unexpected_fields` (com auditoria). Demais
    erros -> 400 citando apenas os nomes dos campos inválidos.
    """
    if not isinstance(body, dict):
        abort(400, description="Corpo da requisição deve ser um objeto JSON.")
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        errors = exc.errors(include_input=False, include_url=False)
        extra_fields = [
            str(err["loc"][0]) for err in errors if err.get("type") == "extra_forbidden" and err.get("loc")
        ]
        if extra_fields:
            reject_unexpected_fields(extra_fields, context=context)
        invalid = sorted({str(err["loc"][0]) for err in errors if err.get("loc")})
        shown = ", ".join(invalid[:_MAX_FIELD_NAMES_IN_MESSAGE]) or "corpo"
        abort(400, description=f"Campo(s) ausente(s) ou inválido(s): {shown}.")
    raise AssertionError("inalcançável")  # pragma: no cover
