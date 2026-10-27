"""Catálogo de painéis e preferências de painel (`/api/v1/dashboard/panels`,
`PUT /api/v1/dashboard/preferences`).

SQLite com o schema REAL dos modelos + `require_auth` real (papéis e
permissões lidos do banco), Redis falso, sem rede. Cobre: catálogo filtrado
por perfil (ADM 12 / USER 9 / RH 7), painel proibido ao perfil rejeitado E
auditado, `extra="forbid"`, limite de itens, tamanho inválido, 409 de versão,
`user_id` do cliente rejeitado, dado legado/inválido caindo no padrão e a
tradução do `dashboard_layout` antigo.
"""
from __future__ import annotations

import json
import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
import test_assets_api as taa
from sqlalchemy import select
from test_user_admin_db import FakeRedis, auth_headers

from app import create_app
from app.models.audit import AuditLog
from app.models.settings import UserDashboardPreferences, UserPreferences
from app.services import dashboard_panels_service as dps

PANELS_URL = "/api/v1/dashboard/panels"
PREFS_URL = "/api/v1/dashboard/preferences"
EXTRA_TABLES = ("user_preferences", "user_dashboard_preferences")
SUBS = {"ADM": "dp-adm", "USER": "dp-user", "RH": "dp-rh"}
AAL = {"ADM": "aal2", "USER": "aal1", "RH": "aal1"}

# Contrato FECHADO (pinado aqui de propósito: mudar o catálogo deve falhar
# este teste e exigir uma decisão explícita).
ADM_PANELS = [
    "kpi_workstations",
    "kpi_infrastructure",
    "kpi_furniture",
    "equipment_by_unit_table",
    "furniture_by_unit_table",
    "equipment_by_unit_chart",
    "category_distribution",
    "notebooks_without_docking",
    "workstation_ratio",
    "unclassified_review",
    "classification_overrides",
    "sync_status",
]
ADM_ONLY = ["unclassified_review", "classification_overrides", "sync_status"]
USER_PANELS = [p for p in ADM_PANELS if p not in ADM_ONLY]
RH_PANELS = [p for p in USER_PANELS if p not in ("notebooks_without_docking", "workstation_ratio")]
EXPECTED_IDS = {"ADM": ADM_PANELS, "USER": USER_PANELS, "RH": RH_PANELS}
DEFAULT_SIZES = {
    "kpi_workstations": "G",
    "kpi_infrastructure": "G",
    "kpi_furniture": "G",
    "equipment_by_unit_table": "G",
    "furniture_by_unit_table": "G",
    "equipment_by_unit_chart": "G",
    "category_distribution": "M",
    "notebooks_without_docking": "M",
    "workstation_ratio": "P",
    "unclassified_review": "M",
    "classification_overrides": "M",
    "sync_status": "P",
}


def default_layout(role: str) -> list[dict[str, Any]]:
    return [
        {"id": pid, "visible": True, "size": DEFAULT_SIZES[pid]} for pid in EXPECTED_IDS[role]
    ]


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setattr(taa, "TABLES", taa.TABLES + EXTRA_TABLES)
    for role, perms in taa.PERMS.items():
        monkeypatch.setitem(taa.PERMS, role, perms + ("reports.read",))
    world = taa.AssetWorld(taa._build_engine())
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        for target in (
            "app.api.v1.dashboard.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=events.append)
        )
        unit = world.unit("UA")
        users = {
            role: world.user(f"Painel {role}", role=role, units=[unit], auth_user_id=sub)
            for role, sub in SUBS.items()
        }
        yield SimpleNamespace(
            client=create_app().test_client(), world=world, users=users, events=events
        )


def get_panels(api, role="USER", **kw):
    return api.client.get(
        f"{PANELS_URL}{kw.pop('query', '')}", headers=auth_headers(SUBS[role], aal=AAL[role])
    )


def put_prefs(api, body, role="USER"):
    return api.client.put(PREFS_URL, json=body, headers=auth_headers(SUBS[role], aal=AAL[role]))


def rows(api) -> list[UserDashboardPreferences]:
    with api.world.session() as db:
        return list(db.execute(select(UserDashboardPreferences)).scalars().all())


