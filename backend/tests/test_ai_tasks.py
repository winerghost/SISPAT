"""Celery (app.celery_app) e task placeholder de IA — sem broker nem rede."""
from __future__ import annotations

from app.celery_app import celery_app, create_celery
from app.services.ai.factory import AIConfig
from app.services.ai.models import AI_FEATURES
from app.tasks import ai_tasks
from test_ai_support import FakeRedis, FakeSession, make_settings, openai_ok


def test_ai_celery_is_json_only_with_time_limits() -> None:
    conf = celery_app.conf
    assert conf.task_serializer == "json" and conf.result_serializer == "json"
    assert list(conf.accept_content) == ["json"]
    assert list(conf.result_accept_content) == ["json"]
    assert "pickle" not in str(conf.accept_content)
    assert conf.task_time_limit and conf.task_soft_time_limit < conf.task_time_limit
    assert conf.enable_utc is True
    assert conf.beat_schedule_filename.startswith("/tmp/")


def test_ai_celery_uses_settings_broker() -> None:
    app = create_celery(make_settings(redis_url="redis://cache:6379/3"))
    assert app.conf.broker_url == "redis://cache:6379/3"
    assert app.conf.result_backend == "redis://cache:6379/3"


def test_ai_ping_task_is_registered() -> None:
    assert "sispat.ai.ping_provider" in celery_app.tasks


def test_ai_ping_disabled_uses_null_provider_without_network() -> None:
    session = FakeSession(openai_ok())
    out = ai_tasks.run_ping(AIConfig(), probe=True, settings=make_settings(ai_enabled=False),
                            redis_client=None, session=session)
    assert out == {"status": "disabled", "probed": False, "reason": "disabled"}
    assert session.calls == []


def test_ai_ping_active_probe_uses_fixed_prompt(monkeypatch) -> None:
    audit_rows = []
    monkeypatch.setattr("app.services.ai.usage._default_writer", audit_rows.append)
    config = AIConfig(enabled=True, provider="openai", features={f: True for f in AI_FEATURES})
    session = FakeSession(openai_ok("OK"))
    out = ai_tasks.run_ping(config, probe=True, settings=make_settings(), redis_client=FakeRedis(),
                            session=session)
    assert out == {"status": "active", "probed": True, "result": "ok"}
    assert len(session.calls) == 1
    assert audit_rows and audit_rows[0].operation == "AI_USAGE"


def test_ai_ping_task_never_raises_when_db_unavailable(monkeypatch) -> None:
    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(ai_tasks, "_load_config", boom)
    out = ai_tasks.ping_ai_provider.run()
    assert out["status"] == "unavailable"


def test_ai_ping_task_with_default_config_is_disabled(monkeypatch) -> None:
    monkeypatch.setattr(ai_tasks, "_load_config", lambda: AIConfig())
    out = ai_tasks.ping_ai_provider.run()
    assert out["status"] == "disabled" and out["probed"] is False
