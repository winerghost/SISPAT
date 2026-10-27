"""Importação de bens: resolução de vínculos (alias de unidade, sala, pessoa).

Etapa 3 do plano MConferencia. SQLite com o schema real; as linhas passam
pelo `GoogleSheetsClient._build_row` real (normalizador incluso), sem rede.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select

from _catalog_db import build_engine, new_session
from app.integrations.google_sheets_client import (
    GoogleSheetsClient,
    GoogleSheetsReadResult,
    _disambiguate_headers,
)
from app.models.assets import Asset
from app.models.imports import ImportPreviewItem
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit, UnitAlias
from app.services.import_service import ImportService

ACTOR = uuid.uuid4()
HEADERS = [
    "ID", "PATRIMONIO", "DESCRICAO", "UNIDADE", "UNIDADE_PERTENCENTE", "RESPONSAVEL",
    "RESPONSAVEL", "LOCALIZADO", "SALA", "USUARIO", "OBSERVACAO", "DATA_REGISTRO",
    "DATA_ALTERACAO", "QT", "PESQUISADOR", "LOCALIZACAO",
]


def _line(**kw) -> list:
    base = {
        "ID": "10", "PATRIMONIO": "00123", "DESCRICAO": "(00138020-6) NOTEBOOK |",
        "UNIDADE": "UEA", "UNIDADE_PERTENCENTE": "023404 - UNIDADE ESTADUAL DE ADMINISTRAÇÃO",
        "RESP1": "Servidor", "RESP2": "PHILLIPE FARIAS FERREIRA", "LOCALIZADO": "S",
        "SALA": "3", "USUARIO": "phillipe.ferreira@agu.gov.br", "OBSERVACAO": "Em uso",
        "DATA_REGISTRO": "05/03/2024", "DATA_ALTERACAO": "15/10/2026 22:18:21",
        "QT": "25", "PESQUISADOR": "Developer", "LOCALIZACAO": "0.000000, 0.000000",
    }
    base.update(kw)
    return [
        base["ID"], base["PATRIMONIO"], base["DESCRICAO"], base["UNIDADE"],
        base["UNIDADE_PERTENCENTE"], base["RESP1"], base["RESP2"], base["LOCALIZADO"],
        base["SALA"], base["USUARIO"], base["OBSERVACAO"], base["DATA_REGISTRO"],
        base["DATA_ALTERACAO"], base["QT"], base["PESQUISADOR"], base["LOCALIZACAO"],
    ]


def _sheet(lines: list[list]) -> GoogleSheetsReadResult:
    client = GoogleSheetsClient(settings=SimpleNamespace())
    keys = _disambiguate_headers(HEADERS)
    rows = [client._build_row(HEADERS, keys, line, n) for n, line in enumerate(lines, start=2)]
    return GoogleSheetsReadResult(rows=rows, headers=HEADERS, sheet_title="MConferencia")


@pytest.fixture()
def world(monkeypatch):
    monkeypatch.setattr(ImportService, "_lock_patrimony", lambda self, number: None)
    db = new_session(build_engine())
    units = {}
    for sigla, code in (("PF", "023401"), ("UEA", "023404")):
        unit = Unit(id=uuid.uuid4(), code=code, name=f"Unidade {code}", active=True)
        db.add(unit)
        units[sigla] = unit
    inactive = Unit(id=uuid.uuid4(), code="023999", name="Inativa", active=False)
    db.add(inactive)
    db.flush()
    for sigla, unit in units.items():
        db.add(UnitAlias(id=uuid.uuid4(), alias=sigla, unit_id=unit.id))
    db.add(UnitAlias(id=uuid.uuid4(), alias="INA", unit_id=inactive.id))
    room = Room(id=uuid.uuid4(), unit_id=units["UEA"].id, name="3", active=True)
    person = ResponsiblePerson(
        id=uuid.uuid4(), name="Phillipe Farias Ferreira", email="phillipe.ferreira@agu.gov.br",
        unit_id=units["UEA"].id, active=True,
    )
    db.add_all([room, person])
    db.commit()
    yield SimpleNamespace(db=db, units=units, room=room, person=person)
    db.close()


def _service(world, lines) -> ImportService:
    client = MagicMock()
    client.read_patrimony_rows.return_value = _sheet(lines)
    return ImportService(world.db, client, settings=SimpleNamespace(import_preview_ttl_minutes=60))


def _items(db, preview_id):
    rows = db.execute(select(ImportPreviewItem).where(ImportPreviewItem.preview_id == preview_id)).scalars().all()
    return sorted(rows, key=lambda i: i.normalized_values["_source_row_number"])


def _confirm(service, db, preview):
    return service.confirm_preview(preview.id, ACTOR, [i.id for i in _items(db, preview.id)])


def test_item_novo_resolve_todos_os_vinculos(world) -> None:
    service = _service(world, [_line()])
    preview = service.create_preview(ACTOR)
    assert preview.count_novo == 1 and sum(preview.pending_counts.values()) == 0
    out = _confirm(service, world.db, preview)
    assert out["created"] == 1 and out["falhas"] == []

    asset = world.db.execute(select(Asset)).scalars().one()
    assert asset.patrimony_number == "00123"  # texto, zeros preservados
    assert asset.unit_id == world.units["UEA"].id
    assert asset.owner_unit_id == world.units["UEA"].id
    assert asset.room_id == world.room.id
    assert asset.responsible_person_id == world.person.id
    assert asset.assigned_user_id is None
    assert asset.located == "SIM"
    assert asset.notes == "Em uso"
    assert asset.registration_date == date(2024, 3, 5)
    stamp = asset.source_updated_at.replace(tzinfo=timezone.utc)
    assert stamp == datetime(2026, 10, 16, 1, 18, 21, tzinfo=timezone.utc)  # Araguaina -> UTC
    item = _items(world.db, preview.id)[0]
    assert item.normalized_values["usuario_person_id"] == str(world.person.id)
    assert item.normalized_values["vinculo_situacao"] == "Servidor"


def test_sigla_case_insensitive_e_sem_alias_vira_invalido(world) -> None:
    lines = [
        _line(ID="1", PATRIMONIO="1", UNIDADE=" uea "),
        _line(ID="2", PATRIMONIO="2", UNIDADE="XYZ"),
        _line(ID="3", PATRIMONIO="3", UNIDADE=None),
        _line(ID="4", PATRIMONIO="4", UNIDADE="INA"),
    ]
    service = _service(world, lines)
    preview = service.create_preview(ACTOR)
    items = _items(world.db, preview.id)
    assert [i.classification for i in items] == ["NOVO", "INVALIDO", "INVALIDO", "INVALIDO"]
    assert any("sem alias" in e for e in items[1].validation_errors)
    assert any("vazio" in e and e.startswith("erro") for e in items[2].validation_errors)
    assert any("inativa" in e for e in items[3].validation_errors)
    assert preview.pending_counts["unidade_sem_alias"] == 1
    assert preview.pending_counts["unidade_ausente"] == 1
    assert not items[1].selected
    out = _confirm(service, world.db, preview)
    assert out["created"] == 1 and out["ignorados"] == 3


def test_pendencias_nao_bloqueiam_itens_validos(world) -> None:
    lines = [
        _line(ID="1", PATRIMONIO="1", SALA="99", RESP2="FULANO INEXISTENTE", USUARIO="x@agu.gov.br",
              UNIDADE_PERTENCENTE="999999 - OUTRA"),
    ]
    service = _service(world, lines)
    preview = service.create_preview(ACTOR)
    counts = preview.pending_counts
    assert preview.count_novo == 1
    assert counts["sala_nao_encontrada"] == 1
    assert counts["pessoa_nao_encontrada"] == 1
    assert counts["usuario_pessoa_nao_encontrada"] == 1
    assert counts["unidade_pertencente_nao_encontrada"] == 1
    assert service.pending_report(preview.id) == counts
    out = _confirm(service, world.db, preview)
    assert out["created"] == 1
    asset = world.db.execute(select(Asset)).scalars().one()
    assert asset.room_id is None and asset.responsible_person_id is None
    assert asset.owner_unit_id is None and asset.assigned_user_id is None


def test_pessoa_por_chave_ignora_caixa_acento_e_espacos_e_ambiguidade_e_pendencia(world) -> None:
    world.db.add_all([
        ResponsiblePerson(id=uuid.uuid4(), name="JOÃO  DA SILVA", unit_id=world.units["UEA"].id, active=True),
        ResponsiblePerson(id=uuid.uuid4(), name="Joao da Silva", unit_id=world.units["PF"].id, active=True),
        ResponsiblePerson(id=uuid.uuid4(), name="MARIA INATIVA", unit_id=world.units["PF"].id, active=False),
    ])
    world.db.commit()
    lines = [
        _line(ID="1", PATRIMONIO="1", RESP2="phillipe  FARIAS ferreira", USUARIO=None),
        _line(ID="2", PATRIMONIO="2", RESP2="João da Silva", USUARIO=None),
        _line(ID="3", PATRIMONIO="3", RESP2="Maria Inativa", USUARIO=None),
    ]
    service = _service(world, lines)
    preview = service.create_preview(ACTOR)
    links = [i.normalized_values["_links"] for i in _items(world.db, preview.id)]
    assert links[0]["responsible_person_id"] == str(world.person.id)
    assert links[1]["responsible_person_id"] is None and "pessoa_ambigua" in links[1]["pendencias"]
    assert links[2]["responsible_person_id"] is None and "pessoa_nao_encontrada" in links[2]["pendencias"]
    assert preview.pending_counts["pessoa_ambigua"] == 1


def test_ocioso_na_primeira_responsavel_e_so_situacao(world) -> None:
    world.db.add(
        ResponsiblePerson(id=uuid.uuid4(), name="Ocioso", unit_id=world.units["UEA"].id, active=True)
    )
    world.db.commit()
    lines = [_line(ID="1", PATRIMONIO="1", RESP1="Ocioso", RESP2=None, USUARIO="Ocioso@ocioso")]
    service = _service(world, lines)
    preview = service.create_preview(ACTOR)
    nv = _items(world.db, preview.id)[0].normalized_values
    assert nv["vinculo_situacao"] == "Ocioso"
    assert nv["_links"]["responsible_person_id"] is None
    assert nv["_links"]["pendencias"] == []  # nem pendência: não é pessoa
    _confirm(service, world.db, preview)
    assert world.db.execute(select(Asset)).scalars().one().responsible_person_id is None


def test_sala_resolvida_somente_dentro_da_unidade_do_bem(world) -> None:
    world.db.add(Room(id=uuid.uuid4(), unit_id=world.units["PF"].id, name="Arquivo", active=True))
    world.db.commit()
    lines = [_line(ID="1", PATRIMONIO="1", UNIDADE="UEA", SALA="Arquivo")]
    preview = _service(world, lines).create_preview(ACTOR)
    assert preview.pending_counts["sala_nao_encontrada"] == 1  # existe, mas em outra unidade


def test_confirmacao_reresolve_e_falha_se_alias_removido_apos_a_previa(world) -> None:
    service = _service(world, [_line()])
    preview = service.create_preview(ACTOR)
    world.db.execute(UnitAlias.__table__.delete().where(UnitAlias.alias == "UEA"))
    world.db.commit()
    out = _confirm(service, world.db, preview)
    assert out["created"] == 0 and len(out["falhas"]) == 1
    assert "unidade" in out["falhas"][0]["reason"]


def test_idempotencia_e_item_existente_nao_sobrescreve_campos_manuais(world) -> None:
    service = _service(world, [_line()])
    preview = service.create_preview(ACTOR)
    _confirm(service, world.db, preview)
    with pytest.raises(Exception):
        _confirm(service, world.db, preview)  # prévia já CONFIRMADA

    asset = world.db.execute(select(Asset)).scalars().one()
    asset.notes = "editado manualmente"
    world.db.commit()
    service2 = _service(world, [_line(DESCRICAO="(00138020-6) NOTEBOOK NOVO |", OBSERVACAO="outra")])
    preview2 = service2.create_preview(ACTOR)
    assert preview2.count_existente == 1
    _confirm(service2, world.db, preview2)
    world.db.refresh(asset)
    assert asset.notes == "editado manualmente"
    assert asset.version == 2


def test_item_existente_atualiza_sala_localizado_e_responsavel_da_planilha(world) -> None:
    """Regressão: sync de bem EXISTENTE aplicava só descrição/vínculo."""
    service = _service(world, [_line(SALA="", LOCALIZADO="N", RESP2="", USUARIO="")])
    _confirm(service, world.db, service.create_preview(ACTOR))
    asset = world.db.execute(select(Asset)).scalars().one()
    assert asset.room_id is None and asset.located == "NAO" and asset.responsible_person_id is None

    service2 = _service(world, [_line()])  # planilha atualizada: sala 3, localizado, responsável
    preview2 = service2.create_preview(ACTOR)
    assert preview2.count_existente == 1
    out = _confirm(service2, world.db, preview2)
    assert out["updated"] == 1
    world.db.refresh(asset)
    assert asset.room_id == world.room.id
    assert asset.located == "SIM"
    assert asset.responsible_person_id == world.person.id

    service3 = _service(world, [_line()])  # reimportar igual é no-op
    preview3 = service3.create_preview(ACTOR)
    version = asset.version
    _confirm(service3, world.db, preview3)
    world.db.refresh(asset)
    assert asset.version == version