def stored(api, user_id) -> Any:
    return next(r.panels for r in rows(api) if r.user_id == user_id)


def audits(api, operation: str | None = None) -> list[AuditLog]:
    with api.world.session() as db:
        stmt = select(AuditLog).where(AuditLog.entity_type == dps.PANELS_ENTITY_TYPE)
        if operation:
            stmt = stmt.where(AuditLog.operation == operation)
        return list(db.execute(stmt.order_by(AuditLog.occurred_at)).scalars().all())


def seed_legacy(api, user_id, layout) -> None:
    with api.world.session() as db:
        db.add(
            UserPreferences(
                user_id=user_id,
                density="comfortable",
                font_scale=100,
                dashboard_charts={},
                dashboard_layout=layout,
                version=1,
            )
        )


def seed_panels(api, user_id, panels, *, version=1) -> None:
    with api.world.session() as db:
        db.add(UserDashboardPreferences(user_id=user_id, panels=panels, version=version))


# ---------------------------------------------------------------------------
# Catálogo (coerência interna do serviço)
# ---------------------------------------------------------------------------


def test_catalogo_tem_doze_paineis_sem_repeticao():
    assert len(dps.PANEL_CATALOG) == 12
    assert list(dps.PANEL_IDS) == ADM_PANELS
    assert len(set(dps.PANEL_IDS)) == len(dps.PANEL_IDS)


def test_catalogo_tamanhos_e_perfis_coerentes():
    assert dps.PANEL_SIZES == ("P", "M", "G")
    for panel in dps.PANEL_CATALOG:
        assert panel.sizes, panel.id
        assert set(panel.sizes) <= set(dps.PANEL_SIZES), panel.id
        assert panel.default_size in panel.sizes, panel.id
        assert panel.roles <= {"ADM", "USER", "RH"} and panel.roles, panel.id
        assert panel.label and panel.description and panel.group
    assert {p.id: p.default_size for p in dps.PANEL_CATALOG} == DEFAULT_SIZES


@pytest.mark.parametrize(("role", "expected"), sorted(EXPECTED_IDS.items()))
def test_allowed_panels_por_perfil(role, expected):
    assert list(dps.allowed_panel_ids([role])) == expected


def test_perfil_desconhecido_ou_ausente_nao_tem_painel():
    assert dps.allowed_panel_ids([]) == ()
    assert dps.allowed_panel_ids(None) == ()
    assert dps.allowed_panel_ids(["SUPER"]) == ()
    assert dps.default_layout(["SUPER"]) == []


def test_uniao_de_papeis_soma_os_paineis():
    assert list(dps.allowed_panel_ids(["RH", "USER"])) == USER_PANELS
    assert list(dps.allowed_panel_ids(["RH", "ADM"])) == ADM_PANELS


def test_mapa_legado_descarta_dez_ids():
    from app.services.preferences_service import DEFAULT_DASHBOARD_ORDER

    assert set(dps.LEGACY_PANEL_MAP) <= set(DEFAULT_DASHBOARD_ORDER)
    assert len(dps.LEGACY_PANEL_MAP) == 5
    assert set(dps.LEGACY_PANEL_MAP.values()) <= set(dps.PANEL_IDS)
    descartados = set(DEFAULT_DASHBOARD_ORDER) - set(dps.LEGACY_PANEL_MAP)
    assert descartados == {
        "status", "monthly", "location", "bond", "pending", "rooms", "inventory",
        "tech_status", "tech_no_owner", "tech_age",
    }


# ---------------------------------------------------------------------------
# GET /dashboard/panels
# ---------------------------------------------------------------------------


def test_panels_sem_token_401(api):
    assert api.client.get(PANELS_URL).status_code == 401
    assert rows(api) == []


@pytest.mark.parametrize("role", sorted(SUBS))
def test_panels_devolve_so_os_paineis_do_perfil(api, role):
    response = get_panels(api, role)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert [p["id"] for p in body["panels"]] == EXPECTED_IDS[role]
    assert body["sizes"] == ["P", "M", "G"]
    assert body["default_layout"] == default_layout(role)
    assert body["preferences"] == {"panels": default_layout(role), "version": 0}
    # leitura não cria linha
    assert rows(api) == []


