"""Tasks de insights de IA (Etapa 4b): DTO agregado, flags, cache e degradação.

Provedor roteirizado e Redis em memória: zero rede. As tasks recebem
`session_factory`, `settings` e `redis_client` injetados.
"""
from __future__ import annotations

import json
import logging
from dataclasses import replace

import pytest
from test_ai_dash_support import (  # noqa: F401
    ScriptedProvider, add_assets, add_person, build_world, make_config, use_provider,
)
from test_ai_support import ALL_FAKE_KEYS, BrokenRedis, FakeRedis, make_settings

from app.celery_app import celery_app
from app.services.ai import insights as ins
from app.services.ai.base import AIResult
from app.services.ai.factory import AIConfig
from app.tasks import ai_tasks


@pytest.fixture()
def ctx(monkeypatch):
    world = build_world(monkeypatch)
    state = type("S", (), {})()
    state.world, state.redis, state.rows = world, FakeRedis(), []
    state.ua, state.ub = world.unit("A"), world.unit("B")
    state.provider = use_provider(monkeypatch, ScriptedProvider("Texto gerado pela IA."))
    state.use = lambda *r: setattr(state, "provider", use_provider(monkeypatch, ScriptedProvider(*r)))

    def run(feature, config=None, **kw):
        return ins.run_insight_feature(
            feature,
            config=config or make_config(),
            session_factory=world.session,
            settings=kw.pop("settings", make_settings()),
            redis_client=kw.pop("redis_client", state.redis),
            audit_writer=state.rows.append,
            **kw,
        )

    state.run = run
    return state


def seed(ctx):
    add_assets(ctx.world, ctx.ua, 6, located=False)
    add_assets(ctx.world, ctx.ub, 8, located=False)


def stored(ctx, unit, kind):
    raw = ctx.redis.get(ins.cache_key(unit, kind))
    return json.loads(raw) if raw else None


# --- geração e cache ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "feature,kind",
    [("alerts_explain", ins.KIND_ALERT_PRIORITY), ("executive_summary", ins.KIND_EXECUTIVE_SUMMARY),
     ("data_quality", ins.KIND_QUALITY_SUGGESTION)],
)
def test_gera_e_grava_por_unidade_com_ttl(ctx, feature, kind):
    seed(ctx)
    out = ctx.run(feature)
    assert out["stored"] == 2 and out["skipped"] is None
    for unit in (ctx.ua, ctx.ub):
        entry = stored(ctx, unit, kind)
        assert entry["text"] == "Texto gerado pela IA." and entry["generated_at"].endswith("Z")
        assert ctx.redis.ttls[ins.cache_key(unit, kind)] == ins.TTL_SECONDS[kind]
    assert [r.operation for r in ctx.rows] == ["AI_USAGE", "AI_USAGE"]


def test_payload_e_agregado_isolado_por_unidade_e_sem_dados_pessoais(ctx):
    person = add_person(ctx.world, ctx.ua, "Fulano Reservado", "fulano.reservado@exemplo.invalid")
    add_assets(ctx.world, ctx.ua, 6, located=False, responsible=person)
    add_assets(ctx.world, ctx.ub, 9, located=False)
    ctx.run("alerts_explain")
    first, second = (json.loads(r.user.split("<dados>\n")[1].split("\n</dados>")[0]) for r in ctx.provider.requests)
    payloads = {p["unit_code"]: p for p in (first, second)}
    assert {a["alert_type"]: a["count"] for a in payloads["A"]["alerts"]}["assets_no_location"] == 6
    assert {a["alert_type"]: a["count"] for a in payloads["B"]["alerts"]}["assets_no_location"] == 9
    sent = ctx.provider.sent().lower()
    for secret in ("fulano", "reservado", "exemplo.invalid", "user a", "auth-"):
        assert secret not in sent
    assert set(payloads["A"]["alerts"][0]) == {"alert_type", "severity", "count"}


