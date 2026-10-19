"""Regressão de desempenho da pré-visualização (N+1 contra o Postgres remoto).

Sessão e cliente do Sheets são mocks; o que se mede é o NÚMERO de consultas
e a equivalência de classificação com a busca unitária por linha.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from app.integrations.google_sheets_client import GoogleSheetsReadResult
from app.models.assets import Asset
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit, UnitAlias
from app.services.import_service import ImportService
from app.services.patrimony_lock import normalize_patrimony_number

N_ROWS = 1069


def _rows() -> list[dict]:
    rows = []
    for i in range(N_ROWS):
        # 1 em 10: patrimônio repetido (DUPLICADO); 1 em 7: já existente;
        # 1 em 50: duplo no banco (CONFLITANTE); 1 em 97: sem patrimônio.
        pat = f"{i // 10 * 10 if i % 10 == 9 else i}"
        errs = []
        if i % 97 == 0:
            pat = None
            errs = ["erro: campo PATRIMONIO ausente ou vazio"]
        rows.append(
            {
                "source_row_number": i + 2,
                "raw_values": {"PATRIMONIO": pat, "ID": str(i)},
                "normalized_values": {
                    "PATRIMONIO": pat,
                    "ID": str(i),
                    "DESCRICAO": f"item {i}",
                    "UNIDADE": "SEDE",
                    "responsavel_pessoa": "Fulana de Tal",
                },
                "validation_errors": errs,
            }
        )
    return rows


def _db_and_assets():
    unit = Unit(id=uuid.uuid4(), code="U1", name="Sede", active=True)
    assets = []
    for i in range(0, N_ROWS, 7):
        assets.append(Asset(id=uuid.uuid4(), patrimony_number=f" {i} ", unit_id=unit.id, version=2))
    for i in range(0, N_ROWS, 50):
        assets.append(Asset(id=uuid.uuid4(), patrimony_number=f"{i}", unit_id=unit.id, version=1))
    db = MagicMock()
    counts: dict[str, int] = {}
    models = {
        Unit: [unit],
        UnitAlias: [UnitAlias(alias="SEDE", unit_id=unit.id)],
    }

    def query(model):
        counts[model.__name__] = counts.get(model.__name__, 0) + 1
        m = MagicMock()
        m.all.return_value = models.get(model, [])
        # O mock não avalia o IN: o 1º lote devolve todos os assets, os demais [].
        first = model is Asset and counts[model.__name__] == 1
        m.filter.return_value.all.return_value = assets if first else []
        return m

    db.query.side_effect = query
    return db, counts, assets, unit


def _service(db, cls=ImportService):
    client = MagicMock()
    client.read_patrimony_rows.return_value = GoogleSheetsReadResult(
        rows=_rows(), headers=["ID", "PATRIMONIO"], sheet_title="x"
    )
    settings = MagicMock()
    settings.import_preview_ttl_minutes = 60
    return cls(db, client, settings=settings)


class _PerRowService(ImportService):
    """Semântica de referência: busca unitária por linha (sem pré-carga)."""

    def __init__(self, *a, truth, **k):
        super().__init__(*a, **k)
        self._truth = truth
        self.lookups = 0

    def _prefetch_active_assets(self, patrimony_numbers):
        self._asset_cache = None

    def _active_assets_by_patrimony(self, patrimony_number):
        self.lookups += 1
        if patrimony_number is None:
            return []
        key = normalize_patrimony_number(patrimony_number)
        return [a for a in self._truth if normalize_patrimony_number(a.patrimony_number) == key]


def _snapshot(db):
    items = db.add_all.call_args[0][0]
    return [
        (i.patrimony_number, i.classification, i.selected, i.matched_asset_id,
         (i.normalized_values or {}).get("_version_at_preview"), i.validation_errors)
        for i in items
    ]


def test_preview_usa_numero_constante_de_queries():
    db, counts, _assets, _unit = _db_and_assets()
    _service(db).create_preview(uuid.uuid4())
    # 1069 linhas, 3 chunks no máximo de assets; mapas de apoio 1x cada.
    assert counts.get("Asset", 0) <= 3
    assert counts.get("Unit") == 1
    assert counts.get("UnitAlias") == 1
    assert counts.get("Room") == 1
    assert counts.get("ResponsiblePerson") == 1
    assert sum(counts.values()) <= 10


def test_preview_equivale_a_busca_unitaria_por_linha():
    db1, _c1, assets, _u = _db_and_assets()
    _service(db1).create_preview(uuid.uuid4())
    db2, _c2, _a2, _u2 = _db_and_assets()
    client = MagicMock()
    client.read_patrimony_rows.return_value = GoogleSheetsReadResult(
        rows=_rows(), headers=["ID", "PATRIMONIO"], sheet_title="x"
    )
    settings = MagicMock()
    settings.import_preview_ttl_minutes = 60
    ref_service = _PerRowService(db2, client, settings=settings, truth=assets)
    ref_service.create_preview(uuid.uuid4())
    # Ids de assets diferem entre as duas fixtures; compara com a mesma lista.
    snap_a = _snapshot(db1)
    snap_b = _snapshot(db2)
    assert ref_service.lookups > N_ROWS // 2
    classes = {s[1] for s in snap_a}
    assert {"NOVO", "EXISTENTE", "DUPLICADO", "INVALIDO", "CONFLITANTE"} <= classes
    assert [(s[0], s[1], s[2], s[4], s[5]) for s in snap_a] == [
        (s[0], s[1], s[2], s[4], s[5]) for s in snap_b
    ]