def test_panels_nao_vaza_os_paineis_de_outro_perfil(api):
    body = get_panels(api, "RH").get_json()
    texto = json.dumps(body)
    for panel_id in ADM_ONLY + ["notebooks_without_docking", "workstation_ratio"]:
        assert panel_id not in texto


def test_panels_traz_rotulo_tamanhos_e_nao_expoe_perfis(api):
    body = get_panels(api, "ADM").get_json()
    por_id = {p["id"]: p for p in body["panels"]}
    assert set(por_id["equipment_by_unit_table"]) == {
        "id", "label", "description", "group", "sizes", "default_size", "exportable"
    }
    assert por_id["equipment_by_unit_table"]["sizes"] == ["M", "G"]
    assert por_id["equipment_by_unit_table"]["exportable"] is True
    assert por_id["kpi_workstations"]["sizes"] == ["P", "M", "G"]
    assert por_id["kpi_workstations"]["exportable"] is False
    assert all("roles" not in p for p in body["panels"])


@pytest.mark.parametrize("query", ["?user_id=x", "?foo=1", "?unit_id=" + str(uuid.uuid4())])
def test_panels_parametro_desconhecido_400(api, query):
    response = get_panels(api, "USER", query=query)
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"


# ---------------------------------------------------------------------------
# PUT /dashboard/preferences — caminho feliz
# ---------------------------------------------------------------------------


def test_put_grava_ordem_visibilidade_e_tamanho(api):
    pedido = [
        {"id": "category_distribution", "visible": True, "size": "G"},
        {"id": "kpi_workstations", "visible": False, "size": "P"},
    ]
    response = put_prefs(api, {"version": 0, "panels": pedido})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert body["version"] == 1
    # os painéis não enviados entram ao fim, visíveis, no tamanho padrão
    assert body["panels"][:2] == pedido
    assert [p["id"] for p in body["panels"]] == [
        "category_distribution", "kpi_workstations",
        *[p for p in USER_PANELS if p not in ("category_distribution", "kpi_workstations")],
    ]
    assert stored(api, api.users["USER"]) == body["panels"]
    assert get_panels(api, "USER").get_json()["preferences"] == body


def test_put_igual_ao_padrao_grava_lista_vazia(api):
    response = put_prefs(api, {"version": 0, "panels": default_layout("USER")})
    assert response.status_code == 200
    assert response.get_json()["panels"] == default_layout("USER")
    assert stored(api, api.users["USER"]) == []


def test_restaurar_padrao(api):
    put_prefs(api, {"version": 0, "panels": [{"id": "sync_status", "visible": True, "size": "G"}]}, "ADM")
    response = put_prefs(api, {"version": 1, "restore_default": True}, "ADM")
    assert response.status_code == 200
    assert response.get_json() == {"panels": default_layout("ADM"), "version": 2}
    assert stored(api, api.users["ADM"]) == []
    assert get_panels(api, "ADM").get_json()["preferences"]["panels"] == default_layout("ADM")


def test_adm_pode_usar_os_paineis_administrativos(api):
    pedido = [{"id": pid, "visible": True, "size": "M"} for pid in ADM_ONLY]
    response = put_prefs(api, {"version": 0, "panels": pedido}, "ADM")
    assert response.status_code == 200
    assert [p["id"] for p in response.get_json()["panels"][:3]] == ADM_ONLY


def test_isolamento_entre_usuarios(api):
    put_prefs(api, {"version": 0, "panels": [{"id": "kpi_furniture", "visible": True, "size": "P"}]})
    assert get_panels(api, "RH").get_json()["preferences"] == {
        "panels": default_layout("RH"), "version": 0
    }
    assert {r.user_id for r in rows(api)} == {api.users["USER"]}


