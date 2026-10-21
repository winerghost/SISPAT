"""Revisão AppSec 2026-10-20: vínculo do bem (`bond_status`) e filtros do dashboard.

Relatório: docs/security/REVISAO_VINCULO_FILTROS_2026-10-20.md.

Cobre o que os testes funcionais (`test_dashboard_filters.py`,
`test_assets_bond_status.py`) não cobrem do ponto de vista de segurança:

- authN/authZ em TODAS as rotas novas (sem token, ADM AAL1, sem `reports.read`),
  com evento auditado;
- IDOR/BOLA por `unit_id`/`owner_unit_id`/`room_id`/`responsible_person_id` de
  outra unidade: resposta idêntica à de UUID inexistente em todos os agregados;
- parâmetro desconhecido/privilegiado na query: 400 + evento, sem eco de valor;
- valores com metacaracteres SQL/LIKE tratados literalmente;
- datas-limite (ano 9999) não viram 500;
- vínculo gravado com controle/formatação (como o backfill SQL da 0012 pode
  gravar) não quebra os agregados e sai limpo no rótulo;
- mass assignment de `bond_status` (inclusive `null`) no PATCH;
- SEC-VF-01 (CORRIGIDO): planilha com UMA só coluna RESPONSAVEL não grava o
  nome da pessoa em `vinculo_situacao` -> `assets.bond_status`;
- SEC-VF-01 item 2: vínculo igual à pessoa da linha ou a uma pessoa ativa não
  é gravado (aviso na prévia; triagem refeita na confirmação), exceto marcador;
- SEC-VF-04: valores reservados `__...__` viram vazio + aviso;
- SEC-VF-02: inventário estático + espião provando que NOVO/EXISTENTE só
  gravam via `normalize_bond_status`, e saída de /assets e dashboard limpa.

SQLite com o schema real, `require_auth` real, sem rede.
"""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch
from urllib.parse import urlencode

import pytest
import test_assets_api as taa
from sqlalchemy import select
from test_import_links import ACTOR, _confirm, _items, _line, _service, world  # noqa: F401
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.models.assets import Asset
from app.models.people import ResponsiblePerson
from app.services import dashboard_service as ds
from app.services import import_references as iref
from app.services.import_normalizer import is_reserved_bond_value, normalize_bond_status

BASE = "/api/v1/dashboard"
EXTRA = ("unit_aliases", "asset_movements", "inventories", "inventory_items")
DASH = (
    "resumo", "por-unidade", "por-situacao", "aquisicoes-mensais", "localizacao-por-unidade",
    "por-vinculo", "pendencias-cadastro", "por-sala", "inventario", "tipos",
)
SUBS = {"ua": "vf-a", "ub": "vf-b", "rh": "vf-rh", "adm": "vf-adm", "norep": "vf-norep"}


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    # ADM/USER/RH com reports.read (como no seed); papel extra sem reports.read
    # não existe no modelo, então o "sem permissão" é um RH sem reports.read
    # num mundo separado (ver `api_sem_reports`).
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read",))
    yield from _world()


@pytest.fixture()
def api_sem_reports(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA)
    yield from _world()


def _world():
    world = taa.AssetWorld(taa._build_engine())
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        for target in (
            "app.api.v1.dashboard.get_db_session",
            "app.api.v1.assets.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=events.append)
        )
        ua, ub = world.unit("UA"), world.unit("UB")
        world.user("User A", role="USER", units=[ua], auth_user_id=SUBS["ua"])
        world.user("User B", role="USER", units=[ub], auth_user_id=SUBS["ub"])
        world.user("Rita RH", role="RH", units=[ua], auth_user_id=SUBS["rh"])
        world.user("Adm A", role="ADM", units=[ua], auth_user_id=SUBS["adm"])
        yield SimpleNamespace(
            client=create_app().test_client(), world=world, ua=ua, ub=ub, events=events
        )


def get(api, path, who="ua", aal="aal1", **params):
    query = f"?{urlencode(params)}" if params else ""
    return api.client.get(f"{path}{query}", headers=auth_headers(SUBS[who], aal=aal))


def dash(api, name, who="ua", aal="aal1", **params):
    return get(api, f"{BASE}/{name}", who, aal, **params)


def kinds(api) -> list[str]:
    return [e["event_type"] for e in api.events]


ALL_PATHS = [f"{BASE}/{p}" for p in DASH] + ["/api/v1/assets/bond-statuses"]


# --- authN / authZ ---------------------------------------------------------------


@pytest.mark.parametrize("path", ALL_PATHS)
def test_sem_token_401(api, path):
    assert api.client.get(path).status_code == 401