def test_contagens_menores_que_5_sao_suprimidas(ctx):
    add_assets(ctx.world, ctx.ua, 3, located=False)
    ctx.run("alerts_explain")
    sent = ctx.provider.requests[0].user
    assert '"count":"\\u003c5"' in sent and '"count":3' not in sent


def test_resumo_executivo_envia_total_agregado(ctx):
    add_assets(ctx.world, ctx.ua, 7, located=False)
    ctx.run("executive_summary")
    assert '"metrics":{"total":7}' in ctx.provider.requests[0].user


def test_qualidade_envia_issues_com_campo(ctx):
    add_assets(ctx.world, ctx.ua, 6, located=False)
    ctx.run("data_quality")
    sent = ctx.provider.requests[0].user
    assert '"issue":"sem_localizacao"' in sent and '"field_name":"localizacao"' in sent


def test_unidade_sem_alertas_nao_chama_o_provedor(ctx):
    add_assets(ctx.world, ctx.ua, 6)
    out = ctx.run("alerts_explain", rules=[])  # nenhuma regra => nenhum alerta
    assert out["stored"] == 0 and ctx.provider.requests == []


# --- flags por funcionalidade -----------------------------------------------------------------


def test_so_a_funcionalidade_ligada_roda(ctx):
    seed(ctx)
    config = make_config(alerts_explain=True, executive_summary=False, data_quality=False)
    assert ctx.run("executive_summary", config)["skipped"] == "feature_disabled"
    assert ctx.run("data_quality", config)["skipped"] == "feature_disabled"
    assert ctx.provider.requests == [] and ctx.redis.ttls.keys().isdisjoint({ins.cache_key(ctx.ua, "executive_summary")})
    assert ctx.run("alerts_explain", config)["stored"] == 2


def test_feature_invalida_ou_assistant_nao_gera_insight(ctx):
    seed(ctx)
    assert ctx.run("assistant")["skipped"] == "invalid_feature"
    assert ctx.run("nao_existe")["skipped"] == "invalid_feature"
    assert ctx.provider.requests == []


# --- degradação: sem IA/erro/NullProvider => não grava ------------------------------------------


def _nothing_stored(ctx):
    assert not any(k.startswith(ins.CACHE_PREFIX) for k in ctx.redis.data)


def test_ia_desligada_no_ambiente_nao_grava(ctx):
    seed(ctx)
    out = ctx.run("alerts_explain", settings=make_settings(ai_enabled=False))
    assert out["skipped"] == "ai_unavailable" and ctx.provider.requests == []
    _nothing_stored(ctx)


@pytest.mark.parametrize("change", [{"enabled": False}, {"provider": "none"}])
def test_ia_desligada_no_banco_nao_grava(ctx, change):
    seed(ctx)
    assert ctx.run("alerts_explain", replace(make_config(), **change))["skipped"] == "ai_unavailable"
    assert ctx.provider.requests == []
    _nothing_stored(ctx)


def test_sem_chave_nao_grava(ctx):
    seed(ctx)
    assert ctx.run("alerts_explain", settings=make_settings(openai_api_key=None))["skipped"] == "ai_unavailable"
    _nothing_stored(ctx)


def test_redis_fora_nao_grava_nem_lanca(ctx):
    seed(ctx)
    out = ctx.run("alerts_explain", redis_client=BrokenRedis())
    assert out["stored"] == 0 and ctx.provider.requests == []


@pytest.mark.parametrize("kind", ["timeout", "auth_error", "upstream_error", "bad_response", "provider_rate_limited"])
def test_erro_do_provedor_nao_grava(ctx, kind):
    seed(ctx)
    ctx.use(AIResult.neutral(kind, provider="openai"))
    out = ctx.run("alerts_explain")
    assert out["stored"] == 0
    _nothing_stored(ctx)


def test_resposta_vazia_nao_grava(ctx):
    seed(ctx)
    ctx.use("   ")
    assert ctx.run("alerts_explain")["stored"] == 0
    _nothing_stored(ctx)


def test_cota_esgotada_interrompe_o_laco(ctx):
    seed(ctx)
    out = ctx.run("alerts_explain", settings=make_settings(ai_monthly_token_cap=0))
    assert out["skipped"] == "ai_unavailable" and ctx.provider.requests == []


