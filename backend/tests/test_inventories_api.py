"""API de inventários `/api/v1/inventories` e de locais `/api/v1/locations` (ponta a ponta).

SQLite com o schema real dos modelos + `require_auth` real, Redis falso, sem rede. A matriz
401/perfil/AAL2 por rota está em `test_sec_route_inventory.py`; aqui: fluxo, escopo, IDOR,
transições, conferência duplicada, inventário fechado, bem excluído, mass assignment,
atomicidade, imutabilidade e locais.
"""
from __future__ import annotations

import json
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine, select, text
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import DefaultClause

import app.models  # noqa: F401
from app import create_app
from app.database.session import Base
from app.models.assets import Asset
from app.models.audit import AuditLog
from app.models.inventory import Inventory, InventoryItem
from app.models.rbac import Permission, Role, RolePermission
from app.models.units import Location
from test_user_admin_db import FakeRedis, World, auth_headers

TABLES = (
    "users", "roles", "permissions", "role_permissions", "user_roles", "units",
    "user_unit_access", "audit_logs", "rooms", "responsible_people", "locations", "assets",
    "inventories", "inventory_items",
)
PERMS = {
    "ADM": ("units.read", "inventory.create", "inventory.check"),
    "USER": ("units.read", "inventory.check"),
    "RH": ("units.read",),
}
NOT_FOUND = {"error": {"code": "not_found", "message": "Recurso não encontrado."}}
ADM, USER_A, USER_B, RH_A = "auth-adm", "auth-user-a", "auth-user-b", "auth-rh-a"
ADM_A = "auth-adm-a"


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


class InvWorld(World):
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

    def location(self, unit_id, name, *, active=True) -> uuid.UUID:
        location_id = uuid.uuid4()
        with self.session() as db:
            db.add(Location(id=location_id, unit_id=unit_id, name=name, active=active))
        return location_id

    def audit_rows(self, operation: str) -> list[AuditLog]:
        with self.session() as db:
            return list(db.execute(select(AuditLog).where(AuditLog.operation == operation)).scalars())

    def inv(self, inventory_id) -> Inventory:
        with self.session() as db:
            return db.get(Inventory, uuid.UUID(str(inventory_id)))

    def items(self) -> list[InventoryItem]:
        with self.session() as db:
            return list(db.execute(select(InventoryItem)).scalars())

    def asset_row(self, asset_id) -> Asset:
        with self.session() as db:
            return db.get(Asset, asset_id)


@pytest.fixture()
def iv():
    world = InvWorld(_build_engine())
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        for target in ("app.api.v1.inventories.get_db_session", "app.api.v1.locations.get_db_session",
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
            user_b=world.user("User B", role="USER", units=[b], auth_user_id=USER_B),
            rh_a=world.user("Rh A", role="RH", units=[a], auth_user_id=RH_A),
        )


def h(sub, **kw):
    return auth_headers(sub, **kw)


def types(iv, name):
    return [e for e in iv.events if e["event_type"] == name]


def create(iv, sub=ADM, unit=None, **extra):
    body = {"name": "Inventário 2026", "unit_id": str(unit or iv.a), **extra}
    return iv.client.post("/api/v1/inventories", json=body, headers=h(sub))


def started(iv, sub=ADM, unit=None) -> str:
    inv_id = create(iv, sub, unit).get_json()["id"]
    assert iv.client.post(f"/api/v1/inventories/{inv_id}/start", json={}, headers=h(sub)).status_code == 200
    return inv_id


def check(iv, inv_id, asset_id, sub=USER_A, **extra):
    body = {"asset_id": str(asset_id), "found": True, **extra}
    return iv.client.post(f"/api/v1/inventories/{inv_id}/items", json=body, headers=h(sub))


# ---------------------------------------------------------------------------
# Perfis, AAL2 e métodos
# ---------------------------------------------------------------------------


