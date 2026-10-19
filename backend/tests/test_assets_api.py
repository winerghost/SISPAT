"""API de patrimônios `/api/v1/assets` e `GET /api/v1/units/accessible` (ponta a ponta).

SQLite com o schema real dos modelos + carregador REAL de `require_auth`
(papéis/permissões lidos do banco), Redis falso, sem rede. A matriz de 401 e de
perfil/AAL2 das rotas administrativas está em `test_sec_route_inventory.py`;
aqui: escopo/IDOR, campos por perfil (RH sem `notes`), mass assignment,
concorrência, unicidade, exclusão lógica, histórico e `units/accessible`.
"""
from __future__ import annotations

import json
import uuid
from contextlib import ExitStack
from datetime import date
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
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.people import ResponsiblePerson
from app.models.rbac import Permission, Role, RolePermission
from app.models.units import Location, Room
from test_user_admin_db import FakeRedis, World, auth_headers

TABLES = (
    "users", "roles", "permissions", "role_permissions", "user_roles", "units",
    "user_unit_access", "audit_logs", "rooms", "responsible_people", "locations", "assets",
)
PERMS = {
    "ADM": ("assets.read", "assets.create", "assets.update", "assets.delete", "assets.export", "units.read"),
    "USER": ("assets.read", "assets.create", "assets.update", "assets.export", "units.read"),
    "RH": ("assets.read", "assets.export", "units.read"),
}
NOT_FOUND = {"error": {"code": "not_found", "message": "Recurso não encontrado."}}


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


class AssetWorld(World):
    def __init__(self, engine) -> None:
        self.engine = engine
        self.roles = {}
        with self.session() as db:
            for code in ("ADM", "USER", "RH"):
                role = Role(id=uuid.uuid4(), code=code, name=code, active=True)
                db.add(role)
                self.roles[code] = role.id
            codes = sorted({p for perms in PERMS.values() for p in perms})
            perm_ids = {}
            for code in codes:
                permission = Permission(id=uuid.uuid4(), code=code, resource=code.split(".")[0], action=code)
                db.add(permission)
                perm_ids[code] = permission.id
            for role_code, perms in PERMS.items():
                for code in perms:
                    db.add(RolePermission(
                        id=uuid.uuid4(), role_id=self.roles[role_code], permission_id=perm_ids[code]))

    def asset(self, unit_id, number, **kw) -> uuid.UUID:
        asset_id = uuid.uuid4()
        with self.session() as db:
            db.add(Asset(id=asset_id, patrimony_number=number, unit_id=unit_id, version=1, **kw))
        return asset_id

    def room(self, unit_id, name, *, active=True) -> uuid.UUID:
        room_id = uuid.uuid4()
        with self.session() as db:
            db.add(Room(id=room_id, unit_id=unit_id, name=name, active=active))
        return room_id

    def location(self, unit_id, name, *, room_id=None, active=True) -> uuid.UUID:
        location_id = uuid.uuid4()
        with self.session() as db:
            db.add(Location(id=location_id, unit_id=unit_id, name=name, room_id=room_id, active=active))
        return location_id

    def person(self, unit_id, name, *, active=True) -> uuid.UUID:
        person_id = uuid.uuid4()
        with self.session() as db:
            db.add(ResponsiblePerson(id=person_id, unit_id=unit_id, name=name, active=active))
        return person_id

    def row(self, asset_id) -> Asset:
        with self.session() as db:
            return db.get(Asset, asset_id)

    def audits(self):
        with self.session() as db:
            return list(db.execute(select(AuditLog).where(AuditLog.entity_type == "asset")).scalars())


