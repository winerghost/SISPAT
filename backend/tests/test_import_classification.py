"""Importação x classificação de bens: preenche SÓ quando nula (nunca sobrescreve)."""
from __future__ import annotations

from sqlalchemy import select
from test_import_links import _confirm, _line, _service, world  # noqa: F401

from app.models.assets import Asset


def _only_asset(world) -> Asset:
    return world.db.execute(select(Asset)).scalars().one()


def test_bem_novo_recebe_classificacao_pela_regra(world) -> None:
    service = _service(world, [_line()])  # "(00138020-6) NOTEBOOK |"
    _confirm(service, world.db, service.create_preview(__import__("uuid").uuid4()))
    asset = _only_asset(world)
    assert (asset.asset_category, asset.tech_type) == ("TECNOLOGIA", "NOTEBOOK")
    assert asset.operational_status is None  # situação operacional nunca é deduzida


def test_descricao_sem_regra_fica_nao_classificada(world) -> None:
    service = _service(world, [_line(DESCRICAO="(1) OBJETO MISTERIOSO |")])
    _confirm(service, world.db, service.create_preview(__import__("uuid").uuid4()))
    asset = _only_asset(world)
    assert asset.asset_category is None and asset.tech_type is None


def test_reimportacao_nao_sobrescreve_classificacao_existente(world) -> None:
    import uuid

    actor = uuid.uuid4()
    first = _service(world, [_line()])
    _confirm(first, world.db, first.create_preview(actor))
    asset = _only_asset(world)
    asset.asset_category, asset.tech_type = "OUTROS", None  # ajuste manual
    world.db.commit()
    again = _service(world, [_line(DESCRICAO="(00138020-6) NOTEBOOK NOVO |")])
    _confirm(again, world.db, again.create_preview(actor))
    world.db.refresh(asset)
    assert (asset.asset_category, asset.tech_type) == ("OUTROS", None)


def test_reimportacao_preenche_bem_existente_sem_categoria(world) -> None:
    import uuid

    actor = uuid.uuid4()
    first = _service(world, [_line(DESCRICAO="(1) OBJETO MISTERIOSO |")])
    _confirm(first, world.db, first.create_preview(actor))
    asset = _only_asset(world)
    assert asset.asset_category is None
    again = _service(world, [_line(DESCRICAO="(1) CADEIRA GIRATORIA |")])
    _confirm(again, world.db, again.create_preview(actor))
    world.db.refresh(asset)
    assert asset.asset_category == "MOBILIARIO" and asset.tech_type is None
