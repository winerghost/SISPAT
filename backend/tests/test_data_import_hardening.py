"""Testes de regressão — `ImportService` (injeção, concorrência, transações).

Auditoria AppSec 2026-10-13 (backend-data). Sessão de banco sempre mockada
(`MagicMock`), mesmo padrão de `tests/test_import_service.py`. Dados
sintéticos.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError

from app.integrations.google_sheets_client import GoogleSheetsReadResult
from app.models.assets import Asset
from app.models.imports import ImportPreview, ImportPreviewItem
from app.models.sync import RawImportRecord
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit, UnitAlias
from app.services.import_service import (
    MAX_SEARCH_LENGTH,
    ImportService,
    PreviewNotConfirmableError,
    _VERSION_AT_PREVIEW_KEY,
)


class _Router:
    def __init__(self) -> None:
        self.by_model: dict[type, MagicMock] = {}

    def register(self, model: type) -> MagicMock:
        self.by_model[model] = MagicMock()
        return self.by_model[model]

    def __call__(self, model: type) -> MagicMock:
        if model not in self.by_model:
            raise AssertionError(f"query inesperada para {model!r}")
        return self.by_model[model]


def _db() -> tuple[MagicMock, _Router]:
    db = MagicMock()
    router = _Router()
    db.query.side_effect = router
    return db, router


def _settings() -> MagicMock:
    settings = MagicMock()
    settings.import_preview_ttl_minutes = 60
    return settings


def _preview(status: str = "CONCLUIDA") -> ImportPreview:
    return ImportPreview(
        id=uuid.uuid4(),
        requested_by=uuid.uuid4(),
        source="google_sheets",
        status=status,
        total_rows=0,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
    )


def _item(preview_id, classification, patrimony, normalized=None) -> ImportPreviewItem:
    return ImportPreviewItem(
        id=uuid.uuid4(),
        preview_id=preview_id,
        source_record_id="SRC-1",
        patrimony_number=patrimony,
        description="Item sintético",
        raw_values={"PATRIMONIO": patrimony},
        normalized_values=normalized if normalized is not None else {"UNIDADE": "SEDE"},
        classification=classification,
        selected=True,
    )


def _register_refs(router, unit=None):
    router.register(Unit).all.return_value = [unit] if unit else []
    router.register(UnitAlias).all.return_value = (
        [UnitAlias(alias="SEDE", unit_id=unit.id)] if unit else []
    )
    router.register(Room).filter.return_value.all.return_value = []
    router.register(ResponsiblePerson).filter.return_value.all.return_value = []


def _wire_confirm(preview, items, asset_results, unit=None):
    db, router = _db()
    router.register(ImportPreview).filter.return_value.first.return_value = preview
    router.register(ImportPreviewItem).filter.return_value.all.return_value = items
    router.register(Asset).filter.return_value.all.side_effect = asset_results
    _register_refs(router, unit)
    return db, router


# ---------------------------------------------------------------------------
# list_preview_items — CWE-89 (ILIKE), allowlist de status, limites
# ---------------------------------------------------------------------------


def _wire_list(preview):
    db, router = _db()
    router.register(ImportPreview).filter.return_value.first.return_value = preview
    items_q = router.register(ImportPreviewItem)
    return db, items_q


def test_search_escapa_curingas_e_usa_bind_parameter() -> None:
    preview = _preview()
    db, items_q = _wire_list(preview)
    service = ImportService(db, MagicMock(), settings=_settings())

    service.list_preview_items(preview.id, search="100%_' OR 1=1 --")

    # 1º filter: preview_id; 2º filter (encadeado): o OR de ILIKEs
    search_clause = items_q.filter.return_value.filter.call_args.args[0]
    compiled = search_clause.compile(dialect=postgresql.dialect())
    sql = str(compiled)
    assert "ESCAPE" in sql and "ILIKE" in sql.upper()
    assert "OR 1=1" not in sql
    params = list(compiled.params.values())
    assert params == ["%100\\%\\_' OR 1=1 --%"] * 2


def test_search_e_truncado_no_tamanho_maximo() -> None:
    preview = _preview()
    db, items_q = _wire_list(preview)
    service = ImportService(db, MagicMock(), settings=_settings())

    service.list_preview_items(preview.id, search="a" * 5000)

    clause = items_q.filter.return_value.filter.call_args.args[0]
    params = list(clause.compile(dialect=postgresql.dialect()).params.values())
    assert params[0] == "%" + "a" * MAX_SEARCH_LENGTH + "%"


def test_status_fora_da_allowlist_retorna_vazio_sem_consultar_itens() -> None:
    preview = _preview()
    db, items_q = _wire_list(preview)
    service = ImportService(db, MagicMock(), settings=_settings())

    result = service.list_preview_items(preview.id, status="NOVO' OR '1'='1")

    assert result["total"] == 0 and result["items"] == []
    items_q.filter.assert_not_called()


def test_status_valido_e_normalizado_para_maiusculas() -> None:
    preview = _preview()
    db, items_q = _wire_list(preview)
    service = ImportService(db, MagicMock(), settings=_settings())

    service.list_preview_items(preview.id, status=" novo ")

    clause = items_q.filter.return_value.filter.call_args.args[0]
    assert list(clause.compile(dialect=postgresql.dialect()).params.values()) == ["NOVO"]


def test_paginacao_tem_ordenacao_total_e_limites() -> None:
    preview = _preview()
    db, items_q = _wire_list(preview)
    service = ImportService(db, MagicMock(), settings=_settings())

    result = service.list_preview_items(preview.id, page=10**9, page_size=10**6)

    assert result["page_size"] == 50
    assert result["page"] == 10_000
    order_args = items_q.filter.return_value.order_by.call_args.args
    assert len(order_args) == 2  # created_at + id (desempate determinístico)


# ---------------------------------------------------------------------------
# create_preview — defesa em profundidade
# ---------------------------------------------------------------------------


def _rows_result(rows):
    return GoogleSheetsReadResult(rows=rows, headers=["ID", "PATRIMONIO"], sheet_title="x")


def test_linha_sem_patrimonio_utilizavel_nunca_e_selecionavel() -> None:
    """Ex.: cabeçalho PATRIMONIO duplicado -> chaves PATRIMONIO_1/_2, sem erro
    vindo do cliente (cenário antigo). Antes virava NOVO selecionável e a
    confirmação quebrava com NOT NULL; agora é INVALIDO."""
    row = {
        "source_row_number": 2,
        "raw_values": {"ID": "1", "PATRIMONIO_1": "100", "PATRIMONIO_2": "200"},
        "normalized_values": {"ID": "1", "PATRIMONIO_1": "100", "PATRIMONIO_2": "200"},
        "validation_errors": [],
    }
    sheets = MagicMock()
    sheets.read_patrimony_rows.return_value = _rows_result([row])
    db, router = _db()
    router.register(Asset).filter.return_value.all.return_value = []

    preview = ImportService(db, sheets, settings=_settings()).create_preview(uuid.uuid4())

    item = db.add_all.call_args.args[0][0]
    assert item.classification == "INVALIDO"
    assert item.selected is False
    assert preview.count_novo == 0


def test_id_de_origem_repetido_gera_aviso_e_linha_de_origem_preservada() -> None:
    rows = [
        {
            "source_row_number": n,
            "raw_values": {"ID": "7", "PATRIMONIO": p},
            "normalized_values": {"ID": "7", "PATRIMONIO": p, "UNIDADE": "SEDE"},
            "validation_errors": [],
        }
        for n, p in ((2, "100"), (3, "200"))
    ]
    sheets = MagicMock()
    sheets.read_patrimony_rows.return_value = _rows_result(rows)
    db, router = _db()
    router.register(Asset).filter.return_value.all.return_value = []
    _register_refs(router, Unit(id=uuid.uuid4(), code="U", name="SEDE", active=True))

    ImportService(db, sheets, settings=_settings()).create_preview(uuid.uuid4())

    items = db.add_all.call_args.args[0]
    assert items[0].validation_errors is None
    assert any("ID de origem repetido" in e for e in items[1].validation_errors)
    assert items[1].normalized_values["_source_row_number"] == 3


def test_patrimonio_float_no_service_nunca_vira_texto_com_ponto() -> None:
    row = {
        "source_row_number": 2,
        "raw_values": {"ID": "1", "PATRIMONIO": 123.0},
        "normalized_values": {"ID": "1", "PATRIMONIO": 123.0},
        "validation_errors": [],
    }
    sheets = MagicMock()
    sheets.read_patrimony_rows.return_value = _rows_result([row])
    db, router = _db()
    router.register(Asset).filter.return_value.all.return_value = []

    ImportService(db, sheets, settings=_settings()).create_preview(uuid.uuid4())

    item = db.add_all.call_args.args[0][0]
    assert item.patrimony_number is None
    assert item.classification == "INVALIDO"


# ---------------------------------------------------------------------------
# confirm_preview — concorrência, savepoints, controle otimista
# ---------------------------------------------------------------------------


def test_confirm_trava_a_previa_com_for_update_antes_de_checar_status() -> None:
    preview = _preview()
    db, _ = _wire_confirm(preview, [], [])

    ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), []
    )

    db.refresh.assert_any_call(preview, with_for_update=True)


def test_dupla_confirmacao_concorrente_e_rejeitada_apos_o_lock() -> None:
    """Simula a 2ª requisição: ao obter o lock, o refresh recarrega o status
    já gravado pela 1ª (CONFIRMADA) -> 409, sem tocar em assets."""
    preview = _preview()
    db, router = _wire_confirm(preview, [], [])

    def _refresh(obj, with_for_update=False):
        if obj is preview and with_for_update:
            preview.status = "CONFIRMADA"

    db.refresh.side_effect = _refresh

    with pytest.raises(PreviewNotConfirmableError):
        ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
            preview.id, uuid.uuid4(), []
        )
    router.by_model[ImportPreviewItem].filter.assert_not_called()
    db.commit.assert_not_called()


def test_confirm_adquire_advisory_lock_por_patrimonio_em_ordem() -> None:
    preview = _preview()
    unit = Unit(id=uuid.uuid4(), code="U", name="SEDE", active=True)
    item_b = _item(preview.id, "NOVO", "200")
    item_a = _item(preview.id, "NOVO", "100")
    db, _ = _wire_confirm(preview, [item_b, item_a], [[], []], unit=unit)
    db.get_bind.return_value.dialect.name = "postgresql"

    ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), [item_a.id, item_b.id]
    )

    calls = db.execute.call_args_list
    assert len(calls) == 2
    assert all("pg_advisory_xact_lock" in str(c.args[0]) for c in calls)
    # chave normalizada (mesma da API) vai como bind parameter, em ordem crescente (sem deadlock)
    keys = [c.args[1]["key"] for c in calls]
    assert keys == ["sispat:asset-number:100", "sispat:asset-number:200"]


def test_falha_de_banco_em_um_item_desfaz_so_o_savepoint_e_segue() -> None:
    preview = _preview()
    unit = Unit(id=uuid.uuid4(), code="U", name="SEDE", active=True)
    item_ok = _item(preview.id, "NOVO", "100")
    item_bad = _item(preview.id, "NOVO", "200")
    db, _ = _wire_confirm(preview, [item_ok, item_bad], [[], []], unit=unit)

    savepoints: list[MagicMock] = []

    def _begin_nested():
        sp = MagicMock()
        savepoints.append(sp)
        return sp

    db.begin_nested.side_effect = _begin_nested
    flush_calls = {"n": 0}

    def _flush():
        flush_calls["n"] += 1
        # 3ª chamada de flush = flush do 2º item (cada item faz 2 flushes)
        if flush_calls["n"] == 3:
            raise IntegrityError("INSERT ...", {}, Exception("duplicate key"))

    db.flush.side_effect = _flush

    result = ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), [item_ok.id, item_bad.id]
    )

    assert result["created"] == 1
    assert len(result["falhas"]) == 1
    assert result["falhas"][0]["item_id"] == str(item_bad.id)
    assert "duplicate key" not in result["falhas"][0]["reason"]  # sem detalhe interno
    savepoints[0].commit.assert_called_once()
    savepoints[1].rollback.assert_called_once()
    assert preview.status == "CONFIRMADA"
    db.commit.assert_called_once()


def test_existente_sem_versao_de_referencia_falha_fechado() -> None:
    preview = _preview()
    item = _item(preview.id, "EXISTENTE", "300", normalized={})
    asset = Asset(id=uuid.uuid4(), patrimony_number="300", unit_id=uuid.uuid4(), version=4)
    db, _ = _wire_confirm(preview, [item], [[asset]])

    result = ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), [item.id]
    )

    assert result["updated"] == 0
    assert "concorrência" in result["falhas"][0]["reason"]
    assert asset.version == 4


def test_existente_recarrega_asset_com_lock_antes_de_comparar_version() -> None:
    preview = _preview()
    item = _item(preview.id, "EXISTENTE", "300", normalized={_VERSION_AT_PREVIEW_KEY: 4})
    asset = Asset(id=uuid.uuid4(), patrimony_number="300", unit_id=uuid.uuid4(), version=4)
    db, _ = _wire_confirm(preview, [item], [[asset]])

    def _refresh(obj, with_for_update=False):
        if obj is asset and with_for_update:
            asset.version = 5  # outro processo alterou o bem nesse meio tempo

    db.refresh.side_effect = _refresh

    result = ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), [item.id]
    )

    assert result["updated"] == 0
    assert len(result["falhas"]) == 1
    assert asset.version == 5


def test_raw_import_record_preserva_linha_de_origem() -> None:
    preview = _preview()
    unit = Unit(id=uuid.uuid4(), code="U", name="SEDE", active=True)
    item = _item(preview.id, "NOVO", "100", normalized={"UNIDADE": "SEDE", "_source_row_number": 42})
    db, _ = _wire_confirm(preview, [item], [[]], unit=unit)

    ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), [item.id]
    )

    raws = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], RawImportRecord)]
    assert len(raws) == 1
    assert raws[0].source_row_number == 42
    assert raws[0].raw_values == {"PATRIMONIO": "100"}


def test_stale_data_error_do_version_id_col_vira_falha_de_concorrencia() -> None:
    from sqlalchemy.orm.exc import StaleDataError

    preview = _preview()
    item = _item(preview.id, "EXISTENTE", "300", normalized={_VERSION_AT_PREVIEW_KEY: 4})
    asset = Asset(id=uuid.uuid4(), patrimony_number="300", unit_id=uuid.uuid4(), version=4)
    db, _ = _wire_confirm(preview, [item], [[asset]])
    savepoint = MagicMock()
    db.begin_nested.return_value = savepoint
    db.flush.side_effect = StaleDataError("UPDATE statement on table 'assets' expected 1 row")

    result = ImportService(db, MagicMock(), settings=_settings()).confirm_preview(
        preview.id, uuid.uuid4(), [item.id]
    )

    assert result["updated"] == 0
    assert "concorrência" in result["falhas"][0]["reason"]
    savepoint.rollback.assert_called_once()
    assert preview.status == "CONFIRMADA"
    db.commit.assert_called_once()