@pytest.fixture()
def ast():
    world = AssetWorld(_build_engine())
    events: list[dict[str, Any]] = []
    queries: list[str] = []

    @event.listens_for(world.engine, "before_cursor_execute")
    def _count(_conn, _cursor, statement, *_a):  # pragma: no cover
        queries.append(statement)

    with ExitStack() as stack:
        for target in (
            "app.api.v1.assets.get_db_session",
            "app.api.v1.units.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(patch("app.authorization.security_events._dispatch", side_effect=events.append))
        a, b = world.unit("A"), world.unit("B")
        ns = SimpleNamespace(
            client=create_app().test_client(), w=world, events=events, queries=queries, a=a, b=b,
            adm=world.user("Adm", role="ADM", units=[a], auth_user_id="auth-adm"),
            adm_b=world.user("Adm B", role="ADM", units=[b], auth_user_id="auth-adm-b"),
            user_a=world.user("User A", role="USER", units=[a], auth_user_id="auth-user-a"),
            user_ab=world.user("User AB", role="USER", units=[a, b], auth_user_id="auth-user-ab"),
            rh_a=world.user("Rh A", role="RH", units=[a], auth_user_id="auth-rh-a"),
            user_b=world.user("User B", role="USER", units=[b], auth_user_id="auth-user-b"),
        )
        yield ns
    event.remove(world.engine, "before_cursor_execute", _count)


def h(sub, **kw):
    return auth_headers(sub, **kw)


ADM, ADM_B = "auth-adm", "auth-adm-b"
USER_A, USER_AB, USER_B, RH_A = "auth-user-a", "auth-user-ab", "auth-user-b", "auth-rh-a"


def _flush_raises(error: Exception):
    """Faz o flush falhar só quando há um `Asset` pendente (o resto segue real)."""
    from sqlalchemy.orm import Session

    real = Session.flush

    def flush(self, *args, **kwargs):
        if any(isinstance(o, Asset) for o in list(self.new) + list(self.dirty)):
            raise error
        return real(self, *args, **kwargs)

    return patch.object(Session, "flush", flush)


def types(ast, name):
    return [e for e in ast.events if e["event_type"] == name]


# ---------------------------------------------------------------------------
# Leitura: escopo, perfis e exclusão lógica
# ---------------------------------------------------------------------------


def test_listagem_respeita_escopo_inclusive_owner_unit(ast):
    a1 = ast.w.asset(ast.a, "A-1")
    b1 = ast.w.asset(ast.b, "B-1")
    owned = ast.w.asset(ast.b, "B-OWNED-A", owner_unit_id=ast.a)
    c = ast.client
    adm = c.get("/api/v1/assets", headers=h(ADM)).get_json()
    assert {x["id"] for x in adm["assets"]} == {str(a1), str(owned)} and adm["total"] == 2
    other = c.get("/api/v1/assets", headers=h(USER_B)).get_json()
    assert {x["id"] for x in other["assets"]} == {str(b1), str(owned)}
    # escopo vazio => lista vazia (negar por padrão)
    lone = ast.w.user("Sem unidade", role="USER", units=[], auth_user_id="auth-lone")
    assert c.get("/api/v1/assets", headers=h("auth-lone")).get_json()["assets"] == []
    # filtro por unidade alheia não vaza nada
    r = c.get(f"/api/v1/assets?unit_id={ast.b}", headers=h(USER_A)).get_json()
    assert r["total"] == 1 and r["assets"][0]["id"] == str(owned)
    assert lone


def test_rh_nao_recebe_notes_nem_campos_internos_e_sql_nao_le_a_coluna(ast):
    person = ast.w.person(ast.a, "Maria Responsável")
    asset_id = ast.w.asset(ast.a, "RH-1", notes="nota interna", responsible_person_id=person, description="Mesa")
    ast.queries.clear()
    rh = ast.client.get(f"/api/v1/assets/{asset_id}", headers=h(RH_A))
    assert rh.status_code == 200
    body = rh.get_json()
    for key in ("notes", "assigned_user_id", "created_by", "updated_by", "source_record_id", "deleted_by"):
        assert key not in body
    assert body["responsible_person"]["name"] == "Maria Responsável" and body["description"] == "Mesa"
    asset_selects = [q for q in ast.queries if "FROM assets" in q]
    assert asset_selects and all("assets.notes" not in q for q in asset_selects)
    assert "nota interna" not in rh.get_data(as_text=True)
    # listagem também
    ast.queries.clear()
    listing = ast.client.get("/api/v1/assets", headers=h(RH_A)).get_json()
    assert "notes" not in listing["assets"][0]
    assert all("assets.notes" not in q for q in ast.queries if "FROM assets" in q)
    # USER/ADM recebem
    assert ast.client.get(f"/api/v1/assets/{asset_id}", headers=h(USER_A)).get_json()["notes"] == "nota interna"
    ast.queries.clear()
    ast.client.get(f"/api/v1/assets/{asset_id}", headers=h(ADM))
    assert any("assets.notes" in q for q in ast.queries if "FROM assets" in q)


def test_alvo_alheio_inexistente_e_malformado_tem_mesma_resposta_404(ast):
    foreign = ast.w.asset(ast.b, "B-9")
    results = []
    for target in (str(foreign), str(uuid.uuid4()), "nao-e-uuid"):
        for path in ("", "/history"):
            r = ast.client.get(f"/api/v1/assets/{target}{path}", headers=h(USER_A))
            results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)
    assert str(foreign) not in json.dumps(results)
    assert len(types(ast, "UNIT_SCOPE_DENIED")) == 4  # os 2 válidos x 2 rotas


