"""Registro estruturado de eventos de segurança em `audit_logs`.

Eventos cobertos (constantes `EVENT_*` abaixo): falha de autenticação
(401), acesso negado por papel/permissão (403), sessão sem AAL2, tentativa
de escalonamento de privilégio, campos não permitidos no corpo (mass
assignment), acesso fora do escopo de unidade, bloqueios de revogação e de
remoção de fator MFA, etc.

Princípios:
    - NUNCA registra token, cabeçalho `Authorization`, segredo ou corpo
      bruto da requisição — apenas metadados (tipo do evento, ator, rota,
      método, IP, id da requisição) e `details` explicitamente montados
      pelo chamador (ex.: NOMES dos campos rejeitados, nunca seus valores).
    - Falha ao gravar o evento NUNCA derruba a requisição: a gravação é
      feita fora da thread da requisição por um escritor em segundo plano
      com fila LIMITADA (`_MAX_QUEUE_SIZE`). Se a fila encher (ex.: rajada
      de 401 anônimos), o evento é apenas logado e descartado — isso também
      impede que um atacante não autenticado use 401s para amplificar
      escritas no banco.
    - O evento tem formato estável e versionado (`schema`), pronto para ser
      encaminhado no futuro a uma notificação via n8n EXTERNO (campo
      `notify`). Este módulo NÃO chama o n8n.

Mapeamento para `AuditLog` (sem alteração de esquema):
    entity_type = "security_event"
    entity_id   = id do alvo (quando houver) ou o `event_id`
    operation   = tipo do evento (ex.: "ACCESS_DENIED")
    new_values  = o evento estruturado completo
    result      = "FALHA" (padrão) ou "SUCESSO"
    request_id  = id da requisição (também devolvido no header X-Request-ID)
"""
from __future__ import annotations

import logging
import os
import queue
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from flask import g, has_request_context, request

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "sispat.security_event/v1"

EVENT_AUTH_FAILED = "AUTH_FAILED"
EVENT_ACCESS_DENIED = "ACCESS_DENIED"
EVENT_AAL2_REQUIRED = "AAL2_REQUIRED"
EVENT_PRIVILEGE_ESCALATION_ATTEMPT = "PRIVILEGE_ESCALATION_ATTEMPT"
EVENT_MASS_ASSIGNMENT_REJECTED = "MASS_ASSIGNMENT_REJECTED"
EVENT_UNIT_SCOPE_DENIED = "UNIT_SCOPE_DENIED"
EVENT_REVOKE_BLOCKED = "REVOKE_BLOCKED"
EVENT_USER_ACCESS_REVOKED = "USER_ACCESS_REVOKED"
EVENT_INVITE_ACTIVATION_FAILED = "INVITE_ACTIVATION_FAILED"
EVENT_MFA_FACTOR_DELETED = "MFA_FACTOR_DELETED"
EVENT_MFA_FACTOR_DELETE_BLOCKED = "MFA_FACTOR_DELETE_BLOCKED"
EVENT_INVALID_IDENTIFIER = "INVALID_IDENTIFIER"
# Gestão de usuários (Etapa 2).
EVENT_USER_PRIVILEGE_CHANGED = "USER_PRIVILEGE_CHANGED"
EVENT_USER_MFA_RESET = "USER_MFA_RESET"
EVENT_REAUTH_REQUIRED = "REAUTH_REQUIRED"
EVENT_USER_ADMIN_BLOCKED = "USER_ADMIN_BLOCKED"
EVENT_USER_PROVIDER_SYNC_FAILED = "USER_PROVIDER_SYNC_FAILED"
# Exclusão de conta (lógica + anonimização irreversível): a operação mais
# destrutiva do módulo, por isso evento PRÓPRIO e não um `USER_ACCESS_REVOKED`
# com detalhe. Ver `app.services.user_deletion_service`; nenhum dado pessoal
# entra nos detalhes (o e-mail só aparece MASCARADO, no evento de negócio
# `USER_DELETED` do `audit_logs`).
EVENT_USER_DELETED = "USER_DELETED"
# E-mail (app.services.email): envio e teste administrativo.
EVENT_EMAIL_SENT = "EMAIL_SENT"
EVENT_EMAIL_FAILED = "EMAIL_FAILED"
EVENT_EMAIL_TEST_REQUESTED = "EMAIL_TEST_REQUESTED"
# Apoio ao achado B-3: ADM cadastrou fator TOTP com sessão AAL1 (só senha).
EVENT_ADM_TOTP_ENROLL_AAL1 = "ADM_TOTP_ENROLL_AAL1"