def test_perfis_criar_so_adm_conferir_adm_e_user_rh_nada(iv):
    c = iv.client
    assert create(iv, USER_A).status_code == 403
    assert create(iv, RH_A).status_code == 403
    assert create(iv, ADM_A).status_code == 201
    inv_id = create(iv, ADM).get_json()["id"]
    for action in ("start", "close", "cancel"):
        assert c.post(f"/api/v1/inventories/{inv_id}/{action}", json={}, headers=h(USER_A)).status_code == 403
    assert c.get("/api/v1/inventories", headers=h(RH_A)).status_code == 403
    assert c.get(f"/api/v1/inventories/{inv_id}", headers=h(RH_A)).status_code == 403
    assert c.get("/api/v1/inventories", headers=h(USER_A)).status_code == 200
    assert iv.w.inv(inv_id).status == "ABERTO"
    for method in ("put", "patch", "delete"):
        for path in (f"/api/v1/inventories/{inv_id}", "/api/v1/inventories", f"/api/v1/inventories/{inv_id}/items"):
            assert getattr(c, method)(path, headers=h(ADM), json={}).status_code == 405


def test_adm_exige_aal2_e_user_nao(iv):
    c = iv.client
    inv_id = started(iv)
    aal1 = h(ADM, aal="aal1")
    calls = [
        ("get", "/api/v1/inventories", None), ("get", f"/api/v1/inventories/{inv_id}", None),
        ("get", f"/api/v1/inventories/{inv_id}/summary", None),
        ("get", f"/api/v1/inventories/{inv_id}/items", None),
        ("post", "/api/v1/inventories", {"name": "x", "unit_id": str(iv.a)}),
        ("post", f"/api/v1/inventories/{inv_id}/items", {"asset_id": str(uuid.uuid4()), "found": True}),
        ("post", f"/api/v1/inventories/{inv_id}/close", {}),
        ("post", f"/api/v1/inventories/{inv_id}/cancel", {}),
    ]
    for method, path, body in calls:
        kwargs = {"json": body} if body is not None else {}
        r = getattr(c, method)(path, headers=aal1, **kwargs)
        assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED", path
    assert iv.w.inv(inv_id).status == "EM_ANDAMENTO" and iv.w.items() == []
    assert c.get("/api/v1/inventories", headers=h(USER_A, aal="aal1")).status_code == 200
    asset_id = iv.w.asset(iv.a, "AAL-1")
    assert check(iv, inv_id, asset_id, sub=USER_A).status_code == 201


# ---------------------------------------------------------------------------
# Criação, escopo e IDOR
# ---------------------------------------------------------------------------


def test_criacao_grava_autoria_do_servidor_e_audita(iv):
    r = create(iv, ADM, iv.a, start_date="2026-03-01")
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["status"] == "ABERTO" and body["unit_id"] == str(iv.a)
    assert body["created_by"] == str(iv.adm) and body["start_date"] == "2026-03-01"
    assert body["closed_at"] is None and body["unit"]["code"] == "A"
    audits = iv.w.audit_rows("INVENTORY_CREATED")
    assert len(audits) == 1 and audits[0].actor_user_id == iv.adm


def test_criacao_em_unidade_alheia_inexistente_malformada_mesma_404(iv):
    results = []
    for unit in (str(iv.b), str(uuid.uuid4()), "lixo"):
        r = iv.client.post("/api/v1/inventories", json={"name": "x", "unit_id": unit}, headers=h(ADM_A))
        results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)
    assert len(types(iv, "UNIT_SCOPE_DENIED")) == 3
    with iv.w.session() as db:
        assert db.execute(select(Inventory)).first() is None


def test_criacao_em_unidade_inativa_409(iv):
    inactive = iv.w.unit("Z", active=False)
    with iv.w.session() as db:
        from app.models.units import UserUnitAccess
        db.add(UserUnitAccess(id=uuid.uuid4(), user_id=iv.adm, unit_id=inactive))
    r = create(iv, ADM, inactive)
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "unit_inactive"


