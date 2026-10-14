"""Mixins reutilizáveis para os modelos SQLAlchemy do SISPAT-AGU."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func


def utcnow() -> datetime:
    """Retorna o instante atual em UTC (usado como default Python-side)."""
    return datetime.now(timezone.utc)


class TimestampMixin:
    """Adiciona `created_at`/`updated_at` (timestamptz, sempre em UTC).

    O valor é definido pelo servidor (`now()`, normalizado para UTC pelo tipo
    `timestamptz`) e, como fallback, também pelo lado Python (`utcnow`), para
    cobrir cenários de uso do ORM sem round-trip imediato ao banco.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=utcnow,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=utcnow,
        default=utcnow,
    )
