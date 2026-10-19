"""Leitura da trilha de auditoria (`audit_logs`) para o ADM -- SOMENTE LEITURA.

Decisões (documentadas em `docs/architecture/admin-read-api.md`):

ESCOPO DE UNIDADE. `audit_logs` não tem coluna de unidade. Um registro é
visível ao ADM consultante se ao menos uma condição vale (negar por padrão):

1. o AUTOR do registro é um usuário vinculado (`user_unit_access`) a alguma
   unidade do escopo do ADM (inclui o próprio ADM);
2. `entity_type='user'` e a entidade é um usuário vinculado ao escopo;
3. `entity_type='unit'` e a entidade é uma unidade do escopo.

Registros sem autor (ex.: falhas de autenticação anônimas, jobs) e de
autores sem unidade em comum ficam FORA: "auditoria irrestrita" é privilégio
de sistema (matriz de permissões, pendência 4). Alvo alheio, inexistente ou
malformado no detalhe => a MESMA resposta (nenhum registro).

PROJEÇÃO SEGURA. Nada de `previous_values`/`new_values`/`details` é devolvido
bruto. Só chaves em allowlist (por tipo de registro) e só valores escalares
curtos que passem por `safe_scalar` (sem espaços, sem '@', sem tokens longos);
o resto é omitido/`[redacted]`. Nunca saem e-mail, telefone, nome, texto
livre, token, segredo nem IP completo (apenas a rede: /24 IPv4, /48 IPv6).
O ator é devolvido só como `actor_user_id` (sem nome).
"""
from __future__ import annotations

import ipaddress
import re
import uuid
from typing import Any

from sqlalchemy import and_, false, func, or_, select

from app.authorization.rbac import get_accessible_unit_ids
from app.models.audit import AuditLog
from app.models.units import UserUnitAccess
from app.services.user_admin_service import iso_utc

SECURITY_ENTITY_TYPE = "security_event"
REDACTED = "[redacted]"

# Chaves de `details` de eventos de segurança que podem sair (todas são
# códigos/nomes de campo escritos pelo servidor, nunca valores do cliente).
SECURITY_DETAIL_KEYS = (
    "context",
    "reason",
    "required",
    "operation",
    "fields",
    "unit_ids",
    "from",
    "to",
    "removed_factors",
    "detail",
)

# Chaves de `previous_values`/`new_values` de registros de negócio que podem
# sair. Texto livre (reason, notes, name, description...) NUNCA está aqui.
CHANGE_KEYS = (
    "role",
    "roles",
    "units",
    "active",
    "avatar",
    "deleted",
    "status",
    "version",
    "density",
    "font_scale",
    "kind",
    "created",
    "updated",
    "skipped",
    "failed",
    "total",
    "provider",
    "model",
    "feature",
    "outcome",
    "tokens_in",
    "tokens_out",
    "enabled",
    "deepseek_acknowledged",
    "sessions_revoked_at",
    "invite_superseded",
    "removed_factors",
    "unit_id",
    "from_unit_id",
    "to_unit_id",
    "room_id",
    "location_id",
    "has_notes",
)

_MAX_LIST_ITEMS = 50
_MAX_SAFE_STR = 64
_SAFE_STR_RE = re.compile(r"^[A-Za-z0-9_.:+\-/]{1,%d}$" % _MAX_SAFE_STR)
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_PATH_RE = re.compile(r"^[A-Za-z0-9_.:\-/]{1,200}$")
_TOKEN_PREFIXES = ("eyj", "sb_", "sk-", "bearer")
_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"})
_SEVERITIES = frozenset({"low", "medium", "high", "critical"})
_RESULTS = frozenset({"SUCESSO", "FALHA"})


def safe_token(value: Any, *, max_len: int = _MAX_SAFE_STR) -> str | None:
    """String curta e "sem cara de segredo", ou `None`."""
    if not isinstance(value, str) or not 1 <= len(value) <= max_len:
        return None
    if not _SAFE_STR_RE.match(value):
        return None
    if value.lower().startswith(_TOKEN_PREFIXES):
        return None
    return value


