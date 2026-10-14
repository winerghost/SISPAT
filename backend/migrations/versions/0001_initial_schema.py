"""schema inicial: RBAC, unidades, patrimônio, inventário, auditoria e sincronização

Cria as 20 tabelas da Fase 1 (banco de dados e permissionamento) do
SISPAT-AGU: users, roles, permissions, role_permissions, user_roles, units,
user_unit_access, rooms, locations, responsible_people, assets,
asset_movements, inventories, inventory_items, audit_logs, sync_jobs,
sync_conflicts, saved_filters, export_jobs, raw_import_records.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-10-13

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revisão Alembic, identificadores usados por Alembic.
revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


ASSET_LOCATED_ENUM = postgresql.ENUM(
    "SIM", "NAO", "DESCONHECIDO", name="asset_located_status"
)


def upgrade() -> None:
    bind = op.get_bind()

    # Extensões necessárias: gen_random_uuid() (pgcrypto, redundante em PG >= 13
    # mas mantido por compatibilidade) e pg_trgm (busca textual aproximada).
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    ASSET_LOCATED_ENUM.create(bind, checkfirst=True)

    # ------------------------------------------------------------------
    # roles
    # ------------------------------------------------------------------
    op.create_table(
        "roles",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("code", name="uq_roles_code"),
        comment="Papéis de acesso (ex.: ADM, USER, RH) atribuíveis a usuários.",
    )

    # ------------------------------------------------------------------
    # permissions
    # ------------------------------------------------------------------
    op.create_table(
        "permissions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("resource", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("code", name="uq_permissions_code"),
        comment="Permissões granulares (ex.: assets.read) usadas na autorização.",
    )

    # ------------------------------------------------------------------
    # users
    # ------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("auth_user_id", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("auth_user_id", name="uq_users_auth_user_id"),
        comment="Usuários da aplicação. Autenticação é externa (Supabase Auth); nenhuma senha é armazenada aqui.",
    )

    # ------------------------------------------------------------------
    # role_permissions
    # ------------------------------------------------------------------
    op.create_table(
        "role_permissions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "role_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("roles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "permission_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("permissions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.UniqueConstraint("role_id", "permission_id", name="uq_role_permissions_role_permission"),
        comment="Associação N:N entre roles e permissions.",
    )
    op.create_index("ix_role_permissions_role_id", "role_permissions", ["role_id"])
    op.create_index("ix_role_permissions_permission_id", "role_permissions", ["permission_id"])

    # ------------------------------------------------------------------
    # user_roles
    # ------------------------------------------------------------------
    op.create_table(
        "user_roles",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "role_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("roles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "assigned_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "assigned_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint("user_id", "role_id", name="uq_user_roles_user_role"),
        comment="Associação N:N entre usuários e roles, com auditoria de atribuição.",
    )
    op.create_index("ix_user_roles_user_id", "user_roles", ["user_id"])
    op.create_index("ix_user_roles_role_id", "user_roles", ["role_id"])
    op.create_index("ix_user_roles_assigned_by", "user_roles", ["assigned_by"])

    # ------------------------------------------------------------------
    # units
    # ------------------------------------------------------------------
    op.create_table(
        "units",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("code", name="uq_units_code"),
        comment="Unidades organizacionais da AGU.",
    )

    # ------------------------------------------------------------------
    # user_unit_access
    # ------------------------------------------------------------------
    op.create_table(
        "user_unit_access",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint("user_id", "unit_id", name="uq_user_unit_access_user_unit"),
        comment="Escopo de acesso de um usuário a uma unidade organizacional.",
    )
    op.create_index("ix_user_unit_access_user_id", "user_unit_access", ["user_id"])
    op.create_index("ix_user_unit_access_unit_id", "user_unit_access", ["unit_id"])
    op.create_index("ix_user_unit_access_created_by", "user_unit_access", ["created_by"])

    # ------------------------------------------------------------------
    # rooms
    # ------------------------------------------------------------------
    op.create_table(
        "rooms",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("floor", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        comment="Salas/ambientes físicos dentro de uma unidade.",
    )
    op.create_index("ix_rooms_unit_id", "rooms", ["unit_id"])

    # ------------------------------------------------------------------
    # locations
    # ------------------------------------------------------------------
    op.create_table(
        "locations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        comment="Locais específicos de guarda de bens, dentro de uma unidade e, opcionalmente, de uma sala.",
    )
    op.create_index("ix_locations_unit_id", "locations", ["unit_id"])
    op.create_index("ix_locations_room_id", "locations", ["room_id"])

    # ------------------------------------------------------------------
    # responsible_people
    # ------------------------------------------------------------------
    op.create_table(
        "responsible_people",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("institutional_identifier", sa.Text(), nullable=True),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("institutional_identifier", name="uq_responsible_people_institutional_identifier"),
        comment="Pessoas responsáveis institucionais por bens patrimoniais.",
    )
    op.create_index("ix_responsible_people_unit_id", "responsible_people", ["unit_id"])

    # ------------------------------------------------------------------
    # assets
    # ------------------------------------------------------------------
    op.create_table(
        "assets",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("source_record_id", sa.Text(), nullable=True),
        sa.Column("source_system", sa.Text(), nullable=True),
        # NUNCA numérico/float: pode conter zeros à esquerda, prefixos, etc.
        sa.Column("patrimony_number", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "owner_unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "responsible_person_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("responsible_people.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "assigned_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "location_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("locations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "located",
            ASSET_LOCATED_ENUM,
            nullable=False,
            server_default=sa.text("'DESCONHECIDO'"),
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("registration_date", sa.Date(), nullable=True),
        sa.Column("source_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "deleted_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.CheckConstraint("version >= 1", name="ck_assets_version_positive"),
        comment=(
            "Bens patrimoniais. Exclusão sempre lógica (deleted_at/deleted_by). "
            "version é usado para controle otimista de concorrência."
        ),
    )
    op.create_index("ix_assets_patrimony_number", "assets", ["patrimony_number"])
    op.create_index("ix_assets_unit_id", "assets", ["unit_id"])
    op.create_index("ix_assets_owner_unit_id", "assets", ["owner_unit_id"])
    op.create_index("ix_assets_room_id", "assets", ["room_id"])
    op.create_index("ix_assets_location_id", "assets", ["location_id"])
    op.create_index("ix_assets_responsible_person_id", "assets", ["responsible_person_id"])
    op.create_index("ix_assets_assigned_user_id", "assets", ["assigned_user_id"])
    op.create_index("ix_assets_source_record_id", "assets", ["source_record_id"])
    op.create_index("ix_assets_created_by", "assets", ["created_by"])
    op.create_index("ix_assets_updated_by", "assets", ["updated_by"])
    op.create_index("ix_assets_deleted_by", "assets", ["deleted_by"])
    # Índice parcial: consultas de "bens ativos por unidade" são o caso comum.
    op.create_index(
        "ix_assets_active_unit",
        "assets",
        ["unit_id"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    # Índice GIN trigram para busca textual aproximada em description
    # (requer extensão pg_trgm, criada no início desta migração).
    op.execute(
        "CREATE INDEX ix_assets_description_trgm ON assets "
        "USING gin (description gin_trgm_ops)"
    )

    # ------------------------------------------------------------------
    # asset_movements
    # ------------------------------------------------------------------
    op.create_table(
        "asset_movements",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "asset_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "origin_unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "destination_unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "origin_room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "destination_room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "previous_responsible_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("responsible_people.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "new_responsible_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("responsible_people.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("movement_type", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'PENDENTE'")),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "requested_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "approved_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('PENDENTE','APROVADA','REJEITADA','CONCLUIDA','CANCELADA')",
            name="ck_asset_movements_status",
        ),
        comment="Movimentações (transferências) de bens entre unidades/salas/responsáveis. Histórico, nunca apagado.",
    )
    op.create_index("ix_asset_movements_asset_id", "asset_movements", ["asset_id"])
    op.create_index("ix_asset_movements_origin_unit_id", "asset_movements", ["origin_unit_id"])
    op.create_index("ix_asset_movements_destination_unit_id", "asset_movements", ["destination_unit_id"])
    op.create_index("ix_asset_movements_origin_room_id", "asset_movements", ["origin_room_id"])
    op.create_index("ix_asset_movements_destination_room_id", "asset_movements", ["destination_room_id"])
    op.create_index("ix_asset_movements_previous_responsible_id", "asset_movements", ["previous_responsible_id"])
    op.create_index("ix_asset_movements_new_responsible_id", "asset_movements", ["new_responsible_id"])
    op.create_index("ix_asset_movements_requested_by", "asset_movements", ["requested_by"])
    op.create_index("ix_asset_movements_approved_by", "asset_movements", ["approved_by"])

    # ------------------------------------------------------------------
    # inventories
    # ------------------------------------------------------------------
    op.create_table(
        "inventories",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'ABERTO'")),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('ABERTO','EM_ANDAMENTO','CONCLUIDO','CANCELADO')",
            name="ck_inventories_status",
        ),
        comment="Campanhas de inventário (conferência física) de bens por unidade.",
    )
    op.create_index("ix_inventories_unit_id", "inventories", ["unit_id"])
    op.create_index("ix_inventories_created_by", "inventories", ["created_by"])

    # ------------------------------------------------------------------
    # inventory_items
    # ------------------------------------------------------------------
    op.create_table(
        "inventory_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "inventory_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "asset_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("found", sa.Boolean(), nullable=True),
        sa.Column(
            "observed_location_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("locations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "checked_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.UniqueConstraint("inventory_id", "asset_id", name="uq_inventory_items_inventory_asset"),
        comment=(
            "Itens conferidos em um inventário. Política atual: 1 conferência por "
            "bem por inventário (ver uq_inventory_items_inventory_asset); se o "
            "processo evoluir para permitir múltiplas conferências/recontagens, "
            "esta constraint deve ser revista em migração própria."
        ),
    )
    op.create_index("ix_inventory_items_inventory_id", "inventory_items", ["inventory_id"])
    op.create_index("ix_inventory_items_asset_id", "inventory_items", ["asset_id"])
    op.create_index("ix_inventory_items_observed_location_id", "inventory_items", ["observed_location_id"])
    op.create_index("ix_inventory_items_checked_by", "inventory_items", ["checked_by"])

    # ------------------------------------------------------------------
    # audit_logs
    # ------------------------------------------------------------------
    op.create_table(
        "audit_logs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "actor_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column("entity_id", sa.Text(), nullable=True),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("previous_values", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("new_values", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("result", sa.Text(), nullable=False, server_default=sa.text("'SUCESSO'")),
        sa.CheckConstraint("result IN ('SUCESSO','FALHA')", name="ck_audit_logs_result"),
        comment="Trilha de auditoria imutável. Nunca é apagada ou atualizada após a inserção.",
    )
    op.create_index("ix_audit_logs_actor_user_id", "audit_logs", ["actor_user_id"])
    op.create_index("ix_audit_logs_entity_type", "audit_logs", ["entity_type"])
    op.create_index("ix_audit_logs_entity_id", "audit_logs", ["entity_id"])
    op.create_index("ix_audit_logs_occurred_at", "audit_logs", ["occurred_at"])
    op.create_index("ix_audit_logs_request_id", "audit_logs", ["request_id"])

    # ------------------------------------------------------------------
    # sync_jobs
    # ------------------------------------------------------------------
    op.create_table(
        "sync_jobs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'EM_EXECUCAO'")),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("records_read", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("records_created", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("records_updated", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("records_failed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("error_summary", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('EM_EXECUCAO','CONCLUIDO','FALHOU','PARCIAL')",
            name="ck_sync_jobs_status",
        ),
        comment="Execuções de jobs de sincronização/importação de dados externos. Histórico, nunca apagado.",
    )
    op.create_index("ix_sync_jobs_source", "sync_jobs", ["source"])
    op.create_index("ix_sync_jobs_status", "sync_jobs", ["status"])

    # ------------------------------------------------------------------
    # sync_conflicts
    # ------------------------------------------------------------------
    op.create_table(
        "sync_conflicts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "asset_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("source_record_id", sa.Text(), nullable=False),
        sa.Column("source_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("database_values", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'PENDENTE'")),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "resolved_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "status IN ('PENDENTE','RESOLVIDO_MANTER_BANCO','RESOLVIDO_USAR_ORIGEM','IGNORADO')",
            name="ck_sync_conflicts_status",
        ),
        comment="Conflitos entre dados de origem externa e dados já existentes no banco. Histórico, nunca apagado.",
    )
    op.create_index("ix_sync_conflicts_asset_id", "sync_conflicts", ["asset_id"])
    op.create_index("ix_sync_conflicts_source_record_id", "sync_conflicts", ["source_record_id"])
    op.create_index("ix_sync_conflicts_resolved_by", "sync_conflicts", ["resolved_by"])
    op.create_index("ix_sync_conflicts_status", "sync_conflicts", ["status"])

    # ------------------------------------------------------------------
    # raw_import_records
    # ------------------------------------------------------------------
    op.create_table(
        "raw_import_records",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "sync_job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sync_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_record_id", sa.Text(), nullable=False),
        sa.Column("source_row_number", sa.Integer(), nullable=True),
        sa.Column("raw_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("normalized_values", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("validation_errors", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("import_status", sa.Text(), nullable=False, server_default=sa.text("'PENDENTE'")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "import_status IN ('PENDENTE','IMPORTADO','REJEITADO','CONFLITO')",
            name="ck_raw_import_records_import_status",
        ),
        comment="Linhas cruas importadas por um job de sincronização, antes/depois da normalização. Histórico, nunca apagado.",
    )
    op.create_index("ix_raw_import_records_sync_job_id", "raw_import_records", ["sync_job_id"])
    op.create_index("ix_raw_import_records_source_record_id", "raw_import_records", ["source_record_id"])
    op.create_index("ix_raw_import_records_import_status", "raw_import_records", ["import_status"])

    # ------------------------------------------------------------------
    # saved_filters
    # ------------------------------------------------------------------
    op.create_table(
        "saved_filters",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("filter_definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        comment="Filtros de busca salvos por usuário (ex.: filtros de listagem de bens).",
    )
    op.create_index("ix_saved_filters_user_id", "saved_filters", ["user_id"])

    # ------------------------------------------------------------------
    # export_jobs
    # ------------------------------------------------------------------
    op.create_table(
        "export_jobs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "requested_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("format", sa.Text(), nullable=False),
        sa.Column("filters", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("columns", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'PENDENTE'")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("format IN ('CSV','XLSX','PDF')", name="ck_export_jobs_format"),
        sa.CheckConstraint(
            "status IN ('PENDENTE','PROCESSANDO','CONCLUIDO','FALHOU')",
            name="ck_export_jobs_status",
        ),
        comment="Solicitações de exportação de dados (CSV/XLSX/PDF) geradas por usuários.",
    )
    op.create_index("ix_export_jobs_requested_by", "export_jobs", ["requested_by"])
    op.create_index("ix_export_jobs_status", "export_jobs", ["status"])


def downgrade() -> None:
    # Ordem inversa à criação, respeitando dependências de FK.
    op.drop_index("ix_export_jobs_status", table_name="export_jobs")
    op.drop_index("ix_export_jobs_requested_by", table_name="export_jobs")
    op.drop_table("export_jobs")

    op.drop_index("ix_saved_filters_user_id", table_name="saved_filters")
    op.drop_table("saved_filters")

    op.drop_index("ix_raw_import_records_import_status", table_name="raw_import_records")
    op.drop_index("ix_raw_import_records_source_record_id", table_name="raw_import_records")
    op.drop_index("ix_raw_import_records_sync_job_id", table_name="raw_import_records")
    op.drop_table("raw_import_records")

    op.drop_index("ix_sync_conflicts_status", table_name="sync_conflicts")
    op.drop_index("ix_sync_conflicts_resolved_by", table_name="sync_conflicts")
    op.drop_index("ix_sync_conflicts_source_record_id", table_name="sync_conflicts")
    op.drop_index("ix_sync_conflicts_asset_id", table_name="sync_conflicts")
    op.drop_table("sync_conflicts")

    op.drop_index("ix_sync_jobs_status", table_name="sync_jobs")
    op.drop_index("ix_sync_jobs_source", table_name="sync_jobs")
    op.drop_table("sync_jobs")

    op.drop_index("ix_audit_logs_request_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_occurred_at", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity_type", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor_user_id", table_name="audit_logs")
    op.drop_table("audit_logs")

    op.drop_index("ix_inventory_items_checked_by", table_name="inventory_items")
    op.drop_index("ix_inventory_items_observed_location_id", table_name="inventory_items")
    op.drop_index("ix_inventory_items_asset_id", table_name="inventory_items")
    op.drop_index("ix_inventory_items_inventory_id", table_name="inventory_items")
    op.drop_table("inventory_items")

    op.drop_index("ix_inventories_created_by", table_name="inventories")
    op.drop_index("ix_inventories_unit_id", table_name="inventories")
    op.drop_table("inventories")

    op.drop_index("ix_asset_movements_approved_by", table_name="asset_movements")
    op.drop_index("ix_asset_movements_requested_by", table_name="asset_movements")
    op.drop_index("ix_asset_movements_new_responsible_id", table_name="asset_movements")
    op.drop_index("ix_asset_movements_previous_responsible_id", table_name="asset_movements")
    op.drop_index("ix_asset_movements_destination_room_id", table_name="asset_movements")
    op.drop_index("ix_asset_movements_origin_room_id", table_name="asset_movements")
    op.drop_index("ix_asset_movements_destination_unit_id", table_name="asset_movements")
    op.drop_index("ix_asset_movements_origin_unit_id", table_name="asset_movements")
    op.drop_index("ix_asset_movements_asset_id", table_name="asset_movements")
    op.drop_table("asset_movements")

    op.execute("DROP INDEX IF EXISTS ix_assets_description_trgm")
    op.drop_index("ix_assets_active_unit", table_name="assets")
    op.drop_index("ix_assets_deleted_by", table_name="assets")
    op.drop_index("ix_assets_updated_by", table_name="assets")
    op.drop_index("ix_assets_created_by", table_name="assets")
    op.drop_index("ix_assets_source_record_id", table_name="assets")
    op.drop_index("ix_assets_assigned_user_id", table_name="assets")
    op.drop_index("ix_assets_responsible_person_id", table_name="assets")
    op.drop_index("ix_assets_location_id", table_name="assets")
    op.drop_index("ix_assets_room_id", table_name="assets")
    op.drop_index("ix_assets_owner_unit_id", table_name="assets")
    op.drop_index("ix_assets_unit_id", table_name="assets")
    op.drop_index("ix_assets_patrimony_number", table_name="assets")
    op.drop_table("assets")

    op.drop_index("ix_responsible_people_unit_id", table_name="responsible_people")
    op.drop_table("responsible_people")

    op.drop_index("ix_locations_room_id", table_name="locations")
    op.drop_index("ix_locations_unit_id", table_name="locations")
    op.drop_table("locations")

    op.drop_index("ix_rooms_unit_id", table_name="rooms")
    op.drop_table("rooms")

    op.drop_index("ix_user_unit_access_created_by", table_name="user_unit_access")
    op.drop_index("ix_user_unit_access_unit_id", table_name="user_unit_access")
    op.drop_index("ix_user_unit_access_user_id", table_name="user_unit_access")
    op.drop_table("user_unit_access")

    op.drop_table("units")

    op.drop_index("ix_user_roles_assigned_by", table_name="user_roles")
    op.drop_index("ix_user_roles_role_id", table_name="user_roles")
    op.drop_index("ix_user_roles_user_id", table_name="user_roles")
    op.drop_table("user_roles")

    op.drop_index("ix_role_permissions_permission_id", table_name="role_permissions")
    op.drop_index("ix_role_permissions_role_id", table_name="role_permissions")
    op.drop_table("role_permissions")

    op.drop_table("users")
    op.drop_table("permissions")
    op.drop_table("roles")

    bind = op.get_bind()
    ASSET_LOCATED_ENUM.drop(bind, checkfirst=True)

    # Extensões não são removidas no downgrade (podem ser usadas por outros
    # objetos do banco); isto é intencional.
