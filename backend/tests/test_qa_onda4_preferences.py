"""ONDA 4 (QA): `PUT /api/v1/dashboard/preferences` (política READ + `reports.read`).

A rota grava as preferências do PRÓPRIO usuário (não é escrita patrimonial), por isso
a política READ é adequada, desde que: o alvo seja sempre o `sub` do JWT, painel
proibido nunca fique habilitado (nem por `restore_default`, ids repetidos ou
desconhecidos), a versão seja otimista e a negação fique em `audit_logs` DE FATO.
"""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from unittest.mock import patch

import pytest
from sqlalchemy import select
from test_dashboard_panels_api import (  # noqa: F401  (fixture `api` reutilizada)
    ADM_ONLY,
    PREFS_URL,
    SUBS,
    api,
    audits,
    default_layout,
    get_panels,
    put_prefs,
    rows,
    seed_panels,
    stored,
)
from test_user_admin_db import auth_headers

from app.authorization import security_events as se
from app.models.audit import AuditLog
from app.services import dashboard_panels_service as dps


@pytest.fixture()
def real_audit(api):
    with ExitStack() as stack:
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=se._persist_event)
        )
        stack.enter_context(patch("app.database.session.get_db_session", api.world.session))
        yield api


def security_rows(api, operation=None):
    with api.world.session() as db:
        stmt = select(AuditLog).where(AuditLog.entity_type == "security_event")
        if operation:
            stmt = stmt.where(AuditLog.operation == operation)
        return list(db.execute(stmt).scalars())


def layout(role="USER", **overrides):
    return [{**item, **overrides.get(item["id"], {})} for item in default_layout(role)]


# --- 2. mass assignment: rejeitado E gravado de fato ---------------------------------------


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", str(uuid.uuid4())),
        ("role", "ADM"),
        ("unit_id", str(uuid.uuid4())),
        ("deleted_at", "2026-01-01T00:00:00Z"),
        ("created_by", str(uuid.uuid4())),
        ("id", str(uuid.uuid4())),
    ],
)
def test_mass_assignment_nas_preferencias_grava_de_fato_em_audit_logs(real_audit, field, value):
    api = real_audit
    r = put_prefs(api, {"version": 0, "panels": layout(), field: value})
    assert r.status_code == 400
    assert rows(api) == []  # nada gravado
    sec = security_rows(api, "PRIVILEGE_ESCALATION_ATTEMPT") + security_rows(api, "MASS_ASSIGNMENT_REJECTED")
    assert len(sec) == 1, "evento despachado mas NÃO persistido em audit_logs"
    assert sec[0].new_values["details"]["fields"] == [field]
    assert sec[0].new_values["details"]["context"] == "dashboard.preferences.update"
    assert value not in str(sec[0].new_values)


def test_mass_assignment_dentro_de_item_de_painel_tambem_e_rejeitado(api):
    panels = layout()
    panels[0] = {**panels[0], "user_id": str(uuid.uuid4())}
    assert put_prefs(api, {"version": 0, "panels": panels}).status_code == 400
    assert rows(api) == []


def test_user_id_na_query_string_nunca_muda_o_alvo(api):
    victim = api.users["RH"]
    seed_panels(api, victim, layout("RH", kpi_workstations={"size": "P"}), version=3)
    before = stored(api, victim)
    r = api.client.put(
        f"{PREFS_URL}?user_id={victim}&version=3",
        json={"version": 0, "panels": layout("USER", kpi_workstations={"size": "M"})},
        headers=auth_headers(SUBS["USER"], aal="aal1"),
    )
    assert r.status_code in (200, 400)
    assert stored(api, victim) == before
    with api.world.session() as db:
        mine = [x for x in db.execute(select(dps.UserDashboardPreferences)).scalars() if x.user_id == victim]
    assert len(mine) == 1 and mine[0].version == 3


# --- 4. painel proibido nunca habilitado --------------------------------------------------


@pytest.mark.parametrize("role", ["USER", "RH"])
def test_restore_default_nunca_habilita_painel_proibido(api, role):
    # Estado sujo no banco com painéis só-ADM habilitados é ignorado na leitura...
    seed_panels(
        api, api.users[role],
        [{"id": p, "visible": True, "size": "M"} for p in ADM_ONLY] + layout(role), version=1,
    )
    shown = [p["id"] for p in get_panels(api, role).get_json()["preferences"]["panels"]]
    assert not set(shown) & set(ADM_ONLY)
    # ...e restaurar o padrão grava o padrão DO PERFIL.
    r = put_prefs(api, {"version": 1, "restore_default": True}, role)
    assert r.status_code == 200
    assert [p["id"] for p in r.get_json()["panels"]] == [p["id"] for p in default_layout(role)]
    assert stored(api, api.users[role]) == []
    assert not set(p["id"] for p in r.get_json()["panels"]) & set(ADM_ONLY)


@pytest.mark.parametrize("panel", ADM_ONLY)
def test_painel_so_adm_via_put_user_rejeitado_403_auditado_e_nada_gravado(real_audit, panel):
    api = real_audit
    panels = layout() + [{"id": panel, "visible": True, "size": "M"}]
    r = put_prefs(api, {"version": 0, "panels": panels})
    assert r.status_code == 403
    assert rows(api) == []
    [log] = audits(api, dps.OPERATION_PANEL_FORBIDDEN)
    assert log.result == "FALHA" and log.new_values["rejected_panels"] == [panel]
    assert log.actor_user_id == api.users["USER"] and log.entity_id == str(api.users["USER"])


