"""Expurgo de prévias de importação antigas (`import_previews` + itens).

Prévias são dados TRANSITÓRIOS de revisão (cada uma copia milhares de linhas
da planilha em `import_preview_items`). Depois de confirmadas, expiradas ou
falhas elas não têm mais uso e só ocupam espaço. A trilha permanente da
importação continua em `raw_import_records` (IDs/valores originais do Google
Sheets), `sync_jobs` e `audit_logs` — que este módulo NUNCA toca.

Critério (com `cutoff = agora - older_than_days`):
    - status final (`EXPIRADA`, `CONFIRMADA`, `FALHOU`; ver
      `ck_import_previews_status`) criada antes do corte; OU
    - qualquer status com `expires_at` anterior ao corte (expirada há mais de
      N dias — ex.: `CONCLUIDA` nunca confirmada, `PROCESSANDO` travada).
Prévias em revisão (`CONCLUIDA`/`PROCESSANDO` ainda não expiradas, ou
expiradas há menos de N dias) são preservadas.

Tudo numa transação: itens e prévias são apagados juntos (os itens também
cairiam por `ON DELETE CASCADE`; o DELETE explícito permite contá-los e não
depende do suporte a FK do banco de teste) e um único registro
`IMPORT_PREVIEWS_PURGED` vai para `audit_logs` só com contagens/parâmetros.
`dry_run` apenas conta, sem gravar nada.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.orm import Session

from app.models.audit import AuditLog
from app.models.imports import ImportPreview, ImportPreviewItem
from app.models.mixins import utcnow

FINAL_PREVIEW_STATUSES: tuple[str, ...] = ("EXPIRADA", "CONFIRMADA", "FALHOU")
DEFAULT_OLDER_THAN_DAYS = 7
MIN_OLDER_THAN_DAYS = 1
MAX_OLDER_THAN_DAYS = 365
OPERATION_PURGED = "IMPORT_PREVIEWS_PURGED"
ENTITY_TYPE = "import_previews"


@dataclass(frozen=True)
class PurgeResult:
    previews: int
    items: int
    cutoff: datetime
    older_than_days: int
    dry_run: bool


def _validate_days(older_than_days: int) -> int:
    if isinstance(older_than_days, bool) or not isinstance(older_than_days, int):
        raise ValueError("older_than_days deve ser inteiro")
    if not MIN_OLDER_THAN_DAYS <= older_than_days <= MAX_OLDER_THAN_DAYS:
        raise ValueError(
            f"older_than_days deve estar entre {MIN_OLDER_THAN_DAYS} e {MAX_OLDER_THAN_DAYS}"
        )
    return older_than_days


def _purgeable(cutoff: datetime):
    return or_(
        and_(ImportPreview.status.in_(FINAL_PREVIEW_STATUSES), ImportPreview.created_at < cutoff),
        ImportPreview.expires_at < cutoff,
    )


def purge_import_previews(
    db: Session,
    *,
    older_than_days: int = DEFAULT_OLDER_THAN_DAYS,
    dry_run: bool = False,
    now: datetime | None = None,
) -> PurgeResult:
    """Conta (e, se não `dry_run`, apaga) as prévias elegíveis. Não faz commit."""
    days = _validate_days(older_than_days)
    cutoff = (now or utcnow()) - timedelta(days=days)
    preview_ids = select(ImportPreview.id).where(_purgeable(cutoff))

    previews = int(db.execute(select(func.count()).select_from(preview_ids.subquery())).scalar_one())
    items = int(
        db.execute(
            select(func.count(ImportPreviewItem.id)).where(ImportPreviewItem.preview_id.in_(preview_ids))
        ).scalar_one()
    )
    result = PurgeResult(
        previews=previews, items=items, cutoff=cutoff, older_than_days=days, dry_run=dry_run
    )
    if dry_run:
        return result

    if previews:
        # Contagens finais vêm do rowcount dos DELETEs (SEC-1021-03): com
        # execução concorrente a auditoria reflete o que foi de fato apagado.
        items = int(
            db.execute(
                delete(ImportPreviewItem)
                .where(ImportPreviewItem.preview_id.in_(preview_ids))
                .execution_options(synchronize_session=False)
            ).rowcount
            or 0
        )
        previews = int(
            db.execute(
                delete(ImportPreview)
                .where(_purgeable(cutoff))
                .execution_options(synchronize_session=False)
            ).rowcount
            or 0
        )
        result = PurgeResult(
            previews=previews, items=items, cutoff=cutoff, older_than_days=days, dry_run=False
        )
    db.add(
        AuditLog(
            id=uuid.uuid4(),
            actor_user_id=None,  # tarefa operacional (CLI), sem usuário da aplicação
            entity_type=ENTITY_TYPE,
            entity_id=None,
            operation=OPERATION_PURGED,
            previous_values=None,
            new_values={
                "previews_deleted": previews,
                "items_deleted": items,
                "older_than_days": days,
                "cutoff": cutoff.isoformat(),
                "final_statuses": list(FINAL_PREVIEW_STATUSES),
                "origin": "cli",
            },
            result="SUCESSO",
        )
    )
    db.flush()
    return result
