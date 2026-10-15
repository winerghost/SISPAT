"""Remetentes de e-mail: SmtpEmailSender (TLS verificado) e NullEmailSender.

Garantias:
    - STARTTLS (587) ou SSL (465) com `ssl.create_default_context()` (cadeia
      de certificados E hostname verificados); login SO apos TLS; timeout em
      toda operacao; conexao sempre encerrada (finally).
    - Anti header-injection: CR/LF/NUL/controles recusados em destinatario,
      assunto, reply-to e nome do remetente; destinatario e UM unico endereco
      simples; o From vem SEMPRE das settings, nunca do chamador.
    - No maximo 1 retry curto, so em erro transitorio (queda de conexao/4xx);
      nunca em autenticacao ou falha de certificado.
    - Erros viram `EmailSendError` com `code` generico: sem usuario, senha,
      host nem a excecao original (`raise ... from None`).
"""
from __future__ import annotations

import logging
import smtplib
import socket
import ssl
import time
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Protocol

from app.config.settings import Settings, get_settings
from app.services.email.address import (
    InvalidAddressError,
    address_domain,
    has_control_chars,
    parse_single_address,
)

logger = logging.getLogger(__name__)

MAX_SUBJECT_LENGTH = 150
MAX_BODY_LENGTH = 50_000
RETRY_DELAY_SECONDS = 1.0

STATUS_SENT = "sent"
STATUS_DISABLED = "disabled"
STATUS_FAILED = "failed"


class EmailSendError(Exception):
    """Falha de envio/validacao. `code` e um identificador generico."""

    def __init__(self, code: str) -> None:
        super().__init__(f"Falha no envio de e-mail ({code}).")
        self.code = code


@dataclass(frozen=True)
class EmailMessageData:
    to: str
    subject: str
    text_body: str
    html_body: str | None = None
    reply_to: str | None = None


@dataclass(frozen=True)
class EmailResult:
    status: str  # "sent" | "disabled" | "failed"
    error_code: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == STATUS_SENT


class EmailSender(Protocol):
    def send(self, message: EmailMessageData) -> EmailResult: ...


class NullEmailSender:
    """Usado com EMAIL_ENABLED=false: nao envia, nao falha, nao abre rede."""

    def send(self, message: EmailMessageData) -> EmailResult:
        return EmailResult(status=STATUS_DISABLED)


def _safe_header(value: object, *, name: str, max_len: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EmailSendError(f"invalid_{name}")
    if len(value) > max_len or has_control_chars(value):
        raise EmailSendError(f"invalid_{name}")
    return value


def _address(value: object, name: str) -> str:
    try:
        return parse_single_address(value)
    except InvalidAddressError:
        raise EmailSendError(f"invalid_{name}") from None


class SmtpEmailSender:
    def __init__(self, settings: Settings | None = None) -> None:
        self._s = settings or get_settings()
        self._sleep = time.sleep  # patchavel nos testes

    # -- construcao da mensagem (sem rede) --------------------------------
    def build_message(self, data: EmailMessageData) -> tuple[EmailMessage, str, str]:
        s = self._s
        to = _address(data.to, "recipient")
        allowed = s.email_allowed_recipient_domains_list
        if allowed and address_domain(to) not in allowed:
            raise EmailSendError("recipient_domain_not_allowed")
        subject = _safe_header(data.subject, name="subject", max_len=MAX_SUBJECT_LENGTH)
        sender_addr = _address(s.email_from, "sender")
        for body in (data.text_body, data.html_body):
            if body is None:
                continue
            if not isinstance(body, str) or len(body) > MAX_BODY_LENGTH or "\x00" in body:
                raise EmailSendError("invalid_body")
        name = ""
        if s.email_from_name:
            name = _safe_header(s.email_from_name, name="sender", max_len=100)
        msg = EmailMessage()
        msg["From"] = formataddr((name, sender_addr), charset="utf-8") if name else sender_addr
        msg["To"] = to
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=False)
        msg["Message-ID"] = make_msgid(domain=address_domain(sender_addr))
        msg["Auto-Submitted"] = "auto-generated"
        if data.reply_to:
            msg["Reply-To"] = _address(data.reply_to, "reply_to")
        msg.set_content(data.text_body)
        if data.html_body:
            msg.add_alternative(data.html_body, subtype="html")
        return msg, sender_addr, to

    # -- entrega -----------------------------------------------------------
    def send(self, message: EmailMessageData) -> EmailResult:
        msg, sender_addr, to = self.build_message(message)
        for attempt in (1, 2):
            try:
                self._deliver(msg, sender_addr, to)
                return EmailResult(status=STATUS_SENT)
            except Exception as exc:  # noqa: BLE001
                code, transient = self._classify(exc)
                logger.warning("email: falha SMTP (%s, codigo=%s).", type(exc).__name__, code)
                if transient and attempt == 1:
                    self._sleep(RETRY_DELAY_SECONDS)
                    continue
                raise EmailSendError(code) from None
        raise EmailSendError("smtp_error")  # pragma: no cover

    @staticmethod
    def _classify(exc: Exception) -> tuple[str, bool]:
        """(codigo generico, transitorio?). Ordem importa (subclasses primeiro)."""
        if isinstance(exc, ssl.SSLCertVerificationError):
            return "tls_certificate", False
        if isinstance(exc, ssl.SSLError):
            return "tls_error", False
        if isinstance(exc, smtplib.SMTPAuthenticationError):
            return "smtp_auth", False
        if isinstance(exc, smtplib.SMTPRecipientsRefused):
            return "recipient_refused", False
        if isinstance(exc, smtplib.SMTPNotSupportedError):
            return "tls_not_supported", False
        if isinstance(exc, (socket.timeout, TimeoutError)):
            return "timeout", True
        if isinstance(exc, (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError)):
            return "connection", True
        if isinstance(exc, smtplib.SMTPResponseException):
            transient = 400 <= exc.smtp_code < 500
            return ("smtp_transient" if transient else "smtp_error"), transient
        if isinstance(exc, OSError):
            return "connection", True
        return "smtp_error", False

    def _deliver(self, msg: EmailMessage, sender_addr: str, to: str) -> None:
        s = self._s
        ctx = ssl.create_default_context()  # verifica certificado e hostname
        timeout = s.email_timeout_seconds
        use_ssl = s.email_security == "ssl"
        if use_ssl:
            client = smtplib.SMTP_SSL(s.email_host, s.email_port, timeout=timeout, context=ctx)
        else:
            client = smtplib.SMTP(s.email_host, s.email_port, timeout=timeout)
        try:
            client.ehlo()
            if not use_ssl:
                client.starttls(context=ctx)  # obrigatorio antes de qualquer credencial
                client.ehlo()
            client.login(s.email_user, s.email_password.get_secret_value())
            client.send_message(msg, from_addr=sender_addr, to_addrs=[to])
            try:
                client.quit()
            except Exception:  # noqa: BLE001 - a entrega ja ocorreu
                pass
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass


def build_email_sender(settings: Settings | None = None) -> EmailSender:
    """SmtpEmailSender se EMAIL_ENABLED=true; senao NullEmailSender."""
    s = settings or get_settings()
    return SmtpEmailSender(s) if s.email_enabled else NullEmailSender()
