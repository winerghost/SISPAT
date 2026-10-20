"""Preferências de aparência do PRÓPRIO usuário (`user_preferences`).

Contrato: `docs/architecture/modulo-configuracoes.md` (Etapa 3).

Regras:
    - O alvo é sempre o usuário do JWT (`user_id` nunca vem do cliente).
    - Sem linha: `get_view` devolve os padrões (`comfortable`/100/`version=0`)
      e NÃO cria linha. O PATCH com `version=0` cria a primeira (versão 1).
    - Concorrência: `SELECT ... FOR UPDATE` + comparação de `version`;
      inserção concorrente da primeira linha -> IntegrityError -> 409.
    - Auditoria `USER_PREFERENCES_UPDATED` (previous/new) na MESMA transação;
      só densidade, escala, tipos de gráfico (allowlist) e versão (sem dados
      pessoais).
    - `dashboard_charts`: persiste só chaves não padrão; a resposta traz
      sempre as 3 chaves resolvidas.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit import AuditLog
from app.models.mixins import utcnow
from app.models.settings import UserPreferences

logger = logging.getLogger(__name__)

PREFERENCES_ENTITY_TYPE = "user_preferences"
OPERATION_PREFERENCES_UPDATED = "USER_PREFERENCES_UPDATED"

DEFAULT_DENSITY = "comfortable"
DEFAULT_FONT_SCALE = 100


class PreferencesVersionConflictError(Exception):
    status_code = 409
    code = "version_conflict"
    message = "As preferências foram alteradas em outra sessão. Recarregue e tente novamente."


# Allowlist FECHADA por painel do dashboard; o primeiro item é o padrão.
DASHBOARD_CHART_OPTIONS: dict[str, tuple[str, ...]] = {
    "units": ("grouped", "stacked", "horizontal"),
    "status": ("pie", "donut", "bar"),
    "monthly": ("line", "area", "bar"),
}
DEFAULT_DASHBOARD_CHARTS: dict[str, str] = {
    panel: options[0] for panel, options in DASHBOARD_CHART_OPTIONS.items()
}


def _stored_charts(row: UserPreferences | None) -> dict[str, str]:
    """Só chaves/valores válidos e não padrão (defesa contra dado legado)."""
    raw = row.dashboard_charts if row is not None else None
    if not isinstance(raw, dict):
        return {}
    return {
        panel: value
        for panel, value in raw.items()
        if panel in DASHBOARD_CHART_OPTIONS
        and value in DASHBOARD_CHART_OPTIONS[panel]
        and value != DEFAULT_DASHBOARD_CHARTS[panel]
    }


def _resolved_charts(stored: dict[str, str]) -> dict[str, str]:
    return {**DEFAULT_DASHBOARD_CHARTS, **stored}


def _snapshot(row: UserPreferences | None) -> dict[str, Any]:
    if row is None:
        return {
            "density": DEFAULT_DENSITY,
            "font_scale": DEFAULT_FONT_SCALE,
            "dashboard_charts": dict(DEFAULT_DASHBOARD_CHARTS),
            "version": 0,
        }
    return {
        "density": row.density,
        "font_scale": int(row.font_scale),
        "dashboard_charts": _resolved_charts(_stored_charts(row)),
        "version": int(row.version),
    }


class PreferencesService:
    def __init__(self, db: Session, *, request_id: str | None = None) -> None:
        self._db = db
        self._request_id = request_id

    def _load_row(self, user_id: uuid.UUID, *, for_update: bool = False) -> UserPreferences | None:
        stmt = select(UserPreferences).where(UserPreferences.user_id == user_id)
        if for_update:
            stmt = stmt.with_for_update()
        return self._db.execute(stmt).scalars().first()

    def get_view(self, user_id: uuid.UUID) -> dict[str, Any]:
        return _snapshot(self._load_row(user_id))

    def update(self, user_id: uuid.UUID, changes: Any) -> dict[str, Any]:
        row = self._load_row(user_id, for_update=True)
        previous = _snapshot(row)
        if int(changes.version) != previous["version"]:
            raise PreferencesVersionConflictError()

        density = changes.density if changes.density is not None else previous["density"]
        font_scale = changes.font_scale if changes.font_scale is not None else previous["font_scale"]

        stored = _stored_charts(row)
        patch = changes.dashboard_charts
        if patch is not None:
            for panel in patch.model_fields_set:
                value = getattr(patch, panel)
                if value is None or value == DEFAULT_DASHBOARD_CHARTS[panel]:
                    stored.pop(panel, None)  # null/padrão -> remove do JSON salvo
                else:
                    stored[panel] = value

        now = utcnow()
        if row is None:
            row = UserPreferences(user_id=user_id, created_at=now)
            self._db.add(row)
        row.density = density
        row.font_scale = int(font_scale)
        row.dashboard_charts = stored
        row.version = previous["version"] + 1
        row.updated_at = now

        new_values = _snapshot(row)
        self._db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=user_id,
                entity_type=PREFERENCES_ENTITY_TYPE,
                entity_id=str(user_id),
                operation=OPERATION_PREFERENCES_UPDATED,
                previous_values=previous,
                new_values=new_values,
                request_id=self._request_id,
                result="SUCESSO",
            )
        )
        try:
            self._db.flush()
        except IntegrityError:
            logger.warning("user_preferences: conflito ao gravar")
            raise PreferencesVersionConflictError() from None
        return new_values