def test_falha_de_uma_unidade_nao_impede_as_demais(ctx):
    seed(ctx)
    ctx.use(AIResult.neutral("timeout", provider="openai"), "Texto da segunda.")
    out = ctx.run("alerts_explain")
    assert out["stored"] == 1 and len(ctx.provider.requests) == 2


def test_dado_pessoal_no_dto_bloqueia_o_envio(ctx):
    seed(ctx)
    with ctx.world.session() as db:
        from app.models.units import Unit

        db.get(Unit, ctx.ua).name = "Unidade fulano@exemplo.com"
    out = ctx.run("alerts_explain")
    assert out["stored"] == 1  # só a unidade B; A foi bloqueada pela varredura
    sent = ctx.provider.sent()
    assert "fulano@exemplo.com" not in sent and len(ctx.provider.requests) == 1


def test_task_nao_aplica_rate_limit_de_usuario(ctx):
    seed(ctx)
    out = ctx.run("alerts_explain", settings=make_settings(ai_rate_limit_per_user=1, ai_rate_limit_per_unit=1))
    assert out["stored"] == 2


def test_regra_com_erro_nao_derruba_a_geracao(ctx):
    from app.services.alerts.rules import AlertItem, AlertRule

    seed(ctx)
    rules = [
        AlertRule("boom", lambda _c: 1 / 0),
        AlertRule("assets_no_location", lambda _c: [AlertItem("assets_no_location", "warning", "t", "d", 6)]),
    ]
    assert ctx.run("alerts_explain", rules=rules)["stored"] == 2


def test_chaves_nunca_aparecem_em_logs(ctx, caplog):
    seed(ctx)
    caplog.set_level(logging.DEBUG)
    ctx.use(AIResult.neutral("auth_error", provider="openai"))
    ctx.run("alerts_explain")
    for key in ALL_FAKE_KEYS:
        assert key not in caplog.text


# --- escopo: o conjunto de regras NÃO enxerga outras unidades -----------------------------------------


def test_evaluate_unit_alerts_so_ve_a_propria_unidade(ctx):
    seed(ctx)
    from datetime import datetime, timezone

    items = ins.evaluate_unit_alerts(
        ctx.ua, session_factory=ctx.world.session, settings=make_settings(), now=datetime.now(timezone.utc)
    )
    assert {i.code: i.count for i in items}["assets_no_location"] == 6


# --- Celery ------------------------------------------------------------------------------------------------


def test_tasks_registradas_e_no_beat():
    names = {"sispat.ai.alerts_priority", "sispat.ai.executive_summary", "sispat.ai.quality_suggestions"}
    assert names <= set(celery_app.tasks)
    assert {e["task"] for e in celery_app.conf.beat_schedule.values()} == names
    assert all(not e.get("args") and not e.get("kwargs") for e in celery_app.conf.beat_schedule.values())


@pytest.mark.parametrize(
    "task,feature",
    [(ai_tasks.generate_alerts_priority, "alerts_explain"),
     (ai_tasks.generate_executive_summary, "executive_summary"),
     (ai_tasks.generate_quality_suggestions, "data_quality")],
)
def test_task_respeita_flag_e_nunca_lanca(monkeypatch, task, feature):
    monkeypatch.setattr(ai_tasks, "_load_config", lambda: AIConfig())
    out = task.run()
    assert out["feature"] == feature and out["stored"] == 0 and out["skipped"] in {"feature_disabled", "ai_unavailable"}

    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(ai_tasks, "_load_config", boom)
    assert task.run()["skipped"] == "internal_error"


def test_run_insight_task_usa_config_e_funcao_do_nucleo(ctx):
    seed(ctx)
    out = ai_tasks.run_insight_task(
        "alerts_explain", config=make_config(), session_factory=ctx.world.session,
        settings=make_settings(), redis_client=ctx.redis, audit_writer=ctx.rows.append,
    )
    assert out["stored"] == 2
