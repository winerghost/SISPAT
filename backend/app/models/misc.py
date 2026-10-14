"""Modelos auxiliares: filtros salvos e jobs de exportação.

Tabelas: saved_filters, export_jobs.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base
from app.models.mixins import TimestampMixin


class SavedFilter(TimestampMixin, Base):
    """Filtro de busca salvo por um usuário (ex.: filtros de listagem de bens)."""

    __tablename__ = "saved_filters"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    filter_definition: Mapped[dict] = mapped_column(JSONB, nullable=False)

    user: Mapped["User"] = relationship(foreign_keys=[user_id])


class ExportJob(Base):
    """Solicitação de exportação de dados (CSV/XLSX/PDF) gerada por um usuário."""

    __tablename__ = "export_jobs"
    __table_args__ = (
        CheckConstraint("format IN ('CSV','XLSX','PDF')", name="ck_export_jobs_format"),
        CheckConstraint(
            "status IN ('PENDENTE','PROCESSANDO','CONCLUIDO','FALHOU')",
            name="ck_export_jobs_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    format: Mapped[str] = mapped_column(Text, nullable=False)
    filters: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    columns: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'PENDENTE'"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    requested_by_user: Mapped["User"] = relationship(foreign_keys=[requested_by])
