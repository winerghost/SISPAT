"""Helpers HTTP compartilhados pelas rotas de gestão de usuários e foto.

Usados por `app/api/v1/users.py`, `units.py` e `me.py` (Etapa 2):
    - respostas de erro no formato padrão `{"error": {"code", "message"}}`
      com os códigos estáveis do contrato;
    - mapeamento das exceções de `app.services.user_admin_service`, com os
      eventos de segurança correspondentes (404 de escopo é auditado igual
      para alvo inexistente e alheio);
    - leitura do upload de foto com limite PRÓPRIO da rota (2 MiB + folga
      do multipart), sem alterar o `MAX_CONTENT_LENGTH` global (1 MiB).
"""
from __future__ import annotations

import logging
from typing import Any

import redis
from flask import g, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge
from werkzeug.formparser import FormDataParser
from werkzeug.wsgi import get_input_stream

from app.api.v1.schemas import get_json_body, reject_unexpected_fields
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    EVENT_UNIT_SCOPE_DENIED,
    EVENT_USER_ADMIN_BLOCKED,
    SEVERITY_HIGH,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.config.settings import get_settings
from app.integrations.supabase_storage_client import StorageUnavailableError
from app.services.avatar_service import (
    MAX_AVATAR_BYTES,
    AvatarError,
    FileTooLargeError,
    UnsupportedImageError,
)
from app.services.user_admin_service import (
    ActorNotAuthorizedError,
    LastAdminBlockedError,
    RateLimitUnavailableError,
    SelfChangeForbiddenError,
    TargetNotFoundError,
    TargetOutOfScopeError,
    TargetRateLimitedError,
    UnitOutOfScopeError,
    UserAdminError,
)

logger = logging.getLogger(__name__)

NOT_FOUND_MESSAGE = "Recurso não encontrado."  # = mensagem padrão do 404 de `app.errors`
_VALIDATION_FALLBACK = "Requisição inválida."
_STORAGE_UNAVAILABLE = "Armazenamento de fotos indisponível no momento. Tente novamente mais tarde."

# Limite do CORPO só das rotas de foto: 2 MiB do arquivo + folga do multipart.
AVATAR_BODY_LIMIT = MAX_AVATAR_BYTES + 64 * 1024
_AVATAR_FIELD = "file"
_MAX_FORM_PARTS = 10
# >= bloco de leitura do parser (64 KiB); campos de texto nem são aceitos.
_MAX_FORM_FIELD_BYTES = 512 * 1024


def error_response(status: int, code: str, message: str):
    response = jsonify({"error": {"code": code, "message": message}})
    response.status_code = status
    return response


def validation_error(exc: BadRequest):
    """400 `validation_error` (o evento de mass assignment já foi gravado)."""
    message = exc.description if isinstance(exc.description, str) else None
    return error_response(400, "validation_error", message or _VALIDATION_FALLBACK)


def not_found_response():
    return error_response(404, "not_found", NOT_FOUND_MESSAGE)


def admin_rate_limit_key(*_args: Any, **_kwargs: Any) -> str:
    """Chave por usuário autenticado (`rate_limit` é o decorator mais interno)."""
    user = getattr(g, "current_user", None)
    return str(getattr(user, "id", "desconhecido"))


_TARGET_QUOTA_PREFIX = "sispat:ratelimit:users.target_quota"


def make_target_quota(operation: str, target_id: Any, *, limit: int, window_seconds: int):
    """Cota por ALVO consumida pelo serviço SÓ depois de confirmar o escopo
    (UA-RL-01): um ADM de outra unidade não esgota o limite da vítima.

    Mesmo mecanismo do `app.security.rate_limit` (INCR + EXPIRE), falha
    fechada: Redis fora => 503 `rate_limit_unavailable`.
    """

    def consume() -> None:
        key = f"{_TARGET_QUOTA_PREFIX}:{operation}:{target_id}"
        try:
            client = redis.Redis.from_url(get_settings().redis_url)
            count = client.incr(key)
            if count == 1:
                client.expire(key, window_seconds)
        except redis.exceptions.RedisError as exc:
            logger.error("user_admin_http: Redis indisponível na cota por alvo (%s).", exc.__class__.__name__)
            raise RateLimitUnavailableError() from exc
        if count > limit:
            raise TargetRateLimitedError()

    return consume


def reject_any_body(context: str):
    """Rotas sem corpo: qualquer corpo não vazio -> 400 (campos auditados)."""
    if not request.get_data(cache=True).strip():
        return None
    body = get_json_body()
    if body == {}:
        return None
    if isinstance(body, dict):
        try:
            reject_unexpected_fields(set(body.keys()), context=context)
        except BadRequest as exc:
            return validation_error(exc)
    return error_response(400, "validation_error", "Este endpoint não aceita corpo na requisição.")


