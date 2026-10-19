"""Regras determinísticas de alerta (Etapa 4a): SQL via ORM, parametrizado.

Cada regra recebe um `RuleContext` e devolve uma lista de `AlertItem` (só com
`count > 0`; lista vazia = nada a alertar). Garantias comuns:

    - Escopo de unidade SEMPRE via `apply_unit_scope` (escopo vazio => zero).
    - Só bens ATIVOS (`deleted_at IS NULL`) entram nas contagens.
    - Nenhum texto vindo do banco entra em título/descrição, exceto o tipo de
      movimentação (texto livre importado) em `movement_spike`, que é
      saneado e truncado.
    - Nenhum dado pessoal (nome, e-mail, matrícula) é lido nem devolvido:
      alertas que envolvem responsável são só contagens (vale para RH também).
    - Nada de SQL montado por texto: limites e regex entram como parâmetros.

"Baixas" não existem como conceito no modelo (A8): não há regra de baixa.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable

from sqlalchemy import and_, case, distinct, exists, func, not_, or_

from app.authorization.rbac import apply_unit_scope
from app.config.settings import Settings
from app.models.assets import Asset, AssetMovement
from app.models.inventory import InventoryItem
from app.models.sync import RawImportRecord, SyncConflict

SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_CRITICAL = "critical"

# Movimentações que não representam atividade real sobre o bem.
_INACTIVE_MOVEMENT_STATUSES = ("CANCELADA", "REJEITADA")
_MAX_SPIKE_ITEMS = 20
_MAX_LABEL_LEN = 60


@dataclass(frozen=True)
class AlertItem:
    code: str
    severity: str
    title: str
    description: str
    count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "title": self.title,
            "description": self.description,
            "count": self.count,
        }


@dataclass(frozen=True)
class RuleContext:
    db: Any
    user_id: Any
    now: datetime
    settings: Settings


@dataclass(frozen=True)
class AlertRule:
    code: str
    run: Callable[[RuleContext], list[AlertItem]]


def _active_assets(ctx: RuleContext, *columns: Any):
    """Consulta base: bens ativos no escopo de unidade do usuário."""
    query = ctx.db.query(*columns).select_from(Asset).filter(Asset.deleted_at.is_(None))
    return apply_unit_scope(query, Asset.unit_id, ctx.user_id, ctx.db)


def _count_item(
    count: int | None, *, code: str, severity: str, title: str, description: str
) -> list[AlertItem]:
    total = int(count or 0)
    if total <= 0:
        return []
    return [AlertItem(code, severity, title, description, total)]


def _count_assets(ctx: RuleContext, *conditions: Any) -> int:
    query = _active_assets(ctx, func.count(Asset.id))
    for condition in conditions:
        query = query.filter(condition)
    return query.scalar() or 0


# --- Regras sobre bens -------------------------------------------------------


def unchecked_assets(ctx: RuleContext) -> list[AlertItem]:
    days = ctx.settings.alerts_unchecked_days
    cutoff = ctx.now - timedelta(days=days)
    checked_recently = (
        exists()
        .where(InventoryItem.asset_id == Asset.id, InventoryItem.checked_at >= cutoff)
        .correlate(Asset)
    )
    return _count_item(
        _count_assets(ctx, not_(checked_recently)),
        code="assets_unchecked",
        severity=SEVERITY_WARNING,
        title="Bens sem conferência recente",
        description=f"Bens sem conferência registrada nos últimos {days} dias (ou nunca conferidos).",
    )


def unmoved_assets(ctx: RuleContext) -> list[AlertItem]:
    days = ctx.settings.alerts_no_movement_days
    cutoff = ctx.now - timedelta(days=days)
    moved_recently = (
        exists()
        .where(
            AssetMovement.asset_id == Asset.id,
            AssetMovement.created_at >= cutoff,
            AssetMovement.status.notin_(_INACTIVE_MOVEMENT_STATUSES),
        )
        .correlate(Asset)
    )
    return _count_item(
        _count_assets(ctx, not_(moved_recently)),
        code="assets_no_movement",
        severity=SEVERITY_INFO,
        title="Bens sem movimentação recente",
        description=f"Bens sem nenhuma movimentação nos últimos {days} dias.",
    )


def assets_without_responsible(ctx: RuleContext) -> list[AlertItem]:
    return _count_item(
        _count_assets(
            ctx, Asset.responsible_person_id.is_(None), Asset.assigned_user_id.is_(None)
        ),
        code="assets_no_responsible",
        severity=SEVERITY_WARNING,
        title="Bens sem responsável",
        description="Bens sem responsável nem usuário atribuído.",
    )


def assets_without_location(ctx: RuleContext) -> list[AlertItem]:
    return _count_item(
        _count_assets(ctx, Asset.room_id.is_(None), Asset.location_id.is_(None)),
        code="assets_no_location",
        severity=SEVERITY_WARNING,
        title="Bens sem localização",
        description="Bens sem sala e sem local definidos.",
    )


def duplicate_patrimony(ctx: RuleContext) -> list[AlertItem]:
    """Bens ATIVOS no escopo que compartilham o mesmo número patrimonial.

    `count` = quantidade de bens envolvidos em duplicidade. Duplicatas com
    bens de unidades fora do escopo não são vistas (nem reveladas).
    """
    grouped = (
        _active_assets(ctx, Asset.patrimony_number, func.count(Asset.id).label("n"))
        .group_by(Asset.patrimony_number)
        .having(func.count(Asset.id) > 1)
        .subquery()
    )
    total = ctx.db.query(func.coalesce(func.sum(grouped.c.n), 0)).scalar()
    return _count_item(
        total,
        code="assets_duplicate_patrimony",
        severity=SEVERITY_CRITICAL,
        title="Número patrimonial duplicado",
        description="Bens ativos que compartilham o mesmo número patrimonial.",
    )


def nonstandard_patrimony(ctx: RuleContext) -> list[AlertItem]:
    pattern = ctx.settings.alerts_patrimony_regex
    re.compile(pattern)  # padrão inválido -> exceção -> regra "indisponível"
    return _count_item(
        _count_assets(ctx, not_(Asset.patrimony_number.regexp_match(pattern))),
        code="assets_nonstandard_patrimony",
        severity=SEVERITY_INFO,
        title="Número patrimonial fora do padrão",
        description="Bens cujo número patrimonial não segue o formato configurado.",
    )


# --- Divergências do Google Sheets ------------------------------------------


def pending_sync_conflicts(ctx: RuleContext) -> list[AlertItem]:
    """Conflitos PENDENTES ligados a bens do escopo (sem `asset_id` não há como escopar)."""
    query = (
        ctx.db.query(func.count(distinct(SyncConflict.id)))
        .select_from(SyncConflict)
        .join(Asset, Asset.id == SyncConflict.asset_id)
        .filter(SyncConflict.status == "PENDENTE", Asset.deleted_at.is_(None))
    )
    query = apply_unit_scope(query, Asset.unit_id, ctx.user_id, ctx.db)
    return _count_item(
        query.scalar(),
        code="sync_conflicts_pending",
        severity=SEVERITY_WARNING,
        title="Conflitos de sincronização pendentes",
        description="Divergências entre o Google Sheets e o banco aguardando resolução.",
    )


def conflicting_import_records(ctx: RuleContext) -> list[AlertItem]:
    """Linhas importadas em CONFLITO cujo `source_record_id` casa com bem do escopo."""
    query = (
        ctx.db.query(func.count(distinct(RawImportRecord.id)))
        .select_from(RawImportRecord)
        .join(Asset, Asset.source_record_id == RawImportRecord.source_record_id)
        .filter(RawImportRecord.import_status == "CONFLITO", Asset.deleted_at.is_(None))
    )
    query = apply_unit_scope(query, Asset.unit_id, ctx.user_id, ctx.db)
    return _count_item(
        query.scalar(),
        code="import_records_conflict",
        severity=SEVERITY_WARNING,
        title="Linhas importadas em conflito",
        description="Linhas da importação marcadas como conflito, ligadas a bens da sua unidade.",
    )


# --- Picos de movimentações ---------------------------------------------------


def _safe_label(value: str | None) -> str:
    text_value = "".join(ch for ch in (value or "") if ch.isprintable()).strip()
    return text_value[:_MAX_LABEL_LEN] or "(sem tipo)"


def movement_spikes(ctx: RuleContext) -> list[AlertItem]:
    """Tipo de movimentação cuja semana atual (7 dias) supera média + k·σ da linha de base."""
    weeks = ctx.settings.alerts_spike_baseline_weeks
    sigma = ctx.settings.alerts_spike_sigma
    minimum = ctx.settings.alerts_spike_min_count
    week = timedelta(days=7)

    def bucket(index: int):
        # index 0 = semana atual; 1..weeks = linha de base (mais antigas).
        start = ctx.now - week * (index + 1)
        if index == 0:
            condition = AssetMovement.created_at >= start
        else:
            condition = and_(
                AssetMovement.created_at >= start,
                AssetMovement.created_at < ctx.now - week * index,
            )
        return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)

    columns = [bucket(i) for i in range(weeks + 1)]
    query = (
        ctx.db.query(AssetMovement.movement_type, *columns)
        .select_from(AssetMovement)
        .join(Asset, Asset.id == AssetMovement.asset_id)
        .filter(
            Asset.deleted_at.is_(None),
            AssetMovement.status.notin_(_INACTIVE_MOVEMENT_STATUSES),
            AssetMovement.created_at >= ctx.now - week * (weeks + 1),
        )
    )
    query = apply_unit_scope(query, Asset.unit_id, ctx.user_id, ctx.db)
    rows = query.group_by(AssetMovement.movement_type).all()

    items: list[AlertItem] = []
    for row in rows:
        current = int(row[1] or 0)
        baseline = [int(v or 0) for v in row[2:]]
        mean = sum(baseline) / len(baseline)
        std = math.sqrt(sum((v - mean) ** 2 for v in baseline) / len(baseline))
        if current >= minimum and current > mean + sigma * std:
            label = _safe_label(row[0])
            items.append(
                AlertItem(
                    "movement_spike",
                    SEVERITY_WARNING,
                    f"Pico de movimentações: {label}",
                    (
                        f"{current} movimentações do tipo \"{label}\" nos últimos 7 dias; "
                        f"média anterior de {mean:.1f} por semana."
                    ),
                    current,
                )
            )
    items.sort(key=lambda item: (-item.count, item.title))
    return items[:_MAX_SPIKE_ITEMS]


RULES: tuple[AlertRule, ...] = (
    AlertRule("assets_duplicate_patrimony", duplicate_patrimony),
    AlertRule("assets_unchecked", unchecked_assets),
    AlertRule("assets_no_movement", unmoved_assets),
    AlertRule("assets_no_responsible", assets_without_responsible),
    AlertRule("assets_no_location", assets_without_location),
    AlertRule("assets_nonstandard_patrimony", nonstandard_patrimony),
    AlertRule("sync_conflicts_pending", pending_sync_conflicts),
    AlertRule("import_records_conflict", conflicting_import_records),
    AlertRule("movement_spike", movement_spikes),
)

__all__ = ["AlertItem", "AlertRule", "RULES", "RuleContext"]