def test_auditoria_de_sucesso_sem_dado_pessoal(api):
    token = auth_headers(SUBS["USER"], aal="aal1")
    api.client.put(
        PREFS_URL,
        json={"version": 0, "panels": [{"id": "kpi_furniture", "visible": True, "size": "M"}]},
        headers=token,
    )
    (audit,) = audits(api, dps.OPERATION_PANELS_UPDATED)
    assert audit.actor_user_id == api.users["USER"]
    assert audit.result == "SUCESSO"
    assert audit.previous_values == {"panels": default_layout("USER"), "version": 0}
    assert audit.new_values["version"] == 1
    dumped = json.dumps([audit.previous_values, audit.new_values])
    assert token["Authorization"].split()[1] not in dumped
    assert "@" not in dumped and "Painel USER" not in dumped


def test_pior_caso_de_tamanho_cabe_no_check(api):
    pedido = [
        {"id": pid, "visible": False if pid != "sync_status" else True, "size": "G"}
        for pid in ADM_PANELS
        if "G" in dps.PANELS_BY_ID[pid].sizes
    ]
    response = put_prefs(api, {"version": 0, "panels": pedido}, "ADM")
    assert response.status_code == 200
    salvo = stored(api, api.users["ADM"])
    assert len(salvo) == 12
    # jsonb::text do PostgreSQL usa ", " e ": " (igual ao json.dumps padrão)
    assert len(json.dumps(salvo, ensure_ascii=False).encode("utf-8")) <= 2048


# ---------------------------------------------------------------------------
# PUT — painel não permitido ao perfil: rejeitado E auditado
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["USER", "RH"])
@pytest.mark.parametrize("panel_id", ADM_ONLY)
def test_painel_administrativo_proibido_para_nao_adm(api, role, panel_id):
    response = put_prefs(api, {"version": 0, "panels": [{"id": panel_id, "visible": True, "size": "M"}]}, role)
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "panel_forbidden"
    # auditado na MESMA transação (o registro persiste apesar do 403)
    (audit,) = audits(api, dps.OPERATION_PANEL_FORBIDDEN)
    assert audit.result == "FALHA"
    assert audit.actor_user_id == api.users[role]
    assert audit.new_values["rejected_panels"] == [panel_id]
    assert audit.new_values["roles"] == [role]
    assert audit.previous_values is None
    # nenhuma preferência foi gravada
    assert rows(api) == []
    assert audits(api, dps.OPERATION_PANELS_UPDATED) == []


@pytest.mark.parametrize("panel_id", ["notebooks_without_docking", "workstation_ratio"])
def test_painel_de_operacao_proibido_para_rh(api, panel_id):
    response = put_prefs(api, {"version": 0, "panels": [{"id": panel_id, "visible": True, "size": "M"}]}, "RH")
    assert response.status_code == 403
    assert len(audits(api, dps.OPERATION_PANEL_FORBIDDEN)) == 1
    assert rows(api) == []


def test_proibido_junto_com_permitido_rejeita_tudo(api):
    pedido = [
        {"id": "kpi_workstations", "visible": True, "size": "G"},
        {"id": "sync_status", "visible": True, "size": "P"},
    ]
    assert put_prefs(api, {"version": 0, "panels": pedido}, "USER").status_code == 403
    assert rows(api) == []


def test_painel_proibido_nao_altera_preferencia_existente(api):
    put_prefs(api, {"version": 0, "panels": [{"id": "kpi_furniture", "visible": True, "size": "M"}]})
    antes = stored(api, api.users["USER"])
    response = put_prefs(api, {"version": 1, "panels": [{"id": "sync_status", "visible": True, "size": "P"}]})
    assert response.status_code == 403
    assert stored(api, api.users["USER"]) == antes
    with api.world.session() as db:
        assert db.get(UserDashboardPreferences, api.users["USER"]).version == 1


