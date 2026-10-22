"""Contrato de paginação das listagens da API v1 (definido em `app.services.pagination`).

`page_size` aceita SOMENTE 50, 100 ou 200 (default 50).
"""
from app.services.pagination import (  # noqa: F401
    ALLOWED_PAGE_SIZES,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    PageNumber,
    PageSize,
    coerce_page_size,
)
