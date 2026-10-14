"""Revisão de segurança (Etapa 1) — `/api/v1/settings/ai`: caminhos alternativos,
mass assignment avançado e aceite DeepSeek.

Complementa `test_ai_settings_api.py` (matriz básica USER/RH/ADM-AAL1). Tudo
mockado: banco (MagicMock), Redis em memória, provedores sem rede. Nenhuma
chamada real a provedor de IA ou ao Supabase. Evidência:
`docs/security/evidence/settings-module-etapa1.md`.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from app.models.audit import AuditLog
from test_ai_settings_api import (  # fixtures e helpers (sem importar testes)
    FAKE_KEYS,
    SECRET_MARK,
    TEST_URL,
    URL,
    _adm,
    _row,
    client,  # noqa: F401 - fixture
    env,  # noqa: F401 - fixture
    events,  # noqa: F401 - fixture
)
from test_ai_support import BrokenRedis, FakeResponse, FakeSession
from test_sec_authz import as_user, auth, call, make_token

PERM = "settings.ai.manage"


def _audit_ops(session) -> list[str]:
    return [c.args[0].operation for c in session.add.call_args_list if isinstance(c.args[0], AuditLog)]


def _raw(client, method: str, url: str, raw: str, token: str | None):
    return client.open(
        url, method=method, data=raw, content_type="application/json", headers=auth(token)
    )


# ---------------------------------------------------------------------------
# 1. AuthZ — nenhum caminho alternativo pula os decorators
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["USER", "RH"])
def test_head_nao_contorna_authz(client, env, events, role):
    with as_user({role}, {PERM}):
        response = client.head(URL, headers=auth(make_token(aal="aal2")))
    assert response.status_code == 403
    assert any(e["event_type"] == "ACCESS_DENIED" for e in events)
    env.session.execute.assert_not_called()


def test_head_adm_aal1_negado(client, env, events):
    with _adm():
        response = client.head(URL, headers=auth(make_token(aal="aal1")))
    assert response.status_code == 403
    env.session.execute.assert_not_called()


@pytest.mark.parametrize("url", [URL, TEST_URL])
@pytest.mark.parametrize("origin", [None, "http://localhost:3000", "https://evil.example"])
def test_options_nao_executa_view_nem_vaza_dados(client, env, url, origin):
    headers = {"Access-Control-Request-Method": "PATCH"}
    if origin:
        headers["Origin"] = origin
    response = client.options(url, headers=headers)
    assert response.status_code in (200, 204)
    env.session.execute.assert_not_called()
    body = response.get_data(as_text=True)
    assert "provider" not in body and SECRET_MARK not in body
    if origin == "https://evil.example":
        assert "Access-Control-Allow-Origin" not in response.headers


@pytest.mark.parametrize(
    "path",
    [
        URL + "/",
        "/api/v1//settings/ai",
        "/api/v1/settings/AI",
        "/api/v1/settings/ai/test/",
        "/api/v1/settings/ai/%2e%2e/ai",
        "/api/v1/settings/ai;x",
    ],
)
def test_variacoes_de_caminho_nao_chegam_a_view(client, env, path):
    with _adm():
        for method in ("GET", "PATCH", "POST"):
            response = call(client, method, path, {"version": 3}, token=make_token())
            assert response.status_code in (301, 308, 404, 405), (method, path, response.status_code)
            assert response.status_code != 200
    env.session.execute.assert_not_called()


@pytest.mark.parametrize(
    "method,url",
    [("PUT", URL), ("DELETE", URL), ("POST", URL), ("GET", TEST_URL), ("PATCH", TEST_URL), ("PUT", TEST_URL)],
)
def test_metodo_errado_405_sem_tocar_banco(client, env, method, url):
    with _adm():
        response = call(client, method, url, {"version": 3}, token=make_token())
    assert response.status_code == 405
    env.session.execute.assert_not_called()


@pytest.mark.parametrize("override", ["PATCH", "DELETE", "PUT"])
def test_method_override_header_ignorado(client, env, override):
    with _adm():
        response = client.get(
            URL, headers={**auth(make_token()), "X-HTTP-Method-Override": override}
        )
    assert response.status_code == 200
    assert _audit_ops(env.session) == []  # nenhuma escrita via override


@pytest.mark.parametrize("aal", [None, "aal1", "AAL2", "aal3", ""])
def test_aal_ausente_ou_forjado_negado(client, env, events, aal):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "enabled": True}, token=make_token(aal=aal))
    assert response.status_code == 403
    env.session.execute.assert_not_called()


# ---------------------------------------------------------------------------
# 2. Mass assignment avançado no PATCH
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"version": 3, "features": {"api_key": "sk-x"}},
        {"version": 3, "features": {"role": "ADM"}},
        {"version": 3, "features": {"Assistant": True}},
        {"version": 3, "API_KEY": "sk-x"},
        {"version": 3, "Api_Key": "sk-x"},
        {"version": 3, "\uff52\uff4f\uff4c\uff45": "ADM"},  # "role" fullwidth
        {"version": 3, "v\u0435rsion": 9},  # "e" cirilico (confusavel)
        {"version": 3, "enabled\u200b": True},  # zero-width
        {"version": 3, "deepseek_acknowledged": True},
        {"version": 3, "deepseek_acknowledged_at": "2026-01-01T00:00:00Z"},
        {"version": 3, "updated_at": "2026-01-01T00:00:00Z"},
        {"version": 3, "keys": {"openai": "configured"}},
        {"version": 3, "status": "active"},
        {"version": 3, "env_enabled": True},
        {"version": 3, "__proto__": {"x": 1}},
    ],
)
def test_mass_assignment_variantes_rejeitadas_e_auditadas(client, env, events, body):
    with _adm():
        response = call(client, "PATCH", URL, body, token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert "sk-x" not in response.get_data(as_text=True)
    assert any(
        e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT") for e in events
    )
    env.session.execute.assert_not_called()


@pytest.mark.parametrize(
    "body",
    [
        {"version": 3, "enabled": "true"},
        {"version": 3, "enabled": 1},
        {"version": 3, "acknowledge_international_transfer": "true", "provider": "deepseek"},
        {"version": 3, "acknowledge_international_transfer": 1, "provider": "deepseek"},
        {"version": 3, "features": {"assistant": "true"}},
        {"version": 3, "features": ["assistant"]},
        {"version": 3, "features": "assistant"},
        {"version": 3.0},
        {"version": 3.5},
        {"version": -1},
        {"version": 0},
        {"version": True},
        {"version": 2_147_483_648},
        {"version": 10**30},
        {"version": "3"},
        {"version": [3]},
        {"version": 3, "monthly_token_cap": 1000.0},
        {"version": 3, "monthly_token_cap": "1000"},
        {"version": 3, "monthly_token_cap": True},
        {"version": 3, "provider": "DeepSeek"},
        {"version": 3, "provider": "OPENAI"},
        {"version": 3, "provider": ["openai"]},
        {"version": 3, "model": 123},
        {"version": 3, "model": ""},
    ],
)
def test_tipos_trocados_rejeitados(client, env, body):
    with _adm():
        response = call(client, "PATCH", URL, body, token=make_token())
    assert response.status_code == 400, response.get_json()
    assert response.get_json()["error"]["code"] == "validation_error"
    env.session.execute.assert_not_called()


@pytest.mark.parametrize(
    "model",
    [
        "gpt\N{NON-BREAKING HYPHEN}6.1\N{NON-BREAKING HYPHEN}sol",
        "gpt-6.1-sol\N{ZERO WIDTH SPACE}",
        "\N{FULLWIDTH LATIN CAPITAL LETTER G}PT-6.1-sol",
        "../gpt-6.1-sol",
        "https://evil/x",
    ],
)
def test_modelo_confusavel_ou_url_invalid_model(client, env, model):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "model": model}, token=make_token())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] in ("invalid_model", "validation_error")
    assert _audit_ops(env.session) == []


def test_modelo_com_espacos_e_normalizado_para_valor_da_allowlist(client, env):
    # `str_strip_whitespace`: o valor gravado é exatamente o da allowlist.
    row = _row()
    env.set_row(row)
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "model": " gpt-6-luna\n"}, token=make_token())
    assert response.status_code == 200
    assert row.model == "gpt-6-luna"


def test_provider_com_espacos_nao_ativa_deepseek_sem_aceite(client, env):
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "provider": " deepseek "}, token=make_token())
    assert response.status_code == 400
    assert _audit_ops(env.session) == []


def test_json_com_chave_duplicada_ultima_vence_e_regras_valem(client, env):
    # A última ocorrência vence (json do Python); a regra do aceite continua valendo.
    with _adm():
        r1 = _raw(client, "PATCH", URL, '{"version":3,"provider":"none","provider":"deepseek"}', make_token())
    assert r1.status_code == 400 and r1.get_json()["error"]["code"] == "deepseek_ack_required"
    with _adm():
        r2 = _raw(
            client, "PATCH", URL,
            '{"version":3,"provider":"deepseek","acknowledge_international_transfer":true,'
            '"acknowledge_international_transfer":false}',
            make_token(),
        )
    assert r2.status_code == 400 and r2.get_json()["error"]["code"] == "deepseek_ack_required"
    with _adm():
        r3 = _raw(client, "PATCH", URL, '{"version":3,"api_key":"a","version":3}', make_token())
    assert r3.status_code == 400
    assert _audit_ops(env.session) == []


@pytest.mark.parametrize("raw", ['{"version":3,', "null", '"x"', "[]", "", "{\"version\": NaN}", "{\"version\": Infinity}"])
def test_corpo_malformado_400(client, env, raw):
    with _adm():
        response = _raw(client, "PATCH", URL, raw, make_token())
    assert response.status_code == 400
    env.session.execute.assert_not_called()


def test_patch_sem_content_type_json_400(client, env):
    with _adm():
        response = client.patch(URL, data=json.dumps({"version": 3, "enabled": True}), headers=auth(make_token()))
    assert response.status_code == 400
    env.session.execute.assert_not_called()


# ---------------------------------------------------------------------------
# 12. DeepSeek — impossível ativar sem aceite por qualquer combinação de PATCH
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"version": 3, "provider": "deepseek"},
        {"version": 3, "provider": "deepseek", "enabled": True},
        {"version": 3, "provider": "deepseek", "acknowledge_international_transfer": False},
        {"version": 3, "provider": "deepseek", "model": "deepseek-flash"},
        {"version": 3, "model": "deepseek-flash"},  # provider atual openai
    ],
)
def test_deepseek_sem_aceite_nunca_grava(client, env, body):
    row = _row()
    env.set_row(row)
    with _adm():
        response = call(client, "PATCH", URL, body, token=make_token())
    assert response.status_code == 400
    assert row.provider == "openai" and row.deepseek_acknowledged_at is None
    assert _audit_ops(env.session) == []


def test_aceite_sem_provider_deepseek_nao_registra_aceite(client, env):
    row = _row()
    env.set_row(row)
    with _adm():
        response = call(
            client, "PATCH", URL, {"version": 3, "acknowledge_international_transfer": True}, token=make_token()
        )
    assert response.status_code == 200
    assert response.get_json()["deepseek_acknowledged"] is False
    assert row.deepseek_acknowledged_at is None
    assert "AI_DEEPSEEK_ACKNOWLEDGED" not in _audit_ops(env.session)


def test_aceite_com_modelo_invalido_nao_registra_aceite(client, env):
    row = _row()
    env.set_row(row)
    with _adm():
        response = call(
            client, "PATCH", URL,
            {"version": 3, "provider": "deepseek", "model": "gpt-6.1-sol", "acknowledge_international_transfer": True},
            token=make_token(),
        )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_model"
    assert row.deepseek_acknowledged_at is None and _audit_ops(env.session) == []


def test_aceite_auditado_com_ator_e_sem_segredos(client, env):
    row = _row()
    env.set_row(row)
    with _adm() as actor:
        response = call(
            client, "PATCH", URL,
            {"version": 3, "provider": "deepseek", "acknowledge_international_transfer": True},
            token=make_token(),
        )
    assert response.status_code == 200
    audits = [c.args[0] for c in env.session.add.call_args_list if isinstance(c.args[0], AuditLog)]
    ack = [a for a in audits if a.operation == "AI_DEEPSEEK_ACKNOWLEDGED"]
    assert len(ack) == 1 and ack[0].actor_user_id == actor.id and ack[0].result == "SUCESSO"
    assert set(audits[0].new_values) == {
        "enabled", "provider", "model", "features", "monthly_token_cap", "deepseek_acknowledged", "version"
    }
    assert SECRET_MARK not in repr([(a.previous_values, a.new_values) for a in audits])


def test_aceite_previo_persiste_ao_voltar_para_deepseek(client, env):
    """Comportamento de projeto (contrato: aceite gravado uma vez). Registrado
    como informativo AI-DS-01: o aceite não expira nem é revogável pela API."""
    row = _row(provider="none", model=None, deepseek_acknowledged_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
    env.set_row(row)
    with _adm():
        response = call(client, "PATCH", URL, {"version": 3, "provider": "deepseek"}, token=make_token())
    assert response.status_code == 200
    assert "AI_DEEPSEEK_ACKNOWLEDGED" not in _audit_ops(env.session)


# ---------------------------------------------------------------------------
# 8. Rate limit fail-closed nas três rotas
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,url,body", [("GET", URL, None), ("PATCH", URL, {"version": 3}), ("POST", TEST_URL, None)])
def test_rate_limit_redis_fora_falha_fechada(client, env, method, url, body):
    with patch("redis.Redis.from_url", return_value=BrokenRedis()):
        fake_http = FakeSession(FakeResponse(200, {}))
        with patch("app.services.ai.http.requests.Session", return_value=fake_http):
            with _adm():
                response = call(client, method, url, body, token=make_token())
    assert response.status_code == 503
    assert fake_http.calls == []
    env.session.execute.assert_not_called()


def test_rate_limit_test_e_por_adm_nao_por_ip(client, env):
    """Trocar X-Forwarded-For não renova a cota do /test (chave = id do ADM)."""
    fake_http = FakeSession(FakeResponse(500, {}))
    with patch("app.services.ai.http.requests.Session", return_value=fake_http):
        with _adm():
            statuses = []
            for i in range(6):
                headers = {**auth(make_token()), "X-Forwarded-For": f"10.0.0.{i}"}
                statuses.append(client.post(TEST_URL, headers=headers).status_code)
    assert statuses[-1] == 429
    assert len(fake_http.calls) <= 5


def test_test_endpoint_nao_loga_chave_com_caplog(client, env, caplog):
    caplog.set_level(logging.DEBUG)
    fake_http = FakeSession(FakeResponse(200, {"choices": [{"message": {"content": "OK"}}]}))
    with patch("app.services.ai.http.requests.Session", return_value=fake_http):
        with _adm():
            response = call(client, "POST", TEST_URL, token=make_token())
    assert response.status_code == 200
    for key in FAKE_KEYS.values():
        assert key not in caplog.text
        assert key not in response.get_data(as_text=True)
