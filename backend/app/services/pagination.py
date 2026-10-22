"""Contrato único de paginação das listagens da API v1.

`page_size` aceita SOMENTE 50, 100 ou 200 (default 50); qualquer outro valor
é rejeitado pela validação do schema (400 via `parse_query`).
"""
from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, Field

ALLOWED_PAGE_SIZES: tuple[int, ...] = (50, 100, 200)
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = max(ALLOWED_PAGE_SIZES)


def _check_page_size(value: int) -> int:
    if value not in ALLOWED_PAGE_SIZES:
        raise ValueError("page_size deve ser 50, 100 ou 200")
    return value


PageSize = Annotated[int, AfterValidator(_check_page_size)]
PageNumber = Annotated[int, Field(ge=1, le=100_000)]


def coerce_page_size(value: int | None) -> int:
    """Saneia `page_size` em serviços chamados fora do schema (fallback seguro)."""
    return value if value in ALLOWED_PAGE_SIZES else DEFAULT_PAGE_SIZE


def page_count(total: int, page_size: int) -> int:
    """Total de páginas (0 quando não há registros)."""
    return -(-int(total) // page_size) if total and page_size > 0 else 0