# ---------------------------------------------------------------------------
# PUT — validação de forma (400)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"version": 0},  # nem panels nem restore_default
        {"version": 0, "panels": [], "restore_default": True},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": "G"}], "restore_default": True},
        {"version": 0, "restore_default": False},
        {"version": 0, "panels": []},
        {"panels": [{"id": "kpi_workstations", "visible": True, "size": "G"}]},  # sem version
        {"version": -1, "restore_default": True},
        {"version": "1", "restore_default": True},
        {"version": True, "restore_default": True},
        {"version": 0, "panels": {"id": "kpi_workstations"}},
        {"version": 0, "panels": "kpi_workstations"},
        {"version": 0, "panels": [["kpi_workstations"]]},
        {"version": 0, "panels": [None]},
        {"version": 0, "panels": [{"id": "kpi_workstations"}]},  # sem visible/size
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "size": "G"}]},
        {"version": 0, "panels": [{"id": "desconhecido", "visible": True, "size": "G"}]},
        {"version": 0, "panels": [{"id": "kpis", "visible": True, "size": "G"}]},  # ID ANTIGO
        {"version": 0, "panels": [{"id": "tech_units", "visible": True, "size": "G"}]},
        {"version": 0, "panels": [{"id": " kpi_workstations", "visible": True, "size": "G"}]},
        {"version": 0, "panels": [{"id": "KPI_WORKSTATIONS", "visible": True, "size": "G"}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": "sim", "size": "G"}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": 1, "size": "G"}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": "X"}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": "g"}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": "GG"}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": ""}]},
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": None}]},
        # tamanho da allowlist global, mas NÃO admitido para este painel
        {"version": 0, "panels": [{"id": "equipment_by_unit_table", "visible": True, "size": "P"}]},
        {"version": 0, "panels": [{"id": "furniture_by_unit_table", "visible": True, "size": "P"}]},
        {"version": 0, "panels": [{"id": "unclassified_review", "visible": True, "size": "P"}]},
        # repetição
        {"version": 0, "panels": [
            {"id": "kpi_workstations", "visible": True, "size": "G"},
            {"id": "kpi_workstations", "visible": False, "size": "P"},
        ]},
        # campo extra dentro do item
        {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": "G", "x": 1}]},
    ],
)
def test_corpo_invalido_400(api, body):
    response = put_prefs(api, body, "ADM")
    assert response.status_code == 400, body
    assert response.get_json()["error"]["code"] == "validation_error"
    assert rows(api) == []
    assert audits(api) == []


def test_limite_de_itens(api):
    pedido = [{"id": pid, "visible": True, "size": "M"} for pid in ADM_PANELS if "M" in dps.PANELS_BY_ID[pid].sizes]
    assert put_prefs(api, {"version": 0, "panels": pedido}, "ADM").status_code == 200
    # acima de MAX_PANELS itens -> 400 (sem tocar o banco de outro usuário)
    excesso = pedido + [{"id": "kpi_workstations", "visible": True, "size": "P"}] * 5
    assert len(excesso) > dps.MAX_PANELS
    assert put_prefs(api, {"version": 1, "panels": excesso}, "ADM").status_code == 400


def test_todos_invisiveis_400(api):
    pedido = [{"id": pid, "visible": False, "size": "M"} for pid in RH_PANELS]
    response = put_prefs(api, {"version": 0, "panels": pedido}, "RH")
    assert response.status_code == 400
    assert rows(api) == []


@pytest.mark.parametrize("field", ["user_id", "role", "unit_id", "deleted_at", "version_id", "panels_extra"])
def test_mass_assignment_rejeitado_e_auditado(api, field):
    body = {
        "version": 0,
        "panels": [{"id": "kpi_workstations", "visible": True, "size": "G"}],
        field: str(api.users["ADM"]),
    }
    response = put_prefs(api, body)
    assert response.status_code == 400
    assert any(
        e["event_type"] in ("MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT")
        for e in api.events
    )
    assert rows(api) == []


def test_user_id_do_cliente_nunca_muda_o_alvo(api):
    # mesmo com `user_id` no corpo (rejeitado), nada é gravado para o ADM
    put_prefs(api, {"version": 0, "panels": [{"id": "kpi_workstations", "visible": True, "size": "G"}],
                    "user_id": str(api.users["ADM"])})
    assert rows(api) == []
    # gravação válida só atinge o usuário do JWT
    put_prefs(api, {"version": 0, "panels": [{"id": "category_distribution", "visible": True, "size": "G"}]})
    assert {r.user_id for r in rows(api)} == {api.users["USER"]}


