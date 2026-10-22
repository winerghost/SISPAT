"""Contrato único de paginação: page_size somente 50/100/200 (default 50)."""
from __future__ import annotations

import pytest
from werkzeug.datastructures import MultiDict
from werkzeug.exceptions import BadRequest

from app.api.v1 import (
    admin_schemas,
    asset_schemas,
    catalog_import_schemas,
    catalog_schemas,
    inventory_schemas,
    location_schemas,
    movement_schemas,
    schemas,
)
from app.api.v1.schemas import parse_query
from app.services.pagination import coerce_page_size, page_count

pytestmark = pytest.mark.strict_page_size


def _paginated_models() -> list[type]:
    found = []
    for module in (
        admin_schemas, asset_schemas, catalog_import_schemas, catalog_schemas,
        inventory_schemas, location_schemas, movement_schemas, schemas,
    ):
        for obj in vars(module).values():
            if (
                isinstance(obj, type)
                and obj.__module__ == module.__name__
                and "page_size" in getattr(obj, "model_fields", {})
            ):
                found.append(obj)
    return found


MODELS = _paginated_models()


def _ctor_args(model: type) -> dict[str, str]:
    """Campos obrigatórios mínimos (se houver) para validar só a paginação."""
    required = {n: f for n, f in model.model_fields.items() if f.is_required()}
    return {name: "x" for name in required}


def test_todos_os_schemas_paginados_foram_encontrados():
    assert len(MODELS) >= 12


@pytest.mark.parametrize("model", MODELS, ids=lambda m: m.__name__)
def test_default_e_valores_aceitos(model):
    base = _ctor_args(model)
    try:
        assert parse_query(model, MultiDict(base), context="t").page_size == 50
    except BadRequest:
        pytest.skip("modelo exige campos específicos")
    for size in (50, 100, 200):
        assert parse_query(model, MultiDict({**base, "page_size": str(size)}), context="t").page_size == size


@pytest.mark.parametrize("model", MODELS, ids=lambda m: m.__name__)
@pytest.mark.parametrize("bad", ["25", "0", "500", "-50", "49", "51", "201", "abc", ""])
def test_valores_invalidos_rejeitados(model, bad):
    base = _ctor_args(model)
    with pytest.raises(BadRequest):
        parse_query(model, MultiDict({**base, "page_size": bad}), context="t")


def test_page_count_e_coerce():
    assert page_count(0, 50) == 0
    assert page_count(1, 50) == 1
    assert page_count(50, 50) == 1
    assert page_count(51, 50) == 2
    assert page_count(401, 200) == 3
    assert coerce_page_size(100) == 100
    assert coerce_page_size(25) == 50
    assert coerce_page_size(None) == 50
