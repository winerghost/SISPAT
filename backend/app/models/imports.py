"""Modelos de pré-visualização de importação de dados (Google Sheets).

Tabelas: import_previews, import_preview_items.

Regras importantes:
    - Uma pré-visualização (`ImportPreview`) NUNCA grava em `assets`: ela
      apenas representa o resultado da leitura/classificação de uma fonte
      externa (ex.: Google Sheets), para exibição nos botões "Pré-visualizar
      Importação" e "Confirmar Importação" do módulo Administração ->
      Importação de Dados.
    - `expires_at` é calculado pela aplicação (ex.: `created_at` + 1 hora) e
      gravado explicitamente; não há cálculo no banco. Uma prévia expirada
      (`status = 'EXPIRADA'`) não pode mais ser confirmada.
    - `ImportPreviewItem.classification` é o resultado da comparação de cada
      linha de origem com os dados já existentes em `assets` no momento da
      pré-visualização (NOVO, EXISTENTE, DUPLICADO, INVALIDO, CONFLITANTE).
    - `selected` permite que o usuário desmarque itens individuais antes de
      confirmar a importação (ex.: não importar um item CONFLITANTE).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class ImportPreview(Base):
    """Execução de uma pré-visualização de importação de dados de origem externa.

    Resume, em contadores, a classificação das linhas lidas da fonte (hoje,
    Google Sheets) frente aos bens já cadastrados, sem efetuar nenhuma
    gravação em `assets`. A confirmação (`status = 'CONFIRMADA'`,
    `confirmed_at`/`confirmed_by` preenchidos) é um passo posterior,
    disparado pelo botão "Confirmar Importação", que efetivamente aplica as
    mudanças a partir dos itens selecionados (`ImportPreviewItem.selected`).
    """

    __tablename__ = "import_previews"
    __table_args__ = (
        CheckConstraint(
            "status IN ('PROCESSANDO','CONCLUIDA','FALHOU','EXPIRADA','CONFIRMADA')",
            name="ck_import_previews_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'google_sheets'"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'CONCLUIDA'"))
    total_rows: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    count_novo: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    count_existente: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    count_duplicado: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    count_invalido: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    count_conflitante: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    # Calculado pela aplicação (ex.: created_at + 1h); gravado explicitamente,
    # sem default no banco.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # `requested_by`/`confirmed_by` são referências de "ator" (ver nota em
    # app/models/__init__.py) e, portanto, unidirecionais (sem back_populates
    # em `User`).
    requested_by_user: Mapped["User"] = relationship(foreign_keys=[requested_by])
    confirmed_by_user: Mapped["User | None"] = relationship(foreign_keys=[confirmed_by])

    items: Mapped[list["ImportPreviewItem"]] = relationship(
        back_populates="preview", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ImportPreview id={self.id} status={self.status!r} total_rows={self.total_rows}>"


class ImportPreviewItem(Base):
    """Linha individual de uma pré-visualização de importação, já classificada.

    `raw_values` guarda a linha crua, como lida da fonte externa;
    `normalized_values` guarda a versão normalizada (quando aplicável) usada
    para comparação com `assets`. `matched_asset_id` aponta para o bem já
    existente identificado como correspondente (classificações EXISTENTE,
    DUPLICADO ou CONFLITANTE), quando houver.
    """

    __tablename__ = "import_preview_items"
    __table_args__ = (
        CheckConstraint(
            "classification IN ('NOVO','EXISTENTE','DUPLICADO','INVALIDO','CONFLITANTE')",
            name="ck_import_preview_items_classification",
        ),
        # Suporta a listagem paginada de itens de uma prévia filtrada por
        # status/classificação (caso de uso principal da tela de revisão).
        Index(
            "ix_import_preview_items_preview_classification",
            "preview_id",
            "classification",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    preview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("import_previews.id", ondelete="CASCADE"), nullable=False
    )
    source_record_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    patrimony_number: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_values: Mapped[dict] = mapped_column(JSONB, nullable=False)
    normalized_values: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    classification: Mapped[str] = mapped_column(Text, nullable=False)
    validation_errors: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    matched_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )
    selected: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

    preview: Mapped["ImportPreview"] = relationship(back_populates="items")
    # Referência de consulta (não é uma coleção útil de navegação a partir de
    # `Asset` nesta fase), por isso unidirecional.
    matched_asset: Mapped["Asset | None"] = relationship(foreign_keys=[matched_asset_id])

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ImportPreviewItem id={self.id} preview_id={self.preview_id} "
            f"classification={self.classification!r}>"
        )
