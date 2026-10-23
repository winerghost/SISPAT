"""Contrato comum da resposta de confirmação das importações (bens e cadastros).

Compartilhado por `imports.py` (bens) e `catalog_imports.py` (cadastros):

- tipos com limites (`CountMap`, `ConfirmUnwrittenOut`) usados nos schemas
  Pydantic `extra="forbid"`;
- `safe_confirm_payload`: a validação da resposta roda APÓS o commit da
  confirmação (o serviço já gravou). Se ela falhar, um 500 seria FALSO (os
  dados estão gravados e a prévia consumida): devolve-se 200 com contadores
  mínimos válidos e `degraded=true`. A falha vai ao log só como tipo e nomes de
  campo (nunca valores: podem conter dados da planilha).
"""
from __future__ import annotations

import logging
from typing import Annotated, Any, Callable, Literal

from pydantic import BaseModel, Field, StringConstraints, ValidationError

from app.api.v1.schemas import _StrictModel

logger = logging.getLogger(__name__)

MAX_COUNT = 1_000_000
MAX_LISTED_FAILURES = 100

JobStatus = Literal["CONCLUIDO", "PARCIAL", "FALHOU"]
_JOB_STATUSES = ("CONCLUIDO", "PARCIAL", "FALHOU")

Count = Annotated[int, Field(ge=0, le=MAX_COUNT)]
# código (curto) -> quantidade; no máximo 64 códigos distintos.
CountMap = Annotated[
    dict[Annotated[str, StringConstraints(max_length=64)], Count],
    Field(max_length=64),
]


class ConfirmUnwrittenOut(_StrictModel):
    """Itens da prévia não gravados, por classificação e motivo (só contadores)."""

    total: Count
    por_classificacao: CountMap
    por_motivo: CountMap
    nao_selecionados: Count


def _count(value: Any) -> int:
    """Inteiro dentro de [0, MAX_COUNT]; qualquer outra coisa vira 0."""
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return min(max(value, 0), MAX_COUNT)


def _derive_status(saved: int, failures: int) -> str:
    if failures > 0 and saved == 0:
        return "FALHOU"
    return "PARCIAL" if failures > 0 else "CONCLUIDO"


def degraded_payload(
    schema: type[BaseModel], identity: dict[str, Any], result: Any
) -> dict[str, Any]:
    """Resposta mínima VÁLIDA a partir do resultado do serviço (já commitado).

    Mantém só inteiros saneados e o status; descarta lista de falhas e resumo
    de não gravados (zerados) e marca `degraded=true`.
    """
    raw = result if isinstance(result, dict) else {}
    created, updated = _count(raw.get("created")), _count(raw.get("updated"))
    failures_list = raw.get("falhas")
    falhas_total = max(
        _count(raw.get("falhas_total")),
        len(failures_list) if isinstance(failures_list, list) else 0,
    )
    status = raw.get("status")
    if status not in _JOB_STATUSES:
        status = _derive_status(created + updated, falhas_total)
    payload: dict[str, Any] = {
        **identity,
        "sync_job_id": str(raw.get("sync_job_id", ""))[:64],
        "status": status,
        "created": created,
        "updated": updated,
        "ignorados": _count(raw.get("ignorados")),
        "inalterados": _count(raw.get("inalterados")),
        "nao_gravados": {
            "total": 0,
            "por_classificacao": {},
            "por_motivo": {},
            "nao_selecionados": 0,
        },
        "falhas_total": min(falhas_total, MAX_COUNT),
        "falhas": [],
        "degraded": True,
    }
    if "pendencias_vinculo" in getattr(schema, "model_fields", {}):
        payload["pendencias_vinculo"] = {}
    try:
        return schema.model_validate(payload).model_dump()
    except ValidationError:  # pragma: no cover - todos os campos já foram saneados
        return payload


def safe_confirm_payload(
    schema: type[BaseModel],
    build: Callable[[], dict[str, Any]],
    *,
    identity: dict[str, Any],
    result: Any,
    context: str,
) -> dict[str, Any]:
    """Valida a resposta; em falha PÓS-commit devolve a versão degradada (200)."""
    try:
        return schema.model_validate(build()).model_dump()
    except Exception as exc:  # noqa: BLE001 - nunca um 500 falso com dados já gravados
        fields = ""
        if isinstance(exc, ValidationError):
            fields = ",".join(sorted({".".join(str(p) for p in e["loc"][:2]) for e in exc.errors()}))
        logger.error(
            "%s: resposta da confirmação inválida após o commit (%s%s); resposta degradada.",
            context,
            type(exc).__name__,
            f" campos={fields}" if fields else "",
        )
        return degraded_payload(schema, identity, result)