def test_leitura_com_escopo_e_idor_uniforme(iv):
    mine = create(iv, ADM, iv.a).get_json()["id"]
    foreign = create(iv, ADM, iv.b).get_json()["id"]
    listing = iv.client.get("/api/v1/inventories", headers=h(USER_A)).get_json()
    assert [i["id"] for i in listing["inventories"]] == [mine] and listing["total"] == 1
    responses = []
    for target in (foreign, str(uuid.uuid4())):
        for suffix in ("", "/summary", "/items"):
            r = iv.client.get(f"/api/v1/inventories/{target}{suffix}", headers=h(USER_A))
            responses.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in responses)
    assert iv.client.get("/api/v1/inventories/lixo", headers=h(USER_A)).status_code == 404
    r = iv.client.post(f"/api/v1/inventories/{foreign}/start", json={}, headers=h(ADM_A))
    assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    assert iv.w.inv(foreign).status == "ABERTO"


def test_filtros_allowlist_e_parametros_invalidos(iv):
    create(iv, ADM, iv.a)
    c = iv.client
    assert c.get("/api/v1/inventories?status=ABERTO&sort=name", headers=h(ADM)).status_code == 200
    assert c.get("/api/v1/inventories?status=XYZ", headers=h(ADM)).status_code == 400
    assert c.get("/api/v1/inventories?sort=unit_id", headers=h(ADM)).status_code == 400
    assert c.get("/api/v1/inventories?foo=1", headers=h(ADM)).status_code == 400
    assert c.get("/api/v1/inventories?status=ABERTO&status=CONCLUIDO", headers=h(ADM)).status_code == 400
    assert c.get("/api/v1/inventories?page_size=1000", headers=h(ADM)).status_code == 400


# ---------------------------------------------------------------------------
# Mass assignment
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field,value", [
    ("status", "CONCLUIDO"), ("created_by", str(uuid.uuid4())), ("id", str(uuid.uuid4())),
    ("closed_at", "2020-01-01T00:00:00Z"), ("created_at", "2020-01-01T00:00:00Z"),
    ("version", 5), ("role", "ADM"),
])
def test_mass_assignment_na_criacao(iv, field, value):
    r = create(iv, ADM, iv.a, **{field: value})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(iv, "PRIVILEGE_ESCALATION_ATTEMPT")) + len(types(iv, "MASS_ASSIGNMENT_REJECTED")) == 1
    with iv.w.session() as db:
        assert db.execute(select(Inventory)).first() is None


@pytest.mark.parametrize("field,value", [
    ("checked_by", str(uuid.uuid4())), ("checked_at", "2020-01-01T00:00:00Z"), ("id", str(uuid.uuid4())),
    ("inventory_id", str(uuid.uuid4())), ("status", "CONCLUIDO"), ("result", "ENCONTRADO"),
    ("version", 2), ("unit_id", str(uuid.uuid4())),
])
def test_mass_assignment_na_conferencia(iv, field, value):
    inv_id = started(iv)
    asset_id = iv.w.asset(iv.a, "MA-1")
    r = check(iv, inv_id, asset_id, **{field: value})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "validation_error"
    assert len(types(iv, "PRIVILEGE_ESCALATION_ATTEMPT")) + len(types(iv, "MASS_ASSIGNMENT_REJECTED")) == 1
    assert iv.w.items() == []


def test_acao_rejeita_campos_extras(iv):
    inv_id = create(iv).get_json()["id"]
    r = iv.client.post(f"/api/v1/inventories/{inv_id}/start", json={"status": "CONCLUIDO"}, headers=h(ADM))
    assert r.status_code == 400 and iv.w.inv(inv_id).status == "ABERTO"


@pytest.mark.parametrize("payload", [
    {}, {"name": "x"}, {"unit_id": "{a}"}, {"name": "", "unit_id": "{a}"}, {"name": "x" * 201, "unit_id": "{a}"},
    {"name": "x", "unit_id": "{a}", "start_date": "01/03/2026"}, {"name": "x", "unit_id": "{a}", "start_date": "2026-13-45"},
    {"name": 5, "unit_id": "{a}"},
])
def test_validacao_da_criacao(iv, payload):
    body = json.loads(json.dumps(payload).replace("{a}", str(iv.a)))
    r = iv.client.post("/api/v1/inventories", json=body, headers=h(ADM))
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Transições
# ---------------------------------------------------------------------------