def test_mensagem_de_erro_nao_ecoa_valores(api):
    response = put_prefs(
        api, {"version": 0, "panels": [{"id": "<script>x</script>", "visible": True, "size": "G"}]}
    )
    assert response.status_code == 400
    assert "<script>" not in response.get_data(as_text=True)


@pytest.mark.parametrize("body", ["texto", ["kpi_workstations"], 1, True, None])
def test_corpo_nao_objeto_400(api, body):
    response = api.client.put(PREFS_URL, json=body, headers=auth_headers(SUBS["USER"], aal="aal1"))
    assert response.status_code == 400
    assert rows(api) == []


def test_sem_token_401(api):
    assert api.client.put(PREFS_URL, json={"version": 0, "restore_default": True}).status_code == 401
    assert rows(api) == []


# ---------------------------------------------------------------------------
# PUT — controle otimista
# ---------------------------------------------------------------------------


def test_conflito_de_versao_409(api):
    put_prefs(api, {"version": 0, "panels": [{"id": "kpi_furniture", "visible": True, "size": "M"}]})
    antes = stored(api, api.users["USER"])
    response = put_prefs(api, {"version": 0, "restore_default": True})
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "version_conflict"
    assert stored(api, api.users["USER"]) == antes
    assert len(audits(api, dps.OPERATION_PANELS_UPDATED)) == 1


def test_versao_alta_demais_409(api):
    response = put_prefs(api, {"version": 7, "restore_default": True})
    assert response.status_code == 409
    assert rows(api) == []


def test_versao_sobe_a_cada_gravacao(api):
    for esperada in (1, 2, 3):
        response = put_prefs(api, {"version": esperada - 1, "restore_default": True})
        assert response.status_code == 200
        assert response.get_json()["version"] == esperada


# ---------------------------------------------------------------------------
# Dado legado/inválido no banco -> padrão, nunca erro
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "salvo",
    [
        [],
        {},
        "texto",
        1,
        [None, 1, "x", ["y"]],
        [{"id": 1, "visible": True, "size": "G"}],
        [{"id": "desconhecido", "visible": True, "size": "G"}],
        [{"id": "kpis", "visible": True, "size": "G"}],  # ID antigo
        [{"visible": True, "size": "G"}],
        [{"id": "sync_status", "visible": True, "size": "P"}],  # painel só de ADM
    ],
)
def test_preferencia_legada_ou_invalida_cai_no_padrao(api, salvo):
    seed_panels(api, api.users["USER"], salvo)
    response = get_panels(api, "USER")
    assert response.status_code == 200
    assert response.get_json()["preferences"] == {"panels": default_layout("USER"), "version": 1}
    # e o PUT sobre dado legado funciona, regravando a forma normalizada
    assert put_prefs(api, {"version": 1, "restore_default": True}).status_code == 200
    assert stored(api, api.users["USER"]) == []


@pytest.mark.parametrize(
    ("salvo", "esperado_size", "esperado_visible"),
    [
        ([{"id": "kpi_workstations", "visible": True, "size": "X"}], "G", True),
        ([{"id": "kpi_workstations", "visible": True, "size": 3}], "G", True),
        ([{"id": "kpi_workstations", "visible": "sim", "size": "P"}], "P", True),
        ([{"id": "kpi_workstations", "size": "P"}], "P", True),
        ([{"id": "kpi_workstations", "visible": False, "size": "P"}], "P", False),
    ],
)
def test_campos_invalidos_do_item_caem_no_padrao(api, salvo, esperado_size, esperado_visible):
    seed_panels(api, api.users["USER"], salvo)
    panels = get_panels(api, "USER").get_json()["preferences"]["panels"]
    assert panels[0] == {
        "id": "kpi_workstations", "visible": esperado_visible, "size": esperado_size
    }
    assert [p["id"] for p in panels] == USER_PANELS  # completado na ordem do catálogo


