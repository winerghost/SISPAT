"""Filtros de SALA, RESPONSÁVEL e VÍNCULO do catálogo de relatórios (frente A).

Regressão do defeito relatado em 2026-10-28: `room_id`/`responsible_person_id`
eram anunciados como `uuid` e `bond_status` como `text`, então a tela
`/relatorios` gerava INPUT DE TEXTO LIVRE (a pessoa tinha de digitar um UUID).
Agora o catálogo anuncia os tipos de lookup `room`/`person` (o frontend carrega
`/api/v1/rooms` e `/api/v1/responsible-people`, já com escopo de unidade) e
`bond_status` como `enum` cujas opções vêm dos VALORES DISTINTOS existentes no
banco DENTRO DO ESCOPO do ator (nunca codificadas à mão: o vínculo vem da
planilha do Google Sheets e muda a cada importação), mais a sentinela
`asset_service.BOND_STATUS_NONE` para "sem vínculo".

O `<select>` é conveniência de interface: a validação e o escopo seguem no
backend -- sala/responsável alheio, inexistente ou malformado => MESMA 404.

Reutiliza a fixture `api` de `test_reports_api` (SQLite + auth real, sem rede)
e a fixture `cat` de `test_catalog_api` (listas de apoio consumidas pela tela).
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timezone

import pytest
from test_catalog_api import as_ as cat_as  # noqa: F401
from test_catalog_api import cat  # noqa: F401  (cat = fixture)
from test_reports_api import (  # noqa: F401  (api = fixture)
    NOT_FOUND,
    SUBS,
    add_asset,
    api,
    csv_rows,
    export,
    get,
)

from app.services.asset_service import BOND_STATUS_NONE
from app.services.report_catalog import ASSETS, FILTER_TYPES, OPTIONS_SOURCE_KEY

PROFILES = [("ua", "aal1"), ("rh", "aal1"), ("adm", "aal2")]


def assets_filters(api, who="ua", aal="aal1") -> dict[str, dict]:
    response = get(api, "", who, aal)
    assert response.status_code == 200
    reports = {r["id"]: r for r in response.get_json()["reports"]}
    return {f["name"]: f for f in reports["assets"]["filters"]}


def bond_options(api, who="ua", aal="aal1") -> list[str]:
    return assets_filters(api, who, aal)["bond_status"]["options"]


# --- contrato do catálogo -----------------------------------------------------


@pytest.mark.parametrize("who,aal", PROFILES)
def test_catalogo_anuncia_sala_e_responsavel_como_lookup(api, who, aal):
    """Tipos novos `room`/`person`: o frontend gera `<select>`, não input livre."""
    flt = assets_filters(api, who, aal)
    assert flt["room_id"] == {"name": "room_id", "type": "room"}
    assert flt["responsible_person_id"] == {"name": "responsible_person_id", "type": "person"}
    assert flt["unit_id"]["type"] == "unit"  # padrão reaproveitado, inalterado


def test_catalogo_nao_declara_mais_filtro_de_texto_livre_para_ids(api):
    for report in get(api, "").get_json()["reports"]:
        for flt in report["filters"]:
            assert flt["type"] in FILTER_TYPES
            assert OPTIONS_SOURCE_KEY not in flt  # marcador interno nunca sai na resposta
            if flt["name"].endswith("_id"):
                assert flt["type"] in ("unit", "inventory", "room", "person")


def test_catalogo_anuncia_vinculo_como_enum(api):
    add_asset(api, api.ua, "1", bond_status="Servidor")
    flt = assets_filters(api)["bond_status"]
    assert flt["type"] == "enum" and flt["options"] == ["Servidor"]


def test_resolver_opcoes_nao_muta_o_catalogo_estatico(api):
    add_asset(api, api.ua, "1", bond_status="Servidor")
    assets_filters(api)
    assets_filters(api)
    static = {f["name"]: f for f in ASSETS.filters}
    assert static["bond_status"][OPTIONS_SOURCE_KEY] == "bond_status"
    assert "options" not in static["bond_status"]


# --- opções de vínculo: valores reais, escopo e "sem vínculo" ----------------


def test_opcoes_de_vinculo_vem_dos_valores_distintos_do_banco(api):
    """Nada é codificado à mão: o que existe no escopo é o que é oferecido."""
    add_asset(api, api.ua, "1", bond_status="Terceirizado")
    add_asset(api, api.ua, "2", bond_status="Servidor")
    add_asset(api, api.ua, "3", bond_status="Servidor")
    add_asset(api, api.ua, "4", bond_status="servidor")  # mesmo grupo, outra grafia
    assert bond_options(api) == ["Servidor", "Terceirizado"]  # grafia mais frequente, alfabética
    add_asset(api, api.ua, "5", bond_status="Estagiario")
    assert bond_options(api) == ["Estagiario", "Servidor", "Terceirizado"]


def test_opcao_sem_vinculo_usa_a_sentinela_existente_e_vem_por_ultimo(api):
    add_asset(api, api.ua, "1", bond_status="Servidor")
    assert BOND_STATUS_NONE not in bond_options(api)  # nenhum bem sem vínculo no escopo
    add_asset(api, api.ua, "2")  # bond_status NULL
    assert bond_options(api) == ["Servidor", BOND_STATUS_NONE] == ["Servidor", "__none__"]


def test_sem_vinculo_do_catalogo_filtra_bens_sem_vinculo(api):
    add_asset(api, api.ua, "100", bond_status="Servidor")
    add_asset(api, api.ua, "200")
    assert BOND_STATUS_NONE in bond_options(api)
    rows = csv_rows(export(api, "assets", f"?bond_status={BOND_STATUS_NONE}"))
    assert [r[0] for r in rows[1:]] == ["200"]


@pytest.mark.parametrize("who,aal", PROFILES)
def test_opcoes_de_vinculo_respeitam_o_escopo_de_unidade(api, who, aal):
    """Vínculo de bem de unidade alheia não aparece para nenhum perfil (ADM sem bypass)."""
    add_asset(api, api.ua, "A-1", bond_status="Servidor")
    add_asset(api, api.ub, "B-1", bond_status="Estagiario")
    add_asset(api, api.ub, "B-2")  # sem vínculo, fora do escopo de UA
    assert bond_options(api, who, aal) == ["Servidor"]


def test_usuario_sem_unidade_nao_recebe_nenhuma_opcao(api):
    add_asset(api, api.ua, "A-1", bond_status="Servidor")
    add_asset(api, api.ua, "A-2")
    assert bond_options(api, "none") == []  # negar por padrão


def test_opcoes_de_vinculo_ignoram_bens_excluidos_logicamente(api):
    add_asset(api, api.ua, "1", bond_status="Servidor")
    add_asset(api, api.ua, "2", bond_status="Cedido", deleted_at=datetime.now(timezone.utc))
    assert bond_options(api, "adm", "aal2") == ["Servidor"]


# --- escopo de unidade nos filtros (o select nunca é a defesa) ---------------


def test_filtro_de_sala_e_responsavel_do_proprio_escopo_funciona(api):
    room = api.w.room(api.ua, "Sala 1")
    person = api.w.person(api.ua, "Fulano")
    add_asset(api, api.ua, "100", room_id=room, responsible_person_id=person)
    add_asset(api, api.ua, "200")
    assert [r[0] for r in csv_rows(export(api, "assets", f"?room_id={room}"))[1:]] == ["100"]
    query = f"?responsible_person_id={person}"
    assert [r[0] for r in csv_rows(export(api, "assets", query))[1:]] == ["100"]


@pytest.mark.parametrize("name", ["room_id", "responsible_person_id"])
def test_sala_e_responsavel_alheios_inexistentes_e_malformados_tem_a_mesma_resposta(api, name):
    foreign = api.w.room(api.ub, "Sala B") if name == "room_id" else api.w.person(api.ub, "Pessoa B")
    add_asset(api, api.ua, "A-1")
    responses = [export(api, "assets", f"?{name}={value}")
                 for value in (foreign, uuid.uuid4(), "nao-e-uuid", 0)]
    assert [r.status_code for r in responses] == [404, 404, 404, 404]
    assert all(r.get_json() == NOT_FOUND for r in responses)  # sem pista de formato
    for response in responses:
        assert str(foreign) not in response.get_data(as_text=True)


def test_vinculo_fora_das_opcoes_nao_quebra_nem_vaza(api):
    """Valor que não está mais na lista (planilha mudou) segue aceito e não vaza nada."""
    add_asset(api, api.ua, "A-1", bond_status="Servidor")
    add_asset(api, api.ub, "B-1", bond_status="Estagiario")
    response = export(api, "assets", "?bond_status=Estagiario")
    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.data.decode("utf-8-sig")), delimiter=";"))
    assert len(rows) == 1 and b"B-1" not in response.data


# --- listas de apoio consumidas pelos selects da tela ------------------------


def test_listas_de_sala_e_responsavel_da_tela_respeitam_escopo(cat):
    """Fonte dos `<select>`: sem escopo, o próprio campo enumeraria pessoas e salas alheias."""
    cat.w.room(cat.a, "Sala A")
    cat.w.room(cat.b, "Sala B")
    pa = cat.w.person(cat.a, "Pessoa A")
    cat.w.asset(cat.a, pa)
    pb = cat.w.person(cat.b, "Pessoa B")
    cat.w.asset(cat.b, pb)
    for sub, aal in (("auth-user-a", "aal1"), ("auth-rh-a", "aal1")):
        rooms = cat.client.get("/api/v1/rooms", headers=cat_as(sub, aal=aal)).get_json()
        assert [r["name"] for r in rooms["rooms"]] == ["Sala A"]
        people = cat.client.get("/api/v1/responsible-people", headers=cat_as(sub, aal=aal)).get_json()
        assert [p["name"] for p in people["people"]] == ["Pessoa A"]
        assert str(pb) not in str(people) and "Sala B" not in str(rooms)
