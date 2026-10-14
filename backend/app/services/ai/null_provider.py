"""NullProvider: degradação graciosa. Nunca faz rede; sempre `AIResult` neutro."""
from __future__ import annotations

from app.services.ai.base import ERROR_DISABLED, AIRequest, AIResult


class NullProvider:
    name = "none"

    def __init__(self, reason: str = ERROR_DISABLED) -> None:
        self.reason = reason

    def __repr__(self) -> str:
        return f"<NullProvider reason={self.reason!r}>"

    def complete(self, request: AIRequest) -> AIResult:  # noqa: ARG002 - interface
        return AIResult.neutral(self.reason)
