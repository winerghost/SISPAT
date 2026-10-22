"""API de movimentações `/api/v1/movements` (ponta a ponta) + regressão da edição de sala.

SQLite com o schema real dos modelos + carregador REAL de `require_auth`, Redis falso,
sem rede. A matriz de 401/perfil/AAL2 por rota está em `test_sec_route_inventory.py`;
aqui: fluxo, escopo origem/destino, IDOR, mass assignment, transições, concorrência,
bem excluído, pendente duplicada, atomicidade, idempotência e imutabilidade.
"""
from __future__ import annotations

import json
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import DefaultClause

import app.models  # noqa: F401
from app import create_app
from app.database.session import Base
from app.models.assets import Asset, AssetMovement
from app.models.audit import AuditLog
from app.models.people import ResponsiblePerson
from app.models.rbac import Permission, Role, RolePermission
from app.models.units import Location, Room
from app.services.local_dates import LOCAL_TZ
from test_user_admin_db import FakeRedis, World, auth_headers

TABLES = (
    "users", "roles", "permissions", "role_permissions", "user_roles", "units",
    "user_unit_access", "audit_logs", "rooms", "responsible_people", "locations", "assets",
    "asset_movements",
)
PERMS = {
    "ADM": ("assets.read", "assets.create", "assets.update", "assets.delete", "units.read",
            "movements.create", "movements.approve"),
    "USER": ("assets.read", "assets.create", "assets.update", "units.read", "movements.create"),
    "RH": ("assets.read", "units.read"),
}
NOT_FOUND = {"error": {"code": "not_found", "message": "Recurso não encontrado."}}
ADM, ADM_A, USER_A, USER_A2, USER_AB, USER_B, RH_A, RH_B = (
    "auth-adm", "auth-adm-a", "auth-user-a", "auth-user-a2", "auth-user-ab", "auth-user-b",
    "auth-rh-a", "auth-rh-b",
)


def _build_engine():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False},
                           future=True)
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


class MovWorld(World):
    def __init__(self, engine) -> None:
        self.engine = engine
        self.roles = {}
        with self.session() as db:
            for code in ("ADM", "USER", "RH"):
                role = Role(id=uuid.uuid4(), code=code, name=code, active=True)
                db.add(role)
                self.roles[code] = role.id
            perm_ids = {}
            for code in sorted({p for perms in PERMS.values() for p in perms}):
                permission = Permission(id=uuid.uuid4(), code=code, resource=code.split(".")[0], action=code)
                db.add(permission)
                perm_ids[code] = permission.id
            for role_code, perms in PERMS.items():
                for code in perms:
                    db.add(RolePermission(id=uuid.uuid4(), role_id=self.roles[role_code],
                                          permission_id=perm_ids[code]))

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

    def location(self, unit_id, name, *, room_id=None) -> uuid.UUID:
        location_id = uuid.uuid4()
        with self.session() as db:
            db.add(Location(id=location_id, unit_id=unit_id, name=name, room_id=room_id, active=True))
        return location_id

    def person(self, unit_id, name, *, active=True) -> uuid.UUID:
        person_id = uuid.uuid4()
        with self.session() as db:
            db.add(ResponsiblePerson(id=person_id, unit_id=unit_id, name=name, active=active))
        return person_id

    def row(self, asset_id) -> Asset:
        with self.session() as db:
            return db.get(Asset, asset_id)

    def mov(self, movement_id) -> AssetMovement:
        with self.session() as db:
            return db.get(AssetMovement, uuid.UUID(str(movement_id)))

    def movements(self) -> list[AssetMovement]:
        with self.session() as db:
            return list(db.execute(select(AssetMovement)).scalars())

    def audit_ops(self) -> list[str]:
        with self.session() as db:
            return [a.operation for a in db.execute(select(AuditLog).order_by(AuditLog.occurred_at)).scalars()]

    def audit_rows(self, operation: str) -> list[AuditLog]:
        with self.session() as db:
            return list(db.execute(select(AuditLog).where(AuditLog.operation == operation)).scalars())


@pytest.fixture()
def mv():
    world = MovWorld(_build_engine())
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        for target in ("app.api.v1.movements.get_db_session", "app.api.v1.assets.get_db_session",
                       "app.auth.supabase_auth.get_db_session"):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(patch("app.authorization.security_events._dispatch", side_effect=events.append))
        a, b = world.unit("A"), world.unit("B")
        yield SimpleNamespace(
            client=create_app().test_client(), w=world, events=events, a=a, b=b,
            adm=world.user("Adm", role="ADM", units=[a, b], auth_user_id=ADM),
            adm_a=world.user("Adm A", role="ADM", units=[a], auth_user_id=ADM_A),
            user_a=world.user("User A", role="USER", units=[a], auth_user_id=USER_A),
            user_a2=world.user("User A2", role="USER", units=[a], auth_user_id=USER_A2),
            user_ab=world.user("User AB", role="USER", units=[a, b], auth_user_id=USER_AB),
            user_b=world.user("User B", role="USER", units=[b], auth_user_id=USER_B),
            rh_a=world.user("Rh A", role="RH", units=[a], auth_user_id=RH_A),
            rh_b=world.user("Rh B", role="RH", units=[b], auth_user_id=RH_B),
        )


