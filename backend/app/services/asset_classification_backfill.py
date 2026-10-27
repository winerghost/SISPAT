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

A classificação família/categoria (motor `classify_equipment`, colunas
`equipment_*`/`classification_*`) tem seu próprio backfill na segunda metade
deste módulo (`classify_existing_equipment`, `flask classify-equipment`), com
as mesmas garantias e respeitando `category_override`.
"""
from __future__ import annotations

import uuid
from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import func, or_, update
from sqlalchemy.orm import Session

from app.models.assets import Asset
from app.models.audit import AuditLog
from app.services.asset_classification import (
    CLASSIFICATION_COLUMNS,
    LOW,
    RULES_VERSION,
    classification_values,
    classify_description,
)

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


# ===========================================================================
# Backfill do motor família/categoria (`flask classify-equipment`)
# ===========================================================================
# - DRY-RUN POR PADRÃO: sem `apply=True` nada é gravado (só conta).
# - Só bens ativos (`deleted_at IS NULL`) e SEM `category_override`: o
#   override do ADM sempre prevalece e esta coluna NUNCA é escrita aqui.
# - Bem sem descrição não é classificado (colunas continuam nulas = "não
#   informado"): nada é inventado.
# - Processa por descrição DISTINTA + classificação atual (agregadas no banco)
#   e atualiza em lotes com `UPDATE ... WHERE description IN (...) AND
#   category_override IS NULL AND <alguma coluna difere do alvo>`: idempotente
#   (a 2ª execução não altera nada) e transacional (uma transação do chamador).
# - Incrementa `version` (controle otimista: edições abertas recebem 409).
# - Resultado só com contagens por família/categoria (nenhum dado do bem).

OP_EQUIPMENT_CLASSIFIED = "ASSETS_EQUIPMENT_CLASSIFIED"


@dataclass
class EquipmentClassificationReport:
    dry_run: bool
    candidates: int = 0  # bens ativos, sem override e com descrição
    updated: int = 0  # bens reclassificados (ou, no dry-run, que mudariam)
    unchanged: int = 0  # já classificados com a mesma regra e versão
    skipped_overridden: int = 0  # bens com `category_override` (intocados)
    skipped_no_description: int = 0  # sem descrição: continuam não classificados
    low_confidence: int = 0  # entre os atualizados, os de confiança BAIXA
    by_family: Counter = field(default_factory=Counter)
    by_category: Counter = field(default_factory=Counter)


_CLASSIFICATION_ATTRS = tuple(getattr(Asset, name) for name in CLASSIFICATION_COLUMNS)


def classify_existing_equipment(
    db: Session, *, apply: bool = False
) -> EquipmentClassificationReport:
    """Classifica/reclassifica os bens ativos pelo motor família/categoria."""
    report = EquipmentClassificationReport(dry_run=not apply)
    report.skipped_overridden = int(
        db.query(func.count(Asset.id))
        .filter(Asset.deleted_at.is_(None), Asset.category_override.is_not(None))
        .scalar()
        or 0
    )
    groups = (
        db.query(Asset.description, *_CLASSIFICATION_ATTRS, func.count(Asset.id))
        .filter(Asset.deleted_at.is_(None), Asset.category_override.is_(None))
        .group_by(Asset.description, *_CLASSIFICATION_ATTRS)
        .all()
    )
    pending: dict[tuple[str, ...], list[str]] = {}
    for row in groups:
        description, current, count = row[0], tuple(row[1:-1]), int(row[-1])
        if not (description and description.strip()):
            report.skipped_no_description += count
            continue
        report.candidates += count
        values = classification_values(description)
        target = tuple(values[name] for name in CLASSIFICATION_COLUMNS)
        if target == current:
            report.unchanged += count
            continue
        report.updated += count
        report.by_family[values["equipment_family"]] += count
        report.by_category[values["equipment_category"]] += count
        if values["classification_confidence"] == LOW:
            report.low_confidence += count
        pending.setdefault(target, []).append(description)
    if not apply:
        return report
    updated = 0
    for target, descriptions in sorted(pending.items()):
        # A mesma descrição pode vir em mais de um grupo (estados atuais
        # diferentes) com o MESMO alvo: basta atualizá-la uma vez.
        descriptions = sorted(set(descriptions))
        values = dict(zip(CLASSIFICATION_COLUMNS, target))
        differs = or_(
            *(getattr(Asset, name).is_distinct_from(value) for name, value in values.items())
        )
        for start in range(0, len(descriptions), BATCH):
            chunk = descriptions[start : start + BATCH]
            result = db.execute(
                update(Asset)
                .where(
                    Asset.deleted_at.is_(None),
                    Asset.category_override.is_(None),
                    Asset.description.in_(chunk),
                    differs,
                )
                .values(**values, version=Asset.version + 1)
                .execution_options(synchronize_session=False)
            )
            updated += int(result.rowcount or 0)
    if updated:
        db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=None,
                entity_type="assets",
                entity_id="equipment_classification",
                operation=OP_EQUIPMENT_CLASSIFIED,
                previous_values=None,
                new_values={
                    "updated": updated,
                    "rules_version": RULES_VERSION,
                    "by_family": dict(report.by_family),
                },
                result="SUCESSO",
            )
        )
    report.updated = updated
    return report


def list_low_confidence_equipment(
    db: Session, *, limit: int = LIST_LIMIT_MAX
) -> list[tuple[str, str]]:
    """SOMENTE LEITURA: `(id, descrição truncada)` dos bens ativos cuja
    classificação ficou com confiança BAIXA (revisão manual do ADM). Nada é
    gravado; não expõe patrimônio, notas nem responsável."""
    rows = (
        db.query(Asset.id, Asset.description)
        .filter(
            Asset.deleted_at.is_(None),
            Asset.category_override.is_(None),
            Asset.classification_confidence == LOW,
        )
        .order_by(Asset.description, Asset.id)
        .limit(max(1, min(limit, LIST_LIMIT_MAX)))
        .all()
    )
    return [(str(asset_id), _safe_description(description)) for asset_id, description in rows]
