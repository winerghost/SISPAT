"""SMTP mockado (zero rede): fluxo TLS, injecao de cabecalho, erros, teto, auditoria."""
from __future__ import annotations

import logging
import smtplib
import ssl
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from unittest.mock import MagicMock, patch

import pytest
import redis

from _email_helpers import FAKE_PASSWORD, make_settings
from app.services.email import dispatch
from app.services.email.address import InvalidAddressError, mask_address, parse_single_address
from app.services.email.sender import (
    EmailMessageData,
    EmailSendError,
    NullEmailSender,
    SmtpEmailSender,
    build_email_sender,
)

MSG = EmailMessageData(to="Maria@AGU.gov.br", subject="Assunto", text_body="oi", html_body="<p>oi</p>")
SMTP = "app.services.email.sender.smtplib.SMTP"
SMTP_SSL = "app.services.email.sender.smtplib.SMTP_SSL"


def _sender(**kw):
    s = SmtpEmailSender(make_settings(**kw))
    s._sleep = lambda _t: None
    return s


def test_null_quando_desligado():
    sender = build_email_sender(make_settings(email_enabled=False))
    assert isinstance(sender, NullEmailSender)
    with patch(SMTP) as smtp, patch(SMTP_SSL) as ssl_:
        r = sender.send(MSG)
    assert r.status == "disabled" and not r.ok
    smtp.assert_not_called()
    ssl_.assert_not_called()


def test_starttls_ordem_correta_e_contexto_verificado():
    with patch(SMTP) as smtp:
        client = smtp.return_value
        r = _sender().send(MSG)
    assert r.ok
    names = [c[0] for c in client.method_calls]
    assert names == ["ehlo", "starttls", "ehlo", "login", "send_message", "quit", "close"]
    ctx = client.starttls.call_args.kwargs["context"]
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True
    assert smtp.call_args.kwargs["timeout"] == 10
    client.login.assert_called_once_with("robo@example.test", FAKE_PASSWORD)
    sent = client.send_message.call_args
    assert sent.kwargs["to_addrs"] == ["Maria@agu.gov.br"]
    assert sent.kwargs["from_addr"] == "robo@example.test"
    m = sent.args[0]
    assert m["From"] == "robo@example.test" and m.is_multipart()


def test_ssl_465_sem_starttls():
    with patch(SMTP_SSL) as ssl_, patch(SMTP) as plain:
        client = ssl_.return_value
        r = _sender(email_port=465, email_security="ssl").send(MSG)
    assert r.ok
    plain.assert_not_called()
    assert [c[0] for c in client.method_calls] == ["ehlo", "login", "send_message", "quit", "close"]
    ctx = ssl_.call_args.kwargs["context"]
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname


def test_login_nunca_antes_do_starttls():
    with patch(SMTP) as smtp:
        client = smtp.return_value
        client.starttls.side_effect = smtplib.SMTPNotSupportedError("x")
        with pytest.raises(EmailSendError) as ei:
            _sender().send(MSG)
    client.login.assert_not_called()
    client.close.assert_called()
    assert ei.value.code == "tls_not_supported"


@pytest.mark.parametrize("campo,valor", [
    ("to", "a@agu.gov.br\r\nBcc: x@y.com"), ("to", "a@agu.gov.br\nX: y"), ("to", "a@agu.gov.br\x00"),
    ("to", "a@agu.gov.br,b@agu.gov.br"), ("to", "a@agu.gov.br;b@agu.gov.br"),
    ("to", "A <a@agu.gov.br>"), ("to", "a@agu.gov.br b@agu.gov.br"), ("to", ""),
    ("subject", "x\r\nBcc: evil@y.com"), ("subject", "x\ny"), ("subject", "x\x00"),
    ("subject", "a" * 151), ("subject", ""), ("reply_to", "a@b.com\r\nX: y"),
])
def test_injecao_de_cabecalho_e_multiplos_destinatarios_rejeitados(campo, valor):
    data = EmailMessageData(**{**MSG.__dict__, campo: valor})
    with patch(SMTP) as smtp:
        with pytest.raises(EmailSendError):
            _sender().send(data)
    smtp.assert_not_called()


def test_from_vem_das_settings_nao_do_chamador():
    with pytest.raises(TypeError):
        EmailMessageData(to="a@b.co", subject="s", text_body="t", **{"from_addr": "evil@x.co"})


def test_from_name_com_crlf_rejeitado_no_envio():
    s = _sender()
    s._s.email_from_name = "X\r\nBcc: a@b.co"
    with pytest.raises(EmailSendError):
        s.build_message(MSG)


def test_allowlist_de_dominio():
    s = _sender(email_allowed_recipient_domains="agu.gov.br")
    with patch(SMTP):
        assert s.send(MSG).ok
        with pytest.raises(EmailSendError) as ei:
            s.send(EmailMessageData("x@gmail.com", "s", "t"))
        assert ei.value.code == "recipient_domain_not_allowed"
        with pytest.raises(EmailSendError):  # subdominio nao herda
            s.send(EmailMessageData("x@sub.agu.gov.br", "s", "t"))


def test_erro_smtp_vira_email_send_error_sem_credenciais(caplog):
    caplog.set_level(logging.DEBUG)
    with patch(SMTP) as smtp:
        smtp.return_value.login.side_effect = smtplib.SMTPAuthenticationError(
            535, f"bad creds robo@example.test {FAKE_PASSWORD} smtp.example.test".encode()
        )
        with pytest.raises(EmailSendError) as ei:
            _sender().send(MSG)
    e = ei.value
    assert e.code == "smtp_auth" and e.__cause__ is None and e.__suppress_context__
    for secret in (FAKE_PASSWORD, "robo@example.test", "smtp.example.test"):
        assert secret not in str(e) and secret not in repr(e) and secret not in caplog.text
    assert smtp.call_count == 1  # autenticacao nao tem retry


