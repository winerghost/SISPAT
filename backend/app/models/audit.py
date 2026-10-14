"""Modelo de log de auditoria (trilha de alterações e ações do sistema).

Tabela: audit_logs. Registro imutável — nunca é apagado nem atualizado após
a inserção (histórico permanente de conformidade).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class AuditLog(Base):
    """Registro de auditoria de uma operação (CRUD, login, exportação, etc.)."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        CheckConstraint("result IN ('SUCESSO','FALHA')", name="ck_audit_logs_result"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    operation: Mapped[str] = mapped_column(Text, nullable=False)
    previous_values: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    new_values: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'SUCESSO'"))

    actor: Mapped["User | None"] = relationship(foreign_keys=[actor_user_id])
