"""Normalização Unicode de texto destinado ao LLM (AI-RED-01 / AI-PI-01).

Usada pela redação (`redaction`) ANTES da varredura e pela serialização do
prompt (`prompting`) ANTES do escape do delimitador, de modo que o texto
VARRIDO é exatamente o texto ENVIADO ao provedor.

Passos (idempotentes):
    1. NFKC: formas fullwidth/de compatibilidade viram ASCII (arroba,
       dígitos, sinais `<`/`>`, ponto e hífen fullwidth).
    2. Remove caracteres de formatação (categoria `Cf`: zero-width, bidi,
       soft hyphen...).
    3. Espaços Unicode (`Zs`) e controles (`Cc`, exceto tab, LF e CR) viram
       espaço ASCII; separadores de linha/parágrafo (`Zl`, `Zp`) viram LF;
       travessões (`Pd`) viram `-`; dígitos decimais de qualquer escrita
       (`Nd`) viram ASCII. A varredura trata qualquer espaço como separador.
    4. NFKC de novo (a remoção do passo 2 pode juntar sequências).
"""
from __future__ import annotations

import unicodedata
from typing import Any

_KEPT_WHITESPACE = frozenset({"\t", "\n", "\r"})


def _map_char(ch: str) -> str:
    if ch == " " or ("!" <= ch <= "~") or ch in _KEPT_WHITESPACE:
        return ch
    category = unicodedata.category(ch)
    if category == "Cf":
        return ""
    if category in ("Zs", "Cc"):
        return " "
    if category in ("Zl", "Zp"):
        return "\n"
    if category == "Pd":
        return "-"
    if category == "Nd":
        return str(unicodedata.decimal(ch, 0))
    return ch


def normalize_text(value: str) -> str:
    """Texto em NFKC, sem `Cf`, com separadores/dígitos/travessões em ASCII."""
    first = unicodedata.normalize("NFKC", value)
    mapped = "".join(_map_char(ch) for ch in first)
    return unicodedata.normalize("NFKC", mapped)


def normalize_obj(value: Any) -> Any:
    """Aplica `normalize_text` a toda string (chaves e valores) de dict/list."""
    if isinstance(value, str):
        return normalize_text(value)
    if isinstance(value, dict):
        return {normalize_obj(k): normalize_obj(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize_obj(v) for v in value]
    return value
