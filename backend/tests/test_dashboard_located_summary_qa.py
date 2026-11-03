"""QA/seguranca do painel `located_summary` (ONDA D) — complementa, nao substitui.

`test_dashboard_located_summary.py` cobre o contrato, o escopo e as preferencias.
Este arquivo fecha as lacunas que a revisao de QA apontou:

    - metodos HTTP nao-GET (405) e cabecalhos da resposta;
    - parametro desconhecido/privilegiado vindo do cliente -> 400 AUDITADO
      (`PRIVILEGE_ESCALATION_ATTEMPT` / `MASS_ASSIGNMENT_REJECTED`), sem eco de
      VALOR e com o alvo sempre tirado do JWT;
    - invariante `total == soma das series` e coerencia do `percentual` em
      TODAS as combinacoes de filtro admitidas;
    - ausencia de qualquer dado pessoal na resposta (inclusive para o RH) e nos
      eventos de seguranca;
    - `/records` e `/export` com a MESMA resposta do painel inexistente para os
      tres perfis, sem auditoria de exportacao;
    - `AAL2_REQUIRED` exato para ADM em aal1 e 403 sem `reports.read` nos tres
      perfis;
    - IDOR: unidade alheia, inexistente e malformada.

Somente SQLite em memoria (nada toca o Supabase).
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import select
from test_dashboard_equipment import BASE, add, api, hdr  # noqa: F401  (fixture `api`)
from test_dashboard_located_summary import PANEL, chart, multi, series

from app.models.audit import AuditLog
from app.models.rbac import Permission, Role, RolePermission

PERSONAL_PROBES = ("Mariana", "mariana@exemplo", "63999", "NOTA SIGILOSA", "111.222.333-44")
PERSONAL_KEYS = (
    "responsible", "responsavel", "responsible_person_id", "email", "phone",
    "notes", "cpf", "assigned_user_id", "owner_unit_id", "unit_id", "room_id",
)


def events_of(api, event_type: str) -> list[dict]:
    """Eventos de seguranca despachados (o fixture troca `_dispatch` por um mock)."""
    return [c.args[0] for c in api.events.call_args_list if c.args and c.args[0].get("event_type") == event_type]


def drop_permission(api, role_code: str, code: str) -> None:
    with api.world.session() as db:
        role = db.execute(select(Role).where(Role.code == role_code)).scalar_one()
        perm = db.execute(select(Permission).where(Permission.code == code)).scalar_one()
        for rp in db.execute(
            select(RolePermission).where(
                RolePermission.role_id == role.id, RolePermission.permission_id == perm.id
            )
        ).scalars():
            db.delete(rp)


def seed_pii(api):
    """Bens com responsavel, sala e observacao — nada disso pode sair na resposta."""
    person = api.world.person(api.ua, "Mariana Pessoa Fisica")
    room = api.world.room(api.ua, "Sala 101")
    add(
        api, api.ua, "P-1", "NOTEBOOK", located="SIM",
        responsible_person_id=person, room_id=room,
        notes="NOTA SIGILOSA 111.222.333-44 mariana@exemplo.org 63999990000",
        desc="NOTEBOOK DELL",
    )
    add(api, api.ua, "P-2", "MESA", located="NAO", room_id=room, desc="MESA DE MADEIRA")
    return person, room


# --- metodos HTTP e cabecalhos --------------------------------------------------------


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_metodos_nao_get_405_sem_eco(api, method):
    url = f"{BASE}/panels/{PANEL}/data"
    response = getattr(api.client, method)(url, headers=hdr("ua"), json={"role": "ADM"})
    assert response.status_code == 405
    body = response.get_data(as_text=True)
    assert "ADM" not in body and "Traceback" not in body


def test_resposta_tem_no_store_e_nenhum_cabecalho_de_identificacao(api):
    seed_pii(api)
    response = chart(api, "ua")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert "X-Powered-By" not in response.headers
    assert response.headers.get("X-Content-Type-Options") == "nosniff"


# --- parametro desconhecido / privilegiado: 400 auditado, alvo do JWT ----------------


# `user_id`, `role*`, `unit_ids`, `owner_unit_id`, `deleted_at|by`, `active`, `status`...
# estao em `app.api.v1.schemas.PRIVILEGED_FIELD_NAMES`: a simples PRESENCA deles na
# consulta vira `PRIVILEGE_ESCALATION_ATTEMPT` (severidade alta).
PRIVILEGED = [
    "user_id", "role", "roles", "unit_ids", "owner_unit_id", "deleted_at", "deleted_by",
    "created_by", "permissions", "is_admin", "active", "status", "aal", "auth_user_id",
]
NON_PRIVILEGED = ["version", "panel_id", "visible", "size", "actor_id", "format", "located"]


@pytest.mark.parametrize("field", PRIVILEGED)
def test_campo_privilegiado_na_consulta_400_e_evento_de_escalonamento(api, field):
    response = chart(api, "ua", f"?{field}={uuid.uuid4()}")
    assert response.status_code == 400
    text = response.get_data(as_text=True)
    assert "Traceback" not in text and "sqlalchemy" not in text.lower()
    eventos = events_of(api, "PRIVILEGE_ESCALATION_ATTEMPT")
    assert eventos, f"{field} deveria gerar PRIVILEGE_ESCALATION_ATTEMPT"
    detalhes = json.dumps(eventos[-1])
    assert field in detalhes  # o NOME do campo e registrado
    assert "dashboard.panel_data" in detalhes


@pytest.mark.parametrize("field", NON_PRIVILEGED)
def test_campo_desconhecido_na_consulta_400_e_evento_de_mass_assignment(api, field):
    response = chart(api, "ua", f"?{field}=valor-secreto-123")
    assert response.status_code == 400
    assert "valor-secreto-123" not in response.get_data(as_text=True)  # VALOR nunca ecoa
    assert events_of(api, "MASS_ASSIGNMENT_REJECTED"), f"{field} deveria ser auditado"


def test_user_id_do_cliente_nao_troca_o_alvo_nem_amplia_o_escopo(api):
    """`user_id` do cliente e rejeitado (400); o escopo continua o do JWT."""
    for i in range(3):
        add(api, api.ub, f"B-{i}", "NOTEBOOK", located="SIM")
    assert chart(api, "ua", "?user_id=" + str(uuid.uuid4())).status_code == 400
    # o ator de UA continua sem ver nada de UB
    assert chart(api, "ua").get_json()["dados"]["total"] == 0


def test_valor_hostil_em_filtro_valido_400_sem_eco(api):
    hostis = [
        "?unit_id=%3Cscript%3Ealert(1)%3C/script%3E",
        "?unit_id=%27%20OR%201%3D1--",
        "?unit_id=1;DROP%20TABLE%20assets",
        "?familia=" + "T" * 5000,
        "?categoria=NOTEBOOK%00",
        "?unit_id=" + "a" * 5000,
        "?familia=TI&familia=TI",
    ]
    for query in hostis:
        response = chart(api, "ua", query)
        assert response.status_code == 400, (query[:50], response.status_code)
        text = response.get_data(as_text=True)
        for probe in ("script", "DROP", "OR 1=1", "TTTT", "aaaa", "\x00"):
            assert probe not in text, (query[:50], probe)
        assert "Traceback" not in text and "sqlalchemy" not in text.lower()


# --- invariantes dos numeros ---------------------------------------------------------


FILTROS = [
    "", "?familia=TI", "?familia=MOBILIARIO", "?familia=OUTROS", "?familia=NAO_CLASSIFICADO",
    "?categoria=NOTEBOOK", "?categoria=MESA", "?categoria=MONITOR",
]


@pytest.mark.parametrize("query", FILTROS)
@pytest.mark.parametrize("who", ["ua", "rh", "adm", "none"])
def test_total_e_sempre_a_soma_das_series_e_o_percentual_e_coerente(api, who, query):
    multi(api)
    for i in range(4):
        add(api, api.ua, f"A-{i}", ["NOTEBOOK", "MESA", "MONITOR", None][i], located=["SIM", "NAO", "SIM", None][i] or "SIM")
    add(api, api.ub, "B-0", "NOTEBOOK", located="NAO")
    body = chart(api, who, query).get_json()
    dados = body["dados"]
    valores = [s["value"] for s in dados["series"]]
    assert all(isinstance(v, int) and v >= 0 for v in valores)
    assert sum(valores) == dados["total"]
    for item in dados["series"]:
        if dados["total"] == 0:
            assert item["percentual"] is None
        else:
            assert item["percentual"] == round(item["value"] * 100.0 / dados["total"], 1)
    assert len(dados["series"]) == 3


def test_soma_dos_percentuais_nunca_e_inventada_para_fechar_cem(api):
    """3 series iguais: 33.3 cada (soma 99.9). O backend NAO ajusta para 100."""
    for i, loc in enumerate(("SIM", "NAO", None)):
        add(api, api.ua, f"T-{i}", "NOTEBOOK", **({"located": loc} if loc else {}))
    dados = chart(api, "ua").get_json()["dados"]
    assert dados["total"] == 3
    assert [s["percentual"] for s in dados["series"]] == [33.3, 33.3, 33.3]


def test_painel_concorda_com_o_grafico_por_unidade(api):
    """`located_summary` e `located_by_unit_chart` leem a MESMA base (mesmo total
    e mesma contagem por situacao), para o mesmo ator e os mesmos filtros."""
    from test_user_admin_db import auth_headers

    multi(api)
    for i in range(7):
        add(api, api.ua, f"C-{i}", "NOTEBOOK", located="SIM" if i % 2 else "NAO")
    for i in range(3):
        add(api, api.ub, f"D-{i}", "MESA", located="NAO")
    cabecalho = auth_headers("ls-multi", aal="aal2")
    resumo = chart(api, "multi").get_json()["dados"]
    por_unidade = api.client.get(f"{BASE}/panels/located_by_unit_chart/data", headers=cabecalho)
    assert por_unidade.status_code == 200
    unidades = por_unidade.get_json()["dados"]
    assert resumo["total"] == unidades["total"] == 10
    linhas = series(chart(api, "multi").get_json())
    for key in ("SIM", "NAO", "DESCONHECIDO"):
        assert linhas[key]["value"] == sum(u["valores"][key] for u in unidades["unidades"]), key


# --- nenhum dado pessoal -------------------------------------------------------------


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
def test_resposta_nao_traz_dado_pessoal_nem_identificador_interno(api, who):
    person, room = seed_pii(api)
    body = chart(api, who).get_json()
    bruto = json.dumps(body, ensure_ascii=False)
    for probe in PERSONAL_PROBES:
        assert probe not in bruto, probe
    for key in PERSONAL_KEYS:
        assert f'"{key}"' not in bruto, key
    for identificador in (str(person), str(room), "P-1", "P-2", "NOTEBOOK DELL"):
        assert identificador not in bruto, identificador


def test_eventos_de_seguranca_nao_levam_dado_pessoal(api):
    seed_pii(api)
    chart(api, "ua", "?notes=NOTA%20SIGILOSA")
    chart(api, "ua", "?responsible_person_id=" + str(uuid.uuid4()))
    bruto = json.dumps([c.args[0] for c in api.events.call_args_list], ensure_ascii=False)
    for probe in PERSONAL_PROBES:
        assert probe not in bruto, probe


def test_nenhuma_leitura_do_painel_e_auditada_em_audit_logs(api):
    seed_pii(api)
    assert chart(api, "ua").status_code == 200
    with api.world.session() as db:
        operacoes = [a.operation for a in db.execute(select(AuditLog)).scalars()]
    assert "DASHBOARD_EQUIPMENT_EXPORTED" not in operacoes


# --- /records e /export: 404 identico ao painel inexistente --------------------------


@pytest.mark.parametrize("who", ["ua", "rh", "adm"])
@pytest.mark.parametrize("suffix", ["records?unit_id=outras", "records?unit_id=" + str(uuid.uuid4()), "export?format=csv", "export?format=xlsx"])
def test_records_e_export_tem_a_mesma_resposta_do_painel_inexistente(api, who, suffix):
    for i in range(3):
        add(api, api.ua, f"R-{i}", "NOTEBOOK", located="SIM")
    real = api.client.get(f"{BASE}/panels/{PANEL}/{suffix}", headers=hdr(who))
    ghost = api.client.get(f"{BASE}/panels/painel_que_nao_existe/{suffix}", headers=hdr(who))
    assert real.status_code == ghost.status_code == 404
    assert real.get_json() == ghost.get_json()
    corpo = real.get_data(as_text=True)
    assert PANEL not in corpo and "R-0" not in corpo


def test_export_do_painel_nao_gera_arquivo_nem_auditoria(api):
    for i in range(3):
        add(api, api.ua, f"E-{i}", "NOTEBOOK", located="SIM")
    response = api.client.get(f"{BASE}/panels/{PANEL}/export?format=csv", headers=hdr("adm"))
    assert response.status_code == 404
    assert "Content-Disposition" not in response.headers
    assert "X-Report-Rows" not in response.headers
    assert api.world_audits("DASHBOARD_EQUIPMENT_EXPORTED") == []


# --- AAL2 e permissao ----------------------------------------------------------------


def test_adm_em_aal1_recebe_403_com_codigo_aal2_required(api):
    response = chart(api, "adm", aal="aal1")
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert chart(api, "adm", aal="aal2").status_code == 200


@pytest.mark.parametrize("who,role_code", [("ua", "USER"), ("rh", "RH"), ("adm", "ADM")])
def test_sem_reports_read_403_nos_tres_perfis(api, who, role_code):
    drop_permission(api, role_code, "reports.read")
    response = chart(api, who)
    assert response.status_code == 403
    assert PANEL not in response.get_data(as_text=True)


# --- IDOR / BOLA ---------------------------------------------------------------------


def test_unidade_alheia_inexistente_e_malformada(api):
    for i in range(3):
        add(api, api.ub, f"B-{i}", "NOTEBOOK", located="SIM")
    alheia = chart(api, "ua", f"?unit_id={api.ub}")
    ghost = chart(api, "ua", f"?unit_id={uuid.uuid4()}")
    assert alheia.status_code == ghost.status_code == 200
    assert alheia.get_json() == ghost.get_json()
    assert alheia.get_json()["dados"]["total"] == 0
    assert str(api.ub) not in alheia.get_data(as_text=True)
    for malformada in ("nao-uuid", "0", "..%2F..%2Fetc%2Fpasswd", str(api.ub).upper() + "x"):
        ruim = chart(api, "ua", f"?unit_id={malformada}")
        assert ruim.status_code == 400
        # A mensagem so nomeia o PARAMETRO; o valor enviado nunca volta.
        assert ruim.get_json()["error"]["message"] == "Parâmetro(s) inválido(s): unit_id."
        assert "passwd" not in ruim.get_data(as_text=True)
        assert str(api.ub).upper() not in ruim.get_data(as_text=True)
