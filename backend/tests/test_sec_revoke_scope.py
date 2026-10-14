"""Regressão AUD-14-01 / AUD-14-02 (auditoria 2026-10-14).

`POST /api/v1/users/<id>/revoke` deve (a) negar alvo fora do escopo de
unidade do ADM com a MESMA resposta de alvo inexistente (404 genérico, sem
escrita, com evento de segurança) e (b) aplicar rate limit fail-closed.
Testes comportamentais com o test client, sem banco/Redis/Supabase reais.
"""
from __future__ import annotations

import time
import uuid
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
import pytest

from app import create_app

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # default de conftest.py

UNIT_A = uuid.UUID("11111111-1111-4111-8111-111111111111")
UNIT_B = uuid.UUID("22222222-2222-4222-8222-222222222222")
ACTOR_ID = uuid.UUID("aaaaaaaa-0000-4000-8000-000000000001")
TARGET_A = uuid.UUID("bbbbbbbb-0000-4000-8000-00000000000a")  # unidade A
TARGET_B = uuid.UUID("bbbbbbbb-0000-4000-8000-00000000000b")  # unidade B
TARGET_GHOST = uuid.UUID("bbbbbbbb-0000-4000-8000-0000000000ff")  # inexistente

ACCESS = {(ACTOR_ID, UNIT_A), (TARGET_A, UNIT_A), (TARGET_B, UNIT_B)}


PENDING_A = uuid.UUID("cccccccc-0000-4000-8000-00000000000a")  # convidado, so unidade A
PENDING_B = uuid.UUID("cccccccc-0000-4000-8000-00000000000b")  # convidado, so unidade B
ORPHAN = uuid.UUID("cccccccc-0000-4000-8000-0000000000ee")  # sem acesso nem convite
PENDING_UNITS = {PENDING_A: [UNIT_A], PENDING_B: [UNIT_B]}
KNOWN_USERS = {TARGET_A, TARGET_B, PENDING_A, PENDING_B, ORPHAN}


class _FakeQuery:
    def __init__(self, session=None, entity=None):
        self._conds = []
        self._session = session
        self._entity = entity
        self._invite_units = False

    def join(self, *_a, **_k):
        self._invite_units = True
        return self

    def first(self):
        values = {c.left.key: c.right.value for c in self._conds}
        uid = values.get("id")
        if uid in KNOWN_USERS:
            self._session.target = uid
            return SimpleNamespace(id=uid, email=f"{uid}@x.test", auth_user_id=None)
        return None

    def filter(self, *conds):
        self._conds.extend(conds)
        return self

    def all(self):
        if self._invite_units:
            return [(u,) for u in PENDING_UNITS.get(self._session.target, [])]
        values = {c.left.key: c.right.value for c in self._conds}
        return [(unit,) for (user, unit) in ACCESS if user == values.get("user_id")]


class _FakeSession:
    target = None

    def query(self, *entities):
        return _FakeQuery(self, entities[0] if entities else None)


@contextmanager
def _fake_db():
    yield _FakeSession()


def _url(user_id) -> str:
    return f"/api/v1/users/{user_id}/revoke"


def _headers(aal: str | None = "aal2") -> dict[str, str]:
    now = int(time.time())
    claims = {"sub": "auth-adm", "aud": "authenticated", "role": "authenticated",
              "iat": now, "exp": now + 3600}
    if aal:
        claims["aal"] = aal
    return {"Authorization": "Bearer " + jwt.encode(claims, JWT_SECRET, algorithm="HS256")}


@pytest.fixture()
def env():
    fake_redis = MagicMock()
    fake_redis.incr.return_value = 1
    service = MagicMock()
    events: list[dict] = []
    actor = SimpleNamespace(id=ACTOR_ID, active=True)
    with (
        patch("redis.Redis.from_url", return_value=fake_redis),
        patch(
            "app.auth.supabase_auth._load_user_with_roles_and_permissions",
            return_value=(actor, {"ADM"}, {"users.revoke_access"}),
        ),
        patch("app.api.v1.users.get_db_session", _fake_db),
        patch("app.api.v1.users.InviteService", MagicMock(return_value=service)),
        patch("app.api.v1.users.SupabaseAdminClient", MagicMock()),
        patch("app.authorization.security_events._dispatch", side_effect=events.append),
    ):
        yield SimpleNamespace(
            client=create_app().test_client(), redis=fake_redis, service=service, events=events
        )


def test_alvo_fora_do_escopo_e_inexistente_tem_resposta_identica_sem_escrita(env):
    other = env.client.post(_url(TARGET_B), headers=_headers())
    ghost = env.client.post(_url(TARGET_GHOST), headers=_headers())
    assert other.status_code == ghost.status_code == 404
    assert other.get_json() == ghost.get_json()
    assert str(TARGET_B) not in other.get_data(as_text=True)
    env.service.revoke_access.assert_not_called()


def test_negacao_e_auditada_sem_segredos(env):
    env.client.post(_url(TARGET_B), json={"reason": "x"}, headers=_headers())
    assert env.events and env.events[0]["event_type"] == "UNIT_SCOPE_DENIED"
    assert env.events[0]["target"] == {"type": "user", "id": str(TARGET_B)}
    assert "Bearer" not in str(env.events)


def test_convidado_pendente_em_unidade_do_ator_e_revogavel(env):
    response = env.client.post(_url(PENDING_A), headers=_headers())
    assert response.status_code == 200
    env.service.revoke_access.assert_called_once()


def test_convidado_pendente_so_de_unidade_alheia_tem_resposta_do_inexistente(env):
    other = env.client.post(_url(PENDING_B), headers=_headers())
    ghost = env.client.post(_url(TARGET_GHOST), headers=_headers())
    assert other.status_code == ghost.status_code == 404
    assert other.get_json() == ghost.get_json()
    env.service.revoke_access.assert_not_called()


def test_alvo_sem_acesso_e_sem_convite_retorna_404(env):
    response = env.client.post(_url(ORPHAN), headers=_headers())
    assert response.status_code == 404
    env.service.revoke_access.assert_not_called()


def test_id_malformado_nao_chega_ao_servico(env):
    response = env.client.post("/api/v1/users/nao-e-uuid/revoke", headers=_headers())
    assert response.status_code == 404
    env.service.revoke_access.assert_not_called()


def test_alvo_no_escopo_revoga_com_sucesso(env):
    response = env.client.post(_url(TARGET_A), json={"reason": "saiu"}, headers=_headers())
    assert response.status_code == 200
    env.service.revoke_access.assert_called_once_with(
        target_user_id=TARGET_A, revoked_by_user_id=ACTOR_ID, reason="saiu"
    )


def test_rate_limit_excedido_retorna_429_sem_escrita(env):
    env.redis.incr.return_value = 11
    response = env.client.post(_url(TARGET_A), headers=_headers())
    assert response.status_code == 429
    env.service.revoke_access.assert_not_called()


def test_sem_aal2_negado_sem_escrita(env):
    response = env.client.post(_url(TARGET_A), headers=_headers(aal="aal1"))
    assert response.status_code == 403
    env.service.revoke_access.assert_not_called()


def test_autorrevogacao_continua_bloqueada(env):
    response = env.client.post(_url(ACTOR_ID), headers=_headers())
    assert response.status_code == 409
    env.service.revoke_access.assert_not_called()
