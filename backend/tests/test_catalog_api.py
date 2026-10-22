"""CRUD de salas, pessoas responsáveis e dados cadastrais de unidades (ponta a ponta).

Banco SQLite com o schema real dos modelos + carregador REAL de `require_auth`
(papéis/permissões lidos do banco), Redis falso, sem rede. A matriz de 401 e
de perfil/AAL2/permissão das rotas está em `test_sec_route_inventory.py`;
aqui: caminho feliz, escopo/IDOR, mass assignment, `phone` oculto para
não-ADM, unicidade (409), inativação, concorrência e auditoria sem dados pessoais.
"""
from __future__ import annotations

import json
import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine, event, select, text
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import DefaultClause

import app.models  # noqa: F401
from app import create_app
from app.database.session import Base
from app.models.people import ResponsiblePerson
from app.models.rbac import Permission, Role, RolePermission
from app.models.units import Room, Unit, UserUnitAccess
from test_user_admin_db import FakeRedis, World, auth_headers

ADM_SUB = "auth-adm-cat"
TABLES = (
    "users", "roles", "permissions", "role_permissions", "user_roles", "units",
    "user_unit_access", "audit_logs", "rooms", "responsible_people", "locations", "assets",
)
ADM_PERMS = (
    "units.read", "units.update", "rooms.manage", "responsible.read", "responsible.manage",
    "users.manage",
)
READ_PERMS = ("units.read", "responsible.read")


def _build_engine():
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}, future=True
    )
    metadata = MetaData()
    for name in TABLES:
        table = Base.metadata.tables[name].to_metadata(metadata)
        for constraint in list(table.constraints):
            if isinstance(constraint, CheckConstraint):
                table.constraints.discard(constraint)
        for column in table.columns:
            default = column.server_default
            if default is None:
                continue
            arg = str(getattr(default, "arg", "")).strip().lower()
            if "gen_random_uuid" in arg:
                column.server_default = None
            elif "now()" in arg:
                column.server_default = DefaultClause(text("CURRENT_TIMESTAMP"))
            elif arg == "true":
                column.server_default = DefaultClause(text("1"))
            elif arg == "false":
                column.server_default = DefaultClause(text("0"))
    metadata.create_all(engine)
    return engine


class CatWorld(World):
    def __init__(self, engine) -> None:
        self.engine = engine
        self.roles = {}
        with self.session() as db:
            for code in ("ADM", "USER", "RH"):
                role = Role(id=uuid.uuid4(), code=code, name=code, active=True)
                db.add(role)
                self.roles[code] = role.id
            for perm in ADM_PERMS:
                permission = Permission(id=uuid.uuid4(), code=perm, resource=perm.split(".")[0], action=perm)
                db.add(permission)
                db.add(RolePermission(id=uuid.uuid4(), role_id=self.roles["ADM"], permission_id=permission.id))
                if perm in READ_PERMS:
                    for code in ("USER", "RH"):
                        db.add(RolePermission(id=uuid.uuid4(), role_id=self.roles[code], permission_id=permission.id))

    def room(self, unit_id, name, *, active=True) -> uuid.UUID:
        room_id = uuid.uuid4()
        with self.session() as db:
            db.add(Room(id=room_id, unit_id=unit_id, name=name, active=active))
        return room_id

    def person(self, unit_id, name, *, email=None, phone=None, identifier=None, active=True) -> uuid.UUID:
        person_id = uuid.uuid4()
        with self.session() as db:
            db.add(ResponsiblePerson(
                id=person_id, unit_id=unit_id, name=name, email=email, phone=phone,
                institutional_identifier=identifier, active=active,
            ))
        return person_id

    def asset(self, unit_id, person_id, *, number="1", deleted=False) -> uuid.UUID:
        """Bem (vínculo de pessoa responsável); `deleted` = exclusão lógica."""
        from datetime import datetime, timezone

        from app.models.assets import Asset

        asset_id = uuid.uuid4()
        with self.session() as db:
            db.add(Asset(
                id=asset_id, patrimony_number=number, unit_id=unit_id, responsible_person_id=person_id,
                version=1, deleted_at=datetime.now(timezone.utc) if deleted else None,
                deleted_by=None,
            ))
        return asset_id

    def row(self, model, entity_id):
        with self.session() as db:
            return db.get(model, entity_id)

    def all_audits(self, entity_type: str):
        from app.models.audit import AuditLog

        with self.session() as db:
            return list(db.execute(select(AuditLog).where(AuditLog.entity_type == entity_type)).scalars())


