"""Catálogo de painéis do dashboard e preferências de painel por usuário.

Contrato: `docs/architecture/dashboard-api.md` ("Personalizar painéis").

Por que este módulo existe:
    O CATÁLOGO de painéis e as PERMISSÕES de painel por perfil vivem no
    BACKEND (CLAUDE.md > Arquitetura/Permissões). O frontend nunca decide o
    que um perfil pode ver: ele pede `GET /api/v1/dashboard/panels` e recebe
    apenas os painéis permitidos ao perfil do JWT, com rótulo, tamanhos
    admitidos, o layout padrão do perfil e as preferências salvas.

Regras:
    - O alvo é sempre o usuário do JWT (`user_id` NUNCA vem do cliente).
    - Sem linha em `user_dashboard_preferences`: a leitura devolve o layout
      padrão do perfil (ou o layout legado traduzido, ver abaixo) com
      `version = 0` e NÃO cria linha. O `PUT` com `version = 0` cria a
      primeira linha (versão 1).
    - Controle otimista: `SELECT ... FOR UPDATE` + comparação de `version`;
      divergência (ou inserção concorrente) -> 409.
    - Painel fora do catálogo ou fora dos tamanhos admitidos -> 400 no
      schema (`app.api.v1.dashboard_schemas`). Painel do catálogo NÃO
      permitido ao perfil -> rejeitado (403) E registrado em `audit_logs`
      na MESMA transação (`DASHBOARD_PANEL_FORBIDDEN`, result `FALHA`).
    - Auditoria `DASHBOARD_PREFERENCES_UPDATED` (previous/new) na MESMA
      transação: só IDs de painel, visibilidade, tamanho e versão — nunca
      dado pessoal.
    - Persistência: a lista COMPLETA normalizada quando difere do padrão do
      perfil; `[]` quando igual ao padrão (= "restaurar padrão").
    - Dado legado/inválido no banco (ID desconhecido, tamanho inválido,
      tipo errado, painel que o perfil perdeu) é ignorado e cai no padrão;
      NUNCA gera erro.

Migração das preferências antigas (`user_preferences.dashboard_layout`):
    `LEGACY_PANEL_MAP` traduz os 5 IDs antigos que têm correspondente; os
    outros 10 são DESCARTADOS. A migração Alembic
    `0017_dashboard_panel_prefs` pré-popula as linhas com o mesmo mapa (um
    teste estático compara o SQL com este dicionário); enquanto ela não for
    aplicada, a tradução acontece em tempo de leitura (sem gravar nada), de
    modo que ninguém perde o layout escolhido.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit import AuditLog
from app.models.mixins import utcnow
from app.models.settings import UserDashboardPreferences, UserPreferences

logger = logging.getLogger(__name__)

PANELS_ENTITY_TYPE = "user_dashboard_preferences"
OPERATION_PANELS_UPDATED = "DASHBOARD_PREFERENCES_UPDATED"
OPERATION_PANEL_FORBIDDEN = "DASHBOARD_PANEL_FORBIDDEN"

ROLE_ADM = "ADM"
ROLE_USER = "USER"
ROLE_RH = "RH"

# Tamanhos admitidos (allowlist FECHADA): P = compacto, M = médio, G = largo.
PANEL_SIZES: tuple[str, ...] = ("P", "M", "G")

_ALL_ROLES = frozenset({ROLE_ADM, ROLE_USER, ROLE_RH})
_ADM_USER = frozenset({ROLE_ADM, ROLE_USER})
_ADM_ONLY = frozenset({ROLE_ADM})


@dataclass(frozen=True)
class PanelDefinition:
    """Um painel do catálogo (fonte única de verdade, só no backend)."""

    id: str
    label: str
    description: str
    group: str
    roles: frozenset[str]
    sizes: tuple[str, ...]
    default_size: str
    exportable: bool = False

    def as_dict(self) -> dict[str, Any]:
        """Forma devolvida por `GET /api/v1/dashboard/panels` (sem `roles`)."""
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "group": self.group,
            "sizes": list(self.sizes),
            "default_size": self.default_size,
            "exportable": self.exportable,
        }


# Catálogo FECHADO de painéis, na ordem padrão de exibição. Substitui
# integralmente a allowlist de 15 IDs de `preferences_service`
# (`DEFAULT_DASHBOARD_ORDER`), mantida só para `dashboard_layout` legado.
PANEL_CATALOG: tuple[PanelDefinition, ...] = (
    PanelDefinition(
        id="kpi_workstations",
        label="Postos de trabalho",
        description="Cartões de Computadores, Notebooks e Monitores.",
        group="indicadores",
        roles=_ALL_ROLES,
        sizes=PANEL_SIZES,
        default_size="G",
    ),
    PanelDefinition(
        id="kpi_infrastructure",
        label="Infraestrutura de TI",
        description="Cartões de Impressoras, Nobreaks, Estabilizadores e Docking stations.",
        group="indicadores",
        roles=_ALL_ROLES,
        sizes=PANEL_SIZES,
        default_size="G",
    ),
    PanelDefinition(
        id="kpi_furniture",
        label="Mobiliário",
        description="Cartões de Gaveteiros, Armários, Mesas e Estações de trabalho.",
        group="indicadores",
        roles=_ALL_ROLES,
        sizes=PANEL_SIZES,
        default_size="G",
    ),
    PanelDefinition(
        id="equipment_by_unit_table",
        label="Equipamentos de TI por unidade",
        description="Tabela de unidade x categoria de TI, com exportação CSV/XLSX.",
        group="tabelas",
        roles=_ALL_ROLES,
        sizes=("M", "G"),
        default_size="G",
        exportable=True,
    ),
    PanelDefinition(
        id="furniture_by_unit_table",
        label="Mobiliário por unidade",
        description="Tabela de mobiliário por unidade, com exportação CSV/XLSX.",
        group="tabelas",
        roles=_ALL_ROLES,
        sizes=("M", "G"),
        default_size="G",
        exportable=True,
    ),
    PanelDefinition(
        id="equipment_by_unit_chart",
        label="Equipamentos por unidade (gráfico)",
        description="Barras agrupadas por unidade, respeitando a família selecionada.",
        group="graficos",
        roles=_ALL_ROLES,
        sizes=PANEL_SIZES,
        default_size="G",
    ),
    PanelDefinition(
        id="located_by_unit_chart",
        label="Localização dos bens por unidade (gráfico)",
        description=(
            "Barras agrupadas por unidade: localizados, não localizados e não informados. "
            "O clique numa barra lista os bens."
        ),
        group="graficos",
        roles=_ALL_ROLES,
        sizes=PANEL_SIZES,
        default_size="G",
    ),
    PanelDefinition(
        id="category_distribution",
        label="Distribuição por categoria",
        description="Distribuição percentual por família/categoria de bem.",
        group="graficos",
        roles=_ALL_ROLES,
        sizes=PANEL_SIZES,
        default_size="M",
    ),
    PanelDefinition(
        id="notebooks_without_docking",
        label="Notebooks sem docking station",
        description="Notebooks sem docking station, por unidade.",
        group="operacao",
        roles=_ADM_USER,
        sizes=PANEL_SIZES,
        default_size="M",
    ),
    PanelDefinition(
        id="workstation_ratio",
        label="Monitores por computador/notebook",
        description="Proporção de monitores por computador e por notebook.",
        group="operacao",
        roles=_ADM_USER,
        sizes=PANEL_SIZES,
        default_size="P",
    ),
    PanelDefinition(
        id="unclassified_review",
        label="Pendentes de revisão",
        description="Bens classificados como OUTROS ou BAIXA que precisam de revisão.",
        group="qualidade",
        roles=_ADM_ONLY,
        sizes=("M", "G"),
        default_size="M",
    ),
    PanelDefinition(
        id="classification_overrides",
        label="Correções manuais de categoria",
        description="Últimas correções manuais de categoria feitas por um ADM.",
        group="qualidade",
        roles=_ADM_ONLY,
        sizes=("M", "G"),
        default_size="M",
    ),
    PanelDefinition(
        id="sync_status",
        label="Status da sincronização",
        description="Última sincronização do Google Sheets e divergências encontradas.",
        group="qualidade",
        roles=_ADM_ONLY,
        sizes=PANEL_SIZES,
        default_size="P",
    ),
)

PANEL_IDS: tuple[str, ...] = tuple(panel.id for panel in PANEL_CATALOG)
PANELS_BY_ID: Mapping[str, PanelDefinition] = {panel.id: panel for panel in PANEL_CATALOG}
MAX_PANELS = len(PANEL_CATALOG)

# Tradução dos IDs antigos de `user_preferences.dashboard_layout`. Os demais
# 10 IDs antigos (status, monthly, location, bond, pending, rooms, inventory,
# tech_status, tech_no_owner, tech_age) são DESCARTADOS de propósito: os
# painéis correspondentes não existem mais no catálogo.
LEGACY_PANEL_MAP: Mapping[str, str] = {
    "kpis": "kpi_workstations",
    "units": "equipment_by_unit_chart",
    "tech_summary": "kpi_infrastructure",
    "tech_category": "category_distribution",
    "tech_units": "equipment_by_unit_table",
}


class DashboardPanelsError(Exception):
    """Erro de contrato das preferências de painel (status/código estáveis)."""

    status_code = 400
    code = "invalid_request"
    message = "Requisição inválida."


class PanelPreferencesVersionConflictError(DashboardPanelsError):
    status_code = 409
    code = "version_conflict"
    message = "Os painéis foram alterados em outra sessão. Recarregue e tente novamente."


class PanelForbiddenError(DashboardPanelsError):
    """Painel do catálogo não permitido ao perfil do usuário (auditado)."""

    status_code = 403
    code = "panel_forbidden"
    message = "Painel não disponível para o seu perfil."


# ---------------------------------------------------------------------------
# Catálogo por perfil e layout padrão
# ---------------------------------------------------------------------------


def _role_set(roles: Iterable[str] | None) -> frozenset[str]:
    """Só papéis conhecidos; qualquer outra coisa é ignorada (negar por padrão)."""
    if not roles:
        return frozenset()
    return frozenset(r for r in roles if isinstance(r, str) and r in _ALL_ROLES)


def allowed_panels(roles: Iterable[str] | None) -> tuple[PanelDefinition, ...]:
    """Painéis permitidos ao conjunto de papéis (união), na ordem do catálogo."""
    codes = _role_set(roles)
    if not codes:
        return ()
    return tuple(panel for panel in PANEL_CATALOG if panel.roles & codes)


def allowed_panel_ids(roles: Iterable[str] | None) -> tuple[str, ...]:
    return tuple(panel.id for panel in allowed_panels(roles))


def default_layout(roles: Iterable[str] | None) -> list[dict[str, Any]]:
    """Layout padrão do perfil: todos os painéis permitidos, visíveis, tamanho padrão."""
    return [
        {"id": panel.id, "visible": True, "size": panel.default_size}
        for panel in allowed_panels(roles)
    ]


def catalog_view(roles: Iterable[str] | None) -> dict[str, Any]:
    """Catálogo + tamanhos + layout padrão do perfil (sem as preferências)."""
    return {
        "panels": [panel.as_dict() for panel in allowed_panels(roles)],
        "sizes": list(PANEL_SIZES),
        "default_layout": default_layout(roles),
    }


# ---------------------------------------------------------------------------
# Normalização (tolerante a dado legado/inválido)
# ---------------------------------------------------------------------------


def _entry(panel: PanelDefinition, *, visible: bool, size: str | None) -> dict[str, Any]:
    return {
        "id": panel.id,
        "visible": bool(visible),
        "size": size if size in panel.sizes else panel.default_size,
    }


def _valid_entries(raw: Any, allowed: Mapping[str, PanelDefinition]) -> list[dict[str, Any]]:
    """Entradas válidas de uma lista persistida, sem repetição, na ordem recebida."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        panel_id = item.get("id")
        if not isinstance(panel_id, str) or panel_id in seen:
            continue
        panel = allowed.get(panel_id)
        if panel is None:  # fora do catálogo ou não permitido ao perfil
            continue
        visible = item.get("visible")
        size = item.get("size")
        out.append(
            _entry(
                panel,
                visible=visible if isinstance(visible, bool) else True,
                size=size if isinstance(size, str) else None,
            )
        )
        seen.add(panel_id)
    return out


