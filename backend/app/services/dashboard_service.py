"""Agregações de leitura do dashboard (`/api/v1/dashboard/*`).

Regras:
- Tudo no escopo de bens de `/assets` (`asset_scope_clause`: `unit_id` OU
  `owner_unit_id` acessíveis; ADM sem bypass), garantindo paridade de contagem.
  Escopo vazio devolve zeros/listas vazias (nunca erro).
- Só bens com `deleted_at IS NULL`; só contagens e rótulos (sem PII).
- FILTROS (`DashboardFilters`, todos opcionais, E lógico) entram em
  `_active_assets` DEPOIS do escopo (`filter_clauses` + `apply_dashboard_filters`):
  * comuns com `/assets` (unit_id, owner_unit_id, room_id, responsible_person_id,
    located, bond_status/`__none__`) vêm de `asset_service.asset_filter_clauses`
    (mesmo SQL => mesmas contagens da lista de bens);
  * has_room / has_responsible: coluna `IS [NOT] NULL`;
  * registrado_desde / registrado_ate: `registration_date` (bens sem data saem);
  * inventario: pela conferência MAIS RECENTE do bem (`inventory_items` com
    `checked_at` não nulo, de inventário não CANCELADO, ordem `checked_at` desc,
    `id` desc). `conferido` = existe conferência; `nao_conferido` = nenhuma;
    `encontrado`/`nao_encontrado` = `found` true/false da mais recente
    (`found` nulo não entra em nenhum dos dois);
  * movimentacao_pendente: existe `asset_movements` do bem com status PENDENTE;
  * tipo: ver `_tipo_clause`.
  ID fora do escopo não gera erro: como o escopo é aplicado antes, o resultado
  é o mesmo de um ID inexistente (vazio), salvo bens que já são visíveis pelo
  escopo (ex.: bem com `owner_unit_id` acessível em `unit_id` alheio), igual a
  `/assets`.
- Agregação no banco com construções portáveis (SQLite/PostgreSQL):
  `count`, `case`, `coalesce`, `extract`, subconsultas correlacionadas; sem
  `date_trunc`/`strftime` e sem SQL textual.
- `valor_total`, `em_manutencao` e `baixas_ano` são SEMPRE null: não existem
  campos de valor, manutenção ou baixa no modelo `Asset`.
- "Tipo" do bem é inferido da `description` (primeira palavra após o
  "(codigo_material)" inicial, maiúscula e sem acento) sobre os grupos
  DISTINTOS de descrição agregados no banco, com teto (`MAX_GRUPOS`, por
  contagem desc.); o excedente vira o balde interno `__OUTROS__` (soma exata).
  Um tipo real "OUTROS" é emitido como "OUTROSTIPO" para não colidir com o balde.
- Sigla da unidade: menor alias (ordem alfabética) de `unit_aliases`; na falta,
  `units.code`. Determinístico quando há mais de um alias.
- Movimentações pendentes do resumo: origem OU destino no escopo (mesma regra
  de `movement_service`); com filtro ativo, só as dos bens filtrados.
- Rankings "top N + resto": o resto soma EXATAMENTE o que ficou de fora.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, extract, false, func, or_, select
from sqlalchemy.orm import Session

from app.authorization.rbac import apply_unit_scope, get_accessible_unit_ids
from app.models.assets import Asset, AssetMovement
from app.models.inventory import Inventory, InventoryItem
from app.models.units import Room, Unit, UnitAlias
from app.services.asset_service import BOND_STATUS_NONE, asset_filter_clauses, asset_scope_clause

NAO_CLASSIFICADO = "NAO_CLASSIFICADO"
OUTROS = "OUTROS"  # rótulo de saída do balde
_BUCKET = "__OUTROS__"  # chave interna: infer_type nunca a produz (só A-Z0-9)
MAX_GRUPOS = 500
MAX_TIPOS_UNIDADE = 6
MAX_TIPOS_SERIE = 3
TOP_UNIDADES = 15
TOP_VINCULOS = 8
TOP_SALAS = 15
TOP_TIPOS = 50
LABEL_MAX = 200
OUTRAS_UNIDADES = "Outras"
OUTROS_ID, OUTROS_LABEL = "__outros__", "Outros"
OUTRAS_ID, OUTRAS_LABEL = "__outras__", "Outras"
NONE_ID = BOND_STATUS_NONE  # "__none__": sem vínculo / sem sala
SEM_VINCULO_LABEL = "Sem vínculo"
SEM_SALA_LABEL = "Sem sala"
OCIOSO = "ocioso"
INVENTORY_CANCELLED = "CANCELADO"
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


# ---------------------------------------------------------------------------
# Filtros
# ---------------------------------------------------------------------------


def _scoped_active(db: Session, actor_id: Any, *cols: Any):
    query = db.query(*cols).select_from(Asset).filter(Asset.deleted_at.is_(None))
    return query.filter(asset_scope_clause(actor_id, db))


def _tipo_clause(db: Session, actor_id: Any, tipo: str) -> Any:
    """Tipo é deduzido da descrição (não há coluna): resolve as descrições
    DISTINTAS do escopo cujo `infer_type` é `tipo` e filtra por elas.

    Custo O(descrições distintas no escopo) por requisição -- adequado ao volume
    atual (centenas de bens). Se a base passar de dezenas de milhares de bens,
    persistir o tipo em coluna própria (migração) em vez deste passo.
    """
    rows = _scoped_active(db, actor_id, Asset.description).distinct().all()
    matched = sorted({d for (d,) in rows if d is not None and infer_type(d) == tipo})
    conds = [Asset.description.in_(matched)] if matched else []
    if tipo == NAO_CLASSIFICADO:
        conds.append(Asset.description.is_(None))
    return or_(*conds) if conds else false()


def _checked_items():
    return (
        select(InventoryItem.found)
        .join(Inventory, Inventory.id == InventoryItem.inventory_id)
        .where(
            InventoryItem.asset_id == Asset.id,
            InventoryItem.checked_at.is_not(None),
            Inventory.status != INVENTORY_CANCELLED,
        )
    )


def _inventory_checked() -> Any:
    return _checked_items().exists().correlate(Asset)


def _inventory_latest_found() -> Any:
    return (
        _checked_items()
        .order_by(InventoryItem.checked_at.desc(), InventoryItem.id.desc())
        .limit(1)
        .correlate(Asset)
        .scalar_subquery()
    )


def _inventory_clause(value: str) -> Any:
    if value == "conferido":
        return _inventory_checked()
    if value == "nao_conferido":
        return ~_inventory_checked()
    return _inventory_latest_found().is_(value == "encontrado")


def _pending_movement() -> Any:
    return (
        select(AssetMovement.id)
        .where(AssetMovement.asset_id == Asset.id, AssetMovement.status == "PENDENTE")
        .exists()
        .correlate(Asset)
    )


def filter_clauses(db: Session, actor_id: Any, filters: Any, *, skip_tipo: bool = False) -> tuple[Any, ...]:
    """Cláusulas SQL dos filtros ativos (atributos `None` são ignorados)."""
    if filters is None:
        return ()
    clauses = list(asset_filter_clauses(filters))
    for attr, column in (("has_room", Asset.room_id), ("has_responsible", Asset.responsible_person_id)):
        value = getattr(filters, attr, None)
        if value is not None:
            clauses.append(column.is_not(None) if value == "true" else column.is_(None))
    desde = getattr(filters, "registrado_desde", None)
    ate = getattr(filters, "registrado_ate", None)
    if desde is not None:
        clauses.append(Asset.registration_date >= desde)
    if ate is not None:
        clauses.append(Asset.registration_date <= ate)
    inventario = getattr(filters, "inventario", None)
    if inventario is not None:
        clauses.append(_inventory_clause(inventario))
    pending = getattr(filters, "movimentacao_pendente", None)
    if pending is not None:
        clauses.append(_pending_movement() if pending == "true" else ~_pending_movement())
    tipo = getattr(filters, "tipo", None)
    if tipo is not None and not skip_tipo:
        clauses.append(_tipo_clause(db, actor_id, tipo))
    return tuple(clauses)


def apply_dashboard_filters(query: Any, where: tuple[Any, ...]) -> Any:
    return query.filter(*where) if where else query


def _active_assets(db: Session, actor_id: Any, *cols: Any, where: tuple[Any, ...] = ()):
    """Bens ativos no escopo do usuário e, depois do escopo, os filtros."""
    return apply_dashboard_filters(_scoped_active(db, actor_id, *cols), where)


# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------


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


def clean_label(value: str | None, max_len: int = LABEL_MAX) -> str:
    """Rótulo de texto vindo da planilha (sala/vínculo): remove controle e
    formatação invisível (categoria Unicode C*), colapsa espaços e limita.
    Não é sanitizador de HTML: o JSON é texto e o React o escapa ao exibir."""
    text = "".join(c for c in (value or "") if unicodedata.category(c)[0] != "C")
    return " ".join(text.split())[:max_len]


def _unit_labels(db: Session, unit_ids: list[Any]) -> dict[Any, str]:
    if not unit_ids:
        return {}
    codes = {r.id: r.code for r in db.query(Unit.id, Unit.code).filter(Unit.id.in_(unit_ids))}
    aliases = dict(
        db.query(UnitAlias.unit_id, func.min(UnitAlias.alias))
        .filter(UnitAlias.unit_id.in_(unit_ids))
        .group_by(UnitAlias.unit_id)
        .all()
    )
    return {
        uid: clean_alias(aliases.get(uid)) or clean_alias(codes.get(uid)) or "?" for uid in unit_ids
    }


def _sum(cond: Any):
    return func.coalesce(func.sum(case((cond, 1), else_=0)), 0)


def _variation(recent: int, previous: int) -> float | None:
    if previous <= 0:
        return None
    return round((recent - previous) * 100.0 / previous, 1)


# ---------------------------------------------------------------------------
# Endpoints existentes
# ---------------------------------------------------------------------------


def summary(
    db: Session, actor_id: Any, filters: Any = None, *, now: datetime | None = None
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    d30, d60 = now - timedelta(days=30), now - timedelta(days=60)
    where = filter_clauses(db, actor_id, filters)

    row = _active_assets(
        db,
        actor_id,
        func.count(Asset.id),
        _sum(Asset.located == "SIM"),
        _sum(Asset.located == "NAO"),
        _sum(Asset.located == "DESCONHECIDO"),
        _sum(Asset.created_at >= d30),
        _sum((Asset.created_at >= d60) & (Asset.created_at < d30)),
        where=where,
    ).one()
    total, loc, nao, desc, recent, previous = (int(v or 0) for v in row)

    accessible = get_accessible_unit_ids(actor_id, db)
    pending = opened = 0
    if accessible:
        ids = sorted(accessible, key=str)
        pending_q = db.query(func.count(AssetMovement.id)).filter(
            AssetMovement.status == "PENDENTE",
            or_(
                AssetMovement.origin_unit_id.in_(ids),
                AssetMovement.destination_unit_id.in_(ids),
            ),
        )
        if where:  # com filtro: só movimentações dos bens filtrados
            pending_q = pending_q.filter(
                AssetMovement.asset_id.in_(_active_assets(db, actor_id, Asset.id, where=where).subquery().select())
            )
        pending = pending_q.scalar()
        inv_q = db.query(func.count(Inventory.id)).filter(Inventory.status == "ABERTO")
        unit_filter = getattr(filters, "unit_id", None)
        if unit_filter is not None:  # inventário é por unidade: só `unit_id` se aplica
            inv_q = inv_q.filter(Inventory.unit_id == unit_filter)
        opened = apply_unit_scope(inv_q, Inventory.unit_id, actor_id, db).scalar()
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


def by_unit(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    where = filter_clauses(db, actor_id, filters)
    unit_totals = {
        uid: int(n)
        for uid, n in _active_assets(db, actor_id, Asset.unit_id, func.count(Asset.id), where=where)
        .group_by(Asset.unit_id)
    }
    if not unit_totals:
        return []
    n_desc = func.count(Asset.id)
    groups = (
        _active_assets(db, actor_id, Asset.unit_id, Asset.description, n_desc, where=where)
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
    names = _unit_labels(db, list(per_unit))

    out = []
    for unit_id, counter in per_unit.items():
        tipos: Counter = Counter()
        for tipo, n in counter.items():
            tipos[_label(tipo) if tipo in keep else OUTROS] += n
        out.append(
            {
                "unidade": names[unit_id],
                "total": sum(tipos.values()),
                "tipos": dict(sorted(tipos.items(), key=lambda kv: (-kv[1], kv[0]))),
            }
        )
    out.sort(key=lambda item: (-item["total"], item["unidade"]))
    return out


def by_situation(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    where = filter_clauses(db, actor_id, filters)
    rows = (
        _active_assets(db, actor_id, Asset.located, func.count(Asset.id), where=where)
        .group_by(Asset.located)
        .all()
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
    db: Session, actor_id: Any, months: int, filters: Any = None, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    window = month_range(now, months)
    first_y, first_m = window[0]
    start_date = date(first_y, first_m, 1)
    start_dt = datetime(first_y, first_m, 1, tzinfo=timezone.utc)
    where = filter_clauses(db, actor_id, filters)

    def _grouped(date_col: Any, *conds: Any):
        year, month = extract("year", date_col), extract("month", date_col)
        n_desc = func.count(Asset.id)
        listed = (
            _active_assets(db, actor_id, year, month, Asset.description, n_desc, where=where)
            .filter(*conds)
            .group_by(year, month, Asset.description)
            .order_by(n_desc.desc(), year, month, Asset.description)
            .limit(MAX_GRUPOS)
            .all()
        )
        month_totals = (
            _active_assets(db, actor_id, year, month, func.count(Asset.id), where=where)
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


# ---------------------------------------------------------------------------
# Endpoints novos (painéis do catálogo de filtros)
# ---------------------------------------------------------------------------


def location_by_unit(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    """Localizado × não localizado × desconhecido por unidade de uso (`unit_id`).

    Ordem `total` desc (desempate pela sigla); top `TOP_UNIDADES` + "Outras"
    com a soma exata do restante.
    """
    where = filter_clauses(db, actor_id, filters)
    rows = (
        _active_assets(
            db, actor_id, Asset.unit_id,
            _sum(Asset.located == "SIM"), _sum(Asset.located == "NAO"),
            _sum(Asset.located == "DESCONHECIDO"), func.count(Asset.id),
            where=where,
        )
        .group_by(Asset.unit_id)
        .all()
    )
    if not rows:
        return []
    names = _unit_labels(db, [r[0] for r in rows])
    items = sorted(
        (
            {"unidade": names[uid], "sim": int(s), "nao": int(n), "desconhecido": int(d), "total": int(t)}
            for uid, s, n, d, t in rows
        ),
        key=lambda item: (-item["total"], item["unidade"]),
    )
    top, rest = items[:TOP_UNIDADES], items[TOP_UNIDADES:]
    if rest:
        top.append(
            {"unidade": OUTRAS_UNIDADES, **{k: sum(i[k] for i in rest) for k in ("sim", "nao", "desconhecido", "total")}}
        )
    return top


def by_bond_status(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    """Bens por vínculo: grupos sem caixa (mesma `lower()` do filtro).

    `id` = grafia mais frequente do grupo (desempate alfabético), igual a
    `GET /assets/bond-statuses`, utilizável como `bond_status=`. Top
    `TOP_VINCULOS` por contagem + `__outros__` (soma exata) + `__none__`
    ("Sem vínculo"). Só itens com valor > 0.
    """
    where = filter_clauses(db, actor_id, filters)
    key = func.lower(Asset.bond_status)
    rows = (
        _active_assets(db, actor_id, key, Asset.bond_status, func.count(Asset.id), where=where)
        .group_by(key, Asset.bond_status)
        .all()
    )
    groups: dict[str, dict[str, int]] = {}
    none_count = 0
    for group_key, spelling, n in rows:
        if spelling is None:
            none_count += int(n)
            continue
        groups.setdefault(group_key, {})[spelling] = int(n)
    ranked = []
    for spellings in groups.values():
        value = min(spellings, key=lambda s: (-spellings[s], s))
        ranked.append((value, sum(spellings.values())))
    ranked.sort(key=lambda kv: (-kv[1], kv[0].casefold(), kv[0]))
    out = [{"id": v, "label": clean_label(v) or "?", "value": n} for v, n in ranked[:TOP_VINCULOS]]
    rest = sum(n for _, n in ranked[TOP_VINCULOS:])
    if rest:
        out.append({"id": OUTROS_ID, "label": OUTROS_LABEL, "value": rest})
    if none_count:
        out.append({"id": NONE_ID, "label": SEM_VINCULO_LABEL, "value": none_count})
    return out


def registration_gaps(db: Session, actor_id: Any, filters: Any = None) -> dict[str, int]:
    """Pendências de cadastro (um bem pode estar em mais de uma)."""
    where = filter_clauses(db, actor_id, filters)
    row = _active_assets(
        db, actor_id,
        _sum(Asset.responsible_person_id.is_(None)),
        _sum(Asset.room_id.is_(None)),
        _sum(func.lower(Asset.bond_status) == OCIOSO),
        _sum(Asset.located == "NAO"),
        where=where,
    ).one()
    keys = ("sem_responsavel", "sem_sala", "ociosos", "nao_localizados")
    return {k: int(v or 0) for k, v in zip(keys, row)}


def by_room(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    """Bens por sala: top `TOP_SALAS` + `__outras__` (soma exata) + `__none__`
    ("Sem sala"). Rótulo = nome da sala (texto limpo); se o mesmo nome (sem
    caixa) aparece em mais de uma unidade entre as exibidas, acrescenta
    " (SIGLA)" da unidade da sala. `id` da sala serve como `room_id=`.
    """
    where = filter_clauses(db, actor_id, filters)
    rows = (
        _active_assets(db, actor_id, Asset.room_id, func.count(Asset.id), where=where)
        .group_by(Asset.room_id)
        .all()
    )
    none_count = sum(int(n) for rid, n in rows if rid is None)
    counts = {rid: int(n) for rid, n in rows if rid is not None}
    rooms = {}
    if counts:
        rooms = {
            r.id: (clean_label(r.name) or "?", r.unit_id)
            for r in db.query(Room.id, Room.name, Room.unit_id).filter(Room.id.in_(list(counts)))
        }
    ranked = sorted(
        counts.items(),
        key=lambda kv: (-kv[1], rooms.get(kv[0], ("?", None))[0].casefold(), str(kv[0])),
    )
    shown, rest = ranked[:TOP_SALAS], ranked[TOP_SALAS:]
    name_units: dict[str, set[Any]] = {}
    for rid, _n in shown:
        name, unit_id = rooms.get(rid, ("?", None))
        name_units.setdefault(name.casefold(), set()).add(unit_id)
    ambiguous_units = sorted(
        {u for units in name_units.values() if len(units) > 1 for u in units if u is not None}, key=str
    )
    unit_names = _unit_labels(db, ambiguous_units)
    out = []
    for rid, n in shown:
        name, unit_id = rooms.get(rid, ("?", None))
        label = name
        if len(name_units[name.casefold()]) > 1 and unit_id in unit_names:
            label = f"{name} ({unit_names[unit_id]})"
        out.append({"id": str(rid), "label": label, "value": n})
    rest_total = sum(n for _, n in rest)
    if rest_total:
        out.append({"id": OUTRAS_ID, "label": OUTRAS_LABEL, "value": rest_total})
    if none_count:
        out.append({"id": NONE_ID, "label": SEM_SALA_LABEL, "value": none_count})
    return out


def inventory_status(db: Session, actor_id: Any, filters: Any = None) -> dict[str, int]:
    """Conferência mais recente por bem (regra em `_inventory_clause`).

    `conferidos + nao_conferidos = total`; `encontrados + nao_encontrados <=
    conferidos` (conferência com `found` nulo não entra em nenhum dos dois).
    """
    where = filter_clauses(db, actor_id, filters)
    latest = _inventory_latest_found()
    row = _active_assets(
        db, actor_id,
        func.count(Asset.id),
        _sum(_inventory_checked()),
        _sum(latest.is_(True)),
        _sum(latest.is_(False)),
        where=where,
    ).one()
    total, checked, found, missing = (int(v or 0) for v in row)
    return {
        "conferidos": checked,
        "nao_conferidos": total - checked,
        "encontrados": found,
        "nao_encontrados": missing,
    }


def type_options(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    """Opções do filtro "Tipo": top `TOP_TIPOS` por contagem no escopo,
    respeitando os demais filtros (o próprio `tipo` é ignorado).

    Agrega TODAS as descrições distintas (sem `MAX_GRUPOS`) para contagens
    exatas; custo O(descrições distintas) -- ver `_tipo_clause`.
    """
    where = filter_clauses(db, actor_id, filters, skip_tipo=True)
    rows = (
        _active_assets(db, actor_id, Asset.description, func.count(Asset.id), where=where)
        .group_by(Asset.description)
        .all()
    )
    totals: Counter = Counter()
    for description, n in rows:
        totals[infer_type(description)] += int(n)
    ranked = sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_TIPOS]
    return [{"value": value, "count": n} for value, n in ranked]