def h(sub, **kw):
    return auth_headers(sub, **kw)


def types(mv, name):
    return [e for e in mv.events if e["event_type"] == name]


def request(mv, sub, asset_id, dest, *, version=1, **extra):
    body = {"asset_id": str(asset_id), "asset_version": version, "destination_unit_id": str(dest), **extra}
    return mv.client.post("/api/v1/movements", json=body, headers=h(sub))


def _flush_raises_for_asset(error: Exception):
    from sqlalchemy.orm import Session

    real = Session.flush

    def flush(self, *args, **kwargs):
        if any(isinstance(o, Asset) for o in list(self.dirty)):
            raise error
        return real(self, *args, **kwargs)

    return patch.object(Session, "flush", flush)


# ---------------------------------------------------------------------------
# Perfis, métodos e AAL2
# ---------------------------------------------------------------------------


def test_permissoes_por_perfil_e_sem_put_patch_delete(mv):
    c = mv.client
    asset_id = mv.w.asset(mv.a, "P-1")
    assert request(mv, RH_A, asset_id, mv.a).status_code == 403
    created = request(mv, USER_AB, asset_id, mv.b)
    assert created.status_code == 201, created.get_json()
    mid = created.get_json()["id"]
    for sub in (USER_AB, RH_A):
        for action in ("approve", "reject"):
            r = c.post(f"/api/v1/movements/{mid}/{action}", json={"asset_version": 1}, headers=h(sub))
            assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden"
    assert c.post(f"/api/v1/movements/{mid}/cancel", json={}, headers=h(RH_A)).status_code == 403
    assert c.get("/api/v1/movements", headers=h(RH_A)).status_code == 200
    for method in ("put", "patch", "delete"):
        for path in (f"/api/v1/movements/{mid}", "/api/v1/movements"):
            assert getattr(c, method)(path, headers=h(ADM), json={}).status_code == 405
    assert mv.w.mov(mid).status == "PENDENTE"


def test_adm_exige_aal2_em_todas_as_rotas_e_user_nao(mv):
    c = mv.client
    asset_id = mv.w.asset(mv.a, "AAL-1")
    mid = request(mv, USER_AB, asset_id, mv.b).get_json()["id"]
    aal1 = h(ADM, aal="aal1")
    calls = [
        ("get", "/api/v1/movements", None), ("get", f"/api/v1/movements/{mid}", None),
        ("post", "/api/v1/movements", {"asset_id": str(asset_id), "asset_version": 1,
                                        "destination_unit_id": str(mv.b)}),
        ("post", f"/api/v1/movements/{mid}/cancel", {}),
        ("post", f"/api/v1/movements/{mid}/approve", {"asset_version": 1}),
        ("post", f"/api/v1/movements/{mid}/reject", {}),
    ]
    for method, path, body in calls:
        kwargs = {"json": body} if body is not None else {}
        r = getattr(c, method)(path, headers=aal1, **kwargs)
        assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED", path
    assert mv.w.mov(mid).status == "PENDENTE" and mv.w.row(asset_id).version == 1
    assert c.get("/api/v1/movements", headers=h(USER_A, aal="aal1")).status_code == 200
    assert c.get("/api/v1/movements", headers=h(RH_A, aal="aal1")).status_code == 200
    other = mv.w.asset(mv.a, "AAL-2")
    assert request(mv, USER_AB, other, mv.b).status_code == 201


# ---------------------------------------------------------------------------
# Solicitação
# ---------------------------------------------------------------------------


def test_solicitacao_grava_origem_do_servidor_nao_altera_o_bem_e_audita_sem_texto_livre(mv):
    person_a = mv.w.person(mv.a, "Ana")
    room_a = mv.w.room(mv.a, "Sala A")
    room_b = mv.w.room(mv.b, "Sala B")
    person_b = mv.w.person(mv.b, "Beto")
    asset_id = mv.w.asset(mv.a, "T-1", room_id=room_a, responsible_person_id=person_a)
    r = request(mv, USER_AB, asset_id, mv.b, destination_room_id=str(room_b), new_responsible_id=str(person_b),
                reason="  motivo   interno do pedido ")
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["status"] == "PENDENTE" and body["movement_type"] == "TRANSFERENCIA_UNIDADE"
    assert body["origin_unit_id"] == str(mv.a) and body["destination_unit_id"] == str(mv.b)
    assert body["origin_room_id"] == str(room_a) and body["destination_room_id"] == str(room_b)
    assert body["previous_responsible_id"] == str(person_a) and body["new_responsible_id"] == str(person_b)
    assert body["requested_by"] == str(mv.user_ab) and body["reason"] == "motivo interno do pedido"
    assert body["approved_by"] is None and body["approved_at"] is None
    assert body["asset"]["patrimony_number"] == "T-1" and body["destination_unit"]["code"] == "B"
    row = mv.w.row(asset_id)  # a solicitação não altera o bem
    assert row.unit_id == mv.a and row.room_id == room_a and row.version == 1
    audits = mv.w.audit_rows("MOVEMENT_REQUESTED")
    assert len(audits) == 1 and audits[0].actor_user_id == mv.user_ab
    assert "motivo" not in json.dumps(audits[0].new_values) and audits[0].new_values["has_reason"] is True


