"""Orquestra o "Pergunte ao SISPAT" (Etapa 4b): pergunta -> ferramentas -> resposta.

Function calling por protocolo de TEXTO (os provedores desta base não usam a
API nativa de ferramentas): o modelo responde ou com texto simples (resposta
final) ou com uma linha JSON `{"tool": "...", "args": {...}}`. Este módulo é o
único que decide o que executa:

    - no máximo `MAX_TOOL_CALLS` (3) ferramentas por pergunta; um 4º pedido
      => `unavailable`;
    - ferramenta fora da allowlist => recusada (vira resultado "recusada" nos
      dados; nada é executado; não entra em `tools_used`);
    - JSON malformado que pareça pedido de ferramenta => `unavailable`;
    - toda chamada ao provedor passa por `AIService.run_feature` (flag
      `assistant`, redação LGPD, circuito, cota, rate limit por usuário e por
      unidade, auditoria `AI_USAGE` sem conteúdo). A pergunta e os resultados
      das ferramentas vão dentro de `<dados>` (não confiáveis).
    - a resposta é texto puro, sem caracteres de controle, truncada.

Nunca lança: qualquer falha => `AskOutcome("unavailable")`; estouro do rate
limit => `AskOutcome("rate_limited")`.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable, Literal

from app.config.settings import Settings
from app.services.ai.base import ERROR_LOCAL_RATE_LIMITED
from app.services.ai.factory import _AUTO, AIConfig
from app.services.ai.models import FEATURE_ASSISTANT
from app.services.ai.prompting import sanitize_output
from app.services.ai.service import AIActor, AIService
from app.services.ai.tools import STATUS_OK, ToolContext, execute_tool

logger = logging.getLogger(__name__)

MAX_TOOL_CALLS = 3
MAX_ANSWER_CHARS = 2000
MAX_QUESTION_CHARS = 500

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)

AskStatus = Literal["ok", "unavailable", "rate_limited"]


@dataclass(frozen=True)
class AskOutcome:
    status: AskStatus
    answer: str = ""
    tools_used: tuple[str, ...] = ()


@dataclass(frozen=True)
class ParsedReply:
    kind: Literal["text", "call", "malformed"]
    tool: Any = None
    args: Any = None


def parse_reply(text: str) -> ParsedReply:
    """Distingue resposta final (texto) de pedido de ferramenta (JSON)."""
    stripped = _FENCE.sub("", text.strip()).strip()
    if not stripped.startswith("{"):
        return ParsedReply("text")
    try:
        data = json.loads(stripped)
    except ValueError:
        return ParsedReply("malformed")
    if not isinstance(data, dict) or "tool" not in data or not set(data) <= {"tool", "args"}:
        return ParsedReply("malformed")
    return ParsedReply("call", tool=data.get("tool"), args=data.get("args"))


def ask(
    question: str,
    *,
    config: AIConfig,
    user_id: Any,
    unit_id: Any | None,
    role_codes: frozenset[str],
    session_factory: Callable[[], Any],
    settings: Settings | None = None,
    redis_client: Any = _AUTO,
    http_session: Any | None = None,
    audit_writer: Any | None = None,
) -> AskOutcome:
    try:
        return _ask(
            question, config=config, user_id=user_id, unit_id=unit_id, role_codes=role_codes,
            session_factory=session_factory, settings=settings, redis_client=redis_client,
            http_session=http_session, audit_writer=audit_writer,
        )
    except Exception as exc:  # noqa: BLE001 - degradação graciosa
        logger.error("ai_assistant: erro inesperado (%s)", type(exc).__name__)
        return AskOutcome("unavailable")


def _ask(
    question: str, *, config: AIConfig, user_id: Any, unit_id: Any | None, role_codes: frozenset[str],
    session_factory: Callable[[], Any], settings: Settings | None, redis_client: Any,
    http_session: Any | None, audit_writer: Any | None,
) -> AskOutcome:
    if not isinstance(question, str) or not (1 <= len(question.strip()) <= MAX_QUESTION_CHARS):
        return AskOutcome("unavailable")
    service = AIService(
        config, settings=settings, redis_client=redis_client, http_session=http_session,
        audit_writer=audit_writer,
    )
    actor = AIActor(user_id=user_id, unit_id=unit_id)
    items: list[dict[str, Any]] = []
    used: list[str] = []
    for _ in range(MAX_TOOL_CALLS + 1):
        result = service.run_feature(FEATURE_ASSISTANT, {"question": question.strip(), "items": items}, actor)
        if not result.ok:
            if result.error_kind == ERROR_LOCAL_RATE_LIMITED:
                return AskOutcome("rate_limited")
            return AskOutcome("unavailable")
        reply = parse_reply(result.text)
        if reply.kind == "text":
            answer = sanitize_output(result.text, MAX_ANSWER_CHARS)
            return AskOutcome("ok", answer, tuple(used)) if answer else AskOutcome("unavailable")
        if reply.kind == "malformed" or len(items) >= MAX_TOOL_CALLS:
            return AskOutcome("unavailable")
        with session_factory() as db:
            outcome = execute_tool(reply.tool, reply.args, ToolContext(db=db, user_id=user_id, role_codes=role_codes))
        items.append({"tool": outcome.tool, "result": outcome.result})
        if outcome.status == STATUS_OK:
            used.append(outcome.tool)
    return AskOutcome("unavailable")
