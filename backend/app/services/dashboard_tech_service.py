"""Agregações dos painéis de Tecnologia (`/api/v1/dashboard/tecnologia/*`).

Mesmas regras de `app.services.dashboard_service` (importadas, não copiadas):
- escopo de bens de `/assets` (`asset_scope_clause`; ADM sem bypass), só bens
  com `deleted_at IS NULL`; escopo vazio => zeros/listas vazias (nunca erro);
- filtros comuns (`DashboardFilters`) via `filter_clauses` + os de
  classificação (`TechFilters`: `categoria`, `tipo_ti`, `status`), E lógico,
  depois do escopo (ID alheio == ID inexistente: resultado vazio);
- só contagens e rótulos de vocabulário fechado/siglas de unidade: nenhum dado
  pessoal (nem para RH). "Sem responsável" é uma CONTAGEM de bens;
- valores nulos aparecem como "não informado"/"não classificado": nenhum
  valor padrão é inventado;
- rankings "top N + resto": o resto soma EXATAMENTE o que ficou de fora;
- "tempo desde o registro" usa `registration_date` (data de cadastro do bem),
  NÃO a idade do equipamento nem a garantia (não há coluna para isso).
"""
from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.assets import Asset
from app.services.asset_classification import (
    CATEGORIES,
    CATEGORY_LABELS,
    NOT_CLASSIFIED,
    NOT_INFORMED,
    OPERATIONAL_STATUSES,
    STATUS_LABELS,
    TECH_TYPE_LABELS,
    TECH_TYPES,
)
from app.services.dashboard_service import (
    OUTRAS_UNIDADES,
    TOP_UNIDADES,
    _active_assets,
    _sum,
    _unit_labels,
    filter_clauses,
)

TECNOLOGIA = "TECNOLOGIA"
NOT_APPLICABLE_LABEL = "Não se aplica"
_AMT = timezone(timedelta(hours=-3))  # America/Araguaina (sem horário de verão)

AGE_BUCKETS = (
    ("ate_1_ano", "Até 1 ano"),
    ("1_a_3_anos", "De 1 a 3 anos"),
    ("3_a_5_anos", "De 3 a 5 anos"),
    ("mais_de_5_anos", "Mais de 5 anos"),
    ("data_futura", "Data futura (inconsistente)"),
    ("sem_data", "Sem data de registro"),
)


def tech_clauses(filters: Any) -> tuple[Any, ...]:
    """Cláusulas de `categoria`, `tipo_ti` e `status` (valor nulo = sem filtro)."""
    clauses: list[Any] = []
    categoria = getattr(filters, "categoria", None)
    if categoria == NOT_CLASSIFIED:
        clauses.append(Asset.asset_category.is_(None))
    elif categoria is not None:
        clauses.append(Asset.asset_category == categoria)
    tipo = getattr(filters, "tipo_ti", None)
    if tipo is not None:
        clauses.append(Asset.asset_category == TECNOLOGIA)
        clauses.append(Asset.tech_type.is_(None) if tipo == NOT_INFORMED else Asset.tech_type == tipo)
    status = getattr(filters, "status", None)
    if status is not None:
        clauses.append(
            Asset.operational_status.is_(None) if status == NOT_INFORMED else Asset.operational_status == status
        )
    return tuple(clauses)


def _where(db: Session, actor_id: Any, filters: Any) -> tuple[Any, ...]:
    return (*filter_clauses(db, actor_id, filters), *tech_clauses(filters))


def _is_tech() -> Any:
    return Asset.asset_category == TECNOLOGIA


def summary(db: Session, actor_id: Any, filters: Any = None) -> dict[str, Any]:
    where = _where(db, actor_id, filters)
    row = _active_assets(
        db,
        actor_id,
        func.count(Asset.id),
        _sum(_is_tech()),
        _sum(Asset.asset_category.is_(None)),
        _sum(_is_tech() & Asset.responsible_person_id.is_(None)),
        _sum(_is_tech() & Asset.tech_type.is_(None)),
        _sum(_is_tech() & Asset.operational_status.is_(None)),
        where=where,
    ).one()
    keys = (
        "total_bens", "tecnologia", "nao_classificados",
        "tecnologia_sem_responsavel", "tecnologia_sem_tipo", "tecnologia_sem_status",
    )
    return {k: int(v or 0) for k, v in zip(keys, row)}


def _ordered(counts: dict[str | None, int], order: tuple[str, ...], labels: dict[str, str], null_id: str):
    items = [
        {"id": key, "label": labels[key], "value": counts[key]}
        for key in order
        if counts.get(key, 0) > 0
    ]
    if counts.get(None, 0) > 0:
        items.append({"id": null_id, "label": labels[null_id], "value": counts[None]})
    return items


