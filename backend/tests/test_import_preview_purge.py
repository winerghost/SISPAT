"""Expurgo de prévias de importação (`flask purge-import-previews`), SQLite com schema real."""
from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from _catalog_db import build_engine, new_session
from sqlalchemy import func, select

from app.models.audit import AuditLog
from app.models.imports import ImportPreview, ImportPreviewItem
from app.models.rbac import User
from app.models.sync import RawImportRecord, SyncJob
from app.services.import_preview_purge import (
    FINAL_PREVIEW_STATUSES,
    OPERATION_PURGED,
    purge_import_previews,
)

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


@pytest.fixture()
def engine():
    return build_engine()


@pytest.fixture()
def seed(engine):
    """Cenário: prévias de todos os status/idades + registros brutos."""
    ids: dict[str, uuid.UUID] = {}
    with new_session(engine) as db:
        user = User(id=uuid.uuid4(), name="Operador", email="op@agu.gov.br", active=True, version=1)
        db.add(user)
        job = SyncJob(id=uuid.uuid4(), source="google_sheets", status="CONCLUIDO")
        db.add(job)
        db.flush()
        for n in range(3):
            db.add(
                RawImportRecord(
                    id=uuid.uuid4(),
                    sync_job_id=job.id,
                    source_record_id=f"ID-{n}",
                    raw_values={"PATRIMONIO": f"00{n}"},
                    import_status="IMPORTADO",
                )
            )

        def preview(key: str, status: str, created_days_ago: float, expires_days_ago: float, items: int = 2):
            created = NOW - timedelta(days=created_days_ago)
            p = ImportPreview(
                id=uuid.uuid4(),
                requested_by=user.id,
                status=status,
                created_at=created,
                expires_at=NOW - timedelta(days=expires_days_ago),
            )
            db.add(p)
            db.flush()
            for i in range(items):
                db.add(
                    ImportPreviewItem(
                        id=uuid.uuid4(),
                        preview_id=p.id,
                        raw_values={"PATRIMONIO": f"{key}-{i}"},
                        classification="NOVO",
                        created_at=created,
                    )
                )
            ids[key] = p.id

        # apagáveis com N=7
        preview("confirmada_velha", "CONFIRMADA", 10, 9.9)
        preview("expirada_velha", "EXPIRADA", 30, 29.9)
        preview("falhou_velha", "FALHOU", 8, 7.9, items=0)
        preview("concluida_expirada_velha", "CONCLUIDA", 20, 19.9, items=3)
        preview("processando_travada", "PROCESSANDO", 15, 14.9)
        # preservadas com N=7
        preview("concluida_em_revisao", "CONCLUIDA", 0.01, -0.04)  # expira no futuro
        preview("concluida_expirada_recente", "CONCLUIDA", 2, 1.9)
        preview("confirmada_recente", "CONFIRMADA", 1, 0.9)
        preview("expirada_recente", "EXPIRADA", 3, 2.9)
        db.commit()
    return ids


def _count(engine, model) -> int:
    with new_session(engine) as db:
        return int(db.execute(select(func.count()).select_from(model)).scalar_one())


def _remaining(engine) -> set[uuid.UUID]:
    with new_session(engine) as db:
        return set(db.execute(select(ImportPreview.id)).scalars())


def _audits(engine) -> list[AuditLog]:
    with new_session(engine) as db:
        return list(db.execute(select(AuditLog).where(AuditLog.operation == OPERATION_PURGED)).scalars())


def _run(engine, **kwargs):
    with new_session(engine) as db:
        result = purge_import_previews(db, now=NOW, **kwargs)
        db.commit()
    return result


def test_status_finais_reais_do_check():
    check = next(c for c in ImportPreview.__table__.constraints if c.name == "ck_import_previews_status")
    declared = set(str(check.sqltext).split("(", 1)[1].rstrip(")").replace("'", "").split(","))
    assert set(FINAL_PREVIEW_STATUSES) <= declared
    assert {"PROCESSANDO", "CONCLUIDA"} <= declared - set(FINAL_PREVIEW_STATUSES)


def test_apaga_so_elegiveis_e_preserva_raw_import_records(engine, seed):
    raw_before = _count(engine, RawImportRecord)
    result = _run(engine, older_than_days=7)
    assert (result.previews, result.items, result.dry_run) == (5, 9, False)
    keep = {
        "concluida_em_revisao",
        "concluida_expirada_recente",
        "confirmada_recente",
        "expirada_recente",
    }
    assert _remaining(engine) == {seed[k] for k in keep}
    assert _count(engine, ImportPreviewItem) == 2 * len(keep)
    with new_session(engine) as db:
        orphan = db.execute(
            select(func.count(ImportPreviewItem.id)).where(
                ImportPreviewItem.preview_id.not_in(select(ImportPreview.id))
            )
        ).scalar_one()
    assert orphan == 0
    assert _count(engine, RawImportRecord) == raw_before == 3
    assert _count(engine, SyncJob) == 1