def test_excluidos_nunca_aparecem_fora_de_include_deleted_adm(ast):
    live = ast.w.asset(ast.a, "VIVO")
    dead = ast.w.asset(ast.a, "MORTO")
    assert ast.client.post(f"/api/v1/assets/{dead}/delete", json={"version": 1}, headers=h(ADM)).status_code == 200
    c = ast.client
    for sub in (ADM, USER_A, RH_A):
        listing = c.get("/api/v1/assets", headers=h(sub)).get_json()
        assert [x["id"] for x in listing["assets"]] == [str(live)]
        r = c.get(f"/api/v1/assets/{dead}", headers=h(sub))
        assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    with_deleted = c.get("/api/v1/assets?include_deleted=true", headers=h(ADM)).get_json()
    assert with_deleted["total"] == 2
    one = c.get(f"/api/v1/assets/{dead}?include_deleted=true", headers=h(ADM))
    assert one.status_code == 200 and one.get_json()["deleted_at"] and one.get_json()["deleted_by"] == str(ast.adm)
    for sub in (USER_A, RH_A):
        for path in ("/api/v1/assets?include_deleted=true", f"/api/v1/assets/{dead}?include_deleted=true",
                     f"/api/v1/assets/{dead}/history?include_deleted=true"):
            denied = c.get(path, headers=h(sub))
            assert denied.status_code == 403 and denied.get_json()["error"]["code"] == "forbidden"
    assert len(types(ast, "ACCESS_DENIED")) == 6


def test_listagem_filtros_busca_e_ordenacao(ast):
    room = ast.w.room(ast.a, "Sala 1")
    person = ast.w.person(ast.a, "Ana")
    ast.w.asset(ast.a, "AB_1", description="Cadeira giratória", room_id=room)
    ast.w.asset(ast.a, "ABC1", description="Mesa 100% madeira", responsible_person_id=person, located="SIM")
    ast.w.asset(ast.a, "ZZ-3", description=None, owner_unit_id=ast.b)
    c = ast.client

    def ids(query):
        return [x["patrimony_number"] for x in c.get(f"/api/v1/assets?{query}", headers=h(ADM)).get_json()["assets"]]

    assert ids("q=B_") == ["AB_1"]  # `_` é literal (curinga escapado)
    assert ids("q=100%25") == ["ABC1"] and ids("q=%25") == ["ABC1"]
    assert ids("q=cadeira") == ["AB_1"]
    assert ids(f"room_id={room}") == ["AB_1"]
    assert ids(f"responsible_person_id={person}") == ["ABC1"]
    assert ids("located=SIM") == ["ABC1"]
    assert ids(f"owner_unit_id={ast.b}") == ["ZZ-3"]
    assert ids("sort=-patrimony_number")[0] == "ZZ-3" and ids("sort=patrimony_number")[-1] == "ZZ-3"
    page = c.get("/api/v1/assets?page=2&page_size=2&sort=patrimony_number", headers=h(ADM)).get_json()
    assert page["total"] == 3 and [x["patrimony_number"] for x in page["assets"]] == ["ZZ-3"]


@pytest.mark.parametrize(
    "query", ["foo=1", "sort=notes", "sort=name;drop", "page=0", "page_size=101", "located=TALVEZ",
              "unit_id=x", "room_id=1", "include_deleted=sim", "q=" + "x" * 101, "page=1&page=2",
              "deleted_at=2020-01-01"],
)
def test_listagem_rejeita_fora_da_allowlist(ast, query):
    r = ast.client.get(f"/api/v1/assets?{query}", headers=h(ADM))
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def test_detalhe_e_historico_rejeitam_parametros_desconhecidos(ast):
    asset_id = ast.w.asset(ast.a, "X-1")
    for path in (f"/api/v1/assets/{asset_id}?foo=1", f"/api/v1/assets/{asset_id}/history?foo=1",
                 f"/api/v1/assets/{asset_id}/history?page_size=0"):
        assert ast.client.get(path, headers=h(ADM)).status_code == 400


# ---------------------------------------------------------------------------
# Perfis: 403 por permissão/papel e AAL2 só para ADM
# ---------------------------------------------------------------------------


def test_permissoes_por_perfil(ast):
    c = ast.client
    asset_id = ast.w.asset(ast.a, "P-1")
    body = {"unit_id": str(ast.a), "patrimony_number": "NOVO"}
    assert c.post("/api/v1/assets", json=body, headers=h(RH_A)).status_code == 403
    assert c.patch(f"/api/v1/assets/{asset_id}", json={"version": 1, "description": "x"},
                   headers=h(RH_A)).status_code == 403
    for sub in (USER_A, RH_A):
        for action in ("delete", "restore"):
            r = c.post(f"/api/v1/assets/{asset_id}/{action}", json={"version": 1}, headers=h(sub))
            assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden"
    assert c.get("/api/v1/assets", headers=h(RH_A)).status_code == 200
    assert ast.w.row(asset_id).deleted_at is None
    assert c.open(f"/api/v1/assets/{asset_id}", method="DELETE", headers=h(ADM)).status_code == 405
    assert ast.w.row(asset_id) is not None


