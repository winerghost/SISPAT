"""Camada de IA consultiva do SISPAT-AGU (somente leitura, degradação graciosa).

Ponto de entrada: `AIService` (service.py) e as funções de `factory.py`
(`AIConfig`, `get_provider`, `resolve_provider`, `compute_status`,
`key_status`). Qualquer falha resulta em `NullProvider`/`AIResult` neutro —
nunca em exceção para o chamador. Chaves de API só vêm do ambiente.
"""
from app.services.ai.base import AIProvider, AIRequest, AIResult
from app.services.ai.factory import (
    AIConfig,
    compute_status,
    effective_token_cap,
    get_provider,
    key_status,
    resolve_provider,
)
from app.services.ai.models import AI_FEATURES, AI_PROVIDERS, ALLOWED_MODELS, models_by_provider
from app.services.ai.null_provider import NullProvider
from app.services.ai.service import AIActor, AIService, ConnectionTestResult

__all__ = [
    "AIProvider",
    "AIRequest",
    "AIResult",
    "AIConfig",
    "AIActor",
    "AIService",
    "ConnectionTestResult",
    "NullProvider",
    "compute_status",
    "effective_token_cap",
    "get_provider",
    "key_status",
    "resolve_provider",
    "AI_FEATURES",
    "AI_PROVIDERS",
    "ALLOWED_MODELS",
    "models_by_provider",
]