def safe_scalar(value: Any) -> Any:
    """Valor escalar projetável: `None`, bool, int, string segura, ou `[redacted]`."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        token = safe_token(value)
        # UUID tem 36 caracteres e passa; demais strings longas parecem segredo.
        if token is not None and (len(token) <= 40 or _UUID_RE.match(token)):
            return token
        return REDACTED
    return None


def _safe_value(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [safe_scalar(item) for item in list(value)[:_MAX_LIST_ITEMS]]
    return safe_scalar(value)


def mask_ip(raw: Any) -> str | None:
    """Rede do IP (nunca o endereço completo): IPv4 /24, IPv6 /48."""
    if not isinstance(raw, str):
        return None
    try:
        address = ipaddress.ip_address(raw.strip())
    except ValueError:
        return None
    prefix = 24 if address.version == 4 else 48
    return str(ipaddress.ip_network(f"{address}/{prefix}", strict=False))


def project_security_details(details: Any) -> dict[str, Any]:
    if not isinstance(details, dict):
        return {}
    return {key: _safe_value(details[key]) for key in SECURITY_DETAIL_KEYS if key in details}


def project_changes(row: AuditLog) -> tuple[dict[str, Any], int]:
    """`({chave: {from, to}}, omitted)` -- `omitted` = chaves fora da allowlist."""
    previous = row.previous_values if isinstance(row.previous_values, dict) else {}
    new = row.new_values if isinstance(row.new_values, dict) else {}
    changes: dict[str, Any] = {}
    for key in CHANGE_KEYS:
        if key in previous or key in new:
            changes[key] = {"from": _safe_value(previous.get(key)), "to": _safe_value(new.get(key))}
    omitted = len((set(previous) | set(new)) - set(CHANGE_KEYS))
    return changes, omitted


def _security_view(row: AuditLog) -> dict[str, Any]:
    event = row.new_values if isinstance(row.new_values, dict) else {}
    target = event.get("target") if isinstance(event.get("target"), dict) else {}
    request = event.get("request") if isinstance(event.get("request"), dict) else {}
    severity = event.get("severity")
    path = request.get("path")
    method = request.get("method")
    return {
        "severity": severity if severity in _SEVERITIES else None,
        "target_type": safe_token(target.get("type")),
        "request": {
            "method": method if method in _METHODS else None,
            "path": path if isinstance(path, str) and _PATH_RE.match(path) else None,
            "network": mask_ip(request.get("ip")),
        },
        "details": project_security_details(event.get("details")),
    }


def project_summary(row: AuditLog) -> dict[str, Any]:
    """Item de LISTA (sem `details`/`changes`)."""
    severity = None
    if row.entity_type == SECURITY_ENTITY_TYPE and isinstance(row.new_values, dict):
        raw = row.new_values.get("severity")
        severity = raw if raw in _SEVERITIES else None
    return {
        "id": str(row.id),
        "occurred_at": iso_utc(row.occurred_at),
        "event_type": safe_token(row.operation, max_len=64) or REDACTED,
        "entity_type": safe_token(row.entity_type, max_len=40),
        "entity_id": safe_token(row.entity_id, max_len=100),
        "actor_user_id": str(row.actor_user_id) if row.actor_user_id else None,
        "result": row.result if row.result in _RESULTS else None,
        "severity": severity,
        "request_id": safe_token(row.request_id, max_len=100),
    }


def project_detail(row: AuditLog) -> dict[str, Any]:
    """Item de DETALHE: resumo + `details` (segurança) ou `changes` (negócio)."""
    data = project_summary(row)
    if row.entity_type == SECURITY_ENTITY_TYPE:
        data.update(_security_view(row))
        data["changes"] = {}
        data["omitted_fields"] = 0
    else:
        changes, omitted = project_changes(row)
        data.update({"target_type": None, "request": None, "details": {}})
        data["changes"] = changes
        data["omitted_fields"] = omitted
    return data


class AdminAuditService:
    """Consultas de leitura (uma sessão por requisição, sem escrita)."""

    def __init__(self, db: Any) -> None:
        self._db = db

    def _scope(self, actor_id: Any) -> Any:
        actor_units = get_accessible_unit_ids(actor_id, self._db)
        if not actor_units:
            return false()
        units = sorted(actor_units, key=str)
        scoped_users = select(UserUnitAccess.user_id).where(UserUnitAccess.unit_id.in_(units))
        scoped_user_ids = [
            str(row[0]) for row in self._db.execute(scoped_users.distinct()).all()
        ]
        return or_(
            AuditLog.actor_user_id.in_(scoped_users),
            and_(AuditLog.entity_type == "user", AuditLog.entity_id.in_(scoped_user_ids)),
            and_(AuditLog.entity_type == "unit", AuditLog.entity_id.in_([str(u) for u in units])),
        )

    def list_logs(self, actor_id: Any, query: Any) -> dict[str, Any]:
        page, page_size = int(query.page), int(query.page_size)
        conditions: list[Any] = [
            self._scope(actor_id),
            AuditLog.occurred_at >= query.from_,
            AuditLog.occurred_at <= query.to_,
        ]
        if query.event_type:
            conditions.append(AuditLog.operation == query.event_type)
        if query.entity_type:
            conditions.append(AuditLog.entity_type == query.entity_type)
        if query.entity_id:
            conditions.append(AuditLog.entity_id == query.entity_id)
        if query.actor_user_id is not None:
            conditions.append(AuditLog.actor_user_id == query.actor_user_id)
        if query.result:
            conditions.append(AuditLog.result == query.result)
        if query.severity:
            conditions.append(
                and_(
                    AuditLog.entity_type == SECURITY_ENTITY_TYPE,
                    AuditLog.new_values["severity"].as_string() == query.severity,
                )
            )
        order = (
            (AuditLog.occurred_at.asc(), AuditLog.id.asc())
            if query.sort == "occurred_at"
            else (AuditLog.occurred_at.desc(), AuditLog.id.desc())
        )
        total = self._db.execute(
            select(func.count()).select_from(AuditLog).where(*conditions)
        ).scalar_one()
        rows = (
            self._db.execute(
                select(AuditLog)
                .where(*conditions)
                .order_by(*order)
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            .scalars()
            .all()
        )
        return {
            "total": int(total),
            "page": page,
            "page_size": page_size,
            "window": {"from": iso_utc(query.from_), "to": iso_utc(query.to_)},
            "items": [project_summary(row) for row in rows],
        }

    def get_log(self, actor_id: Any, log_id: uuid.UUID) -> dict[str, Any] | None:
        """Detalhe projetado, ou `None` (inexistente OU fora do escopo)."""
        row = (
            self._db.execute(
                select(AuditLog).where(AuditLog.id == log_id, self._scope(actor_id))
            )
            .scalars()
            .first()
        )
        return project_detail(row) if row is not None else None