def test_adm_exige_aal2_em_todas_as_rotas_e_user_rh_nao(ast):
    c = ast.client
    asset_id = ast.w.asset(ast.a, "AAL-1")
    aal1 = h(ADM, aal="aal1")
    calls = [
        ("get", "/api/v1/assets", None), ("get", f"/api/v1/assets/{asset_id}", None),
        ("get", f"/api/v1/assets/{asset_id}/history", None), ("get", "/api/v1/units/accessible", None),
        ("post", "/api/v1/assets", {"unit_id": str(ast.a), "patrimony_number": "N"}),
        ("patch", f"/api/v1/assets/{asset_id}", {"version": 1, "description": "d"}),
        ("post", f"/api/v1/assets/{asset_id}/delete", {"version": 1}),
        ("post", f"/api/v1/assets/{asset_id}/restore", {"version": 1}),
    ]
    for method, path, body in calls:
        kwargs = {"json": body} if body is not None else {}
        r = getattr(c, method)(path, headers=aal1, **kwargs)
        assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED", path
    assert ast.w.row(asset_id).version == 1 and ast.w.audits() == []
    # USER/RH em aal1 operam normalmente (MFA não é obrigatório para eles)
    assert c.get("/api/v1/assets", headers=h(USER_A, aal="aal1")).status_code == 200
    assert c.get("/api/v1/assets", headers=h(RH_A, aal="aal1")).status_code == 200
    assert c.post("/api/v1/assets", json={"unit_id": str(ast.a), "patrimony_number": "OK-1"},
                  headers=h(USER_A, aal="aal1")).status_code == 201


# ---------------------------------------------------------------------------
# Criação
# ---------------------------------------------------------------------------


def test_criacao_por_user_normaliza_audita_e_define_padroes(ast):
    room = ast.w.room(ast.a, "Sala 1")
    person = ast.w.person(ast.a, "Ana")
    loc = ast.w.location(ast.a, "Armário", room_id=room)
    r = ast.client.post("/api/v1/assets", headers=h(USER_A), json={
        "unit_id": str(ast.a), "patrimony_number": "  000123  ", "description": " Mesa   grande ",
        "notes": "obs", "room_id": str(room), "location_id": str(loc), "responsible_person_id": str(person),
        "registration_date": "2024-05-06",
    })
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["patrimony_number"] == "000123" and isinstance(body["patrimony_number"], str)
    assert body["description"] == "Mesa grande" and body["located"] == "DESCONHECIDO"
    assert body["owner_unit_id"] is None and body["version"] == 1 and body["registration_date"] == "2024-05-06"
    assert body["created_by"] == str(ast.user_a) and body["deleted_at"] is None
    assert body["unit"]["code"] == "A" and body["room"]["name"] == "Sala 1"
    row = ast.w.row(uuid.UUID(body["id"]))
    assert row.created_by == ast.user_a and row.source_record_id is None
    audits = ast.w.audits()
    assert [a.operation for a in audits] == ["ASSET_CREATED"]
    assert "obs" not in json.dumps(audits[0].new_values) and audits[0].actor_user_id == ast.user_a


def test_criacao_por_adm_pode_definir_owner_e_located(ast):
    r = ast.client.post("/api/v1/assets", headers=h(ADM), json={
        "unit_id": str(ast.a), "patrimony_number": "ADM-1", "owner_unit_id": str(ast.a), "located": "SIM"})
    assert r.status_code == 201
    assert r.get_json()["located"] == "SIM" and r.get_json()["owner_unit_id"] == str(ast.a)
    # owner de unidade fora do escopo => 404 uniforme
    r2 = ast.client.post("/api/v1/assets", headers=h(ADM), json={
        "unit_id": str(ast.a), "patrimony_number": "ADM-2", "owner_unit_id": str(ast.b)})
    assert (r2.status_code, r2.get_json()) == (404, NOT_FOUND)


@pytest.mark.parametrize("field,value,event_name", [
    ("owner_unit_id", None, "PRIVILEGE_ESCALATION_ATTEMPT"),
    ("located", "SIM", "MASS_ASSIGNMENT_REJECTED"),
])
def test_user_nao_define_campos_de_adm_na_criacao(ast, field, value, event_name):
    r = ast.client.post("/api/v1/assets", headers=h(USER_A), json={
        "unit_id": str(ast.a), "patrimony_number": "U-1", field: value})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert field in r.get_json()["error"]["message"]
    assert len(types(ast, event_name)) == 1 and ast.w.audits() == []
    with ast.w.session() as db:
        assert db.execute(select(Asset)).first() is None


@pytest.mark.parametrize("field,value", [
    ("id", str(uuid.uuid4())), ("version", 5), ("created_by", str(uuid.uuid4())),
    ("updated_by", str(uuid.uuid4())), ("deleted_at", "2020-01-01T00:00:00Z"),
    ("deleted_by", str(uuid.uuid4())), ("source_record_id", "S1"), ("source_system", "x"),
    ("source_updated_at", "2020-01-01T00:00:00Z"), ("assigned_user_id", str(uuid.uuid4())),
    ("created_at", "2020-01-01T00:00:00Z"), ("active", True), ("is_admin", True),
])
def test_mass_assignment_na_criacao_e_rejeitado_e_auditado(ast, field, value):
    for sub in (USER_A, ADM):
        r = ast.client.post("/api/v1/assets", headers=h(sub), json={
            "unit_id": str(ast.a), "patrimony_number": "MA-1", field: value})
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(ast, "PRIVILEGE_ESCALATION_ATTEMPT")) + len(types(ast, "MASS_ASSIGNMENT_REJECTED")) == 2
    with ast.w.session() as db:
        assert db.execute(select(Asset)).first() is None


