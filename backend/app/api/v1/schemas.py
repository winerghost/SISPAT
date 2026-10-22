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
from typing import Any, ClassVar, Literal, TypeVar, get_args

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

from app.api.v1.pagination import DEFAULT_PAGE_SIZE, PageSize
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
        # Gestão de usuários: estado de conta/sessão/foto só muda pelo servidor.
        "sessions_revoked_at",
        "avatar_object_key",
        "deactivated_at",
        "deactivated_by",
        "last_login_at",
    }
)

_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
_MAX_EMAIL_LEN = 254
_MAX_FIELD_NAMES_IN_MESSAGE = 10
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")

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


class EmptyBody(_StrictModel):
    """Corpo vazio: rotas de ação sem parâmetros (qualquer campo -> 400 auditado)."""


class _NoExplicitNullsModel(_StrictModel):
    """`null` explícito não tem significado (omitir = manter) -> 400.

    Exceção declarada por subclasse em `_NULLABLE_FIELDS` (ex.: `null` =
    restaurar o padrão).
    """

    _NULLABLE_FIELDS: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict) and not (set(data) - set(cls.model_fields)):
            for name in cls.model_fields:
                if name in cls._NULLABLE_FIELDS:
                    continue
                if name in data and data[name] is None:
                    raise ValueError(f"{name} não pode ser nulo")
        return data


_VERSION_FIELD = Field(ge=1, le=2_147_483_647)
UserRoleCode = Literal["ADM", "USER", "RH"]


class UserUpdateRequest(_NoExplicitNullsModel):
    """Corpo de `PATCH /api/v1/users/<id>` (Etapa 2).

    Só `role` e `unit_ids` são editáveis; `active`, `email`, `auth_user_id`,
    `deleted_at`, `sessions_revoked_at`, `avatar_object_key` etc. são
    rejeitados (400 + evento). Ao menos um de `role`/`unit_ids` é exigido.
    """

    version: StrictInt = _VERSION_FIELD
    role: UserRoleCode | None = None
    unit_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=50)
    confirm_privilege_change: StrictBool | None = None

    @model_validator(mode="after")
    def _require_change(self) -> "UserUpdateRequest":
        if self.role is None and self.unit_ids is None:
            raise ValueError("informe role e/ou unit_ids")
        return self


class VersionRequest(_NoExplicitNullsModel):
    """Corpo `{"version": n}` das ações de conta (ex.: `activate`)."""

    version: StrictInt = _VERSION_FIELD


class DeactivateRequest(VersionRequest):
    """Corpo de `POST /api/v1/users/<id>/deactivate`."""

    reason: str | None = Field(default=None, max_length=1000)


class DashboardChartsPatch(_StrictModel):
    """`dashboard_charts` parcial: allowlist FECHADA por painel.

    Ausente = manter; `null` = restaurar o padrão da chave (via
    `model_fields_set`). Chave desconhecida/valor fora da allowlist/objeto
    aninhado -> 400.
    """

    units: Literal["grouped", "stacked", "horizontal"] | None = None
    status: Literal["pie", "donut", "bar"] | None = None
    monthly: Literal["line", "area", "bar"] | None = None
    location: Literal["stacked", "grouped", "horizontal"] | None = None
    bond: Literal["pie", "donut", "bar"] | None = None
    rooms: Literal["bar", "horizontal"] | None = None


# Allowlist FECHADA de painéis do dashboard (ordem = ordem padrão de exibição).
DashboardPanelId = Literal[
    "kpis", "units", "status", "monthly", "location", "bond", "pending", "rooms", "inventory"
]
DASHBOARD_PANEL_IDS: tuple[str, ...] = get_args(DashboardPanelId)
_MAX_PANELS = len(DASHBOARD_PANEL_IDS)


