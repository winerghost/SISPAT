"""Schema Pydantic (`extra="forbid"`) da resposta de confirmação da importação de BENS.

Mesmo contrato da confirmação dos cadastros (`catalog_import_schemas`): status do
SyncJob, `inalterados`, `falhas_total` (+ lista de no máximo 100), `nao_gravados`
por classificação/motivo e `pendencias_vinculo` (sala/pessoa/unidade ausentes nos
bens criados). Só contadores e códigos; a falha traz linha, número patrimonial
(TEXTO) e motivo fixo, nunca descrição, pessoa ou e-mail.
"""
from __future__ import annotations

from pydantic import Field

from app.api.v1.import_confirm_common import ConfirmUnwrittenOut, Count, CountMap, JobStatus
from app.api.v1.schemas import _StrictModel


class AssetImportFailureOut(_StrictModel):
    """Falha de um item de bens na confirmação."""

    item_id: str | None = Field(default=None, max_length=64)
    row: int | None = Field(default=None, ge=0, le=10_000_000)
    patrimony_number: str | None = Field(default=None, max_length=200)
    reason: str | None = Field(default=None, max_length=300)


class AssetImportConfirmResponse(_StrictModel):
    """Corpo de resposta de `POST /imports/google-sheets/confirm`.

    `degraded=true`: a validação falhou APÓS o commit; os dados estão gravados e
    só os contadores mínimos são confiáveis.
    """

    sync_job_id: str = Field(max_length=64)
    status: JobStatus
    created: Count
    updated: Count
    ignorados: Count
    inalterados: Count
    nao_gravados: ConfirmUnwrittenOut
    pendencias_vinculo: CountMap = Field(default_factory=dict)
    falhas_total: Count
    falhas: list[AssetImportFailureOut] = Field(max_length=100)
    degraded: bool = False
