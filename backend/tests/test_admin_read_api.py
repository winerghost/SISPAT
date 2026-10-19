"""APIs administrativas de LEITURA: auditoria, perfis/permissões e vínculos de unidades.

Banco SQLite com schema real + carregador de usuário REAL de `require_auth`
(ver `test_user_admin_db.py`). Cobre: 401/403 por perfil, AAL2, permissão,
parâmetros desconhecidos/repetidos, allowlists, janela de datas, escopo de
unidade, 404 uniforme, ausência de PII/segredos (resposta e SQL), evento
`AUDIT_VIEWED` e imutabilidade (somente leitura).
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import func, select
from test_user_admin_db import (  # noqa: F401  (fixtures)
    api,
    auth_headers,
    recent_totp_amr,
    world,
)

from app.models.audit import AuditLog
from app.models.rbac import Permission, RolePermission

ADM_SUB = "auth-adm-principal"
USER_SUB = "auth-user-a"
RH_SUB = "auth-rh-a"
ADM_B_SUB = "auth-adm-b"

SECRET_EMAIL = "joao.segredo@exemplo.invalid"
SECRET_IP = "203.0.113.77"
SECRET_TOKEN = "eyJhbGciOiJIUzI1NiJ9." + "A" * 60 + ".assinatura"
FREE_TEXT = "texto livre com dados pessoais"

AUDIT_ROUTES = [
    "/api/v1/admin/audit-logs",
    f"/api/v1/admin/audit-logs/{uuid.uuid4()}",
]
ALL_ROUTES = AUDIT_ROUTES + [
    "/api/v1/admin/roles",
    "/api/v1/admin/permissions",
    "/api/v1/admin/unit-access",
]


def _h(sub: str = ADM_SUB, **kwargs):
    kwargs.setdefault("amr", recent_totp_amr())
    return auth_headers(sub, **kwargs)


@pytest.fixture()
def scene(api):
    w = api.world
    with w.session() as db:  # `roles.manage` (seed 0002) ausente no harness base
        perm = Permission(id=uuid.uuid4(), code="roles.manage", resource="roles", action="manage",
                          description="Gerenciar papéis.")
        db.add(perm)
        db.add(RolePermission(id=uuid.uuid4(), role_id=w.roles["ADM"], permission_id=perm.id))
    a, b = w.unit("A"), w.unit("B")
    ns = SimpleNamespace(api=api, w=w, a=a, b=b)
    ns.actor = w.user("Adm Principal", role="ADM", units=[a], auth_user_id=ADM_SUB,
                      email="adm.principal@exemplo.invalid")
    ns.adm_b = w.user("Adm Beta", role="ADM", units=[b], auth_user_id=ADM_B_SUB)
    ns.user_a = w.user("Usuaria A", role="USER", units=[a], auth_user_id=USER_SUB,
                       email=SECRET_EMAIL)
    ns.rh_a = w.user("Rh Alfa", role="RH", units=[a], auth_user_id=RH_SUB)
    ns.user_b = w.user("Usuario B", role="USER", units=[b])
    ns.inactive_a = w.user("Inativo A", role="USER", units=[a], active=False)
    with patch("app.api.v1.admin_audit.get_db_session", w.session), patch(
        "app.api.v1.admin_access.get_db_session", w.session
    ):
        yield ns


def _log(w, *, actor=None, entity_type="user", entity_id=None, operation="USER_ROLE_CHANGED",
         previous=None, new=None, when=None, result="SUCESSO", request_id="req-abc123") -> uuid.UUID:
    log_id = uuid.uuid4()
    with w.session() as db:
        db.add(AuditLog(
            id=log_id, actor_user_id=actor, entity_type=entity_type,
            entity_id=entity_id, operation=operation, previous_values=previous,
            new_values=new, occurred_at=when or datetime.now(timezone.utc),
            request_id=request_id, result=result,
        ))
    return log_id


def _security(w, *, actor, severity="high", op="ACCESS_DENIED", when=None):
    return _log(
        w, actor=actor, entity_type="security_event", entity_id=str(uuid.uuid4()), operation=op,
        when=when, result="FALHA",
        new={
            "schema": "sispat.security_event/v1", "event_id": "e1", "event_type": op,
            "severity": severity, "notify": True, "actor_user_id": str(actor),
            "target": {"type": "user", "id": "x"},
            "request": {"request_id": "r1", "method": "GET", "path": "/api/v1/users", "ip": SECRET_IP},
            "result": "FALHA",
            "details": {"context": "users.get", "reason": "missing_permission",
                        "detail": SECRET_EMAIL, "token": SECRET_TOKEN,
                        "fields": ["role", FREE_TEXT], "unit_ids": ["u1"], "senha": "123456"},
        },
    )


@pytest.fixture()
def logs(scene):
    w = scene.w
    ns = SimpleNamespace()
    ns.business = _log(
        w, actor=scene.user_a, entity_id=str(scene.user_a),
        previous={"role": "USER", "email": SECRET_EMAIL, "reason": FREE_TEXT},
        new={"role": "RH", "token": SECRET_TOKEN, "reason": FREE_TEXT, "phone": "63999990000"},
    )
    ns.security = _security(w, actor=scene.user_a)
    ns.own = _log(w, actor=scene.actor, entity_type="unit", entity_id=str(scene.a),
                  operation="UNIT_UPDATED", previous={"active": True}, new={"active": False})
    ns.about_user_by_other = _log(w, actor=scene.adm_b, entity_id=str(scene.user_a),
                                  operation="USER_DEACTIVATED")
    ns.foreign = _log(w, actor=scene.user_b, entity_id=str(scene.user_b), operation="USER_ROLE_CHANGED")
    ns.foreign_unit = _log(w, actor=scene.adm_b, entity_type="unit", entity_id=str(scene.b),
                           operation="UNIT_UPDATED")
    ns.anonymous = _log(w, actor=None, entity_type="security_event", entity_id="anon-1",
                        operation="AUTH_FAILED", result="FALHA", new={"severity": "low"})
    return ns


def _get(scene, url, **kw):
    kw.setdefault("headers", _h())
    return scene.api.client.get(url, **kw)


def _route_sql(scene) -> str:
    """SQL emitido pelas rotas (exclui o carregador de autenticação, que lê o ator)."""
    return "\n".join(
        q for q in scene.api.queries if "users.auth_user_id = ?" not in q.lower()
    ).lower()


def _ids(response):
    return {item["id"] for item in response.get_json()["items"]}


# ---------------------------------------------------------------------------
# Autenticação, perfil, AAL2, permissão
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("url", ALL_ROUTES)
def test_sem_token_401_sem_tocar_dados(scene, url):
    response = scene.api.client.get(url)
    assert response.status_code == 401


@pytest.mark.parametrize("url", ALL_ROUTES)
@pytest.mark.parametrize("sub", [USER_SUB, RH_SUB])
def test_user_e_rh_negados_e_auditados(scene, url, sub):
    start = len(scene.api.events)
    response = _get(scene, url, headers=_h(sub))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "forbidden"
    assert any(e["event_type"] == "ACCESS_DENIED" for e in scene.api.events[start:])
    assert not any(e["event_type"] == "AUDIT_VIEWED" for e in scene.api.events)


@pytest.mark.parametrize("url", ALL_ROUTES)
def test_adm_sem_aal2_negado(scene, url):
    response = _get(scene, url, headers=auth_headers(ADM_SUB, aal="aal1"))
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert any(e["event_type"] == "AAL2_REQUIRED" for e in scene.api.events)


@pytest.mark.parametrize(
    "url,permission",
    [
        ("/api/v1/admin/audit-logs", "audit.read"),
        (AUDIT_ROUTES[1], "audit.read"),
        ("/api/v1/admin/roles", "roles.manage"),
        ("/api/v1/admin/permissions", "roles.manage"),
        ("/api/v1/admin/unit-access", "users.manage"),
    ],
)
def test_adm_sem_a_permissao_negado(scene, url, permission):
    with scene.w.session() as db:
        perm_id = db.execute(select(Permission.id).where(Permission.code == permission)).scalar_one()
        for link in db.execute(select(RolePermission).where(RolePermission.permission_id == perm_id)).scalars():
            db.delete(link)
    assert _get(scene, url).status_code == 403


@pytest.mark.parametrize("url", ALL_ROUTES)
@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_rotas_sao_somente_leitura(scene, logs, url, method):
    before = scene.w.audits()
    response = getattr(scene.api.client, method)(url, json={"x": 1}, headers=_h())
    assert response.status_code == 405
    assert len(scene.w.audits()) == len(before)


# ---------------------------------------------------------------------------
# Auditoria: escopo, projeção, PII
# ---------------------------------------------------------------------------


def test_lista_so_traz_registros_do_escopo_de_unidade(scene, logs):
    response = _get(scene, "/api/v1/admin/audit-logs")
    assert response.status_code == 200
    body = response.get_json()
    assert _ids(response) == {
        str(logs.business), str(logs.security), str(logs.own), str(logs.about_user_by_other),
    }
    assert body["total"] == 4 and body["page"] == 1 and body["page_size"] == 25
    assert set(body["window"]) == {"from", "to"}
    # autor de fora do escopo, unidade alheia e registro anônimo ficam de fora
    for hidden in (logs.foreign, logs.foreign_unit, logs.anonymous):
        assert str(hidden) not in response.get_data(as_text=True)
    assert [i["occurred_at"] for i in body["items"]] == sorted(
        (i["occurred_at"] for i in body["items"]), reverse=True
    )


def test_adm_sem_unidades_ve_lista_vazia(scene, logs):
    with scene.w.session() as db:
        from app.models.units import UserUnitAccess

        for link in db.execute(select(UserUnitAccess).where(UserUnitAccess.user_id == scene.actor)).scalars():
            db.delete(link)
    body = _get(scene, "/api/v1/admin/audit-logs").get_json()
    assert body["total"] == 0 and body["items"] == []


def test_resposta_e_sql_sem_pii_nem_segredos(scene, logs):
    scene.api.queries.clear()
    listing = _get(scene, "/api/v1/admin/audit-logs?page_size=100")
    detail_texts = [listing.get_data(as_text=True)]
    for item_id in (logs.business, logs.security, logs.own):
        detail = _get(scene, f"/api/v1/admin/audit-logs/{item_id}")
        assert detail.status_code == 200
        detail_texts.append(detail.get_data(as_text=True))
    blob = "\n".join(detail_texts)
    for forbidden in (
        SECRET_EMAIL, SECRET_IP, SECRET_TOKEN, "eyJ", FREE_TEXT, "63999990000", "123456",
        "Usuaria A", "Adm Principal", "@", "exemplo.invalid", "senha", "password",
    ):
        assert forbidden not in blob, forbidden
    sql = _route_sql(scene)
    assert "users.email" not in sql and "users.phone" not in sql and "auth_user_id" not in sql


def test_detalhe_de_negocio_projeta_so_chaves_da_allowlist(scene, logs):
    body = _get(scene, f"/api/v1/admin/audit-logs/{logs.business}").get_json()
    assert body["event_type"] == "USER_ROLE_CHANGED" and body["entity_type"] == "user"
    assert body["actor_user_id"] == str(scene.user_a)
    assert body["result"] == "SUCESSO" and body["request_id"] == "req-abc123"
    assert body["changes"] == {"role": {"from": "USER", "to": "RH"}}
    assert body["omitted_fields"] == 4  # email, reason, token, phone
    assert "actor" not in body and "previous_values" not in body and "new_values" not in body


def test_detalhe_de_evento_de_seguranca_redige_detalhes_e_ip(scene, logs):
    body = _get(scene, f"/api/v1/admin/audit-logs/{logs.security}").get_json()
    assert body["severity"] == "high" and body["target_type"] == "user"
    assert body["request"] == {"method": "GET", "path": "/api/v1/users", "network": "203.0.113.0/24"}
    assert body["details"] == {
        "context": "users.get",
        "reason": "missing_permission",
        "detail": "[redacted]",
        "fields": ["role", "[redacted]"],
        "unit_ids": ["u1"],
    }
    assert "token" not in body["details"] and "senha" not in body["details"]


def test_ipv6_so_expoe_a_rede():
    from app.services.admin_audit_service import mask_ip

    assert mask_ip("2001:db8:abcd:12::99") == "2001:db8:abcd::/48"
    assert mask_ip("nao-e-ip") is None and mask_ip(None) is None and mask_ip("10.1.2.3") == "10.1.2.0/24"


@pytest.mark.parametrize("target", ["alheio", "inexistente", "malformado"])
def test_detalhe_404_uniforme(scene, logs, target):
    urls = {
        "alheio": f"/api/v1/admin/audit-logs/{logs.foreign}",
        "inexistente": f"/api/v1/admin/audit-logs/{uuid.uuid4()}",
        "malformado": "/api/v1/admin/audit-logs/nao-e-uuid",
    }
    response = _get(scene, urls[target])
    assert response.status_code == 404
    assert response.get_json() == {"error": {"code": "not_found", "message": "Recurso não encontrado."}}
    assert str(logs.foreign) not in response.get_data(as_text=True)


def test_404_alheio_e_inexistente_mesmo_numero_de_consultas_e_evento(scene, logs):
    api = scene.api
    counts, events = {}, {}
    for label, target in (("alheio", logs.foreign), ("inexistente", uuid.uuid4())):
        q0, e0 = len(api.queries), len(api.events)
        _get(scene, f"/api/v1/admin/audit-logs/{target}")
        counts[label] = len(api.queries) - q0
        events[label] = [e for e in api.events[e0:] if e["event_type"] == "UNIT_SCOPE_DENIED"]
    assert counts["alheio"] == counts["inexistente"]
    assert len(events["alheio"]) == len(events["inexistente"]) == 1
    assert events["alheio"][0]["details"] == events["inexistente"][0]["details"]


def test_acesso_a_trilha_gera_audit_viewed_sem_payload(scene, logs):
    start = len(scene.api.events)
    assert _get(scene, "/api/v1/admin/audit-logs?event_type=ACCESS_DENIED&actor_user_id=" + str(scene.user_a)).status_code == 200
    assert _get(scene, f"/api/v1/admin/audit-logs/{logs.own}").status_code == 200
    viewed = [e for e in scene.api.events[start:] if e["event_type"] == "AUDIT_VIEWED"]
    assert len(viewed) == 2
    for event in viewed:
        assert event["actor_user_id"] == str(scene.actor) and event["result"] == "SUCESSO"
        assert event["details"] == {} and event["target"]["type"] == "audit_log"
        assert "ACCESS_DENIED" not in json.dumps(event) and str(scene.user_a) not in json.dumps(event)
    assert viewed[1]["target"]["id"] == str(logs.own)


def test_consulta_invalida_ou_negada_nao_gera_audit_viewed(scene, logs):
    _get(scene, "/api/v1/admin/audit-logs?foo=1")
    _get(scene, f"/api/v1/admin/audit-logs/{logs.foreign}")
    assert not any(e["event_type"] == "AUDIT_VIEWED" for e in scene.api.events)


# ---------------------------------------------------------------------------
# Auditoria: parâmetros, allowlists, janela
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        "foo=1",
        "role=ADM",
        "unit_id=" + str(uuid.uuid4()),
        "deleted_at=2020-01-01",
        "actor=1",
        "from_=2026-01-01",
        "to_=2026-01-01",
        "page=1&page=2",
        "event_type=ACCESS_DENIED&event_type=AUTH_FAILED",
        "sort=entity_id",
        "sort=-occurred_at;DROP",
        "page=0",
        "page=abc",
        "page_size=101",
        "page_size=0",
        "event_type=x%27%3B%20DROP%20TABLE%20audit_logs",
        "event_type=lower_case",
        "entity_type=User",
        "entity_id=" + "a" * 101,
        "entity_id=a%20b",
        "actor_user_id=nao-uuid",
        "result=DENIED",
        "severity=urgent",
        "from=ontem",
        "to=" + "9" * 41,
        "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
        "from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
        "from=2026-01-01T00:00:00Z&to=2026-04-02T00:00:01Z",
    ],
)
def test_parametros_invalidos_400(scene, logs, query):
    response = _get(scene, f"/api/v1/admin/audit-logs?{query}")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    for echoed in ("DROP", "ontem", "nao-uuid"):
        assert echoed not in response.get_json()["error"]["message"]


def test_parametro_desconhecido_gera_evento_de_mass_assignment(scene, logs):
    start = len(scene.api.events)
    assert _get(scene, "/api/v1/admin/audit-logs?role=ADM&foo=1").status_code == 400
    events = [e["event_type"] for e in scene.api.events[start:]]
    assert "PRIVILEGE_ESCALATION_ATTEMPT" in events or "MASS_ASSIGNMENT_REJECTED" in events


def test_janela_padrao_30_dias_e_limite_de_90(scene, logs):
    old = _log(scene.w, actor=scene.user_a, entity_id=str(scene.user_a),
               when=datetime.now(timezone.utc) - timedelta(days=60))
    assert str(old) not in _ids(_get(scene, "/api/v1/admin/audit-logs?page_size=100"))
    start = (datetime.now(timezone.utc) - timedelta(days=89)).strftime("%Y-%m-%dT%H:%M:%SZ")
    wide = _get(scene, f"/api/v1/admin/audit-logs?from={start}&page_size=100")
    assert wide.status_code == 200 and str(old) in _ids(wide)
    # apenas `to`: janela de 30 dias anterior a ele
    to = (datetime.now(timezone.utc) - timedelta(days=50)).strftime("%Y-%m-%dT%H:%M:%SZ")
    only_to = _get(scene, f"/api/v1/admin/audit-logs?to={to}&page_size=100")
    assert only_to.status_code == 200 and str(old) in _ids(only_to)
    assert str(logs.business) not in _ids(only_to)


def test_data_sem_fuso_e_tratada_como_utc(scene, logs):
    day = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
    assert _get(scene, f"/api/v1/admin/audit-logs?from={day}").status_code == 200
    assert _get(scene, f"/api/v1/admin/audit-logs?from={day}T00:00:00-03:00").status_code == 200


def test_filtros_por_allowlist(scene, logs):
    base = "/api/v1/admin/audit-logs"
    assert _ids(_get(scene, f"{base}?event_type=USER_ROLE_CHANGED")) == {str(logs.business)}
    assert _ids(_get(scene, f"{base}?entity_type=unit")) == {str(logs.own)}
    assert _ids(_get(scene, f"{base}?entity_type=user&entity_id={scene.user_a}")) == {
        str(logs.business), str(logs.about_user_by_other)}
    assert _ids(_get(scene, f"{base}?actor_user_id={scene.user_a}")) == {
        str(logs.business), str(logs.security)}
    assert _ids(_get(scene, f"{base}?result=FALHA")) == {str(logs.security)}
    assert _ids(_get(scene, f"{base}?severity=high")) == {str(logs.security)}
    assert _ids(_get(scene, f"{base}?severity=low")) == set()  # o anônimo está fora do escopo
    # filtro por autor alheio nunca vaza registros fora do escopo
    assert _ids(_get(scene, f"{base}?actor_user_id={scene.user_b}")) == set()


def test_ordenacao_e_paginacao(scene, logs):
    base = "/api/v1/admin/audit-logs"
    now = datetime.now(timezone.utc)
    for index in range(5):
        _log(scene.w, actor=scene.user_a, entity_id=str(scene.user_a), operation="USER_ACTIVATED",
             when=now - timedelta(hours=index + 1))
    desc = _get(scene, f"{base}?event_type=USER_ACTIVATED&page_size=2&page=2").get_json()
    asc = _get(scene, f"{base}?event_type=USER_ACTIVATED&sort=occurred_at&page_size=100").get_json()
    assert desc["total"] == 5 and len(desc["items"]) == 2 and desc["page"] == 2
    times = [i["occurred_at"] for i in asc["items"]]
    assert times == sorted(times) and len(times) == 5
    assert [i["id"] for i in desc["items"]] == [i["id"] for i in reversed(asc["items"])][2:4]


def test_registro_somente_leitura_nao_altera_a_trilha(scene, logs):
    with scene.w.session() as db:
        before = db.execute(select(func.count()).select_from(AuditLog)).scalar_one()
    _get(scene, "/api/v1/admin/audit-logs")
    _get(scene, f"/api/v1/admin/audit-logs/{logs.business}")
    with scene.w.session() as db:
        after = db.execute(select(func.count()).select_from(AuditLog)).scalar_one()
    # o AUDIT_VIEWED é despachado ao escritor em segundo plano (mockado aqui)
    assert before == after


def test_head_nao_retorna_corpo(scene, logs):
    response = scene.api.client.head("/api/v1/admin/audit-logs", headers=_h())
    assert response.status_code == 200 and response.get_data() == b""


# ---------------------------------------------------------------------------
# Perfis e permissões
# ---------------------------------------------------------------------------


def test_roles_lista_perfis_com_permissoes_e_contagem_no_escopo(scene):
    response = _get(scene, "/api/v1/admin/roles")
    assert response.status_code == 200
    body = response.get_json()
    assert [r["code"] for r in body["roles"]] == ["ADM", "USER", "RH"]
    by_code = {r["code"]: r for r in body["roles"]}
    # unidade A: 1 ADM, 1 USER ativo (inativo e unidade B não contam), 1 RH
    assert by_code["ADM"]["active_users_count"] == 1
    assert by_code["USER"]["active_users_count"] == 1
    assert by_code["RH"]["active_users_count"] == 1
    assert body["users_count_scope"] == "actor_units"
    adm_perms = {p["code"] for p in by_code["ADM"]["permissions"]}
    assert {"audit.read", "roles.manage", "users.manage"} <= adm_perms
    assert by_code["USER"]["permissions"] == []
    assert set(by_code["ADM"]["permissions"][0]) == {"code", "description", "resource", "action"}
    blob = response.get_data(as_text=True)
    assert "@" not in blob and "exemplo.invalid" not in blob and "Usuaria" not in blob


def test_permissions_catalogo_com_perfis(scene):
    body = _get(scene, "/api/v1/admin/permissions").get_json()
    codes = [p["code"] for p in body["permissions"]]
    assert codes == sorted(codes) and "audit.read" in codes
    audit = next(p for p in body["permissions"] if p["code"] == "audit.read")
    assert audit["roles"] == ["ADM"] and audit["resource"] == "audit"


@pytest.mark.parametrize("url", ["/api/v1/admin/roles", "/api/v1/admin/permissions", AUDIT_ROUTES[1]])
def test_rotas_sem_parametros_rejeitam_qualquer_query(scene, logs, url):
    url = url.replace(AUDIT_ROUTES[1].rsplit("/", 1)[1], str(logs.own))
    assert _get(scene, f"{url}?foo=1").status_code == 400
    assert _get(scene, f"{url}?page=1").status_code == 400


# ---------------------------------------------------------------------------
# Vínculos de unidades
# ---------------------------------------------------------------------------


def test_unit_access_lista_so_escopo_e_sem_pii(scene):
    scene.api.queries.clear()
    response = _get(scene, "/api/v1/admin/unit-access?page_size=100")
    assert response.status_code == 200
    body = response.get_json()
    names = [i["name"] for i in body["items"]]
    assert names == sorted(names, key=str.lower)
    assert "Usuario B" not in names and "Adm Beta" not in names
    assert body["total"] == len(body["items"]) == 4
    item = next(i for i in body["items"] if i["name"] == "Usuaria A")
    assert item == {
        "user_id": str(scene.user_a), "name": "Usuaria A", "role": "USER", "active": True,
        "units": [{"id": str(scene.a), "code": "A"}],
    }
    blob = response.get_data(as_text=True)
    assert "@" not in blob and "email" not in blob and "phone" not in blob
    sql = _route_sql(scene)
    assert "users.email" not in sql and "users.phone" not in sql and "auth_user_id" not in sql


def test_unit_access_so_mostra_unidades_do_escopo_do_adm(scene):
    extra = scene.w.unit("EXTRA")
    both = scene.w.user("Duas Unidades", role="USER", units=[scene.a, extra])
    body = _get(scene, "/api/v1/admin/unit-access?page_size=100").get_json()
    item = next(i for i in body["items"] if i["user_id"] == str(both))
    assert item["units"] == [{"id": str(scene.a), "code": "A"}]


def test_unit_access_filtros(scene):
    base = "/api/v1/admin/unit-access"
    assert {i["name"] for i in _get(scene, f"{base}?role=RH").get_json()["items"]} == {"Rh Alfa"}
    assert {i["name"] for i in _get(scene, f"{base}?active=false").get_json()["items"]} == {"Inativo A"}
    assert len(_get(scene, f"{base}?unit_id={scene.a}").get_json()["items"]) == 4
    desc = _get(scene, f"{base}?sort=-name").get_json()["items"]
    assert [i["name"] for i in desc] == sorted((i["name"] for i in desc), key=str.lower, reverse=True)
    page = _get(scene, f"{base}?page_size=2&page=2").get_json()
    assert page["total"] == 4 and len(page["items"]) == 2


@pytest.mark.parametrize("unit", ["alheia", "inexistente"])
def test_unit_access_unidade_alheia_ou_inexistente_resposta_vazia_identica(scene, unit):
    target = scene.b if unit == "alheia" else uuid.uuid4()
    body = _get(scene, f"/api/v1/admin/unit-access?unit_id={target}").get_json()
    assert body == {"total": 0, "page": 1, "page_size": 25, "items": []}


@pytest.mark.parametrize(
    "query",
    ["foo=1", "email=a@b.c", "q=ana", "user_id=" + str(uuid.uuid4()), "role=ROOT", "role=ADM&role=RH",
     "active=yes", "unit_id=nao-uuid", "sort=email", "sort=-role", "page_size=101", "page=0"],
)
def test_unit_access_parametros_invalidos_400(scene, query):
    assert _get(scene, f"/api/v1/admin/unit-access?{query}").status_code == 400


def test_nenhuma_rota_admin_de_escrita_registrada():
    from app import create_app

    rules = [r for r in create_app().url_map.iter_rules() if "/admin/" in r.rule]
    assert rules
    for rule in rules:
        assert (rule.methods or set()) - {"GET", "HEAD", "OPTIONS"} == set(), rule.rule
    assert not any(re.search(r"register|signup", r.rule) for r in rules)