def _complete(entries: list[dict[str, Any]], allowed: tuple[PanelDefinition, ...]) -> list[dict[str, Any]]:
    """Completa com os painéis ausentes (visíveis, tamanho padrão) na ordem do catálogo."""
    present = {entry["id"] for entry in entries}
    return entries + [
        {"id": panel.id, "visible": True, "size": panel.default_size}
        for panel in allowed
        if panel.id not in present
    ]


def _ensure_one_visible(
    entries: list[dict[str, Any]], roles: Iterable[str] | None
) -> list[dict[str, Any]]:
    """Nenhum painel visível é estado inválido -> volta ao padrão do perfil."""
    if entries and not any(entry["visible"] for entry in entries):
        return default_layout(roles)
    return entries


def panels_from_legacy_layout(raw: Any, roles: Iterable[str] | None) -> list[dict[str, Any]] | None:
    """Traduz `user_preferences.dashboard_layout` pelo `LEGACY_PANEL_MAP`.

    Devolve `None` quando não há informação legada aproveitável (nunca erro).
    IDs antigos sem correspondente são DESCARTADOS em silêncio.
    """
    if not isinstance(raw, dict):
        return None
    allowed = allowed_panels(roles)
    by_id = {panel.id: panel for panel in allowed}

    def _mapped(key: str) -> list[str]:
        value = raw.get(key)
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            new_id = LEGACY_PANEL_MAP.get(item)
            if new_id is not None and new_id in by_id and new_id not in out:
                out.append(new_id)
        return out

    order = _mapped("order")
    hidden = set(_mapped("hidden"))
    if not order and not hidden:
        return None
    entries = [_entry(by_id[pid], visible=pid not in hidden, size=None) for pid in order]
    present = {entry["id"] for entry in entries}
    entries += [
        _entry(panel, visible=panel.id not in hidden, size=None)
        for panel in allowed
        if panel.id not in present
    ]
    return _ensure_one_visible(entries, roles)


