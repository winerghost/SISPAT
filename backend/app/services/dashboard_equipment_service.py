"""Dados dos 13 painéis de equipamentos do dashboard (ONDA 2).

Contrato: `docs/architecture/dashboard-api.md` ("Dados dos painéis").

Regras (as mesmas de `dashboard_service`/`dashboard_tech_service`, importadas):
    - só bens ativos (`deleted_at IS NULL`) e SEMPRE no escopo de unidade
      (`asset_scope_clause`, que usa `apply_unit_scope`; ADM sem bypass). Filtro
      de unidade alheio/inexistente == resultado vazio (mesma resposta);
    - só CONTAGENS e RÓTULOS de vocabulário fechado/siglas de unidade; nenhum
      dado pessoal (nem para RH). A fila de revisão devolve identificação do
      BEM (nº patrimonial e descrição), nunca de pessoas;
    - a categoria considerada é a EFETIVA: `category_override` (ADM) prevalece
      sobre `equipment_category` (regra). A família efetiva é derivada da
      categoria efetiva (`CATEGORY_FAMILY`); sem categoria => "não classificado".
      Nenhum valor é inventado;
    - "top N + resto": o resto soma EXATAMENTE o que ficou de fora;
    - a visibilidade do painel por perfil vive no catálogo
      (`dashboard_panels_service.PANELS_BY_ID[...].roles`); `panel_data` NÃO
      confia nisso sozinho: quem chama passa os papéis e o painel proibido
      levanta o MESMO `PanelNotFoundError` do inexistente.

Limitação conhecida de `notebooks_without_docking`: não existe vínculo
notebook <-> docking no banco; o painel compara CONTAGENS por unidade
(`max(notebooks - docking, 0)`), o que é uma estimativa e não uma relação.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Callable, Iterable

from sqlalchemy import func

from app.models.assets import Asset
from app.services.asset_classification import (
    CATEGORY_FAMILY,
    EQUIPMENT_CATEGORIES_BY_FAMILY,
    EQUIPMENT_CATEGORY_LABELS,
    EQUIPMENT_FAMILY_LABELS,
    LOW,
    MOBILIARIO_CATEGORIES,
    NOT_CLASSIFIED,
    OUTROS,
    TI_CATEGORIES,
)
from app.services.dashboard_panels_service import PANELS_BY_ID, allowed_panel_ids
from app.services.dashboard_service import (
    OUTRAS_UNIDADES,
    TOP_UNIDADES,
    _active_assets,
    _unit_labels,
    clean_label,
)

RECENT_OVERRIDES = 10
OVERRIDE_OPERATION = "ASSET_CATEGORY_OVERRIDDEN"

EFFECTIVE_CATEGORY = func.coalesce(Asset.category_override, Asset.equipment_category)

_WORKSTATIONS = ("COMPUTADOR", "NOTEBOOK", "MONITOR")
_INFRASTRUCTURE = ("IMPRESSORA", "NOBREAK", "ESTABILIZADOR", "DOCKING")
_FURNITURE_CARDS = ("GAVETEIRO", "ARMARIO", "MESA", "ESTACAO_TRABALHO")


class PanelNotFoundError(Exception):
    """Painel inexistente, malformado OU proibido ao perfil (mesma resposta 404)."""

    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


# ---------------------------------------------------------------------------
# Filtros e consultas-base
# ---------------------------------------------------------------------------


def family_of(category: str | None) -> str:
    """Família efetiva de uma categoria efetiva (nula => não classificado)."""
    return CATEGORY_FAMILY.get(category, NOT_CLASSIFIED) if category else NOT_CLASSIFIED


def filter_where(filters: Any) -> tuple[Any, ...]:
    """Cláusulas de `unit_id`, `familia` e `categoria` (valor nulo = sem filtro)."""
    clauses: list[Any] = []
    unit_id = getattr(filters, "unit_id", None)
    if unit_id is not None:
        clauses.append(Asset.unit_id == unit_id)
    familia = getattr(filters, "familia", None)
    if familia == NOT_CLASSIFIED:
        clauses.append(EFFECTIVE_CATEGORY.is_(None))
    elif familia is not None:
        clauses.append(EFFECTIVE_CATEGORY.in_(EQUIPMENT_CATEGORIES_BY_FAMILY[familia]))
    categoria = getattr(filters, "categoria", None)
    if categoria == NOT_CLASSIFIED:
        clauses.append(EFFECTIVE_CATEGORY.is_(None))
    elif categoria is not None:
        clauses.append(EFFECTIVE_CATEGORY == categoria)
    return tuple(clauses)


def _category_counts(db: Any, actor_id: Any, where: tuple[Any, ...]) -> Counter:
    rows = (
        _active_assets(db, actor_id, EFFECTIVE_CATEGORY, func.count(Asset.id), where=where)
        .group_by(EFFECTIVE_CATEGORY)
        .all()
    )
    return Counter({category: int(n) for category, n in rows})


def _unit_counts(
    db: Any, actor_id: Any, where: tuple[Any, ...], categories: Iterable[str]
) -> dict[str, Counter]:
    """`{rótulo da unidade: Counter(categoria -> n)}` só das categorias pedidas."""
    categories = tuple(categories)
    rows = (
        _active_assets(
            db, actor_id, Asset.unit_id, EFFECTIVE_CATEGORY, func.count(Asset.id), where=where
        )
        .filter(EFFECTIVE_CATEGORY.in_(categories))
        .group_by(Asset.unit_id, EFFECTIVE_CATEGORY)
        .all()
    )
    names = _unit_labels(db, sorted({r[0] for r in rows}, key=str))
    per_unit: dict[str, Counter] = {}
    for unit_id, category, n in rows:
        per_unit.setdefault(names[unit_id], Counter())[category] += int(n)
    return per_unit


def _columns(categories: Iterable[str]) -> list[dict[str, str]]:
    return [{"id": c, "label": EQUIPMENT_CATEGORY_LABELS[c]} for c in categories]


def _unit_rows(
    per_unit: dict[str, Counter], categories: tuple[str, ...], *, top: int | None
) -> list[dict[str, Any]]:
    items = [
        {
            "unidade": unit,
            "total": sum(counter.values()),
            "valores": {c: counter.get(c, 0) for c in categories},
        }
        for unit, counter in per_unit.items()
    ]
    items.sort(key=lambda item: (-item["total"], item["unidade"]))
    if top is None or len(items) <= top:
        return items
    head, rest = items[:top], items[top:]
    head.append(
        {
            "unidade": OUTRAS_UNIDADES,
            "total": sum(i["total"] for i in rest),
            "valores": {c: sum(i["valores"][c] for i in rest) for c in categories},
        }
    )
    return head


def _ranked(counter: Counter) -> list[dict[str, Any]]:
    """Ranking `unidade -> value` com top N + "Outras" (soma exata)."""
    ranked = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
    items = [{"unidade": u, "value": n} for u, n in ranked[:TOP_UNIDADES]]
    rest = sum(n for _, n in ranked[TOP_UNIDADES:])
    if rest:
        items.append({"unidade": OUTRAS_UNIDADES, "value": rest})
    return items


def _envelope(panel_id: str, tipo: str, dados: dict[str, Any], filters: Any) -> dict[str, Any]:
    names = filters.active_names() if hasattr(filters, "active_names") else []
    return {"panel_id": panel_id, "tipo": tipo, "dados": dados, "filtros_aplicados": names}


# ---------------------------------------------------------------------------
# Construtores por painel (um por ID do catálogo)
# ---------------------------------------------------------------------------


def _cards(panel_id: str, categories: tuple[str, ...]) -> Callable[..., dict[str, Any]]:
    def build(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
        counts = _category_counts(db, actor_id, filter_where(filters))
        items = [
            {"id": c, "label": EQUIPMENT_CATEGORY_LABELS[c], "value": counts.get(c, 0)}
            for c in categories
        ]
        return _envelope(
            panel_id, "cartoes", {"itens": items, "total": sum(i["value"] for i in items)}, filters
        )

    return build


def _unit_table(panel_id: str, categories: tuple[str, ...]) -> Callable[..., dict[str, Any]]:
    def build(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
        per_unit = _unit_counts(db, actor_id, filter_where(filters), categories)
        rows = _unit_rows(per_unit, categories, top=None)
        dados = {
            "colunas": _columns(categories),
            "linhas": rows,
            "total": sum(r["total"] for r in rows),
        }
        return _envelope(panel_id, "tabela", dados, filters)

    return build


def equipment_by_unit_chart(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    """Barras por unidade da família selecionada (padrão TI); top N + "Outras"."""
    familia = getattr(filters, "familia", None)
    family = familia if familia in EQUIPMENT_CATEGORIES_BY_FAMILY else "TI"
    categories = EQUIPMENT_CATEGORIES_BY_FAMILY[family]
    per_unit = _unit_counts(db, actor_id, filter_where(filters), categories)
    rows = _unit_rows(per_unit, categories, top=TOP_UNIDADES)
    dados = {
        "familia": family,
        "familia_label": EQUIPMENT_FAMILY_LABELS[family],
        "series": _columns(categories),
        "unidades": rows,
        "total": sum(r["total"] for r in rows),
    }
    return _envelope("equipment_by_unit_chart", "grafico", dados, filters)


LOCATED_SERIES: tuple[tuple[str, str], ...] = (
    ("SIM", "Localizados"),
    ("NAO", "Não localizados"),
    ("DESCONHECIDO", "Não informado"),
)
LOCATED_IDS = tuple(i for i, _ in LOCATED_SERIES)


def located_unit_ranking(db: Any, actor_id: Any, where: tuple[Any, ...]) -> list[dict[str, Any]]:
    """Unidades do escopo com a contagem por situação de localização.

    Agrupa por `unit_id` (nunca funde unidades de mesmo rótulo); ordem
    determinística `(-total, rótulo, unit_id)`, a mesma do gráfico e do
    clique em "Outras".
    """
    rows = (
        _active_assets(db, actor_id, Asset.unit_id, Asset.located, func.count(Asset.id), where=where)
        .group_by(Asset.unit_id, Asset.located)
        .all()
    )
    names = _unit_labels(db, sorted({r[0] for r in rows}, key=str))
    per_unit: dict[Any, dict[str, int]] = {}
    for unit_id, located, n in rows:
        bucket = per_unit.setdefault(unit_id, {k: 0 for k in LOCATED_IDS})
        bucket[located if located in bucket else "DESCONHECIDO"] += int(n)
    items = [
        {"unit_id": uid, "unidade": names[uid], "total": sum(v.values()), "valores": v}
        for uid, v in per_unit.items()
    ]
    items.sort(key=lambda i: (-i["total"], i["unidade"], str(i["unit_id"])))
    return items


def located_by_unit_chart(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    """Barras SIM/NAO/DESCONHECIDO por unidade; top N + "Outras" (soma exata)."""
    ranking = located_unit_ranking(db, actor_id, filter_where(filters))
    head, rest = ranking[:TOP_UNIDADES], ranking[TOP_UNIDADES:]
    rows = [
        {"unidade": i["unidade"], "unit_id": str(i["unit_id"]), "total": i["total"], "valores": i["valores"]}
        for i in head
    ]
    if rest:
        rows.append(
            {
                "unidade": OUTRAS_UNIDADES,
                "unit_id": None,
                "total": sum(i["total"] for i in rest),
                "valores": {k: sum(i["valores"][k] for i in rest) for k in LOCATED_IDS},
            }
        )
    dados = {
        "series": [{"id": i, "label": label} for i, label in LOCATED_SERIES],
        "unidades": rows,
        "total": sum(r["total"] for r in rows),
    }
    return _envelope("located_by_unit_chart", "grafico", dados, filters)


def category_distribution(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    """Distribuição por família e por categoria (soma == total do filtro)."""
    counts = _category_counts(db, actor_id, filter_where(filters))
    total = sum(counts.values())

    def pct(value: int) -> float | None:
        return round(value * 100.0 / total, 1) if total else None

    families: Counter = Counter()
    for category, n in counts.items():
        families[family_of(category)] += n
    family_order = (*EQUIPMENT_CATEGORIES_BY_FAMILY, NOT_CLASSIFIED)
    categories = [
        {
            "id": c,
            "label": EQUIPMENT_CATEGORY_LABELS[c],
            "familia": family_of(c),
            "value": counts[c],
            "percentual": pct(counts[c]),
        }
        for family in EQUIPMENT_CATEGORIES_BY_FAMILY
        for c in EQUIPMENT_CATEGORIES_BY_FAMILY[family]
        if counts.get(c, 0) > 0
    ]
    if counts.get(None, 0) > 0:
        categories.append(
            {
                "id": NOT_CLASSIFIED,
                "label": EQUIPMENT_CATEGORY_LABELS[NOT_CLASSIFIED],
                "familia": NOT_CLASSIFIED,
                "value": counts[None],
                "percentual": pct(counts[None]),
            }
        )
    dados = {
        "total": total,
        "familias": [
            {
                "id": f,
                "label": EQUIPMENT_FAMILY_LABELS[f],
                "value": families[f],
                "percentual": pct(families[f]),
            }
            for f in family_order
            if families.get(f, 0) > 0
        ],
        "categorias": categories,
    }
    return _envelope("category_distribution", "distribuicao", dados, filters)


def notebooks_without_docking(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    """Por unidade: notebooks, docking stations e `max(notebooks - docking, 0)`."""
    per_unit = _unit_counts(db, actor_id, filter_where(filters), ("NOTEBOOK", "DOCKING"))
    rows = [
        {
            "unidade": unit,
            "notebooks": c.get("NOTEBOOK", 0),
            "docking": c.get("DOCKING", 0),
            "sem_docking": max(c.get("NOTEBOOK", 0) - c.get("DOCKING", 0), 0),
        }
        for unit, c in per_unit.items()
        if c.get("NOTEBOOK", 0) > 0
    ]
    rows.sort(key=lambda r: (-r["sem_docking"], -r["notebooks"], r["unidade"]))
    head, rest = rows[:TOP_UNIDADES], rows[TOP_UNIDADES:]
    if rest:
        head.append(
            {
                "unidade": OUTRAS_UNIDADES,
                **{k: sum(r[k] for r in rest) for k in ("notebooks", "docking", "sem_docking")},
            }
        )
    dados = {
        "metodo": "diferenca_de_contagens_por_unidade",
        "notebooks": sum(r["notebooks"] for r in rows),
        "docking": sum(r["docking"] for r in rows),
        "sem_docking": sum(r["sem_docking"] for r in rows),
        "por_unidade": head,
    }
    return _envelope("notebooks_without_docking", "ranking", dados, filters)


def workstation_ratio(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    counts = _category_counts(db, actor_id, filter_where(filters))
    computers, notebooks, monitors = (counts.get(c, 0) for c in _WORKSTATIONS)

    def ratio(den: int) -> float | None:
        return round(monitors / den, 2) if den else None

    dados = {
        "computadores": computers,
        "notebooks": notebooks,
        "monitores": monitors,
        "monitores_por_computador": ratio(computers),
        "monitores_por_notebook": ratio(notebooks),
    }
    return _envelope("workstation_ratio", "razao", dados, filters)


def review_clauses() -> tuple[Any, ...]:
    """Fila de revisão: regra sem acerto (OUTROS) com confiança BAIXA e sem override."""
    return (
        Asset.category_override.is_(None),
        Asset.equipment_category == OUTROS,
        Asset.classification_confidence == LOW,
    )


def unclassified_review(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    where = (*filter_where(filters), *review_clauses())
    rows = (
        _active_assets(db, actor_id, Asset.unit_id, func.count(Asset.id), where=where)
        .group_by(Asset.unit_id)
        .all()
    )
    names = _unit_labels(db, sorted({r[0] for r in rows}, key=str))
    counter: Counter = Counter()
    for unit_id, n in rows:
        counter[names[unit_id]] += int(n)
    dados = {"total_pendentes": sum(counter.values()), "por_unidade": _ranked(counter)}
    return _envelope("unclassified_review", "fila", dados, filters)


def classification_overrides(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    """Total e distribuição dos overrides ativos + últimas correções (sem autor)."""
    from sqlalchemy import select

    from app.models.audit import AuditLog

    where = (*filter_where(filters), Asset.category_override.is_not(None))
    by_category = {
        c: int(n)
        for c, n in _active_assets(
            db, actor_id, Asset.category_override, func.count(Asset.id), where=where
        ).group_by(Asset.category_override)
    }
    total = sum(by_category.values())
    recent: list[dict[str, Any]] = []
    if total:
        logs = db.execute(
            select(AuditLog)
            .where(AuditLog.entity_type == "asset", AuditLog.operation == OVERRIDE_OPERATION)
            .order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())
            .limit(RECENT_OVERRIDES * 10)
        ).scalars().all()
        ids = [log.entity_id for log in logs]
        found = {
            str(r.id): r
            for r in _active_assets(
                db, actor_id, Asset.id, Asset.patrimony_number, Asset.description,
                Asset.category_override, where=where,
            )
            .filter(Asset.id.in_(_as_uuids(ids)))
            .all()
        }
        for log in logs:
            row = found.get(_canon(log.entity_id))
            if row is None:
                continue
            new = log.new_values or {}
            prev = log.previous_values or {}
            recent.append(
                {
                    "asset_id": str(row.id),
                    "patrimony_number": row.patrimony_number,
                    "description": clean_label(row.description),
                    "categoria_anterior": _label(prev.get("effective_category")),
                    "categoria_nova": _label(new.get("category_override")),
                    "em": log.occurred_at.isoformat() if log.occurred_at else None,
                }
            )
            found.pop(_canon(log.entity_id))  # um item por bem (o mais recente)
            if len(recent) >= RECENT_OVERRIDES:
                break
    dados = {
        "total": total,
        "por_categoria": [
            {"id": c, "label": EQUIPMENT_CATEGORY_LABELS[c], "value": by_category[c]}
            for c in (*TI_CATEGORIES, *MOBILIARIO_CATEGORIES, *EQUIPMENT_CATEGORIES_BY_FAMILY["OUTROS"])
            if by_category.get(c, 0) > 0
        ],
        "recentes": recent,
    }
    return _envelope("classification_overrides", "lista", dados, filters)


def _label(category: Any) -> str | None:
    return EQUIPMENT_CATEGORY_LABELS.get(category) if isinstance(category, str) else None


def _as_uuids(raw_ids: Iterable[Any]) -> list[Any]:
    import uuid

    out = []
    for raw in raw_ids:
        try:
            out.append(uuid.UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            continue
    return out


def _canon(raw: Any) -> str:
    import uuid

    try:
        return str(uuid.UUID(str(raw)))
    except (ValueError, AttributeError, TypeError):
        return ""


def sync_status(db: Any, actor_id: Any, filters: Any) -> dict[str, Any]:
    """Última importação confirmada / último job de sincronização e conflitos pendentes.

    Metadados operacionais (contagens e datas), sem registros de bens. Conflitos
    contam os pendentes cujo bem está no escopo do usuário OU que ainda não têm
    bem associado (registro novo da planilha).
    """
    from sqlalchemy import or_, select

    from app.models.imports import ImportPreview
    from app.models.sync import SyncConflict, SyncJob

    preview = db.execute(
        select(ImportPreview)
        .where(ImportPreview.status == "CONFIRMADA")
        .order_by(ImportPreview.confirmed_at.desc().nulls_last(), ImportPreview.id.desc())
        .limit(1)
    ).scalars().first()
    job = db.execute(
        select(SyncJob).order_by(SyncJob.started_at.desc(), SyncJob.id.desc()).limit(1)
    ).scalars().first()
    in_scope = (
        _active_assets(db, actor_id, Asset.id).filter(Asset.id == SyncConflict.asset_id).exists()
    )
    pending = (
        db.query(func.count(SyncConflict.id))
        .filter(SyncConflict.status == "PENDENTE", or_(SyncConflict.asset_id.is_(None), in_scope))
        .scalar()
    )

    def iso(value: Any) -> str | None:
        return value.isoformat() if value is not None else None

    dados = {
        "ultima_importacao": None
        if preview is None
        else {
            "confirmada_em": iso(preview.confirmed_at),
            "linhas": int(preview.total_rows),
            "novos": int(preview.count_novo),
            "existentes": int(preview.count_existente),
            "duplicados": int(preview.count_duplicado),
            "invalidos": int(preview.count_invalido),
            "conflitantes": int(preview.count_conflitante),
        },
        "ultimo_job": None
        if job is None
        else {
            "status": job.status,
            "iniciado_em": iso(job.started_at),
            "finalizado_em": iso(job.finished_at),
            "lidos": int(job.records_read),
            "criados": int(job.records_created),
            "atualizados": int(job.records_updated),
            "falhas": int(job.records_failed),
        },
        "conflitos_pendentes": int(pending or 0),
    }
    return _envelope("sync_status", "status", dados, filters)


PANEL_BUILDERS: dict[str, Callable[[Any, Any, Any], dict[str, Any]]] = {
    "kpi_workstations": _cards("kpi_workstations", _WORKSTATIONS),
    "kpi_infrastructure": _cards("kpi_infrastructure", _INFRASTRUCTURE),
    "kpi_furniture": _cards("kpi_furniture", _FURNITURE_CARDS),
    "equipment_by_unit_table": _unit_table("equipment_by_unit_table", TI_CATEGORIES),
    "furniture_by_unit_table": _unit_table("furniture_by_unit_table", MOBILIARIO_CATEGORIES),
    "equipment_by_unit_chart": equipment_by_unit_chart,
    "located_by_unit_chart": located_by_unit_chart,
    "category_distribution": category_distribution,
    "notebooks_without_docking": notebooks_without_docking,
    "workstation_ratio": workstation_ratio,
    "unclassified_review": unclassified_review,
    "classification_overrides": classification_overrides,
    "sync_status": sync_status,
}

# Tabelas exportáveis: as mesmas marcadas `exportable` no catálogo.
EXPORT_TABLES: dict[str, tuple[str, ...]] = {
    "equipment_by_unit_table": TI_CATEGORIES,
    "furniture_by_unit_table": MOBILIARIO_CATEGORIES,
}


def authorize_panel(panel_id: Any, roles: Iterable[str] | None) -> str:
    """ID de painel liberado ao perfil; senão `PanelNotFoundError` (mesma resposta)."""
    if (
        not isinstance(panel_id, str)
        or panel_id not in PANELS_BY_ID
        or panel_id not in allowed_panel_ids(roles)
        or panel_id not in PANEL_BUILDERS
    ):
        raise PanelNotFoundError()
    return panel_id


def panel_data(
    db: Any, actor_id: Any, roles: Iterable[str] | None, panel_id: Any, filters: Any
) -> dict[str, Any]:
    return PANEL_BUILDERS[authorize_panel(panel_id, roles)](db, actor_id, filters)
