"""SEC-CAT-06: USER vê só pessoas vinculadas a bens do escopo, com campos mínimos.

RH mantém o cadastro completo (sem telefone); ADM, completo com telefone.
Reaproveita o mundo SQLite de `test_catalog_api` (schema real dos modelos).
"""
from __future__ import annotations

import json
import uuid

import pytest

from test_catalog_api import as_, cat, types  # noqa: F401  (fixture `cat`)

URL = "/api/v1/responsible-people"
MINIMAL = {"id", "name", "unit_id", "active"}
USER_A = "auth-user-a"


def _user(cat, url, **kw):
    return cat.client.get(url, headers=as_(USER_A, aal="aal1", **kw))


def _seed(cat):
    linked = cat.w.person(cat.a, "Ana Vinculada", email="ana@agu.gov.br", phone="63911112222",
                          identifier="SIAPE-ANA")
    free = cat.w.person(cat.a, "Bia Solta", email="bia@agu.gov.br", identifier="SIAPE-BIA")
    deleted_only = cat.w.person(cat.a, "Caio Bem Excluido", email="caio@agu.gov.br")
    alien = cat.w.person(cat.b, "Dora Alheia", email="dora@agu.gov.br")
    cat.w.asset(cat.a, linked, number="1")
    cat.w.asset(cat.a, deleted_only, number="2", deleted=True)
    cat.w.asset(cat.b, alien, number="3")
    return linked, free, deleted_only, alien


def test_user_lista_so_vinculadas_e_so_campos_minimos(cat):
    linked, *_ = _seed(cat)
    r = _user(cat, URL)
    assert r.status_code == 200
    people = r.get_json()["people"]
    assert [p["name"] for p in people] == ["Ana Vinculada"] and r.get_json()["total"] == 1
    assert set(people[0]) == MINIMAL and people[0]["id"] == str(linked)
    raw = r.get_data(as_text=True)
    for secret in ("ana@agu", "SIAPE-ANA", "63911112222", "source_record_id", "email", "phone"):
        assert secret not in raw


def test_user_get_vinculada_minimo_e_nao_vinculadas_sao_404_identicos(cat):
    linked, free, deleted_only, alien = _seed(cat)
    ok = _user(cat, f"{URL}/{linked}")
    assert ok.status_code == 200 and set(ok.get_json()) == MINIMAL
    out, counts = {}, {}
    for label, target in (("solta", free), ("bem_excluido", deleted_only), ("alheia", alien),
                          ("inexistente", uuid.uuid4()), ("malformada", "x")):
        start = len(cat.queries)
        r = _user(cat, f"{URL}/{target}")
        out[label] = (r.status_code, r.get_json())
        counts[label] = len(cat.queries) - start
    assert len({json.dumps(v, sort_keys=True) for v in out.values()}) == 1
    assert out["solta"][0] == 404
    counts.pop("malformada")  # rota <uuid:> nem chega ao serviço (404 do roteador)
    assert len(set(counts.values())) == 1, counts
    assert len(types(cat, "UNIT_SCOPE_DENIED")) == 4  # acesso negado auditado


def test_user_nao_enumera_por_email_identificador_ou_ordenacao(cat):
    _seed(cat)
    for q in ("bia@agu", "SIAPE-BIA", "ana@agu", "SIAPE-ANA", "agu.gov"):
        assert _user(cat, f"{URL}?q={q}").get_json()["total"] == 0, q
    assert _user(cat, f"{URL}?q=ana").get_json()["total"] == 1  # nome
    for sort in ("email", "-email", "created_at", "updated_at"):
        r = _user(cat, f"{URL}?sort={sort}")
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert _user(cat, f"{URL}?sort=-name").status_code == 200
    assert any(e["event_type"] == "ACCESS_DENIED" for e in cat.events)


def test_user_nao_ve_pessoa_de_bem_excluido_nem_de_outra_unidade_via_filtro(cat):
    _seed(cat)
    assert _user(cat, f"{URL}?unit_id={cat.b}").get_json()["total"] == 0
    names = [p["name"] for p in _user(cat, f"{URL}?active=true").get_json()["people"]]
    assert names == ["Ana Vinculada"]
    # Usuário de outra unidade enxerga o seu próprio vínculo, nunca o da unidade A.
    other = cat.client.get(URL, headers=as_("auth-user-b", aal="aal1")).get_json()
    assert [p["name"] for p in other["people"]] == ["Dora Alheia"]


def test_sql_do_user_nao_seleciona_colunas_pessoais(cat):
    linked, *_ = _seed(cat)
    start = len(cat.queries)
    _user(cat, URL)
    _user(cat, f"{URL}/{linked}")
    _user(cat, f"{URL}?q=ana")
    selects = [q for q in cat.queries[start:] if "FROM responsible_people" in q]
    assert selects
    for sql in selects:
        head = sql.split(" FROM ", 1)[0]
        for col in ("email", "institutional_identifier", "source_record_id", "phone",
                    "created_at", "updated_at"):
            assert f"responsible_people.{col}" not in head, (col, head)
    # busca por nome apenas: e-mail/identificador não entram nem no WHERE
    q_sql = [q for q in cat.queries[start:] if "LIKE" in q.upper() and "FROM responsible_people" in q]
    assert q_sql and all("email" not in s and "institutional_identifier" not in s for s in q_sql)


def test_rh_ve_cadastro_completo_sem_telefone(cat):
    _seed(cat)
    r = cat.client.get(URL, headers=as_("auth-rh-a", aal="aal1"))
    people = {p["name"]: p for p in r.get_json()["people"]}
    assert set(people) == {"Ana Vinculada", "Bia Solta", "Caio Bem Excluido"}  # inclui não vinculadas
    assert people["Ana Vinculada"]["email"] == "ana@agu.gov.br"
    assert people["Ana Vinculada"]["institutional_identifier"] == "SIAPE-ANA"
    assert all("phone" not in p for p in people.values())
    assert cat.client.get(URL + "?q=bia@agu", headers=as_("auth-rh-a", aal="aal1")).get_json()["total"] == 1
    assert cat.client.get(URL + "?sort=email", headers=as_("auth-rh-a", aal="aal1")).status_code == 200


def test_adm_ve_cadastro_completo_com_telefone(cat):
    linked, free, *_ = _seed(cat)
    from test_catalog_api import adm

    r = cat.client.get(URL, headers=adm())
    people = {p["name"]: p for p in r.get_json()["people"]}
    assert set(people) == {"Ana Vinculada", "Bia Solta", "Caio Bem Excluido"}
    assert people["Ana Vinculada"]["phone"] == "63911112222"
    one = cat.client.get(f"{URL}/{free}", headers=adm())
    assert one.status_code == 200 and "phone" in one.get_json()


def test_user_sem_escrita_e_409_de_unicidade_so_para_adm(cat):
    _seed(cat)
    body = {"unit_id": str(cat.a), "name": "X", "email": "ana@agu.gov.br"}
    r = cat.client.post(URL, json=body, headers=as_(USER_A))
    assert r.status_code == 403  # nunca chega à checagem de unicidade
    r = cat.client.post(URL, json=body, headers=as_("auth-rh-a"))
    assert r.status_code == 403


@pytest.mark.parametrize("role_sub", [USER_A])
def test_user_sem_unidade_no_escopo_nao_ve_nada(cat, role_sub):
    _seed(cat)
    cat.w.user("Sem unidade", role="USER", units=[], auth_user_id="auth-user-none")
    r = cat.client.get(URL, headers=as_("auth-user-none", aal="aal1"))
    assert r.status_code == 200 and r.get_json()["people"] == [] and r.get_json()["total"] == 0
