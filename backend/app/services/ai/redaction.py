"""Redação LGPD do payload enviado ao LLM (duas camadas).

1. ALLOWLIST de campos: o payload é um DTO AGREGADO (dict/list de valores
   escalares). Só chaves de `ALLOWED_FIELDS` (+ extras da funcionalidade)
   sobrevivem, em qualquer nível; nomes, e-mails, CPF, matrícula e IDs de
   pessoa nunca estão na allowlist e são descartados. Strings são
   truncadas, listas e profundidade limitadas. Contagens entre 1 e 4 são
   suprimidas (k-anonimato simples: viram "<5").
2. VARREDURA BLOQUEANTE (defesa em profundidade) sobre o JSON resultante:
   CPF formatado (000.000.000-00, bloqueia mesmo sem DV válido) e com
   separadores variados/ausentes (espaço, ponto, hífen, barra — bloqueia se
   os 11 dígitos tiverem DV válido, o que evita falso positivo em número
   patrimonial), e-mail (também `@` com espaços, `[at]`/`(at)`), telefone
   BR, JWT e chaves `sk-`/`sk-ant-`. Qualquer achado BLOQUEIA o envio.
3. NORMALIZAÇÃO (AI-RED-01): toda string permitida passa por
   `textnorm.normalize_text` (NFKC, sem `Cf`/zero-width, separadores e
   dígitos Unicode em ASCII) ANTES da truncagem e da varredura, e o payload
   devolvido (= o que vai ao provedor) é o NORMALIZADO: o texto varrido é o
   texto enviado. `scan_sensitive` também normaliza o texto recebido.

Limitação conhecida: nomes próprios em campos de texto livre permitidos
(ex.: `question`) não são detectáveis por padrão; por isso os campos de
texto livre da allowlist são mínimos e o builder de cada funcionalidade só
deve preencher rótulos não pessoais (unidade, sala, tipo de alerta).
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.services.ai.models import FEATURE_ASSISTANT
from app.services.ai.textnorm import normalize_text

ALLOWED_FIELDS: frozenset[str] = frozenset(
    {
        # contexto
        "feature", "period", "period_start", "period_end", "generated_at",
        "unit_code", "unit_label", "room_label", "location_label",
        # alertas / métricas agregadas
        "alerts", "alert_type", "severity", "count", "total", "threshold", "days",
        "percentage", "trend", "metrics", "category", "movement_type", "status",
        "week", "current", "baseline_mean", "baseline_stddev",
        # qualidade de dados
        "issues", "issue", "rule", "field_name", "examples_count",
        # assistente (ferramentas somente leitura)
        "tool", "result", "items",
    }
)

FEATURE_EXTRA_FIELDS: Mapping[str, frozenset[str]] = {
    FEATURE_ASSISTANT: frozenset({"question"}),
}

COUNT_FIELDS: frozenset[str] = frozenset({"count", "total", "current", "examples_count"})
K_ANONYMITY_MIN = 5
SUPPRESSED_COUNT = "<5"

MAX_STRING_LENGTH = 300
MAX_LIST_ITEMS = 50
MAX_DEPTH = 7  # assistente: items -> {tool,result} -> result.items -> {room_label,count}
MAX_PAYLOAD_CHARS = 20_000

# Texto já normalizado (dígitos ASCII); `[0-9]` evita casar dígitos de outras escritas.
_CPF_FORMATTED = re.compile(r"(?<![0-9])[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}(?![0-9])")
_CPF_SEP = r"[\s./\-]{0,2}"
_CPF_LOOSE = re.compile(
    rf"(?<![0-9])[0-9]{{3}}{_CPF_SEP}[0-9]{{3}}{_CPF_SEP}[0-9]{{3}}{_CPF_SEP}[0-9]{{2}}(?![0-9])"
)
_EMAIL = re.compile(
    r"[\w.%+-]+\s*(?:@|\[at\]|\(at\))\s*[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
    re.IGNORECASE,
)
_PHONE_BR = re.compile(
    r"(?:\+?55[\s-]?)?\(\d{2}\)\s?9?\d{4}[\s-]?\d{4}(?!\d)"  # (63) 99999-9999
    r"|\+55[\s-]?\d{2}[\s-]?9?\d{4}[\s-]?\d{4}(?!\d)"  # +55 63 99999-9999
    r"|(?<!\d)\d{2}[\s-]9?\d{4}-\d{4}(?!\d)"  # 63 99999-9999
    r"|(?<![\d-])9\d{4}-\d{4}(?!\d)"  # 99999-9999
)
_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*")
_API_KEY = re.compile(r"sk-(?:ant-)?[A-Za-z0-9_-]{10,}")


def _valid_cpf(digits: str) -> bool:
    if len(digits) != 11 or digits == digits[0] * 11:
        return False
    nums = [int(d) for d in digits]
    for size in (9, 10):
        total = sum(n * w for n, w in zip(nums[:size], range(size + 1, 1, -1)))
        check = (total * 10) % 11 % 10
        if check != nums[size]:
            return False
    return True


def _has_cpf(text: str) -> bool:
    if _CPF_FORMATTED.search(text):
        return True
    for match in _CPF_LOOSE.finditer(text):
        if _valid_cpf("".join(ch for ch in match.group(0) if "0" <= ch <= "9")):
            return True
    return False


def scan_sensitive(text: str) -> tuple[str, ...]:
    """Categorias de dado sensível encontradas em `text` (nunca os valores).

    O texto é normalizado (`normalize_text`) antes da varredura.
    """
    text = normalize_text(text)
    found: list[str] = []
    if _has_cpf(text):
        found.append("cpf")
    if _EMAIL.search(text):
        found.append("email")
    if _PHONE_BR.search(text):
        found.append("phone")
    if _JWT.search(text):
        found.append("jwt")
    if _API_KEY.search(text):
        found.append("api_key")
    return tuple(found)


@dataclass(frozen=True)
class RedactionResult:
    ok: bool
    payload: dict[str, Any] | None = field(default=None, repr=False)
    blocked_categories: tuple[str, ...] = ()
    dropped_fields: int = 0
    suppressed_counts: int = 0


class _Sanitizer:
    def __init__(self, allowed: frozenset[str]) -> None:
        self.allowed = allowed
        self.dropped = 0
        self.suppressed = 0

    def _small_count(self, value: Any, key: str | None) -> bool:
        """Contagem 1..4 em `int`, `float` ou string numérica (AI-RED-02)."""
        if key not in COUNT_FIELDS:
            return False
        if isinstance(value, int):
            return 0 < value < K_ANONYMITY_MIN
        if isinstance(value, str):
            try:
                number = float(value.strip())
            except (ValueError, OverflowError):
                return False
        else:
            number = value
        return math.isfinite(number) and 0 < number < K_ANONYMITY_MIN

    def value(self, value: Any, depth: int, key: str | None = None) -> Any:
        if depth > MAX_DEPTH:
            self.dropped += 1
            return None
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, int):
            if self._small_count(value, key):
                self.suppressed += 1
                return SUPPRESSED_COUNT
            return value
        if isinstance(value, float):
            if not math.isfinite(value):
                return None
            if self._small_count(value, key):
                self.suppressed += 1
                return SUPPRESSED_COUNT
            return value
        if isinstance(value, str):
            # Normaliza ANTES de truncar/varrer; o texto normalizado é o enviado.
            text = normalize_text(value)
            if self._small_count(text, key):
                self.suppressed += 1
                return SUPPRESSED_COUNT
            return text[:MAX_STRING_LENGTH]
        if isinstance(value, Mapping):
            return self.mapping(value, depth + 1)
        if isinstance(value, (list, tuple)):
            if len(value) > MAX_LIST_ITEMS:
                self.dropped += len(value) - MAX_LIST_ITEMS
            return [self.value(v, depth + 1, key) for v in list(value)[:MAX_LIST_ITEMS]]
        # Objetos arbitrários (ORM, UUID, datetime...) nunca passam.
        self.dropped += 1
        return None

    def mapping(self, data: Mapping[Any, Any], depth: int) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for raw_key, raw_value in data.items():
            if not isinstance(raw_key, str) or raw_key not in self.allowed:
                self.dropped += 1
                continue
            out[raw_key] = self.value(raw_value, depth, raw_key)
        return out


def redact_payload(feature: str, dto: Any) -> RedactionResult:
    """Aplica allowlist + supressão + varredura bloqueante. Nunca lança."""
    try:
        if not isinstance(dto, Mapping):
            return RedactionResult(ok=False, blocked_categories=("invalid_payload",))
        allowed = ALLOWED_FIELDS | FEATURE_EXTRA_FIELDS.get(feature, frozenset())
        sanitizer = _Sanitizer(allowed)
        payload = sanitizer.mapping(dto, 1)
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if len(serialized) > MAX_PAYLOAD_CHARS:
            return RedactionResult(ok=False, blocked_categories=("payload_too_large",))
        found = scan_sensitive(serialized)
        if found:
            return RedactionResult(
                ok=False,
                blocked_categories=found,
                dropped_fields=sanitizer.dropped,
                suppressed_counts=sanitizer.suppressed,
            )
        return RedactionResult(
            ok=True,
            payload=payload,
            dropped_fields=sanitizer.dropped,
            suppressed_counts=sanitizer.suppressed,
        )
    except Exception:  # noqa: BLE001 - falha => bloqueia
        return RedactionResult(ok=False, blocked_categories=("internal_error",))