@pytest.fixture()
def cat():
    world = CatWorld(_build_engine())
    events: list[dict[str, Any]] = []
    queries: list[str] = []

    @event.listens_for(world.engine, "before_cursor_execute")
    def _count(_conn, _cursor, statement, *_a):  # pragma: no cover
        queries.append(statement)

    with ExitStack() as stack:
        for target in (
            "app.api.v1.rooms.get_db_session",
            "app.api.v1.responsible_people.get_db_session",
            "app.api.v1.units.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(patch("app.authorization.security_events._dispatch", side_effect=events.append))
        a, b = world.unit("A"), world.unit("B")
        ns = SimpleNamespace(
            client=create_app().test_client(), w=world, events=events, queries=queries, a=a, b=b,
            adm=world.user("Adm", role="ADM", units=[a], auth_user_id=ADM_SUB),
            user_a=world.user("User A", role="USER", units=[a], auth_user_id="auth-user-a"),
            rh_a=world.user("Rh A", role="RH", units=[a], auth_user_id="auth-rh-a"),
            user_b=world.user("User B", role="USER", units=[b], auth_user_id="auth-user-b"),
        )
        yield ns
    event.remove(world.engine, "before_cursor_execute", _count)


def adm(**kw):
    return auth_headers(ADM_SUB, **kw)


def as_(sub, **kw):
    return auth_headers(sub, **kw)


def types(cat, name):
    return [e for e in cat.events if e["event_type"] == name]


# ---------------------------------------------------------------------------
# Salas
# ---------------------------------------------------------------------------


def test_sala_crud_feliz_com_normalizacao_e_auditoria(cat):
    c = cat.client
    created = c.post("/api/v1/rooms", json={"unit_id": str(cat.a), "name": "  Sala   03 ", "floor": " 1º "},
                     headers=adm())
    assert created.status_code == 201, created.get_json()
    room = created.get_json()
    assert room["name"] == "Sala 03" and room["floor"] == "1º" and room["active"] is True
    assert room["source_record_id"] is None
    room_id = room["id"]

    assert c.get(f"/api/v1/rooms/{room_id}", headers=adm()).get_json()["name"] == "Sala 03"
    listing = c.get("/api/v1/rooms?q=sala&sort=-name&page_size=10", headers=adm()).get_json()
    assert listing["total"] == 1 and listing["rooms"][0]["id"] == room_id

    patched = c.patch(f"/api/v1/rooms/{room_id}", json={"name": "Sala 03 - ANM", "floor": None}, headers=adm())
    assert patched.status_code == 200
    assert patched.get_json()["name"] == "Sala 03 - ANM" and patched.get_json()["floor"] is None

    off = c.post(f"/api/v1/rooms/{room_id}/deactivate", headers=adm())
    assert off.status_code == 200 and off.get_json()["active"] is False
    again = c.post(f"/api/v1/rooms/{room_id}/deactivate", json={"reason": "duplicada"}, headers=adm())
    assert again.status_code == 200  # idempotente, sem nova auditoria
    on = c.post(f"/api/v1/rooms/{room_id}/activate", headers=adm())
    assert on.get_json()["active"] is True

    ops = [r.operation for r in cat.w.all_audits("room")]
    assert ops == ["ROOM_CREATED", "ROOM_UPDATED", "ROOM_DEACTIVATED", "ROOM_ACTIVATED"]
    # Nunca físico: a linha segue existindo após inativar/reativar.
    assert cat.w.row(Room, uuid.UUID(room_id)) is not None


def test_sala_sem_alteracao_nao_gera_auditoria(cat):
    rid = cat.w.room(cat.a, "Sala 1")
    r = cat.client.patch(f"/api/v1/rooms/{rid}", json={"name": "Sala 1"}, headers=adm())
    assert r.status_code == 200 and cat.w.all_audits("room") == []


def test_listagem_de_salas_filtra_ativas_e_pagina(cat):
    for i in range(5):
        cat.w.room(cat.a, f"Sala {i}", active=i % 2 == 0)
    r = cat.client.get("/api/v1/rooms?active=true&page=2&page_size=2&sort=name", headers=adm()).get_json()
    assert r["total"] == 3 and r["page"] == 2 and [x["name"] for x in r["rooms"]] == ["Sala 4"]


@pytest.mark.parametrize(
    "query", ["foo=1", "sort=phone", "sort=name;drop", "page=0", "page_size=101", "active=sim",
              "unit_id=x", "q=" + "x" * 101, "page=1&page=2"],
)
def test_listagem_de_salas_rejeita_fora_da_allowlist(cat, query):
    r = cat.client.get(f"/api/v1/rooms?{query}", headers=adm())
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def test_sala_unicidade_por_unidade_sem_vazar_detalhe(cat):
    cat.w.room(cat.a, "Sala 7")
    r = cat.client.post("/api/v1/rooms", json={"unit_id": str(cat.a), "name": "  sala   7"}, headers=adm())
    assert r.status_code == 409
    assert r.get_json() == {"error": {"code": "conflict", "message": "Já existe um registro com estes dados."}}
    other = cat.w.room(cat.a, "Sala 8")
    r2 = cat.client.patch(f"/api/v1/rooms/{other}", json={"name": "SALA 7"}, headers=adm())
    assert r2.status_code == 409 and r2.get_json()["error"]["code"] == "conflict"


def test_sala_violacao_do_indice_unico_do_banco_vira_409_generico(cat):
    cat.w.room(cat.a, "Sala 9")
    with patch("app.services.catalog_service.RoomService._name_taken", return_value=False):
        r = cat.client.post("/api/v1/rooms", json={"unit_id": str(cat.a), "name": "Sala 9"}, headers=adm())
    assert r.status_code == 409
    body = r.get_data(as_text=True).lower()
    assert "unique" not in body and "sqlite" not in body and "rooms" not in body
    assert cat.w.all_audits("room") == []


def test_sala_em_unidade_alheia_inexistente_ou_malformada_tem_mesma_resposta(cat):
    results = []
    for unit in (str(cat.b), str(uuid.uuid4()), "nao-e-uuid", ""[:0] or "x"):
        r = cat.client.post("/api/v1/rooms", json={"unit_id": unit, "name": "Sala X"}, headers=adm())
        results.append((r.status_code, r.get_json()))
    assert all(res == results[0] for res in results)
    assert results[0] == (404, {"error": {"code": "not_found", "message": "Recurso não encontrado."}})
    assert str(cat.b) not in json.dumps(results)
    with cat.w.session() as db:
        assert db.execute(select(Room)).first() is None
    assert len(types(cat, "UNIT_SCOPE_DENIED")) == 4


def test_sala_em_unidade_inativa_bloqueia_criacao_e_reativacao(cat):
    rid = cat.w.room(cat.a, "Sala 1", active=False)
    assert cat.client.post(f"/api/v1/units/{cat.a}/deactivate", headers=adm()).status_code == 200
    r = cat.client.post("/api/v1/rooms", json={"unit_id": str(cat.a), "name": "Nova"}, headers=adm())
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "unit_inactive"
    r = cat.client.post(f"/api/v1/rooms/{rid}/activate", headers=adm())
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "unit_inactive"


@pytest.mark.parametrize("method,suffix,body", [
    ("GET", "", None), ("PATCH", "", {"name": "Novo"}), ("POST", "/deactivate", None),
    ("POST", "/activate", None),
])
def test_sala_alheia_inexistente_e_malformada_tem_resposta_identica(cat, method, suffix, body):
    alien = cat.w.room(cat.b, "Sala B")
    out, counts = {}, {}
    for label, target in (("alheia", alien), ("inexistente", uuid.uuid4()), ("malformada", "nao-uuid")):
        start = len(cat.queries)
        kwargs = {"headers": adm()}
        if body is not None:
            kwargs["json"] = body
        r = cat.client.open(f"/api/v1/rooms/{target}{suffix}", method=method, **kwargs)
        out[label] = (r.status_code, r.get_json())
        counts[label] = len(cat.queries) - start
    assert out["alheia"] == out["inexistente"] == out["malformada"]
    assert out["alheia"][0] == 404
    assert str(alien) not in json.dumps(out)
    assert counts["alheia"] == counts["inexistente"]
    assert cat.w.row(Room, alien).name == "Sala B" and cat.w.row(Room, alien).active is True


@pytest.mark.parametrize("field,value", [
    ("unit_id", None), ("id", str(uuid.uuid4())), ("source_record_id", "9"), ("active", False),
    ("created_at", "2020-01-01T00:00:00Z"), ("deleted_at", None), ("code", "X"),
])
def test_sala_mass_assignment_rejeitado_e_auditado(cat, field, value):
    rid = cat.w.room(cat.a, "Sala 1")
    if field == "unit_id":
        value = str(cat.a)
    r = cat.client.patch(f"/api/v1/rooms/{rid}", json={"name": "Outro", field: value}, headers=adm())
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert cat.w.row(Room, rid).name == "Sala 1"
    assert any(field in e["details"].get("fields", []) for e in cat.events
               if e["event_type"] in ("PRIVILEGE_ESCALATION_ATTEMPT", "MASS_ASSIGNMENT_REJECTED"))


@pytest.mark.parametrize("body", [
    {"unit_id": "x", "name": "A", "source_record_id": "1"},
    {"unit_id": "x", "name": "A", "active": False},
    {"unit_id": "x"}, {"name": "A"}, {"unit_id": "x", "name": " "}, {"unit_id": "x", "name": "a\x00b"},
    {"unit_id": "x", "name": "n" * 201}, {},
])
def test_sala_criacao_valida_corpo(cat, body):
    r = cat.client.post("/api/v1/rooms", json=body, headers=adm())
    assert r.status_code == 400


def test_sala_patch_exige_campo_e_nome_nao_nulo(cat):
    rid = cat.w.room(cat.a, "Sala 1")
    for body in ({}, {"name": None}, {"name": "  "}, {"expected_updated_at": "2026-01-01T00:00:00Z"}):
        assert cat.client.patch(f"/api/v1/rooms/{rid}", json=body, headers=adm()).status_code == 400


def test_sala_concorrencia_otimista_via_expected_updated_at(cat):
    rid = cat.w.room(cat.a, "Sala 1")
    current = cat.client.get(f"/api/v1/rooms/{rid}", headers=adm()).get_json()["updated_at"]
    stale = cat.client.patch(
        f"/api/v1/rooms/{rid}", json={"name": "B", "expected_updated_at": "2001-01-01T00:00:00Z"}, headers=adm()
    )
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"
    assert cat.w.row(Room, rid).name == "Sala 1"
    ok = cat.client.patch(f"/api/v1/rooms/{rid}", json={"name": "B", "expected_updated_at": current}, headers=adm())
    assert ok.status_code == 200 and ok.get_json()["name"] == "B"


def test_perfis_e_sessao_nas_rotas_de_sala(cat):
    rid = cat.w.room(cat.a, "Sala 1")
    for sub in ("auth-user-a", "auth-rh-a"):
        assert cat.client.post("/api/v1/rooms", json={"unit_id": str(cat.a), "name": "Z"},
                               headers=as_(sub)).status_code == 403
        assert cat.client.patch(f"/api/v1/rooms/{rid}", json={"name": "Z"}, headers=as_(sub)).status_code == 403
        assert cat.client.post(f"/api/v1/rooms/{rid}/deactivate", headers=as_(sub)).status_code == 403
    r = cat.client.post("/api/v1/rooms", json={"unit_id": str(cat.a), "name": "Z"}, headers=adm(aal="aal1"))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"
    r = cat.client.get("/api/v1/rooms", headers=adm(aal="aal1"))  # ADM também precisa de AAL2 na leitura
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert cat.w.row(Room, rid).name == "Sala 1"


def test_user_e_rh_leem_salas_so_da_propria_unidade_sem_aal2(cat):
    cat.w.room(cat.a, "Sala A")
    rb = cat.w.room(cat.b, "Sala B")
    for sub in ("auth-user-a", "auth-rh-a"):
        listing = cat.client.get("/api/v1/rooms", headers=as_(sub, aal="aal1")).get_json()
        assert [r["name"] for r in listing["rooms"]] == ["Sala A"]
        assert cat.client.get(f"/api/v1/rooms/{rb}", headers=as_(sub, aal="aal1")).status_code == 404
    other = cat.client.get("/api/v1/rooms", headers=as_("auth-user-b", aal="aal1")).get_json()
    assert [r["name"] for r in other["rooms"]] == ["Sala B"]


def test_adm_nao_enxerga_nem_cria_sala_fora_do_proprio_escopo(cat):
    rb = cat.w.room(cat.b, "Sala B")
    assert cat.client.get("/api/v1/rooms", headers=adm()).get_json()["total"] == 0
    assert cat.client.get(f"/api/v1/rooms/{rb}", headers=adm()).status_code == 404
    assert cat.client.get(f"/api/v1/rooms?unit_id={cat.b}", headers=adm()).get_json()["total"] == 0


# ---------------------------------------------------------------------------
# Pessoas responsáveis
# ---------------------------------------------------------------------------


def _person_body(cat, **extra):
    body = {"unit_id": str(cat.a), "name": "  Maria   da  Silva ", "email": " Maria.Silva@AGU.gov.br ",
            "phone": "(63) 99999-1234", "institutional_identifier": "SIAPE-1"}
    body.update(extra)
    return body


def test_pessoa_crud_feliz_adm_ve_telefone(cat):
    c = cat.client
    r = c.post("/api/v1/responsible-people", json=_person_body(cat), headers=adm())
    assert r.status_code == 201, r.get_json()
    p = r.get_json()
    assert p["name"] == "Maria da Silva" and p["email"] == "maria.silva@agu.gov.br"
    assert p["phone"] == "63999991234" and p["active"] is True and p["source_record_id"] is None
    pid = p["id"]
    got = c.get(f"/api/v1/responsible-people/{pid}", headers=adm()).get_json()
    assert got["phone"] == "63999991234"
    listing = c.get("/api/v1/responsible-people?q=maria&sort=-email", headers=adm()).get_json()
    assert listing["total"] == 1 and listing["people"][0]["phone"] == "63999991234"

    upd = c.patch(f"/api/v1/responsible-people/{pid}",
                  json={"phone": "+55 63 98888-7777", "email": None, "name": "Maria S."}, headers=adm())
    assert upd.status_code == 200
    assert upd.get_json()["phone"] == "5563988887777" and upd.get_json()["email"] is None
    assert c.post(f"/api/v1/responsible-people/{pid}/deactivate", json={"reason": "saiu"},
                  headers=adm()).get_json()["active"] is False
    assert c.post(f"/api/v1/responsible-people/{pid}/activate", headers=adm()).get_json()["active"] is True
    ops = [r.operation for r in cat.w.all_audits("responsible_person")]
    assert ops == ["RESPONSIBLE_PERSON_CREATED", "RESPONSIBLE_PERSON_UPDATED",
                   "RESPONSIBLE_PERSON_DEACTIVATED", "RESPONSIBLE_PERSON_ACTIVATED"]


def test_auditoria_de_pessoa_nao_guarda_email_telefone_nem_identificador(cat):
    r = cat.client.post("/api/v1/responsible-people", json=_person_body(cat), headers=adm())
    pid = r.get_json()["id"]
    cat.client.patch(f"/api/v1/responsible-people/{pid}",
                     json={"phone": "63911112222", "email": "novo@agu.gov.br"}, headers=adm())
    dump = json.dumps([[a.previous_values, a.new_values] for a in cat.w.all_audits("responsible_person")])
    for secret in ("99999", "11112222", "maria.silva", "novo@agu", "SIAPE-1"):
        assert secret not in dump
    assert "changed_fields" in dump


def test_telefone_oculto_para_user_e_rh_na_resposta_e_nem_e_consultado(cat):
    pid = cat.w.person(cat.a, "Joao", email="j@agu.gov.br", phone="63911112222")
    cat.w.asset(cat.a, pid)  # USER só enxerga pessoa vinculada a bem do escopo
    for sub in ("auth-user-a", "auth-rh-a"):
        start = len(cat.queries)
        one = cat.client.get(f"/api/v1/responsible-people/{pid}", headers=as_(sub, aal="aal1"))
        lst = cat.client.get("/api/v1/responsible-people", headers=as_(sub, aal="aal1"))
        assert one.status_code == 200 and lst.status_code == 200
        assert "phone" not in one.get_json() and "phone" not in lst.get_json()["people"][0]
        assert "63911112222" not in one.get_data(as_text=True) + lst.get_data(as_text=True)
        selects = [q for q in cat.queries[start:] if "FROM responsible_people" in q]
        assert selects and all("responsible_people.phone" not in q for q in selects), [q for q in selects if "responsible_people.phone" in q]


def test_user_rh_leem_pessoas_so_da_propria_unidade_e_nao_escrevem(cat):
    pa = cat.w.person(cat.a, "Pessoa A")
    cat.w.asset(cat.a, pa)
    pb = cat.w.person(cat.b, "Pessoa B")
    cat.w.asset(cat.b, pb)
    for sub in ("auth-user-a", "auth-rh-a"):
        names = [p["name"] for p in cat.client.get("/api/v1/responsible-people",
                                                   headers=as_(sub, aal="aal1")).get_json()["people"]]
        assert names == ["Pessoa A"]
        assert cat.client.get(f"/api/v1/responsible-people/{pb}", headers=as_(sub, aal="aal1")).status_code == 404
        assert cat.client.post("/api/v1/responsible-people", json=_person_body(cat), headers=as_(sub)).status_code == 403
        assert cat.client.patch(f"/api/v1/responsible-people/{pb}", json={"name": "X"},
                                headers=as_(sub)).status_code == 403
    r = cat.client.get("/api/v1/responsible-people", headers=adm(aal="aal1"))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"


def test_nao_adm_nao_grava_telefone_service_levanta_e_borda_audita(cat):
    from app.api.v1.catalog_http import catalog_error_response
    from app.api.v1.catalog_schemas import PersonCreateRequest
    from app.services.catalog_service import PhoneForbiddenError, ResponsiblePersonService

    body = PersonCreateRequest(unit_id=str(cat.a), name="Fulano", phone="63911112222")
    with cat.w.session() as db:
        service = ResponsiblePersonService(db, is_adm=False)
        with pytest.raises(PhoneForbiddenError):
            service.create(cat.user_a, body)
    assert cat.w.row(Room, uuid.uuid4()) is None
    with create_app().test_request_context("/"):
        response = catalog_error_response(
            PhoneForbiddenError(), actor_id=cat.user_a, target_type="unit", target_id=None,
            context="responsible_people.create",
        )
    assert response.status_code == 400
    assert any(e["details"].get("fields") == ["phone"] for e in cat.events)


@pytest.mark.parametrize("phone", ["123", "abcdefghijk", "6399999123456789", "63 9999-12a4", "+++"])
def test_telefone_invalido_rejeitado(cat, phone):
    r = cat.client.post("/api/v1/responsible-people", json=_person_body(cat, phone=phone), headers=adm())
    assert r.status_code == 400


@pytest.mark.parametrize("email", ["sem-arroba", "a@b", "a b@agu.gov.br", "x" * 250 + "@agu.gov.br"])
def test_email_invalido_rejeitado(cat, email):
    r = cat.client.post("/api/v1/responsible-people", json=_person_body(cat, email=email), headers=adm())
    assert r.status_code == 400


def test_pessoa_unicidade_de_email_e_identificador_409(cat):
    cat.w.person(cat.a, "Existente", email="dup@agu.gov.br", identifier="ID-1")
    r = cat.client.post("/api/v1/responsible-people",
                        json=_person_body(cat, email="DUP@agu.gov.br", institutional_identifier=None), headers=adm())
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "conflict"
    r = cat.client.post("/api/v1/responsible-people",
                        json=_person_body(cat, email="outro@agu.gov.br", institutional_identifier="ID-1"), headers=adm())
    assert r.status_code == 409
    other = cat.w.person(cat.a, "Outro", email="o@agu.gov.br")
    r = cat.client.patch(f"/api/v1/responsible-people/{other}", json={"email": "Dup@agu.gov.br"}, headers=adm())
    assert r.status_code == 409
    assert cat.w.row(ResponsiblePerson, other).email == "o@agu.gov.br"
    assert "dup@" not in r.get_data(as_text=True).lower()


def test_pessoa_sem_email_pode_repetir_nulo(cat):
    for name in ("Um", "Dois"):
        r = cat.client.post("/api/v1/responsible-people",
                            json={"unit_id": str(cat.a), "name": name}, headers=adm())
        assert r.status_code == 201 and r.get_json()["email"] is None


@pytest.mark.parametrize("method,suffix,body", [
    ("GET", "", None), ("PATCH", "", {"name": "Novo"}), ("POST", "/deactivate", None), ("POST", "/activate", None),
])
def test_pessoa_alheia_inexistente_e_malformada_tem_resposta_identica(cat, method, suffix, body):
    alien = cat.w.person(cat.b, "Pessoa B", phone="63911112222")
    out, counts = {}, {}
    for label, target in (("alheia", alien), ("inexistente", uuid.uuid4()), ("malformada", "x")):
        start = len(cat.queries)
        kwargs = {"headers": adm()}
        if body is not None:
            kwargs["json"] = body
        r = cat.client.open(f"/api/v1/responsible-people/{target}{suffix}", method=method, **kwargs)
        out[label] = (r.status_code, r.get_json())
        counts[label] = len(cat.queries) - start
    assert out["alheia"] == out["inexistente"] == out["malformada"] and out["alheia"][0] == 404
    assert counts["alheia"] == counts["inexistente"]
    assert cat.w.row(ResponsiblePerson, alien).name == "Pessoa B"


def test_pessoa_em_unidade_alheia_no_corpo_tem_404_igual(cat):
    r1 = cat.client.post("/api/v1/responsible-people", json=_person_body(cat, unit_id=str(cat.b)), headers=adm())
    r2 = cat.client.post("/api/v1/responsible-people", json=_person_body(cat, unit_id="lixo"), headers=adm())
    assert r1.status_code == r2.status_code == 404 and r1.get_json() == r2.get_json()


@pytest.mark.parametrize("field,value", [
    ("unit_id", "x"), ("active", False), ("id", "x"), ("source_record_id", "7"),
    ("created_at", "x"), ("deleted_at", "x"),
])
def test_pessoa_mass_assignment_rejeitado(cat, field, value):
    pid = cat.w.person(cat.a, "Pessoa")
    r = cat.client.patch(f"/api/v1/responsible-people/{pid}", json={"name": "Z", field: value}, headers=adm())
    assert r.status_code == 400
    assert cat.w.row(ResponsiblePerson, pid).name == "Pessoa"
    r = cat.client.post("/api/v1/responsible-people", json=_person_body(cat, **{field: value}) if field != "unit_id"
                        else {**_person_body(cat), "extra": 1}, headers=adm())
    assert r.status_code == 400


def test_pessoa_inativar_em_uso_e_permitido_e_nao_apaga(cat):
    pid = cat.w.person(cat.a, "Em Uso")
    r = cat.client.post(f"/api/v1/responsible-people/{pid}/deactivate", headers=adm())
    assert r.status_code == 200 and cat.w.row(ResponsiblePerson, pid).active is False
    inactive = cat.client.get("/api/v1/responsible-people?active=false", headers=adm()).get_json()
    assert inactive["total"] == 1
    assert cat.client.get("/api/v1/responsible-people?active=true", headers=adm()).get_json()["total"] == 0


def test_nao_existe_delete_fisico(cat):
    rid = cat.w.room(cat.a, "Sala")
    pid = cat.w.person(cat.a, "Pessoa")
    for url in (f"/api/v1/rooms/{rid}", f"/api/v1/responsible-people/{pid}", f"/api/v1/units/{cat.a}"):
        assert cat.client.delete(url, headers=adm()).status_code == 405


# ---------------------------------------------------------------------------
# Unidades
# ---------------------------------------------------------------------------


def test_unidade_edicao_feliz_e_endereco_so_para_adm(cat):
    c = cat.client
    r = c.patch(f"/api/v1/units/{cat.a}",
                json={"name": "  Unidade   Estadual ", "address": "Quadra 1", "description": None}, headers=adm())
    assert r.status_code == 200
    body = r.get_json()
    assert body["name"] == "Unidade Estadual" and body["address"] == "Quadra 1" and body["code"] == "A"
    assert c.get(f"/api/v1/units/{cat.a}", headers=adm()).get_json()["address"] == "Quadra 1"
    user_view = c.get(f"/api/v1/units/{cat.a}", headers=as_("auth-user-a", aal="aal1"))
    assert user_view.status_code == 200 and "address" not in user_view.get_json()
    assert [a.operation for a in cat.w.all_audits("unit")] == ["UNIT_UPDATED"]
    off = c.post(f"/api/v1/units/{cat.a}/deactivate", headers=adm())
    assert off.get_json()["active"] is False
    assert c.post(f"/api/v1/units/{cat.a}/activate", headers=adm()).get_json()["active"] is True


@pytest.mark.parametrize("field,value", [
    ("code", "Z"), ("active", False), ("id", "x"), ("source_record_id", "1"), ("created_at", "x"),
])
def test_unidade_campos_privilegiados_rejeitados(cat, field, value):
    r = cat.client.patch(f"/api/v1/units/{cat.a}", json={"name": "Novo", field: value}, headers=adm())
    assert r.status_code == 400
    with cat.w.session() as db:
        unit = db.get(Unit, cat.a)
        assert unit.code == "A" and unit.name == "Unidade A" and unit.active is True


def test_unidade_alheia_inexistente_e_malformada_404_igual_e_perfis(cat):
    out = []
    for target in (cat.b, uuid.uuid4(), "lixo"):
        r = cat.client.patch(f"/api/v1/units/{target}", json={"name": "X"}, headers=adm())
        g = cat.client.get(f"/api/v1/units/{target}", headers=adm())
        out.append((r.status_code, r.get_json(), g.status_code, g.get_json()))
    assert out[0] == out[1] == out[2] and out[0][0] == 404
    for sub in ("auth-user-a", "auth-rh-a"):
        assert cat.client.patch(f"/api/v1/units/{cat.a}", json={"name": "X"}, headers=as_(sub)).status_code == 403
    r = cat.client.patch(f"/api/v1/units/{cat.a}", json={"name": "X"}, headers=adm(aal="aal1"))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"
    with cat.w.session() as db:
        assert db.get(Unit, cat.a).name == "Unidade A" and db.get(Unit, cat.b).name == "Unidade B"


def test_unidade_listagem_existente_continua_funcionando(cat):
    r = cat.client.get("/api/v1/units", headers=adm())
    assert r.status_code == 200 and [u["code"] for u in r.get_json()["units"]] == ["A"]


# ---------------------------------------------------------------------------
# GET /units/catalog (cadastro de unidades; GET /units segue intacto)
# ---------------------------------------------------------------------------

CATALOG_URL = "/api/v1/units/catalog"


def test_catalogo_de_unidades_inclui_inativas_e_endereco_so_adm(cat):
    c = cat.client
    c.patch(f"/api/v1/units/{cat.a}", json={"address": "Quadra 1"}, headers=adm())
    assert c.post(f"/api/v1/units/{cat.a}/deactivate", headers=adm()).status_code == 200
    r = c.get(CATALOG_URL, headers=adm())
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["total"] == 1 and body["page"] == 1 and body["page_size"] == 50
    unit = body["units"][0]
    assert set(unit) == {"id", "code", "name", "active", "updated_at", "source_record_id", "address"}
    assert unit["active"] is False and unit["address"] == "Quadra 1" and unit["id"] == str(cat.a)
    # O seletor antigo continua só com ativas.
    assert c.get("/api/v1/units", headers=adm()).get_json()["units"] == []


def test_catalogo_de_unidades_filtros_busca_ordenacao_e_paginacao(cat):
    for code, active in (("C", True), ("D", False), ("E", True)):
        uid = cat.w.unit(code, active=active)
        with cat.w.session() as db:
            db.add(UserUnitAccess(id=uuid.uuid4(), user_id=cat.adm, unit_id=uid))
    c = cat.client
    get = lambda q: c.get(f"{CATALOG_URL}?{q}", headers=adm()).get_json()  # noqa: E731
    assert get("")["total"] == 4
    assert get("active=true")["total"] == 3 and get("active=false")["total"] == 1
    assert get("active=all")["total"] == 4
    assert [u["code"] for u in get("sort=-code")["units"]] == ["E", "D", "C", "A"]
    assert [u["code"] for u in get("sort=code&page=2&page_size=3")["units"]] == ["E"]
    assert [u["code"] for u in get("q=unidade%20d")["units"]] == ["D"]
    assert get("q=%25")["total"] == 0  # curinga LIKE escapado


@pytest.mark.parametrize(
    "query", ["foo=1", "unit_id=x", "sort=address", "sort=name;drop", "page=0", "page_size=101",
              "active=sim", "q=" + "x" * 101, "page=1&page=2", "active=true&active=false"],
)
def test_catalogo_de_unidades_rejeita_fora_da_allowlist(cat, query):
    r = cat.client.get(f"{CATALOG_URL}?{query}", headers=adm())
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def test_catalogo_de_unidades_perfis_aal2_e_escopo(cat):
    c = cat.client
    assert c.get(CATALOG_URL).status_code == 401
    for sub in ("auth-user-a", "auth-rh-a", "auth-user-b"):
        assert c.get(CATALOG_URL, headers=as_(sub)).status_code == 403
    r = c.get(CATALOG_URL, headers=adm(aal="aal1"))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"
    # ADM só vê unidades do próprio escopo (B é alheia).
    assert [u["code"] for u in c.get(CATALOG_URL, headers=adm()).get_json()["units"]] == ["A"]


def test_regressao_contrato_de_get_units_nao_mudou(cat):
    c = cat.client
    r = c.get("/api/v1/units", headers=adm())
    assert r.status_code == 200 and list(r.get_json()) == ["units"]
    assert set(r.get_json()["units"][0]) == {"id", "code", "name"}
    bad = c.get("/api/v1/units?active=all", headers=adm())
    assert bad.status_code == 400