def test_solicitacao_na_mesma_unidade_tipo_e_semantica_de_ausente_vs_null(mv):
    person = mv.w.person(mv.a, "Ana")
    room1, room2 = mv.w.room(mv.a, "S1"), mv.w.room(mv.a, "S2")
    asset_id = mv.w.asset(mv.a, "S-1", room_id=room1, responsible_person_id=person)
    r = request(mv, USER_A, asset_id, mv.a, destination_room_id=str(room2))
    assert r.status_code == 201
    body = r.get_json()  # responsável ausente => mantido
    assert body["movement_type"] == "MUDANCA_SALA" and body["new_responsible_id"] == str(person)
    assert body["destination_room_id"] == str(room2)
    mv.client.post(f"/api/v1/movements/{body['id']}/cancel", json={}, headers=h(USER_A))
    only_person = request(mv, USER_A, asset_id, mv.a, new_responsible_id=None)  # null explícito => limpa
    assert only_person.status_code == 201
    assert only_person.get_json()["movement_type"] == "TROCA_RESPONSAVEL"
    assert only_person.get_json()["new_responsible_id"] is None
    assert only_person.get_json()["destination_room_id"] == str(room1)


def test_solicitacao_em_escopo_alheio_inexistente_e_malformado_tem_mesma_resposta(mv):
    foreign = mv.w.asset(mv.b, "F-1")
    mine = mv.w.asset(mv.a, "M-1")
    results = []
    for target in (str(foreign), str(uuid.uuid4()), "nao-e-uuid"):
        r = request(mv, USER_A, target, mv.a)
        results.append((r.status_code, r.get_json()))
    # destino fora do escopo do solicitante (bem é meu): mesma resposta
    for dest in (str(mv.b), str(uuid.uuid4()), "lixo"):
        r = request(mv, USER_A, mine, dest)
        results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)
    assert str(foreign) not in json.dumps(results) and mv.w.movements() == []
    assert len(types(mv, "UNIT_SCOPE_DENIED")) == 6


@pytest.mark.parametrize("field,value", [
    ("status", "APROVADA"), ("movement_type", "X"), ("origin_unit_id", str(uuid.uuid4())),
    ("origin_room_id", str(uuid.uuid4())), ("previous_responsible_id", str(uuid.uuid4())),
    ("requested_by", str(uuid.uuid4())), ("approved_by", str(uuid.uuid4())), ("id", str(uuid.uuid4())),
    ("approved_at", "2020-01-01T00:00:00Z"), ("completed_at", "2020-01-01T00:00:00Z"),
    ("created_at", "2020-01-01T00:00:00Z"), ("unit_id", str(uuid.uuid4())), ("role", "ADM"),
])
def test_mass_assignment_na_solicitacao(mv, field, value):
    asset_id = mv.w.asset(mv.a, "MA-1")
    for sub in (USER_AB, ADM):
        r = request(mv, sub, asset_id, mv.b, **{field: value})
        assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(mv, "PRIVILEGE_ESCALATION_ATTEMPT")) + len(types(mv, "MASS_ASSIGNMENT_REJECTED")) == 2
    assert mv.w.movements() == []


@pytest.mark.parametrize("payload", [
    {}, {"asset_id": "{a}"}, {"asset_id": "{a}", "destination_unit_id": "{b}"},
    {"asset_id": "{a}", "asset_version": 0, "destination_unit_id": "{b}"},
    {"asset_id": "{a}", "asset_version": "1", "destination_unit_id": "{b}"},
    {"asset_id": "{a}", "asset_version": True, "destination_unit_id": "{b}"},
    {"asset_id": "{a}", "asset_version": 1, "destination_unit_id": "{b}", "reason": "x" * 501},
    {"asset_id": 5, "asset_version": 1, "destination_unit_id": "{b}"},
])
def test_solicitacao_valida_corpo(mv, payload):
    asset_id = mv.w.asset(mv.a, "V-0")
    body = {k: ({"{a}": str(asset_id), "{b}": str(mv.b)}.get(v, v) if isinstance(v, str) else v)
            for k, v in payload.items()}
    r = mv.client.post("/api/v1/movements", json=body, headers=h(USER_AB))
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert mv.w.movements() == []


def test_solicitacao_conflitos_versao_pendente_sem_mudanca_excluido_e_inativos(mv):
    asset_id = mv.w.asset(mv.a, "C-1")
    stale = request(mv, USER_AB, asset_id, mv.b, version=7)
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"
    nochange = request(mv, USER_AB, asset_id, mv.a)
    assert nochange.status_code == 409 and nochange.get_json()["error"]["code"] == "no_change"
    first = request(mv, USER_AB, asset_id, mv.b)
    assert first.status_code == 201
    dup = request(mv, USER_AB, asset_id, mv.b)
    assert dup.status_code == 409 and dup.get_json()["error"]["code"] == "movement_pending"
    assert len(mv.w.movements()) == 1
    # excluído logicamente: 404 (nem aparece)
    dead = mv.w.asset(mv.a, "C-DEAD")
    assert mv.client.post(f"/api/v1/assets/{dead}/delete", json={"version": 1}, headers=h(ADM)).status_code == 200
    r = request(mv, USER_AB, dead, mv.b, version=2)
    assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    # destino inativo
    inactive = mv.w.unit("I", active=False)
    mv.w.user("Adm I", role="ADM", units=[mv.a, inactive], auth_user_id="auth-adm-i")
    other = mv.w.asset(mv.a, "C-2")
    r = request(mv, "auth-adm-i", other, inactive)
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "unit_inactive"


