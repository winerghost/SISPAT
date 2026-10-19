"""Ferramentas SOMENTE LEITURA do "Pergunte ao SISPAT" (Etapa 4b).

O LLM só pode PEDIR uma ferramenta por nome + argumentos; quem executa é este
módulo, com as garantias abaixo:

    - Allowlist fechada (`TOOLS`): nome fora dela => recusada (nada executa).
    - Argumentos validados por schema Pydantic `extra="forbid"` + `strict`:
      qualquer campo extra (inclusive `unit_id`, `sql`, `where`) é rejeitado.
    - Escopo: TODA consulta passa por `apply_unit_scope` com o usuário
      autenticado (`ctx.user_id`); a unidade nunca vem do LLM nem do cliente.
    - Nunca SQL do LLM: as consultas são fixas no código (ORM parametrizado).
    - Privacidade: o resultado é um dict com chaves da allowlist de
      `redaction.ALLOWED_FIELDS`. Ferramentas que tocam responsáveis
      (`touches_responsibles=True`) devolvem APENAS contagens inteiras, para
      qualquer perfil (RH incluído); nenhuma ferramenta devolve nome, e-mail
      ou matrícula. Rótulos de sala são dado importado NÃO CONFIÁVEL: seguem
      para o LLM somente dentro de `<dados>` (ver `prompting`).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError
from sqlalchemy import func

from app.authorization.rbac import apply_unit_scope
from app.models.assets import Asset
from app.models.units import Room

logger = logging.getLogger(__name__)

STATUS_OK = "ok"
STATUS_REFUSED = "refused"
STATUS_INVALID = "invalid"

REFUSED_RESULT: dict[str, Any] = {"status": "recusada"}
INVALID_RESULT: dict[str, Any] = {"status": "argumentos_invalidos"}


@dataclass(frozen=True)
class ToolContext:
    db: Any
    user_id: Any
    role_codes: frozenset[str]


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NoArgs(_Args):
    pass


class ContarBensArgs(_Args):
    filtro: Literal["todos", "sem_responsavel", "sem_localizacao"] = "todos"


class BensPorSalaArgs(_Args):
    limite: StrictInt = Field(default=10, ge=1, le=20)


@dataclass(frozen=True)
class Tool:
    name: str
    args_model: type[_Args]
    run: Callable[[ToolContext, Any], dict[str, Any]]
    touches_responsibles: bool = False


@dataclass(frozen=True)
class ToolOutcome:
    status: str  # STATUS_*
    tool: str  # nome da ferramenta executada, ou rótulo fixo se recusada/inválida
    result: dict[str, Any]


def _scoped_assets(ctx: ToolContext, *columns: Any):
    query = ctx.db.query(*columns).select_from(Asset).filter(Asset.deleted_at.is_(None))
    return apply_unit_scope(query, Asset.unit_id, ctx.user_id, ctx.db)


def _contar_bens(ctx: ToolContext, args: ContarBensArgs) -> dict[str, Any]:
    query = _scoped_assets(ctx, func.count(Asset.id))
    if args.filtro == "sem_responsavel":
        query = query.filter(Asset.responsible_person_id.is_(None), Asset.assigned_user_id.is_(None))
    elif args.filtro == "sem_localizacao":
        query = query.filter(Asset.room_id.is_(None), Asset.location_id.is_(None))
    return {"category": args.filtro, "count": int(query.scalar() or 0)}


def _listar_alertas(ctx: ToolContext, _args: NoArgs) -> dict[str, Any]:
    from app.services.alerts import evaluate_alerts

    payload = evaluate_alerts(ctx.user_id)
    return {
        "alerts": [
            {"alert_type": i["code"], "severity": i["severity"], "count": i["count"]}
            for i in payload.get("items", [])
        ]
    }


def _bens_por_sala(ctx: ToolContext, args: BensPorSalaArgs) -> dict[str, Any]:
    query = (
        _scoped_assets(ctx, Room.name, func.count(Asset.id).label("n"))
        # A sala precisa ser da MESMA unidade do bem (dado inconsistente não vaza).
        .join(Room, (Room.id == Asset.room_id) & (Room.unit_id == Asset.unit_id))
        .group_by(Room.id, Room.name)
        .order_by(func.count(Asset.id).desc(), Room.name)
        .limit(args.limite)
    )
    return {"items": [{"room_label": str(r[0] or "")[:80], "count": int(r[1])} for r in query.all()]}


def _contagem_responsaveis(ctx: ToolContext, _args: NoArgs) -> dict[str, Any]:
    total = int(_scoped_assets(ctx, func.count(Asset.id)).scalar() or 0)
    without = int(
        _scoped_assets(ctx, func.count(Asset.id))
        .filter(Asset.responsible_person_id.is_(None), Asset.assigned_user_id.is_(None))
        .scalar()
        or 0
    )
    # Apenas contagens (RH e demais perfis): nenhum nome/identificador.
    return {"total": max(0, total - without), "count": without}


TOOLS: Mapping[str, Tool] = {
    tool.name: tool
    for tool in (
        Tool("contar_bens", ContarBensArgs, _contar_bens),
        Tool("listar_alertas", NoArgs, _listar_alertas),
        Tool("bens_por_sala", BensPorSalaArgs, _bens_por_sala),
        Tool("contagem_responsaveis", NoArgs, _contagem_responsaveis, touches_responsibles=True),
    )
}

REFUSED_LABEL = "(ferramenta nao permitida)"


def execute_tool(name: Any, raw_args: Any, ctx: ToolContext) -> ToolOutcome:
    """Executa `name` se estiver na allowlist e os argumentos forem válidos.

    Nunca lança: erro de execução vira resultado `argumentos_invalidos`/vazio
    sem detalhes (só o nome da exceção no log).
    """
    tool = TOOLS.get(name) if isinstance(name, str) else None
    if tool is None:
        return ToolOutcome(STATUS_REFUSED, REFUSED_LABEL, dict(REFUSED_RESULT))
    try:
        args = tool.args_model.model_validate({} if raw_args is None else raw_args)
    except ValidationError:
        return ToolOutcome(STATUS_INVALID, tool.name, dict(INVALID_RESULT))
    try:
        result = tool.run(ctx, args)
    except Exception as exc:  # noqa: BLE001 - ferramenta nunca derruba a pergunta
        logger.error("ai_tools: ferramenta '%s' falhou (%s)", tool.name, type(exc).__name__)
        return ToolOutcome(STATUS_INVALID, tool.name, dict(INVALID_RESULT))
    return ToolOutcome(STATUS_OK, tool.name, result)