def test_criacao_em_unidade_alheia_inexistente_ou_malformada_tem_mesma_resposta(ast):
    results = []
    for unit in (str(ast.b), str(uuid.uuid4()), "nao-e-uuid"):
        r = ast.client.post("/api/v1/assets", headers=h(USER_A), json={"unit_id": unit, "patrimony_number": "X"})
        results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)
    with ast.w.session() as db:
        assert db.execute(select(Asset)).first() is None
    assert len(types(ast, "UNIT_SCOPE_DENIED")) == 3


@pytest.mark.parametrize("payload", [
    {}, {"unit_id": "x"}, {"patrimony_number": "N"},
    {"unit_id": "{u}", "patrimony_number": ""}, {"unit_id": "{u}", "patrimony_number": "   "},
    {"unit_id": "{u}", "patrimony_number": "a\x00b"}, {"unit_id": "{u}", "patrimony_number": "x" * 65},
    {"unit_id": "{u}", "patrimony_number": 123}, {"unit_id": "{u}", "patrimony_number": "N", "located": "TALVEZ"},
    {"unit_id": "{u}", "patrimony_number": "N", "registration_date": "06/05/2024"},
    {"unit_id": "{u}", "patrimony_number": "N", "registration_date": 20240506},
    {"unit_id": "{u}", "patrimony_number": "N", "description": "d" * 2001},
])
def test_criacao_valida_corpo(ast, payload):
    body = {k: (str(ast.a) if v == "{u}" else v) for k, v in payload.items()}
    r = ast.client.post("/api/v1/assets", headers=h(ADM), json=body)
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def test_criacao_em_unidade_inativa_e_409(ast):
    inactive = ast.w.unit("I", active=False)
    ast.w.user("Adm I", role="ADM", units=[inactive], auth_user_id="auth-adm-i")
    r = ast.client.post("/api/v1/assets", headers=h("auth-adm-i"),
                        json={"unit_id": str(inactive), "patrimony_number": "I-1"})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "unit_inactive"


def test_numero_patrimonial_unico_entre_ativos_com_409_generico(ast):
    ast.w.asset(ast.a, "AGU-001")
    c = ast.client
    r = c.post("/api/v1/assets", headers=h(USER_A), json={"unit_id": str(ast.a), "patrimony_number": " agu-001 "})
    assert r.status_code == 409
    assert r.get_json() == {"error": {"code": "conflict", "message": "Já existe um registro com estes dados."}}
    # mesmo número em OUTRA unidade também conflita; texto idêntico, zeros à esquerda preservados
    other = c.post("/api/v1/assets", headers=h(USER_B), json={"unit_id": str(ast.b), "patrimony_number": "AGU-001"})
    assert other.status_code == 409
    assert c.post("/api/v1/assets", headers=h(USER_A),
                  json={"unit_id": str(ast.a), "patrimony_number": "AGU-0010"}).status_code == 201
    # excluído libera o número; restaurar com número em uso => 409
    first = ast.w.asset(ast.a, "REUSO")
    assert c.post(f"/api/v1/assets/{first}/delete", json={"version": 1}, headers=h(ADM)).status_code == 200
    assert c.post("/api/v1/assets", headers=h(USER_A),
                  json={"unit_id": str(ast.a), "patrimony_number": "REUSO"}).status_code == 201
    r = c.post(f"/api/v1/assets/{first}/restore", json={"version": 2}, headers=h(ADM))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "conflict"
    assert ast.w.row(first).deleted_at is not None


def test_violacao_de_integridade_do_banco_vira_409_generico(ast):
    from sqlalchemy.exc import IntegrityError

    boom = IntegrityError("INSERT INTO assets", {}, Exception("UNIQUE constraint failed: assets.patrimony_number"))
    with _flush_raises(boom):
        r = ast.client.post("/api/v1/assets", headers=h(ADM),
                            json={"unit_id": str(ast.a), "patrimony_number": "BD-1"})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "conflict"
    body = r.get_data(as_text=True).lower()
    assert "unique" not in body and "sqlite" not in body and "patrimony_number" not in body


# ---------------------------------------------------------------------------
# Edição
# ---------------------------------------------------------------------------


def test_edicao_por_user_incrementa_version_e_audita_sem_notes(ast):
    asset_id = ast.w.asset(ast.a, "E-1", description="velha")
    c = ast.client
    r = c.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A),
                json={"version": 1, "description": "nova", "notes": "segredo interno"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["version"] == 2 and r.get_json()["description"] == "nova"
    row = ast.w.row(asset_id)
    assert row.version == 2 and row.updated_by == ast.user_a and row.notes == "segredo interno"
    audits = ast.w.audits()
    assert [a.operation for a in audits] == ["ASSET_UPDATED"]
    blob = json.dumps([audits[0].previous_values, audits[0].new_values])
    assert "segredo interno" not in blob and "notes" in audits[0].new_values["changed_fields"]
    assert audits[0].previous_values == {"description": "velha"}
    # sem alteração efetiva: 200, sem auditoria e sem novo version
    same = c.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A), json={"version": 2, "description": "nova"})
    assert same.status_code == 200 and same.get_json()["version"] == 2 and len(ast.w.audits()) == 1