SEVERITY_LOW = "low"
SEVERITY_MEDIUM = "medium"
SEVERITY_HIGH = "high"
SEVERITY_CRITICAL = "critical"

# Severidades que, no futuro, devem disparar notificação (n8n externo).
_NOTIFY_SEVERITIES = frozenset({SEVERITY_HIGH, SEVERITY_CRITICAL})

_MAX_QUEUE_SIZE = 1000
_MAX_PATH_LEN = 200
_MAX_DETAIL_STR_LEN = 300
_MAX_DETAIL_ITEMS = 50


def _truncate(value: Any, limit: int = _MAX_DETAIL_STR_LEN) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…"
    return value


def _sanitize_details(details: dict[str, Any] | None) -> dict[str, Any]:
    """Limita tamanho/quantidade dos detalhes (defesa contra poluição de log)."""
    if not details:
        return {}
    clean: dict[str, Any] = {}
    for index, (key, value) in enumerate(details.items()):
        if index >= _MAX_DETAIL_ITEMS:
            break
        if isinstance(value, (list, tuple, set)):
            value = [_truncate(str(v)) for v in list(value)[:_MAX_DETAIL_ITEMS]]
        elif not isinstance(value, (int, float, bool)) and value is not None:
            value = _truncate(str(value))
        clean[_truncate(str(key), 64)] = value
    return clean


def get_request_id() -> str | None:
    """Retorna (gerando, se preciso) o id da requisição atual."""
    if not has_request_context():
        return None
    request_id = getattr(g, "request_id", None)
    if not request_id:
        request_id = uuid.uuid4().hex
        g.request_id = request_id
    return request_id


def build_security_event(
    event_type: str,
    *,
    severity: str = SEVERITY_MEDIUM,
    actor_user_id: Any = None,
    target_type: str | None = None,
    target_id: Any = None,
    details: dict[str, Any] | None = None,
    result: str = "FALHA",
) -> dict[str, Any]:
    """Monta o evento estruturado (sem nenhum dado sensível)."""
    if actor_user_id is None and has_request_context():
        actor_user_id = getattr(getattr(g, "current_user", None), "id", None)

    request_info: dict[str, Any] = {}
    if has_request_context():
        request_info = {
            "request_id": get_request_id(),
            "method": request.method,
            "path": _truncate(request.path, _MAX_PATH_LEN),
            "ip": request.remote_addr,
        }

    return {
        "schema": SCHEMA_VERSION,
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "severity": severity,
        "notify": severity in _NOTIFY_SEVERITIES,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "actor_user_id": str(actor_user_id) if actor_user_id else None,
        "target": {
            "type": target_type,
            "id": _truncate(str(target_id), 100) if target_id is not None else None,
        },
        "request": request_info,
        "result": result,
        "details": _sanitize_details(details),
    }


def _persist_event(event: dict[str, Any]) -> None:
    """Grava o evento em `audit_logs` (sessão própria, isolada da requisição)."""
    # Imports locais: evitam ciclo de importação e permitem que este módulo
    # seja importado sem inicializar o engine em contextos que não gravam.
    from app.database.session import get_db_session
    from app.models.audit import AuditLog

    actor = event.get("actor_user_id")
    try:
        actor_uuid = uuid.UUID(actor) if actor else None
    except (ValueError, TypeError):
        actor_uuid = None

    with get_db_session() as db:
        db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=actor_uuid,
                entity_type="security_event",
                entity_id=(event.get("target") or {}).get("id") or event["event_id"],
                operation=event["event_type"],
                previous_values=None,
                new_values=event,
                request_id=(event.get("request") or {}).get("request_id"),
                result="SUCESSO" if event.get("result") == "SUCESSO" else "FALHA",
            )
        )


