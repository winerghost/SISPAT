"""Revisão AppSec das APIs de cadastros, patrimônios, movimentações e leitura admin (2026-10-17).

Testes de regressão dos achados SEC-REV-* (docs/security/REVISAO_APPSEC_CATALOGO_PATRIMONIO_2026-10-17.md).
Achados ainda abertos estão como `xfail(strict=True)`: ao corrigir o código o teste passa a XPASS
e a marca deve ser removida. Os demais travam comportamento correto já existente.
SQLite local com o carregador REAL de `require_auth`; nada toca Supabase/rede.
"""
from __future__ import annotations

import json
import logging
import uuid

import pytest

import test_assets_api as ta
import test_catalog_api as tc
import test_movements_api as tm
import test_sec_catalog_import as tci
from test_assets_api import ast  # noqa: F401  (fixture)
from test_catalog_api import cat  # noqa: F401  (fixture)
from test_movements_api import mv  # noqa: F401  (fixture)
from test_sec_catalog_import import env, fake_redis  # noqa: F401  (fixtures)


def _post_raw(client, url, raw: bytes, headers):
    return client.post(url, data=raw, headers={**headers, "Content-Type": "application/json"})


# ---------------------------------------------------------------------------
# SEC-REV-01 -- JSON profundamente aninhado derruba o parser (RecursionError -> 500)
# ---------------------------------------------------------------------------

_NESTED = b"[" * 20000 + b"]" * 20000  # ~40 KB, muito abaixo de MAX_CONTENT_LENGTH (1 MiB)
_NESTED_OBJ = b'{"name": ' + _NESTED + b"}"


@pytest.mark.xfail(strict=True, reason="SEC-REV-01 aberto: get_json(silent=True) nao captura RecursionError")
@pytest.mark.parametrize("raw", [_NESTED, _NESTED_OBJ], ids=["array", "campo"])
def test_json_aninhado_nas_rotas_de_cadastro_e_400_e_nao_500(cat, raw):  # noqa: F811
    rid = cat.w.room(cat.a, "Sala 1")
    for method, url in (
        ("post", "/api/v1/rooms"),
        ("post", "/api/v1/responsible-people"),
        ("patch", f"/api/v1/rooms/{rid}"),
        ("post", f"/api/v1/rooms/{rid}/deactivate"),
        ("patch", f"/api/v1/units/{cat.a}"),
    ):
        r = getattr(cat.client, method)(url, data=raw, headers={**tc.adm(), "Content-Type": "application/json"})
        assert r.status_code == 400, (url, r.status_code)
        assert "Traceback" not in r.get_data(as_text=True)


@pytest.mark.xfail(strict=True, reason="SEC-REV-01 aberto: get_json(silent=True) nao captura RecursionError")
@pytest.mark.parametrize("raw", [_NESTED, _NESTED_OBJ], ids=["array", "campo"])
def test_json_aninhado_em_patrimonios_e_movimentacoes_e_400(ast, raw):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "N-1")
    for method, url in (
        ("post", "/api/v1/assets"),
        ("patch", f"/api/v1/assets/{asset_id}"),
        ("post", f"/api/v1/assets/{asset_id}/delete"),
    ):
        r = getattr(ast.client, method)(
            url, data=raw, headers={**ta.h(ta.ADM), "Content-Type": "application/json"}
        )
        assert r.status_code == 400, (url, r.status_code)


# ---------------------------------------------------------------------------
# SEC-REV-02 -- nome de campo rejeitado com caractere de controle forja linha de log
# ---------------------------------------------------------------------------


def test_nome_de_campo_rejeitado_nao_forja_linha_de_log(cat, caplog):  # noqa: F811
    caplog.set_level(logging.DEBUG)
    body = {"unit_id": str(cat.a), "name": "Sala", "x\nERROR forged-line": 1, "y\r\nINFO forged-2": 2}
    r = cat.client.post("/api/v1/rooms", json=body, headers=tc.adm())
    assert r.status_code == 400
    for record in caplog.records:
        text = record.getMessage()
        assert "\n" not in text and "\r" not in text, text


