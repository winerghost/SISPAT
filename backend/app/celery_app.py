"""Aplicação Celery do SISPAT-AGU (worker único com beat embutido: `worker -B`).

- Broker/result backend: `CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND`
  (padrão: REDIS_URL, ver `app.config.settings`).
- Serialização SOMENTE JSON (pickle desabilitado: evita execução de código
  a partir de mensagens da fila).
- Limites de tempo por task; prefetch 1; horários em UTC.
- Arquivo de estado do beat: `CELERY_BEAT_SCHEDULE_FILENAME` (settings).
- `beat_schedule` começa vazio: tasks periódicas (ex.: resumo executivo) são
  adicionadas nas próximas etapas, sempre degradando para NullProvider.

Uso: `celery -A app.celery_app worker -B --loglevel=info`.
"""
from __future__ import annotations

from celery import Celery

from app.config.settings import Settings, get_settings

TASK_TIME_LIMIT_SECONDS = 120
TASK_SOFT_TIME_LIMIT_SECONDS = 90


def create_celery(settings: Settings | None = None) -> Celery:
    s = settings or get_settings()
    app = Celery(
        "sispat",
        broker=s.celery_broker_url,
        backend=s.celery_result_backend,
        include=["app.tasks.ai_tasks"],
    )
    app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        result_accept_content=["json"],
        timezone="UTC",
        enable_utc=True,
        task_time_limit=TASK_TIME_LIMIT_SECONDS,
        task_soft_time_limit=TASK_SOFT_TIME_LIMIT_SECONDS,
        task_acks_late=False,
        worker_prefetch_multiplier=1,
        worker_hijack_root_logger=False,
        result_expires=3600,
        broker_connection_retry_on_startup=True,
        beat_schedule={},
        # O container do worker é read_only: o arquivo de estado do beat
        # fica, por padrão, no tmpfs privado /tmp (efêmero; o agendamento vem
        # do código). Configurável: CELERY_BEAT_SCHEDULE_FILENAME (AI-SAST-01).
        beat_schedule_filename=s.celery_beat_schedule_filename,
    )
    return app


celery_app = create_celery()
# Alias procurado por `celery -A app.celery_app` (atributo `celery`).
celery = celery_app
