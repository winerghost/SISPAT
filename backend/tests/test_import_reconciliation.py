"""Regressão: confirmação em lotes (>200 itens), seleção no servidor e reconciliação.

Causa original (693 bens nunca gravados): a tela enviava só os ids das páginas
(50) que o usuário visitou; cada confirmação consumia a prévia. Aqui garantimos
que o backend aceita `select_all_eligible` e persiste TODOS os itens, e que
todo item não importado aparece no relatório de reconciliação.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from app.models.assets import Asset
from app.models.imports import ImportPreview, ImportPreviewItem
from app.services.import_service import CONFIRM_BATCH_SIZE, ImportService
from app.services.patrimony_lock import normalize_patrimony_number

from tests.test_import_service import (
    _build_item,
    _build_preview,
    _make_settings,
    _make_unit,
    _wire_confirm_db,
)


def _service(db) -> ImportService:
    return ImportService(db, MagicMock(), settings=_make_settings())


def test_confirmacao_de_mais_de_200_itens_grava_todos_em_lotes() -> None:
    preview = _build_preview()
    total = 250
    items = [_build_item(preview.id, "NOVO", patrimony_number=str(1000 + n)) for n in range(total)]
    db, _ = _wire_confirm_db(
        preview, items=items, asset_query_results=[[] for _ in range(total)], unit=_make_unit()
    )
    # select_all_eligible: nenhum id enviado pelo cliente.
    result = _service(db).confirm_preview(
        preview.id, uuid.uuid4(), [], select_all_eligible=True
    )
    assert result["created"] == total
    assert result["falhas_total"] == 0
    assert result["status"] == "CONCLUIDO"
    assert preview.status == "CONFIRMADA"
    created_assets = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Asset)]
    assert len(created_assets) == total
    # claim + 2 lotes completos de 100 (250 -> commits em 100 e 200) + final
    assert db.commit.call_count == 1 + total // CONFIRM_BATCH_SIZE + 1


def test_excluded_item_ids_vence_na_selecao_total() -> None:
    preview = _build_preview()
    items = [_build_item(preview.id, "NOVO", patrimony_number=str(n)) for n in range(5)]
    db, _ = _wire_confirm_db(
        preview, items=items, asset_query_results=[[] for _ in range(5)], unit=_make_unit()
    )
    result = _service(db).confirm_preview(
        preview.id, uuid.uuid4(), [items[0].id], select_all_eligible=True,
        excluded_item_ids=[items[0].id, items[1].id],
    )
    assert result["created"] == 3
    assert result["nao_gravados"]["nao_selecionados"] == 2


def test_confirmacao_nao_selecao_total_so_grava_ids_enviados() -> None:
    preview = _build_preview()
    items = [_build_item(preview.id, "NOVO", patrimony_number=str(n)) for n in range(4)]
    db, _ = _wire_confirm_db(
        preview, items=items, asset_query_results=[[], []], unit=_make_unit()
    )
    result = _service(db).confirm_preview(preview.id, uuid.uuid4(), [items[0].id, items[1].id])
    assert result["created"] == 2


def test_erro_inesperado_marca_previa_e_job_como_falhou() -> None:
    preview = _build_preview()
    item = _build_item(preview.id, "NOVO", patrimony_number="1")
    db, router = _wire_confirm_db(preview, items=[item], asset_query_results=[[]], unit=_make_unit())
    from app.models.sync import SyncJob
    router.register(SyncJob).filter.return_value.first.return_value = SyncJob(id=uuid.uuid4())
    service = _service(db)
    service._apply_items = MagicMock(side_effect=RuntimeError("boom"))  # type: ignore[method-assign]
    try:
        service.confirm_preview(preview.id, uuid.uuid4(), [item.id])
    except RuntimeError:
        pass
    else:  # pragma: no cover
        raise AssertionError("deveria propagar")
    db.rollback.assert_called()
    assert preview.status == "FALHOU"


def _wire_reconciliation(preview, items, found_numbers):
    db, router = _wire_confirm_db(preview, items=items)
    # `.order_by(...).all()` da consulta de itens
    router.by_model[ImportPreviewItem].filter.return_value.order_by.return_value.all.return_value = items
    db.execute.return_value.scalars.return_value = [
        normalize_patrimony_number(n) for n in found_numbers
    ]
    return db


def test_reconciliacao_lista_pendentes_com_motivo_e_numero() -> None:
    preview = _build_preview()
    importado = _build_item(preview.id, "EXISTENTE", patrimony_number="10")
    dup_do_importado = _build_item(preview.id, "DUPLICADO", patrimony_number="10")
    novo_pendente = _build_item(preview.id, "NOVO", patrimony_number="20")
    invalido = _build_item(preview.id, "INVALIDO", patrimony_number=None)
    conflitante = _build_item(preview.id, "CONFLITANTE", patrimony_number="30")
    dup_sem_bem = _build_item(preview.id, "DUPLICADO", patrimony_number="40")
    sem_unidade = _build_item(
        preview.id, "INVALIDO", patrimony_number="50",
        normalized_values={"_links": {"blocking": "unidade_sem_alias"}},
    )
    items = [importado, dup_do_importado, novo_pendente, invalido, conflitante, dup_sem_bem, sem_unidade]
    db = _wire_reconciliation(preview, items, found_numbers=["10"])

    r = _service(db).reconciliation_report(preview.id)

    assert r["total_itens"] == 7
    assert r["localizados"] == 2  # os dois itens do patrimônio 10
    assert r["nao_importados"] == 5
    got = {(i["patrimony_number"], i["reason_code"]) for i in r["items"]}
    assert got == {
        ("20", "novo_pendente"),
        (None, "dados_invalidos"),
        ("30", "patrimonio_conflitante"),
        ("40", "duplicado_na_origem"),
        ("50", "unidade_sem_alias"),
    }
    assert r["por_motivo"]["novo_pendente"] == 1
    # Invariante: toda linha é localizada OU aparece no relatório.
    assert r["localizados"] + r["nao_importados"] == r["total_itens"]


def test_reconciliacao_filtro_por_motivo_e_paginacao() -> None:
    preview = _build_preview()
    items = [_build_item(preview.id, "NOVO", patrimony_number=str(n)) for n in range(120)]
    items.append(_build_item(preview.id, "CONFLITANTE", patrimony_number="999"))
    db = _wire_reconciliation(preview, items, found_numbers=[])

    r = _service(db).reconciliation_report(preview.id, reason="novo_pendente", page=2, page_size=50)
    assert r["total"] == 120 and r["pages"] == 3 and len(r["items"]) == 50
    assert all(i["reason_code"] == "novo_pendente" for i in r["items"])
