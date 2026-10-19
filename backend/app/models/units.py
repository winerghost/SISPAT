"""Modelos de unidades organizacionais, salas, locais e acesso por unidade.

Tabelas: units, unit_aliases, user_unit_access, rooms, locations.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
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
from app.models.mixins import TimestampMixin


class Unit(TimestampMixin, Base):
    """Unidade organizacional da AGU (ex.: sede, núcleos/escritórios regionais)."""

    __tablename__ = "units"
    __table_args__ = (
        CheckConstraint(
            "source_record_id IS NULL OR char_length(source_record_id) BETWEEN 1 AND 64",
            name="ck_units_source_record_id_length",
        ),
        Index(
            "uq_units_source_record_id", "source_record_id", unique=True,
            postgresql_where=text("source_record_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    source_record_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    rooms: Mapped[list["Room"]] = relationship(back_populates="unit", cascade="all, delete-orphan")
    locations: Mapped[list["Location"]] = relationship(back_populates="unit", cascade="all, delete-orphan")
    responsible_people: Mapped[list["ResponsiblePerson"]] = relationship(back_populates="unit")
    user_access: Mapped[list["UserUnitAccess"]] = relationship(
        back_populates="unit", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Unit code={self.code!r}>"


class UnitAlias(Base):
    """Sigla de unidade usada na planilha de origem (ex.: `UEA`) -> `units`.

    Unicidade case-insensitive em `lower(alias)`. Somente leitura para o
    fluxo de importação; cadastro por migração/administração.
    """

    __tablename__ = "unit_aliases"
    __table_args__ = (
        CheckConstraint("char_length(alias) BETWEEN 1 AND 32", name="ck_unit_aliases_alias_length"),
        CheckConstraint("alias = trim(alias)", name="ck_unit_aliases_alias_trimmed"),
        Index("uq_unit_aliases_alias_lower", func.lower(text("alias")), unique=True),
        Index("ix_unit_aliases_unit_id", "unit_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    alias: Mapped[str] = mapped_column(Text, nullable=False)
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    unit: Mapped["Unit"] = relationship()


class UserUnitAccess(Base):
    """Vínculo de acesso de um usuário a uma unidade (escopo de autorização).

    Usado pelo backend para restringir, por exemplo, usuários com papel
    `USER`/`RH` a verem apenas dados das unidades às quais têm acesso.
    """

    __tablename__ = "user_unit_access"
    __table_args__ = (
        UniqueConstraint("user_id", "unit_id", name="uq_user_unit_access_user_unit"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="unit_access", foreign_keys=[user_id])
    unit: Mapped["Unit"] = relationship(back_populates="user_access")
    created_by_user: Mapped["User | None"] = relationship(foreign_keys=[created_by])


class Room(TimestampMixin, Base):
    """Sala/ambiente físico dentro de uma unidade."""

    __tablename__ = "rooms"
    __table_args__ = (
        CheckConstraint(
            "char_length(name) BETWEEN 1 AND 200 AND name = trim(name)",
            name="ck_rooms_name_trimmed",
        ),
        CheckConstraint(
            "source_record_id IS NULL OR char_length(source_record_id) BETWEEN 1 AND 64",
            name="ck_rooms_source_record_id_length",
        ),
        Index("uq_rooms_unit_name_lower", "unit_id", func.lower(func.trim(text("name"))), unique=True),
        Index(
            "uq_rooms_source_record_id", "source_record_id", unique=True,
            postgresql_where=text("source_record_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    floor: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_record_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    unit: Mapped["Unit"] = relationship(back_populates="rooms")
    locations: Mapped[list["Location"]] = relationship(back_populates="room")


class Location(TimestampMixin, Base):
    """Local específico de guarda de bens, vinculado a uma unidade e, opcionalmente, a uma sala."""

    __tablename__ = "locations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="CASCADE"), nullable=False
    )
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    unit: Mapped["Unit"] = relationship(back_populates="locations")
    room: Mapped["Room | None"] = relationship(back_populates="locations")
