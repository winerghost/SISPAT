"""Uso da IA: auditoria `AI_USAGE`, teto mensal de tokens e rate limit.

Auditoria (`audit_logs`, append-only):
    entity_type="ai", entity_id=<feature>, operation="AI_USAGE",
    new_values={provider, model, feature, tokens_in, tokens_out, outcome,
    error_kind, unit_id} — NUNCA prompt, resposta, dados enviados ou chave.

Contador mensal (Redis): `sispat:ai:tokens:<AAAA-MM>` (UTC), TTL de 40 dias.
AI-QUOTA-01: antes de cada chamada RESERVA-se o teto estimado
(`max_tokens` + entrada estimada) com INCRBY atômico; se o contador já
estava no teto, a reserva é desfeita e a chamada vira NullProvider. Depois
da chamada a reserva é ajustada ao consumo real (`settle_token_reservation`).
Como a decisão usa o valor devolvido pelo próprio INCRBY, requisições
concorrentes enxergam as reservas umas das outras: o excesso máximo sobre o
teto é UMA reserva (não N), mesmo em rajada.

Atomicidade (AI-RL-01): contador e TTL são criados juntos numa transação
MULTI/EXEC (`SET key 0 EX ttl NX` + `INCR`/`INCRBY`), de modo que a chave
nunca fica sem TTL se uma das operações falhar.

Rate limit por usuário e por unidade (janela de 1 h): mesmo prefixo de chave
de `app.security.rate_limit`. O
decorator daquele módulo devolve respostas Flask e serve para ROTAS (ex.:
`POST /settings/ai/test` 5/h); aqui o limite é consultado dentro do serviço,
por isso a função `consume_rate_limit` abaixo.

Falha fechada: Redis indisponível => cota considerada esgotada e rate
limit negado (a IA fica indisponível; o sistema segue normal).
Nenhuma função deste módulo lança exceção.
"""
from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from app.security.rate_limit import _RATE_LIMIT_KEY_PREFIX

logger = logging.getLogger(__name__)

AI_USAGE_OPERATION = "AI_USAGE"
AI_ENTITY_TYPE = "ai"
RATE_LIMIT_WINDOW_SECONDS = 3600
_TOKENS_KEY_PREFIX = "sispat:ai:tokens"
_TOKENS_TTL_SECONDS = 40 * 24 * 3600


# ---------------------------------------------------------------------------
# Teto mensal de tokens
# ---------------------------------------------------------------------------