class DashboardLayoutPatch(_StrictModel):
    """`dashboard_layout` parcial: ordem e painéis ocultos.

    Ausente = manter; `null` = restaurar o padrão da chave. Cada lista só
    aceita IDs da allowlist, sem repetição, até 9 itens. `order` parcial é
    aceito (os demais painéis seguem na ordem padrão). `hidden` não pode
    ocultar todos os painéis.
    """

    order: list[DashboardPanelId] | None = Field(default=None, max_length=_MAX_PANELS)
    hidden: list[DashboardPanelId] | None = Field(default=None, max_length=_MAX_PANELS)

    @field_validator("order", "hidden", mode="after")
    @classmethod
    def _no_duplicates(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("painel repetido")
        return value

    @model_validator(mode="after")
    def _keep_one_visible(self) -> "DashboardLayoutPatch":
        if self.hidden is not None and len(set(self.hidden)) >= _MAX_PANELS:
            raise ValueError("ao menos um painel deve ficar visível")
        return self


class PreferencesUpdateRequest(_NoExplicitNullsModel):
    """Corpo de `PATCH /api/v1/me/preferences` (Etapa 3 — Aparência).

    `version` obrigatório (0 = criar a primeira linha). `user_id` e demais
    campos nunca vêm do cliente (400 + evento). Ao menos uma preferência.
    """

    version: StrictInt = Field(ge=0, le=2_147_483_647)
    density: Literal["comfortable", "compact"] | None = None
    font_scale: Literal[100, 112, 125] | None = None
    dashboard_charts: "DashboardChartsPatch | None" = None
    # `null` = restaurar o layout padrão (único campo que aceita null).
    dashboard_layout: "DashboardLayoutPatch | None" = None

    _NULLABLE_FIELDS: ClassVar[frozenset[str]] = frozenset({"dashboard_layout"})

    @model_validator(mode="after")
    def _require_change(self) -> "PreferencesUpdateRequest":
        charts_changed = bool(self.dashboard_charts and self.dashboard_charts.model_fields_set)
        layout_changed = "dashboard_layout" in self.model_fields_set and (
            self.dashboard_layout is None or bool(self.dashboard_layout.model_fields_set)
        )
        if (
            self.density is None
            and self.font_scale is None
            and not charts_changed
            and not layout_changed
        ):
            raise ValueError(
                "informe density, font_scale, dashboard_charts e/ou dashboard_layout"
            )
        return self


UserSortKey = Literal[
    "name", "-name", "email", "-email", "created_at", "-created_at", "last_login_at", "-last_login_at"
]


class UserListQuery(_StrictModel):
    """Query string de `GET /api/v1/users` (allowlist; desconhecido -> 400)."""

    q: str | None = Field(default=None, max_length=100)
    role: UserRoleCode | None = None
    unit_id: uuid.UUID | None = None
    active: Literal["true", "false"] | None = None
    sort: UserSortKey = "name"
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE


class ImportItemsQuery(_StrictModel):
    """Query string de `GET /imports/google-sheets/preview/<id>/items` (B-2).

    `status` é filtrado pelo serviço contra a allowlist de classificações
    (valor desconhecido -> lista vazia); aqui só limites de tamanho/forma.
    Parâmetro desconhecido/repetido ou fora dos limites -> 400.
    """

    status: str | None = Field(default=None, max_length=32)
    search: str | None = Field(default=None, max_length=200)
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE

    @field_validator("status", "search", mode="after")
    @classmethod
    def _blank_to_none(cls, value: str | None) -> str | None:
        return value or None


class PageQuery(_StrictModel):
    """Query string paginada simples (ex.: histórico de auditoria)."""

    page: int = Field(default=1, ge=1, le=100_000)
    page_size: PageSize = DEFAULT_PAGE_SIZE


def parse_query(model: type[ModelT], args: Any, *, context: str) -> ModelT:
    """Valida a query string (MultiDict) contra `model` — mesma política de `parse_body`.

    Parâmetro repetido -> 400; desconhecido -> 400 auditado; valores nunca
    ecoados na mensagem.
    """
    raw = args.to_dict(flat=False) if hasattr(args, "to_dict") else dict(args or {})
    if any(len(values) != 1 for values in raw.values() if isinstance(values, list)):
        abort(400, description="Parâmetro de consulta repetido.")
    flat = {key: (values[0] if isinstance(values, list) else values) for key, values in raw.items()}
    unknown = set(flat) - set(model.model_fields)
    if unknown:
        reject_unexpected_fields(unknown, context=context, location="na consulta")
    try:
        return model.model_validate(flat)
    except ValidationError as exc:
        errors = exc.errors(include_input=False, include_url=False)
        invalid = sorted({str(err["loc"][0]) for err in errors if err.get("loc")})
        shown = ", ".join(invalid[:_MAX_FIELD_NAMES_IN_MESSAGE]) or "consulta"
        abort(400, description=f"Parâmetro(s) inválido(s): {shown}.")
    raise AssertionError("inalcançável")  # pragma: no cover


def reject_unexpected_fields(
    field_names: list[str] | set[str],
    *,
    context: str,
    location: str = "no corpo da requisição",
) -> None:
    """Registra evento de segurança e aborta com 400 por campos não permitidos."""
    # SEC-REV-02: nomes vêm do cliente; neutraliza controles (CR/LF) antes de log/mensagem.
    names = sorted(_CONTROL_CHARS_RE.sub("?", str(name)[:64]) for name in field_names)
    # L-1: nomes aninhados chegam como caminho ("dashboard_charts.role"); o
    # último segmento também é checado contra os campos privilegiados.
    privileged = sorted(
        name for name in set(names) if name.rsplit(".", 1)[-1] in PRIVILEGED_FIELD_NAMES
    )
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
    abort(400, description=f"Campo(s) não permitido(s) {location}: {shown}.")


def get_json_body() -> Any:
    """`request.get_json(silent=True)` tolerante a JSON profundamente aninhado.

    SEC-REV-01 / M-1: o parser estoura `RecursionError` (-> 500). Nesse caso
    devolve `[]`: valor não nulo, não-objeto e diferente de `{}`, que todas as
    rotas já rejeitam com o mesmo 400 de corpo inválido.
    """
    from flask import request

    try:
        return request.get_json(silent=True)
    except RecursionError:
        return []


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
            ".".join(str(part) for part in err["loc"])
            for err in errors
            if err.get("type") == "extra_forbidden" and err.get("loc")
        ]
        if extra_fields:
            reject_unexpected_fields(extra_fields, context=context)
        invalid = sorted({str(err["loc"][0]) for err in errors if err.get("loc")})
        shown = ", ".join(invalid[:_MAX_FIELD_NAMES_IN_MESSAGE]) or "corpo"
        abort(400, description=f"Campo(s) ausente(s) ou inválido(s): {shown}.")
    raise AssertionError("inalcançável")  # pragma: no cover