@pytest.mark.parametrize("path", ALL_PATHS)
def test_adm_aal1_negado_e_auditado(api, path):
    api.world.asset(api.ua, "1", bond_status="Ocioso")
    response = get(api, path, "adm", "aal1")
    assert response.status_code in (401, 403)
    assert "Ocioso" not in response.get_data(as_text=True)
    assert "AAL2_REQUIRED" in kinds(api)
    assert get(api, path, "adm", "aal2").status_code == 200


@pytest.mark.parametrize("name", DASH)
def test_sem_reports_read_403_e_auditado(api_sem_reports, name):
    api = api_sem_reports
    api.world.asset(api.ua, "1", bond_status="Ocioso")
    for who in ("ua", "rh"):
        api.events.clear()
        response = dash(api, name, who)
        assert response.status_code == 403
        assert "Ocioso" not in response.get_data(as_text=True)
        assert "ACCESS_DENIED" in kinds(api)
    # `bond-statuses` exige só assets.read (contrato documentado)
    assert get(api, "/api/v1/assets/bond-statuses", "ua").status_code == 200


# --- IDOR/BOLA por IDs de outra unidade -------------------------------------------


def _seed_two_units(api):
    room_b = api.world.room(api.ub, "Sala Secreta B")
    person_b = api.world.person(api.ub, "Pessoa Secreta B")
    api.world.asset(api.ua, "A1", description="(1) NOTEBOOK", bond_status="Ocioso", located="SIM")
    api.world.asset(
        api.ub, "B1", description="(2) COFRE", bond_status="VinculoSecretoB", located="NAO",
        room_id=room_b, responsible_person_id=person_b,
    )
    return room_b, person_b


@pytest.mark.parametrize("field", ["unit_id", "owner_unit_id", "room_id", "responsible_person_id"])
def test_id_de_outra_unidade_igual_a_inexistente_em_todos_os_agregados(api, field):
    room_b, person_b = _seed_two_units(api)
    alien = {"unit_id": api.ub, "owner_unit_id": api.ub, "room_id": room_b,
             "responsible_person_id": person_b}[field]
    for name in DASH:
        real = dash(api, name, **{field: str(alien)})
        ghost = dash(api, name, **{field: str(uuid.uuid4())})
        assert real.status_code == ghost.status_code == 200, name
        assert real.get_json() == ghost.get_json(), (name, field)
        text = real.get_data(as_text=True)
        for secret in ("Secreta", "VinculoSecretoB", "COFRE", "UB"):
            assert secret not in text, (name, secret)


@pytest.mark.parametrize("who", ["ua", "rh"])
def test_bond_statuses_sem_vazamento_entre_unidades(api, who):
    _seed_two_units(api)
    body = get(api, "/api/v1/assets/bond-statuses", who).get_json()
    assert body == {"items": [{"value": "Ocioso", "count": 1}]}


# --- validação da query: desconhecido/privilegiado auditado, sem eco ---------------


@pytest.mark.parametrize("path", [f"{BASE}/resumo", f"{BASE}/por-vinculo", "/api/v1/assets/bond-statuses"])
def test_parametro_desconhecido_400_auditado_sem_valor(api, path):
    secret = "VALOR-SECRETO-123"
    response = get(api, path, foo=secret)
    assert response.status_code == 400
    assert secret not in response.get_data(as_text=True)
    events = [e for e in api.events if e["event_type"] == "MASS_ASSIGNMENT_REJECTED"]
    assert len(events) == 1
    assert secret not in repr(events[0])


@pytest.mark.parametrize("field", ["role", "is_admin", "permissions"])
def test_parametro_privilegiado_na_query_vira_evento_de_escalacao(api, field):
    response = dash(api, "resumo", **{field: "ADM"})
    assert response.status_code == 400
    assert "PRIVILEGE_ESCALATION_ATTEMPT" in kinds(api)


@pytest.mark.parametrize("params", [
    {"registrado_desde": "9999-01-01", "registrado_ate": "9999-12-31"},
    {"registrado_desde": "9999-12-31"},
    {"registrado_ate": "0001-01-01"},
    {"unit_id": "00000000-0000-0000-0000-000000000000"},
    {"bond_status": "x" * 10_000},
    {"tipo": "A" * 10_000},
])
def test_valores_limite_nao_viram_500(api, params):
    for name in DASH:
        assert dash(api, name, **params).status_code in (200, 400), (name, params)