class _BackgroundAuditWriter:
    """Escritor em segundo plano com fila limitada (ver docstring do módulo).

    A thread é criada sob demanda e recriada após `fork` (workers do
    Gunicorn), verificando o PID.
    """

    def __init__(self, max_size: int = _MAX_QUEUE_SIZE) -> None:
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=max_size)
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._pid: int | None = None

    def _ensure_started(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive() and self._pid == os.getpid():
                return
            self._pid = os.getpid()
            self._thread = threading.Thread(
                target=self._run, name="sispat-security-audit", daemon=True
            )
            self._thread.start()

    def submit(self, event: dict[str, Any]) -> bool:
        self._ensure_started()
        try:
            self._queue.put_nowait(event)
            return True
        except queue.Full:
            logger.error(
                "security_events: fila de auditoria cheia; evento %s descartado (apenas logado).",
                event.get("event_type"),
            )
            return False

    def _run(self) -> None:  # pragma: no cover - laço de thread
        while True:
            event = self._queue.get()
            try:
                _persist_event(event)
            except Exception as exc:  # noqa: BLE001 - nunca derruba o escritor
                logger.error(
                    "security_events: falha ao gravar evento %s em audit_logs (%s).",
                    event.get("event_type"),
                    exc.__class__.__name__,
                )
            finally:
                self._queue.task_done()


_writer = _BackgroundAuditWriter()


def _notify_admins(event: dict[str, Any]) -> None:
    """Notifica ADMs ativos por e-mail quando `event["notify"]` (best effort).

    Import local (evita ciclo: o módulo de e-mail importa este). O envio roda
    em thread própria e NUNCA levanta; com EMAIL_ENABLED=false é no-op.
    """
    if not event.get("notify"):
        return
    try:
        from app.services.security_notifications import notify_admins_of_event

        notify_admins_of_event(event)
    except Exception as exc:  # noqa: BLE001 - notificação nunca derruba a operação
        logger.error(
            "security_events: falha ao notificar evento %s (%s).",
            event.get("event_type"),
            exc.__class__.__name__,
        )


def _dispatch(event: dict[str, Any]) -> None:
    """Ponto único de envio (substituído por mocks nos testes)."""
    _writer.submit(event)
    _notify_admins(event)


def record_security_event(
    event_type: str,
    *,
    severity: str = SEVERITY_MEDIUM,
    actor_user_id: Any = None,
    target_type: str | None = None,
    target_id: Any = None,
    details: dict[str, Any] | None = None,
    result: str = "FALHA",
) -> dict[str, Any] | None:
    """Registra um evento de segurança (log + `audit_logs`), sem nunca levantar.

    Retorna o evento montado (ou `None` se até a montagem falhar).
    """
    try:
        event = build_security_event(
            event_type,
            severity=severity,
            actor_user_id=actor_user_id,
            target_type=target_type,
            target_id=target_id,
            details=details,
            result=result,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("security_events: falha ao montar evento %s (%s).", event_type, exc.__class__.__name__)
        return None

    logger.warning(
        "security_event type=%s severity=%s actor=%s path=%s request_id=%s",
        event["event_type"],
        event["severity"],
        event["actor_user_id"],
        event["request"].get("path"),
        event["request"].get("request_id"),
    )
    try:
        _dispatch(event)
    except Exception as exc:  # noqa: BLE001 - auditoria nunca derruba a requisição
        logger.error(
            "security_events: falha ao despachar evento %s (%s).",
            event_type,
            exc.__class__.__name__,
        )
    return event