def test_solicitacao_vinculos_coerentes_com_o_destino(mv):
    room_a = mv.w.room(mv.a, "Sala A")
    room_b_off = mv.w.room(mv.b, "Sala B off", active=False)
    person_a = mv.w.person(mv.a, "Ana")
    asset_id = mv.w.asset(mv.a, "L-1")
    mismatch = request(mv, USER_AB, asset_id, mv.b, destination_room_id=str(room_a))
    assert mismatch.status_code == 409 and mismatch.get_json()["error"]["code"] == "link_unit_mismatch"
    mismatch2 = request(mv, USER_AB, asset_id, mv.b, new_responsible_id=str(person_a))
    assert mismatch2.status_code == 409 and mismatch2.get_json()["error"]["code"] == "link_unit_mismatch"
    off = request(mv, USER_AB, asset_id, mv.b, destination_room_id=str(room_b_off))
    assert off.status_code == 409 and off.get_json()["error"]["code"] == "link_inactive"
    for bad in (str(uuid.uuid4()), "lixo"):
        r = request(mv, USER_AB, asset_id, mv.b, destination_room_id=bad)
        assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    # sala de unidade fora do escopo do solicitante => 404 uniforme
    room_b = mv.w.room(mv.b, "Sala B")
    r = request(mv, USER_A, asset_id, mv.a, destination_room_id=str(room_b))
    assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    assert mv.w.movements() == []


# ---------------------------------------------------------------------------
# Aprovação
# ---------------------------------------------------------------------------


def _pending_transfer(mv, number="AP-1"):
    person = mv.w.person(mv.a, "Ana")
    room_a = mv.w.room(mv.a, "Sala A")
    loc = mv.w.location(mv.a, "Armário", room_id=room_a)
    room_b = mv.w.room(mv.b, "Sala B")
    person_b = mv.w.person(mv.b, "Beto")
    asset_id = mv.w.asset(mv.a, number, room_id=room_a, location_id=loc, responsible_person_id=person)
    created = request(mv, USER_AB, asset_id, mv.b, destination_room_id=str(room_b),
                      new_responsible_id=str(person_b))
    assert created.status_code == 201
    return SimpleNamespace(asset_id=asset_id, mid=created.get_json()["id"], room_b=room_b, person_b=person_b,
                           room_a=room_a, person_a=person)


def test_aprovacao_aplica_o_bem_atomicamente_e_audita(mv):
    p = _pending_transfer(mv)
    r = mv.client.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1}, headers=h(ADM))
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["status"] == "APROVADA" and body["approved_by"] == str(mv.adm)
    assert body["approved_at"] and body["completed_at"]
    asset = mv.w.row(p.asset_id)
    assert asset.unit_id == mv.b and asset.room_id == p.room_b and asset.responsible_person_id == p.person_b
    assert asset.location_id is None and asset.version == 2 and asset.updated_by == mv.adm
    assert asset.deleted_at is None
    assert mv.w.audit_ops() == ["MOVEMENT_REQUESTED", "MOVEMENT_APPROVED", "ASSET_MOVED"] or set(
        mv.w.audit_ops()) == {"MOVEMENT_REQUESTED", "MOVEMENT_APPROVED", "ASSET_MOVED"}
    moved = mv.w.audit_rows("ASSET_MOVED")[0]
    assert moved.entity_type == "asset" and moved.entity_id == str(p.asset_id)
    assert moved.previous_values["unit_id"] == str(mv.a) and moved.new_values["unit_id"] == str(mv.b)
    # o bem agora é visível no histórico do bem e o USER de A deixa de vê-lo, mas vê a movimentação
    assert mv.client.get(f"/api/v1/assets/{p.asset_id}", headers=h(USER_A)).status_code == 404
    assert mv.client.get(f"/api/v1/movements/{p.mid}", headers=h(USER_A)).status_code == 200


def test_aprovacao_mesma_unidade_mantem_local_coerente(mv):
    room1, room2 = mv.w.room(mv.a, "R1"), mv.w.room(mv.a, "R2")
    loc = mv.w.location(mv.a, "Gaveta", room_id=room1)
    keep = mv.w.location(mv.a, "Livre", room_id=None)
    a1 = mv.w.asset(mv.a, "SU-1", room_id=room1, location_id=loc)
    a2 = mv.w.asset(mv.a, "SU-2", room_id=room1, location_id=keep)
    for asset_id in (a1, a2):
        mid = request(mv, USER_A, asset_id, mv.a, destination_room_id=str(room2)).get_json()["id"]
        assert mv.client.post(f"/api/v1/movements/{mid}/approve", json={"asset_version": 1},
                              headers=h(ADM)).status_code == 200
    assert mv.w.row(a1).location_id is None and mv.w.row(a1).room_id == room2
    assert mv.w.row(a2).location_id == keep and mv.w.row(a2).unit_id == mv.a


