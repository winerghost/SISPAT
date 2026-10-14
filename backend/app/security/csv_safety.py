"""Proteção contra CSV/Formula Injection (CWE-1236) em exportações.

Ainda NÃO existe endpoint de exportação (CSV/XLSX) no SISPAT-AGU. Este
módulo é o utilitário obrigatório para TODA exportação futura de dados
tabulares que possa ser aberta em Excel/LibreOffice/Google Sheets
(relatórios de patrimônio, inventários, movimentações, auditoria, etc.),
porque esses dados vêm, em parte, de fonte externa não confiável (planilha
do Google Sheets importada) e de usuários.

Regra (OWASP "CSV Injection"):
    Uma célula de texto cujo primeiro caractere significativo é `=`, `+`,
    `-`, `@`, TAB (`\\t`), CR (`\\r`) ou LF (`\\n`) — inclusive quando
    precedido de espaços ou aspas, e inclusive nas variantes de largura
    total (`＝ ＋ － ＠`) — recebe um apóstrofo (`'`) como prefixo, o que faz
    a planilha tratá-la como texto literal. Além disso, `write_safe_csv`
    usa `csv.QUOTE_ALL`, escapando aspas internas e delimitadores.

Valores numéricos nativos (`int`, `float`, `Decimal`) NÃO são alterados: não
podem conter fórmulas. Atenção: número patrimonial é TEXTO no SISPAT-AGU e,
portanto, passa por `escape_formula` como qualquer outra string.

Para XLSX (ex.: openpyxl), aplicar `escape_formula` em toda célula string
antes de atribuí-la, OU definir explicitamente o tipo da célula como string
(`cell.data_type = "s"`) — nunca gravar strings vindas de usuário/planilha
como fórmula.
"""
from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Any, TextIO

FORMULA_TRIGGER_CHARS = frozenset(
    {"=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"}
)
# Caracteres que podem preceder o gatilho e ainda assim permitir que a
# planilha interprete a célula como fórmula (ex.: ` =1+1`, `"=1+1`).
_LEADING_IGNORABLE = " \"' "

FORMULA_ESCAPE_PREFIX = "'"


def is_formula_like(value: str) -> bool:
    """True se `value` seria interpretado como fórmula por uma planilha."""
    if not value:
        return False
    if value[0] in FORMULA_TRIGGER_CHARS:
        return True
    stripped = value.lstrip(_LEADING_IGNORABLE)
    return bool(stripped) and stripped[0] in FORMULA_TRIGGER_CHARS


def escape_formula(value: Any) -> Any:
    """Neutraliza uma célula para exportação. Strings perigosas recebem o
    prefixo `'`; `None` vira string vazia; números nativos e `bool` são
    devolvidos intactos; outros tipos são convertidos com `str()` e
    tratados como string."""
    if value is None:
        return ""
    if isinstance(value, (bool, int, float, Decimal)):
        return value
    text = value if isinstance(value, str) else str(value)
    if is_formula_like(text):
        return FORMULA_ESCAPE_PREFIX + text
    return text


def escape_row(row: Iterable[Any]) -> list[Any]:
    """Aplica `escape_formula` a cada célula de uma linha."""
    return [escape_formula(cell) for cell in row]


def write_safe_csv(
    output: TextIO,
    header: Sequence[Any] | None,
    rows: Iterable[Iterable[Any]],
    delimiter: str = ";",
) -> None:
    """Escreve um CSV seguro em `output` (cabeçalho também é escapado).

    `delimiter=';'` por padrão (convenção do Excel em pt-BR). Use
    `newline=""` ao abrir arquivos destinados a esta função.
    """
    writer = csv.writer(output, delimiter=delimiter, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    if header is not None:
        writer.writerow(escape_row(header))
    for row in rows:
        writer.writerow(escape_row(row))


def build_safe_csv(
    header: Sequence[Any] | None, rows: Iterable[Iterable[Any]], delimiter: str = ";"
) -> str:
    """Conveniência: retorna o CSV seguro como `str` (para `Response`)."""
    buffer = io.StringIO(newline="")
    write_safe_csv(buffer, header, rows, delimiter=delimiter)
    return buffer.getvalue()
