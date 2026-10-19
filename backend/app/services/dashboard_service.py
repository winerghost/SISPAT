"""Agregações de leitura do dashboard (`/api/v1/dashboard/*`).

Regras:
- Tudo no escopo de bens de `/assets` (`asset_scope_clause`: `unit_id` OU
  `owner_unit_id` acessíveis; ADM sem bypass), garantindo paridade de contagem.
  Escopo vazio devolve zeros/listas vazias (nunca erro).
- Só bens com `deleted_at IS NULL`; só contagens e rótulos (sem PII).
- Agregação no banco com construções portáveis (SQLite/PostgreSQL):
  `count`, `case`, `coalesce`, `extract`; sem `date_trunc`/`strftime`.
- `valor_total`, `em_manutencao` e `baixas_ano` são SEMPRE null: não existem
  campos de valor, manutenção ou baixa no modelo `Asset`.
- "Tipo" do bem é inferido da `description` (primeira palavra após o
  "(codigo_material)" inicial, maiúscula e sem acento) sobre os grupos
  DISTINTOS de descrição agregados no banco, com teto (`MAX_GRUPOS`, por
  contagem desc.); o excedente vira o balde interno `__OUTROS__` (soma exata).
  Um tipo real "OUTROS" é emitido como "OUTROSTIPO" para não colidir com o balde.
- Sigla da unidade: menor alias (ordem alfabética) de `unit_aliases`; na falta,
  `units.code`. Determinístico quando há mais de um alias.
- Movimentações pendentes: origem OU destino no escopo (mesma regra de
  `movement_service`).
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, extract, func, or_
from sqlalchemy.orm import Session

from app.authorization.rbac import apply_unit_scope, get_accessible_unit_ids
from app.services.asset_service import asset_scope_clause
from app.models.assets import Asset, AssetMovement
from app.models.inventory import Inventory
from app.models.units import Unit, UnitAlias

NAO_CLASSIFICADO = "NAO_CLASSIFICADO"
OUTROS = "OUTROS"  # rótulo de saída do balde
_BUCKET = "__OUTROS__"  # chave interna: infer_type nunca a produz (só A-Z0-9)
MAX_GRUPOS = 500
MAX_TIPOS_UNIDADE = 6
MAX_TIPOS_SERIE = 3
SITUACAO_LABELS = (
    ("SIM", "Localizado"),
    ("NAO", "Não localizado"),
    ("DESCONHECIDO", "Desconhecido"),
)
_LEADING_CODE = re.compile(r"^\s*\([^)]*\)\s*")
_TYPE_MAX = 40
_ALIAS_EXTRA = frozenset(" -_./()&,ºª")


def infer_type(description: str | None) -> str:
    """Primeira palavra após o "(codigo)" inicial, em maiúsculas e sem acento."""
    if not description:
        return NAO_CLASSIFICADO
    text = _LEADING_CODE.sub("", description, count=1).strip()
    for word in text.split():
        folded = unicodedata.normalize("NFKD", word)
        folded = "".join(c for c in folded if not unicodedata.combining(c)).upper()
        folded = re.sub(r"[^A-Z0-9]", "", folded)
        if folded:
            return "OUTROSTIPO" if folded == OUTROS else folded[:_TYPE_MAX]
    return NAO_CLASSIFICADO


def _active_assets(db: Session, actor_id: Any, *cols: Any):
    query = db.query(*cols).select_from(Asset).filter(Asset.deleted_at.is_(None))
    return query.filter(asset_scope_clause(actor_id, db))


def _top_types(totals: Counter, limit: int) -> list[str]:
    ranked = sorted(
        ((k, v) for k, v in totals.items() if k != _BUCKET), key=lambda kv: (-kv[1], kv[0])
    )
    return [name for name, _ in ranked[:limit]]


def _label(tipo: str) -> str:
    return OUTROS if tipo == _BUCKET else tipo


def clean_alias(value: str | None) -> str:
    """Allowlist de saída: letras/dígitos e `" -_./()&,ºª"`; sem marcação/controle."""
    text = "".join(c for c in (value or "") if c.isalnum() or c in _ALIAS_EXTRA)
    return " ".join(text.split())[:64]


def _variation(recent: int, previous: int) -> float | None:
    if previous <= 0:
        return None
    return round((recent - previous) * 100.0 / previous, 1)


def summary(db: Session, actor_id: Any, *, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    d30, d60 = now - timedelta(days=30), now - timedelta(days=60)

    def _sum(cond: Any):
        return func.coalesce(func.sum(case((cond, 1), else_=0)), 0)

    row = _active_assets(
        db,
        actor_id,
        func.count(Asset.id),
        _sum(Asset.located == "SIM"),
        _sum(Asset.located == "NAO"),
        _sum(Asset.located == "DESCONHECIDO"),
        _sum(Asset.created_at >= d30),
        _sum((Asset.created_at >= d60) & (Asset.created_at < d30)),
    ).one()
    total, loc, nao, desc, recent, previous = (int(v or 0) for v in row)

    accessible = get_accessible_unit_ids(actor_id, db)
    pending = opened = 0
    if accessible:
        ids = sorted(accessible, key=str)
        pending = (
            db.query(func.count(AssetMovement.id))
            .filter(
                AssetMovement.status == "PENDENTE",
                or_(
                    AssetMovement.origin_unit_id.in_(ids),
                    AssetMovement.destination_unit_id.in_(ids),
                ),
            )
            .scalar()
        )
        opened = apply_unit_scope(
            db.query(func.count(Inventory.id)).filter(Inventory.status == "ABERTO"),
            Inventory.unit_id,
            actor_id,
            db,
        ).scalar()
    return {
        "total_bens": total,
        "localizados": loc,
        "nao_localizados": nao,
        "desconhecidos": desc,
        "movimentacoes_pendentes": int(pending or 0),
        "inventarios_abertos": int(opened or 0),
        "novos_30d": recent,
        "valor_total": None,
        "em_manutencao": None,
        "baixas_ano": None,
        "variacao": {
            "total_bens": _variation(recent, previous),
            "valor_total": None,
            "em_manutencao": None,
            "baixas_ano": None,
        },
    }


def by_unit(db: Session, actor_id: Any) -> list[dict[str, Any]]:
    unit_totals = {
        uid: int(n)
        for uid, n in _active_assets(db, actor_id, Asset.unit_id, func.count(Asset.id)).group_by(
            Asset.unit_id
        )
    }
    if not unit_totals:
        return []
    n_desc = func.count(Asset.id)
    groups = (
        _active_assets(db, actor_id, Asset.unit_id, Asset.description, n_desc)
        .group_by(Asset.unit_id, Asset.description)
        .order_by(n_desc.desc(), Asset.unit_id, Asset.description)
        .limit(MAX_GRUPOS)
        .all()
    )
    per_unit: dict[Any, Counter] = {uid: Counter() for uid in unit_totals}
    global_types: Counter = Counter()
    for unit_id, description, n in groups:
        tipo = infer_type(description)
        per_unit[unit_id][tipo] += int(n)
        global_types[tipo] += int(n)
    for uid, counter in per_unit.items():  # excedente do teto -> balde
        rest = unit_totals[uid] - sum(counter.values())
        if rest > 0:
            counter[_BUCKET] += rest
            global_types[_BUCKET] += rest
    keep = set(_top_types(global_types, MAX_TIPOS_UNIDADE))

    unit_ids = list(per_unit)
    codes = {r.id: r.code for r in db.query(Unit.id, Unit.code).filter(Unit.id.in_(unit_ids))}
    aliases: dict[Any, str] = {}
    for unit_id, alias in (
        db.query(UnitAlias.unit_id, func.min(UnitAlias.alias))
        .filter(UnitAlias.unit_id.in_(unit_ids))
        .group_by(UnitAlias.unit_id)
    ):
        aliases[unit_id] = alias

    out = []
    for unit_id, counter in per_unit.items():
        tipos: Counter = Counter()
        for tipo, n in counter.items():
            tipos[_label(tipo) if tipo in keep else OUTROS] += n
        name = clean_alias(aliases.get(unit_id)) or clean_alias(codes.get(unit_id)) or "?"
        out.append(
            {
                "unidade": name,
                "total": sum(tipos.values()),
                "tipos": dict(sorted(tipos.items(), key=lambda kv: (-kv[1], kv[0]))),
            }
        )
    out.sort(key=lambda item: (-item["total"], item["unidade"]))
    return out


def by_situation(db: Session, actor_id: Any) -> list[dict[str, Any]]:
    rows = (
        _active_assets(db, actor_id, Asset.located, func.count(Asset.id)).group_by(Asset.located).all()
    )
    counts = {located: int(n) for located, n in rows}
    return [
        {"id": label, "value": counts[key]} for key, label in SITUACAO_LABELS if counts.get(key, 0) > 0
    ]


def month_range(now: datetime, months: int) -> list[tuple[int, int]]:
    year, month = now.year, now.month
    out: list[tuple[int, int]] = []
    for _ in range(months):
        out.append((year, month))
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return list(reversed(out))


def monthly_acquisitions(
    db: Session, actor_id: Any, months: int, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    window = month_range(now, months)
    first_y, first_m = window[0]
    start_date = date(first_y, first_m, 1)
    start_dt = datetime(first_y, first_m, 1, tzinfo=timezone.utc)

    def _grouped(date_col: Any, *conds: Any):
        year, month = extract("year", date_col), extract("month", date_col)
        n_desc = func.count(Asset.id)
        listed = (
            _active_assets(db, actor_id, year, month, Asset.description, n_desc)
            .filter(*conds)
            .group_by(year, month, Asset.description)
            .order_by(n_desc.desc(), year, month, Asset.description)
            .limit(MAX_GRUPOS)
            .all()
        )
        month_totals = (
            _active_assets(db, actor_id, year, month, func.count(Asset.id))
            .filter(*conds)
            .group_by(year, month)
            .all()
        )
        seen: Counter = Counter()
        for y, m, _d, n in listed:
            seen[(int(y), int(m))] += int(n)
        rows = [(y, m, d, n) for y, m, d, n in listed]
        for y, m, n in month_totals:  # excedente do teto -> balde
            rest = int(n) - seen[(int(y), int(m))]
            if rest > 0:
                rows.append((y, m, _BUCKET, rest))
        return rows

    # COALESCE(registration_date, created_at): dois grupos disjuntos, mesma regra.
    rows = _grouped(
        Asset.registration_date,
        Asset.registration_date.isnot(None),
        Asset.registration_date >= start_date,
    )
    rows += _grouped(Asset.created_at, Asset.registration_date.is_(None), Asset.created_at >= start_dt)

    valid = set(window)
    cells: dict[tuple[str, tuple[int, int]], int] = {}
    totals: Counter = Counter()
    for year, month, description, n in rows:
        key = (int(year), int(month))
        if key not in valid:  # datas futuras ficam fora do intervalo
            continue
        tipo = _BUCKET if description == _BUCKET else infer_type(description)
        cells[(tipo, key)] = cells.get((tipo, key), 0) + int(n)
        totals[tipo] += int(n)
    if not totals:
        return []

    top = _top_types(totals, MAX_TIPOS_SERIE)
    series: dict[str, dict[tuple[int, int], int]] = {name: {} for name in top}
    if any(t not in top for t in totals):
        series[_BUCKET] = {}
    for (tipo, key), n in cells.items():
        bucket = series[tipo if tipo in top else _BUCKET]
        bucket[key] = bucket.get(key, 0) + n
    return [
        {"id": _label(name), "data": [{"x": f"{y:04d}-{m:02d}", "y": points.get((y, m), 0)} for y, m in window]}
        for name, points in series.items()
    ]