def test_fluxo_completo_e_encerramento_imutavel(iv):
    inv_id = create(iv).get_json()["id"]
    c = iv.client
    r = c.post(f"/api/v1/inventories/{inv_id}/start", json={}, headers=h(ADM))
    assert r.status_code == 200 and r.get_json()["status"] == "EM_ANDAMENTO"
    r = c.post(f"/api/v1/inventories/{inv_id}/close", json={"reason": "fim"}, headers=h(ADM))
    body = r.get_json()
    assert r.status_code == 200 and body["status"] == "CONCLUIDO"
    assert body["closed_at"] is not None and body["end_date"] is not None
    for action in ("start", "close", "cancel"):
        r = c.post(f"/api/v1/inventories/{inv_id}/{action}", json={}, headers=h(ADM))
        assert r.status_code == 409 and r.get_json()["error"]["code"] == "invalid_transition"
    ops = [a.operation for a in iv.w.audit_rows("INVENTORY_CLOSED")]
    assert ops == ["INVENTORY_CLOSED"]
    assert "fim" not in json.dumps(iv.w.audit_rows("INVENTORY_CLOSED")[0].new_values)


def test_transicoes_invalidas(iv):
    c = iv.client
    inv_id = create(iv).get_json()["id"]
    r = c.post(f"/api/v1/inventories/{inv_id}/close", json={}, headers=h(ADM))  # ABERTO -> CONCLUIDO
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "invalid_transition"
    assert c.post(f"/api/v1/inventories/{inv_id}/start", json={}, headers=h(ADM)).status_code == 200
    assert c.post(f"/api/v1/inventories/{inv_id}/start", json={}, headers=h(ADM)).status_code == 409
    assert c.post(f"/api/v1/inventories/{inv_id}/cancel", json={}, headers=h(ADM)).status_code == 200
    assert iv.w.inv(inv_id).status == "CANCELADO"
    assert c.post(f"/api/v1/inventories/{inv_id}/close", json={}, headers=h(ADM)).status_code == 409


def test_cancelar_inventario_aberto(iv):
    inv_id = create(iv).get_json()["id"]
    r = iv.client.post(f"/api/v1/inventories/{inv_id}/cancel", json={}, headers=h(ADM))
    assert r.status_code == 200 and r.get_json()["status"] == "CANCELADO"


def test_guarda_orm_impede_alterar_inventario_terminal(iv):
    inv_id = create(iv).get_json()["id"]
    iv.client.post(f"/api/v1/inventories/{inv_id}/cancel", json={}, headers=h(ADM))
    with pytest.raises(RuntimeError):
        with iv.w.session() as db:
            db.get(Inventory, uuid.UUID(inv_id)).status = "ABERTO"
    with pytest.raises(RuntimeError):
        with iv.w.session() as db:
            db.get(Inventory, uuid.UUID(inv_id)).name = "outro"


# ---------------------------------------------------------------------------
# Conferência
# ---------------------------------------------------------------------------


def test_conferencia_grava_conferidor_do_servidor_e_nao_altera_o_bem(iv):
    loc = iv.w.location(iv.a, "Almoxarifado")
    asset_id = iv.w.asset(iv.a, "C-1", location_id=loc)
    inv_id = started(iv)
    r = check(iv, inv_id, asset_id, notes="  ok   conferido ")
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["found"] is True and body["result"] == "ENCONTRADO"
    assert body["checked_by"] == str(iv.user_a) and body["notes"] == "ok conferido"
    assert body["asset"]["patrimony_number"] == "C-1"
    row = iv.w.asset_row(asset_id)  # decisão: o bem NÃO é alterado
    assert row.version == 1 and row.location_id == loc and row.updated_by is None
    audit = iv.w.audit_rows("INVENTORY_ITEM_CHECKED")[0]
    assert audit.actor_user_id == iv.user_a and audit.new_values["has_notes"] is True
    assert "conferido" not in json.dumps(audit.new_values)


