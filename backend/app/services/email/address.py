"""Validacao estrita de enderecos de e-mail e mascara para logs/auditoria.

Aceita APENAS um endereco simples `local@dominio` (sem display-name, sem
comentarios, sem listas). Recusa CR/LF/NUL e demais controles, espacos,
virgulas, ponto e virgula, aspas e colchetes angulares: a base da defesa
contra header injection e contra multiplos destinatarios.
"""
from __future__ import annotations

import re

MAX_ADDRESS_LENGTH = 254

_LOCAL_RE = re.compile(r"^[A-Za-z0-9_%+\-]+(?:\.[A-Za-z0-9_%+\-]+)*$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?$")
_HOST_LABEL_RE = _LABEL_RE


class InvalidAddressError(ValueError):
    """Endereco invalido. A mensagem nunca inclui o valor recebido."""


def has_control_chars(value: str) -> bool:
    """True se houver CR, LF, NUL ou qualquer caractere de controle."""
    return any(ord(c) < 32 or ord(c) == 127 for c in value)


def parse_single_address(value: object) -> str:
    """Retorna o endereco normalizado (dominio em minusculas) ou levanta."""
    if not isinstance(value, str):
        raise InvalidAddressError("Endereco de e-mail invalido.")
    if not value or len(value) > MAX_ADDRESS_LENGTH or has_control_chars(value):
        raise InvalidAddressError("Endereco de e-mail invalido.")
    if value != value.strip() or value.count("@") != 1 or not value.isascii():
        raise InvalidAddressError("Endereco de e-mail invalido.")
    local, domain = value.split("@")
    if not local or len(local) > 64 or not _LOCAL_RE.match(local):
        raise InvalidAddressError("Endereco de e-mail invalido.")
    labels = domain.split(".")
    if len(labels) < 2 or not all(_LABEL_RE.match(label) for label in labels):
        raise InvalidAddressError("Endereco de e-mail invalido.")
    if labels[-1].isdigit():  # recusa IP literal / TLD numerico
        raise InvalidAddressError("Endereco de e-mail invalido.")
    return f"{local}@{domain.lower()}"


def address_domain(address: str) -> str:
    return address.rsplit("@", 1)[1].lower()


def is_valid_hostname(value: str) -> bool:
    if not value or len(value) > 253 or not value.isascii():
        return False
    return all(_HOST_LABEL_RE.match(label) for label in value.rstrip(".").split("."))


def mask_address(value: object) -> str:
    """`maria@agu.gov.br` -> `m***@agu.gov.br`. Nunca levanta."""
    try:
        text = str(value)
        if "@" not in text:
            return "***"
        local, domain = text.rsplit("@", 1)
        domain = "".join(c for c in domain[:100] if not (ord(c) < 32 or ord(c) == 127))
        first = local[:1] if local[:1].isalnum() else "*"
        return f"{first}***@{domain}"
    except Exception:  # noqa: BLE001
        return "***"