def test_certificado_invalido_sem_retry():
    with patch(SMTP) as smtp:
        smtp.return_value.starttls.side_effect = ssl.SSLCertVerificationError("hostname mismatch")
        with pytest.raises(EmailSendError) as ei:
            _sender().send(MSG)
    assert ei.value.code == "tls_certificate" and smtp.call_count == 1


def test_um_retry_em_erro_transitorio_e_sucesso():
    with patch(SMTP) as smtp:
        smtp.return_value.send_message.side_effect = [smtplib.SMTPServerDisconnected("x"), {}]
        assert _sender().send(MSG).ok
    assert smtp.call_count == 2


def test_no_maximo_um_retry():
    with patch(SMTP) as smtp:
        smtp.side_effect = TimeoutError("t")
        with pytest.raises(EmailSendError) as ei:
            _sender().send(MSG)
    assert smtp.call_count == 2 and ei.value.code == "timeout"


def test_endereco_estrito_e_mascara():
    assert parse_single_address("Ana.B@AGU.gov.br") == "Ana.B@agu.gov.br"
    with pytest.raises(InvalidAddressError):
        parse_single_address("a@@b.co")
    assert mask_address("maria@agu.gov.br") == "m***@agu.gov.br"
    assert mask_address("x\r\ny") == "***"


# --- send_email_safely -------------------------------------------------------
class _SyncExecutor:
    def submit(self, fn, *a, **k):
        f = Future()
        try:
            f.set_result(fn(*a, **k))
        except BaseException as exc:  # noqa: BLE001
            f.set_exception(exc)
        return f


@pytest.fixture
def safe(monkeypatch):
    monkeypatch.setattr(dispatch, "_get_executor", lambda: _SyncExecutor())
    events = []
    monkeypatch.setattr(dispatch, "record_security_event", lambda t, **kw: events.append((t, kw)))
    return events


def _redis(count=1):
    r = MagicMock()
    r.incr.return_value = count
    return r


def test_send_safely_desligado_nao_audita_nem_usa_redis(safe):
    r = _redis()
    res = dispatch.send_email_safely(MSG, settings=make_settings(email_enabled=False), redis_client=r)
    assert res.status == "disabled" and safe == []
    r.incr.assert_not_called()


def test_send_safely_sucesso_audita_mascarado_sem_corpo(safe):
    with patch(SMTP):
        res = dispatch.send_email_safely(
            MSG, purpose="convite", settings=make_settings(), redis_client=_redis()
        )
    assert res.ok
    ((tipo, kw),) = safe
    assert tipo == "EMAIL_SENT" and kw["details"]["recipient"] == "M***@AGU.gov.br"
    blob = repr(kw)
    assert "Maria@AGU" not in blob and "<p>oi</p>" not in blob and FAKE_PASSWORD not in blob


def test_send_safely_nunca_levanta_e_audita_falha(safe):
    with patch(SMTP) as smtp:
        smtp.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"x")
        res = dispatch.send_email_safely(MSG, settings=make_settings(), redis_client=_redis())
    assert res.status == "failed" and res.error_code == "smtp_auth"
    assert safe[0][0] == "EMAIL_FAILED" and safe[0][1]["result"] == "FALHA"


def test_send_safely_captura_erro_inesperado(safe, monkeypatch):
    def boom(_s):
        raise RuntimeError("boom")

    monkeypatch.setattr(dispatch, "build_email_sender", boom)
    res = dispatch.send_email_safely(MSG, settings=make_settings(), redis_client=_redis())
    assert res.status == "failed" and res.error_code == "unexpected_error"


def test_send_safely_dados_invalidos_nao_levantam(safe):
    bad = EmailMessageData(to="a@b.co\r\nBcc: x@y.co", subject="s", text_body="t")
    res = dispatch.send_email_safely(bad, settings=make_settings(), redis_client=_redis())
    assert res.status == "failed" and res.error_code == "invalid_recipient"
    assert "Bcc" not in repr(safe)


def test_teto_por_hora(safe):
    s = make_settings(email_max_per_hour=2)
    with patch(SMTP) as smtp:
        assert dispatch.send_email_safely(MSG, settings=s, redis_client=_redis(2)).ok
        res = dispatch.send_email_safely(MSG, settings=s, redis_client=_redis(3))
    assert res.error_code == "hourly_cap_exceeded" and smtp.call_count == 1


def test_redis_indisponivel_fail_closed(safe):
    r = MagicMock()
    r.incr.side_effect = redis.exceptions.ConnectionError("down")
    with patch(SMTP) as smtp:
        res = dispatch.send_email_safely(MSG, settings=make_settings(), redis_client=r)
    assert res.error_code == "rate_limit_unavailable"
    smtp.assert_not_called()


def test_prazo_estourado_vira_falha(safe, monkeypatch):
    class _Hang:
        def submit(self, *a, **k):
            f = MagicMock()
            f.result.side_effect = FutureTimeout()
            return f

    monkeypatch.setattr(dispatch, "_get_executor", lambda: _Hang())
    res = dispatch.send_email_safely(MSG, settings=make_settings(), redis_client=_redis())
    assert res.error_code == "timeout"