def by_category(db: Session, actor_id: Any, filters: Any = None) -> dict[str, Any]:
    """Distribuição por categoria (todos os bens do filtro; soma == total) e por
    tipo de TI (só TECNOLOGIA)."""
    where = _where(db, actor_id, filters)
    cats = {
        k: int(n)
        for k, n in _active_assets(db, actor_id, Asset.asset_category, func.count(Asset.id), where=where)
        .group_by(Asset.asset_category)
    }
    types = {
        k: int(n)
        for k, n in _active_assets(db, actor_id, Asset.tech_type, func.count(Asset.id), where=where)
        .filter(_is_tech())
        .group_by(Asset.tech_type)
    }
    return {
        "categorias": _ordered(cats, CATEGORIES, CATEGORY_LABELS, NOT_CLASSIFIED),
        "tipos_ti": _ordered(types, TECH_TYPES, TECH_TYPE_LABELS, NOT_INFORMED),
    }


def by_unit(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    """Bens de TI por unidade de uso e tipo de TI: top `TOP_UNIDADES` por total
    + "Outras" (soma exata, inclusive por tipo)."""
    where = _where(db, actor_id, filters)
    rows = (
        _active_assets(db, actor_id, Asset.unit_id, Asset.tech_type, func.count(Asset.id), where=where)
        .filter(_is_tech())
        .group_by(Asset.unit_id, Asset.tech_type)
        .all()
    )
    if not rows:
        return []
    names = _unit_labels(db, sorted({r[0] for r in rows}, key=str))
    per_unit: dict[str, Counter] = {}
    for unit_id, tech_type, n in rows:
        label = TECH_TYPE_LABELS[tech_type or NOT_INFORMED]
        per_unit.setdefault(names[unit_id], Counter())[label] += int(n)
    items = [
        {"unidade": unit, "total": sum(c.values()), "tipos": dict(sorted(c.items(), key=lambda kv: (-kv[1], kv[0])))}
        for unit, c in per_unit.items()
    ]
    items.sort(key=lambda item: (-item["total"], item["unidade"]))
    top, rest = items[:TOP_UNIDADES], items[TOP_UNIDADES:]
    if rest:
        merged: Counter = Counter()
        for item in rest:
            merged.update(item["tipos"])
        top.append(
            {
                "unidade": OUTRAS_UNIDADES,
                "total": sum(i["total"] for i in rest),
                "tipos": dict(sorted(merged.items(), key=lambda kv: (-kv[1], kv[0]))),
            }
        )
    return top


def by_status(db: Session, actor_id: Any, filters: Any = None) -> list[dict[str, Any]]:
    where = _where(db, actor_id, filters)
    counts = {
        k: int(n)
        for k, n in _active_assets(db, actor_id, Asset.operational_status, func.count(Asset.id), where=where)
        .filter(_is_tech())
        .group_by(Asset.operational_status)
    }
    return _ordered(counts, OPERATIONAL_STATUSES, STATUS_LABELS, NOT_INFORMED)


def without_owner(db: Session, actor_id: Any, filters: Any = None) -> dict[str, Any]:
    """Bens de TI sem responsável: totais e ranking por unidade (só contagens)."""
    where = _where(db, actor_id, filters)
    total, missing = _active_assets(
        db, actor_id, func.count(Asset.id), _sum(Asset.responsible_person_id.is_(None)), where=where
    ).filter(_is_tech()).one()
    total, missing = int(total or 0), int(missing or 0)
    per_unit: list[dict[str, Any]] = []
    if missing:
        rows = (
            _active_assets(db, actor_id, Asset.unit_id, func.count(Asset.id), where=where)
            .filter(_is_tech(), Asset.responsible_person_id.is_(None))
            .group_by(Asset.unit_id)
            .all()
        )
        names = _unit_labels(db, sorted({r[0] for r in rows}, key=str))
        counts: Counter = Counter()
        for unit_id, n in rows:
            counts[names[unit_id]] += int(n)
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        per_unit = [{"unidade": u, "value": n} for u, n in ranked[:TOP_UNIDADES]]
        rest = sum(n for _, n in ranked[TOP_UNIDADES:])
        if rest:
            per_unit.append({"unidade": OUTRAS_UNIDADES, "value": rest})
    return {
        "tecnologia": total,
        "sem_responsavel": missing,
        "percentual": round(missing * 100.0 / total, 1) if total else None,
        "por_unidade": per_unit,
    }


def _years_ago(today: date, years: int) -> date:
    try:
        return today.replace(year=today.year - years)
    except ValueError:  # 29/02
        return today.replace(year=today.year - years, day=28)


def registration_age(
    db: Session, actor_id: Any, filters: Any = None, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    """Bens de TI por TEMPO DESDE O REGISTRO (`registration_date`), em faixas.

    Não é a idade do equipamento. A data de referência é "hoje" em
    America/Araguaina (UTC-3 fixo). Datas futuras e bens sem data ficam em
    faixas próprias (honestas), nunca somados às demais.
    """
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(_AMT).date()
    d1, d3, d5 = _years_ago(today, 1), _years_ago(today, 3), _years_ago(today, 5)
    reg = Asset.registration_date
    row = _active_assets(
        db,
        actor_id,
        _sum(reg.is_not(None) & (reg <= today) & (reg > d1)),
        _sum(reg.is_not(None) & (reg <= d1) & (reg > d3)),
        _sum(reg.is_not(None) & (reg <= d3) & (reg > d5)),
        _sum(reg.is_not(None) & (reg <= d5)),
        _sum(reg.is_not(None) & (reg > today)),
        _sum(reg.is_(None)),
        where=_where(db, actor_id, filters),
    ).filter(_is_tech()).one()
    return [
        {"id": key, "label": label, "value": int(n or 0)}
        for (key, label), n in zip(AGE_BUCKETS, row)
        if int(n or 0) > 0
    ]


def export_table(db: Session, actor_id: Any, filters: Any = None) -> tuple[list[str], list[list[str]]]:
    """Tabela agregada (unidade × categoria × tipo de TI × situação -> quantidade).

    Sem linha por bem e sem dados pessoais. Ordem determinística.
    """
    where = _where(db, actor_id, filters)
    rows = (
        _active_assets(
            db, actor_id, Asset.unit_id, Asset.asset_category, Asset.tech_type, Asset.operational_status,
            func.count(Asset.id), where=where,
        )
        .group_by(Asset.unit_id, Asset.asset_category, Asset.tech_type, Asset.operational_status)
        .all()
    )
    names = _unit_labels(db, sorted({r[0] for r in rows}, key=str))
    table = []
    for unit_id, category, tech_type, status, n in rows:
        if category == TECNOLOGIA:
            type_label = TECH_TYPE_LABELS[tech_type or NOT_INFORMED]
        else:
            type_label = NOT_APPLICABLE_LABEL
        table.append(
            [
                names[unit_id],
                CATEGORY_LABELS[category or NOT_CLASSIFIED],
                type_label,
                STATUS_LABELS[status or NOT_INFORMED],
                str(int(n)),
            ]
        )
    table.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
    return ["Unidade", "Categoria", "Tipo de TI", "Situação operacional", "Quantidade"], table


ENTITY_TYPE_EXPORT = "dashboard_tech_export"
OP_TECH_EXPORTED = "DASHBOARD_TECH_EXPORTED"


def export_tech(db: Session, actor_id: Any, query: Any, *, request_id: str | None = None):
    """CSV/XLSX da tabela agregada, com auditoria na MESMA transação.

    Toda célula (cabeçalho incluído) passa por `app.security.csv_safety`
    (`report_export`). A auditoria guarda formato, nº de linhas e os NOMES dos
    filtros (nunca valores nem conteúdo). Acima de `MAX_EXPORT_ROWS` => 413.
    """
    import uuid

    from app.models.audit import AuditLog
    from app.services import report_export as export
    from app.services.report_catalog import MAX_EXPORT_ROWS
    from app.services.report_service import ExportResult, ReportTooLargeError

    header, table = export_table(db, actor_id, query)
    if len(table) > MAX_EXPORT_ROWS:
        raise ReportTooLargeError()
    if query.format == "xlsx":
        content, mimetype = export.to_xlsx_bytes(header, table, sheet_name="Tecnologia"), export.XLSX_MIMETYPE
    else:
        content, mimetype = export.to_csv_bytes(header, table), export.CSV_MIMETYPE
    db.add(
        AuditLog(
            id=uuid.uuid4(),
            actor_user_id=actor_id,
            entity_type=ENTITY_TYPE_EXPORT,
            entity_id="tecnologia",
            operation=OP_TECH_EXPORTED,
            previous_values=None,
            new_values={"format": query.format, "rows": len(table), "filters": query.active_names()},
            request_id=request_id,
            result="SUCESSO",
        )
    )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ExportResult(content, mimetype, f"sispat-tecnologia-{stamp}.{query.format}", len(table))
