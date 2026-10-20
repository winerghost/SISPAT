"""Modelos de bens patrimoniais (assets) e suas movimentações.

Tabelas: assets, asset_movements.

Regras importantes:
    - `assets` nunca é apagado fisicamente: exclusão é sempre lógica, via
      `deleted_at`/`deleted_by` (soft delete).
    - `assets.version` é incrementado pela aplicação a cada atualização e
      usado para controle otimista de concorrência (ex.: evitar que uma
      sincronização externa sobrescreva silenciosamente uma edição manual
      concorrente).
    - `patrimony_number` é sempre `TEXT` — nunca numérico/float — pois pode
      conter zeros à esquerda, prefixos e outros formatos não numéricos.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base
from app.models.mixins import TimestampMixin

# Tipo ENUM nativo do Postgres para a situação de localização física do bem.
asset_located_enum = Enum(
    "SIM",
    "NAO",
    "DESCONHECIDO",
    name="asset_located_status",
    create_constraint=True,
)


class Asset(TimestampMixin, Base):
    """Bem patrimonial.

    `description` possui um índice GIN trigram (`ix_assets_description_trgm`,
    requer a extensão `pg_trgm`) para suportar busca textual aproximada
    (ex.: `ILIKE '%termo%'` ou `similarity()`), já que o texto não segue um
    padrão fixo que permita um índice btree simples eficiente para esse tipo
    de busca.
    """

    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_assets_version_positive"),
        # Exclusão lógica rastreável (migração 0004_db_security_hardening).
        CheckConstraint(
            "deleted_at IS NULL OR deleted_by IS NOT NULL",
            name="ck_assets_deleted_by_required",
        ),
        Index(
            "ix_assets_active_unit",
            "unit_id",
            postgresql_where=text("deleted_at IS NULL"),
        ),
        # Vínculo (migração 0012_asset_bond_status). No Postgres o CHECK usa
        # btrim(); trim() é equivalente para espaços e também existe no SQLite.
        CheckConstraint(
            "bond_status IS NULL OR (char_length(bond_status) BETWEEN 1 AND 64"
            " AND bond_status = trim(bond_status))",
            name="ck_assets_bond_status_len",
        ),
        Index(
            "ix_assets_bond_status_lower",
            text("lower(bond_status)"),
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
        # SEC-AST-01: o índice único parcial `uq_assets_patrimony_number_active`
        # (lower(btrim(patrimony_number)) WHERE deleted_at IS NULL) existe só na
        # migração 0009_uniq_idx_assets_movements. NÃO é declarado aqui
        # porque testes existentes (alertas de duplicidade, importação)
        # constroem duplicatas ativas no SQLite; ver docs/architecture.
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    source_record_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_system: Mapped[str | None] = mapped_column(Text, nullable=True)
    # NUNCA numérico/float: pode conter zeros à esquerda, prefixos, etc.
    patrimony_number: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Vínculo/situação do bem (ex.: Servidor, Terceirizado, Ocioso): valor da
    # 1ª coluna RESPONSAVEL da planilha; gerenciado pela importação.
    bond_status: Mapped[str | None] = mapped_column(Text, nullable=True)

    unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    owner_unit_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="SET NULL"), nullable=True
    )
    responsible_person_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responsible_people.id", ondelete="SET NULL"), nullable=True
    )
    assigned_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True
    )
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id", ondelete="SET NULL"), nullable=True
    )

    located: Mapped[str] = mapped_column(
        asset_located_enum, nullable=False, server_default=text("'DESCONHECIDO'")
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    registration_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))

    # Controle otimista efetivo no ORM: todo UPDATE em `assets` passa a
    # incluir `WHERE version = <valor lido>` e levanta
    # `sqlalchemy.orm.exc.StaleDataError` se outra transação alterou o bem
    # nesse intervalo (evita "lost update" entre leitura e escrita).
    # `version_id_generator=False`: o incremento continua explícito na
    # aplicação (ex.: `asset.version = asset.version + 1` no import_service).
    __mapper_args__ = {
        "version_id_col": version,
        "version_id_generator": False,
    }

    unit: Mapped["Unit"] = relationship(foreign_keys=[unit_id])
    owner_unit: Mapped["Unit | None"] = relationship(foreign_keys=[owner_unit_id])
    responsible_person: Mapped["ResponsiblePerson | None"] = relationship(foreign_keys=[responsible_person_id])
    assigned_user: Mapped["User | None"] = relationship(foreign_keys=[assigned_user_id])
    room: Mapped["Room | None"] = relationship(foreign_keys=[room_id])
    location: Mapped["Location | None"] = relationship(foreign_keys=[location_id])
    created_by_user: Mapped["User | None"] = relationship(foreign_keys=[created_by])
    updated_by_user: Mapped["User | None"] = relationship(foreign_keys=[updated_by])
    deleted_by_user: Mapped["User | None"] = relationship(foreign_keys=[deleted_by])

    # Histórico de movimentações nunca é apagado (CLAUDE.md): sem cascade de
    # "delete"/"delete-orphan" no ORM; o banco também bloqueia DELETE físico
    # (migração 0004_db_security_hardening).
    movements: Mapped[list["AssetMovement"]] = relationship(
        back_populates="asset", cascade="save-update, merge"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Asset id={self.id} patrimony_number={self.patrimony_number!r}>"


class AssetMovement(Base):
    """Movimentação (transferência) de um bem entre unidades/salas/responsáveis."""

    __tablename__ = "asset_movements"
    __table_args__ = (
        CheckConstraint(
            "status IN ('PENDENTE','APROVADA','REJEITADA','CONCLUIDA','CANCELADA')",
            name="ck_asset_movements_status",
        ),
        # SEC-MOV-02 (migração 0009_uniq_idx_assets_movements): no
        # máximo UMA movimentação PENDENTE por bem.
        Index(
            "uq_asset_movements_one_pending",
            "asset_id",
            unique=True,
            postgresql_where=text("status = 'PENDENTE'"),
            sqlite_where=text("status = 'PENDENTE'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    origin_unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    destination_unit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("units.id", ondelete="RESTRICT"), nullable=False
    )
    origin_room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True
    )
    destination_room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True
    )
    previous_responsible_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responsible_people.id", ondelete="SET NULL"), nullable=True
    )
    new_responsible_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responsible_people.id", ondelete="SET NULL"), nullable=True
    )
    movement_type: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'PENDENTE'"))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    asset: Mapped["Asset"] = relationship(back_populates="movements")
    origin_unit: Mapped["Unit"] = relationship(foreign_keys=[origin_unit_id])
    destination_unit: Mapped["Unit"] = relationship(foreign_keys=[destination_unit_id])
    origin_room: Mapped["Room | None"] = relationship(foreign_keys=[origin_room_id])
    destination_room: Mapped["Room | None"] = relationship(foreign_keys=[destination_room_id])
    previous_responsible: Mapped["ResponsiblePerson | None"] = relationship(
        foreign_keys=[previous_responsible_id]
    )
    new_responsible: Mapped["ResponsiblePerson | None"] = relationship(foreign_keys=[new_responsible_id])
    requested_by_user: Mapped["User"] = relationship(foreign_keys=[requested_by])
    approved_by_user: Mapped["User | None"] = relationship(foreign_keys=[approved_by])
