"""Modelos de convites de cadastro (cadastro exclusivamente por convite).

Tabelas: invites, invite_units.

Contexto e regras importantes:
    - O SISPAT-AGU NUNCA permite cadastro público de usuários. Toda conta é
      criada a partir de um convite emitido por um administrador (`ADM`).
    - O mecanismo de convite em si (token de convite, criação do usuário no
      provedor de autenticação, envio do e-mail) é OFICIAL do Supabase Auth.
      Este banco NÃO armazena nenhum token, segredo ou credencial de
      convite -- apenas o REGISTRO LOCAL administrativo do convite: quem foi
      convidado, por quem, para qual papel e unidades, e o status desse
      convite. O mesmo vale para MFA (TOTP): o segredo TOTP é gerido
      inteiramente pelo Supabase Auth e nunca persiste neste banco.
    - `intended_role_code` aceita exclusivamente `USER` ou `RH`. A atribuição
      do papel `ADM` NUNCA ocorre por este fluxo de convite direto -- é um
      processo administrativo separado, mais restrito (fora do escopo desta
      tabela), destinado a reduzir o risco de escalonamento de privilégio via
      convite.
    - `invited_auth_user_id` é preenchido quando o Supabase cria o usuário
      convidado (resposta da API de convite). Esse identificador é usado,
      no momento da ativação do convite, para religar o registro ao
      `users.auth_user_id` definitivo -- a criação efetiva da linha em
      `users` e a aplicação do papel/unidades acontecem em outra camada
      (fora do escopo deste módulo de modelos).
    - `expires_at` é o TTL do REGISTRO LOCAL do convite (ex.: 7 dias),
      calculado e gravado explicitamente pela aplicação; não há cálculo no
      banco. Expirar o registro local não revoga, por si só, o convite no
      Supabase Auth -- isso é tratado pela camada de autenticação.
    - No máximo um convite com `status = 'PENDENTE'` pode existir por e-mail
      (ver índice único parcial `uq_invites_pending_email`), evitando
      convites duplicados simultâneos para o mesmo endereço.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class Invite(Base):
    """Registro local de um convite de cadastro (cadastro exclusivamente por convite).

    Representa apenas o lado administrativo do convite -- nunca um token ou
    segredo, que permanecem inteiramente sob gestão do Supabase Auth. Ver
    docstring do módulo para as regras de negócio completas.
    """

    __tablename__ = "invites"
    __table_args__ = (
        CheckConstraint(
            "intended_role_code IN ('USER','RH')",
            name="ck_invites_intended_role_code",
        ),
        CheckConstraint(
            "status IN ('PENDENTE','ACEITO','EXPIRADO','REVOGADO')",
            name="ck_invites_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    email: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Nunca 'ADM': atribuição de ADM é um processo administrativo separado e
    # mais restrito, fora do escopo do fluxo de convite (ver docstring do
    # módulo).
    intended_role_code: Mapped[str] = mapped_column(Text, nullable=False)
    justification: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'PENDENTE'"))
    invited_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    # Preenchido quando o Supabase Auth cria o usuário convidado; usado para
    # religar este registro ao `users.auth_user_id` real na ativação.
    invited_auth_user_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    # TTL do registro local do convite (ex.: 7 dias); calculado pela
    # aplicação e gravado explicitamente, sem default no banco.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # `invited_by`/`revoked_by` são referências de "ator" (ver nota em
    # app/models/__init__.py) e, portanto, unidirecionais (sem back_populates
    # em `User`).
    invited_by_user: Mapped["User"] = relationship(foreign_keys=[invited_by])
    revoked_by_user: Mapped["User | None"] = relationship(foreign_keys=[revoked_by])

    units: Mapped[list["InviteUnit"]] = relationship(
        back_populates="invite", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Invite id={self.id} email={self.email!r} status={self.status!r}>"


class InviteUnit(Base):
    """Unidade autorizada em um convite, aplicada ao usuário real na ativação.

    Lista as unidades (`units`) que serão vinculadas ao usuário (via
    `user_unit_access`) assim que o convite for aceito e o usuário
    efetivamente criado/ativado.
    """

    __tablename__ = "invite_units"
    __table_args__ = (
        UniqueConstraint("invite_id", "unit_id", name="uq_invite_units_invite_unit"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    invite_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invites.id", ondelete="CASCADE"), nullable=False
    )
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )

    invite: Mapped["Invite"] = relationship(back_populates="units")
    # Referência de consulta (não é uma coleção útil de navegação a partir de
    # `Unit` nesta fase), por isso unidirecional.
    unit: Mapped["Unit"] = relationship(foreign_keys=[unit_id])

    def __repr__(self) -> str:  # pragma: no cover
        return f"<InviteUnit invite_id={self.invite_id} unit_id={self.unit_id}>"


Index("ix_invites_email", Invite.__table__.c.email)
Index("ix_invites_status", Invite.__table__.c.status)
Index("ix_invites_invited_by", Invite.__table__.c.invited_by)
# Índice único parcial: no máximo um convite PENDENTE por e-mail
# (case-insensitive). Expresso via `func.lower()` para que o SQLAlchemy
# associe corretamente o índice à tabela `invites`.
Index(
    "uq_invites_pending_email",
    func.lower(Invite.__table__.c.email),
    unique=True,
    postgresql_where=(Invite.__table__.c.status == "PENDENTE"),
)

Index("ix_invite_units_invite_id", InviteUnit.__table__.c.invite_id)
Index("ix_invite_units_unit_id", InviteUnit.__table__.c.unit_id)
