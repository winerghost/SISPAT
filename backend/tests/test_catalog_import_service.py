"""Testes de `CatalogImportService` (unidades, salas, pessoas) em SQLite.

Usa os exemplos REAIS enviados pelo usuário (2026-10-16) como linhas da aba;
nenhuma rede, nenhum Supabase. Os ids de unidade/aliases do banco são
sintéticos (a migração 0007 faz o seed real das siglas).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy import func, select

from app.integrations.google_sheets_client import GoogleSheetsClientError, GoogleSheetsReadResult
from app.models.audit import AuditLog
from app.models.imports import ImportPreview
from app.models.people import ResponsiblePerson
from app.models.sync import RawImportRecord, SyncJob
from app.models.units import Room, Unit, UnitAlias, UserUnitAccess
from app.services.catalog_import_service import (
    CatalogImportService,
    CatalogSchemaError,
    CatalogSourceNotConfiguredError,
)
from app.services.import_service import (
    ImportService,
    PreviewNotConfirmableError,
    PreviewNotFoundError,
    UpstreamSourceError,
)
from _catalog_db import build_engine, new_session

ACTOR = uuid.uuid4()

UNIDADES = [
    ("bf1e0169", "PF", "023401 - PROCURADORIA FEDERAL NO ESTADO DO TOCANTINS"),
    ("bf1e0170", "PU", "023402 - PROCURADORIA DA UNIAO NO TOCANTINS"),
    ("bf1e0171", "CJU", "023403 - CONSULTORIA JURIDICA DA UNIAO NO ESTADO DO TOCANTINS"),
    ("bf1e0172", "UEA", "023404 - UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"),
]

SALAS = [
    ("897bb3a9", "2"),
    ("897bb3a10", "3"),
    ("3cfe560c", "9"),
    ("c7fe6a6e", "11"),
    ("6d8e7c12", "13"),
    ("c3872cae", "30 A"),
    ("38599d91", "Auditório"),
    ("5cdd6692", "07 - Amamentação"),
    ("b628c38b", "07 - ANM"),
    ("dad16e14", "06"),
    ("f96128de", "6"),
    ("452be58b", "Sala do servidor ANTT"),
]

PESSOAS = [
    ("1", "Ocioso", "Ocioso@ocioso", None),
    ("2", "CLEITON GOMES BANDEIRA", "cleiton.bandera@agu.gov.br", "5563984069566"),
    ("5", "KEILY CRISTINY AZEVEDO LEITE", "keily.leite@agu.gov.br", None),
    ("33", "JÕAO GUILHERME VILLANOVA VIDAL", "joao.vidal@agu.gov.br", "5563991027317"),
    ("35", "EVA BARROS DOS SANTOS MACEDO", "eva.barros@agu.gov.br", None),
    ("35", "CARLOS SILVA DOS SANTOS", "carlosdos.santos@agu.gov.br", "5563992488867"),
    ("38", "ERICA LISSANDRA BERTOLOSSI DANTAS -", "erica.dantas@agu.gov.br", None),
    ("42", "NEWTON OLIVEIRA CAMPOS", "newton.campos@AGU.GOV.BR", None),
    ("60", "MANOEL NASCIMENTO DOS SANTOS", "manoel.nsantos@agu.gov.br", None),
    ("61", "MANOEL NASCIMENTO DOS SANTOS ", "manoel.nsantos@agu.gov.br", None),
    ("62", "PHILLIPE FARIAS FERREIRA", "phillipe.ferreira@agu.gov.br", None),
    ("c00d846c", "TALLES MARTINS MOURA", "talles.moura@agu.gov.br", None),
]


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        import_preview_ttl_minutes=60,
        google_sheets_units_sheet_name="Unidades",
        google_sheets_units_sheet_gid=None,
        google_sheets_rooms_sheet_name="Salas",
        google_sheets_rooms_sheet_gid=None,
        google_sheets_people_sheet_name=None,
        google_sheets_people_sheet_gid="123",
    )


def _sheet(headers: list[str], rows: list[list]) -> GoogleSheetsReadResult:
    out = []
    for n, row in enumerate(rows, start=2):
        raw = {h: (row[i] if i < len(row) and row[i] not in ("",) else None) for i, h in enumerate(headers)}
        out.append(
            {"source_row_number": n, "raw_values": raw, "normalized_values": dict(raw), "validation_errors": []}
        )
    return GoogleSheetsReadResult(rows=out, headers=headers, sheet_title="t")


def _client(result: GoogleSheetsReadResult) -> MagicMock:
    client = MagicMock()
    client.read_tab_rows.return_value = result
    return client


@pytest.fixture()
def db():
    engine = build_engine()
    session = new_session(engine)
    yield session
    session.close()


def _seed_units(db, aliases: bool = True) -> dict[str, uuid.UUID]:
    ids = {}
    for _sid, sigla, orgao in UNIDADES:
        code = orgao.split(" - ")[0]
        unit = Unit(id=uuid.uuid4(), code=code, name=orgao.split(" - ", 1)[1], active=True)
        db.add(unit)
        ids[sigla] = unit.id
    db.flush()
    if aliases:
        for sigla, unit_id in ids.items():
            db.add(UnitAlias(id=uuid.uuid4(), alias=sigla, unit_id=unit_id))
    for unit_id in ids.values():  # escopo do ADM da importação (SEC-CAT-02)
        db.add(UserUnitAccess(id=uuid.uuid4(), user_id=ACTOR, unit_id=unit_id))
    db.commit()
    return ids


def _service(db, result) -> CatalogImportService:
    return CatalogImportService(db, _client(result), settings=_settings())


def _rooms_result(rows=None):
    rows = rows if rows is not None else [[sid, name, "UEA"] for sid, name in SALAS]
    return _sheet(["ID", "SALA", "UNIDADE"], rows)


def _people_result(rows=None):
    rows = rows if rows is not None else [[sid, n, e, t, "UEA"] for sid, n, e, t in PESSOAS]
    return _sheet(["ID", "NOME", "EMAIL", "TELEFONE", "UNIDADE"], rows)


def _units_result(rows=None):
    rows = rows if rows is not None else [[sid, sigla, orgao] for sid, sigla, orgao in UNIDADES]
    return _sheet(["ID", "UNIDADE", "Orgao"], rows)


# ---------------------------------------------------------------------------
# Configuração / esquema / leitura
# ---------------------------------------------------------------------------


def test_aba_nao_configurada_recusa_sem_ler(db) -> None:
    service = CatalogImportService(db, MagicMock(), settings=SimpleNamespace(import_preview_ttl_minutes=60))
    with pytest.raises(CatalogSourceNotConfiguredError):
        service.create_preview("rooms", ACTOR)


def test_usa_nome_ou_gid_configurado(db) -> None:
    _seed_units(db)
    client = _client(_people_result([]))
    CatalogImportService(db, client, settings=_settings()).create_preview("people", ACTOR)
    client.read_tab_rows.assert_called_once_with(sheet_name=None, sheet_gid="123")


def test_coluna_obrigatoria_ausente_ou_duplicada(db) -> None:
    _seed_units(db)
    with pytest.raises(CatalogSchemaError):
        _service(db, _sheet(["ID", "SALA"], [])).create_preview("rooms", ACTOR)
    with pytest.raises(CatalogSchemaError):
        _service(db, _sheet(["ID", "SALA", "UNIDADE", "UNIDADE"], [])).create_preview("rooms", ACTOR)


def test_falha_do_sheets_vira_erro_de_dominio(db) -> None:
    client = MagicMock()
    client.read_tab_rows.side_effect = GoogleSheetsClientError("boom")
    with pytest.raises(UpstreamSourceError):
        CatalogImportService(db, client, settings=_settings()).create_preview("units", ACTOR)


# ---------------------------------------------------------------------------
# Salas
# ---------------------------------------------------------------------------


def test_salas_reais_previa_e_confirmacao(db) -> None:
    ids = _seed_units(db)
    service = _service(db, _rooms_result())
    result = service.create_preview("rooms", ACTOR)

    assert result.preview.source == "catalog:rooms"
    assert result.preview.count_novo == 12  # 06 e 6 são salas distintas
    report = result.report
    assert report["pendencias"]["unidade_sem_alias"] == 0
    assert len(report["provaveis_duplicatas"]) == 1
    assert sorted(report["provaveis_duplicatas"][0]["names"]) == ["06", "6"]
    assert report["ids_repetidos"] == []

    outcome = service.confirm_preview(
        result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)]
    )
    assert outcome["created"] == 12 and outcome["falhas"] == []
    rooms = db.execute(select(Room)).scalars().all()
    assert {r.name for r in rooms} >= {"06", "6", "07 - ANM", "07 - Amamentação", "Auditório"}
    assert all(r.unit_id == ids["UEA"] for r in rooms)
    assert {r.source_record_id for r in rooms} == {sid for sid, _ in SALAS}
    assert db.execute(select(func.count()).select_from(RawImportRecord)).scalar_one() == 12
    audit = db.execute(select(AuditLog)).scalars().one()
    assert audit.operation == "CONFIRM_CATALOG_IMPORT" and audit.new_values["created"] == 12
    assert db.execute(select(SyncJob)).scalars().one().status == "CONCLUIDO"


def _items(db, preview_id):
    from app.models.imports import ImportPreviewItem

    return db.execute(
        select(ImportPreviewItem).where(ImportPreviewItem.preview_id == preview_id)
    ).scalars().all()


def test_confirmacao_idempotente_e_segunda_previa_vira_existente(db) -> None:
    _seed_units(db)
    service = _service(db, _rooms_result())
    first = service.create_preview("rooms", ACTOR)
    ids = [i.id for i in _items(db, first.preview.id)]
    service.confirm_preview(first.preview.id, ACTOR, ids)
    with pytest.raises(PreviewNotConfirmableError):
        service.confirm_preview(first.preview.id, ACTOR, ids)
    assert db.execute(select(Room)).scalars().all().__len__() == 12

    second = service.create_preview("rooms", ACTOR)
    assert second.preview.count_existente == 12 and second.preview.count_novo == 0
    out = service.confirm_preview(second.preview.id, ACTOR, [i.id for i in _items(db, second.preview.id)])
    assert out["created"] == 0 and out["updated"] == 0  # nada a alterar
    assert len(db.execute(select(Room)).scalars().all()) == 12


def test_sala_sem_unidade_ou_sigla_desconhecida_e_pendente_sem_chute(db) -> None:
    _seed_units(db)
    rows = [["1", "Sala A", ""], ["2", "Sala B", "XYZ"], ["3", "Sala C", "uea"], ["4", "", "UEA"]]
    result = _service(db, _rooms_result(rows)).create_preview("rooms", ACTOR)
    by_row = {i.normalized_values["_row"]: i for i in _items(db, result.preview.id)}
    assert by_row[2].classification == "INVALIDO" and by_row[2].normalized_values["_pend"] == ["unidade_ausente"]
    assert by_row[3].classification == "INVALIDO" and by_row[3].normalized_values["_pend"] == ["unidade_sem_alias"]
    assert by_row[4].classification == "NOVO"  # alias case-insensitive
    assert by_row[5].classification == "INVALIDO"
    assert result.report["pendencias"]["unidade_sem_alias"] == 1
    out = _service(db, _rooms_result(rows)).confirm_preview(
        result.preview.id, ACTOR, [i.id for i in by_row.values()]
    )
    assert out["created"] == 1 and out["ignorados"] == 3  # inválidas nunca entram


def test_sala_repetida_na_unidade_e_duplicada_e_existente_no_banco(db) -> None:
    ids = _seed_units(db)
    db.add(Room(id=uuid.uuid4(), unit_id=ids["UEA"], name="Auditório", active=True))
    db.commit()
    rows = [["1", "Auditório", "UEA"], ["2", "auditório", "UEA"], ["3", "Sala 1", "UEA"], ["4", "Sala 1", "UEA"]]
    result = _service(db, _rooms_result(rows)).create_preview("rooms", ACTOR)
    cls = {i.normalized_values["_row"]: i.classification for i in _items(db, result.preview.id)}
    assert cls == {2: "EXISTENTE", 3: "DUPLICADO", 4: "NOVO", 5: "DUPLICADO"}


# ---------------------------------------------------------------------------
# Pessoas
# ---------------------------------------------------------------------------


def test_pessoas_reais_previa(db) -> None:
    _seed_units(db)
    result = _service(db, _people_result()).create_preview("people", ACTOR)
    by_row = {i.normalized_values["_row"]: i for i in _items(db, result.preview.id)}

    ocioso = by_row[2]
    assert ocioso.classification == "INVALIDO" and ocioso.normalized_values["_pend"] == ["marcador_ocioso"]
    assert by_row[8].normalized_values["person_name"] == "ERICA LISSANDRA BERTOLOSSI DANTAS"
    assert by_row[9].normalized_values["email"] == "newton.campos@agu.gov.br"
    assert by_row[10].classification == "NOVO"  # 60 mantida
    assert by_row[11].classification == "DUPLICADO"  # 61: mesmo e-mail
    assert by_row[5].normalized_values["suspect"]  # JÕAO sinalizado, nome inalterado
    assert by_row[5].normalized_values["person_name"] == "JÕAO GUILHERME VILLANOVA VIDAL"
    assert by_row[4].normalized_values["phone"] is None  # sem telefone
    assert by_row[2].normalized_values["phone"] is None

    report = result.report
    assert result.preview.count_novo == 10 and result.preview.count_duplicado == 1
    assert result.preview.count_invalido == 1
    assert report["pendencias"]["marcador_ocioso"] == 1
    assert [s["row"] for s in report["nomes_suspeitos"]] == [5]
    assert report["ids_repetidos"] == [{"id": "35", "linhas": [6, 7]}]


def test_pessoas_confirmacao_id_repetido_mantem_ambas_e_so_a_primeira_grava_id(db) -> None:
    _seed_units(db)
    service = _service(db, _people_result())
    result = service.create_preview("people", ACTOR)
    out = service.confirm_preview(result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)])
    assert out["created"] == 10 and out["falhas"] == []

    people = {p.name: p for p in db.execute(select(ResponsiblePerson)).scalars().all()}
    assert set(people) >= {"EVA BARROS DOS SANTOS MACEDO", "CARLOS SILVA DOS SANTOS"}
    assert people["EVA BARROS DOS SANTOS MACEDO"].source_record_id == "35"
    assert people["CARLOS SILVA DOS SANTOS"].source_record_id is None
    assert people["CARLOS SILVA DOS SANTOS"].phone == "5563992488867"
    assert people["CLEITON GOMES BANDEIRA"].phone == "5563984069566"
    assert "Ocioso" not in people
    assert sum(1 for p in people.values() if p.email == "manoel.nsantos@agu.gov.br") == 1
    raw_ids = [r.source_record_id for r in db.execute(select(RawImportRecord)).scalars().all()]
    assert raw_ids.count("35") == 2  # ID original preservado nas duas linhas brutas


def test_pessoa_email_invalido_e_unidade_desconhecida_sao_pendentes(db) -> None:
    _seed_units(db)
    rows = [
        ["1", "FULANO DE TAL", "fulano@semdominio", None, "UEA"],
        ["2", "BELTRANO", "beltrano@agu.gov.br", None, "ZZZ"],
        ["3", "SEM EMAIL SILVA", None, "63999990000", "UEA"],
    ]
    result = _service(db, _people_result(rows)).create_preview("people", ACTOR)
    by_row = {i.normalized_values["_row"]: i for i in _items(db, result.preview.id)}
    assert by_row[2].normalized_values["_pend"] == ["email_invalido"]
    assert by_row[3].normalized_values["_pend"] == ["unidade_sem_alias"]
    assert by_row[4].classification == "NOVO"
    assert result.report["pendencias"]["email_invalido"] == 1


def test_pessoa_existente_so_preenche_campos_vazios(db) -> None:
    ids = _seed_units(db)
    db.add(
        ResponsiblePerson(
            id=uuid.uuid4(), name="CLEITON G. BANDEIRA", email="cleiton.bandera@agu.gov.br",
            unit_id=ids["UEA"], active=True,
        )
    )
    db.commit()
    rows = [["2", "CLEITON GOMES BANDEIRA", "Cleiton.Bandera@agu.gov.br", "5563984069566", "UEA"]]
    service = _service(db, _people_result(rows))
    result = service.create_preview("people", ACTOR)
    item = _items(db, result.preview.id)[0]
    assert item.classification == "EXISTENTE"
    assert any("nome difere" in e for e in item.validation_errors)
    out = service.confirm_preview(result.preview.id, ACTOR, [item.id])
    assert out["updated"] == 1 and out["created"] == 0
    person = db.execute(select(ResponsiblePerson)).scalars().one()
    assert person.name == "CLEITON G. BANDEIRA"  # nome preservado
    assert person.phone == "5563984069566" and person.source_record_id == "2"


# ---------------------------------------------------------------------------
# Unidades
# ---------------------------------------------------------------------------


def test_unidades_existentes_ganham_source_id_sem_mudar_nome(db) -> None:
    ids = _seed_units(db)
    service = _service(db, _units_result())
    result = service.create_preview("units", ACTOR)
    assert result.preview.count_existente == 4
    out = service.confirm_preview(result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)])
    assert out["updated"] == 4 and out["created"] == 0
    units = {u.code: u for u in db.execute(select(Unit)).scalars().all()}
    assert units["023404"].source_record_id == "bf1e0172"
    assert units["023404"].name == "UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"
    assert len(db.execute(select(UnitAlias)).scalars().all()) == 4
    assert units["023401"].id == ids["PF"]


def test_unidades_novas_criam_unidade_e_alias(db) -> None:
    service = _service(db, _units_result())
    result = service.create_preview("units", ACTOR)
    assert result.preview.count_novo == 4
    ids = [i.id for i in _items(db, result.preview.id)]
    assert all(i.normalized_values["create_alias"] for i in _items(db, result.preview.id))
    out = service.confirm_preview(result.preview.id, ACTOR, ids, alias_item_ids=ids)
    assert out["created"] == 4 and out["falhas"] == []
    assert {a.alias for a in db.execute(select(UnitAlias)).scalars().all()} == {"PF", "PU", "CJU", "UEA"}


def test_alias_novo_nao_e_criado_sem_opt_in_explicito(db) -> None:
    service = _service(db, _units_result())
    result = service.create_preview("units", ACTOR)
    ids = [i.id for i in _items(db, result.preview.id)]
    out = service.confirm_preview(result.preview.id, ACTOR, ids)
    assert out["created"] == 4
    assert db.execute(select(UnitAlias)).scalars().all() == []


def test_sigla_ligada_a_outra_unidade_e_conflitante(db) -> None:
    ids = _seed_units(db)
    db.execute(UnitAlias.__table__.update().where(UnitAlias.alias == "UEA").values(unit_id=ids["PF"]))
    db.commit()
    rows = [["bf1e0172", "UEA", "023404 - UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"]]
    result = _service(db, _units_result(rows)).create_preview("units", ACTOR)
    assert result.preview.count_conflitante == 1
    assert result.report["pendencias"]["sigla_ligada_a_outra_unidade"] == 1


def test_orgao_invalido_e_codigo_repetido(db) -> None:
    rows = [["1", "PF", "PROCURADORIA SEM CODIGO"], ["2", "PU", "023402 - A"], ["3", "PU2", "023402 - B"]]
    result = _service(db, _units_result(rows)).create_preview("units", ACTOR)
    cls = [i.classification for i in sorted(_items(db, result.preview.id), key=lambda i: i.normalized_values["_row"])]
    assert cls == ["INVALIDO", "NOVO", "DUPLICADO"]


# ---------------------------------------------------------------------------
# Isolamento entre importações e erros
# ---------------------------------------------------------------------------


def test_previas_de_bens_e_cadastros_nao_se_confundem(db) -> None:
    _seed_units(db)
    result = _service(db, _rooms_result()).create_preview("rooms", ACTOR)
    # ImportService (bens) recusa uma prévia de cadastro
    bens = ImportService(db, MagicMock(), settings=SimpleNamespace(import_preview_ttl_minutes=60))
    with pytest.raises(PreviewNotConfirmableError):
        bens.confirm_preview(result.preview.id, ACTOR, [])
    # e o serviço de cadastros ignora prévias de bens
    asset_preview = ImportPreview(
        id=uuid.uuid4(), requested_by=ACTOR, source="google_sheets", status="CONCLUIDA",
        total_rows=0, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    db.add(asset_preview)
    db.commit()
    with pytest.raises(PreviewNotFoundError):
        _service(db, _rooms_result()).confirm_preview(asset_preview.id, ACTOR, [])


def test_previa_expirada_nao_confirma(db) -> None:
    _seed_units(db)
    service = _service(db, _rooms_result())
    result = service.create_preview("rooms", ACTOR)
    result.preview.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    with pytest.raises(PreviewNotConfirmableError):
        service.confirm_preview(result.preview.id, ACTOR, [])
    assert db.get(ImportPreview, result.preview.id).status == "EXPIRADA"


def test_falha_de_um_item_nao_aborta_os_demais(db) -> None:
    ids = _seed_units(db)
    service = _service(db, _rooms_result([["1", "Sala A", "UEA"], ["2", "Sala B", "UEA"]]))
    result = service.create_preview("rooms", ACTOR)
    # condição de corrida: a Sala A surge no banco após a prévia
    db.add(Room(id=uuid.uuid4(), unit_id=ids["UEA"], name="Sala A", active=True))
    db.commit()
    out = service.confirm_preview(result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)])
    assert out["created"] == 1 and len(out["falhas"]) == 1
    assert "condição de corrida" in out["falhas"][0]["reason"]
    assert db.execute(select(SyncJob)).scalars().one().status == "PARCIAL"
    assert db.get(ImportPreview, result.preview.id).status == "CONFIRMADA"


def test_get_report_le_da_previa_persistida(db) -> None:
    _seed_units(db)
    service = _service(db, _rooms_result())
    result = service.create_preview("rooms", ACTOR)
    assert service.get_report(result.preview.id, ACTOR) == result.report
