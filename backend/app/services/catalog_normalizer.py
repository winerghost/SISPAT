"""Normalizadores PUROS dos cadastros de apoio (unidades, salas, pessoas).

Sem DB, sem I/O. Entrada: texto bruto de células (não confiável). Saída:
valores normalizados + avisos/pendências em texto. Regras (plano 3.1):

- trim e espaços colapsados; NFC; NÃO corrige grafia (só reporta suspeitos);
- nome de pessoa: remove o sufixo `` -`` (ex.: ``"ERICA ... DANTAS -"``);
- e-mail: minúsculo e validado; telefone: só dígitos, 10–13 dígitos;
- marcador ``Ocioso`` (nome ou e-mail) NÃO é pessoa;
- sala: chave de unicidade = casefold + espaços colapsados (``06`` != ``6``);
  chave de "provável duplicata" = sem acento e sem zeros à esquerda
  em tokens numéricos (``06`` ~ ``6``), apenas para relatório.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.services.import_normalizer import (
    is_placeholder_email,
    is_valid_email,
    person_match_key,
)

MAX_NAME = 200
MAX_SOURCE_ID = 64
_TRAILING_DASH_RE = re.compile(r"\s+-+\s*$")
_PHONE_OK_LEN = range(10, 14)
_NAME_ALLOWED_RE = re.compile(r"^[^\W\d_]+(?:[ .'’\-]+[^\W\d_]+)*\.?$", re.UNICODE)
_TILDE_OK_RE = re.compile(r"[ãõ](?![eo]|\b)", re.IGNORECASE)
_REPEAT_RE = re.compile(r"(.)\1\1", re.IGNORECASE)
_PLACEHOLDER_NAMES = frozenset({"ocioso"})


_FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf"})
SIGLA_RE = re.compile(r"[A-Za-z0-9._-]{1,32}")


def has_forbidden_chars(value: Any) -> bool:
    """True se o texto (após colapsar espaços) tem controle (Cc) ou formatação
    invisível/bidi/largura zero (Cf). SEC-CAT-04: mesma regra do CRUD."""
    if value is None:
        return False
    text = " ".join(str(value).split())
    return any(unicodedata.category(ch) in _FORBIDDEN_CATEGORIES for ch in text)


def clean_text(value: Any) -> str | None:
    """NFC + espaços colapsados + trim; vazio -> None.

    Texto com caracteres de controle/bidi/largura zero (Cc/Cf) NÃO é limpo
    silenciosamente: devolve None (quem precisa distinguir "vazio" de "inválido"
    usa `has_forbidden_chars` sobre o valor bruto).
    """
    if value is None:
        return None
    text = " ".join(unicodedata.normalize("NFC", str(value)).split())
    if any(unicodedata.category(ch) in _FORBIDDEN_CATEGORIES for ch in text):
        return None
    return text or None


def normalize_source_id(value: Any) -> str | None:
    text = clean_text(value)
    if text is None:
        return None
    return text[:MAX_SOURCE_ID] if len(text) <= MAX_SOURCE_ID else None


def normalize_person_name(value: Any) -> str | None:
    """Nome limpo, sem o sufixo `` -``; None se vazio."""
    text = clean_text(value)
    if text is None:
        return None
    text = _TRAILING_DASH_RE.sub("", text).strip()
    return text or None


def suspicious_name_reasons(name: str | None) -> list[str]:
    """Motivos para revisão humana (NUNCA altera o nome)."""
    if not name:
        return []
    reasons: list[str] = []
    if "�" in name:
        reasons.append("caractere de substituição (U+FFFD)")
    if any(ch.isdigit() for ch in name):
        reasons.append("contém dígitos")
    elif not _NAME_ALLOWED_RE.match(name):
        reasons.append("caracteres incomuns")
    if _TILDE_OK_RE.search(name):
        reasons.append("til em posição incomum (possível erro de digitação)")
    if _REPEAT_RE.search(name):
        reasons.append("letra repetida 3 vezes ou mais")
    return reasons


def is_placeholder_person(name: str | None, email: str | None) -> bool:
    """``Ocioso`` (nome ou local-part do e-mail) é marcador, não pessoa."""
    key = person_match_key(name)
    if key in _PLACEHOLDER_NAMES:
        return True
    return bool(email) and is_placeholder_email(email or "")


def parse_person_email(value: Any) -> tuple[str | None, str | None]:
    """(email, problema). Vazio -> (None, None); inválido -> (None, motivo)."""
    if has_forbidden_chars(value):
        return None, "e-mail sem formato/domínio válido"
    text = clean_text(value)
    if text is None:
        return None, None
    email = text.lower()
    if is_valid_email(email):
        return email, None
    return None, "e-mail sem formato/domínio válido"


def parse_phone(value: Any) -> tuple[str | None, str | None]:
    """(telefone só dígitos, aviso). Aceita com/sem 55; fora de 10–13 -> None."""
    text = clean_text(value)
    if text is None:
        return None, None
    digits = "".join(ch for ch in text if ch.isdigit())
    if len(digits) not in _PHONE_OK_LEN:
        return None, "aviso: telefone inválido (esperado 10 a 13 dígitos); ignorado"
    if len(digits) >= 12 and not digits.startswith("55"):
        return None, "aviso: telefone com 12–13 dígitos sem prefixo 55; ignorado"
    return digits, None


def normalize_room_name(value: Any) -> str | None:
    text = clean_text(value)
    if text is None or len(text) > MAX_NAME:
        return None
    return text


def room_key(name: str) -> str:
    """Unicidade (unidade, nome): casefold + espaços colapsados."""
    return " ".join(name.casefold().split())


def room_probable_duplicate_key(name: str) -> str:
    """Só para relatório: sem acento e sem zeros à esquerda (``06`` ~ ``6``)."""
    base = person_match_key(name) or ""
    tokens = [(t.lstrip("0") or "0") if t.isdigit() else t for t in base.split()]
    return " ".join(tokens)
