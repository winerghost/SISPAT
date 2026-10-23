"""Classificação inicial dos bens existentes (`flask classify-assets`).

- DRY-RUN POR PADRÃO: sem `apply=True` nada é gravado (só conta).
- Só bens ativos (`deleted_at IS NULL`) com `asset_category IS NULL`: nunca
  sobrescreve classificação existente (inclusive a manual) e nunca toca em bens
  excluídos. Descrição sem regra => continua nula ("não classificado").
- Processa por descrição DISTINTA (agregada no banco) e atualiza em lotes com
  `UPDATE ... WHERE description IN (...) AND asset_category IS NULL`
  (idempotente: reexecutar não altera o que já foi classificado). Incrementa
  `version` (controle otimista: edições abertas em paralelo recebem 409).
- Resultado só com contagens por categoria/tipo (nenhum dado do bem).
"""
from __future__ import annotations

import uuid
from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import func, update
from sqlalchemy.orm import Session

from app.models.assets import Asset
from app.models.audit import AuditLog
from app.services.asset_classification import classify_description

BATCH = 200
OP_CLASSIFIED = "ASSETS_CLASSIFIED"


@dataclass
class ClassificationReport:
    dry_run: bool
    candidates: int = 0  # bens ativos sem categoria
    classified: int = 0  # bens que a regra classifica (aplicados ou, no dry-run, aplicáveis)
    unmatched: int = 0  # sem regra: continuam nulos
    by_category: Counter = field(default_factory=Counter)
    by_tech_type: Counter = field(default_factory=Counter)


def classify_existing_assets(db: Session, *, apply: bool = False) -> ClassificationReport:
    report = ClassificationReport(dry_run=not apply)
    n_desc = func.count(Asset.id)
    groups = (
        db.query(Asset.description, n_desc)
        .filter(Asset.deleted_at.is_(None), Asset.asset_category.is_(None))
        .group_by(Asset.description)
        .all()
    )
    pending: dict[tuple[str, str | None], list[str]] = {}
    for description, n in groups:
        report.candidates += int(n)
        category, tech_type = classify_description(description)
        if category is None or description is None:
            report.unmatched += int(n)
            continue
        report.classified += int(n)
        report.by_category[category] += int(n)
        if tech_type:
            report.by_tech_type[tech_type] += int(n)
        pending.setdefault((category, tech_type), []).append(description)
    if not apply:
        return report
    updated = 0
    for (category, tech_type), descriptions in sorted(pending.items(), key=lambda kv: str(kv[0])):
        for i in range(0, len(descriptions), BATCH):
            chunk = descriptions[i : i + BATCH]
            result = db.execute(
                update(Asset)
                .where(
                    Asset.deleted_at.is_(None),
                    Asset.asset_category.is_(None),
                    Asset.description.in_(chunk),
                )
                .values(asset_category=category, tech_type=tech_type, version=Asset.version + 1)
                .execution_options(synchronize_session=False)
            )
            updated += int(result.rowcount or 0)
    if updated:
        db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=None,
                entity_type="assets",
                entity_id="classification",
                operation=OP_CLASSIFIED,
                previous_values=None,
                new_values={"updated": updated, "by_category": dict(report.by_category)},
                result="SUCESSO",
            )
        )
    report.classified = updated
    return report


LIST_DESCRIPTION_MAX = 80
LIST_LIMIT_MAX = 1000


def _safe_description(value: str | None) -> str:
    """Descrição para listagem: sem controle, espaços colapsados e truncada."""
    text = " ".join("".join(c if c.isprintable() else " " for c in (value or "")).split())
    if len(text) > LIST_DESCRIPTION_MAX:
        text = text[: LIST_DESCRIPTION_MAX - 1] + "…"
    return text or "(sem descrição)"


def list_unclassified_assets(db: Session, *, limit: int = LIST_LIMIT_MAX) -> list[tuple[str, str]]:
    """SOMENTE LEITURA: `(id, descrição truncada)` dos bens ativos sem categoria
    que NENHUMA regra classifica. Nada é gravado; não expõe patrimônio, notas
    nem responsável."""
    rows = (
        db.query(Asset.id, Asset.description)
        .filter(Asset.deleted_at.is_(None), Asset.asset_category.is_(None))
        .order_by(Asset.description, Asset.id)
        .all()
    )
    result: list[tuple[str, str]] = []
    for asset_id, description in rows:
        if classify_description(description)[0] is None:
            result.append((str(asset_id), _safe_description(description)))
            if len(result) >= limit:
                break
    return result