def test_resultados_encontrado_nao_encontrado_divergente(iv):
    loc1, loc2 = iv.w.location(iv.a, "L1"), iv.w.location(iv.a, "L2")
    a1 = iv.w.asset(iv.a, "R-1", location_id=loc1)
    a2 = iv.w.asset(iv.a, "R-2", location_id=loc1)
    a3 = iv.w.asset(iv.a, "R-3", location_id=loc1)
    a4 = iv.w.asset(iv.a, "R-4")
    inv_id = started(iv)
    assert check(iv, inv_id, a1, observed_location_id=str(loc1)).get_json()["result"] == "ENCONTRADO"
    assert check(iv, inv_id, a2, observed_location_id=str(loc2)).get_json()["result"] == "DIVERGENTE"
    r = iv.client.post(f"/api/v1/inventories/{inv_id}/items", json={"asset_id": str(a3), "found": False},
                       headers=h(USER_A))
    assert r.get_json()["result"] == "NAO_ENCONTRADO"
    assert check(iv, inv_id, a4, observed_location_id=str(loc2)).get_json()["result"] == "DIVERGENTE"
    summary = iv.client.get(f"/api/v1/inventories/{inv_id}/summary", headers=h(USER_A)).get_json()
    assert summary["total_assets"] == 4 and summary["checked"] == 4 and summary["pending"] == 0
    assert (summary["found"], summary["not_found"], summary["divergent"]) == (1, 1, 2)
    assert summary["progress_percent"] == 100.0
    listing = iv.client.get(f"/api/v1/inventories/{inv_id}/items?result=DIVERGENTE", headers=h(USER_A)).get_json()
    assert listing["total"] == 2 and all(i["result"] == "DIVERGENTE" for i in listing["items"])


def test_nao_encontrado_com_local_observado_e_400(iv):
    loc = iv.w.location(iv.a, "L")
    asset_id = iv.w.asset(iv.a, "NF-1")
    inv_id = started(iv)
    r = iv.client.post(f"/api/v1/inventories/{inv_id}/items",
                       json={"asset_id": str(asset_id), "found": False, "observed_location_id": str(loc)},
                       headers=h(USER_A))
    assert r.status_code == 400


def test_resumo_calcula_pendentes_no_servidor(iv):
    ids = [iv.w.asset(iv.a, f"S-{i}") for i in range(4)]
    iv.w.asset(iv.b, "OUTRA-UNIDADE")
    deleted = iv.w.asset(iv.a, "S-DEL", deleted_at=datetime.now(timezone.utc), deleted_by=iv.adm)
    inv_id = started(iv)
    check(iv, inv_id, ids[0])
    s = iv.client.get(f"/api/v1/inventories/{inv_id}/summary", headers=h(USER_A)).get_json()
    assert (s["total_assets"], s["checked"], s["pending"], s["progress_percent"]) == (4, 1, 3, 25.0)
    assert deleted not in ids


def test_conferencia_duplicada_409_already_checked(iv):
    asset_id = iv.w.asset(iv.a, "D-1")
    inv_id = started(iv)
    assert check(iv, inv_id, asset_id).status_code == 201
    r = check(iv, inv_id, asset_id, found=False)
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "already_checked"
    assert len(iv.w.items()) == 1 and iv.w.items()[0].found is True


