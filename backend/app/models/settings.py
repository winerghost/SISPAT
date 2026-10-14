"""Modelos de configuração: IA (linha única) e preferências de aparência por usuário.

Tabelas: ai_settings, user_preferences (migração 0005_settings_ai_users).

`ai_settings` NUNCA guarda chaves de API — elas vivem apenas em variáveis de
ambiente do backend (ver `app.config.settings`). `features` é um objeto JSON
cujas chaves são validadas pelo backend (`app.services.ai.models.AI_FEATURES`).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base
from app.models.mixins import TimestampMixin

AI_SETTINGS_SINGLETON_ID = 1


class AISettings(TimestampMixin, Base):
    """Configuração de IA editável pelo ADM (sempre a linha `id = 1`)."""

    __tablename__ = "ai_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_ai_settings_singleton"),
        CheckConstraint(
            "provider IN ('none','openai','anthropic','deepseek')", name="ck_ai_settings_provider"
        ),
        CheckConstraint(
            "model IS NULL OR char_length(model) BETWEEN 1 AND 100",
            name="ck_ai_settings_model_length",
        ),
        CheckConstraint("jsonb_typeof(features) = 'object'", name="ck_ai_settings_features_object"),
        CheckConstraint(
            "monthly_token_cap BETWEEN 0 AND 50000000", name="ck_ai_settings_token_cap"
        ),
        CheckConstraint("version >= 1", name="ck_ai_settings_version"),
        CheckConstraint(
            "provider <> 'deepseek' OR deepseek_acknowledged_at IS NOT NULL",
            name="ck_ai_settings_deepseek_ack",
        ),
    )

    id: Mapped[int] = mapped_column(
        SmallInteger, primary_key=True, server_default=text("1"), default=AI_SETTINGS_SINGLETON_ID
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    provider: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'none'"))
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    features: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    deepseek_acknowledged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deepseek_acknowledged_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    monthly_token_cap: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("200000")
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:  # pragma: no cover - apenas debug
        return f"<AISettings enabled={self.enabled} provider={self.provider!r} version={self.version}>"


class UserPreferences(TimestampMixin, Base):
    """Preferências de aparência de um usuário (densidade e escala de fonte)."""

    __tablename__ = "user_preferences"
    __table_args__ = (
        CheckConstraint("density IN ('comfortable','compact')", name="ck_user_preferences_density"),
        CheckConstraint("font_scale IN (100, 112, 125)", name="ck_user_preferences_font_scale"),
        CheckConstraint("version >= 1", name="ck_user_preferences_version"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    density: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'comfortable'")
    )
    font_scale: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("100")
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
