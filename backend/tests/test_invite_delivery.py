"""CONVITE-LINK: entrega do e-mail de convite PELO BACKEND.

Contexto (docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md §1): o e-mail
de convite do Supabase usa `{{ .ConfirmationURL }}`, um GET de uso unico em
`/auth/v1/verify` que scanners de antivirus de e-mail abrem 2-4 s apos o
envio, gastando o token e (no fluxo implicito) recebendo access/refresh token
validos da conta -- provado nos logs do projeto em 2026-10-27 as 18:54:43. A
correcao espelha a do reset de senha, ja validada em producao:
`admin/generate_link` (type=invite, nao envia nada) + SMTP proprio, com um
link que aponta para a nossa pagina /ativar-conta e so e consumido no clique.

Cobre: formato do link, escape do token, validacao do link contra a
allow-list, mapeamento dos resultados do envio, devolucao do `auth_user_id` e
as garantias de sigilo (o token de uso unico so pode existir no corpo do
e-mail, nunca em log, retorno ou repr).
"""
from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.config.settings import Settings
from app.integrations.supabase_admin_client import (
    GeneratedInvite,
    SupabaseAdminClientError,
)
from app.services import invite_delivery as delivery
from app.services import password_reset_delivery as reset_delivery
from app.services.email.sender import EmailResult

REDIRECT = "https://app.exemplo.invalid/ativar-conta"
TOKEN = "pkce_" + "c" * 40
AUTH_USER_ID = "auth-user-do-convite"
EMAIL = "convidado@exemplo.invalid"


def _settings(**overrides) -> Settings:
    base = {
        "database_url": "postgresql+psycopg2://u:p@localhost:5432/t",
        "secret_key": "s" * 40,
        "invite_allowed_redirect_urls": REDIRECT,
        "_env_file": None,
    }
    base.update(overrides)
    return Settings(**base)


def _source(token: str = TOKEN, auth_user_id: str = AUTH_USER_ID) -> MagicMock:
    source = MagicMock()
    source.generate_invite_token_hash.return_value = GeneratedInvite(
        auth_user_id=auth_user_id, token_hash=token
    )
    return source


def _capture(monkeypatch, status: str = "sent") -> list:
    sent: list = []

    def fake_send(message, **_kwargs):
        sent.append(message)
        return EmailResult(status=status)

    monkeypatch.setattr(delivery, "send_email_safely", fake_send)
    return sent


# ---------------------------------------------------------------------------
# Montagem do link
# ---------------------------------------------------------------------------


def test_link_aponta_para_a_nossa_pagina_e_nao_para_o_verify():
    url = delivery.build_invite_url(REDIRECT, TOKEN)
    assert url == f"{REDIRECT}?token_hash={TOKEN}&type=invite"
    assert "/auth/v1/verify" not in url


def test_link_preserva_query_existente_do_redirect():
    url = delivery.build_invite_url(f"{REDIRECT}?origem=email", TOKEN)
    assert url == f"{REDIRECT}?origem=email&token_hash={TOKEN}&type=invite"


@pytest.mark.parametrize(
    "token,proibido",
    [
        ("abc&type=recovery", "&type=recovery"),
        ("abc#fragmento", "#fragmento"),
        ("abc?x=1", "?x=1"),
        ("abc next", " "),
    ],
)
def test_token_inesperado_nao_injeta_parametros_no_link(token, proibido):
    """Mesmo que o GoTrue devolva algo estranho, o token e escapado: nao pode
    acrescentar parametro nem trocar o `type` do link (um `&type=recovery`
    levaria o convidado para a tela errada)."""
    url = delivery.build_invite_url(REDIRECT, token)
    assert url.count("type=invite") == 1
    assert url.endswith("&type=invite")
    assert "type=recovery" not in url
    assert proibido not in url.split("token_hash=")[1].split("&type=")[0]


# ---------------------------------------------------------------------------
# Fluxo completo
# ---------------------------------------------------------------------------


def test_envia_e_mail_com_o_link_e_devolve_sent_e_o_auth_user_id(monkeypatch):
    sent = _capture(monkeypatch)
    source = _source()
    result = delivery.deliver_invite(
        token_source=source,
        email=EMAIL,
        recipient_name="Pessoa Convidada",
        redirect_to=REDIRECT,
        settings=_settings(),
    )
    assert result.outcome == delivery.OUTCOME_SENT
    assert result.auth_user_id == AUTH_USER_ID
    source.generate_invite_token_hash.assert_called_once_with(
        EMAIL, "Pessoa Convidada", REDIRECT
    )
    (message,) = sent
    expected = f"{REDIRECT}?token_hash={TOKEN}&type=invite"
    assert message.to == EMAIL
    assert expected in message.text_body
    # No HTML o `&` sai escapado (autoescape=True): o href continua correto.
    assert expected.replace("&", "&amp;") in message.html_body
    assert "Pessoa Convidada" in message.text_body
    # O e-mail nunca pode conter o endpoint que o scanner consome.
    assert "/auth/v1/verify" not in message.text_body


