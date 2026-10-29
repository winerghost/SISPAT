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
    GeneratedInvite,
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
    # Regressão: o GoTrue lê `redirect_to` da query string, nunca do corpo.
    assert kwargs["params"] == {"redirect_to": ALLOWED_REDIRECT}
    assert "redirect_to" not in kwargs["json"]
    assert kwargs["json"]["email"] == "novo@exemplo.com"
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


# --- generate_invite_token_hash: convite sem e-mail do Supabase --------------
# CONVITE-LINK (docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md §1): o
# convite deixou de sair pelo template do painel, cujo `{{ .ConfirmationURL }}`
# (`/auth/v1/verify`, uso unico) e consumido por scanner de antivirus de
# e-mail segundos apos o envio -- gastando o token e recebendo, no fluxo
# implicito, access/refresh token validos da conta.

INVITE_TOKEN = "pkce_" + "d" * 40


def _generate_link_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "auth-user-convidado",
        "email": "novo@exemplo.com",
        "hashed_token": INVITE_TOKEN,
        # Os dois campos abaixo sao SEGREDO e precisam ser descartados.
        "action_link": "https://proj.supabase.co/auth/v1/verify?token=SEGREDO",
        "email_otp": "123456",
    }
    payload.update(overrides)
    return payload


def test_generate_invite_devolve_id_e_hashed_token_sem_enviar_e_mail() -> None:
    client = SupabaseAdminClient(settings=_make_settings())

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = _generate_link_payload()

    with patch("requests.Session.request", return_value=mock_response) as mock_request:
        result = client.generate_invite_token_hash(
            email="novo@exemplo.com", name="Novo Usuário", redirect_to=ALLOWED_REDIRECT
        )

    assert result == GeneratedInvite(
        auth_user_id="auth-user-convidado", token_hash=INVITE_TOKEN
    )
    method, url = mock_request.call_args.args
    assert method == "POST"
    assert url == "https://proj.supabase.co/auth/v1/admin/generate_link"
    kwargs = mock_request.call_args.kwargs
    assert kwargs["json"] == {
        "type": "invite",
        "email": "novo@exemplo.com",
        "data": {"name": "Novo Usuário"},
        "redirect_to": ALLOWED_REDIRECT,
    }
    # Nunca seguir redirect: o header `apikey` carrega a Service Role Key.
    assert kwargs["allow_redirects"] is False
    # O endpoint antigo (que dispara o e-mail do painel) nao e chamado.
    assert "/auth/v1/invite" not in url


def test_generate_invite_nao_expoe_o_token_no_repr() -> None:
    """Se o objeto cair num log, num `assert` ou numa excecao, o segredo de
    uso unico nao pode vazar."""
    texto = repr(GeneratedInvite(auth_user_id="auth-1", token_hash=INVITE_TOKEN))
    assert INVITE_TOKEN not in texto
    assert "auth-1" in texto


def test_generate_invite_redirect_fora_da_allow_list_nunca_chama_a_api() -> None:
    client = SupabaseAdminClient(settings=_make_settings())

    with patch("requests.Session.request") as mock_request:
        with pytest.raises(InviteRedirectNotAllowedError):
            client.generate_invite_token_hash(
                email="novo@exemplo.com",
                name="Novo Usuário",
                redirect_to="https://site-nao-autorizado.com/ativar-conta",
            )

    mock_request.assert_not_called()


@pytest.mark.parametrize(
    "email",
    ["sem-arroba", "a@b c", "", None],
)
def test_generate_invite_e_mail_malformado_nunca_chama_a_api(email: object) -> None:
    client = SupabaseAdminClient(settings=_make_settings())

    with patch("requests.Session.request") as mock_request:
        with pytest.raises(SupabaseAdminClientError):
            client.generate_invite_token_hash(
                email=email,  # type: ignore[arg-type]
                name="Novo Usuário",
                redirect_to=ALLOWED_REDIRECT,
            )

    mock_request.assert_not_called()


@pytest.mark.parametrize(
    "overrides",
    [
        {"hashed_token": None},
        {"hashed_token": ""},
        {"hashed_token": "curto"},
        {"hashed_token": "a" * 40 + " &type=x"},
        {"hashed_token": "<html>erro</html>"},
    ],
)
def test_generate_invite_recusa_hashed_token_malformado(overrides: dict) -> None:
    """Lixo (HTML de proxy, valor com separador de query) nunca pode virar o
    `token_hash` de um link enviado por e-mail."""
    client = SupabaseAdminClient(settings=_make_settings())

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = _generate_link_payload(**overrides)

    with patch("requests.Session.request", return_value=mock_response):
        with pytest.raises(SupabaseAdminClientError):
            client.generate_invite_token_hash(
                email="novo@exemplo.com", name="Novo Usuário", redirect_to=ALLOWED_REDIRECT
            )


@pytest.mark.parametrize(
    "overrides",
    [{"id": None}, {"id": ""}, {"id": "../outro-usuario"}, {"id": 123}],
)
def test_generate_invite_recusa_id_ausente_ou_malformado(overrides: dict) -> None:
    """O `id` vira `users.auth_user_id` e e reusado em `/admin/users/{id}`
    (ban, MFA): precisa ter formato de segmento de path seguro (CWE-22)."""
    client = SupabaseAdminClient(settings=_make_settings())

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = _generate_link_payload(**overrides)

    with patch("requests.Session.request", return_value=mock_response):
        with pytest.raises(SupabaseAdminClientError):
            client.generate_invite_token_hash(
                email="novo@exemplo.com", name="Novo Usuário", redirect_to=ALLOWED_REDIRECT
            )


def test_generate_invite_nunca_loga_token_action_link_nem_email_otp(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = SupabaseAdminClient(settings=_make_settings())

    ok = MagicMock()
    ok.status_code = 200
    ok.json.return_value = _generate_link_payload()

    sem_token = MagicMock()
    sem_token.status_code = 200
    sem_token.json.return_value = _generate_link_payload(hashed_token="curto")

    with caplog.at_level(logging.DEBUG, logger="app.integrations.supabase_admin_client"):
        with patch("requests.Session.request", return_value=ok):
            client.generate_invite_token_hash(
                email="novo@exemplo.com", name="Novo Usuário", redirect_to=ALLOWED_REDIRECT
            )
        with patch("requests.Session.request", return_value=sem_token):
            with pytest.raises(SupabaseAdminClientError) as exc:
                client.generate_invite_token_hash(
                    email="novo@exemplo.com",
                    name="Novo Usuário",
                    redirect_to=ALLOWED_REDIRECT,
                )

    assert "SEGREDO" not in str(exc.value) and INVITE_TOKEN not in str(exc.value)
    for record in caplog.records:
        message = record.getMessage()
        assert INVITE_TOKEN not in message
        assert "SEGREDO" not in message
        assert "123456" not in message
        assert SERVICE_ROLE_KEY_SENTINEL not in message
