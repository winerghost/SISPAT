"""Backfill do motor família/categoria (`flask classify-equipment`).

SQLite com o schema REAL dos modelos (`_catalog_db`); nada toca Supabase.
Garante: dry-run por padrão, idempotência, incremento de `version`,
`category_override` intocado, bem excluído e bem sem descrição preservados.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import click.testing
import pytest
from sqlalchemy import select

from _catalog_db import build_engine, new_session

from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.units import Unit
from app.services import asset_classification as ac
from app.services.asset_classification_backfill import (
    OP_EQUIPMENT_CLASSIFIED,
    classify_existing_equipment,
    list_low_confidence_equipment,
)

DESCRICOES = {
    "A1": "MONITOR LED 24 POLEGADAS",
    "A2": "MONITOR LED 27 POLEGADAS",
    "A3": "MESA DE REUNIAO REDONDA",
    "A4": "OBJETO TOTALMENTE DESCONHECIDO",  # sem regra: OUTROS/BAIXA
}


@pytest.fixture()
def world():
    db = new_session(build_engine())
    unit = Unit(id=uuid.uuid4(), code="023404", name="Unidade Estadual", active=True)
    db.add(unit)
    db.flush()
    yield SimpleNamespace(db=db, unit_id=unit.id)
    db.close()


def _asset(world, patrimony: str, description: str | None, **kw) -> Asset:
    asset = Asset(
        id=uuid.uuid4(),
        patrimony_number=patrimony,
        description=description,
        unit_id=world.unit_id,
        located="DESCONHECIDO",
        version=1,
        **kw,
    )
    world.db.add(asset)
    world.db.flush()
    return asset


def _seed(world) -> dict[str, Asset]:
    assets = {p: _asset(world, p, d) for p, d in DESCRICOES.items()}
    # override do ADM: nunca reclassificado nem sobrescrito
    assets["A5"] = _asset(world, "A5", "NOTEBOOK DELL LATITUDE", category_override="MESA")
    # sem descrição: continua "não informado" (nada é inventado)
    assets["A6"] = _asset(world, "A6", None)
    # excluído logicamente: fora do backfill
    assets["A7"] = _asset(
        world,
        "A7",
        "IMPRESSORA LASER",
        deleted_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        deleted_by=None,
    )
    world.db.commit()
    return assets


def _row(world, patrimony: str) -> Asset:
    world.db.expire_all()
    return world.db.execute(
        select(Asset).where(Asset.patrimony_number == patrimony)
    ).scalar_one()


def _classification(asset: Asset) -> tuple:
    return tuple(getattr(asset, name) for name in ac.CLASSIFICATION_COLUMNS)


def test_dry_run_e_o_padrao_e_nao_grava_nada(world) -> None:
    _seed(world)
    report = classify_existing_equipment(world.db)  # sem apply=
    assert report.dry_run is True
    assert report.candidates == 4  # A1..A4 (A5 tem override, A6 sem descrição, A7 excluído)
    assert report.updated == 4
    assert report.unchanged == 0
    assert report.skipped_overridden == 1
    assert report.skipped_no_description == 1
    assert report.low_confidence == 1  # A4: sem regra
    assert dict(report.by_family) == {"TI": 2, "MOBILIARIO": 1, "OUTROS": 1}
    assert dict(report.by_category) == {"MONITOR": 2, "MESA": 1, "OUTROS": 1}
    for patrimony in DESCRICOES:
        row = _row(world, patrimony)
        assert _classification(row) == (None,) * len(ac.CLASSIFICATION_COLUMNS)
        assert row.version == 1
    assert world.db.execute(select(AuditLog)).scalars().all() == []


def test_apply_classifica_incrementa_version_e_audita(world) -> None:
    _seed(world)
    report = classify_existing_equipment(world.db, apply=True)
    assert report.dry_run is False and report.updated == 4
    world.db.commit()
    monitor = _row(world, "A1")
    assert _classification(monitor) == (
        "TI", "MONITOR", "ALTA", "6_MONITOR:MONITOR", ac.RULES_VERSION,
    )
    assert monitor.version == 2  # controle otimista
    assert _row(world, "A3").equipment_category == "MESA"
    sem_regra = _row(world, "A4")
    assert (sem_regra.equipment_family, sem_regra.equipment_category) == ("OUTROS", "OUTROS")
    assert sem_regra.classification_confidence == "BAIXA"
    (audit,) = world.db.execute(
        select(AuditLog).where(AuditLog.operation == OP_EQUIPMENT_CLASSIFIED)
    ).scalars()
    assert audit.new_values["updated"] == 4
    assert audit.new_values["rules_version"] == ac.RULES_VERSION
    assert audit.previous_values is None
    # o vocabulário legado da 0015 não é tocado por este backfill
    assert monitor.asset_category is None and monitor.tech_type is None


def test_segunda_execucao_nao_altera_nada(world) -> None:
    _seed(world)
    classify_existing_equipment(world.db, apply=True)
    world.db.commit()
    antes = {p: (_classification(_row(world, p)), _row(world, p).version) for p in DESCRICOES}
    again = classify_existing_equipment(world.db, apply=True)
    world.db.commit()
    assert again.updated == 0  # idempotente
    assert again.unchanged == 4
    assert again.candidates == 4
    for patrimony, (classification, version) in antes.items():
        row = _row(world, patrimony)
        assert _classification(row) == classification
        assert row.version == version  # `version` NÃO é incrementado de novo
    audits = world.db.execute(
        select(AuditLog).where(AuditLog.operation == OP_EQUIPMENT_CLASSIFIED)
    ).scalars().all()
    assert len(audits) == 1  # a 2ª execução não audita (nada mudou)


def test_override_do_adm_e_bem_excluido_ficam_intocados(world) -> None:
    _seed(world)
    classify_existing_equipment(world.db, apply=True)
    world.db.commit()
    override = _row(world, "A5")
    assert override.category_override == "MESA"
    assert _classification(override) == (None,) * len(ac.CLASSIFICATION_COLUMNS)
    assert override.version == 1
    sem_descricao = _row(world, "A6")
    assert _classification(sem_descricao) == (None,) * len(ac.CLASSIFICATION_COLUMNS)
    assert sem_descricao.version == 1
    excluido = _row(world, "A7")
    assert _classification(excluido) == (None,) * len(ac.CLASSIFICATION_COLUMNS)
    assert excluido.version == 1


def test_nova_versao_de_regras_reclassifica(world, monkeypatch) -> None:
    _seed(world)
    classify_existing_equipment(world.db, apply=True)
    world.db.commit()
    monkeypatch.setattr(ac, "RULES_VERSION", "99")
    report = classify_existing_equipment(world.db, apply=True)
    world.db.commit()
    assert report.updated == 4 and report.unchanged == 0
    monitor = _row(world, "A1")
    assert monitor.classification_rules_version == "99"
    assert monitor.version == 3


def test_listagem_de_baixa_confianca_e_somente_leitura(world) -> None:
    _seed(world)
    classify_existing_equipment(world.db, apply=True)
    world.db.commit()
    items = list_low_confidence_equipment(world.db)
    assert [description for _, description in items] == [DESCRICOES["A4"]]
    uuid.UUID(items[0][0])  # id válido
    assert _row(world, "A1").version == 2  # nada gravado pela listagem


def test_cli_classify_equipment_e_dry_run_por_padrao(monkeypatch) -> None:
    from contextlib import contextmanager

    from app.cli import classify_equipment_command

    calls: list[bool] = []

    class _Report:
        dry_run = True
        candidates, updated, unchanged, low_confidence = 4, 3, 1, 1
        skipped_overridden, skipped_no_description = 2, 1
        by_family = {"TI": 2}
        by_category = {"MONITOR": 2}

    @contextmanager
    def fake_session():
        yield object()

    def fake_classify(db, *, apply):
        calls.append(apply)
        return _Report()

    monkeypatch.setattr("app.cli.get_db_session", fake_session)
    monkeypatch.setattr("app.cli.classify_existing_equipment", fake_classify)
    runner = click.testing.CliRunner()
    result = runner.invoke(classify_equipment_command, [])
    assert result.exit_code == 0 and calls == [False]
    assert "Dry-run" in result.output and "nada foi gravado" in result.output.lower()
    assert runner.invoke(classify_equipment_command, ["--apply"]).exit_code == 0
    assert calls == [False, True]
    # --list-low-confidence é somente leitura: não combina com --apply
    conflito = runner.invoke(classify_equipment_command, ["--apply", "--list-low-confidence"])
    assert conflito.exit_code != 0 and calls == [False, True]
