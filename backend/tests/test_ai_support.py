"""Dublês compartilhados pelos testes `test_ai_*` (sem rede, sem Redis real).

Chaves FICTÍCIAS montadas em tempo de execução (não são segredos reais e
não casam com detectores de segredo por literal).
"""
from __future__ import annotations

import json
from typing import Any

import redis
import requests

from app.config.settings import Settings

FAKE_OPENAI_KEY = "sk-" + "testeopenai" * 3
FAKE_ANTHROPIC_KEY = "sk-ant-" + "testeanthropic" * 3
FAKE_DEEPSEEK_KEY = "sk-" + "testedeepseek" * 3
ALL_FAKE_KEYS = (FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, FAKE_DEEPSEEK_KEY)


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "database_url": "postgresql+psycopg2://user:pass@localhost:5432/test",
        "secret_key": "test-secret-key",
        "flask_env": "testing",
        "ai_enabled": True,
        "openai_api_key": FAKE_OPENAI_KEY,
        "anthropic_api_key": FAKE_ANTHROPIC_KEY,
        "deepseek_api_key": FAKE_DEEPSEEK_KEY,
        "ai_monthly_token_cap": 200_000,
    }
    base.update(overrides)
    return Settings(**base)


class FakeRedis:
    """Subconjunto em memória da API do redis-py usada pela camada de IA."""

    def __init__(self) -> None:
        self.data: dict[str, Any] = {}
        self.ttls: dict[str, int] = {}

    def get(self, key: str) -> Any:
        value = self.data.get(key)
        return None if value is None else str(value).encode()

    def incr(self, key: str) -> int:
        return self.incrby(key, 1)

    def incrby(self, key: str, amount: int) -> int:
        self.data[key] = int(self.data.get(key, 0)) + int(amount)
        return self.data[key]

    def expire(self, key: str, seconds: int) -> bool:
        if key in self.data:
            self.ttls[key] = int(seconds)
        return True

    def exists(self, key: str) -> int:
        return 1 if key in self.data else 0

    def set(self, key: str, value: Any, ex: int | None = None, nx: bool = False) -> bool | None:
        if nx and key in self.data:
            return None
        self.data[key] = value
        if ex is not None:
            self.ttls[key] = int(ex)
        return True

    def delete(self, key: str) -> int:
        return 1 if self.data.pop(key, None) is not None else 0

    def pipeline(self, transaction: bool = True) -> "FakePipeline":
        return FakePipeline(self)


class FakePipeline:
    """MULTI/EXEC em memória: enfileira comandos e aplica todos em `execute`."""

    def __init__(self, redis_client: FakeRedis) -> None:
        self._redis = redis_client
        self._ops: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Any:
        if name not in ("set", "incr", "incrby", "expire", "get"):
            raise AttributeError(name)

        def _queue(*args: Any, **kwargs: Any) -> "FakePipeline":
            self._ops.append((name, args, kwargs))
            return self

        return _queue

    def execute(self) -> list[Any]:
        ops, self._ops = self._ops, []
        return [getattr(self._redis, name)(*args, **kwargs) for name, args, kwargs in ops]


class BrokenRedis:
    """Redis fora do ar: toda operação levanta ConnectionError."""

    def __getattr__(self, name: str) -> Any:
        def _fail(*args: Any, **kwargs: Any) -> Any:
            raise redis.exceptions.ConnectionError("redis down")

        return _fail


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: Any = None, raw: str | None = None) -> None:
        self.status_code = status_code
        self._payload = payload
        self._raw = raw
        self.content = (raw if raw is not None else json.dumps(payload)).encode()
        self.headers: dict[str, str] = {}
        self.closed = False
        self.bytes_read = 0

    def iter_content(self, chunk_size: int = 1) -> Any:
        """Como `requests.Response.iter_content` (stream=True); conta o que foi lido."""
        for start in range(0, len(self.content), chunk_size):
            chunk = self.content[start:start + chunk_size]
            self.bytes_read += len(chunk)
            yield chunk

    def close(self) -> None:
        self.closed = True

    def json(self) -> Any:
        if self._raw is not None:
            return json.loads(self._raw)  # levanta ValueError se malformado
        return self._payload


class FakeSession:
    """Captura cada chamada `post`; `responses` pode conter exceções."""

    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, **kwargs: Any) -> Any:
        self.calls.append({"url": url, **kwargs})
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, BaseException):
            raise item
        return item

    def sent_text(self) -> str:
        return json.dumps([c.get("json") for c in self.calls], ensure_ascii=False)


def openai_ok(text: str = "Resposta.", prompt_tokens: int = 10, completion_tokens: int = 5) -> FakeResponse:
    return FakeResponse(
        200,
        {
            "choices": [{"message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
        },
    )


def anthropic_ok(text: str = "Resposta.", input_tokens: int = 10, output_tokens: int = 5) -> FakeResponse:
    return FakeResponse(
        200,
        {
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
        },
    )


TIMEOUT = requests.exceptions.Timeout("t")
CONN_ERROR = requests.exceptions.ConnectionError("c")