def test_conflito_de_versao_e_version_obrigatorio(ast):
    asset_id = ast.w.asset(ast.a, "V-1")
    c = ast.client
    assert c.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A),
                   json={"version": 1, "description": "a"}).status_code == 200
    stale = c.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A), json={"version": 1, "description": "b"})
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"
    assert ast.w.row(asset_id).description == "a"
    for body in ({"description": "c"}, {"version": None, "description": "c"}, {"version": "2", "description": "c"},
                 {"version": 0, "description": "c"}, {"version": True, "description": "c"}):
        r = c.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A), json=body)
        assert r.status_code == 400, body
    assert c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM), json={"version": 1}).status_code == 409


def test_corrida_no_orm_vira_version_conflict(ast):
    """`StaleDataError` (outra transação alterou entre leitura e UPDATE) => 409."""
    from sqlalchemy.orm.exc import StaleDataError

    asset_id = ast.w.asset(ast.a, "ORM-1")
    with _flush_raises(StaleDataError()):
        r = ast.client.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A),
                             json={"version": 1, "description": "x"})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "version_conflict"


@pytest.mark.parametrize("field,value,event_name", [
    ("owner_unit_id", None, "PRIVILEGE_ESCALATION_ATTEMPT"),
    ("located", "SIM", "MASS_ASSIGNMENT_REJECTED"),
    ("patrimony_number", "OUTRO", "MASS_ASSIGNMENT_REJECTED"),
])
def test_user_nao_edita_campos_de_adm(ast, field, value, event_name):
    asset_id = ast.w.asset(ast.a, "UF-1")
    r = ast.client.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A), json={"version": 1, field: value})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(ast, event_name)) == 1
    row = ast.w.row(asset_id)
    assert row.version == 1 and row.patrimony_number == "UF-1" and row.located == "DESCONHECIDO"
    assert ast.w.audits() == []


@pytest.mark.parametrize("field,value", [
    ("unit_id", "{b}"), ("id", "x"), ("created_by", "x"), ("deleted_at", "2020-01-01T00:00:00Z"),
    ("deleted_by", "x"), ("source_record_id", "S"), ("assigned_user_id", "x"), ("updated_by", "x"),
    ("source_updated_at", "2020-01-01T00:00:00Z"),
])
def test_mass_assignment_na_edicao(ast, field, value):
    asset_id = ast.w.asset(ast.a, "MA-9")
    value = str(ast.b) if value == "{b}" else value
    for sub in (USER_A, ADM):
        r = ast.client.patch(f"/api/v1/assets/{asset_id}", headers=h(sub), json={"version": 1, field: value})
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    row = ast.w.row(asset_id)
    assert row.version == 1 and row.unit_id == ast.a and row.source_record_id is None
    assert len(types(ast, "PRIVILEGE_ESCALATION_ATTEMPT")) + len(types(ast, "MASS_ASSIGNMENT_REJECTED")) == 2


def test_edicao_pelo_adm_de_owner_located_e_numero_com_unicidade(ast):
    asset_id = ast.w.asset(ast.a, "AD-1")
    ast.w.asset(ast.a, "AD-2")
    c = ast.client
    r = c.patch(f"/api/v1/assets/{asset_id}", headers=h(ADM),
                json={"version": 1, "owner_unit_id": str(ast.a), "located": "NAO", "patrimony_number": "AD-1B"})
    assert r.status_code == 200 and r.get_json()["located"] == "NAO" and r.get_json()["patrimony_number"] == "AD-1B"
    dup = c.patch(f"/api/v1/assets/{asset_id}", headers=h(ADM), json={"version": 2, "patrimony_number": "ad-2"})
    assert dup.status_code == 409 and dup.get_json()["error"]["code"] == "conflict"
    cleared = c.patch(f"/api/v1/assets/{asset_id}", headers=h(ADM), json={"version": 2, "owner_unit_id": None})
    assert cleared.status_code == 200 and cleared.get_json()["owner_unit_id"] is None
    nulls = c.patch(f"/api/v1/assets/{asset_id}", headers=h(ADM), json={"version": 3, "patrimony_number": None})
    assert nulls.status_code == 400
    assert c.patch(f"/api/v1/assets/{asset_id}", headers=h(ADM), json={"version": 3}).status_code == 400