def service_error_response(exc: UserAdminError, *, actor_id: Any, target_id: Any, context: str):
    """Converte o erro de domínio em resposta, auditando as negações."""
    if isinstance(exc, TargetNotFoundError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor_id,
            target_type="user",
            target_id=target_id,
            details={"context": context},
        )
        return not_found_response()
    if isinstance(exc, (TargetOutOfScopeError, ActorNotAuthorizedError)):
        record_security_event(
            EVENT_ACCESS_DENIED,
            severity=SEVERITY_HIGH if isinstance(exc, TargetOutOfScopeError) else SEVERITY_MEDIUM,
            actor_user_id=actor_id,
            target_type="user",
            target_id=target_id,
            details={
                "context": context,
                "reason": exc.code if isinstance(exc, TargetOutOfScopeError) else "actor_not_admin",
                "detail": getattr(exc, "reason", None),
            },
        )
    elif isinstance(exc, UnitOutOfScopeError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor_id,
            target_type="unit",
            details={"context": context, "unit_ids": exc.unit_ids},
        )
    elif isinstance(exc, (LastAdminBlockedError, SelfChangeForbiddenError)):
        record_security_event(
            EVENT_USER_ADMIN_BLOCKED,
            severity=SEVERITY_HIGH if isinstance(exc, LastAdminBlockedError) else SEVERITY_MEDIUM,
            actor_user_id=actor_id,
            target_type="user",
            target_id=target_id,
            details={"context": context, "reason": exc.code},
        )
    return error_response(exc.status_code, exc.code, exc.message)


def storage_unavailable_response():
    return error_response(503, "storage_unavailable", _STORAGE_UNAVAILABLE)


def avatar_error_response(exc: AvatarError):
    return error_response(exc.status_code, exc.code, exc.message)


def read_avatar_upload() -> bytes:
    """Lê o campo `file` do `multipart/form-data` com limite próprio da rota.

    Levanta `FileTooLargeError` (413), `UnsupportedImageError` (400) ou
    `BadRequest` (400 `validation_error`, campos extras auditados). Nada é
    decidido pelo nome do arquivo nem pelo Content-Type da parte.
    """
    if request.content_length is not None and request.content_length > AVATAR_BODY_LIMIT:
        raise FileTooLargeError()
    if request.mimetype != "multipart/form-data":
        raise UnsupportedImageError()
    # UA-UP-01: `safe_fallback=True` — sem Content-Length e sem
    # `wsgi.input_terminated` o stream fica VAZIO (400), nunca lido sem limite.
    # Parser próprio com o limite DESTA rota (independe da versão do Flask e
    # não altera o MAX_CONTENT_LENGTH global). `request.files`/`request.form`
    # NÃO são usados (aplicariam o limite global de 1 MiB).
    parser = FormDataParser(
        max_form_memory_size=_MAX_FORM_FIELD_BYTES,
        max_content_length=AVATAR_BODY_LIMIT,
        silent=False,
        max_form_parts=_MAX_FORM_PARTS,
    )
    try:
        stream = get_input_stream(
            request.environ, safe_fallback=True, max_content_length=AVATAR_BODY_LIMIT
        )
        _stream, form, files = parser.parse(
            stream, request.mimetype, request.content_length, request.mimetype_params
        )
    except RequestEntityTooLarge as exc:
        raise FileTooLargeError() from exc
    except ValueError as exc:  # multipart malformado
        raise UnsupportedImageError() from exc
    extra = (set(form.keys()) | set(files.keys())) - {_AVATAR_FIELD}
    if extra:
        reject_unexpected_fields(extra, context="users.avatar", location="no formulário")
    uploads = files.getlist(_AVATAR_FIELD)
    if len(uploads) != 1:
        raise UnsupportedImageError()
    try:
        data = uploads[0].stream.read(MAX_AVATAR_BYTES + 1)
    except RequestEntityTooLarge as exc:
        raise FileTooLargeError() from exc
    if len(data) > MAX_AVATAR_BYTES:
        raise FileTooLargeError()
    return data


__all__ = [
    "AVATAR_BODY_LIMIT",
    "StorageUnavailableError",
    "admin_rate_limit_key",
    "avatar_error_response",
    "error_response",
    "not_found_response",
    "read_avatar_upload",
    "reject_any_body",
    "service_error_response",
    "storage_unavailable_response",
    "make_target_quota",
    "validation_error",
]
