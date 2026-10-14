"""Modelos de sincronização com sistemas de origem (importação de dados).

Tabelas: sync_jobs, sync_conflicts, raw_import_records.
Nenhuma destas tabelas é apagada: são histórico permanente de execuções de
sincronização, úteis para auditoria e depuração de divergências de dados.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class SyncJob(Base):
    """Execução de um job de sincronização/importação de dados de origem externa."""

    __tablename__ = "sync_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('EM_EXECUCAO','CONCLUIDO','FALHOU','PARCIAL')",
            name="ck_sync_jobs_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'EM_EXECUCAO'"))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    records_read: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    records_created: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    records_updated: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    records_failed: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    raw_records: Mapped[list["RawImportRecord"]] = relationship(
        back_populates="sync_job", cascade="all, delete-orphan"
    )


class SyncConflict(Base):
    """Conflito detectado entre dados de origem externa e dados já existentes no banco."""

    __tablename__ = "sync_conflicts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('PENDENTE','RESOLVIDO_MANTER_BANCO','RESOLVIDO_USAR_ORIGEM','IGNORADO')",
            name="ck_sync_conflicts_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    asset_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )
    source_record_id: Mapped[str] = mapped_column(Text, nullable=False)
    source_values: Mapped[dict] = mapped_column(JSONB, nullable=False)
    database_values: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'PENDENTE'"))
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    asset: Mapped["Asset | None"] = relationship(foreign_keys=[asset_id])
    resolved_by_user: Mapped["User | None"] = relationship(foreign_keys=[resolved_by])


class RawImportRecord(Base):
    """Linha crua importada de um job de sincronização, antes/depois da normalização."""

    __tablename__ = "raw_import_records"
    __table_args__ = (
        CheckConstraint(
            "import_status IN ('PENDENTE','IMPORTADO','REJEITADO','CONFLITO')",
            name="ck_raw_import_records_import_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    sync_job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sync_jobs.id", ondelete="CASCADE"), nullable=False
    )
    source_record_id: Mapped[str] = mapped_column(Text, nullable=False)
    source_row_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw_values: Mapped[dict] = mapped_column(JSONB, nullable=False)
    normalized_values: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    validation_errors: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    import_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'PENDENTE'"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

    sync_job: Mapped["SyncJob"] = relationship(back_populates="raw_records")
