"""Segurança da Etapa 3 (Aparência): rate limit fail-closed, auditoria sem segredos,
IDOR por construção, limite de taxa por usuário, corpo grande/forjado."""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from sqlalchemy import select
from test_user_admin_db import api, auth_headers, world  # noqa: F401

from app.models.settings import UserPreferences

URL = "/api/v1/me/preferences"
SUB_A = "auth-secpref-a"
SUB_B = "auth-secpref-b"


class _BrokenRedis:
    def __getattr__(self, name):
        def _fail(*_a, **_k):
            import redis

            raise redis.exceptions.ConnectionError("redis down")

        return _fail


@pytest.fixture()
def people(api):
    unit = api.world.unit("A")
    a = api.world.user("Sec A", role="USER", units=[unit], auth_user_id=SUB_A)
    b = api.world.user("Sec B", role="RH", units=[unit], auth_user_id=SUB_B)
    return api, a, b


def _rows(api):
    with api.world.session() as db:
        return list(db.execute(select(UserPreferences)).scalars().all())


@pytest.mark.parametrize("method,body", [("GET", None), ("PATCH", {"version": 0, "density": "compact"})])
def test_redis_fora_falha_fechada_sem_gravar(people, method, body):
    api, _a, _b = people
    with patch("redis.Redis.from_url", return_value=_BrokenRedis()):
        response = api.client.open(URL, method=method, json=body, headers=auth_headers(SUB_A, aal="aal1"))
    assert response.status_code == 503
    assert _rows(api) == []
    assert api.world.audits("USER_PREFERENCES_UPDATED") == []


def test_rate_limit_de_escrita_por_usuario(people):
    api, _a, _b = people
    codes = [
        api.client.patch(URL, json={"version": 99, "density": "compact"}, headers=auth_headers(SUB_A, aal="aal1")).status_code
        for _ in range(61)
    ]
    assert codes[:60] == [409] * 60
    assert codes[60] == 429
    # a cota é do usuário: outro usuário não é afetado
    other = api.client.patch(URL, json={"version": 0, "density": "compact"}, headers=auth_headers(SUB_B, aal="aal1"))
    assert other.status_code == 200


def test_auditoria_sem_segredos_e_sem_pii(people):
    api, a, _b = people
    token = auth_headers(SUB_A, aal="aal1")
    api.client.patch(URL, json={"version": 0, "density": "compact", "font_scale": 112}, headers=token)
    (audit,) = api.world.audits("USER_PREFERENCES_UPDATED")
    dumped = json.dumps([audit.previous_values, audit.new_values])
    assert set(audit.new_values) == {"density", "font_scale", "version"}
    assert set(audit.previous_values) == {"density", "font_scale", "version"}
    assert token["Authorization"].split()[1] not in dumped
    assert "@" not in dumped and "Sec A" not in dumped


def test_alvo_e_sempre_o_jwt_ignorando_cabecalhos_e_query(people):
    api, a, b = people
    headers = {**auth_headers(SUB_A, aal="aal1"), "X-User-Id": str(b), "X-Forwarded-User": str(b)}
    response = api.client.patch(f"{URL}?user_id={b}", json={"version": 0, "density": "compact"}, headers=headers)
    assert response.status_code == 200
    assert {r.user_id for r in _rows(api)} == {a}


@pytest.mark.parametrize("field", ["auth_user_id", "active", "created_at", "updated_at", "id"])
def test_mass_assignment_campos_privilegiados_extras(people, field):
    api, _a, _b = people
    response = api.client.patch(
        URL, json={"version": 0, "density": "compact", field: "x"}, headers=auth_headers(SUB_A, aal="aal1")
    )
    assert response.status_code == 400
    assert any(
        e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT") for e in api.events
    )
    assert _rows(api) == []


def test_corpo_nao_json_e_content_type_errado_400(people):
    api, _a, _b = people
    h = auth_headers(SUB_A, aal="aal1")
    assert api.client.patch(URL, data="version=0&density=compact", headers=h).status_code == 400
    assert api.client.patch(URL, data="{" * 10, headers={**h, "Content-Type": "application/json"}).status_code == 400
    assert _rows(api) == []


def test_resposta_so_tem_campos_esperados(people):
    api, _a, _b = people
    body = api.client.get(URL, headers=auth_headers(SUB_A, aal="aal1")).get_json()
    assert set(body) == {"density", "font_scale", "version"}
