"""Revisão AppSec (2026-10-16) — cadastros de apoio e sua importação (Sheets).

Escopo revisado: `catalog_imports`, `catalog_import_service`, `catalog_normalizer`,
`import_normalizer`, `catalog_service`, rotas `rooms`/`responsible-people`/`units`.
Evidências e severidades: `docs/security/evidence/catalog-import-appsec-2026-10-16.md`.

Todos os testes são normais (regressão). SEC-CAT-01..05 foram CORRIGIDOS em
2026-10-16 e as marcas xfail removidas. SQLite em memória; nenhuma rede,
nenhum banco real.
"""
from __future__ import annotations

import logging
import time
import uuid
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from _catalog_db import build_engine, new_session  # noqa: F401
from test_catalog_import_service import (  # noqa: F401  (fixture `db` e helpers)
    ACTOR,
    PESSOAS,
    _items,
    _people_result,
    _rooms_result,
    _seed_units,
    _service,
    _sheet,
    _units_result,
    db,
)
from test_catalog_imports_api import (  # noqa: F401  (fixtures `env`, `fake_redis`)
    ALL_PERMS,
    _adm,
    _confirm,
    _create,
    _get,
    env,
    fake_redis,
)
from test_imports_api import _auth_headers, _make_token

from app.models.audit import AuditLog
from app.models.people import ResponsiblePerson
from app.models.units import Room, Unit, UnitAlias
from app.services.catalog_import_service import CatalogImportService
from app.services.catalog_normalizer import clean_text, normalize_room_name
from app.services.import_normalizer import parse_description, parse_owner_unit


# ---------------------------------------------------------------------------
# Controles que funcionam (regressão)
# ---------------------------------------------------------------------------


def test_sigla_ja_ligada_a_outra_unidade_nao_e_sequestrada(db) -> None:
    """Linha de Unidades tentando religar `UEA` (já de 023404) a 023401 -> CONFLITANTE."""
    ids = _seed_units(db)
    rows = [["9", "UEA", "023401 - PROCURADORIA FEDERAL NO ESTADO DO TOCANTINS"]]
    service = _service(db, _units_result(rows))
    result = service.create_preview("units", ACTOR)
    item = _items(db, result.preview.id)[0]
    assert item.classification == "CONFLITANTE"
    out = service.confirm_preview(result.preview.id, ACTOR, [item.id])
    assert out["ignorados"] == 1 and out["created"] == 0 and out["updated"] == 0
    alias = db.execute(select(UnitAlias).where(func.lower(UnitAlias.alias) == "uea")).scalar_one()
    assert alias.unit_id == ids["UEA"]


def test_sigla_com_caixa_diferente_nao_cria_alias_duplicado(db) -> None:
    ids = _seed_units(db)
    rows = [["9", "uea", "023404 - UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"]]
    service = _service(db, _units_result(rows))
    result = service.create_preview("units", ACTOR)
    service.confirm_preview(result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)])
    aliases = db.execute(select(UnitAlias).where(UnitAlias.unit_id == ids["UEA"])).scalars().all()
    assert [a.alias for a in aliases] == ["UEA"]


def test_confirmacao_ignora_item_de_outra_previa(db) -> None:
    """`item_ids` de OUTRA prévia nunca são aplicados (sem IDOR entre prévias)."""
    _seed_units(db)
    first = _service(db, _rooms_result([["1", "Sala A", "UEA"]])).create_preview("rooms", ACTOR)
    other = _service(db, _rooms_result([["2", "Sala B", "UEA"]])).create_preview("rooms", ACTOR)
    foreign = [i.id for i in _items(db, other.preview.id)]
    out = _service(db, _rooms_result([])).confirm_preview(first.preview.id, ACTOR, foreign)
    assert out["created"] == 0 and out["ignorados"] == 1
    assert db.execute(select(func.count()).select_from(Room)).scalar_one() == 0


def test_item_invalido_nunca_e_aplicado_mesmo_se_selecionado(db) -> None:
    _seed_units(db)
    service = _service(db, _rooms_result([["1", "Sala X", "SIGLA-FALSA"]]))
    result = service.create_preview("rooms", ACTOR)
    out = service.confirm_preview(result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)])
    assert out["created"] == 0 and out["ignorados"] == 1


