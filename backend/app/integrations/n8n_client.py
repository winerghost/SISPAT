"""Cliente HTTP para a integração do SISPAT-AGU com a instância n8n externa.

A instância n8n usada por este projeto é EXTERNA (hospedada na VPS do
usuário, fora deste repositório). Este módulo apenas dispara webhooks/eventos
para ela a partir do backend Flask; não implementa nenhum workflow do n8n.

Garantias deste cliente (`N8nClient`):

    - **Feature flag**: se `settings.n8n_integration_enabled` for `False`
      (o default), nenhuma chamada de rede é feita. `trigger_webhook` retorna
      imediatamente um `N8nIntegrationResult(disabled=True)`.
    - **Nunca derruba a operação chamadora**: qualquer erro de rede, timeout
      ou resposta HTTP de erro do n8n é capturado, logado via `logging`
      padrão (formato estruturado simples de texto) e convertido em um
      `N8nIntegrationResult(success=False, error=...)`. A exceção original só
      é relançada quando o chamador passa `raise_on_error=True` explicitamente
      — o padrão é sempre seguro para quem dispara eventos a partir de uma
      operação patrimonial (ex.: criação/movimentação de bem).
    - **Idempotência**: todo disparo de webhook aceita (ou gera, via
      `uuid4()`) uma `idempotency_key`, enviada tanto no header
      `Idempotency-Key` quanto no campo `idempotency_key` do corpo JSON, para
      que o n8n possa deduplicar execuções de workflow em caso de retry do
      lado do backend.
    - **Autenticação**: se `settings.n8n_api_key` estiver configurada, é
      enviada no header `Authorization: Bearer <api_key>`. O valor da API key
      NUNCA é escrito em nenhuma mensagem de log deste módulo, em nenhuma
      circunstância (nem em mensagens de erro, nem em modo debug).
    - **Timeout configurável**: toda requisição usa
      `timeout=settings.n8n_request_timeout_seconds` (default: 10s).
    - **Retry limitado**: apenas falhas de timeout/conexão (`Timeout`,
      `ConnectionError`) são retentadas (poucas tentativas, com um pequeno
      backoff linear). Respostas HTTP de erro (4xx/5xx) são definitivas e NÃO
      são retentadas por este cliente — refletem uma rejeição explícita do
      n8n (ex.: payload inválido, autenticação incorreta), e insistir não
      mudaria o resultado.
    - **HTTPS obrigatório** (alterado na auditoria AppSec 2026-10-13; antes
      era apenas um aviso): em produção (`settings.is_production`) só URLs
      `https://` são aceitas; fora de produção, também `http://` para
      `localhost`/`127.0.0.1`/`::1` (hostname validado via `urlparse`, não
      por prefixo de string). URLs com credenciais embutidas são recusadas.
      URL fora da regra -> nenhuma requisição é feita e o resultado é
      `success=False` (a operação patrimonial chamadora nunca é bloqueada).
    - **Sem redirects**: `allow_redirects=False` — um 3xx é tratado como
      falha, nunca seguido para um host não configurado (API7/API10).
    - **URL só de configuração**: a URL vem exclusivamente de `settings`
      (`N8N_WEBHOOK_URL`/`N8N_BASE_URL`); nenhum parâmetro de chamada altera
      o destino.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from urllib.parse import urlparse

import requests

from app.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class N8nIntegrationResult:
    """Resultado de uma chamada ao n8n externo.

    Nunca contém o valor da API key, independentemente do resultado.
    """

    success: bool
    status_code: int | None = None
    error: str | None = None
    disabled: bool = False
    idempotency_key: str | None = None


_LOCAL_DEV_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _looks_secure_or_local(url: str) -> bool:
    """Retorna True se `url` usa HTTPS, ou se aponta para um host local de dev.

    Usa `urlparse` (hostname real) em vez de prefixo de string: a versão
    anterior aceitava `http://localhost.atacante.com` e
    `http://localhost@atacante.com` como "locais" (auditoria 2026-10-13).
    URLs com credenciais embutidas (`user:pass@`) nunca são aceitas.
    """
    try:
        parsed = urlparse(url.strip())
        hostname = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if not hostname or parsed.username is not None or parsed.password is not None:
        return False
    if parsed.scheme == "https":
        return True
    return parsed.scheme == "http" and hostname in _LOCAL_DEV_HOSTS


def _is_https(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
        return parsed.scheme == "https" and bool(parsed.hostname)
    except ValueError:
        return False


class N8nClient:
    """Cliente para disparar webhooks na instância n8n externa do SISPAT-AGU.

    Ver docstring do módulo para as garantias de segurança/robustez
    (feature flag, idempotência, não-propagação de exceções, HTTPS, timeout).
    """

    def __init__(
        self,
        settings: Settings | None = None,
        session: requests.Session | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._session = session or requests.Session()

    @property
    def enabled(self) -> bool:
        """Reflete a feature flag `N8N_INTEGRATION_ENABLED`."""
        return bool(self._settings.n8n_integration_enabled)

    def _resolve_url(self) -> str | None:
        """`n8n_webhook_url` tem prioridade; cai para `n8n_base_url` se ausente."""
        return self._settings.n8n_webhook_url or self._settings.n8n_base_url

    def _build_headers(self, idempotency_key: str) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
        }
        if self._settings.n8n_api_key:
            # O valor da chave é usado aqui, mas NUNCA incluído em nenhum log.
            headers["Authorization"] = f"Bearer {self._settings.n8n_api_key}"
        return headers

    def trigger_webhook(
        self,
        event_type: str,
        payload: dict[str, Any],
        idempotency_key: str | None = None,
        raise_on_error: bool = False,
        max_attempts: int = 2,
    ) -> N8nIntegrationResult:
        """Dispara um evento/webhook no n8n externo.

        Args:
            event_type: identificador do tipo de evento patrimonial
                (ex.: "asset.created", "asset.moved"). Enviado no corpo.
            payload: dados do evento. Uma cópia é enviada com os campos
                `event_type` e `idempotency_key` adicionados; o dict original
                do chamador não é mutado.
            idempotency_key: chave de idempotência a reutilizar (ex.: em um
                retry controlado pelo chamador). Se omitida, uma nova
                `uuid4()` é gerada.
            raise_on_error: se True, propaga a exceção original em caso de
                falha de rede/timeout/HTTP em vez de retornar um resultado
                "falhou". Default False (nunca derruba o chamador).
            max_attempts: número máximo de tentativas para falhas de
                timeout/conexão (default 2 = 1 tentativa original + 1 retry).

        Returns:
            `N8nIntegrationResult`. Quando a integração está desligada,
            `disabled=True` e nenhuma chamada de rede é feita.
        """
        key = idempotency_key or str(uuid4())

        if not self.enabled:
            logger.info(
                "n8n_client: integração desabilitada (N8N_INTEGRATION_ENABLED=false); "
                "event_type=%s idempotency_key=%s",
                event_type,
                key,
            )
            return N8nIntegrationResult(success=False, disabled=True, idempotency_key=key)

        url = self._resolve_url()
        if not url:
            error_msg = (
                "nenhuma URL configurada para o n8n "
                "(defina N8N_WEBHOOK_URL ou N8N_BASE_URL)"
            )
            logger.error(
                "n8n_client: %s; event_type=%s idempotency_key=%s",
                error_msg,
                event_type,
                key,
            )
            if raise_on_error:
                raise RuntimeError(error_msg)
            return N8nIntegrationResult(success=False, error=error_msg, idempotency_key=key)

        is_production = bool(getattr(self._settings, "is_production", False))
        url_allowed = _is_https(url) if is_production else _looks_secure_or_local(url)
        if not url_allowed:
            # HTTPS obrigatório (CLAUDE.md, "Integrações"): a chamada é
            # BLOQUEADA — nunca enviamos o Bearer token por canal inseguro.
            # Em produção, só `https://`; fora dela, também `http://` para
            # localhost/127.0.0.1/::1 (dev). URL nunca é logada (pode conter
            # token em query string).
            error_msg = (
                "URL do n8n rejeitada: HTTPS é obrigatório (http:// apenas para "
                "localhost fora de produção)"
            )
            logger.error(
                "n8n_client: %s; event_type=%s idempotency_key=%s",
                error_msg,
                event_type,
                key,
            )
            if raise_on_error:
                raise ValueError(error_msg)
            return N8nIntegrationResult(success=False, error=error_msg, idempotency_key=key)

        body: dict[str, Any] = dict(payload)
        body["event_type"] = event_type
        body["idempotency_key"] = key
        headers = self._build_headers(key)
        timeout = self._settings.n8n_request_timeout_seconds
        attempts = max(1, max_attempts)

        for attempt in range(1, attempts + 1):
            try:
                # `allow_redirects=False`: um redirect (3xx) para outro host
                # reenviaria o corpo (307/308) — e headers customizados —
                # a um destino não configurado (SSRF/vazamento, API7/API10).
                response = self._session.post(
                    url, json=body, headers=headers, timeout=timeout, allow_redirects=False
                )
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
                is_last_attempt = attempt >= attempts
                logger.warning(
                    "n8n_client: falha de timeout/conexão na tentativa %d/%d; "
                    "event_type=%s idempotency_key=%s erro=%s",
                    attempt,
                    attempts,
                    event_type,
                    key,
                    type(exc).__name__,
                )
                if not is_last_attempt:
                    time.sleep(0.5 * attempt)
                    continue

                error_msg = (
                    f"falha de rede ({type(exc).__name__}) ao chamar o n8n "
                    f"após {attempts} tentativa(s)"
                )
                logger.error(
                    "n8n_client: %s; event_type=%s idempotency_key=%s",
                    error_msg,
                    event_type,
                    key,
                )
                if raise_on_error:
                    raise
                return N8nIntegrationResult(success=False, error=error_msg, idempotency_key=key)
            except requests.exceptions.RequestException as exc:
                # Erros de request que não são de timeout/conexão (ex.: URL
                # malformada) são definitivos — não há retry.
                error_msg = f"erro ao chamar o n8n: {type(exc).__name__}"
                logger.error(
                    "n8n_client: %s; event_type=%s idempotency_key=%s",
                    error_msg,
                    event_type,
                    key,
                )
                if raise_on_error:
                    raise
                return N8nIntegrationResult(success=False, error=error_msg, idempotency_key=key)
            else:
                status = response.status_code
                if 200 <= status < 300:
                    logger.info(
                        "n8n_client: webhook disparado com sucesso; event_type=%s "
                        "idempotency_key=%s status=%d",
                        event_type,
                        key,
                        status,
                    )
                    return N8nIntegrationResult(
                        success=True, status_code=status, idempotency_key=key
                    )

                # Resposta HTTP de erro (4xx/5xx): definitiva, sem retry.
                error_msg = f"n8n respondeu com status HTTP {status}"
                logger.error(
                    "n8n_client: %s; event_type=%s idempotency_key=%s",
                    error_msg,
                    event_type,
                    key,
                )
                if raise_on_error:
                    response.raise_for_status()
                return N8nIntegrationResult(
                    success=False,
                    status_code=status,
                    error=error_msg,
                    idempotency_key=key,
                )

        # Inalcançável: o laço sempre retorna ou relança dentro de si mesmo.
        raise AssertionError("n8n_client: fluxo de retry terminou sem retornar um resultado")
