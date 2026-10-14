"""Modelos de inventários (conferências físicas de bens) e seus itens.

Tabelas: inventories, inventory_items.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class Inventory(Base):
    """Campanha de inventário (conferência física) de bens de uma unidade."""

    __tablename__ = "inventories"
    __table_args__ = (
        CheckConstraint(
            "status IN ('ABERTO','EM_ANDAMENTO','CONCLUIDO','CANCELADO')",
            name="ck_inventories_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'ABERTO'"))
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    unit: Mapped["Unit"] = relationship(foreign_keys=[unit_id])
    created_by_user: Mapped["User"] = relationship(foreign_keys=[created_by])
    items: Mapped[list["InventoryItem"]] = relationship(
        back_populates="inventory", cascade="all, delete-orphan"
    )


class InventoryItem(Base):
    """Item conferido dentro de um inventário.

    Política atual: cada bem é conferido no máximo uma vez por inventário
    (`unique(inventory_id, asset_id)`). Caso o processo evolua para permitir
    múltiplas conferências do mesmo bem no mesmo inventário (ex.: recontagem
    por divergência), esta `UniqueConstraint` deve ser removida/revista aqui
    e em uma migração Alembic própria — não a remova silenciosamente.
    """

    __tablename__ = "inventory_items"
    __table_args__ = (
        UniqueConstraint("inventory_id", "asset_id", name="uq_inventory_items_inventory_asset"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    inventory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("inventories.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    found: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    observed_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id", ondelete="SET NULL"), nullable=True
    )
    checked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    inventory: Mapped["Inventory"] = relationship(back_populates="items")
    asset: Mapped["Asset"] = relationship(foreign_keys=[asset_id])
    observed_location: Mapped["Location | None"] = relationship(foreign_keys=[observed_location_id])
    checked_by_user: Mapped["User | None"] = relationship(foreign_keys=[checked_by])
