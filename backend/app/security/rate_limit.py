"""Limitação de tentativas (rate limiting) baseada em Redis.

Decorator `@rate_limit(key_func, limit, window_seconds)`, pensado para ser
aplicado em QUALQUER rota sensível a abuso por tentativas repetidas — o caso
de uso imediato previsto é o endpoint de convite de usuários (implementado
em outra frente de trabalho), mas o decorator não é específico desse
endpoint e pode ser reaproveitado por qualquer rota futura (ex.: tentativas
de recuperação de MFA, reenvio de convite, etc.).

Mecanismo: um contador Redis incremental (`INCR`) com TTL (`EXPIRE`,
aplicado de forma idempotente apenas quando o contador é criado, ou seja,
quando `INCR` retorna `1`) por chave de limitação. A chave é construída a
partir de um prefixo fixo, do nome qualificado da view decorada e do valor
retornado por `key_func(*args, **kwargs)` — tipicamente algo que identifica
quem está fazendo a requisição (ex.: IP, e-mail do corpo, id do usuário
autenticado), para que o limite seja aplicado por esse identificador, não
globalmente para todos os chamadores.

Se o limite (`limit`) for excedido dentro da janela (`window_seconds`), a
requisição é bloqueada com `429 Too Many Requests`, corpo JSON
padronizado:

    {"error": {"code": "rate_limited", "message": "..."}}

Comportamento quando o Redis está inacessível (`fail_open`):
    Por padrão (`fail_open=False`), uma falha ao falar com o Redis BLOQUEIA
    a requisição (503) — a limitação de tentativas é tratada como um
    controle de segurança que não deve ser contornável apenas por uma falha
    de infraestrutura. Rotas administrativas/sensíveis críticas (ex.:
    convites) DEVEM manter `fail_open=False` em produção.

    `fail_open=True` permite a requisição passar sem limitação quando o
    Redis está inacessível — útil apenas para rotas onde a disponibilidade
    importa mais do que a limitação estrita, ou em ambientes de teste/CI
    sem um Redis real disponível. Isso é documentado explicitamente aqui
    para que ninguém o use por engano em uma rota crítica: NUNCA usar
    `fail_open=True` em produção para rotas administrativas críticas
    (convites, gestão de usuários, segurança).

Injeção de dependência para testes: o parâmetro `redis_client` permite
passar um cliente Redis (ou um mock) diretamente, em vez de construir um a
partir de `settings.redis_url` — os testes deste módulo sempre usam um mock,
nunca uma conexão Redis real.
"""
from __future__ import annotations

import logging
from functools import wraps
from typing import Any, Callable, TypeVar

import redis
from flask import jsonify

from app.config.settings import get_settings

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

_RATE_LIMIT_KEY_PREFIX = "sispat:ratelimit"


def _build_redis_client(redis_url: str) -> redis.Redis:
    return redis.Redis.from_url(redis_url)


def rate_limit(
    key_func: Callable[..., str],
    limit: int,
    window_seconds: int,
    *,
    fail_open: bool = False,
    redis_client: redis.Redis | None = None,
) -> Callable[[F], F]:
    """Decorator-factory: limita chamadas à view decorada a `limit` por
    `window_seconds`, por chave retornada por `key_func(*args, **kwargs)`.

    Args:
        key_func: função que recebe os mesmos argumentos da view decorada
            e retorna uma string identificando quem está fazendo a
            requisição (ex.: IP, e-mail, id de usuário). O limite é
            aplicado por essa chave, não globalmente.
        limit: número máximo de chamadas permitidas dentro da janela.
        window_seconds: duração da janela de contagem, em segundos.
        fail_open: ver docstring do módulo — default `False` (bloqueia em
            caso de falha do Redis). Rotas críticas em produção DEVEM manter
            `False`.
        redis_client: cliente Redis a usar (ou mock, em testes); se omitido,
            é construído a partir de `settings.redis_url` na primeira
            chamada da view decorada.
    """

    def decorator(view_func: F) -> F:
        @wraps(view_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            client = redis_client
            if client is None:
                settings = get_settings()
                client = _build_redis_client(settings.redis_url)

            key_suffix = key_func(*args, **kwargs)
            redis_key = (
                f"{_RATE_LIMIT_KEY_PREFIX}:{view_func.__module__}.{view_func.__qualname__}:"
                f"{key_suffix}"
            )

            try:
                current_count = client.incr(redis_key)
                if current_count == 1:
                    # Só define o TTL quando o contador acabou de ser criado
                    # (idempotente: chamadas concorrentes que também vejam
                    # `1` reaplicariam o mesmo TTL, sem efeito colateral
                    # diferente de reiniciar a janela por uma corrida rara —
                    # aceitável para este caso de uso).
                    client.expire(redis_key, window_seconds)
            except redis.exceptions.RedisError as exc:
                if fail_open:
                    logger.error(
                        "rate_limit: Redis indisponível (%s) para a chave '%s'; "
                        "fail_open=True -> requisição permitida sem limitação "
                        "(NUNCA usar fail_open=True em rotas críticas em produção).",
                        exc.__class__.__name__,
                        redis_key,
                    )
                    return view_func(*args, **kwargs)

                logger.error(
                    "rate_limit: Redis indisponível (%s) para a chave '%s'; "
                    "fail_open=False -> requisição bloqueada.",
                    exc.__class__.__name__,
                    redis_key,
                )
                response = jsonify(
                    {
                        "error": {
                            "code": "rate_limit_unavailable",
                            "message": "Serviço de limitação de tentativas indisponível.",
                        }
                    }
                )
                response.status_code = 503
                return response

            if current_count > limit:
                logger.warning(
                    "rate_limit: limite excedido para a chave '%s' (%d/%d em %ds).",
                    redis_key,
                    current_count,
                    limit,
                    window_seconds,
                )
                response = jsonify(
                    {
                        "error": {
                            "code": "rate_limited",
                            "message": "Muitas tentativas. Tente novamente mais tarde.",
                        }
                    }
                )
                response.status_code = 429
                return response

            return view_func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator
