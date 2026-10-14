"""Testes do cliente de integração com o n8n externo (`app.integrations.n8n_client`).

Nenhuma chamada de rede real é feita: `requests.Session.post` é sempre
mockado via `unittest.mock.patch`.

Observação sobre o ambiente deste sandbox: `pytest` e `requests` podem não
estar instalados aqui. Este arquivo foi validado apenas com
`python -m py_compile` (sintaxe), não com uma execução real de `pytest`. A
execução de fato deve ocorrer em um ambiente com as dependências de
`requirements.txt` instaladas (`pip install -r requirements.txt`), por
exemplo:

    pip install -r backend/requirements.txt
    pytest backend/tests/test_n8n_client.py -v
"""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
import requests

from app.config.settings import Settings
from app.integrations.n8n_client import N8nClient, N8nIntegrationResult

API_KEY_SENTINEL = "segredo-super-secreto-nao-deve-aparecer-no-log-12345"


def _make_settings(**overrides: object) -> Settings:
    """Cria um `Settings` válido para testes, sem depender do ambiente real."""
    defaults: dict[str, object] = {
        "database_url": "postgresql+psycopg2://user:pass@localhost:5432/test",
        "secret_key": "test-secret-key",
        "n8n_integration_enabled": True,
        "n8n_webhook_url": "https://n8n.exemplo.com/webhook/sispat",
        "n8n_api_key": API_KEY_SENTINEL,
        "n8n_request_timeout_seconds": 10,
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def test_trigger_webhook_disabled_faz_nenhuma_chamada_de_rede() -> None:
    """Com a feature flag desligada, nenhuma chamada HTTP deve ocorrer."""
    settings = _make_settings(n8n_integration_enabled=False)
    client = N8nClient(settings=settings)

    with patch("requests.Session.post") as mock_post:
        result = client.trigger_webhook("asset.created", {"asset_id": 1})

    mock_post.assert_not_called()
    assert isinstance(result, N8nIntegrationResult)
    assert result.disabled is True
    assert result.success is False


def test_trigger_webhook_sucesso_http_200() -> None:
    """Uma resposta HTTP 200 simulada deve resultar em `success=True`."""
    settings = _make_settings()
    client = N8nClient(settings=settings)

    mock_response = MagicMock()
    mock_response.status_code = 200

    with patch("requests.Session.post", return_value=mock_response) as mock_post:
        result = client.trigger_webhook("asset.created", {"asset_id": 42})

    mock_post.assert_called_once()
    assert result.success is True
    assert result.status_code == 200
    assert result.disabled is False
    assert result.error is None

    # A idempotency key deve ter sido gerada e enviada tanto no header quanto no corpo.
    _, kwargs = mock_post.call_args
    assert "Idempotency-Key" in kwargs["headers"]
    assert kwargs["json"]["idempotency_key"] == result.idempotency_key
    assert kwargs["timeout"] == settings.n8n_request_timeout_seconds


def test_trigger_webhook_timeout_nao_propaga_exececao_por_padrao() -> None:
    """Uma exceção de rede (Timeout) deve ser capturada, não propagada, por padrão."""
    settings = _make_settings()
    client = N8nClient(settings=settings)

    with patch(
        "requests.Session.post", side_effect=requests.exceptions.Timeout("timed out")
    ) as mock_post:
        result = client.trigger_webhook(
            "asset.created", {"asset_id": 7}, raise_on_error=False, max_attempts=1
        )

    mock_post.assert_called_once()
    assert result.success is False
    assert result.disabled is False
    assert result.error is not None


def test_trigger_webhook_timeout_propaga_quando_raise_on_error() -> None:
    """Com `raise_on_error=True`, a exceção original deve ser relançada."""
    settings = _make_settings()
    client = N8nClient(settings=settings)

    with patch(
        "requests.Session.post", side_effect=requests.exceptions.Timeout("timed out")
    ):
        with pytest.raises(requests.exceptions.Timeout):
            client.trigger_webhook(
                "asset.created", {"asset_id": 7}, raise_on_error=True, max_attempts=1
            )


def test_trigger_webhook_retry_em_timeout_mas_nao_em_4xx() -> None:
    """Timeout deve ser retentado; uma resposta 400 não deve gerar retry."""
    settings = _make_settings()
    client = N8nClient(settings=settings)

    # Caso 1: timeout seguido de sucesso -> deve ter havido 2 chamadas.
    mock_response_ok = MagicMock()
    mock_response_ok.status_code = 200
    with patch(
        "requests.Session.post",
        side_effect=[requests.exceptions.Timeout("timed out"), mock_response_ok],
    ) as mock_post, patch("time.sleep", return_value=None):
        result = client.trigger_webhook(
            "asset.created", {"asset_id": 1}, max_attempts=2
        )
    assert mock_post.call_count == 2
    assert result.success is True

    # Caso 2: resposta 400 -> apenas 1 chamada (sem retry).
    mock_response_bad = MagicMock()
    mock_response_bad.status_code = 400
    with patch("requests.Session.post", return_value=mock_response_bad) as mock_post:
        result = client.trigger_webhook(
            "asset.created", {"asset_id": 1}, max_attempts=3
        )
    assert mock_post.call_count == 1
    assert result.success is False
    assert result.status_code == 400


def test_api_key_nunca_aparece_em_mensagens_de_log(caplog: pytest.LogCaptureFixture) -> None:
    """A API key nunca deve aparecer em nenhuma mensagem logada por este módulo,
    nem no caminho de sucesso, nem no de erro.
    """
    settings = _make_settings()
    client = N8nClient(settings=settings)

    mock_response = MagicMock()
    mock_response.status_code = 200

    with caplog.at_level(logging.DEBUG, logger="app.integrations.n8n_client"):
        with patch("requests.Session.post", return_value=mock_response):
            client.trigger_webhook("asset.created", {"asset_id": 1})

        with patch(
            "requests.Session.post",
            side_effect=requests.exceptions.Timeout("timed out"),
        ):
            client.trigger_webhook(
                "asset.created", {"asset_id": 1}, max_attempts=1
            )

        mock_response_bad = MagicMock()
        mock_response_bad.status_code = 500
        with patch("requests.Session.post", return_value=mock_response_bad):
            client.trigger_webhook("asset.created", {"asset_id": 1})

    for record in caplog.records:
        message = record.getMessage()
        assert API_KEY_SENTINEL not in message


def test_disabled_quando_url_ausente_retorna_erro_sem_derrubar() -> None:
    """Sem URL configurada (mas com a flag ligada), o cliente deve retornar
    um resultado de falha em vez de lançar exceção, por padrão."""
    settings = _make_settings(n8n_webhook_url=None, n8n_base_url=None)
    client = N8nClient(settings=settings)

    with patch("requests.Session.post") as mock_post:
        result = client.trigger_webhook("asset.created", {"asset_id": 1})

    mock_post.assert_not_called()
    assert result.success is False
    assert result.disabled is False
    assert result.error is not None