@pytest.mark.parametrize("value", ["%", "_", "' OR '1'='1", "Ocioso' --", "o%", "*"])
def test_bond_status_com_metacaracteres_e_literal(api, value):
    api.world.asset(api.ua, "1", bond_status="Ocioso")
    api.world.asset(api.ua, "2", bond_status="Servidor")
    assert dash(api, "resumo", bond_status=value).get_json()["total_bens"] == 0
    body = get(api, "/api/v1/assets", bond_status=value).get_json()
    assert body["total"] == 0


# --- rótulos vindos da planilha ------------------------------------------------------


def test_vinculo_gravado_com_controle_nao_quebra_e_sai_limpo(api):
    """O backfill SQL da 0012 só colapsa `\\s`; não remove Cc/Cf (U+0001,
    U+200B, U+202E). Simula esse dado já gravado: os agregados continuam 200 e
    o rótulo exibido não carrega controle/formatação invisível."""
    import unicodedata

    for n, value in enumerate(["Servidor\x01", "‮Ocioso", "Terc​eirizado", "​"]):
        api.world.asset(api.ua, f"C{n}", bond_status=value)
    for name in DASH:
        assert dash(api, name).status_code == 200, name
    for item in dash(api, "por-vinculo").get_json():
        assert all(unicodedata.category(c)[0] != "C" for c in item["label"]), item
    assert get(api, "/api/v1/assets/bond-statuses").status_code == 200


def test_sala_hostil_no_relatorio_por_sala_e_texto(api):
    room = api.world.room(api.ua, "<svg onload=alert(1)>‮=HYPERLINK(\"http://x\")")
    api.world.asset(api.ua, "1", room_id=room)
    item = dash(api, "por-sala").get_json()[0]
    assert item["label"] == "<svg onload=alert(1)>=HYPERLINK(\"http://x\")"
    assert len(item["label"]) <= ds.LABEL_MAX


# --- mass assignment ---------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "Servidor", ["Servidor"], {"x": 1}])
def test_patch_bond_status_qualquer_forma_e_rejeitado_e_auditado(api, value):
    asset_id = api.world.asset(api.ua, "MA", bond_status="Ocioso")
    for who, aal in (("ua", "aal1"), ("adm", "aal2")):
        api.events.clear()
        response = api.client.patch(
            f"/api/v1/assets/{asset_id}", headers=auth_headers(SUBS[who], aal=aal),
            json={"version": 1, "bond_status": value},
        )
        assert response.status_code == 400
        assert "MASS_ASSIGNMENT_REJECTED" in kinds(api)
    row = api.world.row(asset_id)
    assert row.bond_status == "Ocioso" and row.version == 1


# --- SEC-VF-01: nome de pessoa como vínculo (LGPD) -----------------------------------


def test_planilha_com_uma_so_coluna_responsavel_nao_grava_pessoa_como_vinculo():
    """Se a planilha tiver só UMA coluna RESPONSAVEL (a pessoa), o valor NÃO
    pode ir para `vinculo_situacao` (que vira `assets.bond_status`, exibido a
    todos os perfis, inclusive RH, e listado em `/assets/bond-statuses`)."""
    from test_google_sheets_client import _FakeSettings, _make_mock_service

    from app.integrations.google_sheets_client import GoogleSheetsClient

    headers = ["ID", "PATRIMONIO", "RESPONSAVEL", "UNIDADE"]
    row = ["1", "00123", "Maria Sintetica da Silva", "SEDE"]
    with patch("app.integrations.google_sheets_client.service_account.Credentials"
               ".from_service_account_file"), \
            patch("googleapiclient.discovery.build", return_value=_make_mock_service([headers, row])):
        result = GoogleSheetsClient(settings=_FakeSettings()).read_patrimony_rows()
    assert result.rows[0]["normalized_values"]["vinculo_situacao"] is None


# --- SEC-VF-01 item 2 / SEC-VF-04: triagem do vínculo na prévia e na confirmação ---

AVISO_LINHA = (
    "aviso: 1ª RESPONSAVEL (vínculo) é igual à 2ª RESPONSAVEL (pessoa) da linha; "
    "vínculo não será gravado"
)
AVISO_CADASTRO = (
    "aviso: 1ª RESPONSAVEL (vínculo) coincide com o nome de uma pessoa cadastrada; "
    "vínculo não será gravado"
)
AVISO_RESERVADO = (
    "aviso: 1ª RESPONSAVEL (vínculo) usa um valor reservado do sistema "
    "(__none__/__outros__); vínculo tratado como vazio"
)


def _one_asset(world):
    world.db.expire_all()
    return world.db.execute(select(Asset)).scalars().one()


def _preview_one(world, **line):
    service = _service(world, [_line(**line)])
    preview = service.create_preview(ACTOR)
    (item,) = _items(world.db, preview.id)
    return service, preview, item


