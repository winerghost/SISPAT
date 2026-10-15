"""Clientes HTTP da Etapa 2: Supabase Storage (fotos) e novos métodos da API
Admin (ban/unban, recuperação de senha, reset de MFA).

`requests.Session.request` sempre mockado — nenhuma chamada de rede real.
Verifica HTTPS obrigatório, timeout, `allow_redirects=False`, allowlist de
nomes/ids antes da rede, validação de resposta e ausência de segredos em log.
"""
from __future__ import annotations

import logging
import uuid
from unittest.mock import MagicMock, patch

import pytest
import requests

from app.config.settings import Settings
from app.integrations.supabase_admin_client import (
    InviteRedirectNotAllowedError,
    SupabaseAdminClient,
    SupabaseAdminClientError,
)
from app.integrations.supabase_storage_client import (
    StorageUnavailableError,
    SupabaseStorageClient,
    is_valid_object_key,
)

KEY_SENTINEL = "service-role-key-sentinela-nao-pode-vazar-123456"
REDIRECT = "https://app.exemplo.invalid/ativar-conta"


def _settings(**overrides) -> Settings:
    base = {
        "database_url": "postgresql+psycopg2://u:p@localhost:5432/t",
        "secret_key": "s" * 40,
        "supabase_url": "https://proj.supabase.co",
        "supabase_service_role_key": KEY_SENTINEL,
        "invite_allowed_redirect_urls": REDIRECT,
    }
    base.update(overrides)
    return Settings(**base)


def _response(status=200, payload=None):
    response = MagicMock()
    response.status_code = status
    response.json.return_value = payload if payload is not None else {}
    return response


KEY = f"{uuid.uuid4()}.webp"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def test_upload_usa_https_sem_redirect_e_sem_sobrescrever():
    with patch("requests.Session.request", return_value=_response()) as req:
        SupabaseStorageClient(settings=_settings()).upload(KEY, b"RIFF....WEBP")
    method, url = req.call_args.args
    kwargs = req.call_args.kwargs
    assert method == "POST" and url == f"https://proj.supabase.co/storage/v1/object/avatars/{KEY}"
    assert kwargs["allow_redirects"] is False and kwargs["timeout"] == 10.0
    assert kwargs["headers"]["x-upsert"] == "false"
    assert kwargs["headers"]["Content-Type"] == "image/webp"


@pytest.mark.parametrize(
    "key",
    ["../x.webp", "x.webp", f"{uuid.uuid4()}.png", str(uuid.uuid4()).upper() + ".webp",
     f"{uuid.uuid4()}.webp?x=1", f"a/{uuid.uuid4()}.webp", "", None],
)
def test_nome_de_objeto_fora_da_allowlist_nao_chega_a_rede(key):
    assert not is_valid_object_key(key)
    client = SupabaseStorageClient(settings=_settings())
    with patch("requests.Session.request") as req:
        for call in (lambda: client.upload(key, b"x"), lambda: client.delete(key),
                     lambda: client.create_signed_url(key)):
            with pytest.raises(StorageUnavailableError):
                call()
    req.assert_not_called()


@pytest.mark.parametrize(
    "overrides",
    [
        {"supabase_url": "http://proj.supabase.co"},
        {"supabase_url": "https://user:pw@proj.supabase.co"},
        {"supabase_url": None},
        {"supabase_service_role_key": None},
        {"supabase_url": "http://localhost:54321", "flask_env": "production", "secret_key": "s" * 40,
         "supabase_jwt_secret": "j" * 40},
    ],
)
def test_configuracao_insegura_ou_ausente_falha_fechado(overrides):
    with patch("requests.Session.request") as req, pytest.raises(StorageUnavailableError):
        SupabaseStorageClient(settings=_settings(**overrides)).delete(KEY)
    req.assert_not_called()


@pytest.mark.parametrize("status", [301, 302, 400, 401, 404, 500, 503])
def test_status_de_erro_ou_redirect_vira_indisponivel(status, caplog):
    with patch("requests.Session.request", return_value=_response(status)), caplog.at_level(logging.DEBUG):
        with pytest.raises(StorageUnavailableError):
            SupabaseStorageClient(settings=_settings()).upload(KEY, b"x")
    assert KEY_SENTINEL not in caplog.text


def test_falha_de_rede_vira_indisponivel_sem_vazar_chave(caplog):
    with patch("requests.Session.request", side_effect=requests.exceptions.ConnectTimeout("t")), \
            caplog.at_level(logging.DEBUG), pytest.raises(StorageUnavailableError) as exc:
        SupabaseStorageClient(settings=_settings()).delete(KEY)
    assert KEY_SENTINEL not in caplog.text and KEY_SENTINEL not in str(exc.value)


def test_url_assinada_curta_e_validada():
    signed = f"/object/sign/avatars/{KEY}?token=aaa.bbb_ccc-ddd"
    with patch("requests.Session.request", return_value=_response(payload={"signedURL": signed})) as req:
        url = SupabaseStorageClient(settings=_settings()).create_signed_url(KEY)
    assert url == f"https://proj.supabase.co/storage/v1{signed}"
    assert req.call_args.kwargs["json"] == {"expiresIn": 300}


