"""Provedor Anthropic (Messages API) via `requests`, sem SDK.

POST https://api.anthropic.com/v1/messages com `x-api-key` e
`anthropic-version: 2023-06-01`. Nunca lança exceção; chave fora de
repr/str/logs.
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
from app.services.ai.openai_provider import _non_negative_int

ANTHROPIC_VERSION = "2023-06-01"


class AnthropicProvider:
    name = "anthropic"
    path = "/v1/messages"

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
        return f"<AnthropicProvider configured={self._api_key is not None}>"

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
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": [{"role": "user", "content": request.user}],
        }
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_VERSION,
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
        content = payload.get("content")
        if not isinstance(content, list):
            return AIResult.neutral(ERROR_BAD_RESPONSE, provider=self.name, model=request.model)
        parts = [
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        ]
        text = "".join(parts)
        if not text.strip():
            return AIResult.neutral(ERROR_BAD_RESPONSE, provider=self.name, model=request.model)
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return AIResult(
            ok=True,
            text=text,
            tokens_in=_non_negative_int(usage.get("input_tokens")),
            tokens_out=_non_negative_int(usage.get("output_tokens")),
            provider=self.name,
            model=request.model,
            latency_ms=latency,
        )
