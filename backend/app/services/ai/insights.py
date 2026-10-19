"""Insights de IA no dashboard (Etapa 4b): geração periódica por unidade + cache.

Fluxo (executado pelas tasks Celery, nunca por requisição HTTP):

    alertas determinísticos da unidade (mesmas regras de `app.services.alerts`)
      -> DTO AGREGADO (só códigos de regra, severidade e contagens; nunca nome,
         e-mail, CPF, matrícula ou texto de descrição) -> `AIService.run_feature`
         (flag da funcionalidade, redação com k-anonimato <5 e varredura
         bloqueante, circuito, cota) -> texto puro -> Redis por unidade com TTL.

Sem IA ativa, funcionalidade desligada, erro, bloqueio da redação ou
NullProvider: NADA é gravado (o cache antigo apenas expira). O endpoint
`GET /ai/insights` só LÊ este cache.

Escopo: a unidade vem do banco (tabela `units`), nunca do cliente nem do LLM.
As regras de alerta usam `apply_unit_scope(user_id, db)`; como a task não tem
usuário, `_UnitScopedSession` responde à consulta de acesso do escopo com
exatamente a unidade processada (as regras rodam inalteradas).
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Sequence

from app.config.settings import Settings, get_settings
from app.models.units import Unit, UserUnitAccess
from app.services.ai.base import (
    ERROR_CIRCUIT_OPEN,
    ERROR_DISABLED,
    ERROR_NOT_CONFIGURED,
    ERROR_QUOTA_EXCEEDED,
)
from app.services.ai.factory import _AUTO, AIConfig, build_redis_client, compute_status
from app.services.ai.models import (
    FEATURE_ALERTS_EXPLAIN,
    FEATURE_DATA_QUALITY,
    FEATURE_EXECUTIVE_SUMMARY,
)
from app.services.ai.prompting import sanitize_output
from app.services.ai.service import AIActor, AIService
from app.services.alerts.rules import RULES, AlertItem, AlertRule, RuleContext

logger = logging.getLogger(__name__)

KIND_ALERT_PRIORITY = "alert_priority"
KIND_EXECUTIVE_SUMMARY = "executive_summary"
KIND_QUALITY_SUGGESTION = "quality_suggestion"

# Ordem de exibição.
KINDS: tuple[str, ...] = (KIND_ALERT_PRIORITY, KIND_EXECUTIVE_SUMMARY, KIND_QUALITY_SUGGESTION)

FEATURE_BY_KIND = {
    KIND_ALERT_PRIORITY: FEATURE_ALERTS_EXPLAIN,
    KIND_EXECUTIVE_SUMMARY: FEATURE_EXECUTIVE_SUMMARY,
    KIND_QUALITY_SUGGESTION: FEATURE_DATA_QUALITY,
}
KIND_BY_FEATURE = {feature: kind for kind, feature in FEATURE_BY_KIND.items()}

TITLES = {
    KIND_ALERT_PRIORITY: "Prioridade dos alertas",
    KIND_EXECUTIVE_SUMMARY: "Resumo executivo",
    KIND_QUALITY_SUGGESTION: "Sugestões de qualidade de dados",
}

CACHE_PREFIX = "sispat:ai:insights"
# TTL > período do agendamento, para o insight não sumir entre execuções.
TTL_SECONDS = {
    KIND_ALERT_PRIORITY: 8 * 3600,
    KIND_EXECUTIVE_SUMMARY: 30 * 3600,
    KIND_QUALITY_SUGGESTION: 30 * 3600,
}

# Falhas que valem para TODAS as unidades: interrompe o laço (sem custo/ruído).
_STOP_KINDS = frozenset({ERROR_DISABLED, ERROR_NOT_CONFIGURED, ERROR_CIRCUIT_OPEN, ERROR_QUOTA_EXCEEDED})

# Regras que representam qualidade de dados -> (problema, campo).
QUALITY_RULES: dict[str, tuple[str, str]] = {
    "assets_no_responsible": ("sem_responsavel", "responsavel"),
    "assets_no_location": ("sem_localizacao", "localizacao"),
    "assets_duplicate_patrimony": ("duplicidade", "numero_patrimonial"),
    "assets_nonstandard_patrimony": ("fora_do_padrao", "numero_patrimonial"),
    "sync_conflicts_pending": ("conflito_sincronizacao", "sincronizacao"),
    "import_records_conflict": ("conflito_importacao", "importacao"),
}

_SYSTEM_SCOPE_USER = uuid.UUID(int=0)  # marcador: só satisfaz `user_id is not None`
_MAX_UNITS = 500


@dataclass(frozen=True)
class UnitRef:
    id: uuid.UUID
    code: str
    name: str


# ---------------------------------------------------------------------------
# Escopo de unidade para tasks (sem usuário)
# ---------------------------------------------------------------------------


class _FixedRows:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def filter(self, *_a: Any, **_k: Any) -> "_FixedRows":
        return self

    def all(self) -> list[tuple[Any, ...]]:
        return list(self._rows)


class _UnitScopedSession:
    """Sessão que responde ao escopo (`user_unit_access`) com UMA unidade fixa."""

    def __init__(self, db: Any, unit_id: uuid.UUID) -> None:
        self._db = db
        self._unit_id = unit_id

    def query(self, *columns: Any) -> Any:
        if len(columns) == 1 and columns[0] is UserUnitAccess.unit_id:
            return _FixedRows([(self._unit_id,)])
        return self._db.query(*columns)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


def list_active_units(session_factory: Callable[[], Any]) -> list[UnitRef]:
    with session_factory() as db:
        rows = (
            db.query(Unit.id, Unit.code, Unit.name)
            .filter(Unit.active.is_(True))
            .order_by(Unit.code)
            .limit(_MAX_UNITS)
            .all()
        )
    return [UnitRef(id=r[0], code=str(r[1]), name=str(r[2])) for r in rows]


def evaluate_unit_alerts(
    unit_id: uuid.UUID,
    *,
    session_factory: Callable[[], Any],
    settings: Settings,
    now: datetime,
    rules: Sequence[AlertRule] | None = None,
) -> list[AlertItem]:
    """Alertas determinísticos de UMA unidade; cada regra em sessão própria."""
    items: list[AlertItem] = []
    for rule in rules if rules is not None else RULES:
        try:
            with session_factory() as db:
                ctx = RuleContext(
                    db=_UnitScopedSession(db, unit_id), user_id=_SYSTEM_SCOPE_USER, now=now, settings=settings
                )
                found = rule.run(ctx)
        except Exception as exc:  # noqa: BLE001 - isolamento por regra
            logger.error("ai_insights: regra '%s' indisponível (%s)", rule.code, type(exc).__name__)
            continue
        items.extend(item for item in found if item.count > 0)
    return items


def count_unit_assets(unit_id: uuid.UUID, *, session_factory: Callable[[], Any]) -> int:
    from sqlalchemy import func

    from app.models.assets import Asset

    with session_factory() as db:
        return int(
            db.query(func.count(Asset.id))
            .filter(Asset.unit_id == unit_id, Asset.deleted_at.is_(None))
            .scalar()
            or 0
        )


# ---------------------------------------------------------------------------
# DTOs agregados (allowlist de `redaction.ALLOWED_FIELDS`)
# ---------------------------------------------------------------------------


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_dto(kind: str, unit: UnitRef, alerts: Iterable[AlertItem], total_assets: int, now: datetime) -> dict[str, Any] | None:
    """DTO agregado da funcionalidade, ou None se não há o que analisar."""
    alert_list = list(alerts)
    base: dict[str, Any] = {
        "unit_code": unit.code,
        "unit_label": unit.name,
        "generated_at": _iso(now),
    }
    if kind == KIND_QUALITY_SUGGESTION:
        issues = [
            {"issue": QUALITY_RULES[a.code][0], "rule": a.code, "field_name": QUALITY_RULES[a.code][1],
             "examples_count": a.count}
            for a in alert_list
            if a.code in QUALITY_RULES
        ]
        if not issues:
            return None
        return {**base, "issues": issues}
    if not alert_list:
        return None
    alerts_dto = [{"alert_type": a.code, "severity": a.severity, "count": a.count} for a in alert_list]
    if kind == KIND_ALERT_PRIORITY:
        return {**base, "alerts": alerts_dto}
    return {**base, "period": "diario", "metrics": {"total": total_assets}, "alerts": alerts_dto}


# ---------------------------------------------------------------------------
# Cache (Redis)
# ---------------------------------------------------------------------------


def cache_key(unit_id: Any, kind: str) -> str:
    return f"{CACHE_PREFIX}:{unit_id}:{kind}"


def store_insight(
    redis_client: Any, unit: UnitRef, kind: str, text: str, now: datetime
) -> bool:
    """Grava o insight com TTL. Nunca lança; False se não gravou."""
    clean = sanitize_output(text)
    if redis_client is None or not clean or kind not in KINDS:
        return False
    entry = {"generated_at": _iso(now), "unit_label": unit.name, "text": clean}
    try:
        redis_client.set(cache_key(unit.id, kind), json.dumps(entry, ensure_ascii=False), ex=TTL_SECONDS[kind])
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_insights: falha ao gravar cache (%s)", type(exc).__name__)
        return False
    return True


def read_insights(redis_client: Any, units: Sequence[UnitRef], allowed_kinds: Iterable[str]) -> list[dict[str, Any]]:
    """Insights em cache das unidades dadas. Nunca lança; Redis fora => []."""
    if redis_client is None:
        return []
    kinds = [k for k in KINDS if k in set(allowed_kinds)]
    out: list[dict[str, Any]] = []
    multi = len(units) > 1
    for kind in kinds:
        for unit in sorted(units, key=lambda u: u.code):
            try:
                raw = redis_client.get(cache_key(unit.id, kind))
                if raw is None:
                    continue
                data = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
                text = data.get("text")
                generated_at = data.get("generated_at")
                if not isinstance(text, str) or not text.strip() or not isinstance(generated_at, str):
                    continue
            except Exception as exc:  # noqa: BLE001
                logger.warning("ai_insights: falha ao ler cache (%s)", type(exc).__name__)
                return []
            title = TITLES[kind] + (f" — {unit.name}" if multi else "")
            out.append(
                {"kind": kind, "title": title, "text": sanitize_output(text), "generated_at": generated_at}
            )
    return out


# ---------------------------------------------------------------------------
# Execução das tasks
# ---------------------------------------------------------------------------


def run_insight_feature(
    feature: str,
    *,
    config: AIConfig,
    session_factory: Callable[[], Any] | None = None,
    settings: Settings | None = None,
    redis_client: Any = _AUTO,
    http_session: Any | None = None,
    audit_writer: Any | None = None,
    now: datetime | None = None,
    rules: Sequence[AlertRule] | None = None,
) -> dict[str, Any]:
    """Gera e cacheia o insight de `feature` para cada unidade ativa. Nunca lança."""
    summary: dict[str, Any] = {"feature": feature, "units": 0, "stored": 0, "skipped": None}
    try:
        kind = KIND_BY_FEATURE.get(feature)
        if kind is None:
            summary["skipped"] = "invalid_feature"
            return summary
        if not config.feature_enabled(feature):
            summary["skipped"] = "feature_disabled"
            return summary
        s = settings or get_settings()
        client = build_redis_client(s) if redis_client is _AUTO else redis_client
        if compute_status(config, settings=s, redis_client=client) != "active":
            summary["skipped"] = "ai_unavailable"
            return summary
        if session_factory is None:
            from app.database.session import get_db_session

            session_factory = get_db_session
        moment = now or datetime.now(timezone.utc)
        service = AIService(
            config, settings=s, redis_client=client, http_session=http_session,
            audit_writer=audit_writer, enforce_rate_limit=False,
        )
        for unit in list_active_units(session_factory):
            summary["units"] += 1
            alerts = evaluate_unit_alerts(
                unit.id, session_factory=session_factory, settings=s, now=moment, rules=rules
            )
            total = count_unit_assets(unit.id, session_factory=session_factory)
            dto = build_dto(kind, unit, alerts, total, moment)
            if dto is None:
                continue
            result = service.run_feature(feature, dto, AIActor(user_id=None, unit_id=unit.id))
            if result.ok and result.text.strip():
                if store_insight(client, unit, kind, result.text, moment):
                    summary["stored"] += 1
            elif result.error_kind in _STOP_KINDS:
                summary["skipped"] = result.error_kind
                break
    except Exception as exc:  # noqa: BLE001 - task nunca lança
        logger.error("ai_insights: falha na geração (%s)", type(exc).__name__)
        summary["skipped"] = "internal_error"
    return summary