@pytest.mark.parametrize(
    "payload",
    [
        {"signedURL": "https://evil.invalid/x"},
        {"signedURL": f"/object/sign/avatars/{uuid.uuid4()}.webp?token=abc"},  # outro objeto
        {"signedURL": f"/object/sign/outro/{KEY}?token=abc"},
        {"signedURL": f"/object/sign/avatars/{KEY}?token=a b"},
        {"url": "x"},
        ["lista"],
    ],
)
def test_url_assinada_inesperada_rejeitada(payload):
    with patch("requests.Session.request", return_value=_response(payload=payload)):
        with pytest.raises(StorageUnavailableError):
            SupabaseStorageClient(settings=_settings()).create_signed_url(KEY)


def test_validade_da_url_assinada_limitada_a_300s():
    with patch("requests.Session.request") as req, pytest.raises(StorageUnavailableError):
        SupabaseStorageClient(settings=_settings()).create_signed_url(KEY, expires_in=3600)
    req.assert_not_called()


# ---------------------------------------------------------------------------
# API Admin: ban/unban, recuperação de senha, reset de MFA
# ---------------------------------------------------------------------------


def test_ban_e_unban():
    with patch("requests.Session.request", return_value=_response()) as req:
        client = SupabaseAdminClient(settings=_settings())
        client.ban_user("auth-1")
        client.unban_user("auth-1")
    bodies = [c.kwargs["json"] for c in req.call_args_list]
    assert bodies == [{"ban_duration": "876000h"}, {"ban_duration": "none"}]
    assert all(c.kwargs["allow_redirects"] is False for c in req.call_args_list)


def test_unban_com_id_invalido_nao_chama_rede():
    with patch("requests.Session.request") as req, pytest.raises(SupabaseAdminClientError):
        SupabaseAdminClient(settings=_settings()).unban_user("../x")
    req.assert_not_called()


def test_recuperacao_de_senha_usa_recover_com_redirect_da_allowlist():
    with patch("requests.Session.request", return_value=_response(payload={"action_link": "x"})) as req:
        result = SupabaseAdminClient(settings=_settings()).send_password_recovery("p@exemplo.invalid", REDIRECT)
    assert result is None  # nada da resposta (link) é devolvido ao chamador
    method, url = req.call_args.args
    assert method == "POST" and url == "https://proj.supabase.co/auth/v1/recover"
    assert req.call_args.kwargs["params"] == {"redirect_to": REDIRECT}
    assert req.call_args.kwargs["json"] == {"email": "p@exemplo.invalid"}


@pytest.mark.parametrize(
    "email,redirect",
    [("p@exemplo.invalid", "https://evil.invalid/"), ("sem-arroba", REDIRECT), ("a@b c", REDIRECT), (None, REDIRECT)],
)
def test_recuperacao_de_senha_invalida_nao_chama_rede(email, redirect):
    with patch("requests.Session.request") as req, pytest.raises(SupabaseAdminClientError) as exc:
        SupabaseAdminClient(settings=_settings()).send_password_recovery(email, redirect)
    req.assert_not_called()
    if redirect != REDIRECT:
        assert isinstance(exc.value, InviteRedirectNotAllowedError)


def test_reset_de_mfa_remove_todos_os_fatores_validos():
    responses = [_response(payload={"factors": [{"id": "f-1"}, {"id": "f-2"}]}), _response(), _response()]
    with patch("requests.Session.request", side_effect=responses):
        assert SupabaseAdminClient(settings=_settings()).delete_all_mfa_factors("auth-1") == 2


def test_reset_de_mfa_com_id_invalido_conta_como_falha_sem_logar_o_id(caplog):
    """UA-MFA-01: id fora do padrão não é ignorado em silêncio."""
    from app.integrations.supabase_admin_client import MfaResetIncompleteError

    factors = {"factors": [{"id": "f-1"}, {"id": "f-2"}, {"id": "../segredo"}, {"id": None}]}
    responses = [_response(payload=factors), _response(), _response()]
    with patch("requests.Session.request", side_effect=responses) as req, caplog.at_level(logging.WARNING):
        with pytest.raises(MfaResetIncompleteError) as exc:
            SupabaseAdminClient(settings=_settings()).delete_all_mfa_factors("auth-1")
    assert exc.value.removed == 2
    assert "../segredo" not in caplog.text and "id em formato inválido" in caplog.text
    deleted = [c.args[1] for c in req.call_args_list if c.args[0] == "DELETE"]
    assert deleted == [
        "https://proj.supabase.co/auth/v1/admin/users/auth-1/factors/f-1",
        "https://proj.supabase.co/auth/v1/admin/users/auth-1/factors/f-2",
    ]


def test_reset_de_mfa_propaga_falha_com_quantidade_parcial():
    from app.integrations.supabase_admin_client import MfaResetIncompleteError

    responses = [_response(payload={"factors": [{"id": "f-1"}, {"id": "f-2"}]}), _response(), _response(500)]
    with patch("requests.Session.request", side_effect=responses), pytest.raises(MfaResetIncompleteError) as exc:
        SupabaseAdminClient(settings=_settings()).delete_all_mfa_factors("auth-1")
    assert exc.value.removed == 1 and isinstance(exc.value, SupabaseAdminClientError)
