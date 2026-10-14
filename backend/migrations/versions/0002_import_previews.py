"""pré-visualização de importação de dados (Google Sheets)

Cria as tabelas import_previews e import_preview_items, usadas pelos botões
"Pré-visualizar Importação" e "Confirmar Importação" do módulo
Administração -> Importação de Dados -> Google Sheets. A pré-visualização
nunca grava em `assets`; serve apenas para mostrar o que seria importado
antes de uma confirmação explícita do usuário.

Revision ID: 0002_import_previews
Revises: 0001_initial_schema
Create Date: 2026-10-13

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revisão Alembic, identificadores usados por Alembic.
revision: str = "0002_import_previews"
down_revision: Union[str, None] = "0001_initial_schema"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # import_previews
    # ------------------------------------------------------------------
    op.create_table(
        "import_previews",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "requested_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("source", sa.Text(), nullable=False, server_default=sa.text("'google_sheets'")),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'CONCLUIDA'")),
        sa.Column("total_rows", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("count_novo", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("count_existente", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("count_duplicado", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("count_invalido", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("count_conflitante", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        # Calculado pela aplicação (ex.: created_at + 1h); sem default no banco.
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "confirmed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "status IN ('PROCESSANDO','CONCLUIDA','FALHOU','EXPIRADA','CONFIRMADA')",
            name="ck_import_previews_status",
        ),
        comment=(
            "Pré-visualizações de importação de dados (ex.: Google Sheets). "
            "Nunca gravam em assets; representam apenas o que seria importado "
            "até uma confirmação explícita do usuário."
        ),
    )
    op.create_index("ix_import_previews_requested_by", "import_previews", ["requested_by"])
    op.create_index("ix_import_previews_confirmed_by", "import_previews", ["confirmed_by"])
    op.create_index("ix_import_previews_status", "import_previews", ["status"])

    # ------------------------------------------------------------------
    # import_preview_items
    # ------------------------------------------------------------------
    op.create_table(
        "import_preview_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "preview_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("import_previews.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_record_id", sa.Text(), nullable=True),
        sa.Column("patrimony_number", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("raw_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("normalized_values", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("classification", sa.Text(), nullable=False),
        sa.Column("validation_errors", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "matched_asset_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("selected", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "classification IN ('NOVO','EXISTENTE','DUPLICADO','INVALIDO','CONFLITANTE')",
            name="ck_import_preview_items_classification",
        ),
        comment=(
            "Linhas individuais de uma pré-visualização de importação, já "
            "classificadas (NOVO/EXISTENTE/DUPLICADO/INVALIDO/CONFLITANTE) "
            "frente aos bens já cadastrados."
        ),
    )
    op.create_index("ix_import_preview_items_preview_id", "import_preview_items", ["preview_id"])
    op.create_index(
        "ix_import_preview_items_matched_asset_id", "import_preview_items", ["matched_asset_id"]
    )
    op.create_index("ix_import_preview_items_classification", "import_preview_items", ["classification"])
    # Índice composto: suporta a listagem paginada de itens de uma prévia
    # filtrada por classificação (caso de uso principal da tela de revisão).
    op.create_index(
        "ix_import_preview_items_preview_classification",
        "import_preview_items",
        ["preview_id", "classification"],
    )


def downgrade() -> None:
    # Ordem inversa à criação, respeitando dependências de FK.
    op.drop_index(
        "ix_import_preview_items_preview_classification", table_name="import_preview_items"
    )
    op.drop_index("ix_import_preview_items_classification", table_name="import_preview_items")
    op.drop_index("ix_import_preview_items_matched_asset_id", table_name="import_preview_items")
    op.drop_index("ix_import_preview_items_preview_id", table_name="import_preview_items")
    op.drop_table("import_preview_items")

    op.drop_index("ix_import_previews_status", table_name="import_previews")
    op.drop_index("ix_import_previews_confirmed_by", table_name="import_previews")
    op.drop_index("ix_import_previews_requested_by", table_name="import_previews")
    op.drop_table("import_previews")
