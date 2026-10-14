"""Utilitários de normalização/validação de texto vindo de fontes NÃO confiáveis.

Usado principalmente pela importação do Google Sheets
(`app.integrations.google_sheets_client`, `app.services.import_service`),
mas genérico o bastante para qualquer entrada textual externa.

Princípios (auditoria AppSec 2026-10-13, ver
`docs/security/evidence/backend-data.md`):
    - NUNCA sanitização destrutiva de conteúdo livre (ex.: DESCRICAO): não
      removemos `<`, `>`, aspas, `=` etc. A defesa contra XSS é o escape
      contextual na SAÍDA (React escapa por padrão) e contra CSV/Formula
      Injection é `app.security.csv_safety` na EXPORTAÇÃO.
    - Exceção inevitável: o PostgreSQL não armazena o caractere NUL (U+0000)
      em `text`/`jsonb`, nem surrogates isolados (U+D800–U+DFFF) codificados
      em UTF-8. Esses pontos de código são substituídos por U+FFFD
      (`make_db_safe`), com aviso registrado pelo chamador — sem isso, uma
      única célula maliciosa derrubaria a pré-visualização inteira (DoS).
    - Identificadores (número patrimonial, ID de origem, cabeçalhos) recebem
      normalização mais estrita: NFC, remoção de caracteres invisíveis
      (zero-width, BOM) e rejeição de caracteres de controle.
"""
from __future__ import annotations

import unicodedata
from typing import Any

# Caracteres invisíveis comumente colados de editores/planilhas e que nunca
# fazem sentido em identificadores (número patrimonial, ID, cabeçalho).
INVISIBLE_CHARS = frozenset(
    {
        "​",  # ZERO WIDTH SPACE
        "‌",  # ZERO WIDTH NON-JOINER
        "‍",  # ZERO WIDTH JOINER
        "⁠",  # WORD JOINER
        "﻿",  # BOM / ZERO WIDTH NO-BREAK SPACE
        "­",  # SOFT HYPHEN
    }
)

REPLACEMENT_CHAR = "�"

# Caractere de escape usado em padrões LIKE/ILIKE (ver `escape_like`).
LIKE_ESCAPE_CHAR = "\\"


def make_db_safe(value: str) -> tuple[str, bool]:
    """Substitui pontos de código que o PostgreSQL não consegue armazenar
    (NUL e surrogates isolados) por U+FFFD.

    Retorna `(valor_seguro, alterado)`. Todo o restante do conteúdo é
    preservado byte a byte.
    """
    changed = False
    out: list[str] = []
    for ch in value:
        code = ord(ch)
        if code == 0 or 0xD800 <= code <= 0xDFFF:
            out.append(REPLACEMENT_CHAR)
            changed = True
        else:
            out.append(ch)
    return ("".join(out) if changed else value), changed


def remove_invisible(value: str) -> str:
    """Remove caracteres invisíveis (zero-width, BOM, soft hyphen)."""
    return "".join(ch for ch in value if ch not in INVISIBLE_CHARS)


def normalize_free_text(value: str) -> str:
    """Normalização NÃO destrutiva para texto livre: NFC + `strip()`.

    Não remove nenhum caractere visível legítimo (acentos, símbolos, `<`,
    `=`, etc.). NUL/surrogates devem ter sido tratados antes por
    `make_db_safe`.
    """
    return unicodedata.normalize("NFC", value).strip()


def normalize_identifier(value: str) -> str:
    """Normalização estrita para identificadores: NFC, remoção de
    invisíveis e `strip()` (inclui NBSP e demais espaços Unicode)."""
    return remove_invisible(unicodedata.normalize("NFC", value)).strip()


def has_control_chars(value: str) -> bool:
    """True se `value` contém caracteres de controle (categoria Unicode `Cc`,
    inclui TAB/CR/LF e NUL) ou de formatação (`Cf`, ex.: RLO U+202E usado em
    ataques de "bidi spoofing")."""
    return any(unicodedata.category(ch) in ("Cc", "Cf") for ch in value)


def canonical_header(header: Any) -> str:
    """Forma canônica de um cabeçalho para COMPARAÇÃO (nunca para exibição).

    NFC → remove invisíveis → `strip()` → remove acentos (NFKD sem marcas
    combinantes) → `upper()`. Assim `"\\ufeffPatrimônio "` casa com
    `"PATRIMONIO"`.
    """
    text = "" if header is None else str(header)
    text = normalize_identifier(text)
    decomposed = unicodedata.normalize("NFKD", text)
    without_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return without_marks.upper()


def escape_like(term: str, escape_char: str = LIKE_ESCAPE_CHAR) -> str:
    """Escapa os metacaracteres de LIKE/ILIKE (`%`, `_` e o próprio caractere
    de escape) para que `term` seja tratado como texto literal.

    Deve ser usado em conjunto com `column.ilike(pattern, escape=escape_char)`
    (bind parameter — o valor nunca é concatenado no SQL).
    """
    return (
        term.replace(escape_char, escape_char * 2)
        .replace("%", f"{escape_char}%")
        .replace("_", f"{escape_char}_")
    )
