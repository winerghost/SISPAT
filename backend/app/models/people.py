"""Modelo de pessoa responsável institucional por bens patrimoniais.

Tabela: responsible_people.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base
from app.models.mixins import TimestampMixin


class ResponsiblePerson(TimestampMixin, Base):
    """Pessoa física responsável institucional por um ou mais bens patrimoniais."""

    __tablename__ = "responsible_people"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    institutional_identifier: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    email: Mapped[str | None] = mapped_column(Text, nullable=True)
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    unit: Mapped["Unit"] = relationship(back_populates="responsible_people")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ResponsiblePerson name={self.name!r}>"