def _bond_warnings(item) -> list[str]:
    return [m for m in item.validation_errors or [] if "vínculo" in m]


def test_vinculo_igual_a_pessoa_da_linha_nao_e_gravado_e_avisa(world):
    service, preview, item = _preview_one(
        world, RESP1="  maria   SINTÉTICA ", RESP2="Maria Sintetica", USUARIO="",
    )
    assert item.classification == "NOVO"
    assert AVISO_LINHA in item.validation_errors
    assert item.normalized_values["_vinculo_descartado"] == iref.BOND_IS_ROW_PERSON
    assert "aria" not in " ".join(item.validation_errors)  # aviso não ecoa o nome
    assert _confirm(service, world.db, preview)["created"] == 1
    assert _one_asset(world).bond_status is None


def test_vinculo_igual_a_pessoa_ativa_cadastrada_nao_e_gravado(world):
    # `world.person` = "Phillipe Farias Ferreira" (ativa); 2ª RESPONSAVEL é outra.
    service, preview, item = _preview_one(world, RESP1="PHILLIPE FARIAS FERREIRA", RESP2="Outra Pessoa")
    assert AVISO_CADASTRO in item.validation_errors
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status is None


def test_pessoa_inativa_nao_bloqueia_vinculo(world):
    world.db.add(ResponsiblePerson(
        id=uuid.uuid4(), name="Servidor", unit_id=world.units["UEA"].id, active=False,
    ))
    world.db.commit()
    service, preview, item = _preview_one(world, RESP1="Servidor")
    assert _bond_warnings(item) == []
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status == "Servidor"


def test_marcador_ocioso_continua_vinculo_valido_mesmo_igual_a_pessoa(world):
    world.db.add(ResponsiblePerson(
        id=uuid.uuid4(), name="Ocioso", unit_id=world.units["UEA"].id, active=True,
    ))
    world.db.commit()
    service, preview, item = _preview_one(world, RESP1="Ocioso", RESP2="Ocioso", USUARIO="Ocioso@ocioso")
    assert _bond_warnings(item) == []
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status == "Ocioso"


@pytest.mark.parametrize("value", ["__none__", " __NONE__ ", "__outros__", "__Outros__", "__outras__", "__x__"])
def test_valor_reservado_vira_vazio_com_aviso(world, value):
    service, preview, item = _preview_one(world, RESP1=value)
    assert AVISO_RESERVADO in item.validation_errors
    assert item.normalized_values["_vinculo_descartado"] == iref.BOND_RESERVED
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status is None


@pytest.mark.parametrize("value", ["__none__", "__OUTROS__", "  __outras__", "_" * 70, "__" + "a" * 70 + "__"])
def test_normalize_bond_status_recusa_reservado(value):
    assert is_reserved_bond_value(value)
    assert normalize_bond_status(value) is None


@pytest.mark.parametrize("value", ["_none_", "__none", "none__", "Servidor__", "__"])
def test_normalize_bond_status_aceita_parecido_com_reservado(value):
    assert not is_reserved_bond_value(value)
    assert normalize_bond_status(value) == value


def test_existente_com_vinculo_de_pessoa_mantem_valor_atual_e_avisa(world):
    service = _service(world, [_line(RESP1="Servidor")])
    _confirm(service, world.db, service.create_preview(ACTOR))
    service, preview, item = _preview_one(world, RESP1="Phillipe Farias Ferreira", RESP2="Outra Pessoa")
    assert item.classification == "EXISTENTE" and AVISO_CADASTRO in item.validation_errors
    assert _confirm(service, world.db, preview)["updated"] == 1
    assert _one_asset(world).bond_status == "Servidor"


def test_existente_com_reservado_mantem_valor_atual(world):
    service = _service(world, [_line(RESP1="Terceirizado")])
    _confirm(service, world.db, service.create_preview(ACTOR))
    service, preview, item = _preview_one(world, RESP1="__none__")
    assert AVISO_RESERVADO in item.validation_errors
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status == "Terceirizado"


def test_confirmacao_refaz_a_triagem_com_pessoas_atuais(world):
    """Pessoa cadastrada ENTRE a prévia e a confirmação: a confirmação
    (autoritativa) também descarta o vínculo."""
    service, preview, item = _preview_one(world, RESP1="Joana Nova Sintetica")
    assert _bond_warnings(item) == []
    world.db.add(ResponsiblePerson(
        id=uuid.uuid4(), name="Joana Nova Sintética", unit_id=world.units["UEA"].id, active=True,
    ))
    world.db.commit()
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status is None