def test_conferencia_duplicada_por_corrida_vira_409(iv):
    """Violação do UNIQUE no flush (corrida) => already_checked, sem 500 e sem item extra."""
    asset_id = iv.w.asset(iv.a, "RACE-1")
    inv_id = started(iv)
    from app.services import inventory_service as svc

    original = svc.InventoryService._flush

    def flush_after_hidden_item(self, **kwargs):
        with iv.w.session() as db:  # outra transação já gravou a conferência
            db.add(InventoryItem(id=uuid.uuid4(), inventory_id=uuid.UUID(inv_id), asset_id=asset_id,
                                 found=True, checked_by=iv.user_a, checked_at=datetime.now(timezone.utc)))
        return original(self, **kwargs)

    with patch.object(svc.InventoryService, "_flush", flush_after_hidden_item):
        r = check(iv, inv_id, asset_id)
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "already_checked"
    assert len(iv.w.items()) == 1
    assert iv.w.audit_rows("INVENTORY_ITEM_CHECKED") == []


def test_inventario_nao_iniciado_e_encerrado_nao_aceitam_itens(iv):
    asset_id = iv.w.asset(iv.a, "ST-1")
    inv_id = create(iv).get_json()["id"]
    r = check(iv, inv_id, asset_id)
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "inventory_not_started"
    iv.client.post(f"/api/v1/inventories/{inv_id}/start", json={}, headers=h(ADM))
    iv.client.post(f"/api/v1/inventories/{inv_id}/close", json={}, headers=h(ADM))
    r = check(iv, inv_id, asset_id)
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "inventory_closed"
    cancelled = create(iv).get_json()["id"]
    iv.client.post(f"/api/v1/inventories/{cancelled}/cancel", json={}, headers=h(ADM))
    assert check(iv, cancelled, asset_id).get_json()["error"]["code"] == "inventory_closed"
    assert iv.w.items() == []


def test_bem_excluido_alheio_inexistente_e_malformado_mesma_404(iv):
    deleted = iv.w.asset(iv.a, "X-DEL", deleted_at=datetime.now(timezone.utc), deleted_by=iv.adm)
    foreign = iv.w.asset(iv.b, "X-B")
    inv_id = started(iv)
    results = []
    for target in (deleted, foreign, uuid.uuid4(), "lixo"):
        r = check(iv, inv_id, target)
        results.append((r.status_code, r.get_json()))
    assert all(res == (404, NOT_FOUND) for res in results)
    assert iv.w.items() == []


def test_local_observado_de_outra_unidade_inexistente_ou_inativo(iv):
    asset_id = iv.w.asset(iv.a, "L-1")
    foreign_loc = iv.w.location(iv.b, "Fora")
    inactive = iv.w.location(iv.a, "Inativo", active=False)
    inv_id = started(iv)
    for loc in (foreign_loc, uuid.uuid4(), "lixo"):
        r = check(iv, inv_id, asset_id, observed_location_id=str(loc))
        assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    r = check(iv, inv_id, asset_id, observed_location_id=str(inactive))
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "link_inactive"
    assert iv.w.items() == []


def test_user_so_confere_na_propria_unidade(iv):
    asset_b = iv.w.asset(iv.b, "UB-1")
    inv_b = started(iv, ADM, iv.b)
    r = check(iv, inv_b, asset_b, sub=USER_A)
    assert (r.status_code, r.get_json()) == (404, NOT_FOUND)
    assert iv.w.items() == []
    assert check(iv, inv_b, asset_b, sub=USER_B).status_code == 201


def test_guarda_orm_item_imutavel(iv):
    asset_id = iv.w.asset(iv.a, "IM-1")
    inv_id = started(iv)
    check(iv, inv_id, asset_id)
    with pytest.raises(RuntimeError):
        with iv.w.session() as db:
            db.execute(select(InventoryItem)).scalars().first().found = False
    with pytest.raises(RuntimeError):
        with iv.w.session() as db:
            db.delete(db.execute(select(InventoryItem)).scalars().first())


def test_atomicidade_falha_ao_auditar_nao_deixa_item(iv):
    asset_id = iv.w.asset(iv.a, "AT-1")
    inv_id = started(iv)
    from app.services import inventory_service as svc

    with patch.object(svc.InventoryService, "_audit", side_effect=RuntimeError("falha")):
        client = iv.client
        client.application.config["PROPAGATE_EXCEPTIONS"] = False
        r = check(iv, inv_id, asset_id)
    assert r.status_code == 500
    assert iv.w.items() == []


