"""Handlers de erro HTTP padronizados para a API do SISPAT-AGU.

Toda resposta de erro da API segue o mesmo formato JSON:

    {"error": {"code": "<slug>", "message": "<mensagem em português>"}}

Princípios:
    - Nenhum detalhe interno (stack trace, exceção Python, SQL, caminho de
      arquivo, etc.) é exposto ao cliente, em nenhum código de status.
    - O detalhe real do erro é sempre logado no servidor via `logging`
      (nunca em texto puro sensível, ex.: tokens — ver `app.auth.supabase_auth`).
    - Uma mensagem customizada só é exposta ao cliente quando foi
      explicitamente definida pelo próprio código da aplicação ao abortar a
      requisição (ex.: `abort(409, description="E-mail já cadastrado.")`) —
      nunca a partir da descrição padrão do Werkzeug ou de uma exceção não
      tratada.

Uso em `app/__init__.py`:
    from app.errors import register_error_handlers
    register_error_handlers(app)
"""
from __future__ import annotations

import logging

from flask import Flask, jsonify
from sqlalchemy.exc import (
    DBAPIError,
    InterfaceError,
    OperationalError,
    SQLAlchemyError,
)
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from werkzeug.exceptions import HTTPException, default_exceptions

logger = logging.getLogger(__name__)

# SQLSTATE 57014 = query_canceled (statement_timeout do PostgreSQL).
_QUERY_CANCELED_SQLSTATE = "57014"


def _is_pg_driver_error(exc: DBAPIError) -> bool:
    """Só erros operacionais do driver PostgreSQL (rede/conexão) viram 503;
    erros de esquema/SQL continuam 500 (bug, não indisponibilidade)."""
    module = type(getattr(exc, "orig", None)).__module__ or ""
    return module.startswith(("psycopg2", "psycopg"))


def _is_query_canceled(exc: DBAPIError) -> bool:
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "pgcode", None) or getattr(orig, "sqlstate", None)
    return code == _QUERY_CANCELED_SQLSTATE

# Códigos de status explicitamente suportados por esta fase, com seu
# slug (`code`) e mensagem padrão (em português) quando nenhuma mensagem
# customizada e segura tiver sido definida pela aplicação.
_DEFAULT_ERROR_INFO: dict[int, tuple[str, str]] = {
    400: ("bad_request", "Requisição inválida."),
    401: ("unauthorized", "Autenticação necessária ou inválida."),
    403: ("forbidden", "Acesso negado."),
    404: ("not_found", "Recurso não encontrado."),
    405: ("method_not_allowed", "Método não permitido para este recurso."),
    409: ("conflict", "Conflito com o estado atual do recurso."),
    413: ("payload_too_large", "Corpo da requisição excede o tamanho máximo permitido."),
    415: ("unsupported_media_type", "Tipo de conteúdo não suportado."),
    422: ("unprocessable_entity", "Não foi possível processar os dados enviados."),
    429: ("rate_limited", "Muitas tentativas. Tente novamente mais tarde."),
    500: ("internal_error", "Erro interno do servidor."),
    502: ("bad_gateway", "Falha ao comunicar com um serviço externo."),
    503: ("service_unavailable", "Serviço temporariamente indisponível."),
    504: ("gateway_timeout", "A operação excedeu o tempo limite. Tente novamente."),
}

_FALLBACK_ERROR_INFO = ("error", "Ocorreu um erro ao processar a requisição.")

# Cabeçalhos de HTTPException do Werkzeug repassados ao cliente.
_PRESERVED_HEADERS = frozenset({"allow", "retry-after"})


def _build_error_payload(status_code: int, message: str | None, code: str | None):
    default_code, default_message = _DEFAULT_ERROR_INFO.get(status_code, _FALLBACK_ERROR_INFO)
    body = {
        "error": {
            "code": code or default_code,
            "message": message or default_message,
        }
    }
    return jsonify(body), status_code


