"""Sync Sheets -> Flask -> PostgreSQL x motor família/categoria.

O sync RECLASSIFICA pela descrição atual (ao contrário do vocabulário legado
da 0015, que só preenche quando nulo), mas o `category_override` do ADM sempre
prevalece. Reaproveita o mundo de `test_import_links` (SQLite, sem rede).
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from test_import_links import _confirm, _line, _service, world  # noqa: F401

from app.models.assets import Asset
from app.services import asset_classification as ac

ACTOR = uuid.uuid4()


def _only_asset(world) -> Asset:  # noqa: F811
    return world.db.execute(select(Asset)).scalars().one()


def _classification(asset: Asset) -> tuple:
    return tuple(getattr(asset, name) for name in ac.CLASSIFICATION_COLUMNS)


def _import(world, description: str) -> None:  # noqa: F811
    service = _service(world, [_line(DESCRICAO=description)])
    _confirm(service, world.db, service.create_preview(ACTOR))


def test_bem_novo_recebe_familia_e_categoria(world) -> None:  # noqa: F811
    _import(world, "(00138020-6) MONITOR LED 24 POLEGADAS |")
    asset = _only_asset(world)
    assert (asset.equipment_family, asset.equipment_category) == ("TI", "MONITOR")
    assert asset.classification_confidence == "ALTA"
    assert asset.classification_rule.startswith("6_MONITOR")
    assert asset.classification_rules_version == ac.RULES_VERSION
    assert asset.category_override is None  # o motor nunca escreve o override


def test_descricao_sem_regra_fica_outros_com_confianca_baixa(world) -> None:  # noqa: F811
    _import(world, "(1) OBJETO MISTERIOSO |")
    asset = _only_asset(world)
    assert (asset.equipment_family, asset.equipment_category) == ("OUTROS", "OUTROS")
    assert asset.classification_confidence == "BAIXA"
    assert asset.classification_rule == ac.NO_RULE


def test_reimportacao_com_nova_descricao_reclassifica(world) -> None:  # noqa: F811
    _import(world, "(1) OBJETO MISTERIOSO |")
    asset = _only_asset(world)
    assert asset.equipment_category == "OUTROS"
    version = asset.version
    _import(world, "(1) NOTEBOOK DELL LATITUDE |")
    world.db.refresh(asset)
    assert (asset.equipment_family, asset.equipment_category) == ("TI", "NOTEBOOK")
    assert asset.version == version + 1


def test_reimportacao_identica_nao_grava_nem_incrementa_version(world) -> None:  # noqa: F811
    _import(world, "(00138020-6) MONITOR LED 24 POLEGADAS |")
    asset = _only_asset(world)
    before = (_classification(asset), asset.version)
    _import(world, "(00138020-6) MONITOR LED 24 POLEGADAS |")
    world.db.refresh(asset)
    assert (_classification(asset), asset.version) == before  # INALTERADO


def test_bem_sem_classificacao_conta_como_atualizado_uma_vez(world) -> None:  # noqa: F811
    """Efeito único após o deploy: bem anterior ao motor é classificado no
    primeiro sync (conta como atualizado) e, dali em diante, fica INALTERADO."""
    _import(world, "(00138020-6) MONITOR LED 24 POLEGADAS |")
    asset = _only_asset(world)
    for name in ac.CLASSIFICATION_COLUMNS:  # simula bem anterior à migração
        setattr(asset, name, None)
    asset.version = asset.version + 1
    world.db.commit()
    service = _service(world, [_line(DESCRICAO="(00138020-6) MONITOR LED 24 POLEGADAS |")])
    out = _confirm(service, world.db, service.create_preview(ACTOR))
    assert out["updated"] == 1 and out["inalterados"] == 0
    world.db.refresh(asset)
    assert (asset.equipment_family, asset.equipment_category) == ("TI", "MONITOR")
    service = _service(world, [_line(DESCRICAO="(00138020-6) MONITOR LED 24 POLEGADAS |")])
    out = _confirm(service, world.db, service.create_preview(ACTOR))
    assert out["updated"] == 0 and out["inalterados"] == 1  # idempotente a partir daqui


def test_override_do_adm_prevalece_sobre_o_sync(world) -> None:  # noqa: F811
    _import(world, "(00138020-6) MONITOR LED 24 POLEGADAS |")
    asset = _only_asset(world)
    asset.category_override = "MESA"  # decisão do ADM
    asset.version = asset.version + 1
    world.db.commit()
    classificacao = _classification(asset)
    _import(world, "(1) NOTEBOOK DELL LATITUDE |")
    world.db.refresh(asset)
    assert asset.category_override == "MESA"  # preservado
    assert _classification(asset) == classificacao  # regra NÃO reescreveu nada
    assert "NOTEBOOK DELL LATITUDE" in (asset.description or "")  # a descrição, sim
    assert ac.effective_equipment_category(asset) == "MESA"
    assert ac.effective_equipment_family(asset) == "MOBILIARIO"
