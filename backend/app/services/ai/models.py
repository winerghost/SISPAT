"""Allowlists da camada de IA: provedores, modelos por provedor e funcionalidades.

O schema da API rejeita qualquer modelo fora desta lista (nunca string livre).
Mantenha 2-4 modelos por provedor e cite a fonte ao atualizar.

Fontes (consultadas em 2026-10-14):
- OpenAI: https://developers.openai.com/api/docs/models e páginas dos modelos
  (`gpt-6.1-sol`, `gpt-6-luna`: suportam v1/chat/completions).
- Anthropic: IDs atuais informados pelo coordenador do projeto
  (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5; API Messages).
- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
  (`deepseek-flash`, `deepseek-v4-pro`; base https://api.deepseek.com,
  formato compatível com OpenAI).
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Mapping

PROVIDER_NONE = "none"
PROVIDER_OPENAI = "openai"
PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_DEEPSEEK = "deepseek"

# Provedores reais (com chave), na ordem exibida pela UI.
AI_PROVIDERS: tuple[str, ...] = (PROVIDER_OPENAI, PROVIDER_ANTHROPIC, PROVIDER_DEEPSEEK)
# Valores aceitos em ai_settings.provider (CHECK da migração 0005).
ALL_PROVIDER_VALUES: tuple[str, ...] = (PROVIDER_NONE, *AI_PROVIDERS)

# O primeiro modelo de cada tupla é o padrão do provedor.
ALLOWED_MODELS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        PROVIDER_OPENAI: ("gpt-6.1-sol", "gpt-6-luna"),
        PROVIDER_ANTHROPIC: ("claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"),
        PROVIDER_DEEPSEEK: ("deepseek-flash", "deepseek-v4-pro"),
    }
)

# Funcionalidades de IA (chaves aceitas em ai_settings.features).
FEATURE_ALERTS_EXPLAIN = "alerts_explain"
FEATURE_EXECUTIVE_SUMMARY = "executive_summary"
FEATURE_ASSISTANT = "assistant"
FEATURE_DATA_QUALITY = "data_quality"
AI_FEATURES: tuple[str, ...] = (
    FEATURE_ALERTS_EXPLAIN,
    FEATURE_EXECUTIVE_SUMMARY,
    FEATURE_ASSISTANT,
    FEATURE_DATA_QUALITY,
)


def is_known_provider(provider: str | None) -> bool:
    return provider in AI_PROVIDERS


def is_allowed_model(provider: str | None, model: str | None) -> bool:
    """True somente se `model` estiver na allowlist do `provider`."""
    if not isinstance(provider, str) or not isinstance(model, str):
        return False
    return model in ALLOWED_MODELS.get(provider, ())


def default_model(provider: str | None) -> str | None:
    models = ALLOWED_MODELS.get(provider or "", ())
    return models[0] if models else None


def models_by_provider() -> dict[str, list[str]]:
    """Cópia serializável da allowlist (para o GET /settings/ai)."""
    return {provider: list(models) for provider, models in ALLOWED_MODELS.items()}


def default_features() -> dict[str, bool]:
    return {feature: False for feature in AI_FEATURES}