def test_paginacao_dos_itens(iv):
    ids = [iv.w.asset(iv.a, f"P-{i}") for i in range(3)]
    inv_id = started(iv)
    for i in ids:
        check(iv, inv_id, i)
    page = iv.client.get(f"/api/v1/inventories/{inv_id}/items?page=2&page_size=2", headers=h(USER_A)).get_json()
    assert page["total"] == 3 and len(page["items"]) == 1
    assert iv.client.get(f"/api/v1/inventories/{inv_id}/items?sort=notes", headers=h(USER_A)).status_code == 400


# ---------------------------------------------------------------------------
# Locais
# ---------------------------------------------------------------------------


def test_locais_listagem_escopo_filtros_e_perfis(iv):
    la = iv.w.location(iv.a, "Almoxarifado")
    iv.w.location(iv.a, "Arquivo", active=False)
    lb = iv.w.location(iv.b, "Depósito B")
    c = iv.client
    for sub in (USER_A, RH_A, ADM_A):
        body = c.get("/api/v1/locations", headers=h(sub)).get_json()
        assert {x["id"] for x in body["locations"]} == {str(la), *(x["id"] for x in body["locations"] if x["name"] == "Arquivo")}
        assert str(lb) not in json.dumps(body)
    assert c.get("/api/v1/locations", headers=h(ADM)).get_json()["total"] == 3
    only_active = c.get("/api/v1/locations?active=true", headers=h(ADM)).get_json()
    assert {x["name"] for x in only_active["locations"]} == {"Almoxarifado", "Depósito B"}
    assert c.get(f"/api/v1/locations?unit_id={iv.b}", headers=h(ADM)).get_json()["total"] == 1
    assert c.get(f"/api/v1/locations?unit_id={iv.b}", headers=h(USER_A)).get_json()["total"] == 0
    assert c.get("/api/v1/locations?q=almox", headers=h(ADM)).get_json()["total"] == 1
    assert c.get("/api/v1/locations?q=%25", headers=h(ADM)).get_json()["total"] == 0
    assert c.get("/api/v1/locations?sort=-name&page_size=1", headers=h(ADM)).get_json()["locations"][0]["name"] == "Depósito B"
    assert c.get(f"/api/v1/locations?room_id={uuid.uuid4()}", headers=h(ADM)).get_json()["total"] == 0


def test_locais_parametros_invalidos_e_aal2(iv):
    c = iv.client
    for query in ("foo=1", "active=sim", "sort=unit_id", "unit_id=lixo", "page=0", "page_size=101",
                  "active=true&active=false"):
        assert c.get(f"/api/v1/locations?{query}", headers=h(ADM)).status_code == 400, query
    assert c.get("/api/v1/locations", headers=h(ADM, aal="aal1")).get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert c.get("/api/v1/locations", headers=h(USER_A, aal="aal1")).status_code == 200
    for method in ("post", "put", "patch", "delete"):
        assert getattr(c, method)("/api/v1/locations", headers=h(ADM), json={}).status_code == 405


def test_local_por_id_404_uniforme(iv):
    mine = iv.w.location(iv.a, "Meu")
    foreign = iv.w.location(iv.b, "Alheio")
    c = iv.client
    ok = c.get(f"/api/v1/locations/{mine}", headers=h(USER_A))
    assert ok.status_code == 200 and ok.get_json()["unit_id"] == str(iv.a)
    results = [c.get(f"/api/v1/locations/{t}", headers=h(USER_A)) for t in (foreign, uuid.uuid4(), "lixo")]
    assert all((r.status_code, r.get_json()) == (404, NOT_FOUND) for r in results)
    assert len(types(iv, "UNIT_SCOPE_DENIED")) == 2
    assert c.get(f"/api/v1/locations/{mine}?x=1", headers=h(USER_A)).status_code == 400
