"""Catálogo estático dos relatórios exportáveis (`/api/v1/reports`).

Fonte única de colunas, filtros e ordenações expostos ao frontend e usados pelo
repositório/exportador. Colunas `internal=True` (texto livre/observações) só
existem para ADM e USER: perfil RH não as recebe -- a coluna nem é consultada
(finalidade patrimonial; mesma regra de `assets`/`movements`).

Nenhum dado pessoal além do NOME do responsável pelo bem (já exibido nas telas
de bens) é exportado: sem e-mail, telefone, identificador institucional nem
ids de usuários (autoria).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MAX_EXPORT_ROWS = 10_000  # teto de linhas por arquivo (acima disso: 413, nunca truncar em silêncio)
EXPORT_FORMATS = ("csv", "xlsx")


@dataclass(frozen=True)
class Column:
    key: str
    label: str
    internal: bool = False  # texto livre: oculto para RH


@dataclass(frozen=True)
class ReportDef:
    id: str
    title: str
    description: str
    columns: tuple[Column, ...]
    filters: tuple[dict[str, Any], ...]
    sorts: tuple[str, ...]
    default_sort: str
    supports_deleted: bool  # `include_deleted` (somente ADM)


_BOOL = {"type": "enum", "options": ["true", "false"]}

ASSETS = ReportDef(
    id="assets",
    title="Patrimônios",
    description="Bens patrimoniais visíveis nas suas unidades.",
    columns=(
        Column("patrimony_number", "Nº patrimonial"),
        Column("description", "Descrição"),
        Column("bond_status", "Vínculo"),
        Column("unit_code", "Unidade (código)"),
        Column("unit_name", "Unidade"),
        Column("owner_unit_code", "Unidade proprietária (código)"),
        Column("room", "Sala"),
        Column("location", "Local"),
        Column("responsible", "Responsável"),
        Column("located", "Localizado"),
        Column("registration_date", "Data de cadastro"),
        Column("created_at", "Criado em (UTC)"),
        Column("updated_at", "Atualizado em (UTC)"),
        Column("deleted_at", "Excluído em (UTC)"),
        Column("notes", "Observações", internal=True),
    ),
    filters=(
        {"name": "q", "type": "text", "max_length": 100},
        {"name": "unit_id", "type": "unit"},
        {"name": "owner_unit_id", "type": "unit"},
        {"name": "room_id", "type": "uuid"},
        {"name": "responsible_person_id", "type": "uuid"},
        {"name": "located", "type": "enum", "options": ["SIM", "NAO", "DESCONHECIDO"]},
        {"name": "bond_status", "type": "text", "max_length": 64},
    ),
    sorts=(
        "patrimony_number", "-patrimony_number", "description", "-description",
        "created_at", "-created_at", "updated_at", "-updated_at", "bond_status", "-bond_status",
    ),
    default_sort="patrimony_number",
    supports_deleted=True,
)

MOVEMENTS = ReportDef(
    id="movements",
    title="Movimentações",
    description="Histórico de movimentações de bens com origem ou destino nas suas unidades.",
    columns=(
        Column("patrimony_number", "Nº patrimonial"),
        Column("asset_description", "Descrição do bem"),
        Column("movement_type", "Tipo"),
        Column("status", "Situação"),
        Column("origin_unit", "Unidade de origem"),
        Column("origin_room", "Sala de origem"),
        Column("previous_responsible", "Responsável anterior"),
        Column("destination_unit", "Unidade de destino"),
        Column("destination_room", "Sala de destino"),
        Column("new_responsible", "Novo responsável"),
        Column("created_at", "Solicitada em (UTC)"),
        Column("approved_at", "Decidida em (UTC)"),
        Column("completed_at", "Concluída em (UTC)"),
        Column("reason", "Motivo", internal=True),
    ),
    filters=(
        {"name": "status", "type": "enum",
         "options": ["PENDENTE", "APROVADA", "REJEITADA", "CONCLUIDA", "CANCELADA"]},
        {"name": "movement_type", "type": "enum",
         "options": ["TRANSFERENCIA_UNIDADE", "MUDANCA_SALA", "TROCA_RESPONSAVEL"]},
        {"name": "origin_unit_id", "type": "unit"},
        {"name": "destination_unit_id", "type": "unit"},
        {"name": "created_from", "type": "date"},
        {"name": "created_to", "type": "date"},
    ),
    sorts=("created_at", "-created_at", "status", "-status"),
    default_sort="-created_at",
    supports_deleted=True,
)

INVENTORY_ITEMS = ReportDef(
    id="inventory-items",
    title="Inventários (itens conferidos)",
    description="Itens conferidos nos inventários das suas unidades.",
    columns=(
        Column("inventory_name", "Inventário"),
        Column("inventory_status", "Situação do inventário"),
        Column("unit_code", "Unidade (código)"),
        Column("patrimony_number", "Nº patrimonial"),
        Column("asset_description", "Descrição do bem"),
        Column("result", "Resultado"),
        Column("registered_location", "Local cadastrado"),
        Column("observed_location", "Local observado"),
        Column("checked_at", "Conferido em (UTC)"),
        Column("notes", "Observações", internal=True),
    ),
    filters=(
        {"name": "inventory_id", "type": "inventory"},
        {"name": "unit_id", "type": "unit"},
        {"name": "inventory_status", "type": "enum",
         "options": ["ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"]},
        {"name": "result", "type": "enum", "options": ["ENCONTRADO", "NAO_ENCONTRADO", "DIVERGENTE"]},
        {"name": "checked_from", "type": "date"},
        {"name": "checked_to", "type": "date"},
    ),
    sorts=("checked_at", "-checked_at", "patrimony_number", "-patrimony_number", "result", "-result"),
    default_sort="-checked_at",
    supports_deleted=True,
)

REPORTS: dict[str, ReportDef] = {r.id: r for r in (ASSETS, MOVEMENTS, INVENTORY_ITEMS)}


def visible_columns(report: ReportDef, *, can_view_internal: bool) -> tuple[Column, ...]:
    """Colunas permitidas ao perfil (RH não recebe as `internal`)."""
    return tuple(c for c in report.columns if can_view_internal or not c.internal)
