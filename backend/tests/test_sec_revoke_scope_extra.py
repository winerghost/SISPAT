"""Complemento de AUD-14-01/02 (revisao AppSec 2026-10-14).

Cobre propriedades que `test_sec_revoke_scope.py` nao prova: cabecalhos
identicos, fail-closed, erro de banco, papeis nao-ADM, eventos equivalentes e
o oraculo de tempo (AUD-14-07, corrigido: mesmo numero de consultas).
Reutiliza a sessao falsa do arquivo original (sem banco/Redis reais).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import test_sec_revoke_scope as base
from test_sec_revoke_scope import (
    ACTOR_ID,
    TARGET_A,
    TARGET_B,
    TARGET_GHOST,
    _fake_db,
    _headers,
    _url,
)

from app import create_app

env = base.env  # reutiliza a fixture


def _stable_headers(response) -> dict[str, str]:
    volatile = {"date", "x-request-id", "content-length"}
    return {k.lower(): v for k, v in response.headers.items() if k.lower() not in volatile}


def test_cabecalhos_identicos_entre_alheio_e_inexistente(env):
    other = env.client.post(_url(TARGET_B), headers=_headers())
    ghost = env.client.post(_url(TARGET_GHOST), headers=_headers())
    assert other.status_code == ghost.status_code == 404
    assert other.get_data() == ghost.get_data()
    assert _stable_headers(other) == _stable_headers(ghost)


def test_eventos_de_negacao_sao_equivalentes(env):
    env.client.post(_url(TARGET_B), headers=_headers())
    env.client.post(_url(TARGET_GHOST), headers=_headers())
    first, second = env.events[0], env.events[1]
    for key in ("event_type", "severity", "result", "details"):
        assert first[key] == second[key]
    assert first["details"] == {"context": "users.revoke"}


def test_id_malformado_e_404_com_codigo_generico_sem_eco(env):
    response = env.client.post("/api/v1/users/%3Cscript%3E/revoke", headers=_headers())
    assert response.status_code == 404
    body = response.get_data(as_text=True)
    assert "script" not in body
    assert response.get_json()["error"]["code"] == "not_found"
    env.service.revoke_access.assert_not_called()


def test_ator_sem_unidades_falha_fechado(env):
    with patch.object(base, "ACCESS", {(TARGET_A, base.UNIT_A)}):
        response = env.client.post(_url(TARGET_A), headers=_headers())
    assert response.status_code == 404
    env.service.revoke_access.assert_not_called()


def test_erro_de_banco_na_checagem_de_escopo_nao_revoga(env):
    def boom():
        raise RuntimeError("db down")

    class _Broken:
        def __enter__(self):
            raise RuntimeError("db down")

        def __exit__(self, *a):
            return False

    with patch("app.api.v1.users.get_db_session", lambda: _Broken()):
        client = create_app().test_client()
        response = client.post(_url(TARGET_A), headers=_headers())
    assert response.status_code == 500
    assert "db down" not in response.get_data(as_text=True)
    env.service.revoke_access.assert_not_called()


@pytest.mark.parametrize("role", ["USER", "RH"])
def test_papeis_nao_adm_negados_antes_de_tocar_o_banco(role):
    service = MagicMock()
    sentinel = MagicMock(side_effect=AssertionError("banco nao pode ser tocado"))
    redis_fake = MagicMock()
    redis_fake.incr.return_value = 1
    actor = SimpleNamespace(id=ACTOR_ID, active=True)
    with (
        patch("redis.Redis.from_url", return_value=redis_fake),
        patch(
            "app.auth.supabase_auth._load_user_with_roles_and_permissions",
            return_value=(actor, {role}, {"users.revoke_access"}),
        ),
        patch("app.api.v1.users.get_db_session", sentinel),
        patch("app.api.v1.users.InviteService", MagicMock(return_value=service)),
    ):
        response = create_app().test_client().post(_url(TARGET_A), headers=_headers())
    assert response.status_code == 403
    service.revoke_access.assert_not_called()


def test_alvo_ghost_e_alheio_executam_mesmo_numero_de_consultas(env):
    """AUD-14-07 corrigido: a consulta de convites pendentes roda tambem para
    alvo inexistente => mesmo numero de consultas (sem oraculo de tempo)."""
    counts: dict[str, int] = {}

    def run(target):
        n = {"q": 0}
        session = base._FakeSession()
        original = session.query

        def counting(*e):
            n["q"] += 1
            return original(*e)

        session.query = counting
        from contextlib import contextmanager

        @contextmanager
        def db():
            yield session

        with patch("app.api.v1.users.get_db_session", db):
            create_app().test_client().post(_url(target), headers=_headers())
        counts[str(target)] = n["q"]

    run(TARGET_B)
    run(TARGET_GHOST)
    assert counts[str(TARGET_B)] == counts[str(TARGET_GHOST)]

