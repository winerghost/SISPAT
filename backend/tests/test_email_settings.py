"""Settings de e-mail: desligado por padrao, validacao estrita, segredo protegido."""
from __future__ import annotations

import logging

import pytest
from pydantic import ValidationError

from _email_helpers import FAKE_PASSWORD, make_settings
from app.config.settings import Settings


def test_desligado_por_padrao_sem_exigir_nada():
    s = Settings(_env_file=None, database_url="postgresql://u:p@h/d", secret_key="k" * 40)
    assert s.email_enabled is False
    assert s.email_port == 587 and s.email_security == "starttls"
    assert s.email_timeout_seconds == 10 and s.email_max_per_hour == 30


def test_desligado_aceita_valores_do_ambiente_atual_sem_validar():
    s = make_settings(email_enabled=False, email_port=25, email_from="Nome <a@b>", email_password="")
    assert s.email_password is None


def test_valida_habilitado():
    s = make_settings()
    assert s.email_enabled and s.email_from == "robo@example.test"


@pytest.mark.parametrize("campo", ["email_host", "email_user", "email_password", "email_from"])
def test_habilitado_exige_campos(campo):
    with pytest.raises(ValidationError):
        make_settings(**{campo: ""})


@pytest.mark.parametrize("porta", [25, 2525, 80, 143])
def test_porta_fora_de_465_587_recusada(porta):
    with pytest.raises(ValidationError):
        make_settings(email_port=porta)


def test_porta_465_exige_ssl_e_587_exige_starttls():
    assert make_settings(email_port=465, email_security="ssl").email_security == "ssl"
    with pytest.raises(ValidationError):
        make_settings(email_port=465, email_security="starttls")
    with pytest.raises(ValidationError):
        make_settings(email_port=587, email_security="ssl")


@pytest.mark.parametrize("modo", ["none", "plain", "", "tls1"])
def test_sem_tls_recusado_inclusive_em_producao(modo):
    with pytest.raises(ValidationError):
        make_settings(email_security=modo, flask_env="production")


def test_producao_com_tls_ok():
    assert make_settings(flask_env="production").is_production


@pytest.mark.parametrize(
    "valor",
    ["a@b.com\r\nBcc: x@y.com", "a@b.com\n", "a@b.com,c@d.com", "A <a@b.com>", "semarroba", "a@b", ""],
)
def test_from_invalido_recusado(valor):
    with pytest.raises(ValidationError):
        make_settings(email_from=valor)


def test_senha_com_espacos_do_gmail_e_normalizada():
    s = make_settings(email_password="abcd wxyz abcd wxyz")
    assert s.email_password.get_secret_value() == FAKE_PASSWORD


def test_senha_nunca_em_repr_dump_ou_log(caplog):
    s = make_settings()
    caplog.set_level(logging.DEBUG)
    logging.getLogger("x").info("settings=%r %s", s, s.model_dump())
    assert FAKE_PASSWORD not in repr(s) and FAKE_PASSWORD not in str(s)
    assert FAKE_PASSWORD not in str(s.model_dump())
    assert FAKE_PASSWORD not in s.model_dump_json()
    assert FAKE_PASSWORD not in caplog.text
    assert FAKE_PASSWORD not in repr(s.email_password)


@pytest.mark.parametrize("campo,valor", [("email_timeout_seconds", 0), ("email_timeout_seconds", 61),
                                         ("email_max_per_hour", 0)])
def test_faixas(campo, valor):
    with pytest.raises(ValidationError):
        make_settings(**{campo: valor})


def test_lista_de_dominios():
    s = make_settings(email_allowed_recipient_domains="AGU.gov.br, outro.gov.br")
    assert s.email_allowed_recipient_domains_list == ["agu.gov.br", "outro.gov.br"]
    with pytest.raises(ValidationError):
        make_settings(email_allowed_recipient_domains="bad domain")


def test_ler_do_ambiente(monkeypatch):
    monkeypatch.setenv("EMAIL_ENABLED", "true")
    monkeypatch.setenv("EMAIL_HOST", "smtp.example.test")
    monkeypatch.setenv("EMAIL_USER", "u@example.test")
    monkeypatch.setenv("EMAIL_PASSWORD", "abcd efgh ijkl mnop")
    monkeypatch.setenv("EMAIL_FROM", "u@example.test")
    s = Settings(_env_file=None)
    assert s.email_enabled and s.email_password.get_secret_value() == "abcdefghijklmnop"