def resolve_panels(
    stored_raw: Any, legacy_layout_raw: Any, roles: Iterable[str] | None
) -> list[dict[str, Any]]:
    """Layout efetivo: preferência salva -> layout legado traduzido -> padrão."""
    allowed = allowed_panels(roles)
    if not allowed:
        return []
    by_id = {panel.id: panel for panel in allowed}
    entries = _valid_entries(stored_raw, by_id)
    if entries:
        return _ensure_one_visible(_complete(entries, allowed), roles)
    legacy = panels_from_legacy_layout(legacy_layout_raw, roles)
    if legacy:
        return legacy
    return default_layout(roles)


def _compact(entries: list[dict[str, Any]], roles: Iterable[str] | None) -> list[dict[str, Any]]:
    """Forma persistida: lista completa normalizada, ou `[]` quando = padrão."""
    return [] if entries == default_layout(roles) else entries


# ---------------------------------------------------------------------------
# Serviço
# ---------------------------------------------------------------------------


class DashboardPanelsService:
    """Leitura e escrita das preferências de painel do PRÓPRIO usuário."""

    def __init__(self, db: Session, *, request_id: str | None = None) -> None:
        self._db = db
        self._request_id = request_id

    # -- leitura ------------------------------------------------------------

    def _load_row(
        self, user_id: uuid.UUID, *, for_update: bool = False
    ) -> UserDashboardPreferences | None:
        stmt = select(UserDashboardPreferences).where(
            UserDashboardPreferences.user_id == user_id
        )
        if for_update:
            stmt = stmt.with_for_update()
        return self._db.execute(stmt).scalars().first()

    def _legacy_layout(self, user_id: uuid.UUID) -> Any:
        row = (
            self._db.execute(select(UserPreferences).where(UserPreferences.user_id == user_id))
            .scalars()
            .first()
        )
        return getattr(row, "dashboard_layout", None) if row is not None else None

    def _snapshot(
        self, row: UserDashboardPreferences | None, user_id: uuid.UUID, roles: Iterable[str] | None
    ) -> dict[str, Any]:
        stored = getattr(row, "panels", None) if row is not None else None
        legacy = self._legacy_layout(user_id) if not _valid_entries(stored, PANELS_BY_ID) else None
        return {
            "panels": resolve_panels(stored, legacy, roles),
            "version": int(row.version) if row is not None else 0,
        }

    def get_preferences(self, user_id: uuid.UUID, roles: Iterable[str] | None) -> dict[str, Any]:
        """Preferências efetivas (sem criar linha)."""
        return self._snapshot(self._load_row(user_id), user_id, roles)

    def view(self, user_id: uuid.UUID, roles: Iterable[str] | None) -> dict[str, Any]:
        """Resposta de `GET /api/v1/dashboard/panels` (catálogo + preferências)."""
        payload = catalog_view(roles)
        payload["preferences"] = self.get_preferences(user_id, roles)
        return payload

    # -- escrita ------------------------------------------------------------

    def update(
        self, user_id: uuid.UUID, roles: Iterable[str] | None, changes: Any
    ) -> dict[str, Any]:
        """Aplica `PUT /api/v1/dashboard/preferences` (ver docstring do módulo)."""
        row = self._load_row(user_id, for_update=True)
        previous = self._snapshot(row, user_id, roles)
        if int(changes.version) != previous["version"]:
            raise PanelPreferencesVersionConflictError()

        if getattr(changes, "restore_default", False):
            entries = default_layout(roles)
        else:
            entries = self._requested_entries(user_id, roles, changes)

        stored = _compact(entries, roles)
        now = utcnow()
        if row is None:
            row = UserDashboardPreferences(user_id=user_id, created_at=now)
            self._db.add(row)
        row.panels = stored
        row.version = previous["version"] + 1
        row.updated_at = now

        new_values = {"panels": entries, "version": int(row.version)}
        self._audit(
            user_id,
            OPERATION_PANELS_UPDATED,
            previous=previous,
            new=new_values,
            result="SUCESSO",
        )
        try:
            self._db.flush()
        except IntegrityError:
            logger.warning("user_dashboard_preferences: conflito ao gravar")
            raise PanelPreferencesVersionConflictError() from None
        return new_values

    def _requested_entries(
        self, user_id: uuid.UUID, roles: Iterable[str] | None, changes: Any
    ) -> list[dict[str, Any]]:
        """Valida os painéis pedidos contra o perfil e normaliza a lista."""
        allowed = allowed_panels(roles)
        by_id = {panel.id: panel for panel in allowed}
        forbidden = sorted(
            {item.id for item in changes.panels if item.id not in by_id}
        )
        if forbidden:
            # Rejeitado E auditado na MESMA transação (o endpoint comita).
            self._audit(
                user_id,
                OPERATION_PANEL_FORBIDDEN,
                previous=None,
                new={"rejected_panels": forbidden, "roles": sorted(_role_set(roles))},
                result="FALHA",
            )
            raise PanelForbiddenError()
        entries = [
            _entry(by_id[item.id], visible=item.visible, size=item.size)
            for item in changes.panels
        ]
        return _ensure_one_visible(_complete(entries, allowed), roles)

    def _audit(
        self,
        user_id: uuid.UUID,
        operation: str,
        *,
        previous: dict[str, Any] | None,
        new: dict[str, Any] | None,
        result: str,
    ) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=user_id,
                entity_type=PANELS_ENTITY_TYPE,
                entity_id=str(user_id),
                operation=operation,
                previous_values=previous,
                new_values=new,
                request_id=self._request_id,
                result=result,
            )
        )