def test_aprovacao_duas_vezes_e_idempotente_409_sem_reaplicar(mv):
    p = _pending_transfer(mv)
    c = mv.client
    assert c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1}, headers=h(ADM)).status_code == 200
    for version in (1, 2):
        again = c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": version}, headers=h(ADM))
        assert again.status_code == 409 and again.get_json()["error"]["code"] == "invalid_transition"
    assert mv.w.row(p.asset_id).version == 2
    assert len(mv.w.audit_rows("MOVEMENT_APPROVED")) == 1 and len(mv.w.audit_rows("ASSET_MOVED")) == 1
    for action in ("reject", "cancel"):
        r = c.post(f"/api/v1/movements/{p.mid}/{action}", json={}, headers=h(ADM))
        assert r.status_code == 409 and r.get_json()["error"]["code"] == "invalid_transition"
    assert mv.w.mov(p.mid).status == "APROVADA"


def test_aprovacao_com_bem_alterado_depois_da_solicitacao_e_version_conflict(mv):
    p = _pending_transfer(mv)
    c = mv.client
    # versão do corpo diferente da atual
    r = c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 9}, headers=h(ADM))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "version_conflict"
    # bem editado (versão 2), com a versão nova no corpo: ainda aprova (unidade/sala/responsável iguais)
    assert c.patch(f"/api/v1/assets/{p.asset_id}", json={"version": 1, "description": "nova"},
                   headers=h(ADM)).status_code == 200
    stale = c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1}, headers=h(ADM))
    assert stale.status_code == 409 and stale.get_json()["error"]["code"] == "version_conflict"
    assert mv.w.mov(p.mid).status == "PENDENTE"
    # sala do bem mudou depois do pedido: o instantâneo da origem não confere mais, mesmo com a versão certa
    room_other = mv.w.room(mv.a, "Outra")
    assert c.patch(f"/api/v1/assets/{p.asset_id}", json={"version": 2, "room_id": str(room_other), "location_id": None},
                   headers=h(ADM)).status_code == 200
    r = c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 3}, headers=h(ADM))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "version_conflict"
    assert mv.w.row(p.asset_id).unit_id == mv.a and mv.w.mov(p.mid).status == "PENDENTE"


def test_aprovacao_de_bem_excluido_depois_da_solicitacao(mv):
    p = _pending_transfer(mv)
    assert mv.client.post(f"/api/v1/assets/{p.asset_id}/delete", json={"version": 1},
                          headers=h(ADM)).status_code == 200
    r = mv.client.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 2}, headers=h(ADM))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "asset_unavailable"
    assert mv.w.mov(p.mid).status == "PENDENTE" and mv.w.row(p.asset_id).unit_id == mv.a


def test_aprovacao_exige_escopo_de_origem_e_destino_e_alvo_alheio_e_404(mv):
    p = _pending_transfer(mv)
    c = mv.client
    # ADM só da unidade A enxerga a movimentação (origem) mas não aprova: 403 + evento
    r = c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1}, headers=h(ADM_A))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden"
    r = c.post(f"/api/v1/movements/{p.mid}/reject", json={}, headers=h(ADM_A))
    assert r.status_code == 403
    assert len(types(mv, "ACCESS_DENIED")) == 2 and mv.w.mov(p.mid).status == "PENDENTE"
    # ADM sem nenhuma das unidades: 404 uniforme
    outsider_unit = mv.w.unit("Z")
    mv.w.user("Adm Z", role="ADM", units=[outsider_unit], auth_user_id="auth-adm-z")
    results = []
    for target in (p.mid, str(uuid.uuid4()), "nao-e-uuid"):
        r = c.post(f"/api/v1/movements/{target}/approve", json={"asset_version": 1}, headers=h("auth-adm-z"))
        results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)


def test_aprovacao_valida_corpo_estrito(mv):
    p = _pending_transfer(mv)
    c = mv.client
    for body in ({}, {"asset_version": None}, {"asset_version": 1, "status": "APROVADA"},
                 {"asset_version": 1, "approved_by": str(uuid.uuid4())}, {"asset_version": "1"}):
        r = c.post(f"/api/v1/movements/{p.mid}/approve", json=body, headers=h(ADM))
        assert r.status_code == 400, body
    assert mv.w.mov(p.mid).status == "PENDENTE" and mv.w.row(p.asset_id).version == 1


def test_aprovacao_com_falha_no_meio_faz_rollback_total(mv):
    p = _pending_transfer(mv)
    boom = IntegrityError("UPDATE assets", {}, Exception("UNIQUE constraint failed"))
    with _flush_raises_for_asset(boom):
        r = mv.client.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1}, headers=h(ADM))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "conflict"
    assert "unique" not in r.get_data(as_text=True).lower()
    asset = mv.w.row(p.asset_id)
    assert asset.unit_id == mv.a and asset.version == 1 and asset.room_id == p.room_a
    moved = mv.w.mov(p.mid)
    assert moved.status == "PENDENTE" and moved.approved_by is None and moved.approved_at is None
    assert mv.w.audit_rows("MOVEMENT_APPROVED") == [] and mv.w.audit_rows("ASSET_MOVED") == []
    # corrida do ORM (StaleDataError) vira version_conflict
    from sqlalchemy.orm.exc import StaleDataError

    with _flush_raises_for_asset(StaleDataError()):
        r = mv.client.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1}, headers=h(ADM))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "version_conflict"
    assert mv.w.mov(p.mid).status == "PENDENTE"
    # depois da falha, a aprovação normal funciona
    assert mv.client.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1},
                          headers=h(ADM)).status_code == 200