def _is_custom_description(exc: HTTPException) -> bool:
    """Indica se `exc.description` foi explicitamente definida pela aplicação
    (ex.: `abort(404, description="...")`), em vez de ser a descrição padrão
    genérica da classe de exceção do Werkzeug.

    Usada para decidir se a mensagem pode ser repassada ao cliente (ela é
    conteúdo controlado pelo próprio código da aplicação, não um detalhe
    interno/stack trace).
    """
    exc_class = default_exceptions.get(exc.code) if exc.code else None
    default_description = getattr(exc_class, "description", None) if exc_class else None
    return bool(exc.description) and exc.description != default_description


def register_error_handlers(app: Flask) -> None:
    """Registra na aplicação Flask os handlers de erro padronizados."""

    def handle_known_http_exception(exc: HTTPException):
        status_code = exc.code or 500
        logger.warning(
            "Erro HTTP %s (%s): %s",
            status_code,
            getattr(exc, "name", "HTTPException"),
            getattr(exc, "description", ""),
        )
        message = exc.description if _is_custom_description(exc) else None
        # Nunca repassar descrições que não sejam texto puro controlado pela
        # aplicação (ex.: objetos/estruturas internas).
        if message is not None and not isinstance(message, str):
            message = None
        response, status = _build_error_payload(status_code, message=message, code=None)
        # Preserva cabeçalhos relevantes da exceção (ex.: `Allow` em 405,
        # `Retry-After` em 429/503), sem copiar o corpo HTML do Werkzeug.
        try:
            for name, value in exc.get_headers():
                if name.lower() in _PRESERVED_HEADERS:
                    response.headers[name] = value
        except Exception:  # noqa: BLE001 - cabeçalhos são acessórios
            pass
        return response, status

    def handle_unexpected_exception(exc: Exception):
        # Qualquer exceção não tratada (bug, erro de infraestrutura, etc.)
        # é logada com o traceback completo no servidor, mas o cliente
        # recebe apenas a mensagem genérica de erro interno (500) — nunca
        # stack trace, SQL, caminho de arquivo ou mensagem da exceção.
        logger.exception("Erro não tratado na aplicação (%s).", exc.__class__.__name__)
        return _build_error_payload(500, message=None, code=None)

    def handle_db_exception(exc: SQLAlchemyError):
        # Falhas de infraestrutura do banco viram resposta JSON controlada
        # (antes de o gunicorn abortar o worker e devolver 500 sem corpo).
        # Nunca expõe SQL, parâmetros ou mensagem do driver.
        if isinstance(exc, DBAPIError) and _is_query_canceled(exc):
            logger.error("Consulta cancelada por statement_timeout (%s).", type(exc).__name__)
            return _build_error_payload(504, message=None, code="request_timeout")
        if isinstance(exc, (PoolTimeoutError, InterfaceError)) or (
            isinstance(exc, OperationalError) and _is_pg_driver_error(exc)
        ):
            logger.error("Banco indisponível (%s).", type(exc).__name__)
            response, status = _build_error_payload(503, message=None, code="database_unavailable")
            response.headers["Retry-After"] = "5"
            return response, status
        return handle_unexpected_exception(exc)

    def handle_timeout(exc: TimeoutError):
        logger.error("Tempo limite excedido (%s).", type(exc).__name__)
        return _build_error_payload(504, message=None, code="request_timeout")

    for status_code in _DEFAULT_ERROR_INFO:
        app.register_error_handler(status_code, handle_known_http_exception)

    # Fallback para qualquer outro HTTPException (ex.: 405 Method Not
    # Allowed) que não esteja na lista explícita acima, ainda assim
    # respondendo no formato JSON padronizado em vez do HTML padrão do
    # Werkzeug.
    app.register_error_handler(HTTPException, handle_known_http_exception)

    # Qualquer exceção Python não tratada (não é um HTTPException) vira 500.
    app.register_error_handler(Exception, handle_unexpected_exception)
    # Mais específicos (resolvidos pela MRO do Flask antes de Exception).
    app.register_error_handler(SQLAlchemyError, handle_db_exception)
    app.register_error_handler(TimeoutError, handle_timeout)
