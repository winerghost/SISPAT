"""Testes do cliente da API Admin do Supabase Auth
(`app.integrations.supabase_admin_client`).

Nenhuma chamada de rede real é feita: `requests.Session.request` é sempre
mockado via `unittest.mock.patch`. Mesmo espírito de `test_n8n_client.py`.
"""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
import requests

from app.config.settings import Settings
from app.integrations.supabase_admin_client import (
    InviteRedirectNotAllowedError,
    SupabaseAdminClient,
    SupabaseAdminClientError,
)

SERVICE_ROLE_KEY_SENTINEL = "service-role-key-super-secreta-nao-deve-aparecer-no-log-98765"
ALLOWED_REDIRECT = "https://app.exemplo.com/convite/aceitar"


def _make_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "database_url": "postgresql+psycopg2://user:pass@localhost:5432/test",
        "secret_key": "test-secret-key",
        "supabase_url": "https://proj.supabase.co",
        "supabase_service_role_key": SERVICE_ROLE_KEY_SENTINEL,
        "invite_allowed_redirect_urls": ALLOWED_REDIRECT,
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


# --- invite_user_by_email: allow-list de redirect_to -------------------------


def test_invite_redirect_to_fora_da_allow_list_nunca_chama_a_api() -> None:
    settings = _make_settings()
    client = SupabaseAdminClient(settings=settings)

    with patch("requests.Session.request") as mock_request:
        with pytest.raises(InviteRedirectNotAllowedError):
            client.invite_user_by_email(
                email="novo@exemplo.com",
                name="Novo Usuário",
                redirect_to="https://site-nao-autorizado.com/qualquer",
            )

    mock_request.assert_not_called()


def test_invite_redirect_to_na_allow_list_chama_a_api_com_sucesso() -> None:
    settings = _make_settings()
    client = SupabaseAdminClient(settings=settings)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"id": "auth-user-123", "email": "novo@exemplo.com"}

    with patch("requests.Session.request", return_value=mock_response) as mock_request:
        result = client.invite_user_by_email(
            email="novo@exemplo.com", name="Novo Usuário", redirect_to=ALLOWED_REDIRECT
        )

    mock_request.assert_called_once()
    assert result["id"] == "auth-user-123"
    _, kwargs = mock_request.call_args
    assert kwargs["json"]["redirect_to"] == ALLOWED_REDIRECT
    assert kwargs["json"]["data"]["name"] == "Novo Usuário"


# --- service role key nunca aparece em log -----------------------------------


def test_service_role_key_nunca_aparece_em_mensagens_de_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    settings = _make_settings()
    client = SupabaseAdminClient(settings=settings)

    mock_response_ok = MagicMock()
    mock_response_ok.status_code = 200
    mock_response_ok.json.return_value = {"id": "auth-user-123"}

    mock_response_error = MagicMock()
    mock_response_error.status_code = 500

    with caplog.at_level(logging.DEBUG, logger="app.integrations.supabase_admin_client"):
        with patch("requests.Session.request", return_value=mock_response_ok):
            client.invite_user_by_email(
                email="novo@exemplo.com", name="Novo Usuário", redirect_to=ALLOWED_REDIRECT
            )

        with patch("requests.Session.request", return_value=mock_response_error):
            with pytest.raises(SupabaseAdminClientError):
                client.list_mfa_factors("auth-user-123")

        with patch(
            "requests.Session.request",
            side_effect=requests.exceptions.ConnectionError("boom"),
        ):
            with pytest.raises(SupabaseAdminClientError):
                client.delete_mfa_factor("auth-user-123", "factor-1")

    for record in caplog.records:
        message = record.getMessage()
        assert SERVICE_ROLE_KEY_SENTINEL not in message


# --- conversão de erro HTTP/rede em SupabaseAdminClientError -----------------


def test_erro_http_e_convertido_em_supabase_admin_client_error() -> None:
    settings = _make_settings()
    client = SupabaseAdminClient(settings=settings)

    mock_response = MagicMock()
    mock_response.status_code = 404

    with patch("requests.Session.request", return_value=mock_response):
        with pytest.raises(SupabaseAdminClientError):
            client.list_mfa_factors("auth-user-inexistente")


def test_erro_de_rede_e_convertido_em_supabase_admin_client_error() -> None:
    settings = _make_settings()
    client = SupabaseAdminClient(settings=settings)

    with patch(
        "requests.Session.request", side_effect=requests.exceptions.Timeout("timed out")
    ):
        with pytest.raises(SupabaseAdminClientError):
            client.deactivate_user("auth-user-123")


def test_list_mfa_factors_retorna_lista_vazia_quando_campo_ausente() -> None:
    settings = _make_settings()
    client = SupabaseAdminClient(settings=settings)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"id": "auth-user-123"}  # sem campo "factors"

    with patch("requests.Session.request", return_value=mock_response):
        factors = client.list_mfa_factors("auth-user-123")

    assert factors == []


def test_sem_service_role_key_configurada_levanta_erro_sem_chamar_rede() -> None:
    settings = _make_settings(supabase_service_role_key=None)
    client = SupabaseAdminClient(settings=settings)

    with patch("requests.Session.request") as mock_request:
        with pytest.raises(SupabaseAdminClientError):
            client.deactivate_user("auth-user-123")

    mock_request.assert_not_called()
