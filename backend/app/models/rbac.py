"""Modelos de RBAC: usuários, papéis (roles), permissões e seus vínculos.

Tabelas: users, roles, permissions, role_permissions, user_roles.

A autenticação (senha/MFA) é externa (Supabase Auth); `users.auth_user_id`
guarda a referência ao usuário no provedor de autenticação. Nenhuma senha é
armazenada neste banco.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base
from app.models.mixins import TimestampMixin


class User(TimestampMixin, Base):
    """Usuário da aplicação SISPAT-AGU."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_users_version_positive"),
        CheckConstraint(
            "avatar_object_key IS NULL OR char_length(avatar_object_key) BETWEEN 1 AND 200",
            name="ck_users_avatar_object_key_length",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    auth_user_id: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # --- Gestão de usuários (migração 0005_settings_ai_users) ---
    # Controle otimista: incrementado EXPLICITAMENTE pela camada de serviço
    # (comparação `version` do cliente x banco -> 409). Não é `version_id_col`
    # do mapper nesta etapa para não alterar fluxos existentes (invite_service).
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    # JWTs com `iat` anterior a este instante são rejeitados por `require_auth`.
    sessions_revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Chave do objeto no bucket privado `avatars` (nunca uma URL pública).
    avatar_object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deactivated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    role_links: Mapped[list["UserRole"]] = relationship(
        back_populates="user",
        foreign_keys="UserRole.user_id",
        cascade="all, delete-orphan",
    )
    unit_access: Mapped[list["UserUnitAccess"]] = relationship(
        back_populates="user",
        foreign_keys="UserUnitAccess.user_id",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover - apenas debug
        return f"<User id={self.id} email={self.email!r}>"


class Role(TimestampMixin, Base):
    """Papel de acesso (ex.: ADM, USER, RH) atribuível a usuários."""

    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    permission_links: Mapped[list["RolePermission"]] = relationship(
        back_populates="role", cascade="all, delete-orphan"
    )
    user_links: Mapped[list["UserRole"]] = relationship(
        back_populates="role",
        foreign_keys="UserRole.role_id",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Role code={self.code!r}>"


class Permission(TimestampMixin, Base):
    """Permissão granular (ex.: `assets.read`) usada nas checagens de autorização."""

    __tablename__ = "permissions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    resource: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)

    role_links: Mapped[list["RolePermission"]] = relationship(
        back_populates="permission", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Permission code={self.code!r}>"


class RolePermission(Base):
    """Associação N:N entre `roles` e `permissions`."""

    __tablename__ = "role_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "permission_id", name="uq_role_permissions_role_permission"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False
    )
    permission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False
    )

    role: Mapped["Role"] = relationship(back_populates="permission_links")
    permission: Mapped["Permission"] = relationship(back_populates="role_links")


class UserRole(Base):
    """Associação N:N entre `users` e `roles`, com auditoria de atribuição."""

    __tablename__ = "user_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", name="uq_user_roles_user_role"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False
    )
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    assigned_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="role_links", foreign_keys=[user_id])
    role: Mapped["Role"] = relationship(back_populates="user_links", foreign_keys=[role_id])
    assigned_by_user: Mapped["User | None"] = relationship(foreign_keys=[assigned_by])
