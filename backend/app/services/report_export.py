"""Serialização segura de relatórios tabulares em CSV e XLSX.

TODA célula (cabeçalho incluído) passa por `app.security.csv_safety.escape_formula`
(CWE-1236) e é gravada SEMPRE como TEXTO:

- CSV: `build_safe_csv` (`QUOTE_ALL`, `;`), UTF-8 com BOM (Excel pt-BR).
- XLSX: escritor mínimo próprio (zip + OOXML) com células `t="inlineStr"`;
  nunca `<f>` (fórmula) nem `t="n"`. Evita nova dependência e garante que o
  número patrimonial (texto, zeros à esquerda) não vire número no arquivo.
  Limitação do CSV: o Excel pode reinterpretar "00123" como número ao abrir;
  o XLSX preserva o texto.
"""
from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Sequence
from datetime import date, datetime, timezone
from typing import Any
from xml.sax.saxutils import escape as xml_escape

from app.security.csv_safety import build_safe_csv, escape_formula

CSV_MIMETYPE = "text/csv; charset=utf-8"
XLSX_MIMETYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_BOM = "﻿"
_XLSX_CELL_MAX = 32_767
_XML_ILLEGAL_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


def utc_iso(value: Any) -> str:
    """Timestamps sempre em UTC (ISO-8601 com `+00:00`); naive é tratado como UTC."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def as_text(value: Any) -> str:
    """Valor -> texto (nenhuma célula é número nativo)."""
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return utc_iso(value)
    return value if isinstance(value, str) else str(value)


def _safe_table(header: Sequence[str], rows: Sequence[Sequence[Any]]) -> tuple[list[str], list[list[str]]]:
    safe_header = [str(escape_formula(as_text(h))) for h in header]
    safe_rows = [[str(escape_formula(as_text(cell))) for cell in row] for row in rows]
    return safe_header, safe_rows


def to_csv_bytes(header: Sequence[str], rows: Sequence[Sequence[Any]]) -> bytes:
    # `build_safe_csv` aplica `escape_formula` a cada célula (cabeçalho incluído).
    return (_BOM + build_safe_csv([as_text(h) for h in header],
                                  [[as_text(c) for c in row] for row in rows])).encode("utf-8")


def _column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _cell(ref: str, text: str) -> str:
    clean = xml_escape(_XML_ILLEGAL_RE.sub("", text)[:_XLSX_CELL_MAX])
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{clean}</t></is></c>'


def to_xlsx_bytes(header: Sequence[str], rows: Sequence[Sequence[Any]], *, sheet_name: str = "Relatorio") -> bytes:
    safe_header, safe_rows = _safe_table(header, rows)
    lines = []
    for r_index, row in enumerate([safe_header, *safe_rows], start=1):
        cells = "".join(_cell(f"{_column_letter(c)}{r_index}", text) for c, text in enumerate(row))
        lines.append(f'<row r="{r_index}">{cells}</row>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(lines)}</sheetData></worksheet>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{xml_escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    buffer = io.BytesIO()
    fixed = (2026, 1, 1, 0, 0, 0)  # zip reprodutível; sem metadados do servidor
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in (
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", root_rels),
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", wb_rels),
            ("xl/worksheets/sheet1.xml", sheet),
        ):
            info = zipfile.ZipInfo(name, date_time=fixed)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return buffer.getvalue()
