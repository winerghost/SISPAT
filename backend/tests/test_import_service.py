"""Testes de `app.services.import_service.ImportService`.

`GoogleSheetsClient` e a sessão de banco (`sqlalchemy.orm.Session`) são
sempre mockados via `unittest.mock.MagicMock` — nenhuma chamada de rede ou
conexão real de banco é feita neste arquivo (não há fixture de banco em
`backend/tests/conftest.py` para este projeto; outros testes já existentes,
ex. `test_rbac.py`/`test_health.py`, seguem o mesmo padrão).

Cobre:
    - Classificação NOVO/EXISTENTE/DUPLICADO/INVALIDO/CONFLITANTE em uma
      única pré-visualização.
    - Falha de leitura do Google Sheets propagada como `UpstreamSourceError`.
    - Prévia inexistente / já confirmada (idempotência) / expirada não
      podem ser confirmadas.
    - Itens INVALIDO/DUPLICADO/CONFLITANTE nunca são importados mesmo se
      vierem em `selected_item_ids` (contabilizados em `ignorados`).
    - Condição de corrida (NOVO que já existe, EXISTENTE cuja `version`
      mudou) é tratada como falha daquele item específico, não como
      exceção não tratada — os demais itens, se houver, ainda são
      processados.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.integrations.google_sheets_client import GoogleSheetsClientError, GoogleSheetsReadResult
from app.models.assets import Asset
from app.models.imports import ImportPreview, ImportPreviewItem
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit, UnitAlias
from app.services.import_service import (
    ImportService,
    PreviewNotConfirmableError,
    PreviewNotFoundError,
    UpstreamSourceError,
    _VERSION_AT_PREVIEW_KEY,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row(
    source_row_number: int,
    patrimonio: str | None,
    item_id: str | None,
    descricao: str | None = None,
    validation_errors: list[str] | None = None,
) -> dict:
    """Monta uma linha no mesmo formato de `GoogleSheetsReadResult.rows`."""
    return {
        "source_row_number": source_row_number,
        "raw_values": {"PATRIMONIO": patrimonio, "ID": item_id, "DESCRICAO": descricao},
        "normalized_values": {
            "PATRIMONIO": patrimonio,
            "ID": item_id,
            "DESCRICAO": descricao,
            "UNIDADE": "SEDE",
        },
        "validation_errors": validation_errors or [],
    }


def _make_settings(ttl_minutes: int = 60) -> MagicMock:
    settings = MagicMock()
    settings.import_preview_ttl_minutes = ttl_minutes
    return settings


def _make_asset(patrimony_number: str, version: int = 1) -> Asset:
    return Asset(
        id=uuid.uuid4(),
        patrimony_number=patrimony_number,
        unit_id=uuid.uuid4(),
        version=version,
        deleted_at=None,
    )


def _make_unit(name: str = "SEDE") -> Unit:
    return Unit(id=uuid.uuid4(), code="U1", name=name, active=True)


class _QueryRouter:
    """Mock de `Session.query(Model)` que direciona cada modelo para um
    mock dedicado, configurável de forma independente por teste.
    """

    def __init__(self) -> None:
        self.by_model: dict[type, MagicMock] = {}

    def register(self, model: type) -> MagicMock:
        mock = MagicMock()
        self.by_model[model] = mock
        return mock

    def __call__(self, model: type) -> MagicMock:
        if model not in self.by_model:
            raise AssertionError(f"query inesperada para o modelo {model!r} neste teste")
        return self.by_model[model]


def _make_db_mock() -> tuple[MagicMock, _QueryRouter]:
    db = MagicMock()
    router = _QueryRouter()
    db.query.side_effect = router
    return db, router


def _register_refs(router: _QueryRouter, unit: Unit | None) -> None:
    """Tabelas de apoio da resolução de vínculos (sigla `SEDE` -> `unit`)."""
    router.register(Unit).all.return_value = [unit] if unit else []
    router.register(UnitAlias).all.return_value = (
        [UnitAlias(alias="SEDE", unit_id=unit.id)] if unit else []
    )
    router.register(Room).filter.return_value.all.return_value = []
    router.register(ResponsiblePerson).filter.return_value.all.return_value = []


# ---------------------------------------------------------------------------
# create_preview
# ---------------------------------------------------------------------------


def test_create_preview_classifica_todas_as_situacoes() -> None:
    """NOVO, DUPLICADO, EXISTENTE, CONFLITANTE e INVALIDO numa única leitura."""
    rows = [
        _row(2, "100", "1"),  # NOVO (primeira ocorrência de 100)
        _row(3, "100", "2"),  # DUPLICADO (repete o patrimônio 100)
        _row(4, "200", "3"),  # EXISTENTE (1 asset ativo com patrimônio 200)
        _row(5, "300", "4"),  # CONFLITANTE (2 assets ativos com patrimônio 300)
        _row(6, None, None, validation_errors=["erro: campo PATRIMONIO ausente ou vazio"]),  # INVALIDO
    ]
    read_result = GoogleSheetsReadResult(rows=rows, headers=["ID", "PATRIMONIO", "DESCRICAO"], sheet_title="Patrimonio")

    sheets_client = MagicMock()
    sheets_client.read_patrimony_rows.return_value = read_result

    existing_asset_200 = _make_asset("200", version=3)
    asset_a_300 = _make_asset("300")
    asset_b_300 = _make_asset("300")

    db, router = _make_db_mock()
    _register_refs(router, _make_unit())
    asset_query = router.register(Asset)
    # Pré-carga em lote: UMA query devolve os assets ativos de todas as linhas.
    asset_query.filter.return_value.all.return_value = [
        existing_asset_200,
        asset_a_300,
        asset_b_300,
    ]

    service = ImportService(db, sheets_client, settings=_make_settings())
    preview = service.create_preview(requested_by_user_id=uuid.uuid4())

    assert preview.status == "CONCLUIDA"
    assert preview.total_rows == 5
    assert preview.count_novo == 1
    assert preview.count_existente == 1
    assert preview.count_duplicado == 1
    assert preview.count_conflitante == 1
    assert preview.count_invalido == 1

    # `db.add_all` recebeu os 5 ImportPreviewItem criados.
    added_items: list[ImportPreviewItem] = db.add_all.call_args[0][0]
    by_patrimony_and_classification = {
        (item.patrimony_number, item.classification): item for item in added_items
    }

    novo_item = by_patrimony_and_classification[("100", "NOVO")]
    assert novo_item.selected is True
    assert novo_item.matched_asset_id is None

    duplicado_item = by_patrimony_and_classification[("100", "DUPLICADO")]
    assert duplicado_item.selected is False
    assert duplicado_item.matched_asset_id is None

    existente_item = by_patrimony_and_classification[("200", "EXISTENTE")]
    assert existente_item.selected is True
    assert existente_item.matched_asset_id == existing_asset_200.id
    assert existente_item.normalized_values[_VERSION_AT_PREVIEW_KEY] == 3

    conflitante_item = by_patrimony_and_classification[("300", "CONFLITANTE")]
    assert conflitante_item.selected is False
    assert conflitante_item.matched_asset_id is None

    invalido_item = by_patrimony_and_classification[(None, "INVALIDO")]
    assert invalido_item.selected is False

    db.flush.assert_called_once()
    db.commit.assert_not_called()  # commit é responsabilidade do chamador nesta operação


def test_create_preview_define_expires_at_conforme_settings() -> None:
    rows = [_row(2, "100", "1")]
    read_result = GoogleSheetsReadResult(rows=rows, headers=["ID", "PATRIMONIO"], sheet_title="x")
    sheets_client = MagicMock()
    sheets_client.read_patrimony_rows.return_value = read_result

    db, router = _make_db_mock()
    _register_refs(router, _make_unit())
    asset_query = router.register(Asset)
    asset_query.filter.return_value.all.return_value = []

    before = datetime.now(timezone.utc)
    service = ImportService(db, sheets_client, settings=_make_settings(ttl_minutes=30))
    preview = service.create_preview(requested_by_user_id=uuid.uuid4())
    after = datetime.now(timezone.utc)

    assert before + timedelta(minutes=29) < preview.expires_at < after + timedelta(minutes=31)


def test_create_preview_propaga_falha_do_sheets_como_erro_de_dominio() -> None:
    sheets_client = MagicMock()
    sheets_client.read_patrimony_rows.side_effect = GoogleSheetsClientError("boom")

    db, _router = _make_db_mock()
    service = ImportService(db, sheets_client, settings=_make_settings())

    with pytest.raises(UpstreamSourceError):
        service.create_preview(requested_by_user_id=uuid.uuid4())

    db.add.assert_not_called()


# ---------------------------------------------------------------------------
# confirm_preview
# ---------------------------------------------------------------------------


def _build_preview(status: str = "CONCLUIDA", expires_in_minutes: int = 60) -> ImportPreview:
    return ImportPreview(
        id=uuid.uuid4(),
        requested_by=uuid.uuid4(),
        source="google_sheets",
        status=status,
        total_rows=0,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes),
    )


def _build_item(
    preview_id: uuid.UUID,
    classification: str,
    patrimony_number: str = "100",
    normalized_values: dict | None = None,
) -> ImportPreviewItem:
    return ImportPreviewItem(
        id=uuid.uuid4(),
        preview_id=preview_id,
        source_record_id="1",
        patrimony_number=patrimony_number,
        description="Descrição teste",
        raw_values={"PATRIMONIO": patrimony_number},
        normalized_values=normalized_values if normalized_values is not None else {"UNIDADE": "SEDE"},
        classification=classification,
        selected=True,
    )


def _wire_confirm_db(
    preview: ImportPreview,
    items: list[ImportPreviewItem],
    asset_query_results: list[list[Asset]] | None = None,
    unit: Unit | None = None,
) -> tuple[MagicMock, _QueryRouter]:
    db, router = _make_db_mock()

    preview_query = router.register(ImportPreview)
    preview_query.filter.return_value.first.return_value = preview

    items_query = router.register(ImportPreviewItem)
    items_query.filter.return_value.all.return_value = items

    asset_query = router.register(Asset)
    asset_query.filter.return_value.all.side_effect = asset_query_results or []

    _register_refs(router, unit)

    return db, router


def test_confirm_preview_preview_inexistente() -> None:
    db, router = _make_db_mock()
    preview_query = router.register(ImportPreview)
    preview_query.filter.return_value.first.return_value = None

    service = ImportService(db, MagicMock(), settings=_make_settings())
    with pytest.raises(PreviewNotFoundError):
        service.confirm_preview(uuid.uuid4(), uuid.uuid4(), [])


def test_confirm_preview_ja_confirmada_falha_idempotencia() -> None:
    """Segunda confirmação da MESMA prévia (status já CONFIRMADA) deve
    falhar com um erro de domínio, sem tentar reprocessar nada."""
    preview = _build_preview(status="CONFIRMADA")
    db, router = _wire_confirm_db(preview, items=[])

    service = ImportService(db, MagicMock(), settings=_make_settings())
    with pytest.raises(PreviewNotConfirmableError):
        service.confirm_preview(preview.id, uuid.uuid4(), [])

    # Nem chega a consultar os itens: falha antes disso.
    router.by_model[ImportPreviewItem].filter.assert_not_called()


def test_confirm_preview_expirada_marca_status_e_rejeita() -> None:
    preview = _build_preview(status="CONCLUIDA", expires_in_minutes=-10)
    db, router = _wire_confirm_db(preview, items=[])

    service = ImportService(db, MagicMock(), settings=_make_settings())
    with pytest.raises(PreviewNotConfirmableError):
        service.confirm_preview(preview.id, uuid.uuid4(), [])

    assert preview.status == "EXPIRADA"
    db.commit.assert_called_once()
    # Nunca chegou a consultar os itens da prévia (rejeitada antes disso).
    router.by_model[ImportPreviewItem].filter.assert_not_called()


def test_confirm_preview_ignora_itens_nao_selecionaveis_mesmo_se_selecionados() -> None:
    preview = _build_preview()
    item_novo = _build_item(preview.id, "NOVO", patrimony_number="100")
    item_invalido = _build_item(preview.id, "INVALIDO", patrimony_number=None)
    item_duplicado = _build_item(preview.id, "DUPLICADO", patrimony_number="100")
    item_conflitante = _build_item(preview.id, "CONFLITANTE", patrimony_number="300")

    items = [item_novo, item_invalido, item_duplicado, item_conflitante]
    unit = _make_unit()
    # Apenas o item NOVO chega a consultar `assets` (os demais são ignorados
    # antes de qualquer revalidação).
    db, router = _wire_confirm_db(preview, items=items, asset_query_results=[[]], unit=unit)

    service = ImportService(db, MagicMock(), settings=_make_settings())
    result = service.confirm_preview(
        preview.id,
        uuid.uuid4(),
        [item_novo.id, item_invalido.id, item_duplicado.id, item_conflitante.id],
    )

    assert result["created"] == 1
    assert result["updated"] == 0
    assert result["ignorados"] == 3
    assert result["falhas"] == []


def test_confirm_preview_condicao_de_corrida_item_novo_vira_falha() -> None:
    """Item NOVO cujo patrimônio já existe no banco no momento da
    confirmação (surgiu após a pré-visualização) é reportado em `falhas`,
    sem levantar exceção."""
    preview = _build_preview()
    item_novo = _build_item(preview.id, "NOVO", patrimony_number="100")
    asset_que_surgiu_depois = _make_asset("100")

    db, router = _wire_confirm_db(
        preview, items=[item_novo], asset_query_results=[[asset_que_surgiu_depois]]
    )

    service = ImportService(db, MagicMock(), settings=_make_settings())
    result = service.confirm_preview(preview.id, uuid.uuid4(), [item_novo.id])

    assert result["created"] == 0
    assert len(result["falhas"]) == 1
    assert result["falhas"][0]["item_id"] == str(item_novo.id)
    assert "condição de corrida" in result["falhas"][0]["reason"]


def test_confirm_preview_condicao_de_corrida_item_existente_version_divergente() -> None:
    """Item EXISTENTE cujo `version` mudou desde a pré-visualização é
    reportado em `falhas` (falha de concorrência otimista), sem exceção."""
    preview = _build_preview()
    item_existente = _build_item(
        preview.id,
        "EXISTENTE",
        patrimony_number="200",
        normalized_values={_VERSION_AT_PREVIEW_KEY: 1},
    )
    asset_atual_com_versao_diferente = _make_asset("200", version=2)

    db, router = _wire_confirm_db(
        preview,
        items=[item_existente],
        asset_query_results=[[asset_atual_com_versao_diferente]],
    )

    service = ImportService(db, MagicMock(), settings=_make_settings())
    result = service.confirm_preview(preview.id, uuid.uuid4(), [item_existente.id])

    assert result["updated"] == 0
    assert len(result["falhas"]) == 1
    assert "concorrência" in result["falhas"][0]["reason"]


def test_confirm_preview_sucesso_cria_e_atualiza_e_persiste_tudo() -> None:
    preview = _build_preview()
    item_novo = _build_item(preview.id, "NOVO", patrimony_number="100")
    item_existente = _build_item(
        preview.id,
        "EXISTENTE",
        patrimony_number="200",
        normalized_values={_VERSION_AT_PREVIEW_KEY: 5, "UNIDADE": "SEDE"},
    )
    asset_200 = _make_asset("200", version=5)
    unit = _make_unit()

    db, router = _wire_confirm_db(
        preview,
        items=[item_novo, item_existente],
        asset_query_results=[[], [asset_200]],
        unit=unit,
    )

    confirmed_by = uuid.uuid4()
    service = ImportService(db, MagicMock(), settings=_make_settings())
    result = service.confirm_preview(
        preview.id, confirmed_by, [item_novo.id, item_existente.id]
    )

    assert result["created"] == 1
    assert result["updated"] == 1
    assert result["ignorados"] == 0
    assert result["falhas"] == []
    assert preview.status == "CONFIRMADA"
    assert preview.confirmed_by == confirmed_by
    assert asset_200.version == 6  # incrementado pelo controle otimista
    db.commit.assert_called_once()


def test_confirm_preview_novo_sem_unidade_resolvivel_vira_falha() -> None:
    """Sem uma `Unit` ativa cujo nome corresponda à coluna UNIDADE, um item
    NOVO não pode ser criado (unit_id é obrigatório) — reportado em
    `falhas`, nunca uma exceção não tratada."""
    preview = _build_preview()
    item_novo = _build_item(preview.id, "NOVO", patrimony_number="100")

    db, router = _wire_confirm_db(preview, items=[item_novo], asset_query_results=[[]], unit=None)

    service = ImportService(db, MagicMock(), settings=_make_settings())
    result = service.confirm_preview(preview.id, uuid.uuid4(), [item_novo.id])

    assert result["created"] == 0
    assert len(result["falhas"]) == 1
    assert "unidade" in result["falhas"][0]["reason"]
