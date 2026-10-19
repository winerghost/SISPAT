"""Normalizador PURO de uma linha da planilha MConferencia.

Sem DB, sem I/O, sem estado. Entrada: texto bruto das células (ou `None`
para célula vazia). Saída: valores normalizados em formato JSON-safe
(datas como string ISO) e uma lista de avisos prefixados com ``"aviso: "``.

Interpretações baseadas na AMOSTRA de 10 linhas (2026-10-16); devem ser
validadas na prévia real (ver `docs/architecture/plano-importacao-mconferencia.md`):

- 1ª coluna ``RESPONSAVEL`` = vínculo/situação (``Terceirizado``, ``Ocioso``,
  ``Servidor``); 2ª = pessoa responsável.
- ``QT`` NÃO é interpretado aqui (permanece bruto em ``qt_raw`` no cliente).
- ``PATRIMONIO``/``ID`` não são tratados aqui (continuam texto, validados
  no cliente com erro bloqueante).

Valores inválidos viram ``None`` + aviso; este módulo nunca emite ``erro:``.
Os valores brutos (``raw_values``) nunca são alterados por este módulo.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    _SOURCE_TZ: Any = ZoneInfo("America/Araguaina")
except ZoneInfoNotFoundError:  # pragma: no cover - ambiente sem tzdata
    _SOURCE_TZ = timezone(timedelta(hours=-3))  # offset vigente (sem DST)

_MATERIAL_CODE_RE = re.compile(r"^\s*\((\d{8}-\d)\)\s*")
# SEC-CAT-05: sem `\s*` final nem quantificadores aninhados (ReDoS quadrático).
# O pipe final é removido com `rstrip`/`endswith` (ver `parse_description`) e o
# texto de `parse_owner_unit` tem os espaços colapsados ANTES do regex linear.
_UNIT_OWNER_RE = re.compile(r"^(\d{6}) ?- ?(.+)$")
_EMAIL_RE = re.compile(
    r"^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9]([a-z0-9-]*[a-z0-9])?"
    r"(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$"
)
_EMAIL_MAX = 254
_DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
_DATETIME_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$")
_COORD_RE = re.compile(r"^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$")
_PLACEHOLDER_LOCALS = frozenset({"ocioso"})
_LOCALIZADO_MAP = {"S": "SIM", "N": "NAO"}
_MAX_TEXT = 255


def _clean(value: Any) -> str | None:
    """Texto com NFC + strip; vazio/None -> None."""
    if value is None:
        return None
    text = unicodedata.normalize("NFC", str(value)).strip()
    return text or None


def person_match_key(name: str | None) -> str | None:
    """Chave de casamento de pessoa: casefold, sem acento, espaços colapsados."""
    text = _clean(name)
    if text is None:
        return None
    decomposed = unicodedata.normalize("NFKD", text)
    no_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(no_marks.casefold().split()) or None


@dataclass(frozen=True)
class MaterialDescription:
    codigo_material: str | None
    descricao_limpa: str | None


def parse_description(value: Any) -> MaterialDescription:
    """Extrai ``(NNNNNNNN-D)`` do início e remove o `` |`` final."""
    text = _clean(value)
    if text is None:
        return MaterialDescription(None, None)
    code: str | None = None
    match = _MATERIAL_CODE_RE.match(text)
    if match:
        code = match.group(1)
        text = text[match.end():]
    text = text.rstrip()
    if text.endswith("|"):
        text = text[:-1]
    text = text.strip()
    return MaterialDescription(code, text or None)


def parse_owner_unit(value: Any, warnings: list[str]) -> tuple[str | None, str | None]:
    """``'023404 - NOME'`` -> (``'023404'``, ``'NOME'``)."""
    text = _clean(value)
    if text is None:
        return None, None
    text = " ".join(text.split())  # colapsa espaços (linear) antes do regex
    match = _UNIT_OWNER_RE.match(text)
    if not match:
        warnings.append(
            "aviso: campo UNIDADE_PERTENCENTE sem código de 6 dígitos "
            "('NNNNNN - NOME'); ignorado"
        )
        return None, None
    return match.group(1), match.group(2)


def parse_located(value: Any, warnings: list[str]) -> str:
    """S/N -> SIM/NAO; vazio -> DESCONHECIDO (sem aviso extra); outro -> aviso."""
    text = _clean(value)
    if text is None:
        return "DESCONHECIDO"
    mapped = _LOCALIZADO_MAP.get(text.upper())
    if mapped is None:
        warnings.append(f"aviso: campo LOCALIZADO com valor inesperado ({text[:20]!r}); usando DESCONHECIDO")
        return "DESCONHECIDO"
    return mapped


def is_valid_email(email: str) -> bool:
    """True se `email` (já minúsculo) tem forma válida e domínio com ponto."""
    return len(email) <= _EMAIL_MAX and _EMAIL_RE.match(email) is not None


def is_placeholder_email(email: str) -> bool:
    """True para marcadores conhecidos (ex.: ``Ocioso@ocioso``)."""
    return email.lower().split("@", 1)[0] in _PLACEHOLDER_LOCALS


def parse_email(value: Any, warnings: list[str]) -> str | None:
    """E-mail minúsculo válido; placeholders (ex.: ``Ocioso@ocioso``) -> None."""
    text = _clean(value)
    if text is None:
        return None
    email = text.lower()
    if len(email) <= _EMAIL_MAX and _EMAIL_RE.match(email):
        return email
    local = email.split("@", 1)[0]
    if local not in _PLACEHOLDER_LOCALS:  # placeholder conhecido é silencioso
        warnings.append("aviso: campo USUARIO não é um e-mail válido; ignorado")
    return None


def parse_coordinates(
    value: Any, warnings: list[str]
) -> tuple[float | None, float | None]:
    """``'lat, lon'`` -> floats; ``0,0`` -> (None, None); fora de faixa -> aviso."""
    text = _clean(value)
    if text is None:
        return None, None
    match = _COORD_RE.match(text)
    if not match:
        warnings.append("aviso: campo LOCALIZACAO em formato inválido ('lat, lon'); ignorado")
        return None, None
    lat, lon = float(match.group(1)), float(match.group(2))
    if lat == 0.0 and lon == 0.0:
        return None, None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        warnings.append("aviso: campo LOCALIZACAO fora da faixa de coordenadas; ignorado")
        return None, None
    return lat, lon


def parse_date(value: Any, warnings: list[str]) -> date | None:
    """``dd/mm/aaaa`` -> date; inválida -> None + aviso."""
    text = _clean(value)
    if text is None:
        return None
    match = _DATE_RE.match(text)
    if match:
        try:
            return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
        except ValueError:
            pass
    warnings.append("aviso: campo DATA_REGISTRO inválido (esperado dd/mm/aaaa); ignorado")
    return None


def parse_datetime_utc(value: Any, warnings: list[str]) -> datetime | None:
    """``dd/mm/aaaa HH:MM:SS`` em America/Araguaina -> datetime UTC (aware)."""
    text = _clean(value)
    if text is None:
        return None
    match = _DATETIME_RE.match(text)
    if match:
        d, mo, y, h, mi, s = (int(g) for g in match.groups())
        try:
            local = datetime(y, mo, d, h, mi, s, tzinfo=_SOURCE_TZ)
            return local.astimezone(timezone.utc)
        except ValueError:
            pass
    warnings.append(
        "aviso: campo DATA_ALTERACAO inválido (esperado dd/mm/aaaa HH:MM:SS); ignorado"
    )
    return None


def _bounded_text(value: Any, field: str, warnings: list[str]) -> str | None:
    text = _clean(value)
    if text is not None and len(text) > _MAX_TEXT:
        warnings.append(f"aviso: campo {field} excede {_MAX_TEXT} caracteres; truncado")
        text = text[:_MAX_TEXT]
    return text


def normalize_row(
    *,
    descricao: Any = None,
    localizado: Any = None,
    sala: Any = None,
    usuario: Any = None,
    unidade_pertencente: Any = None,
    responsavel_vinculo: Any = None,
    responsavel_pessoa: Any = None,
    data_registro: Any = None,
    localizacao: Any = None,
    data_alteracao: Any = None,
    pesquisador: Any = None,
) -> tuple[dict[str, Any], list[str]]:
    """Normaliza uma linha. Retorna (valores JSON-safe, avisos)."""
    warnings: list[str] = []
    material = parse_description(descricao)
    owner_code, owner_name = parse_owner_unit(unidade_pertencente, warnings)
    lat, lon = parse_coordinates(localizacao, warnings)
    updated = parse_datetime_utc(data_alteracao, warnings)
    registered = parse_date(data_registro, warnings)
    pessoa = _bounded_text(responsavel_pessoa, "RESPONSAVEL (2ª)", warnings)
    values: dict[str, Any] = {
        "codigo_material": material.codigo_material,
        "descricao_limpa": material.descricao_limpa,
        "owner_unit_code": owner_code,
        "owner_unit_name": owner_name,
        "located_enum": parse_located(localizado, warnings),
        "sala_codigo": _bounded_text(sala, "SALA", warnings),
        "usuario_email": parse_email(usuario, warnings),
        "vinculo_situacao": _bounded_text(responsavel_vinculo, "RESPONSAVEL (1ª)", warnings),
        "responsavel_pessoa": pessoa,
        "responsavel_pessoa_key": person_match_key(pessoa),
        "latitude": lat,
        "longitude": lon,
        "source_updated_at_utc": updated.isoformat() if updated else None,
        "registration_date": registered.isoformat() if registered else None,
        "pesquisador": _bounded_text(pesquisador, "PESQUISADOR", warnings),
    }
    return values, warnings