@pytest.mark.xfail(strict=True, reason="SEC-REV-02 aberto: BadRequest sem tratamento loga nomes de parametro com CR/LF")
def test_consulta_de_itens_da_previa_com_parametro_forjado_nao_forja_log(env, caplog):  # noqa: F811
    """`GET /catalog-imports/<id>/items` deixa o BadRequest chegar ao handler global, que
    loga a descrição (nomes de parâmetro vindos do cliente) -- sem neutralizar CR/LF."""
    preview_id = tci._create(env, "rooms")
    caplog.set_level(logging.DEBUG)
    response = tci._get(env, f"{preview_id}/items?x%0AERROR%20linha-forjada=1&y%0D%0AINFO%20outra=2")
    assert response.status_code == 400
    for record in caplog.records:
        text = record.getMessage()
        assert "\n" not in text and "\r" not in text, repr(text)


# ---------------------------------------------------------------------------
# SEC-REV-03 -- histórico do bem entrega o MOTIVO (texto livre) ao perfil RH
# ---------------------------------------------------------------------------


@pytest.mark.xfail(strict=True, reason="SEC-REV-03 aberto: historico do bem expoe reason (texto livre) ao RH")
def test_rh_nao_recebe_motivo_de_texto_livre_no_historico_do_bem(ast):  # noqa: F811
    asset_id = ast.w.asset(ast.a, "R-1", description="Mesa")
    version = ast.w.row(asset_id).version
    secret = "contato joao.silva@exemplo.invalid 63 99999-0000"
    dele = ast.client.post(f"/api/v1/assets/{asset_id}/delete", json={"version": version, "reason": secret},
                           headers=ta.h(ta.ADM))
    assert dele.status_code == 200
    back = ast.client.post(f"/api/v1/assets/{asset_id}/restore",
                           json={"version": version + 1, "reason": secret}, headers=ta.h(ta.ADM))
    assert back.status_code == 200
    rh = ast.client.get(f"/api/v1/assets/{asset_id}/history", headers=ta.h(ta.RH_A))
    assert rh.status_code == 200 and rh.get_json()["entries"]
    assert "joao.silva" not in rh.get_data(as_text=True)
    assert "99999" not in rh.get_data(as_text=True)


# ---------------------------------------------------------------------------
# Mass assignment em CRIAÇÃO (a edição já tem teste) -- 400 + evento, nada gravado
# ---------------------------------------------------------------------------

_PRIV = [
    ("deleted_at", "2020-01-01T00:00:00Z"), ("deleted_by", str(uuid.uuid4())), ("version", 7),
    ("assigned_user_id", str(uuid.uuid4())), ("created_by", str(uuid.uuid4())),
    ("source_record_id", "99"), ("id", str(uuid.uuid4())), ("role", "ADM"), ("active", False),
]


@pytest.mark.parametrize("field,value", _PRIV)
def test_criacao_de_patrimonio_rejeita_campos_privilegiados(ast, field, value):  # noqa: F811
    body = {"unit_id": str(ast.a), "patrimony_number": "MA-1", field: value}
    for sub in (ta.USER_A, ta.ADM):
        r = ast.client.post("/api/v1/assets", json=body, headers=ta.h(sub))
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert not ast.w.audits()
    assert any(field in e["details"].get("fields", []) for e in ast.events
               if e["event_type"] in ("PRIVILEGE_ESCALATION_ATTEMPT", "MASS_ASSIGNMENT_REJECTED"))


@pytest.mark.parametrize("field,value", [
    ("origin_unit_id", str(uuid.uuid4())), ("status", "APROVADA"), ("movement_type", "MUDANCA_SALA"),
    ("requested_by", str(uuid.uuid4())), ("approved_by", str(uuid.uuid4())), ("previous_responsible_id", None),
    ("completed_at", "2020-01-01T00:00:00Z"), ("id", str(uuid.uuid4())),
])
def test_criacao_de_movimentacao_rejeita_campos_privilegiados(mv, field, value):  # noqa: F811
    asset_id = mv.w.asset(mv.a, "MM-1")
    for sub in (tm.USER_AB, tm.ADM):
        r = tm.request(mv, sub, asset_id, mv.b, **{field: value})
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert mv.w.movements() == []
    assert mv.w.row(asset_id).unit_id == mv.a


@pytest.mark.parametrize("field", ["role", "unit_id", "active", "auth_user_id", "deleted_at", "version"])
def test_pessoa_e_unidade_rejeitam_campos_privilegiados_na_edicao(cat, field):  # noqa: F811
    person = cat.w.person(cat.a, "Maria", email="m@exemplo.invalid")
    value = str(cat.b) if field == "unit_id" else ("ADM" if field == "role" else 1)
    for url in (f"/api/v1/responsible-people/{person}", f"/api/v1/units/{cat.a}"):
        r = cat.client.patch(url, json={"name": "Novo", field: value}, headers=tc.adm())
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error", url
    assert cat.w.row(tc.ResponsiblePerson, person).unit_id == cat.a