def test_edicao_em_alvo_alheio_ou_inexistente_tem_mesma_resposta(ast):
    foreign = ast.w.asset(ast.b, "FB-1")
    results = []
    for target in (str(foreign), str(uuid.uuid4()), "nao-e-uuid"):
        for sub in (USER_A, ADM):
            r = ast.client.patch(f"/api/v1/assets/{target}", headers=h(sub), json={"version": 1, "description": "x"})
            results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)
    assert ast.w.row(foreign).version == 1
    # corpo inválido continua 400 mesmo em alvo alheio (validação antes do escopo, sem oráculo de existência)
    assert ast.client.patch(f"/api/v1/assets/{foreign}", headers=h(USER_A), json={"description": "x"}).status_code == 400


def test_vinculos_validados_por_unidade_escopo_e_atividade(ast):
    asset_id = ast.w.asset(ast.a, "L-1")
    room_a = ast.w.room(ast.a, "Sala A")
    room_b = ast.w.room(ast.b, "Sala B")
    room_off = ast.w.room(ast.a, "Sala inativa", active=False)
    person_off = ast.w.person(ast.a, "Inativo", active=False)
    loc_other_room = ast.w.location(ast.a, "Local", room_id=ast.w.room(ast.a, "Sala C"))
    c = ast.client

    def patch(sub, version=1, **fields):
        return c.patch(f"/api/v1/assets/{asset_id}", headers=h(sub), json={"version": version, **fields})

    # escopo: sala de unidade fora do escopo do usuário => 404 uniforme
    assert (patch(USER_A, room_id=str(room_b)).status_code, patch(USER_A, room_id=str(room_b)).get_json()) == (404, NOT_FOUND)
    assert patch(USER_A, room_id=str(uuid.uuid4())).get_json() == NOT_FOUND
    assert patch(USER_A, room_id="lixo").get_json() == NOT_FOUND
    # unidade diferente do bem, mas dentro do escopo => 409 link_unit_mismatch
    r = patch(USER_AB, room_id=str(room_b))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "link_unit_mismatch"
    # inativos bloqueiam NOVA associação
    assert patch(USER_A, room_id=str(room_off)).get_json()["error"]["code"] == "link_inactive"
    assert patch(USER_A, responsible_person_id=str(person_off)).get_json()["error"]["code"] == "link_inactive"
    # local de outra sala
    assert patch(USER_A, room_id=str(room_a)).status_code == 200
    r = patch(USER_A, version=2, location_id=str(loc_other_room))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "link_unit_mismatch"
    assert ast.w.row(asset_id).version == 2
    # limpar vínculos com null
    assert patch(USER_A, version=2, room_id=None).get_json()["room_id"] is None


def test_vinculo_inativo_ja_existente_continua_valido(ast):
    room_off = ast.w.room(ast.a, "Antiga", active=False)
    asset_id = ast.w.asset(ast.a, "KEEP-1", room_id=room_off)
    r = ast.client.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A),
                         json={"version": 1, "room_id": str(room_off), "description": "ok"})
    assert r.status_code == 200 and r.get_json()["room_id"] == str(room_off)


# ---------------------------------------------------------------------------
# Exclusão lógica, restauração e histórico
# ---------------------------------------------------------------------------


def test_exclusao_logica_restauracao_e_auditoria(ast):
    asset_id = ast.w.asset(ast.a, "D-1")
    c = ast.client
    d = c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM), json={"version": 1, "reason": "baixa"})
    assert d.status_code == 200 and d.get_json()["deleted_at"] and d.get_json()["version"] == 2
    row = ast.w.row(asset_id)
    assert row is not None and row.deleted_at is not None and row.deleted_by == ast.adm  # nunca físico
    again = c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM), json={"version": 2})
    assert (again.status_code, again.get_json()) == (404, NOT_FOUND)
    # PATCH em excluído => 404
    assert c.patch(f"/api/v1/assets/{asset_id}", headers=h(ADM),
                   json={"version": 2, "description": "x"}).status_code == 404
    stale = c.post(f"/api/v1/assets/{asset_id}/restore", headers=h(ADM), json={"version": 1})
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"
    restored = c.post(f"/api/v1/assets/{asset_id}/restore", headers=h(ADM), json={"version": 2})
    assert restored.status_code == 200 and restored.get_json()["deleted_at"] is None
    row = ast.w.row(asset_id)
    assert row.deleted_by is None and row.version == 3
    ops = {a.operation for a in ast.w.audits()}
    assert ops == {"ASSET_DELETED", "ASSET_RESTORED"}
    # restaurar quem não está excluído => 404
    assert c.post(f"/api/v1/assets/{asset_id}/restore", headers=h(ADM), json={"version": 3}).status_code == 404


def test_exclusao_exige_version_corpo_estrito_e_escopo(ast):
    asset_id = ast.w.asset(ast.a, "D-2")
    foreign = ast.w.asset(ast.b, "D-3")
    c = ast.client
    assert c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM), json={}).status_code == 400
    assert c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM), json={"version": 1, "x": 1}).status_code == 400
    assert c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM),
                  json={"version": 1, "deleted_at": "2020-01-01"}).status_code == 400
    r = c.post(f"/api/v1/assets/{foreign}/delete", headers=h(ADM), json={"version": 1})
    assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    assert ast.w.row(foreign).deleted_at is None and ast.w.row(asset_id).deleted_at is None
    # bem com owner no escopo do ADM também pode ser excluído por ele
    owned = ast.w.asset(ast.b, "D-4", owner_unit_id=ast.a)
    assert c.post(f"/api/v1/assets/{owned}/delete", headers=h(ADM), json={"version": 1}).status_code == 200


