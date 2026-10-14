"""Provedor OpenAI (Chat Completions) e base compatível com OpenAI (DeepSeek).

POST https://api.openai.com/v1/chat/completions, `Authorization: Bearer`.
Nunca lança exceção; chave fora de repr/str/logs.
"""
from __future__ import annotations

import time
from typing import Any

import requests

from app.services.ai.base import (
    ERROR_BAD_RESPONSE,
    ERROR_INVALID_MODEL,
    ERROR_NOT_CONFIGURED,
    AIRequest,
    AIResult,
)
from app.services.ai.http import AIHttpClient
from app.services.ai.models import is_allowed_model


def _non_negative_int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


class OpenAICompatibleProvider:
    """Base para APIs no formato Chat Completions da OpenAI."""

    name = "openai"
    path = "/v1/chat/completions"
    max_tokens_param = "max_completion_tokens"
    # Pede à OpenAI que não armazene a conversa (LGPD); omitido em terceiros.
    extra_body: dict[str, Any] = {"store": False}

    def __init__(
        self,
        api_key: str | None,
        *,
        timeout: float,
        session: requests.Session | None = None,
        http_client: AIHttpClient | None = None,
    ) -> None:
        self._api_key = (api_key or "").strip() or None
        self._http = http_client or AIHttpClient(self.name, self.path, timeout=timeout, session=session)

    def __repr__(self) -> str:
        return f"<{type(self).__name__} configured={self._api_key is not None}>"

    __str__ = __repr__

    def complete(self, request: AIRequest) -> AIResult:
        try:
            return self._complete(request)
        except Exception:  # noqa: BLE001 - provedor nunca lança
            return AIResult.neutral(ERROR_BAD_RESPONSE, provider=self.name, model=request.model)

    def _complete(self, request: AIRequest) -> AIResult:
        if self._api_key is None:
            return AIResult.neutral(ERROR_NOT_CONFIGURED, provider=self.name, model=request.model)
        if not is_allowed_model(self.name, request.model):
            return AIResult.neutral(ERROR_INVALID_MODEL, provider=self.name, model=request.model)

        body: dict[str, Any] = {
            "model": request.model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            self.max_tokens_param: request.max_tokens,
            **self.extra_body,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        started = time.monotonic()
        outcome = self._http.post_json(headers, body)
        latency = int((time.monotonic() - started) * 1000)
        if not outcome.ok or outcome.payload is None:
            return AIResult(
                ok=False, error_kind=outcome.error_kind, provider=self.name,
                model=request.model, latency_ms=latency,
            )

        payload = outcome.payload
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            return AIResult.neutral(ERROR_BAD_RESPONSE, provider=self.name, model=request.model)
        message = choices[0].get("message")
        text = message.get("content") if isinstance(message, dict) else None
        if not isinstance(text, str) or not text.strip():
            return AIResult.neutral(ERROR_BAD_RESPONSE, provider=self.name, model=request.model)
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return AIResult(
            ok=True,
            text=text,
            tokens_in=_non_negative_int(usage.get("prompt_tokens")),
            tokens_out=_non_negative_int(usage.get("completion_tokens")),
            provider=self.name,
            model=request.model,
            latency_ms=latency,
        )


class OpenAIProvider(OpenAICompatibleProvider):
    name = "openai"
