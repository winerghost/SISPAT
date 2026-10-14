"""Cliente HTTP de saída para provedores de IA (padrão `n8n_client`).

Garantias:
    - HTTPS obrigatório e host FIXO por provedor (`PROVIDER_HOSTS`); o caminho
      vem de constantes do código. Nenhum dado de entrada altera o destino.
    - `timeout` em toda chamada; `allow_redirects=False` (3xx = falha).
    - Retry SOMENTE em `Timeout`/`ConnectionError`, no máximo 2 tentativas.
    - Nunca lança exceção: devolve `HTTPOutcome`.
    - A chave (header) NUNCA é logada; logs só têm provedor, status e
      `type(exc).__name__`. O corpo de erro do provedor nunca é logado nem
      repassado.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

import requests

from app.services.ai.base import (
    ERROR_AUTH,
    ERROR_BAD_REQUEST,
    ERROR_BAD_RESPONSE,
    ERROR_CONNECTION,
    ERROR_INTERNAL,
    ERROR_RATE_LIMITED,
    ERROR_REDIRECT,
    ERROR_TIMEOUT,
    ERROR_UPSTREAM,
)

logger = logging.getLogger(__name__)

PROVIDER_HOSTS: Mapping[str, str] = {
    "openai": "api.openai.com",
    "anthropic": "api.anthropic.com",
    "deepseek": "api.deepseek.com",
}

MAX_ATTEMPTS = 2
# Resposta acima disso é tratada como malformada (defesa contra respostas gigantes).
MAX_RESPONSE_BYTES = 1_000_000


@dataclass(frozen=True)
class HTTPOutcome:
    ok: bool
    status_code: int | None = None
    payload: dict[str, Any] | None = field(default=None, repr=False)
    error_kind: str | None = None


class AIHttpClient:
    """POST JSON para `https://<host fixo do provedor><path>`."""

    def __init__(
        self,
        provider: str,
        path: str,
        *,
        timeout: float,
        session: requests.Session | None = None,
        max_attempts: int = MAX_ATTEMPTS,
        backoff_seconds: float = 0.5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        host = PROVIDER_HOSTS.get(provider)
        if host is None:
            raise ValueError("provedor de IA desconhecido")
        if not path.startswith("/") or "//" in path or "@" in path or "?" in path:
            raise ValueError("caminho de API inválido")
        self.provider = provider
        self.url = f"https://{host}{path}"
        self._timeout = timeout
        self._session = session or requests.Session()
        self._attempts = max(1, min(int(max_attempts), MAX_ATTEMPTS))
        self._backoff = backoff_seconds
        self._sleep = sleep

    def __repr__(self) -> str:
        return f"<AIHttpClient provider={self.provider!r}>"

    def post_json(self, headers: Mapping[str, str], body: Mapping[str, Any]) -> HTTPOutcome:
        try:
            return self._post_json(headers, body)
        except Exception as exc:  # noqa: BLE001 - nunca propaga
            logger.error("ai_http: erro inesperado provider=%s erro=%s", self.provider, type(exc).__name__)
            return HTTPOutcome(ok=False, error_kind=ERROR_INTERNAL)

    def _post_json(self, headers: Mapping[str, str], body: Mapping[str, Any]) -> HTTPOutcome:
        for attempt in range(1, self._attempts + 1):
            try:
                response = self._session.post(
                    self.url,
                    json=dict(body),
                    headers=dict(headers),
                    timeout=self._timeout,
                    allow_redirects=False,
                )
            except requests.exceptions.Timeout as exc:
                kind = ERROR_TIMEOUT
                err_name = type(exc).__name__
            except requests.exceptions.ConnectionError as exc:
                kind = ERROR_CONNECTION
                err_name = type(exc).__name__
            except requests.exceptions.RequestException as exc:
                logger.warning("ai_http: falha definitiva provider=%s erro=%s", self.provider, type(exc).__name__)
                return HTTPOutcome(ok=False, error_kind=ERROR_CONNECTION)
            else:
                return self._interpret(response)

            logger.warning(
                "ai_http: %s provider=%s tentativa=%d/%d erro=%s",
                kind, self.provider, attempt, self._attempts, err_name,
            )
            if attempt < self._attempts:
                self._sleep(self._backoff * attempt)
                continue
            return HTTPOutcome(ok=False, error_kind=kind)

        return HTTPOutcome(ok=False, error_kind=ERROR_INTERNAL)  # pragma: no cover

    def _interpret(self, response: requests.Response) -> HTTPOutcome:
        status = int(getattr(response, "status_code", 0) or 0)
        if 200 <= status < 300:
            content = getattr(response, "content", b"") or b""
            if isinstance(content, (bytes, str)) and len(content) > MAX_RESPONSE_BYTES:
                logger.warning("ai_http: resposta grande demais provider=%s", self.provider)
                return HTTPOutcome(ok=False, status_code=status, error_kind=ERROR_BAD_RESPONSE)
            try:
                payload = response.json()
            except ValueError:
                logger.warning("ai_http: JSON malformado provider=%s status=%d", self.provider, status)
                return HTTPOutcome(ok=False, status_code=status, error_kind=ERROR_BAD_RESPONSE)
            if not isinstance(payload, dict):
                return HTTPOutcome(ok=False, status_code=status, error_kind=ERROR_BAD_RESPONSE)
            return HTTPOutcome(ok=True, status_code=status, payload=payload)

        if 300 <= status < 400:
            kind = ERROR_REDIRECT
        elif status in (401, 403):
            kind = ERROR_AUTH
        elif status == 429:
            kind = ERROR_RATE_LIMITED
        elif status >= 500:
            kind = ERROR_UPSTREAM
        else:
            kind = ERROR_BAD_REQUEST
        logger.warning("ai_http: provider=%s status=%d kind=%s", self.provider, status, kind)
        return HTTPOutcome(ok=False, status_code=status, error_kind=kind)