# ---------------------------------------------------------------------------
# Rejeição e cancelamento
# ---------------------------------------------------------------------------


def test_rejeicao_nao_altera_o_bem_e_libera_nova_solicitacao(mv):
    p = _pending_transfer(mv)
    c = mv.client
    r = c.post(f"/api/v1/movements/{p.mid}/reject", json={"reason": "sem espaço"}, headers=h(ADM))
    assert r.status_code == 200 and r.get_json()["status"] == "REJEITADA"
    assert r.get_json()["approved_by"] == str(mv.adm) and r.get_json()["completed_at"] is None
    assert mv.w.row(p.asset_id).unit_id == mv.a and mv.w.row(p.asset_id).version == 1
    assert c.post(f"/api/v1/movements/{p.mid}/approve", json={"asset_version": 1},
                  headers=h(ADM)).status_code == 409
    assert request(mv, USER_AB, p.asset_id, mv.b).status_code == 201  # sem pendente
    assert len(mv.w.audit_rows("MOVEMENT_REJECTED")) == 1
    # corpo vazio/ausente é aceito; campo extra não
    other = mv.w.asset(mv.a, "RJ-2")
    mid = request(mv, USER_AB, other, mv.b).get_json()["id"]
    assert c.post(f"/api/v1/movements/{mid}/reject", json={"status": "APROVADA"}, headers=h(ADM)).status_code == 400
    assert c.post(f"/api/v1/movements/{mid}/reject", headers=h(ADM)).status_code == 200


def test_cancelamento_so_solicitante_ou_adm(mv):
    asset_id = mv.w.asset(mv.a, "CN-1")
    c = mv.client
    mid = request(mv, USER_A, asset_id, mv.a, destination_room_id=str(mv.w.room(mv.a, "R"))).get_json()["id"]
    # outro USER da mesma unidade enxerga mas não cancela
    r = c.post(f"/api/v1/movements/{mid}/cancel", json={}, headers=h(USER_A2))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden"
    assert len(types(mv, "ACCESS_DENIED")) == 1
    # USER fora do escopo: 404 uniforme
    r = c.post(f"/api/v1/movements/{mid}/cancel", json={}, headers=h(USER_B))
    assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    assert mv.w.mov(mid).status == "PENDENTE"
    ok = c.post(f"/api/v1/movements/{mid}/cancel", json={"reason": "engano"}, headers=h(USER_A))
    assert ok.status_code == 200 and ok.get_json()["status"] == "CANCELADA"
    assert ok.get_json()["approved_by"] is None and mv.w.row(asset_id).version == 1
    again = c.post(f"/api/v1/movements/{mid}/cancel", json={}, headers=h(USER_A))
    assert again.status_code == 409 and again.get_json()["error"]["code"] == "invalid_transition"
    # ADM cancela pedido de outro
    mid2 = request(mv, USER_A, asset_id, mv.a, destination_room_id=str(mv.w.room(mv.a, "R2"))).get_json()["id"]
    assert c.post(f"/api/v1/movements/{mid2}/cancel", json={}, headers=h(ADM_A)).status_code == 200
    assert c.post(f"/api/v1/movements/{mid2}/cancel", json={"status": "x"}, headers=h(ADM_A)).status_code == 400


# ---------------------------------------------------------------------------
# Leitura
# ---------------------------------------------------------------------------


def test_leitura_idor_alvo_alheio_inexistente_e_malformado_mesma_resposta(mv):
    asset_id = mv.w.asset(mv.a, "ID-1")
    mid = request(mv, USER_A, asset_id, mv.a, destination_room_id=str(mv.w.room(mv.a, "R"))).get_json()["id"]
    results = []
    for target in (mid, str(uuid.uuid4()), "nao-e-uuid"):
        r = mv.client.get(f"/api/v1/movements/{target}", headers=h(USER_B))
        results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results) and mid not in json.dumps(results)
    assert len(types(mv, "UNIT_SCOPE_DENIED")) == 2  # os 2 UUIDs válidos; o malformado nem casa a rota
    assert mv.client.get(f"/api/v1/movements/{mid}?foo=1", headers=h(USER_A)).status_code == 400


