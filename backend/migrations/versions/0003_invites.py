"""convites de cadastro (cadastro exclusivamente por convite)

Cria as tabelas invites e invite_units, usadas pelo fluxo administrativo de
convite de novos usuários. O cadastro público NUNCA é permitido: toda conta
nasce de um convite emitido por um administrador (ADM). O mecanismo de
convite propriamente dito (token, criação do usuário, e-mail, segredo TOTP
de MFA) é inteiramente gerido pelo Supabase Auth -- este banco armazena
apenas o registro local administrativo do convite (quem, para qual
papel/unidades, status), nunca um token ou segredo.

`intended_role_code` aceita exclusivamente 'USER' ou 'RH'. A atribuição do
papel 'ADM' NUNCA ocorre via convite direto; é um processo administrativo
separado e mais restrito, fora do escopo desta migração.

Revision ID: 0003_invites
Revises: 0002_import_previews
Create Date: 2026-10-13

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revisão Alembic, identificadores usados por Alembic.
revision: str = "0003_invites"
down_revision: Union[str, None] = "0002_import_previews"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # invites
    # ------------------------------------------------------------------
    op.create_table(
        "invites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("intended_role_code", sa.Text(), nullable=False),
        sa.Column("justification", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'PENDENTE'")),
        sa.Column(
            "invited_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # Preenchido quando o Supabase Auth cria o usuário convidado; usado
        # para religar este registro ao users.auth_user_id real na ativação.
        sa.Column("invited_auth_user_id", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        # TTL do registro local do convite (ex.: 7 dias); calculado pela
        # aplicação, sem default no banco.
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "revoked_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "intended_role_code IN ('USER','RH')",
            name="ck_invites_intended_role_code",
        ),
        sa.CheckConstraint(
            "status IN ('PENDENTE','ACEITO','EXPIRADO','REVOGADO')",
            name="ck_invites_status",
        ),
        comment=(
            "Registro local administrativo de convites de cadastro. NENHUM "
            "token ou segredo (convite, TOTP/MFA) é armazenado aqui -- isso "
            "é gerido inteiramente pelo Supabase Auth. Cadastro público "
            "NUNCA é permitido; intended_role_code nunca é 'ADM' (processo "
            "administrativo separado, fora do escopo desta tabela)."
        ),
    )
    op.create_index("ix_invites_email", "invites", ["email"])
    op.create_index("ix_invites_status", "invites", ["status"])
    op.create_index("ix_invites_invited_by", "invites", ["invited_by"])
    # Índice único parcial: no máximo um convite PENDENTE por e-mail
    # (case-insensitive).
    op.create_index(
        "uq_invites_pending_email",
        "invites",
        [sa.text("lower(email)")],
        unique=True,
        postgresql_where=sa.text("status = 'PENDENTE'"),
    )

    # ------------------------------------------------------------------
    # invite_units
    # ------------------------------------------------------------------
    op.create_table(
        "invite_units",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "invite_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("invites.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.UniqueConstraint("invite_id", "unit_id", name="uq_invite_units_invite_unit"),
        comment=(
            "Unidades autorizadas em um convite, aplicadas ao usuário real "
            "(via user_unit_access) assim que o convite for aceito."
        ),
    )
    op.create_index("ix_invite_units_invite_id", "invite_units", ["invite_id"])
    op.create_index("ix_invite_units_unit_id", "invite_units", ["unit_id"])


def downgrade() -> None:
    # Ordem inversa à criação, respeitando dependências de FK.
    op.drop_index("ix_invite_units_unit_id", table_name="invite_units")
    op.drop_index("ix_invite_units_invite_id", table_name="invite_units")
    op.drop_table("invite_units")

    op.drop_index("uq_invites_pending_email", table_name="invites")
    op.drop_index("ix_invites_invited_by", table_name="invites")
    op.drop_index("ix_invites_status", table_name="invites")
    op.drop_index("ix_invites_email", table_name="invites")
    op.drop_table("invites")
