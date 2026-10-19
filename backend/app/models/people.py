"""Modelo de pessoa responsável institucional por bens patrimoniais.

Tabela: responsible_people.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base
from app.models.mixins import TimestampMixin


class ResponsiblePerson(TimestampMixin, Base):
    """Pessoa física responsável institucional por um ou mais bens patrimoniais."""

    __tablename__ = "responsible_people"
    __table_args__ = (
        CheckConstraint(
            "char_length(name) BETWEEN 1 AND 200 AND name = trim(name)",
            name="ck_responsible_people_name_trimmed",
        ),
        CheckConstraint(
            "source_record_id IS NULL OR char_length(source_record_id) BETWEEN 1 AND 64",
            name="ck_responsible_people_source_record_id_length",
        ),
        CheckConstraint(
            "phone IS NULL OR phone ~ '^[0-9]{10,13}$'",
            name="ck_responsible_people_phone_format",
        ).ddl_if(dialect="postgresql"),
        Index(
            "uq_responsible_people_email_lower", func.lower(func.trim(text("email"))), unique=True,
            postgresql_where=text("email IS NOT NULL"),
        ),
        Index(
            "uq_responsible_people_source_record_id", "source_record_id", unique=True,
            postgresql_where=text("source_record_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    institutional_identifier: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    email: Mapped[str | None] = mapped_column(Text, nullable=True)
    # DADO PESSOAL (LGPD): somente ADM le/escreve (imposto no backend).
    phone: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_record_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    unit: Mapped["Unit"] = relationship(back_populates="responsible_people")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ResponsiblePerson name={self.name!r}>"