# ---------------------------------------------------------------------------
# 404 uniforme (alvo alheio == inexistente) em TODA leitura/ação por id
# ---------------------------------------------------------------------------


def test_404_uniforme_em_cadastros(cat):  # noqa: F811
    alien_room = cat.w.room(cat.b, "Sala B")
    alien_person = cat.w.person(cat.b, "Pessoa B", email="b@exemplo.invalid")
    ghost = uuid.uuid4()
    routes = [
        ("get", "/api/v1/rooms/{}", None), ("patch", "/api/v1/rooms/{}", {"name": "x"}),
        ("post", "/api/v1/rooms/{}/deactivate", {}), ("post", "/api/v1/rooms/{}/activate", {}),
        ("get", "/api/v1/units/{}", None), ("patch", "/api/v1/units/{}", {"name": "x"}),
        ("post", "/api/v1/units/{}/deactivate", {}),
        ("get", "/api/v1/responsible-people/{}", None), ("patch", "/api/v1/responsible-people/{}", {"name": "x"}),
        ("post", "/api/v1/responsible-people/{}/deactivate", {}),
    ]
    for method, template, body in routes:
        ids = {
            "alheio": cat.b if "units" in template else (alien_person if "people" in template else alien_room),
            "inexistente": ghost,
        }
        out = {}
        for label, target in ids.items():
            kwargs = {"headers": tc.adm()}
            if body is not None:
                kwargs["json"] = body
            r = getattr(cat.client, method)(template.format(target), **kwargs)
            out[label] = (r.status_code, r.get_json())
        assert out["alheio"] == out["inexistente"], template
        assert out["alheio"][0] == 404, template
        assert str(ids["alheio"]) not in json.dumps(out), template


def test_404_uniforme_em_patrimonios(ast):  # noqa: F811
    alien = ast.w.asset(ast.b, "ALHEIO-1")
    ghost = uuid.uuid4()
    for sub in (ta.ADM, ta.USER_A, ta.RH_A):
        for suffix in ("", "/history"):
            a = ast.client.get(f"/api/v1/assets/{alien}{suffix}", headers=ta.h(sub))
            g = ast.client.get(f"/api/v1/assets/{ghost}{suffix}", headers=ta.h(sub))
            assert a.status_code == g.status_code == 404
            assert a.get_json() == g.get_json() == ta.NOT_FOUND
    for sub in (ta.ADM, ta.USER_A):
        patch_a = ast.client.patch(f"/api/v1/assets/{alien}", json={"version": 1, "description": "x"},
                                   headers=ta.h(sub))
        patch_g = ast.client.patch(f"/api/v1/assets/{ghost}", json={"version": 1, "description": "x"},
                                   headers=ta.h(sub))
        assert patch_a.status_code == patch_g.status_code == 404
        assert patch_a.get_json() == patch_g.get_json()
    for action in ("delete", "restore"):
        a = ast.client.post(f"/api/v1/assets/{alien}/{action}", json={"version": 1}, headers=ta.h(ta.ADM))
        g = ast.client.post(f"/api/v1/assets/{ghost}/{action}", json={"version": 1}, headers=ta.h(ta.ADM))
        assert a.status_code == g.status_code == 404 and a.get_json() == g.get_json()
    assert ast.w.row(alien).deleted_at is None


