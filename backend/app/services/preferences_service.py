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
      sempre as 6 chaves resolvidas.
    - `dashboard_layout`: persiste `order` (ordem efetiva completa) e
      `hidden` só quando diferentes do padrão; a resposta traz sempre
      `{"order": [15 IDs na ordem efetiva], "hidden": [...]}`.
    - Dado legado/inválido no banco (chave desconhecida, tipo errado, ID fora
      da allowlist) é ignorado e cai no padrão; nunca gera erro.
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
    "location": ("stacked", "grouped", "horizontal"),
    "bond": ("donut", "pie", "bar"),
    "rooms": ("horizontal", "bar"),
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


# Allowlist FECHADA de painéis, na ordem padrão (espelha `DashboardPanelId`
# em app/api/v1/schemas.py; teste garante a igualdade).
DEFAULT_DASHBOARD_ORDER: tuple[str, ...] = (
    "kpis",
    "units",
    "status",
    "monthly",
    "location",
    "bond",
    "pending",
    "rooms",
    "inventory",
    "tech_summary",
    "tech_category",
    "tech_units",
    "tech_status",
    "tech_no_owner",
    "tech_age",
)


def _valid_panel_ids(raw: Any) -> list[str]:
    """IDs da allowlist, sem repetição, na ordem recebida (tolerante a legado)."""
    if not isinstance(raw, list):
        return []
    seen: list[str] = []
    for item in raw:
        if isinstance(item, str) and item in DEFAULT_DASHBOARD_ORDER and item not in seen:
            seen.append(item)
    return seen


def _effective_order(raw: Any) -> list[str]:
    """Ordem parcial + painéis ausentes ao fim, na ordem padrão."""
    first = _valid_panel_ids(raw)
    return first + [panel for panel in DEFAULT_DASHBOARD_ORDER if panel not in first]


def _normalized_hidden(raw: Any) -> list[str]:
    """Ocultos na ordem padrão; ocultar TODOS é inválido -> nenhum oculto."""
    hidden = set(_valid_panel_ids(raw))
    if len(hidden) >= len(DEFAULT_DASHBOARD_ORDER):
        return []
    return [panel for panel in DEFAULT_DASHBOARD_ORDER if panel in hidden]


def _compact_layout(order: Any, hidden: Any) -> dict[str, list[str]]:
    """Forma persistida: só o que difere do padrão ({} = layout padrão)."""
    stored: dict[str, list[str]] = {}
    effective = _effective_order(order)
    if tuple(effective) != DEFAULT_DASHBOARD_ORDER:
        stored["order"] = effective
    normalized = _normalized_hidden(hidden)
    if normalized:
        stored["hidden"] = normalized
    return stored


def _stored_layout(row: UserPreferences | None) -> dict[str, list[str]]:
    raw = getattr(row, "dashboard_layout", None) if row is not None else None
    if not isinstance(raw, dict):
        return {}
    return _compact_layout(raw.get("order"), raw.get("hidden"))


def _resolved_layout(stored: dict[str, list[str]]) -> dict[str, list[str]]:
    return {
        "order": _effective_order(stored.get("order")),
        "hidden": _normalized_hidden(stored.get("hidden")),
    }


def _snapshot(row: UserPreferences | None) -> dict[str, Any]:
    if row is None:
        return {
            "density": DEFAULT_DENSITY,
            "font_scale": DEFAULT_FONT_SCALE,
            "dashboard_charts": dict(DEFAULT_DASHBOARD_CHARTS),
            "dashboard_layout": _resolved_layout({}),
            "version": 0,
        }
    return {
        "density": row.density,
        "font_scale": int(row.font_scale),
        "dashboard_charts": _resolved_charts(_stored_charts(row)),
        "dashboard_layout": _resolved_layout(_stored_layout(row)),
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

        layout = self._merge_layout(_stored_layout(row), changes)

        now = utcnow()
        if row is None:
            row = UserPreferences(user_id=user_id, created_at=now)
            self._db.add(row)
        row.density = density
        row.font_scale = int(font_scale)
        row.dashboard_charts = stored
        row.dashboard_layout = layout
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

    @staticmethod
    def _merge_layout(stored: dict[str, list[str]], changes: Any) -> dict[str, list[str]]:
        """Ausente = manter; `null` (no todo ou na chave) = padrão."""
        if "dashboard_layout" not in getattr(changes, "model_fields_set", set()):
            return stored
        patch = changes.dashboard_layout
        if patch is None:
            return {}
        order = stored.get("order")
        hidden = stored.get("hidden")
        if "order" in patch.model_fields_set:
            order = patch.order
        if "hidden" in patch.model_fields_set:
            hidden = patch.hidden
        return _compact_layout(order, hidden)
