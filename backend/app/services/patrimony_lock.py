"""Normalização e advisory lock ÚNICOS do número patrimonial (SEC-AST-01).

API (`asset_service`) e importação (`import_service`) usam ESTE módulo, de modo que:
- o número é comparado como `lower(btrim(valor))` (case-insensitive, sem espaços nas pontas);
- ambos tomam a MESMA chave de `pg_advisory_xact_lock` e se excluem mutuamente.

O lock é transacional (liberado no commit/rollback) e o valor vai sempre como bind.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, text
from sqlalchemy.orm import Session

_LOCK_PREFIX = "sispat:asset-number:"


def normalize_patrimony_number(number: str) -> str:
    """Equivale a `lower(btrim(number))` do PostgreSQL (btrim remove apenas espaços)."""
    return number.strip(" ").lower()


def normalized_column(column: Any) -> Any:
    """Expressão SQL `lower(trim(coluna))`, par de `normalize_patrimony_number`."""
    return func.lower(func.trim(column))


def lock_key(number: str) -> str:
    return f"{_LOCK_PREFIX}{normalize_patrimony_number(number)}"


def acquire_patrimony_lock(db: Session, number: str) -> None:
    """Advisory lock transacional por número normalizado (no-op fora do PostgreSQL)."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": lock_key(number)},
        )