def test_404_uniforme_em_movimentacoes_e_vinculos_alheios(mv):  # noqa: F811
    asset_b = mv.w.asset(mv.b, "B-ONLY")
    asset_a = mv.w.asset(mv.a, "A-ONLY")
    ghost = uuid.uuid4()
    # bem alheio x inexistente na SOLICITAÇÃO
    alien = tm.request(mv, tm.USER_A, asset_b, mv.a)
    none = tm.request(mv, tm.USER_A, ghost, mv.a)
    assert alien.status_code == none.status_code == 404 and alien.get_json() == none.get_json()
    # destino alheio x inexistente
    alien_dest = tm.request(mv, tm.USER_A, asset_a, mv.b)
    ghost_dest = tm.request(mv, tm.USER_A, asset_a, ghost)
    assert alien_dest.status_code == ghost_dest.status_code == 404
    assert alien_dest.get_json() == ghost_dest.get_json()
    assert mv.w.movements() == []
    # leitura/ação por id: mesma resposta para movimentação de que não participo
    created = tm.request(mv, tm.USER_B, asset_b, mv.b, destination_room_id=None)
    assert created.status_code in (201, 409)
    for action in ("", "/cancel", "/approve", "/reject"):
        if action in ("/approve", "/reject"):
            who, body = tm.ADM_A, ({"asset_version": 1} if action == "/approve" else {})
        else:
            who, body = tm.USER_A, {}
        method = "get" if action == "" else "post"
        kwargs = {"headers": tm.h(who)}
        if method == "post":
            kwargs["json"] = body
        mid = created.get_json()["id"] if created.status_code == 201 else str(ghost)
        r1 = getattr(mv.client, method)(f"/api/v1/movements/{mid}{action}", **kwargs)
        r2 = getattr(mv.client, method)(f"/api/v1/movements/{ghost}{action}", **kwargs)
        assert r1.status_code == r2.status_code == 404 and r1.get_json() == r2.get_json(), action


# ---------------------------------------------------------------------------
# Limites de tamanho (extra="forbid" + max_length) e corpo gigante
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field,size", [
    ("patrimony_number", 65), ("description", 2001), ("notes", 2001), ("unit_id", 65),
    ("room_id", 65), ("owner_unit_id", 65),
])
def test_patrimonio_campos_acima_do_limite_sao_400(ast, field, size):  # noqa: F811
    body = {"unit_id": str(ast.a), "patrimony_number": "LIM-1"}
    body[field] = "x" * size
    r = ast.client.post("/api/v1/assets", json=body, headers=ta.h(ta.ADM))
    assert r.status_code == 400
    assert not ast.w.audits()


@pytest.mark.parametrize("field,size", [("reason", 501)])
def test_movimentacao_e_exclusao_acima_do_limite_sao_400(mv, field, size):  # noqa: F811
    asset_id = mv.w.asset(mv.a, "LIM-M")
    r = tm.request(mv, tm.USER_AB, asset_id, mv.b, **{field: "x" * size})
    assert r.status_code == 400
    assert mv.w.movements() == []


@pytest.mark.parametrize("field,value", [
    ("name", "n" * 201), ("email", "a" * 250 + "@exemplo.invalid"), ("phone", "9" * 41),
    ("institutional_identifier", "i" * 65), ("email", "sem-arroba"), ("phone", "12"),
])
def test_pessoa_campos_invalidos_ou_acima_do_limite_sao_400(cat, field, value):  # noqa: F811
    body = {"unit_id": str(cat.a), "name": "Maria"}
    body[field] = value
    r = cat.client.post("/api/v1/responsible-people", json=body, headers=tc.adm())
    assert r.status_code == 400
    assert cat.w.all_audits("responsible_person") == []


@pytest.mark.parametrize("query", [
    "page_size=101", "page=0", "page=100001", "q=" + "x" * 101, "sort=password", "unit_id=nao-e-uuid",
    "active=talvez", "extra=1", "page=1&page=2",
])
def test_listas_de_cadastro_rejeitam_consulta_fora_da_allowlist(cat, query):  # noqa: F811
    for url in ("/api/v1/rooms", "/api/v1/responsible-people", "/api/v1/units/catalog"):
        r = cat.client.get(f"{url}?{query}", headers=tc.adm())
        assert r.status_code == 400, (url, query, r.status_code)


def test_corpo_acima_do_limite_global_e_413_sem_efeito(cat):  # noqa: F811
    big = b'{"unit_id": "%s", "name": "%s"}' % (str(cat.a).encode(), b"A" * (2 * 1024 * 1024))
    r = _post_raw(cat.client, "/api/v1/rooms", big, tc.adm())
    assert r.status_code == 413
    assert cat.w.all_audits("room") == []


# ---------------------------------------------------------------------------
# PII: telefone só ADM, e-mail nunca em logs/auditoria; RH não busca por telefone
# ---------------------------------------------------------------------------