def test_valores_de_pessoas_nao_vazam_para_logs_nem_audit(db, caplog) -> None:
    """Fluxo completo + falha de banco forçada: nenhum e-mail/telefone/nome em logs ou audit_logs."""
    _seed_units(db)
    service = _service(db, _people_result())
    with caplog.at_level(logging.DEBUG):
        result = service.create_preview("people", ACTOR)
        ids = [i.id for i in _items(db, result.preview.id)]
        real_apply = CatalogImportService._apply_person
        calls = {"n": 0}

        def flaky(self, item, nv):
            calls["n"] += 1
            if calls["n"] == 1:
                raise IntegrityError("INSERT ... cleiton.bandera@agu.gov.br 5563984069566", {}, Exception("x"))
            return real_apply(self, item, nv)

        with patch.object(CatalogImportService, "_apply_person", flaky):
            service.confirm_preview(result.preview.id, ACTOR, ids)
    logs = caplog.text
    audits = " ".join(
        str((a.previous_values, a.new_values)) for a in db.execute(select(AuditLog)).scalars().all()
    )
    for sensitive in ("cleiton.bandera", "5563984069566", "5563991027317", "keily.leite", "CLEITON"):
        assert sensitive not in logs
        assert sensitive not in audits


def test_rotas_de_cadastro_nao_aceitam_delete_put_nem_metodos_extras(env) -> None:
    rid = str(uuid.uuid4())
    for method, url in (
        ("delete", f"/api/v1/rooms/{rid}"),
        ("put", f"/api/v1/rooms/{rid}"),
        ("delete", f"/api/v1/responsible-people/{rid}"),
        ("put", f"/api/v1/responsible-people/{rid}"),
        ("delete", f"/api/v1/units/{rid}"),
        ("delete", f"/api/v1/catalog-imports/{rid}/confirm"),
        ("put", f"/api/v1/catalog-imports/rooms/preview"),
    ):
        with _adm(ALL_PERMS | {"rooms.manage"}):
            response = getattr(env.client, method)(url, headers=_auth_headers(_make_token()))
        assert response.status_code in (404, 405), (method, url, response.status_code)


