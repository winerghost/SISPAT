"""Filtros de data (AAAA-MM-DD) como dia civil em America/Araguaina.

O banco guarda UTC. O dia civil local (UTC-3, sem DST) vira o intervalo
semiaberto [inicio_do_dia, inicio_do_dia_seguinte) em UTC.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    LOCAL_TZ: Any = ZoneInfo("America/Araguaina")
except ZoneInfoNotFoundError:  # pragma: no cover - ambiente sem tzdata
    LOCAL_TZ = timezone(timedelta(hours=-3))  # offset vigente (sem DST)


def local_day_start_utc(raw: str) -> datetime:
    """Início do dia civil local `raw` (AAAA-MM-DD), em UTC."""
    local = datetime.combine(date.fromisoformat(raw), time.min, tzinfo=LOCAL_TZ)
    return local.astimezone(timezone.utc)


def local_day_end_exclusive_utc(raw: str) -> datetime:
    """Início do dia civil local seguinte a `raw`, em UTC (limite exclusivo)."""
    nxt = date.fromisoformat(raw) + timedelta(days=1)
    return datetime.combine(nxt, time.min, tzinfo=LOCAL_TZ).astimezone(timezone.utc)