def test_rh_nao_localiza_pessoa_por_telefone_nem_ve_o_campo(cat):  # noqa: F811
    cat.w.person(cat.a, "Maria Souza", email="maria@exemplo.invalid", phone="63999990000")
    for sub in ("auth-rh-a", "auth-user-a"):
        r = cat.client.get("/api/v1/responsible-people?q=63999990000", headers=tc.as_(sub))
        assert r.status_code == 200 and r.get_json()["total"] == 0
    full = cat.client.get("/api/v1/responsible-people", headers=tc.as_("auth-rh-a"))
    assert "63999990000" not in full.get_data(as_text=True) and "phone" not in full.get_data(as_text=True)


def test_logs_e_auditoria_das_mutacoes_de_pessoa_nao_contem_dados_pessoais(cat, caplog):  # noqa: F811
    caplog.set_level(logging.DEBUG)
    email, phone, ident = "ana.paula@exemplo.invalid", "63988887777", "MAT-4455667"
    created = cat.client.post(
        "/api/v1/responsible-people",
        json={"unit_id": str(cat.a), "name": "Ana Paula", "email": email, "phone": phone,
              "institutional_identifier": ident},
        headers=tc.adm(),
    )
    assert created.status_code == 201
    pid = created.get_json()["id"]
    cat.client.patch(f"/api/v1/responsible-people/{pid}", json={"email": "outro@exemplo.invalid",
                                                                "phone": "63977776666"}, headers=tc.adm())
    # conflito e mass assignment também passam por log/evento
    cat.client.post("/api/v1/responsible-people",
                    json={"unit_id": str(cat.a), "name": "Dup", "email": "outro@exemplo.invalid"},
                    headers=tc.adm())
    blob = " ".join(r.getMessage() for r in caplog.records)
    blob += json.dumps(cat.events, default=str)
    for row in cat.w.all_audits("responsible_person"):
        blob += json.dumps([row.previous_values, row.new_values], default=str)
    for secret in (email, phone, ident, "outro@exemplo.invalid", "63977776666"):
        assert secret.lower() not in blob.lower(), secret


# ---------------------------------------------------------------------------
# Unicidade global: o 409 não diz QUAL campo nem de QUAL unidade (resíduo documentado)
# ---------------------------------------------------------------------------


def test_conflito_de_numero_patrimonial_de_outra_unidade_e_generico(ast):  # noqa: F811
    ast.w.asset(ast.b, "UNICO-1")
    r = ast.client.post("/api/v1/assets", json={"unit_id": str(ast.a), "patrimony_number": " unico-1 "},
                        headers=ta.h(ta.USER_A))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "conflict"
    text = r.get_data(as_text=True).lower()
    assert str(ast.b) not in text and "patrimony" not in text and "unidade b" not in text


# ---------------------------------------------------------------------------
# SEC-REV-04 (Info) -- projeção da trilha admin aceita valores com formato de CPF/telefone
# ---------------------------------------------------------------------------


@pytest.mark.xfail(strict=True, reason="SEC-REV-04 aberto (defesa em profundidade): safe_scalar deixa passar CPF")
@pytest.mark.parametrize("value", ["123.456.789-09", "12345678909"])
def test_projecao_da_trilha_admin_redige_valor_com_formato_de_cpf(value):
    from app.services.admin_audit_service import REDACTED, safe_scalar

    assert safe_scalar(value) == REDACTED


# ---------------------------------------------------------------------------
# Estabilidade de test_catalog_api::test_sala_criacao_valida_corpo (500 intermitente relatado)
# ---------------------------------------------------------------------------

_CORPOS_SALA = [
    {"unit_id": "x", "name": "A", "source_record_id": "1"},
    {"unit_id": "x", "name": "A", "active": False},
    {"unit_id": "x"}, {"name": "A"}, {"unit_id": "x", "name": " "}, {"unit_id": "x", "name": "a\x00b"},
    {"unit_id": "x", "name": "n" * 201}, {},
]


def test_criacao_de_sala_invalida_e_sempre_400_sob_repeticao(cat):  # noqa: F811
    """Mesmos corpos do teste instável, 14x no MESMO app/DB (14*8=112 < WRITE_LIMIT=120/h):
    qualquer 500 passa a mostrar o corpo da resposta."""
    for round_ in range(14):
        for index, body in enumerate(_CORPOS_SALA):
            r = cat.client.post("/api/v1/rooms", json=body, headers=tc.adm())
            assert r.status_code == 400, (round_, index, r.status_code, r.get_data(as_text=True))
    assert cat.w.all_audits("room") == []