def monthly_tokens_key(now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    return f"{_TOKENS_KEY_PREFIX}:{moment.astimezone(timezone.utc):%Y-%m}"


def get_monthly_tokens(redis_client: Any | None, now: datetime | None = None) -> int | None:
    """Tokens consumidos no mês (UTC); None se o Redis estiver indisponível."""
    if redis_client is None:
        return None
    try:
        raw = redis_client.get(monthly_tokens_key(now))
        return int(raw) if raw is not None else 0
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_usage: Redis indisponível ao ler cota (%s)", type(exc).__name__)
        return None


def monthly_quota_exhausted(redis_client: Any | None, cap: int, now: datetime | None = None) -> bool:
    """True se a cota mensal acabou OU se não for possível verificar (falha fechada)."""
    if cap <= 0:
        return True
    used = get_monthly_tokens(redis_client, now)
    return used is None or used >= cap


def _atomic_incrby(redis_client: Any, key: str, amount: int, ttl_seconds: int) -> int:
    """INCRBY com TTL garantido, numa transação MULTI/EXEC. Pode lançar."""
    pipe = redis_client.pipeline(transaction=True)
    pipe.set(key, 0, ex=ttl_seconds, nx=True)
    pipe.incrby(key, int(amount))
    results = pipe.execute()
    return int(results[-1])


def add_monthly_tokens(redis_client: Any | None, tokens: int, now: datetime | None = None) -> None:
    if redis_client is None or tokens <= 0:
        return
    try:
        _atomic_incrby(redis_client, monthly_tokens_key(now), int(tokens), _TOKENS_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_usage: falha ao somar tokens (%s)", type(exc).__name__)


@dataclass(frozen=True)
class TokenReservation:
    """Reserva de tokens no contador mensal (chave fixada no momento da reserva)."""

    key: str
    amount: int


def estimate_tokens(*texts: str) -> int:
    """Estimativa conservadora de tokens de entrada (~3 caracteres por token)."""
    return math.ceil(sum(len(t or "") for t in texts) / 3)


def reserve_monthly_tokens(
    redis_client: Any | None, amount: int, cap: int, now: datetime | None = None
) -> TokenReservation | None:
    """Reserva `amount` tokens atomicamente; None => negar (teto ou Redis fora).

    Nega se o contador JÁ estava no teto antes desta reserva (valor devolvido
    pelo INCRBY menos `amount`), desfazendo-a. O critério "antes da reserva"
    mantém o comportamento sequencial documentado (uma chamada que começa
    abaixo do teto é atendida) e, por ser decidido sobre o resultado atômico
    do INCRBY, limita o excesso concorrente a uma única reserva.
    """
    if redis_client is None or cap <= 0:
        return None
    amount = max(1, int(amount))
    key = monthly_tokens_key(now)
    try:
        total = _atomic_incrby(redis_client, key, amount, _TOKENS_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_usage: Redis indisponível ao reservar tokens (%s)", type(exc).__name__)
        return None
    if total - amount >= cap:
        try:
            redis_client.incrby(key, -amount)
        except Exception as exc:  # noqa: BLE001 - falha fechada: sobra reserva
            logger.warning("ai_usage: falha ao desfazer reserva (%s)", type(exc).__name__)
        return None
    return TokenReservation(key=key, amount=amount)


def settle_token_reservation(redis_client: Any | None, reservation: TokenReservation, actual_tokens: int) -> None:
    """Troca a reserva pelo consumo real (delta pode ser negativo). Nunca lança."""
    if redis_client is None:
        return
    delta = max(0, int(actual_tokens)) - reservation.amount
    if delta == 0:
        return
    try:
        redis_client.incrby(reservation.key, delta)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_usage: falha ao ajustar reserva de tokens (%s)", type(exc).__name__)


# ---------------------------------------------------------------------------
# Rate limit por usuário / unidade
# ---------------------------------------------------------------------------


def ai_user_rate_key(user_id: Any) -> str:
    return f"{_RATE_LIMIT_KEY_PREFIX}:ai:user:{user_id}"


def ai_unit_rate_key(unit_id: Any) -> str:
    return f"{_RATE_LIMIT_KEY_PREFIX}:ai:unit:{unit_id}"


def consume_rate_limit(
    redis_client: Any | None, key: str, limit: int, window_seconds: int = RATE_LIMIT_WINDOW_SECONDS
) -> bool:
    """Consome 1 da janela; True se permitido. Redis fora => False (nega)."""
    if redis_client is None:
        return False
    try:
        # AI-RL-01: SET NX EX + INCR na mesma transação (chave nunca sem TTL).
        count = _atomic_incrby(redis_client, key, 1, window_seconds)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ai_usage: Redis indisponível no rate limit (%s)", type(exc).__name__)
        return False
    return count <= limit


def check_ai_rate_limit(
    redis_client: Any | None,
    *,
    user_id: Any,
    unit_id: Any | None,
    per_user: int,
    per_unit: int,
) -> bool:
    """True se o usuário (e a unidade, quando informada) ainda têm cota na hora."""
    if not consume_rate_limit(redis_client, ai_user_rate_key(user_id), per_user):
        return False
    if unit_id is not None and not consume_rate_limit(redis_client, ai_unit_rate_key(unit_id), per_unit):
        return False
    return True


# ---------------------------------------------------------------------------
# Auditoria AI_USAGE
# ---------------------------------------------------------------------------


def build_usage_values(
    *,
    provider: str,
    model: str | None,
    feature: str,
    tokens_in: int,
    tokens_out: int,
    ok: bool,
    error_kind: str | None,
    unit_id: Any | None = None,
) -> dict[str, Any]:
    """Somente metadados — nunca conteúdo."""
    return {
        "provider": provider,
        "model": model,
        "feature": feature,
        "tokens_in": int(tokens_in),
        "tokens_out": int(tokens_out),
        "outcome": "ok" if ok else "degraded",
        "error_kind": error_kind,
        "unit_id": str(unit_id) if unit_id is not None else None,
    }


def _default_writer(row: Any) -> None:
    from app.database.session import get_db_session

    with get_db_session() as db:
        db.add(row)


def record_ai_usage(
    *,
    actor_user_id: Any,
    values: dict[str, Any],
    ok: bool,
    db_session: Any | None = None,
    writer: Callable[[Any], None] | None = None,
) -> None:
    """Grava `AI_USAGE` em audit_logs. Nunca lança.

    `db_session` (opcional): sessão do chamador — a linha é adicionada e o
    COMMIT fica a cargo do chamador. Sem sessão, usa uma sessão própria.
    `writer` (testes): recebe o `AuditLog` montado.
    """
    try:
        from app.models.audit import AuditLog

        try:
            actor = uuid.UUID(str(actor_user_id)) if actor_user_id is not None else None
        except (ValueError, TypeError):
            actor = None
        row = AuditLog(
            id=uuid.uuid4(),
            actor_user_id=actor,
            entity_type=AI_ENTITY_TYPE,
            entity_id=str(values.get("feature") or "")[:100] or None,
            operation=AI_USAGE_OPERATION,
            previous_values=None,
            new_values=values,
            result="SUCESSO" if ok else "FALHA",
        )
        if writer is not None:
            writer(row)
        elif db_session is not None:
            db_session.add(row)
        else:
            _default_writer(row)
    except Exception as exc:  # noqa: BLE001 - auditoria nunca derruba a chamada
        logger.error("ai_usage: falha ao gravar AI_USAGE (%s)", type(exc).__name__)