def test_listagem_escopo_origem_ou_destino_filtros_ordenacao_e_paginacao(mv):
    c = mv.client
    a1 = mv.w.asset(mv.a, "LS-1")
    a2 = mv.w.asset(mv.a, "LS-2")
    b1 = mv.w.asset(mv.b, "LS-3")
    m1 = request(mv, USER_AB, a1, mv.b).get_json()["id"]  # A -> B
    m2 = request(mv, USER_AB, a2, mv.a, destination_room_id=str(mv.w.room(mv.a, "R"))).get_json()["id"]  # A -> A
    m3 = request(mv, USER_AB, b1, mv.a).get_json()["id"]  # B -> A
    c.post(f"/api/v1/movements/{m2}/cancel", json={}, headers=h(USER_AB))

    def ids(sub, query=""):
        body = c.get(f"/api/v1/movements?{query}", headers=h(sub)).get_json()
        return {x["id"] for x in body["movements"]}

    assert ids(USER_AB) == {m1, m2, m3}
    assert ids(USER_A) == {m1, m2, m3}  # A é origem ou destino de todos
    assert ids(USER_B) == {m1, m3}  # B é destino de m1 e origem de m3
    assert ids(RH_B) == {m1, m3}
    lone = mv.w.user("Sem unidade", role="USER", units=[], auth_user_id="auth-lone")
    assert ids("auth-lone") == set() and lone
    assert ids(USER_AB, "status=CANCELADA") == {m2} and ids(USER_AB, "status=PENDENTE") == {m1, m3}
    assert ids(USER_AB, f"asset_id={a1}") == {m1}
    assert ids(USER_AB, f"origin_unit_id={mv.b}") == {m3}
    assert ids(USER_AB, f"destination_unit_id={mv.b}") == {m1}
    assert ids(USER_B, f"origin_unit_id={mv.a}") == {m1}  # filtro nunca amplia o escopo
    local_today = datetime.now(LOCAL_TZ).date()
    today, tomorrow = local_today, local_today + timedelta(days=2)
    assert ids(USER_AB, f"created_from={today}") == {m1, m2, m3}
    assert ids(USER_AB, f"created_from={tomorrow}") == set()
    assert ids(USER_AB, f"created_to={local_today - timedelta(days=2)}") == set()
    assert ids(USER_AB, f"created_to={tomorrow}") == {m1, m2, m3}
    page = c.get("/api/v1/movements?page=2&page_size=2&sort=created_at", headers=h(USER_AB)).get_json()
    assert page["total"] == 3 and len(page["movements"]) == 1 and page["page"] == 2
    asc = c.get("/api/v1/movements?sort=status", headers=h(USER_AB)).get_json()["movements"]
    assert [x["status"] for x in asc] == ["CANCELADA", "PENDENTE", "PENDENTE"]


@pytest.mark.parametrize("query", [
    "foo=1", "sort=reason", "sort=name;drop", "page=0", "page_size=101", "status=XYZ", "status=pendente",
    "asset_id=x", "origin_unit_id=1", "created_from=2024-13-45", "created_from=1700000000",
    "created_to=ontem", "status=PENDENTE&status=APROVADA", "requested_by=" + str(uuid.uuid4()),
    "reason=a", "deleted_at=2020-01-01", "include_deleted=true",
    "movement_type=X", "movement_type=mudanca_sala", "movement_type=",
    "movement_type=MUDANCA_SALA&movement_type=TROCA_RESPONSAVEL",
])
def test_listagem_rejeita_fora_da_allowlist(mv, query):
    r = mv.client.get(f"/api/v1/movements?{query}", headers=h(ADM))
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"


def _set_created(mv, movement_id, when_utc):
    with mv.w.session() as db:
        # Core (o ORM bloqueia mudança de histórico por design)
        db.execute(update(AssetMovement).where(AssetMovement.id == uuid.UUID(movement_id))
                   .values(created_at=when_utc))


def test_filtro_de_data_usa_dia_civil_araguaina_borda_22h_a_02h(mv):
    a1, a2, a3 = (mv.w.asset(mv.a, f"DT-{i}") for i in range(3))
    m_late = request(mv, USER_AB, a1, mv.b).get_json()["id"]
    m_early = request(mv, USER_AB, a2, mv.b).get_json()["id"]
    m_edge = request(mv, USER_AB, a3, mv.b).get_json()["id"]
    # 22h do dia 10 em Araguaina = 01h UTC do dia 11
    _set_created(mv, m_late, datetime(2025, 3, 11, 1, 0, tzinfo=timezone.utc))
    # 02h do dia 11 em Araguaina = 05h UTC do dia 11
    _set_created(mv, m_early, datetime(2025, 3, 11, 5, 0, tzinfo=timezone.utc))
    # 00h00 local do dia 11 = 03h00 UTC (inclusivo); 23h59 local do dia 10 = 02h59 UTC
    _set_created(mv, m_edge, datetime(2025, 3, 11, 3, 0, tzinfo=timezone.utc))

    def ids(query):
        body = mv.client.get(f"/api/v1/movements?{query}", headers=h(USER_AB)).get_json()
        return {x["id"] for x in body["movements"]}

    assert ids("created_from=2025-03-10&created_to=2025-03-10") == {m_late}
    assert ids("created_from=2025-03-11&created_to=2025-03-11") == {m_early, m_edge}
    assert ids("created_from=2025-03-11") == {m_early, m_edge}
    assert ids("created_to=2025-03-10") == {m_late}
    assert ids("created_to=2025-03-09") == set()
    _set_created(mv, m_edge, datetime(2025, 3, 11, 2, 59, 59, tzinfo=timezone.utc))
    assert ids("created_from=2025-03-11") == {m_early}  # 23:59:59 do dia 10 local
    _set_created(mv, m_edge, datetime(2025, 3, 12, 3, 0, tzinfo=timezone.utc))  # 00:00 do dia 12
    assert ids("created_from=2025-03-11&created_to=2025-03-11") == {m_early}  # fim exclusivo