def test_historico_somente_leitura_sem_pii_e_com_escopo(ast):
    asset_id = ast.w.asset(ast.a, "H-1")
    c = ast.client
    c.patch(f"/api/v1/assets/{asset_id}", headers=h(USER_A), json={"version": 1, "notes": "texto sigiloso"})
    c.post(f"/api/v1/assets/{asset_id}/delete", headers=h(ADM), json={"version": 2})
    with ast.w.session() as db:  # eventos de outras entidades não entram
        db.add(AuditLog(id=uuid.uuid4(), entity_type="room", entity_id=str(asset_id), operation="ROOM_UPDATED",
                        result="SUCESSO"))
    for sub in (ADM, USER_A, RH_A):
        path = f"/api/v1/assets/{asset_id}/history" + ("?include_deleted=true" if sub == ADM else "")
        r = c.get(path, headers=h(sub))
        if sub != ADM:
            assert (r.status_code, r.get_json()) == (404, NOT_FOUND)  # excluído: só ADM + include_deleted
            continue
        body = r.get_json()
        assert body["total"] == 2 and {e["operation"] for e in body["entries"]} == {"ASSET_UPDATED", "ASSET_DELETED"}
        assert "texto sigiloso" not in r.get_data(as_text=True) and "email" not in r.get_data(as_text=True)
        assert set(body["entries"][0]) == {"id", "operation", "occurred_at", "actor_user_id", "result",
                                           "previous_values", "new_values"}
    live = ast.w.asset(ast.a, "H-2")
    c.patch(f"/api/v1/assets/{live}", headers=h(USER_A), json={"version": 1, "description": "d"})
    assert c.get(f"/api/v1/assets/{live}/history", headers=h(RH_A)).get_json()["total"] == 1
    assert c.get(f"/api/v1/assets/{live}/history", headers=h(USER_B)).status_code == 404
    for method in ("post", "patch", "put"):
        assert getattr(c, method)(f"/api/v1/assets/{live}/history", headers=h(ADM), json={}).status_code == 405


# ---------------------------------------------------------------------------
# GET /units/accessible
# ---------------------------------------------------------------------------


def test_units_accessible_por_perfil_so_escopo_ordenado_sem_campos_extras(ast):
    ast.w.unit("0-Z")  # fora do escopo de todos
    c = ast.client
    expected_keys = {"id", "code", "name", "active"}
    for sub, codes in ((ADM, ["A"]), (USER_A, ["A"]), (RH_A, ["A"]), (USER_B, ["B"]), (USER_AB, ["A", "B"])):
        r = c.get("/api/v1/units/accessible", headers=h(sub))
        assert r.status_code == 200
        body = r.get_json()
        assert set(body) == {"units"} and [u["code"] for u in body["units"]] == codes
        assert all(set(u) == expected_keys for u in body["units"])
    r = c.get("/api/v1/units/accessible", headers=h(USER_AB)).get_json()
    assert r["units"][0] == {"id": str(ast.a), "code": "A", "name": "Unidade A", "active": True}
    assert "address" not in json.dumps(r) and "source_record_id" not in json.dumps(r)
    ast.w.user("Sem unidade", role="RH", units=[], auth_user_id="auth-lone-rh")
    assert c.get("/api/v1/units/accessible", headers=h("auth-lone-rh")).get_json() == {"units": []}


@pytest.mark.parametrize("query", ["foo=1", "q=a", "active=true", "page=1", "unit_id=x", "a=1&a=2"])
def test_units_accessible_rejeita_qualquer_parametro(ast, query):
    r = ast.client.get(f"/api/v1/units/accessible?{query}", headers=h(ADM))
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def test_units_accessible_sem_units_read_e_negado_e_contratos_antigos_intactos(ast):
    with ast.w.session() as db:
        rh_role = ast.w.roles["RH"]
        perm = db.execute(select(Permission).where(Permission.code == "units.read")).scalar_one()
        db.query(RolePermission).filter(
            RolePermission.role_id == rh_role, RolePermission.permission_id == perm.id).delete()
    assert ast.client.get("/api/v1/units/accessible", headers=h(RH_A)).status_code == 403
    # `GET /units` segue exclusivo de ADM (`users.manage`) e sem parâmetros.
    assert ast.client.get("/api/v1/units", headers=h(USER_A)).status_code == 403


def test_registration_date_e_serializada_em_iso(ast):
    ast.w.asset(ast.a, "DT-1", registration_date=date(2023, 1, 2))
    got = ast.client.get("/api/v1/assets", headers=h(ADM)).get_json()["assets"][0]
    assert got["registration_date"] == "2023-01-02"
