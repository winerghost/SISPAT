"""Tipos básicos da camada de IA: requisição, resultado e protocolo de provedor.

Padrão de `app.integrations.n8n_client.N8nIntegrationResult`: o resultado é
uma dataclass congelada e NENHUM provedor lança exceção para o chamador —
qualquer falha vira `AIResult(ok=False, error_kind=...)`. Nenhum objeto
desta camada carrega chave de API em campos com `repr`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

# --- Tipos de erro (estáveis; nunca contêm mensagem do provedor) -----------
ERROR_DISABLED = "disabled"  # AI_ENABLED=false ou ai_settings.enabled=false/provider none
ERROR_FEATURE_DISABLED = "feature_disabled"
ERROR_INVALID_FEATURE = "invalid_feature"
ERROR_NOT_CONFIGURED = "not_configured"  # chave ausente
ERROR_DEEPSEEK_ACK_REQUIRED = "deepseek_ack_required"
ERROR_INVALID_MODEL = "invalid_model"
ERROR_CIRCUIT_OPEN = "circuit_open"  # inclui Redis indisponível (falha fechada)
ERROR_QUOTA_EXCEEDED = "quota_exceeded"  # teto mensal de tokens
ERROR_LOCAL_RATE_LIMITED = "local_rate_limited"  # limite por usuário/unidade
ERROR_BLOCKED_SENSITIVE = "blocked_sensitive_data"  # varredura LGPD bloqueou
ERROR_AUTH = "auth_error"  # 401/403 do provedor
ERROR_RATE_LIMITED = "provider_rate_limited"  # 429 do provedor (cota)
ERROR_UPSTREAM = "upstream_error"  # 5xx
ERROR_BAD_REQUEST = "bad_request"  # demais 4xx
ERROR_TIMEOUT = "timeout"
ERROR_CONNECTION = "connection_error"
ERROR_REDIRECT = "redirect"  # 3xx nunca é seguido
ERROR_BAD_RESPONSE = "bad_response"  # JSON malformado/inesperado ou vazio
ERROR_INTERNAL = "internal_error"

# Falhas atribuíveis ao provedor (contam para o circuit breaker).
PROVIDER_FAILURE_KINDS = frozenset(
    {
        ERROR_AUTH,
        ERROR_RATE_LIMITED,
        ERROR_UPSTREAM,
        ERROR_BAD_REQUEST,
        ERROR_TIMEOUT,
        ERROR_CONNECTION,
        ERROR_REDIRECT,
        ERROR_BAD_RESPONSE,
    }
)

# Motivos que significam "desligado" (não "indisponível") para a UI.
DISABLED_KINDS = frozenset({ERROR_DISABLED})


@dataclass(frozen=True)
class AIRequest:
    """Requisição a um provedor. `system`/`user` ficam fora do repr."""

    model: str
    system: str = field(repr=False)
    user: str = field(repr=False)
    max_tokens: int = 800
    feature: str = ""


@dataclass(frozen=True)
class AIResult:
    """Resultado de uma chamada de IA. Nunca contém chave nem erro bruto do provedor."""

    ok: bool
    text: str = field(default="", repr=False)
    tokens_in: int = 0
    tokens_out: int = 0
    error_kind: str | None = None
    provider: str = "none"
    model: str | None = None
    latency_ms: int | None = None

    @classmethod
    def neutral(
        cls, error_kind: str, *, provider: str = "none", model: str | None = None
    ) -> "AIResult":
        """Resultado neutro (sem texto) para qualquer degradação."""
        return cls(ok=False, text="", error_kind=error_kind, provider=provider, model=model)


@runtime_checkable
class AIProvider(Protocol):
    """Contrato de provedor: `complete` NUNCA lança exceção."""

    name: str

    def complete(self, request: AIRequest) -> AIResult:  # pragma: no cover - protocolo
        ...