def test_filtro_movement_type_com_escopo_preservado(mv):
    a1 = mv.w.asset(mv.a, "TP-1")
    b1 = mv.w.asset(mv.b, "TP-2")
    transfer = request(mv, USER_AB, a1, mv.b).get_json()["id"]
    room_change = request(mv, USER_AB, b1, mv.b, destination_room_id=str(mv.w.room(mv.b, "R"))).get_json()["id"]

    def ids(sub, query):
        r = mv.client.get(f"/api/v1/movements?{query}", headers=h(sub))
        assert r.status_code == 200
        return {x["id"] for x in r.get_json()["movements"]}

    assert ids(USER_AB, "movement_type=TRANSFERENCIA_UNIDADE") == {transfer}
    assert ids(USER_AB, "movement_type=MUDANCA_SALA") == {room_change}
    assert ids(USER_AB, "movement_type=TROCA_RESPONSAVEL") == set()
    # USER_A só enxerga o que toca a unidade A: o filtro nunca amplia o escopo
    assert ids(USER_A, "movement_type=MUDANCA_SALA") == set()
    assert ids(USER_A, "movement_type=TRANSFERENCIA_UNIDADE") == {transfer}


def test_rh_nao_recebe_motivo_nem_autoria(mv):
    asset_id = mv.w.asset(mv.a, "RH-1")
    mid = request(mv, USER_AB, asset_id, mv.b, reason="motivo sigiloso").get_json()["id"]
    mv.client.post(f"/api/v1/movements/{mid}/approve", json={"asset_version": 1}, headers=h(ADM))
    listing = mv.client.get("/api/v1/movements", headers=h(RH_A))
    one = mv.client.get(f"/api/v1/movements/{mid}", headers=h(RH_A))
    assert listing.status_code == 200 and one.status_code == 200
    for payload in (listing.get_json()["movements"][0], one.get_json()):
        for key in ("reason", "requested_by", "approved_by"):
            assert key not in payload
        assert payload["status"] == "APROVADA" and payload["asset"]["patrimony_number"] == "RH-1"
    assert "motivo sigiloso" not in listing.get_data(as_text=True) + one.get_data(as_text=True)
    full = mv.client.get(f"/api/v1/movements/{mid}", headers=h(USER_A)).get_json()
    assert full["reason"] == "motivo sigiloso" and full["requested_by"] == str(mv.user_ab)


# ---------------------------------------------------------------------------
# Imutabilidade do histórico
# ---------------------------------------------------------------------------


def test_historico_e_imutavel_no_orm(mv):
    p = _pending_transfer(mv)
    with pytest.raises(RuntimeError):  # conteúdo nunca muda
        with mv.w.session() as db:
            db.get(AssetMovement, uuid.UUID(p.mid)).reason = "adulterado"
    with pytest.raises(RuntimeError):  # estado inválido
        with mv.w.session() as db:
            db.get(AssetMovement, uuid.UUID(p.mid)).status = "CONCLUIDA"
    with pytest.raises(RuntimeError):  # decisão sem mudança de estado
        with mv.w.session() as db:
            db.get(AssetMovement, uuid.UUID(p.mid)).approved_by = mv.adm
    with pytest.raises(RuntimeError):  # nunca apagar
        with mv.w.session() as db:
            db.delete(db.get(AssetMovement, uuid.UUID(p.mid)))
    assert mv.client.post(f"/api/v1/movements/{p.mid}/reject", json={}, headers=h(ADM)).status_code == 200
    with pytest.raises(RuntimeError):  # estado terminal não muda mais
        with mv.w.session() as db:
            db.get(AssetMovement, uuid.UUID(p.mid)).status = "APROVADA"
    row = mv.w.mov(p.mid)
    assert row.status == "REJEITADA" and row.reason is None


# ---------------------------------------------------------------------------
# Regressão (Tarefa A): mudar só a sala revalida o local atual
# ---------------------------------------------------------------------------


def test_mudar_so_a_sala_revalida_o_local_atual_409(mv):
    room1, room2 = mv.w.room(mv.a, "S1"), mv.w.room(mv.a, "S2")
    loc = mv.w.location(mv.a, "Armário", room_id=room1)
    free = mv.w.location(mv.a, "Livre", room_id=None)
    asset_id = mv.w.asset(mv.a, "RM-1", room_id=room1, location_id=loc)
    free_asset = mv.w.asset(mv.a, "RM-2", room_id=room1, location_id=free)
    c = mv.client
    r = c.patch(f"/api/v1/assets/{asset_id}", json={"version": 1, "room_id": str(room2)}, headers=h(USER_A))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "link_unit_mismatch"
    row = mv.w.row(asset_id)
    assert row.room_id == room1 and row.version == 1
    # sala igual ao local: continua válido; local sem sala não conflita; limpar o local junto resolve
    assert c.patch(f"/api/v1/assets/{free_asset}", json={"version": 1, "room_id": str(room2)},
                   headers=h(USER_A)).status_code == 200
    ok = c.patch(f"/api/v1/assets/{asset_id}", json={"version": 1, "room_id": str(room2), "location_id": None},
                 headers=h(USER_A))
    assert ok.status_code == 200 and ok.get_json()["room_id"] == str(room2) and ok.get_json()["location_id"] is None