def test_retorno_nunca_carrega_o_token_nem_a_url(monkeypatch):
    """O chamador (`invite_service`) audita o resultado: nada que volte daqui
    pode conter segredo de uso unico."""
    _capture(monkeypatch)
    result = delivery.deliver_invite(
        token_source=_source(),
        email=EMAIL,
        recipient_name="Pessoa",
        redirect_to=REDIRECT,
        settings=_settings(),
    )
    serialized = f"{result!r} {result.auth_user_id} {result.outcome}"
    assert TOKEN not in serialized
    assert "token_hash" not in serialized


def test_falha_do_provedor_propaga_para_o_servico_decidir(monkeypatch):
    _capture(monkeypatch)
    source = _source()
    source.generate_invite_token_hash.side_effect = SupabaseAdminClientError("fora")
    with pytest.raises(SupabaseAdminClientError):
        delivery.deliver_invite(
            token_source=source,
            email=EMAIL,
            recipient_name="Pessoa",
            redirect_to=REDIRECT,
            settings=_settings(),
        )


@pytest.mark.parametrize(
    "status,esperado",
    [
        ("sent", delivery.OUTCOME_SENT),
        ("disabled", delivery.OUTCOME_EMAIL_DISABLED),
        ("failed", delivery.OUTCOME_EMAIL_FAILED),
    ],
)
def test_resultado_do_envio_vira_codigo_curto(monkeypatch, status, esperado):
    """EMAIL_ENABLED=false (`disabled`) NAO pode ser reportado como enviado:
    o convidado nao receberia nada e o ADM acharia que deu certo."""
    _capture(monkeypatch, status=status)
    result = delivery.deliver_invite(
        token_source=_source(),
        email=EMAIL,
        recipient_name="Pessoa",
        redirect_to=REDIRECT,
        settings=_settings(),
    )
    assert result.outcome == esperado


def test_redirect_fora_da_allowlist_nao_envia_e_mail(monkeypatch):
    """Defesa em profundidade: mesmo que o chamador passe um destino estranho
    (e o cliente da API Admin seja um dublê), o link nao entra no template e
    nenhum e-mail sai."""
    sent = _capture(monkeypatch)
    result = delivery.deliver_invite(
        token_source=_source(),
        email=EMAIL,
        recipient_name="Pessoa",
        redirect_to="https://evil.invalid/ativar-conta",
        settings=_settings(),
    )
    assert result.outcome == delivery.OUTCOME_LINK_NOT_ALLOWED
    assert sent == []


def test_token_nunca_aparece_em_log(monkeypatch, caplog):
    _capture(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        delivery.deliver_invite(
            token_source=_source(),
            email=EMAIL,
            recipient_name="Pessoa",
            redirect_to=REDIRECT,
            settings=_settings(),
        )
    assert TOKEN not in caplog.text


def test_nome_do_destinatario_e_higienizado(monkeypatch):
    """Anti header/HTML injection: o nome vem do ADM, mas passa por
    `clean_text` do template como qualquer outro campo."""
    sent = _capture(monkeypatch)
    delivery.deliver_invite(
        token_source=_source(),
        email=EMAIL,
        recipient_name="Pessoa\r\nBcc: terceiro@exemplo.invalid",
        redirect_to=REDIRECT,
        settings=_settings(),
    )
    (message,) = sent
    assert "\r" not in message.text_body and "Bcc:" not in message.subject
    assert "<" not in message.html_body.split("Ola, ")[1].split("</p>")[0]


def test_usa_as_settings_recebidas_sem_ler_o_ambiente(monkeypatch):
    """O modulo nao pode cair em `get_settings()` quando o chamador passa as
    settings (o servico injeta as suas, inclusive nos testes)."""
    _capture(monkeypatch)
    monkeypatch.setattr(
        delivery, "get_settings", lambda: SimpleNamespace(invite_allowed_redirect_urls_list=[])
    )
    result = delivery.deliver_invite(
        token_source=_source(),
        email=EMAIL,
        recipient_name="Pessoa",
        redirect_to=REDIRECT,
        settings=_settings(),
    )
    assert result.outcome == delivery.OUTCOME_SENT


def test_vocabulario_de_resultados_identico_ao_do_reset_de_senha():
    """Os dois modulos de entrega sao irmaos de proposito: os codigos vao para
    log/auditoria e nao podem divergir (um relatorio que some `email_failed`
    deixaria de enxergar metade das falhas)."""
    assert (
        delivery.OUTCOME_SENT,
        delivery.OUTCOME_EMAIL_DISABLED,
        delivery.OUTCOME_EMAIL_FAILED,
        delivery.OUTCOME_LINK_NOT_ALLOWED,
    ) == (
        reset_delivery.OUTCOME_SENT,
        reset_delivery.OUTCOME_EMAIL_DISABLED,
        reset_delivery.OUTCOME_EMAIL_FAILED,
        reset_delivery.OUTCOME_LINK_NOT_ALLOWED,
    )
