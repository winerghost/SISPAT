"""Helpers HTTP dos cadastros de apoio (salas, pessoas, unidades).

- `require_aal2_for_adm`: rotas de LEITURA compartilhadas por USER/RH/ADM.
  Quem tem o papel ADM precisa de AAL2 (regra de TODA rota administrativa);
  USER/RH não têm MFA obrigatório e seguem só com escopo de unidade.
- `catalog_error_response`: converte `CatalogError` no formato padrão
  `{"error": {"code", "message"}}`, auditando as negações (alvo alheio e
  inexistente geram o MESMO evento e a MESMA resposta 404).
- `read_body`/`read_action_body`: corpo JSON validado por schema `extra="forbid"`.
"""
from __future__ import annotations

from functools import wraps
from typing import Any, Callable, TypeVar

from flask import g, request
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import parse_body, reject_unexpected_fields
from app.api.v1.user_admin_http import error_response, validation_error
from app.authorization.rbac import require_aal2
from app.authorization.security_events import (
    EVENT_UNIT_SCOPE_DENIED,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.services.catalog_service import CatalogError, NotFoundError, PhoneForbiddenError

F = TypeVar("F", bound=Callable[..., Any])

# Limites por usuário/hora (fail-closed, como as demais rotas administrativas).
WINDOW = 3600
READ_LIMIT = 600
LIST_LIMIT = 1200
WRITE_LIMIT = 120
ACTION_LIMIT = 60


def is_adm() -> bool:
    return "ADM" in getattr(g, "current_user_roles", set())


def is_minimal_people_view() -> bool:
    """Negar por padrão: só ADM e RH veem o cadastro completo de pessoas (SEC-CAT-06)."""
    return not ({"ADM", "RH"} & set(getattr(g, "current_user_roles", set())))


def require_aal2_for_adm(view_func: F) -> F:
    """Exige AAL2 só quando o usuário autenticado é ADM (leitura compartilhada)."""
    strict = require_aal2(view_func)

    @wraps(view_func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        if is_adm():
            return strict(*args, **kwargs)
        return view_func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def catalog_error_response(
    exc: CatalogError, *, actor_id: Any, target_type: str, target_id: Any, context: str
):
    if isinstance(exc, NotFoundError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor_id,
            target_type=target_type,
            target_id=target_id,
            details={"context": context},
        )
    elif isinstance(exc, PhoneForbiddenError):
        try:
            reject_unexpected_fields({"phone"}, context=context)
        except BadRequest as bad:
            return validation_error(bad)
    return error_response(exc.status_code, exc.code, exc.message)


def read_body(model: type, context: str):
    """Corpo JSON obrigatório; devolve `(instância, None)` ou `(None, resposta 400)`."""
    try:
        try:
            payload = request.get_json(silent=True)
        except RecursionError:  # SEC-REV-01: JSON profundamente aninhado
            payload = None
        return parse_body(model, payload, context=context), None
    except BadRequest as exc:
        return None, validation_error(exc)


def read_action_body(model: type, context: str):
    """Corpo opcional de `deactivate`/`activate` (ausente/vazio => defaults)."""
    if not request.get_data(cache=True).strip():
        return model(), None
    return read_body(model, context)