def test_todos_invisiveis_no_banco_volta_ao_padrao(api):
    seed_panels(api, api.users["USER"], [{"id": p, "visible": False, "size": "M"} for p in USER_PANELS])
    assert get_panels(api, "USER").get_json()["preferences"]["panels"] == default_layout("USER")


def test_painel_perdido_com_a_troca_de_perfil_e_ignorado(api):
    seed_panels(
        api,
        api.users["RH"],
        [
            {"id": "sync_status", "visible": True, "size": "P"},
            {"id": "category_distribution", "visible": False, "size": "P"},
        ],
    )
    panels = get_panels(api, "RH").get_json()["preferences"]["panels"]
    assert [p["id"] for p in panels][0] == "category_distribution"
    assert "sync_status" not in [p["id"] for p in panels]
    assert len(panels) == len(RH_PANELS)


# ---------------------------------------------------------------------------
# Tradução do `dashboard_layout` antigo (migração em tempo de leitura)
# ---------------------------------------------------------------------------


def test_layout_antigo_e_traduzido_pelo_mapa(api):
    seed_legacy(
        api,
        api.users["USER"],
        {
            "order": ["tech_units", "kpis", "status", "monthly", "units"],
            "hidden": ["tech_category", "pending"],
        },
    )
    panels = get_panels(api, "USER").get_json()["preferences"]["panels"]
    assert [p["id"] for p in panels[:3]] == [
        "equipment_by_unit_table", "kpi_workstations", "equipment_by_unit_chart"
    ]
    por_id = {p["id"]: p for p in panels}
    assert por_id["category_distribution"]["visible"] is False
    assert [p["id"] for p in panels if p["visible"]][0] == "equipment_by_unit_table"
    assert len(panels) == len(USER_PANELS)
    # tradução NÃO grava nada e NÃO apaga a linha antiga
    assert rows(api) == []
    with api.world.session() as db:
        assert db.get(UserPreferences, api.users["USER"]).dashboard_layout["order"][0] == "tech_units"


def test_layout_antigo_so_com_ids_descartados_cai_no_padrao(api):
    seed_legacy(api, api.users["USER"], {"order": ["status", "monthly"], "hidden": ["rooms"]})
    assert get_panels(api, "USER").get_json()["preferences"]["panels"] == default_layout("USER")


@pytest.mark.parametrize(
    "layout",
    [{}, {"order": "kpis"}, {"order": [1, None]}, [], "texto", {"hidden": {"kpis": True}}],
)
def test_layout_antigo_invalido_cai_no_padrao(api, layout):
    seed_legacy(api, api.users["USER"], layout)
    response = get_panels(api, "USER")
    assert response.status_code == 200
    assert response.get_json()["preferences"]["panels"] == default_layout("USER")


def test_preferencia_nova_tem_precedencia_sobre_o_layout_antigo(api):
    seed_legacy(api, api.users["USER"], {"order": ["kpis"], "hidden": ["units"]})
    seed_panels(api, api.users["USER"], [{"id": "kpi_furniture", "visible": False, "size": "P"}])
    panels = get_panels(api, "USER").get_json()["preferences"]["panels"]
    assert panels[0] == {"id": "kpi_furniture", "visible": False, "size": "P"}
    assert {p["id"] for p in panels if not p["visible"]} == {"kpi_furniture"}


def test_traducao_do_legado_e_idempotente(api):
    layout = {"order": ["tech_units", "kpis"], "hidden": ["tech_category"]}
    primeiro = dps.panels_from_legacy_layout(layout, ["USER"])
    assert primeiro == dps.panels_from_legacy_layout(layout, ["USER"])
    # aplicar o resultado como preferência salva não muda mais nada
    assert dps.resolve_panels(primeiro, layout, ["USER"]) == primeiro


def test_traducao_do_legado_respeita_o_perfil(api):
    layout = {"order": ["tech_units", "kpis"]}
    for role, esperado in (("RH", RH_PANELS), ("USER", USER_PANELS), ("ADM", ADM_PANELS)):
        panels = dps.panels_from_legacy_layout(layout, [role])
        assert [p["id"] for p in panels][:2] == ["equipment_by_unit_table", "kpi_workstations"]
        assert len(panels) == len(esperado)