def test_nome_longo_comparado_antes_do_corte_em_64(world):
    nome = "Fulano " + "de Tal " * 12 + "Sintetico"  # > 64 caracteres
    service, preview, item = _preview_one(world, RESP1=nome, RESP2=nome.upper())
    assert AVISO_LINHA in item.validation_errors
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status is None


def test_pessoas_carregadas_uma_vez_por_previa(world, monkeypatch):
    calls = []
    real_init = iref.ImportReferences.__init__

    def counting_init(self, db):
        calls.append(1)
        real_init(self, db)

    monkeypatch.setattr(iref.ImportReferences, "__init__", counting_init)
    lines = [_line(ID=str(n), PATRIMONIO=f"P{n}", RESP1=f"Vinculo {n}") for n in range(30)]
    _service(world, lines).create_preview(ACTOR)
    assert len(calls) == 1


# --- SEC-VF-02: todo caminho que grava bond_status passa por normalize_bond_status ---


def test_novo_e_existente_gravam_somente_via_normalize_bond_status(world, monkeypatch):
    calls: list[Any] = []

    def spy(value):
        calls.append(value)
        real = normalize_bond_status(value)
        return f"N:{real}" if real is not None else None

    monkeypatch.setattr(iref, "normalize_bond_status", spy)
    service = _service(world, [_line(RESP1="Servidor")])
    _confirm(service, world.db, service.create_preview(ACTOR))
    assert _one_asset(world).bond_status == "N:Servidor"  # NOVO
    service = _service(world, [_line(RESP1="Terceirizado")])
    preview = service.create_preview(ACTOR)
    assert [i.classification for i in _items(world.db, preview.id)] == ["EXISTENTE"]
    _confirm(service, world.db, preview)
    assert _one_asset(world).bond_status == "N:Terceirizado"  # EXISTENTE
    assert "Terceirizado" in calls


def test_inventario_estatico_de_gravacoes_de_bond_status():
    """Toda escrita de `bond_status` no código da aplicação (kwarg ou
    atribuição de atributo) fica em `import_service` e usa `_bond_status_of`
    (que delega a `screen_bond_status` -> `normalize_bond_status`). Um caminho
    novo de gravação quebra este teste e precisa passar pela mesma regra."""
    import ast
    import inspect
    import pathlib

    from app.services.import_service import ImportService

    app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
    writes: list[tuple[str, str]] = []
    bond_sources: list[str] = []
    for path in app_dir.rglob("*.py"):
        rel = path.relative_to(app_dir).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.keyword) and node.arg == "bond_status":
                writes.append((rel, ast.unparse(node.value)))
            elif isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Attribute) and target.attr == "bond_status":
                        writes.append((rel, ast.unparse(node.value)))
                    if (isinstance(target, ast.Name) and target.id == "bond"
                            and node.value is not None and rel == "services/import_service.py"):
                        bond_sources.append(ast.unparse(node.value))
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value.upper()
                if "BOND_STATUS" in text and ("UPDATE " in text or "INSERT " in text):
                    writes.append((rel, "SQL literal"))
    assert sorted(writes) == [
        ("services/import_service.py", "bond"),
        ("services/import_service.py", "self._bond_status_of(nv)"),
    ]
    assert bond_sources == ["self._bond_status_of(item.normalized_values or {})"]
    assert "screen_bond(" in inspect.getsource(ImportService._bond_status_of)
    assert "normalize_bond_status(raw)" in inspect.getsource(iref.screen_bond_status)


def test_saida_de_assets_e_dashboard_passa_por_limpeza(api):
    """Dado legado sujo (como o backfill SQL da 0012 gravaria): lista/detalhe
    de bens devolvem o vínculo pela regra de gravação; o rótulo do dashboard
    sai sem Cc/Cf; valor reservado legado não é exibido como vínculo."""
    import unicodedata

    dirty = api.world.asset(api.ua, "D1", bond_status="‮Servidor\x01​")
    reserved = api.world.asset(api.ua, "D2", bond_status="__none__")
    body = get(api, "/api/v1/assets").get_json()
    by_number = {a["patrimony_number"]: a for a in body["assets"]}
    assert by_number["D1"]["bond_status"] == "Servidor"
    assert by_number["D2"]["bond_status"] is None
    assert get(api, f"/api/v1/assets/{dirty}").get_json()["bond_status"] == "Servidor"
    assert get(api, f"/api/v1/assets/{reserved}").get_json()["bond_status"] is None
    for item in dash(api, "por-vinculo").get_json():
        assert all(unicodedata.category(c)[0] != "C" for c in item["label"]), item