def test_confirm_com_campo_extra_e_400_auditado(env) -> None:
    preview_id = _create(env, "rooms")
    response = _confirm(env, preview_id, {"item_ids": [], "kind": "people", "unit_id": str(uuid.uuid4())})
    assert response.status_code == 400
    assert any(e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT" for e in env.events)


def test_items_com_parametro_desconhecido_e_400_json(env) -> None:
    preview_id = _create(env, "rooms")
    response = _get(env, f"{preview_id}/items?sort=description&page_size=500&x=1")
    assert response.status_code == 400
    assert response.is_json


def test_nome_com_prefixo_de_formula_e_armazenado_literal_sem_executar(db) -> None:
    """Fórmula/CSV: a entrada não é confiável, mas é só texto; a defesa é na SAÍDA
    (`app.security.csv_safety`, nenhuma exportação de cadastros existe hoje)."""
    _seed_units(db)
    result = _service(db, _rooms_result([["1", "=HYPERLINK(\"http://x\")", "UEA"]])).create_preview("rooms", ACTOR)
    item = _items(db, result.preview.id)[0]
    assert item.normalized_values["room_name"].startswith("=")


@pytest.mark.parametrize(
    "payload",
    ["a" + " " * 4990 + "b", "( " * 2400, "(00138020-6) " + "-" * 4900, "x" * 5000, "a@" + "a." * 2400],
)
def test_normalizadores_de_catalogo_sao_lineares_em_entradas_hostis(payload) -> None:
    """ReDoS: regexes de `catalog_normalizer`/e-mail em células de 5.000 chars."""
    from app.services.catalog_normalizer import (
        normalize_person_name,
        parse_person_email,
        suspicious_name_reasons,
    )

    start = time.perf_counter()
    normalize_person_name(payload)
    parse_person_email(payload)
    suspicious_name_reasons(payload)
    normalize_room_name(payload)
    assert time.perf_counter() - start < 0.5


# ---------------------------------------------------------------------------
# ACHADOS CORRIGIDOS (SEC-CAT-01..05) - regressão
# ---------------------------------------------------------------------------


def test_listagem_de_itens_de_bens_nao_serve_previa_de_cadastro(env) -> None:
    env.holder.result = _sheet(
        ["ID", "NOME", "EMAIL", "TELEFONE", "UNIDADE"],
        [["1", "MARIA SIGILOSA DA SILVA", "maria@agu.gov.br", "5563990000000", "UEA"]],
    )
    preview_id = _create(env, "people")
    with (
        patch("app.api.v1.imports.get_db_session") as get_session,
        patch("app.api.v1.imports.GoogleSheetsClient", MagicMock()),
        _adm({"imports.execute"}),
    ):
        get_session.return_value.__enter__.return_value = env.db
        get_session.return_value.__exit__.return_value = False
        response = env.client.get(
            f"/api/v1/imports/google-sheets/preview/{preview_id}/items",
            headers=_auth_headers(_make_token()),
        )
    assert response.status_code == 404, response.get_data(as_text=True)[:200]
    assert "MARIA SIGILOSA" not in response.get_data(as_text=True)


def test_adm_fora_do_escopo_nao_importa_para_unidade_alheia(env) -> None:
    from app.models.units import Unit

    pf = env.db.execute(select(Unit).where(Unit.code == "023401")).scalar_one()
    uea = env.db.execute(select(Unit).where(Unit.code == "023404")).scalar_one()
    env.holder.result = _rooms_result([["1", "Sala da PF", "PF"], ["2", "Sala da UEA", "UEA"]])
    with patch("app.authorization.rbac.get_accessible_unit_ids", return_value={uea.id}):
        preview_id = _create(env, "rooms")
        listing = _get(env, f"{preview_id}/items?page_size=100").get_json()
        _confirm(env, preview_id, {"item_ids": [i["id"] for i in listing["items"]]})
    created_in_pf = env.db.execute(select(func.count()).select_from(Room).where(Room.unit_id == pf.id)).scalar_one()
    assert created_in_pf == 0


def test_confirmar_duas_previas_nao_duplica_pessoa_sem_email(db) -> None:
    _seed_units(db)
    rows = [["7", "MARIA TESTE SILVA", None, None, "UEA"]]
    first = _service(db, _people_result(rows)).create_preview("people", ACTOR)
    second = _service(db, _people_result(rows)).create_preview("people", ACTOR)  # ambas NOVO
    for preview in (first, second):
        _service(db, _people_result(rows)).confirm_preview(
            preview.preview.id, ACTOR, [i.id for i in _items(db, preview.preview.id)]
        )
    count = db.execute(select(func.count()).select_from(ResponsiblePerson)).scalar_one()
    assert count == 1


def test_importacao_aplica_as_mesmas_regras_de_texto_da_api() -> None:
    assert normalize_room_name("Sala\x07 1") is None or "\x07" not in (normalize_room_name("Sala\x07 1") or "")
    assert "‮" not in (normalize_room_name("Sala‮1") or "")
    assert "​" not in (clean_text("U​EA") or "")


def test_sigla_com_caractere_invisivel_nao_vira_alias(db) -> None:
    _seed_units(db)
    rows = [["99", "U​XX", "023499 - UNIDADE NOVA"]]
    service = _service(db, _units_result(rows))
    result = service.create_preview("units", ACTOR)
    item = _items(db, result.preview.id)[0]
    assert item.classification == "INVALIDO"


def test_nome_de_unidade_importado_respeita_limite_de_200(db) -> None:
    _seed_units(db)
    rows = [["99", "ZZZ", "023499 - " + "N" * 3000]]
    result = _service(db, _units_result(rows)).create_preview("units", ACTOR)
    assert _items(db, result.preview.id)[0].classification == "INVALIDO"


def test_parse_owner_unit_nao_e_quadratico() -> None:
    payload = "023404 - x" + " " * 4988 + "y"
    best = min(_timed(lambda: parse_owner_unit(payload, [])) for _ in range(3))
    assert best < 0.15


def _timed(fn) -> float:
    start = time.perf_counter()
    fn()
    return time.perf_counter() - start


# ---------------------------------------------------------------------------
# Regressões adicionais da correção (SEC-CAT-01..05)
# ---------------------------------------------------------------------------


def test_listagem_de_itens_de_bens_inexistente_e_cadastro_tem_o_mesmo_404(env) -> None:
    env.holder.result = _sheet(["ID", "NOME", "EMAIL", "TELEFONE", "UNIDADE"], [["1", "ANA", None, None, "UEA"]])
    catalog_id = _create(env, "people")

    def call(preview_id: str):
        with (
            patch("app.api.v1.imports.get_db_session") as get_session,
            patch("app.api.v1.imports.GoogleSheetsClient", MagicMock()),
            _adm({"imports.execute"}),
        ):
            get_session.return_value.__enter__.return_value = env.db
            get_session.return_value.__exit__.return_value = False
            return env.client.get(
                f"/api/v1/imports/google-sheets/preview/{preview_id}/items",
                headers=_auth_headers(_make_token()),
            )

    a, b = call(catalog_id), call(str(uuid.uuid4()))
    assert a.status_code == b.status_code == 404
    assert a.get_data() == b.get_data()


def test_outro_adm_nao_le_nem_confirma_previa_alheia(env) -> None:
    preview_id = _create(env, "rooms")
    other = uuid.uuid4()
    missing_id = uuid.uuid4()
    for method, suffix, kw in (
        ("get", "items", {}),
        ("get", "report", {}),
        ("post", "confirm", {"json": {"item_ids": []}}),
    ):
        with _adm(user_id=other):
            alien = getattr(env.client, method)(
                f"/api/v1/catalog-imports/{preview_id}/{suffix}", headers=_auth_headers(_make_token()), **kw
            )
            absent = getattr(env.client, method)(
                f"/api/v1/catalog-imports/{missing_id}/{suffix}", headers=_auth_headers(_make_token()), **kw
            )
        assert alien.status_code == absent.status_code == 404
        assert alien.get_data() == absent.get_data()


def test_servico_recusa_confirmar_ou_ler_previa_de_outro_autor(db) -> None:
    from app.services.import_service import PreviewNotFoundError

    _seed_units(db)
    service = _service(db, _rooms_result([["1", "Sala A", "UEA"]]))
    result = service.create_preview("rooms", ACTOR)
    stranger = uuid.uuid4()
    with pytest.raises(PreviewNotFoundError):
        service.get_report(result.preview.id, stranger)
    with pytest.raises(PreviewNotFoundError):
        service.confirm_preview(result.preview.id, stranger, [i.id for i in _items(db, result.preview.id)])
    assert db.execute(select(func.count()).select_from(Room)).scalar_one() == 0


def test_sigla_fora_do_escopo_tem_a_mesma_mensagem_de_sigla_sem_alias(db) -> None:
    ids = _seed_units(db)
    rows = [["1", "Sala A", "UEA"], ["2", "Sala B", "SIGLA-NOVA"]]
    service = _service(db, _rooms_result(rows))
    with patch("app.authorization.rbac.get_accessible_unit_ids", return_value={ids["PF"]}):
        result = service.create_preview("rooms", ACTOR)
    by_row = {i.normalized_values["_row"]: i for i in _items(db, result.preview.id)}
    assert by_row[2].classification == by_row[3].classification == "INVALIDO"
    assert by_row[2].validation_errors == by_row[3].validation_errors
    assert by_row[2].normalized_values["_pend"] == by_row[3].normalized_values["_pend"]


def test_escopo_e_revalidado_na_confirmacao(db) -> None:
    ids = _seed_units(db)
    service = _service(db, _rooms_result([["1", "Sala A", "UEA"]]))
    result = service.create_preview("rooms", ACTOR)  # UEA no escopo
    with patch("app.authorization.rbac.get_accessible_unit_ids", return_value={ids["PF"]}):
        out = service.confirm_preview(result.preview.id, ACTOR, [i.id for i in _items(db, result.preview.id)])
    assert out["created"] == 0 and len(out["falhas"]) == 1
    assert db.execute(select(func.count()).select_from(Room)).scalar_one() == 0


def test_pessoas_de_unidade_fora_do_escopo_nao_sao_vistas_como_existentes(db) -> None:
    ids = _seed_units(db)
    db.add(ResponsiblePerson(id=uuid.uuid4(), name="ANA SILVA", email=None, unit_id=ids["UEA"], active=True))
    db.commit()
    service = _service(db, _people_result([["1", "ANA SILVA", None, None, "PF"]]))
    with patch("app.authorization.rbac.get_accessible_unit_ids", return_value={ids["PF"]}):
        result = service.create_preview("people", ACTOR)
    assert _items(db, result.preview.id)[0].classification == "NOVO"


def test_unidade_existente_fora_do_escopo_nao_e_atualizada_pela_importacao(db) -> None:
    ids = _seed_units(db)
    rows = [["x", "UEA", "023404 - UNIDADE ESTADUAL DE ADMINISTRAÇÃO NO TOCANTINS"]]
    with patch("app.authorization.rbac.get_accessible_unit_ids", return_value={ids["PF"]}):
        result = _service(db, _units_result(rows)).create_preview("units", ACTOR)
    assert _items(db, result.preview.id)[0].classification == "INVALIDO"


def test_alias_so_e_criado_para_itens_com_opt_in(db) -> None:
    _seed_units(db)
    rows = [["1", "NOVA1", "023411 - UNIDADE UM"], ["2", "NOVA2", "023412 - UNIDADE DOIS"]]
    service = _service(db, _units_result(rows))
    result = service.create_preview("units", ACTOR)
    items = sorted(_items(db, result.preview.id), key=lambda i: i.normalized_values["_row"])
    assert all(i.normalized_values["create_alias"] for i in items)
    service.confirm_preview(result.preview.id, ACTOR, [i.id for i in items], alias_item_ids=[items[0].id])
    aliases = {a.alias for a in db.execute(select(UnitAlias)).scalars().all()}
    assert "NOVA1" in aliases and "NOVA2" not in aliases


def test_alias_item_ids_de_outra_previa_e_ignorado(db) -> None:
    _seed_units(db)
    service = _service(db, _units_result([["1", "NOVA1", "023411 - UNIDADE UM"]]))
    first = service.create_preview("units", ACTOR)
    other = _service(db, _units_result([["2", "NOVA2", "023412 - UNIDADE DOIS"]])).create_preview("units", ACTOR)
    foreign = [i.id for i in _items(db, other.preview.id)]
    service.confirm_preview(
        first.preview.id, ACTOR, [i.id for i in _items(db, first.preview.id)], alias_item_ids=foreign
    )
    assert {a.alias for a in db.execute(select(UnitAlias)).scalars().all()}.isdisjoint({"NOVA1", "NOVA2"})


def test_api_expoe_create_alias_e_aceita_alias_item_ids(env) -> None:
    rows = [["1", "NOVA1", "023411 - UNIDADE UM"]]
    preview_id = _create(env, "units", _units_result(rows))
    listing = _get(env, f"{preview_id}/items").get_json()
    item = listing["items"][0]
    assert item["details"]["create_alias"] is True
    r = _confirm(env, preview_id, {"item_ids": [item["id"]], "alias_item_ids": [item["id"]]})
    assert r.status_code == 200 and r.get_json()["created"] == 1
    assert env.db.execute(select(UnitAlias).where(UnitAlias.alias == "NOVA1")).scalar_one()


def test_alias_item_ids_invalido_e_400(env) -> None:
    preview_id = _create(env, "units", _units_result([["1", "NOVA1", "023411 - UNIDADE UM"]]))
    assert _confirm(env, preview_id, {"item_ids": [], "alias_item_ids": ["x"]}).status_code == 400


@pytest.mark.parametrize("sigla", ["A B", "UE​A", "UEA‮", "ÜEA", "A" * 33, "UEA;DROP", "<b>"])
def test_sigla_fora_do_padrao_e_invalida_em_unidades_salas_e_pessoas(db, sigla) -> None:
    _seed_units(db)
    for kind, result in (
        ("units", _units_result([["9", sigla, "023499 - UNIDADE NOVA"]])),
        ("rooms", _rooms_result([["9", "Sala", sigla]])),
        ("people", _people_result([["9", "ANA SILVA", None, None, sigla]])),
    ):
        preview = _service(db, result).create_preview(kind, ACTOR)
        assert _items(db, preview.preview.id)[0].classification == "INVALIDO", (kind, sigla)


@pytest.mark.parametrize("bad", ["Ana\x07 Silva", "Ana‮Silva", "Ana​Silva", "Ana\x01Silva"])
def test_nomes_com_controle_bidi_ou_largura_zero_sao_invalidos(db, bad) -> None:
    _seed_units(db)
    room = _service(db, _rooms_result([["1", bad, "UEA"]])).create_preview("rooms", ACTOR)
    person = _service(db, _people_result([["1", bad, None, None, "UEA"]])).create_preview("people", ACTOR)
    assert _items(db, room.preview.id)[0].classification == "INVALIDO"
    assert _items(db, person.preview.id)[0].classification == "INVALIDO"
    unit = _service(db, _units_result([["1", "ZZZ", f"023499 - {bad}"]])).create_preview("units", ACTOR)
    assert _items(db, unit.preview.id)[0].classification == "INVALIDO"


def test_parse_owner_unit_e_description_continuam_corretos() -> None:
    assert parse_owner_unit("023404 - UNIDADE X", []) == ("023404", "UNIDADE X")
    assert parse_owner_unit("  023404   -   UNIDADE   X  ", []) == ("023404", "UNIDADE X")
    assert parse_owner_unit("023404-X", []) == ("023404", "X")
    assert parse_owner_unit("sem codigo", []) == (None, None)
    assert parse_owner_unit("023404 -", []) == (None, None)
    assert parse_description("(00138020-6) CADEIRA |").descricao_limpa == "CADEIRA"
    assert parse_description("(00138020-6) CADEIRA |").codigo_material == "00138020-6"
    assert parse_description("CADEIRA|").descricao_limpa == "CADEIRA"


@pytest.mark.parametrize(
    "payload",
    [
        "023404 - x" + " " * 12000 + "y",
        "023404" + " " * 12000,
        "023404 -" + " " * 12000,
        " " * 12000 + "023404 - x",
        "023404 - " + "- " * 6000,
        "(00138020-6) " + " " * 12000 + "|" + " " * 12000 + "x",
        "(00138020-6)" + " " * 12000,
        "x" + " " * 12000 + "|" + " " * 12000,
        "|" * 12000,
        "a" + " |" * 6000,
    ],
    ids=[f"patologica-{n}" for n in range(10)],
)
def test_import_normalizer_e_estavel_com_entradas_patologicas(payload) -> None:
    from app.services.import_normalizer import parse_coordinates, parse_email

    warnings: list[str] = []
    start = time.perf_counter()
    parse_owner_unit(payload, warnings)
    parse_description(payload)
    parse_email(payload, warnings)
    parse_coordinates(payload, warnings)
    assert time.perf_counter() - start < 0.5


@pytest.mark.parametrize(
    "payload",
    [" " * 12000, "- " * 6000, "a." * 6000 + "@x", "a " * 6000, "ã" * 12000, "-" * 12000],
    ids=["espacos", "tracos-alternados", "email", "letras-espacos", "til", "tracos"],
)
def test_catalog_normalizer_e_estavel_com_entradas_patologicas(payload) -> None:
    from app.services.catalog_normalizer import (
        normalize_person_name,
        parse_person_email,
        parse_phone,
        room_probable_duplicate_key,
        suspicious_name_reasons,
    )

    start = time.perf_counter()
    name = normalize_person_name(payload)
    suspicious_name_reasons(name or payload)
    parse_person_email(payload)
    parse_phone(payload)
    room_probable_duplicate_key(payload)
    clean_text(payload)
    assert time.perf_counter() - start < 0.5


def test_celula_acima_do_limite_vira_erro_bloqueante_e_e_truncada() -> None:
    from test_google_sheets_client import _FakeSettings, _make_mock_service

    from app.integrations import google_sheets_client as gsc

    big = "x" * (gsc._MAX_CELL_CHARS + 500)
    service = _make_mock_service([["ID", "SALA", "UNIDADE"], ["1", big, "UEA"]])
    with (
        patch("app.integrations.google_sheets_client.service_account.Credentials.from_service_account_file"),
        patch("googleapiclient.discovery.build", return_value=service),
    ):
        result = gsc.GoogleSheetsClient(settings=_FakeSettings()).read_tab_rows(sheet_name="Salas")
    row = result.rows[0]
    assert len(row["raw_values"]["SALA"]) == gsc._MAX_CELL_CHARS
    assert any(e.startswith("erro:") and "excede" in e for e in row["validation_errors"])