def test_auditoria_so_com_contagens(engine, seed):
    _run(engine, older_than_days=7)
    (audit,) = _audits(engine)
    assert audit.entity_type == "import_previews" and audit.entity_id is None
    assert audit.result == "SUCESSO" and audit.actor_user_id is None
    assert audit.new_values["previews_deleted"] == 5
    assert audit.new_values["items_deleted"] == 9
    assert audit.new_values["older_than_days"] == 7
    dumped = json.dumps([audit.previous_values, audit.new_values])
    assert "PATRIMONIO" not in dumped and "op@agu" not in dumped and "Operador" not in dumped
    assert not any(str(v) in dumped for v in seed.values())


def test_auditoria_marca_origem_cli(engine, seed):
    """SEC-1021-04: sem actor_user_id, a auditoria identifica a origem CLI."""
    _run(engine, older_than_days=7)
    (audit,) = _audits(engine)
    assert audit.new_values["origin"] == "cli"


def test_auditoria_usa_linhas_de_fato_apagadas(engine, seed):
    """SEC-1021-03: um item apagado por outro processo entre a contagem e o
    DELETE não pode aparecer na auditoria (contagem = rowcount do DELETE)."""
    from sqlalchemy import delete as sa_delete
    from sqlalchemy import event

    with new_session(engine) as db:
        victim = db.execute(
            select(ImportPreviewItem.id).where(ImportPreviewItem.preview_id == seed["confirmada_velha"])
        ).scalars().first()
        fired = {"done": False}

        @event.listens_for(db, "do_orm_execute")
        def _concurrent_delete(state):
            if state.is_delete and not fired["done"]:
                fired["done"] = True
                state.session.connection().execute(
                    sa_delete(ImportPreviewItem.__table__).where(ImportPreviewItem.__table__.c.id == victim)
                )

        result = purge_import_previews(db, older_than_days=7, now=NOW)
        db.commit()
    assert fired["done"]
    assert (result.previews, result.items) == (5, 8)
    (audit,) = _audits(engine)
    assert audit.new_values["items_deleted"] == 8


def test_dry_run_so_conta(engine, seed):
    result = _run(engine, older_than_days=7, dry_run=True)
    assert (result.previews, result.items, result.dry_run) == (5, 9, True)
    assert _remaining(engine) == set(seed.values())
    assert _audits(engine) == []


def test_idempotente(engine, seed):
    _run(engine, older_than_days=7)
    second = _run(engine, older_than_days=7)
    assert (second.previews, second.items) == (0, 0)
    assert len(_remaining(engine)) == 4


def test_corte_maior_preserva_mais(engine, seed):
    result = _run(engine, older_than_days=25)
    assert result.previews == 1  # só a EXPIRADA de 30 dias
    assert seed["expirada_velha"] not in _remaining(engine)


def test_corte_minimo_nao_apaga_prevista_em_revisao(engine, seed):
    _run(engine, older_than_days=1)
    remaining = _remaining(engine)
    assert seed["concluida_em_revisao"] in remaining
    assert seed["concluida_expirada_recente"] not in remaining  # expirou há 1,9 dia


@pytest.mark.parametrize("days", [0, -1, 366, True, "7", 7.0])
def test_dias_fora_do_limite_rejeitados(engine, seed, days):
    with new_session(engine) as db, pytest.raises(ValueError):
        purge_import_previews(db, older_than_days=days, now=NOW)
    assert len(_remaining(engine)) == len(seed)


def test_falha_no_meio_desfaz_tudo(engine, seed):
    with new_session(engine) as db:
        with patch.object(db, "flush", side_effect=RuntimeError("boom")), pytest.raises(RuntimeError):
            purge_import_previews(db, older_than_days=7, now=NOW)
        db.rollback()
    assert _remaining(engine) == set(seed.values())
    assert _audits(engine) == []


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@pytest.fixture()
def cli(engine, seed):
    from app import create_app

    @contextmanager
    def _session():
        db = new_session(engine)
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    # A CLI usa o relógio real (`utcnow`) e o cenário é relativo a NOW fixo: sem congelar o
    # relógio, o resultado dependia da data de execução (falha a partir de 2026-10-2x).
    with patch("app.cli.get_db_session", _session), patch(
        "app.services.import_preview_purge.utcnow", return_value=NOW
    ):
        yield create_app().test_cli_runner()


def test_cli_registrado_e_dry_run(cli, engine, seed):
    result = cli.invoke(args=["purge-import-previews", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "seriam apagadas" in result.output
    assert len(_remaining(engine)) == len(seed)


def test_cli_apaga_com_padrao_7_dias(cli, engine, seed):
    result = cli.invoke(args=["purge-import-previews"])
    assert result.exit_code == 0, result.output
    assert "apagadas: 5 (itens: 9)" in result.output
    assert len(_remaining(engine)) == 4
    assert len(_audits(engine)) == 1


@pytest.mark.parametrize("value", ["0", "366", "-3", "abc"])
def test_cli_rejeita_dias_invalidos(cli, engine, seed, value):
    result = cli.invoke(args=["purge-import-previews", "--older-than-days", value])
    assert result.exit_code != 0
    assert len(_remaining(engine)) == len(seed)


def test_cli_falha_nao_vaza_detalhes(cli, engine, seed):
    with patch(
        "app.cli.purge_import_previews",
        side_effect=RuntimeError("postgresql://user:segredo@host/db"),
    ):
        result = cli.invoke(args=["purge-import-previews"])
    assert result.exit_code != 0
    assert "segredo" not in result.output and "RuntimeError" in result.output
