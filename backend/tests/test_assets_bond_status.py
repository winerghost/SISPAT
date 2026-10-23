"""Campo "Vínculo" do bem (`assets.bond_status`, 1ª coluna RESPONSAVEL).

- normalização única (`normalize_bond_status`), igual ao backfill SQL da 0012;
- importação: NOVO grava; EXISTENTE atualiza quando muda; planilha vazia não apaga;
- API: campo na lista/detalhe (todos os perfis), filtro sem caixa/`__none__`,
  ordenação, endpoint de opções com escopo de unidade e mass assignment rejeitado.

Reaproveita os mundos SQLite de `test_assets_api` (API) e `test_import_links`
(importação pelo `GoogleSheetsClient._build_row` real). Sem rede.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.assets import Asset
from app.services.import_normalizer import BOND_STATUS_MAX, normalize_bond_status
from test_assets_api import ADM, ADM_B, NOT_FOUND, RH_A, USER_A, USER_AB, USER_B, ast, h, types  # noqa: F401
from test_import_links import ACTOR, _confirm, _items, _line, _service, world  # noqa: F401

# ---------------------------------------------------------------------------
# Normalização
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ("  Ocioso ", "Ocioso"),
    ("Servidor   Público", "Servidor Público"),
    ("Terceirizado\t\n Externo", "Terceirizado Externo"),
    ("   ", None),
    ("", None),
    (None, None),
    ("Oci\x00oso", "Ocioso"),
    ("Servidor​", "Servidor"),
    ("‮Servidor", "Servidor"),
    ("A \x07 B", "A B"),
    ("\x00\x01", None),
    (123, "123"),
])
def test_normalize_bond_status(raw, expected):
    assert normalize_bond_status(raw) == expected


def test_normalize_bond_status_corta_em_64_e_trim_por_ultimo():
    seventy = "X" * 70
    assert normalize_bond_status(seventy) == "X" * BOND_STATUS_MAX
    # o corte cai num espaço: o trim vem DEPOIS do corte (igual ao SQL)
    value = "A" * 63 + " " + "B" * 10
    out = normalize_bond_status(value)
    assert out == "A" * 63 and len(out) <= BOND_STATUS_MAX and out == out.strip()


def test_normalize_bond_status_sempre_respeita_o_check():
    for raw in ("  x  ", "a" * 200, " a " * 50, " Ocioso "):
        out = normalize_bond_status(raw)
        assert out is None or (1 <= len(out) <= BOND_STATUS_MAX and out == out.strip())


# ---------------------------------------------------------------------------
# Importação
# ---------------------------------------------------------------------------


def _asset(world):
    return world.db.execute(select(Asset)).scalars().one()


def test_importacao_novo_grava_vinculo_normalizado(world) -> None:
    service = _service(world, [_line(RESP1="  Servidor   Público ")])
    preview = service.create_preview(ACTOR)
    assert _confirm(service, world.db, preview)["created"] == 1
    asset = _asset(world)
    assert asset.bond_status == "Servidor Público"
    assert asset.responsible_person_id == world.person.id  # 2ª RESPONSAVEL segue sendo a pessoa


def test_importacao_novo_ocioso_nao_e_pessoa(world) -> None:
    service = _service(world, [_line(RESP1="Ocioso", RESP2="Ocioso", USUARIO="Ocioso@ocioso")])
    preview = service.create_preview(ACTOR)
    _confirm(service, world.db, preview)
    asset = _asset(world)
    assert asset.bond_status == "Ocioso" and asset.responsible_person_id is None


def test_importacao_novo_vinculo_vazio_fica_nulo(world) -> None:
    service = _service(world, [_line(RESP1="   ")])
    preview = service.create_preview(ACTOR)
    _confirm(service, world.db, preview)
    assert _asset(world).bond_status is None


def _reimport(world, resp1, *, unchanged=False):
    service = _service(world, [_line(RESP1=resp1)])
    preview = service.create_preview(ACTOR)
    assert [i.classification for i in _items(world.db, preview.id)] == ["EXISTENTE"]
    out = _confirm(service, world.db, preview)
    # Contrato novo: sem diferença com a planilha = INALTERADO (não grava, version intacta).
    expected = (0, 1) if unchanged else (1, 0)
    assert (out["updated"], out["inalterados"]) == expected and out["falhas"] == []
    world.db.expire_all()
    return _asset(world)


def test_importacao_existente_atualiza_vinculo_quando_muda(world) -> None:
    service = _service(world, [_line(RESP1="Servidor")])
    _confirm(service, world.db, service.create_preview(ACTOR))
    before = _asset(world)
    assert before.bond_status == "Servidor" and before.version == 1
    after = _reimport(world, "  Terceirizado ")
    assert after.bond_status == "Terceirizado" and after.version == 2
    assert after.updated_by == ACTOR


def test_importacao_existente_vazio_nao_apaga_vinculo(world) -> None:
    service = _service(world, [_line(RESP1="Ocioso")])
    _confirm(service, world.db, service.create_preview(ACTOR))
    after = _reimport(world, "", unchanged=True)
    assert after.bond_status == "Ocioso" and after.version == 1
    after = _reimport(world, "   ", unchanged=True)
    assert after.bond_status == "Ocioso" and after.version == 1


def test_importacao_existente_preenche_vinculo_ausente(world) -> None:
    service = _service(world, [_line(RESP1=None)])
    _confirm(service, world.db, service.create_preview(ACTOR))
    assert _asset(world).bond_status is None
    assert _reimport(world, "Servidor").bond_status == "Servidor"


# ---------------------------------------------------------------------------
# API: resposta, filtro, ordenação
# ---------------------------------------------------------------------------


def test_lista_e_detalhe_incluem_bond_status_para_todos_os_perfis(ast):
    a1 = ast.w.asset(ast.a, "V-1", bond_status="Ocioso")
    a2 = ast.w.asset(ast.a, "V-2")
    for sub in (ADM, USER_A, RH_A):
        listing = ast.client.get("/api/v1/assets", headers=h(sub)).get_json()["assets"]
        by_id = {x["id"]: x for x in listing}
        assert by_id[str(a1)]["bond_status"] == "Ocioso"
        assert "bond_status" in by_id[str(a2)] and by_id[str(a2)]["bond_status"] is None
        detail = ast.client.get(f"/api/v1/assets/{a1}", headers=h(sub)).get_json()
        assert detail["bond_status"] == "Ocioso"


def _ids(ast, sub, **params):
    r = ast.client.get("/api/v1/assets", headers=h(sub), query_string=params)
    assert r.status_code == 200, r.get_json()
    return {x["id"] for x in r.get_json()["assets"]}


def test_filtro_bond_status_exato_sem_caixa_e_none(ast):
    oc1 = ast.w.asset(ast.a, "F-1", bond_status="Ocioso")
    oc2 = ast.w.asset(ast.a, "F-2", bond_status="OCIOSO")
    srv = ast.w.asset(ast.a, "F-3", bond_status="Servidor")
    nul = ast.w.asset(ast.a, "F-4")
    ast.w.asset(ast.b, "F-B", bond_status="Ocioso")  # fora do escopo de USER_A
    assert _ids(ast, USER_A, bond_status="ocioso") == {str(oc1), str(oc2)}
    assert _ids(ast, USER_A, bond_status="  Ocioso ") == {str(oc1), str(oc2)}
    assert _ids(ast, USER_A, bond_status="Servidor") == {str(srv)}
    assert _ids(ast, USER_A, bond_status="Servi") == set()  # exato, não prefixo
    assert _ids(ast, USER_A, bond_status="__none__") == {str(nul)}
    assert _ids(ast, RH_A, bond_status="servidor") == {str(srv)}


@pytest.mark.parametrize("value", ["X" * 65, "", "   ", "Oci\x00oso"])
def test_filtro_bond_status_invalido_e_400(ast, value):
    r = ast.client.get("/api/v1/assets", headers=h(USER_A), query_string={"bond_status": value})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert "bond_status" in r.get_json()["error"]["message"]


def test_filtro_bond_status_64_caracteres_e_aceito(ast):
    asset_id = ast.w.asset(ast.a, "F-64", bond_status="Y" * 64)
    assert _ids(ast, USER_A, bond_status="y" * 64) == {str(asset_id)}


def test_ordenacao_por_bond_status(ast):
    ast.w.asset(ast.a, "S-1", bond_status="Terceirizado")
    ast.w.asset(ast.a, "S-2", bond_status="ocioso")
    ast.w.asset(ast.a, "S-3")
    ast.w.asset(ast.a, "S-4", bond_status="Servidor")
    asc = ast.client.get("/api/v1/assets?sort=bond_status", headers=h(USER_A)).get_json()["assets"]
    assert [x["bond_status"] for x in asc] == [None, "ocioso", "Servidor", "Terceirizado"]
    desc = ast.client.get("/api/v1/assets?sort=-bond_status", headers=h(USER_A)).get_json()["assets"]
    assert [x["bond_status"] for x in desc] == ["Terceirizado", "Servidor", "ocioso", None]


# ---------------------------------------------------------------------------
# API: mass assignment
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("sub", [USER_A, ADM])
def test_bond_status_rejeitado_na_criacao(ast, sub):
    r = ast.client.post("/api/v1/assets", headers=h(sub), json={
        "unit_id": str(ast.a), "patrimony_number": "MA-B", "bond_status": "Servidor"})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(ast, "MASS_ASSIGNMENT_REJECTED")) + len(types(ast, "PRIVILEGE_ESCALATION_ATTEMPT")) == 1
    with ast.w.session() as db:
        assert db.execute(select(Asset)).first() is None


@pytest.mark.parametrize("sub", [USER_A, ADM])
def test_bond_status_rejeitado_na_edicao(ast, sub):
    asset_id = ast.w.asset(ast.a, "MA-E", bond_status="Ocioso")
    r = ast.client.patch(f"/api/v1/assets/{asset_id}", headers=h(sub),
                         json={"version": 1, "bond_status": "Servidor"})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(ast, "MASS_ASSIGNMENT_REJECTED")) + len(types(ast, "PRIVILEGE_ESCALATION_ATTEMPT")) == 1
    row = ast.w.row(asset_id)
    assert row.bond_status == "Ocioso" and row.version == 1
    assert ast.w.audits() == []


# ---------------------------------------------------------------------------
# API: opções do filtro (`/assets/bond-statuses`)
# ---------------------------------------------------------------------------


def _options(ast, sub, **params):
    return ast.client.get("/api/v1/assets/bond-statuses", headers=h(sub), query_string=params)


def test_opcoes_agrupam_sem_caixa_com_grafia_mais_frequente(ast):
    for n, bond in enumerate(["Ocioso", "Ocioso", "OCIOSO", "Servidor", "servidor",
                              "Terceirizado", None]):
        ast.w.asset(ast.a, f"O-{n}", bond_status=bond)
    r = _options(ast, USER_A)
    assert r.status_code == 200
    assert r.get_json() == {"items": [
        {"value": "Ocioso", "count": 3},
        {"value": "Servidor", "count": 2},  # empate 1x1: alfabético ("S" < "s")
        {"value": "Terceirizado", "count": 1},
    ]}


def test_opcoes_ignoram_excluidos_e_respeitam_escopo(ast):
    from datetime import datetime, timezone

    ast.w.asset(ast.a, "E-1", bond_status="Ocioso")
    ast.w.asset(ast.a, "E-2", bond_status="Ocioso", deleted_at=datetime.now(timezone.utc))
    ast.w.asset(ast.b, "E-3", bond_status="Terceirizado")
    ast.w.asset(ast.b, "E-4", bond_status="Ocioso")
    ast.w.asset(ast.b, "E-5", bond_status="Servidor", owner_unit_id=ast.a)  # escopo por owner
    a_items = {"items": [{"value": "Ocioso", "count": 1}, {"value": "Servidor", "count": 1}]}
    for sub in (USER_A, RH_A, ADM):
        assert _options(ast, sub).get_json() == a_items
    assert _options(ast, USER_B).get_json() == {"items": [
        {"value": "Ocioso", "count": 1}, {"value": "Servidor", "count": 1},
        {"value": "Terceirizado", "count": 1},
    ]}
    assert _options(ast, USER_AB).get_json()["items"][0] == {"value": "Ocioso", "count": 2}
    assert _options(ast, ADM_B).get_json()["items"][-1] == {"value": "Terceirizado", "count": 1}


def test_opcoes_sem_escopo_e_vazio(ast):
    ast.w.asset(ast.a, "Z-1", bond_status="Ocioso")
    ast.w.user("Sem unidade", role="USER", units=[], auth_user_id="auth-lone-bond")
    r = _options(ast, "auth-lone-bond")
    assert (r.status_code, r.get_json()) == (200, {"items": []})


def test_opcoes_limitadas_a_100_grupos(ast):
    for n in range(105):
        ast.w.asset(ast.a, f"L-{n:03d}", bond_status=f"Grupo {n:03d}")
    items = _options(ast, USER_A).get_json()["items"]
    assert len(items) == 100 and items[0]["value"] == "Grupo 000" and items[-1]["value"] == "Grupo 099"


def test_opcoes_rejeitam_parametros(ast):
    for params in ({"include_deleted": "true"}, {"unit_id": str(ast.b)}):
        r = _options(ast, USER_A, **params)
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def test_opcoes_exigem_autenticacao(ast):
    assert ast.client.get("/api/v1/assets/bond-statuses").status_code == 401