@pytest.mark.parametrize(
    "panels_patch",
    [
        lambda p: p + [p[0]],  # id repetido
        lambda p: [p[0], {**p[0], "size": "G"}],  # repetido com outro tamanho
        lambda p: p[:1] + [{"id": "painel_desconhecido", "visible": True, "size": "M"}],
        lambda p: p[:1] + [{"id": "KPI_WORKSTATIONS", "visible": True, "size": "M"}],
        lambda p: p[:1] + [{"id": " sync_status", "visible": True, "size": "M"}],
        lambda p: p[:1] + [{"id": "sync_status\n", "visible": True, "size": "M"}],
        lambda p: p[:1] + [{"id": "sync_status", "visible": "true", "size": "M"}],
        lambda p: [{**p[0], "size": "X"}],
        lambda p: [{**p[0], "size": "MM"}],
        lambda p: [{**p[0], "size": ""}],
        lambda p: [],
        lambda p: [{**i, "visible": False} for i in p],
        lambda p: p * 2,  # excede o limite de itens
    ],
)
def test_paineis_invalidos_400_sem_gravar(api, panels_patch):
    r = put_prefs(api, {"version": 0, "panels": panels_patch(layout())})
    assert r.status_code == 400
    assert rows(api) == [] and audits(api, dps.OPERATION_PANELS_UPDATED) == []


@pytest.mark.parametrize(
    "body",
    [
        {"version": 0, "restore_default": True, "panels": layout()},
        {"version": 0, "restore_default": False},
        {"version": 0, "restore_default": "true"},
        {"version": 0},
        {"restore_default": True},
        {"version": "0", "restore_default": True},
        {"version": -1, "restore_default": True},
        {"version": True, "restore_default": True},
    ],
)
def test_restore_default_e_version_estritos(api, body):
    assert put_prefs(api, body).status_code == 400
    assert rows(api) == []


def test_restore_default_com_versao_errada_409_sem_alterar(api):
    seed_panels(api, api.users["USER"], layout(kpi_workstations={"size": "P"}), version=4)
    r = put_prefs(api, {"version": 3, "restore_default": True})
    assert r.status_code == 409
    assert stored(api, api.users["USER"])[0]["size"] == "P"
    assert audits(api, dps.OPERATION_PANELS_UPDATED) == []


def test_conflito_de_versao_e_o_outro_usuario_nao_e_afetado(api):
    seed_panels(api, api.users["USER"], layout(kpi_workstations={"size": "P"}), version=2)
    seed_panels(api, api.users["RH"], layout("RH", kpi_workstations={"size": "M"}), version=7)
    assert put_prefs(api, {"version": 7, "panels": layout()}).status_code == 409  # versão do RH
    assert put_prefs(api, {"version": 2, "panels": layout()}).status_code == 200
    rh = next(r for r in rows(api) if r.user_id == api.users["RH"])
    assert rh.version == 7 and rh.panels[0]["size"] == "M"


# --- 3/4. AAL2 e permissão ------------------------------------------------------------------


def test_adm_sem_aal2_nao_grava_preferencias(api):
    r = api.client.put(
        PREFS_URL, json={"version": 0, "restore_default": True},
        headers=auth_headers(SUBS["ADM"], aal="aal1"),
    )
    assert r.status_code in (401, 403) and rows(api) == []


def test_adm_com_aal2_grava_so_a_propria_linha(api):
    r = put_prefs(api, {"version": 0, "panels": layout("ADM", sync_status={"visible": False})}, "ADM")
    assert r.status_code == 200
    assert [x.user_id for x in rows(api)] == [api.users["ADM"]]


def test_sem_permissao_reports_read_403(api):
    from app.models.rbac import Permission, Role, RolePermission

    with api.world.session() as db:
        role = db.execute(select(Role).where(Role.code == "RH")).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == "reports.read")).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(RolePermission.role_id == role.id, RolePermission.permission_id == perm.id)
        ).scalars():
            db.delete(rp)
    assert put_prefs(api, {"version": 0, "restore_default": True}, "RH").status_code == 403
    assert rows(api) == []


def test_sem_token_401_e_metodos_nao_declarados(api):
    assert api.client.put(PREFS_URL, json={"version": 0, "restore_default": True}).status_code == 401
    for method in ("post", "patch", "delete"):
        r = getattr(api.client, method)(PREFS_URL, json={}, headers=auth_headers(SUBS["USER"], aal="aal1"))
        assert r.status_code in (404, 405)


def test_auditoria_de_sucesso_so_tem_ids_tamanhos_e_versao(api):
    assert put_prefs(api, {"version": 0, "panels": layout(kpi_workstations={"size": "P"})}).status_code == 200
    [log] = audits(api, dps.OPERATION_PANELS_UPDATED)
    blob = str(log.new_values) + str(log.previous_values)
    assert "@" not in blob and "email" not in blob.lower() and "name" not in blob.lower()
    assert set(log.new_values) == {"panels", "version"}
