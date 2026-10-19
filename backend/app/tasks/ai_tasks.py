"""Tasks de IA. Somente leitura; qualquer falha degrada para NullProvider.

`ping_ai_provider`: placeholder seguro. Lê `ai_settings` e devolve o status
consolidado. Só chama o provedor (prompt fixo, sem dados do sistema) se
`probe=True` E a IA estiver ativa; desligada => NullProvider, sem rede.
NÃO está no beat_schedule (não gera custo periódico). As tasks de insights
(alertas, resumo executivo, qualidade) estão no beat e só agem com a flag da
respectiva funcionalidade ligada.
"""
from __future__ import annotations

import logging
from typing import Any

from app.celery_app import celery_app
from app.services.ai.factory import AIConfig, compute_status, resolve_provider
from app.services.ai.models import (
    FEATURE_ALERTS_EXPLAIN,
    FEATURE_DATA_QUALITY,
    FEATURE_EXECUTIVE_SUMMARY,
)
from app.services.ai.null_provider import NullProvider

logger = logging.getLogger(__name__)

SYSTEM_ACTOR = None  # tasks de sistema não têm usuário ator


def _load_config() -> AIConfig:
    try:
        from app.database.session import get_db_session
        from app.models.settings import AI_SETTINGS_SINGLETON_ID, AISettings

        with get_db_session() as db:
            return AIConfig.from_row(db.get(AISettings, AI_SETTINGS_SINGLETON_ID))
    except Exception as exc:  # noqa: BLE001 - banco fora => IA desligada
        logger.warning("ai_tasks: não foi possível ler ai_settings (%s)", type(exc).__name__)
        return AIConfig()


def run_ping(config: AIConfig, *, probe: bool = False, **kwargs: Any) -> dict[str, Any]:
    """Núcleo testável da task (sem Celery)."""
    status = compute_status(config, **{k: v for k, v in kwargs.items() if k in ("settings", "redis_client")})
    provider, reason = resolve_provider(config, **kwargs)
    if isinstance(provider, NullProvider) or not probe:
        return {"status": status, "probed": False, "reason": reason}
    from app.services.ai.service import AIActor, AIService

    service_kwargs = {k: v for k, v in kwargs.items() if k in ("settings", "redis_client")}
    if "session" in kwargs:
        service_kwargs["http_session"] = kwargs["session"]
    result = AIService(config, **service_kwargs).test_connection(AIActor(user_id=SYSTEM_ACTOR))
    return {"status": status, "probed": True, "result": result.result}


@celery_app.task(name="sispat.ai.ping_provider", ignore_result=False)
def ping_ai_provider(probe: bool = False) -> dict[str, Any]:
    try:
        return run_ping(_load_config(), probe=bool(probe))
    except Exception as exc:  # noqa: BLE001
        logger.error("ai_tasks: ping falhou (%s)", type(exc).__name__)
        return {"status": "unavailable", "probed": False, "reason": "internal_error"}


# --- Insights do dashboard (Etapa 4b) ----------------------------------------
# Entrada = só DTOs agregados dos alertas determinísticos (ver
# `app.services.ai.insights`). Cada task respeita a flag da própria
# funcionalidade; sem IA/erro/NullProvider nada é gravado. Sem argumentos
# (nenhuma entrada de usuário chega às tasks).


_INSIGHT_SOFT_LIMIT = 1500  # várias unidades x chamadas de até AI_TIMEOUT_SECONDS
_INSIGHT_HARD_LIMIT = 1800


def run_insight_task(feature: str, **kwargs: Any) -> dict[str, Any]:
    """Núcleo testável (sem Celery): lê a config e gera os insights da funcionalidade."""
    from app.services.ai.insights import run_insight_feature

    config = kwargs.pop("config", None) or _load_config()
    return run_insight_feature(feature, config=config, **kwargs)


def _safe_run(feature: str) -> dict[str, Any]:
    try:
        return run_insight_task(feature)
    except Exception as exc:  # noqa: BLE001
        logger.error("ai_tasks: %s falhou (%s)", feature, type(exc).__name__)
        return {"feature": feature, "units": 0, "stored": 0, "skipped": "internal_error"}


@celery_app.task(name="sispat.ai.alerts_priority", ignore_result=False, soft_time_limit=_INSIGHT_SOFT_LIMIT, time_limit=_INSIGHT_HARD_LIMIT)
def generate_alerts_priority() -> dict[str, Any]:
    return _safe_run(FEATURE_ALERTS_EXPLAIN)


@celery_app.task(name="sispat.ai.executive_summary", ignore_result=False, soft_time_limit=_INSIGHT_SOFT_LIMIT, time_limit=_INSIGHT_HARD_LIMIT)
def generate_executive_summary() -> dict[str, Any]:
    return _safe_run(FEATURE_EXECUTIVE_SUMMARY)


@celery_app.task(name="sispat.ai.quality_suggestions", ignore_result=False, soft_time_limit=_INSIGHT_SOFT_LIMIT, time_limit=_INSIGHT_HARD_LIMIT)
def generate_quality_suggestions() -> dict[str, Any]:
    return _safe_run(FEATURE_DATA_QUALITY)
