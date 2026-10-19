"""Infra compartilhada dos testes de IA do dashboard (Etapa 4b).

SQLite com o schema REAL (mesma infra de `test_alerts_api`), Redis em memória,
provedor roteirizado (zero rede) e `AIConfig` montado direto (sem tabela
`ai_settings`). Este módulo não contém testes.
"""
from __future__ import annotations

import re
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from types import MappingProxyType, SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
import test_user_admin_db as tdb
from test_ai_support import FakeRedis, make_settings
from test_user_admin_db import World, auth_headers, build_engine

from app import create_app
from app.models.assets import Asset
from app.models.people import ResponsiblePerson
from app.models.rbac import Permission, RolePermission
from app.models.units import Room
from app.services.ai import factory
from app.services.ai.base import AIResult
from app.services.ai.factory import AIConfig
from app.services.ai.models import AI_FEATURES

NOW = datetime.now(timezone.utc)
EXTRA_TABLES = (
    "responsible_people", "rooms", "locations", "assets", "asset_movements", "inventories",
    "inventory_items", "sync_jobs", "sync_conflicts", "raw_import_records",
)
SUB_A, SUB_B, SUB_RH, SUB_NO, SUB_NONE = "ai-a", "ai-b", "ai-rh", "ai-no-perm", "ai-no-unit"


def all_features(**overrides: bool) -> dict[str, bool]:
    base = {name: True for name in AI_FEATURES}
    base.update(overrides)
    return base


def make_config(**feature_overrides: bool) -> AIConfig:
    return AIConfig(
        enabled=True, provider="openai", features=MappingProxyType(all_features(**feature_overrides))
    )


class ScriptedProvider:
    """Provedor falso: devolve as respostas na ordem (repete a última) e grava as requisições."""

    name = "openai"

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies) or ["Resposta de teste."]
        self.requests: list[Any] = []

    def complete(self, request: Any) -> AIResult:
        self.requests.append(request)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, AIResult):
            return reply
        return AIResult(ok=True, text=reply, tokens_in=10, tokens_out=5, provider="openai", model=request.model)

    def sent(self) -> str:
        return "\n".join(f"{r.system}\n{r.user}" for r in self.requests)


def use_provider(monkeypatch, provider: ScriptedProvider) -> ScriptedProvider:
    monkeypatch.setitem(factory._PROVIDER_CLASSES, "openai", lambda key, timeout, session: provider)
    return provider


def build_world(monkeypatch) -> World:
    monkeypatch.setattr(tdb, "_TABLES", tdb._TABLES + EXTRA_TABLES)
    engine = build_engine()
    with engine.connect() as conn:  # SQLite não tem REGEXP
        conn.connection.driver_connection.create_function(
            "regexp", 2, lambda pattern, value: int(re.search(pattern, value or "") is not None)
        )
    world = World(engine)
    with world.session() as db:
        perm = Permission(id=uuid.uuid4(), code="ai.use", resource="ai", action="use")
        db.add(perm)
        for role in ("USER", "RH", "ADM"):
            db.add(RolePermission(id=uuid.uuid4(), role_id=world.roles[role], permission_id=perm.id))
    return world


def add_room(world: World, unit: uuid.UUID, name: str) -> uuid.UUID:
    room_id = uuid.uuid4()
    with world.session() as db:
        db.add(Room(id=room_id, unit_id=unit, name=name))
    return room_id


def add_person(world: World, unit: uuid.UUID, name: str, email: str) -> uuid.UUID:
    person_id = uuid.uuid4()
    with world.session() as db:
        db.add(ResponsiblePerson(id=person_id, name=name, unit_id=unit, email=email))
    return person_id


def add_assets(world: World, unit: uuid.UUID, n: int, *, prefix: str = "P", room: uuid.UUID | None = None,
               responsible: uuid.UUID | None = None, located: bool = True) -> None:
    with world.session() as db:
        for i in range(n):
            db.add(
                Asset(
                    id=uuid.uuid4(),
                    patrimony_number=f"{prefix}{uuid.uuid4().hex[:8]}-{i}",
                    unit_id=unit,
                    responsible_person_id=responsible,
                    room_id=room if room else (uuid.uuid4() if located else None),
                )
            )


@pytest.fixture()
def env(monkeypatch):
    """App + SQLite + Redis em memória + provedor roteirizado + captura de auditoria."""
    world = build_world(monkeypatch)
    state = SimpleNamespace(
        world=world,
        redis=FakeRedis(),
        settings=make_settings(),
        config=make_config(),
        provider=use_provider(monkeypatch, ScriptedProvider()),
        usage_rows=[],
        events=[],
    )

    class _SettingsStub:
        def __init__(self, _db: Any) -> None: ...

        def load_config(self) -> AIConfig:
            return state.config

    state.use = lambda *replies: setattr(state, "provider", use_provider(monkeypatch, ScriptedProvider(*replies)))
    with ExitStack() as stack:
        for target in (
            "app.api.v1.ai.get_db_session",
            "app.auth.supabase_auth.get_db_session",
            "app.services.alerts.service.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("app.api.v1.ai.AISettingsService", _SettingsStub))
        stack.enter_context(patch("app.api.v1.ai.get_settings", lambda: state.settings))
        stack.enter_context(patch("redis.Redis.from_url", lambda *_a, **_k: state.redis))
        stack.enter_context(patch("app.services.ai.usage._default_writer", side_effect=state.usage_rows.append))
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=state.events.append)
        )
        state.client = create_app().test_client()
        ua, ub = world.unit("A"), world.unit("B")
        world.user("User A", role="USER", units=[ua], auth_user_id=SUB_A)
        world.user("User B", role="USER", units=[ub], auth_user_id=SUB_B)
        world.user("Rita RH", role="RH", units=[ua], auth_user_id=SUB_RH)
        world.user("Sem Perm", roles=[], units=[ua], auth_user_id=SUB_NO)
        world.user("Sem Unidade", role="USER", units=[], auth_user_id=SUB_NONE)
        state.ua, state.ub = ua, ub
        yield state


def ask(env, question: Any = "Quantos bens?", sub: str = SUB_A, **extra: Any):
    body = {"question": question, **extra}
    return env.client.post("/api/v1/ai/ask", json=body, headers=auth_headers(sub, aal="aal2"))


def insights(env, sub: str = SUB_A):
    return env.client.get("/api/v1/ai/insights", headers=auth_headers(sub, aal="aal1"))
