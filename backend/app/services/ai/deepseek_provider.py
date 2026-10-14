"""Provedor DeepSeek (API compatível com OpenAI em https://api.deepseek.com).

Fonte: https://api-docs.deepseek.com/ (base URL formato OpenAI:
`https://api.deepseek.com`, endpoint `/chat/completions`).

Uso condicionado ao aceite explícito do ADM sobre transferência
internacional de dados (LGPD) — verificado em `factory.resolve_provider`.
"""
from __future__ import annotations

from typing import Any

from app.services.ai.openai_provider import OpenAICompatibleProvider


class DeepSeekProvider(OpenAICompatibleProvider):
    name = "deepseek"
    path = "/chat/completions"
    max_tokens_param = "max_tokens"
    extra_body: dict[str, Any] = {}
