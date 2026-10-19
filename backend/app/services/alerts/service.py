"""Orquestra as regras de alerta com isolamento de falha.

Cada regra roda em SUA PRÓPRIA sessão/transação (somente leitura): se uma
consulta falhar no PostgreSQL a transação daquela regra aborta, sem
contaminar as demais. A regra com erro entra em `unavailable` (só o código;
a causa vai para o log com o nome da exceção, sem dados) e a resposta segue.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Sequence

from app.config.settings import get_settings
from app.database.session import get_db_session
from app.services.alerts.rules import RULES, AlertItem, AlertRule, RuleContext

logger = logging.getLogger(__name__)

_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


def evaluate_alerts(
    user_id: Any,
    *,
    now: datetime | None = None,
    rules: Sequence[AlertRule] | None = None,
) -> dict[str, Any]:
    """Avalia as regras para `user_id` e devolve o contrato do dashboard."""
    moment = now or datetime.now(timezone.utc)
    settings = get_settings()
    items: list[AlertItem] = []
    unavailable: list[str] = []
    for rule in rules if rules is not None else RULES:
        try:
            with get_db_session() as db:
                found = rule.run(RuleContext(db=db, user_id=user_id, now=moment, settings=settings))
        except Exception as exc:  # noqa: BLE001 - isolamento deliberado por regra
            logger.error("alerts: regra '%s' indisponível (%s).", rule.code, type(exc).__name__)
            unavailable.append(rule.code)
            continue
        items.extend(item for item in found if item.count > 0)
    items.sort(key=lambda i: (_SEVERITY_ORDER.get(i.severity, 9), i.code, -i.count))
    return {
        "generated_at": moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "items": [item.as_dict() for item in items],
        "unavailable": unavailable,
    }
