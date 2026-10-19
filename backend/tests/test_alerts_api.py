"""`GET /api/v1/dashboard/alerts` (Etapa 4a): regras determinísticas sobre SQLite
com o schema REAL dos modelos (mesma infra de `test_user_admin_db`).

Cobre cada regra, escopo de unidade (IDOR), perfis USER/RH/ADM, bens excluídos
logicamente, isolamento de falha por regra, contrato da resposta e 401.
"""
from __future__ import annotations

import re
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
import test_user_admin_db as tdb
from test_user_admin_db import FakeRedis, World, auth_headers, build_engine

from app import create_app
from app.config.settings import get_settings
from app.models.assets import Asset, AssetMovement
from app.models.inventory import Inventory, InventoryItem
from app.models.sync import RawImportRecord, SyncConflict, SyncJob
from app.services.alerts import AlertRule, evaluate_alerts

URL = "/api/v1/dashboard/alerts"
NOW = datetime.now(timezone.utc)
_EXTRA_TABLES = (
    "responsible_people",
    "rooms",
    "locations",
    "assets",
    "asset_movements",
    "inventories",
    "inventory_items",
    "sync_jobs",
    "sync_conflicts",
    "raw_import_records",
)
SUB_A, SUB_B, SUB_RH, SUB_ADM, SUB_NONE = "al-a", "al-b", "al-rh", "al-adm", "al-none"


@pytest.fixture()
def world(monkeypatch):
    monkeypatch.setattr(tdb, "_TABLES", tdb._TABLES + _EXTRA_TABLES)
    engine = build_engine()
    with engine.connect() as conn:  # SQLite não tem REGEXP: registra a função
        conn.connection.driver_connection.create_function(
            "regexp", 2, lambda pattern, value: int(re.search(pattern, value or "") is not None)
        )
    return World(engine)


@pytest.fixture()
def api(world):
    events: list[dict[str, Any]] = []
    with ExitStack() as stack:
        for target in (
            "app.services.alerts.service.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(patch("redis.Redis.from_url", return_value=FakeRedis()))
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=events.append)
        )
        yield SimpleNamespace(client=create_app().test_client(), world=world, events=events)


@pytest.fixture()
def people(api):
    w = api.world
    ua, ub = w.unit("A"), w.unit("B")
    w.user("User A", role="USER", units=[ua], auth_user_id=SUB_A)
    w.user("User B", role="USER", units=[ub], auth_user_id=SUB_B)
    w.user("Rita RH", role="RH", units=[ua], auth_user_id=SUB_RH)
    w.user("Adm A", role="ADM", units=[ua], auth_user_id=SUB_ADM)
    w.user("Sem Unidade", role="USER", units=[], auth_user_id=SUB_NONE)
    api.ua, api.ub = ua, ub
    return api


def add_asset(world, unit, number="100", *, responsible=True, located=True, deleted=False, **kw) -> uuid.UUID:
    asset_id = uuid.uuid4()
    with world.session() as db:
        db.add(
            Asset(
                id=asset_id,
                patrimony_number=number,
                unit_id=unit,
                responsible_person_id=kw.pop("responsible_person_id", uuid.uuid4() if responsible else None),
                room_id=uuid.uuid4() if located else None,
                deleted_at=NOW if deleted else None,
                deleted_by=uuid.uuid4() if deleted else None,
                **kw,
            )
        )
    return asset_id


def add_check(world, asset_id, days_ago):
    with world.session() as db:
        inv = Inventory(
            id=uuid.uuid4(), name="i", unit_id=uuid.uuid4(), start_date=NOW.date(), created_by=uuid.uuid4()
        )
        db.add(inv)
        db.flush()
        db.add(
            InventoryItem(
                id=uuid.uuid4(),
                inventory_id=inv.id,
                asset_id=asset_id,
                checked_at=NOW - timedelta(days=days_ago),
            )
        )


def add_movement(world, asset_id, days_ago, mtype="TRANSFERENCIA", status="CONCLUIDA"):
    with world.session() as db:
        db.add(
            AssetMovement(
                id=uuid.uuid4(),
                asset_id=asset_id,
                origin_unit_id=uuid.uuid4(),
                destination_unit_id=uuid.uuid4(),
                movement_type=mtype,
                status=status,
                requested_by=uuid.uuid4(),
                created_at=NOW - timedelta(days=days_ago),
            )
        )


def fetch(api, sub=SUB_A, aal="aal1"):
    response = api.client.get(URL, headers=auth_headers(sub, aal=aal))
    assert response.status_code == 200, response.get_data(as_text=True)
    return response.get_json()


def by_code(payload) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for item in payload["items"]:
        out.setdefault(item["code"], []).append(item)
    return out


def count_of(payload, code):
    found = by_code(payload).get(code)
    return found[0]["count"] if found else 0


# --- contrato / autenticação --------------------------------------------------


def test_sem_token_401(people):
    assert people.client.get(URL).status_code == 401
    assert people.client.get(URL, headers={"Authorization": "Bearer lixo"}).status_code == 401


def test_contrato_sem_dados_retorna_listas_vazias(people):
    payload = fetch(people)
    assert set(payload) == {"generated_at", "items", "unavailable"}
    assert payload["items"] == [] and payload["unavailable"] == []
    assert payload["generated_at"].endswith("Z")
    datetime.fromisoformat(payload["generated_at"].replace("Z", "+00:00"))


def test_item_tem_campos_do_contrato_e_so_count_positivo(people):
    add_asset(people.world, people.ua, "100", responsible=False)
    payload = fetch(people)
    assert payload["items"]
    for item in payload["items"]:
        assert set(item) == {"code", "severity", "title", "description", "count"}
        assert item["severity"] in {"info", "warning", "critical"}
        assert isinstance(item["count"], int) and item["count"] > 0


def test_resposta_nao_e_cacheavel(people):
    response = people.client.get(URL, headers=auth_headers(SUB_A, aal="aal1"))
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("sub,aal", [(SUB_A, "aal1"), (SUB_RH, "aal1"), (SUB_ADM, "aal1"), (SUB_ADM, "aal2")])
def test_qualquer_perfil_autenticado_sem_aal2(people, sub, aal):
    add_asset(people.world, people.ua, "100", responsible=False)
    assert count_of(fetch(people, sub, aal), "assets_no_responsible") == 1


def test_usuario_sem_unidades_nao_ve_nada(people):
    add_asset(people.world, people.ua, "100", responsible=False, located=False)
    assert fetch(people, SUB_NONE)["items"] == []


# --- regras -------------------------------------------------------------------


def test_sem_responsavel(people):
    add_asset(people.world, people.ua, "1", responsible=False)
    add_asset(people.world, people.ua, "2", responsible=False)
    add_asset(people.world, people.ua, "3")
    assert count_of(fetch(people), "assets_no_responsible") == 2


def test_responsavel_por_usuario_atribuido_nao_conta(people):
    add_asset(people.world, people.ua, "1", responsible=False, assigned_user_id=uuid.uuid4())
    assert count_of(fetch(people), "assets_no_responsible") == 0


def test_sem_localizacao_exige_sala_e_local_nulos(people):
    add_asset(people.world, people.ua, "1", located=False)
    add_asset(people.world, people.ua, "2", located=False, location_id=uuid.uuid4())
    add_asset(people.world, people.ua, "3")
    assert count_of(fetch(people), "assets_no_location") == 1


def test_sem_conferencia(people):
    w = people.world
    old = add_asset(w, people.ua, "1")
    recent = add_asset(w, people.ua, "2")
    never = add_asset(w, people.ua, "3")  # noqa: F841
    add_check(w, old, days_ago=400)
    add_check(w, recent, days_ago=10)
    assert count_of(fetch(people), "assets_unchecked") == 2  # old + never


def test_conferencia_antiga_mas_com_outra_recente_nao_conta(people):
    w = people.world
    asset = add_asset(w, people.ua, "1")
    add_check(w, asset, days_ago=900)
    add_check(w, asset, days_ago=5)
    assert count_of(fetch(people), "assets_unchecked") == 0


def test_limite_de_conferencia_configuravel(people):
    w = people.world
    asset = add_asset(w, people.ua, "1")
    add_check(w, asset, days_ago=40)
    assert count_of(fetch(people), "assets_unchecked") == 0
    tight = get_settings().model_copy(update={"alerts_unchecked_days": 30})
    with patch("app.services.alerts.service.get_settings", return_value=tight):
        assert count_of(fetch(people), "assets_unchecked") == 1


def test_sem_movimentacao(people):
    w = people.world
    moved = add_asset(w, people.ua, "1")
    stale = add_asset(w, people.ua, "2")
    cancelled_only = add_asset(w, people.ua, "3")
    add_asset(w, people.ua, "4")
    add_movement(w, moved, 10)
    add_movement(w, stale, 500)
    add_movement(w, cancelled_only, 10, status="CANCELADA")
    assert count_of(fetch(people), "assets_no_movement") == 3


def test_duplicado_so_entre_ativos_e_no_escopo(people):
    w = people.world
    add_asset(w, people.ua, "777")
    add_asset(w, people.ua, "777")
    add_asset(w, people.ua, "888")
    add_asset(w, people.ua, "888", deleted=True)  # excluído: não é duplicata
    add_asset(w, people.ub, "888")  # outra unidade: invisível para A
    payload = fetch(people)
    assert count_of(payload, "assets_duplicate_patrimony") == 2
    assert by_code(payload)["assets_duplicate_patrimony"][0]["severity"] == "critical"


def test_duplicado_nao_vaza_unidade_alheia(people):
    add_asset(people.world, people.ua, "999")
    add_asset(people.world, people.ub, "999")
    assert count_of(fetch(people), "assets_duplicate_patrimony") == 0


def test_fora_do_padrao_e_zeros_a_esquerda_validos(people):
    w = people.world
    for number in ("000123", "AB-12.3", "12 34", "", "ab#9", "x" * 40):
        add_asset(w, people.ua, number)
    assert count_of(fetch(people), "assets_nonstandard_patrimony") == 4


def test_regex_configuravel_e_invalida_vira_indisponivel(people):
    add_asset(people.world, people.ua, "ABC")
    only_digits = get_settings().model_copy(update={"alerts_patrimony_regex": r"^[0-9]+$"})
    with patch("app.services.alerts.service.get_settings", return_value=only_digits):
        assert count_of(fetch(people), "assets_nonstandard_patrimony") == 1
    broken = get_settings().model_copy(update={"alerts_patrimony_regex": "([unclosed"})
    with patch("app.services.alerts.service.get_settings", return_value=broken):
        payload = fetch(people)
    assert payload["unavailable"] == ["assets_nonstandard_patrimony"]
    assert count_of(payload, "assets_nonstandard_patrimony") == 0


def test_divergencias_sheets(people):
    w = people.world
    mine = add_asset(w, people.ua, "1", source_record_id="row-1")
    other = add_asset(w, people.ub, "2", source_record_id="row-2")
    gone = add_asset(w, people.ua, "3", source_record_id="row-3", deleted=True)
    with w.session() as db:
        job = SyncJob(id=uuid.uuid4(), source="sheets", status="CONCLUIDO")
        db.add(job)
        db.flush()
        for asset_id, status in (
            (mine, "PENDENTE"),
            (mine, "RESOLVIDO_MANTER_BANCO"),
            (other, "PENDENTE"),
            (gone, "PENDENTE"),
            (None, "PENDENTE"),
        ):
            db.add(
                SyncConflict(
                    id=uuid.uuid4(), asset_id=asset_id, source_record_id="x", source_values={}, status=status
                )
            )
        for src, status in (
            ("row-1", "CONFLITO"),
            ("row-1", "IMPORTADO"),
            ("row-2", "CONFLITO"),
            ("row-3", "CONFLITO"),
            ("sem-bem", "CONFLITO"),
        ):
            db.add(
                RawImportRecord(
                    id=uuid.uuid4(), sync_job_id=job.id, source_record_id=src, raw_values={}, import_status=status
                )
            )
    payload = fetch(people)
    assert count_of(payload, "sync_conflicts_pending") == 1
    assert count_of(payload, "import_records_conflict") == 1
    assert count_of(fetch(people, SUB_B), "sync_conflicts_pending") == 1
    assert count_of(fetch(people, SUB_NONE), "sync_conflicts_pending") == 0


# --- picos de movimentação --------------------------------------------------


def _spike_world(people, current, baseline_per_week, mtype="TRANSFERENCIA", unit=None):
    w = people.world
    asset = add_asset(w, unit or people.ua, f"S{uuid.uuid4().hex[:6]}")
    for _ in range(current):
        add_movement(w, asset, 2, mtype)
    for week, n in enumerate(baseline_per_week, start=1):
        for _ in range(n):
            add_movement(w, asset, 7 * week + 2, mtype)
    return asset


def test_pico_detectado_acima_de_media_mais_3_sigma(people):
    _spike_world(people, 30, [2, 3, 2, 3, 2, 3, 2, 3])
    payload = fetch(people)
    (item,) = by_code(payload)["movement_spike"]
    assert item["count"] == 30 and "TRANSFERENCIA" in item["title"]


def test_sem_pico_quando_dentro_da_variacao_normal(people):
    _spike_world(people, 12, [10, 14, 8, 15, 9, 13, 11, 12])
    assert "movement_spike" not in by_code(fetch(people))


def test_pico_abaixo_do_minimo_nao_alerta(people):
    _spike_world(people, 4, [0] * 8)
    assert "movement_spike" not in by_code(fetch(people))


def test_picos_por_tipo_separados_e_escopo(people):
    _spike_world(people, 20, [1] * 8, "BAIXA_X")
    _spike_world(people, 20, [1] * 8, "OUTRO")
    _spike_world(people, 50, [1] * 8, "ALHEIO", unit=people.ub)
    titles = [i["title"] for i in by_code(fetch(people))["movement_spike"]]
    assert len(titles) == 2 and not any("ALHEIO" in t for t in titles)


def test_tipo_de_movimentacao_e_saneado(people):
    _spike_world(people, 20, [1] * 8, "T\x00\x1b[31m" + "y" * 200)
    (item,) = by_code(fetch(people))["movement_spike"]
    assert "\x00" not in item["title"] and "\x1b" not in item["title"]
    assert len(item["title"]) < 120


# --- escopo / IDOR / soft delete ----------------------------------------------


def test_escopo_de_unidade_isola_contagens(people):
    w = people.world
    add_asset(w, people.ua, "1", responsible=False)
    for n in range(3):
        add_asset(w, people.ub, f"B{n}", responsible=False)
    assert count_of(fetch(people, SUB_A), "assets_no_responsible") == 1
    assert count_of(fetch(people, SUB_B), "assets_no_responsible") == 3


def test_usuario_com_duas_unidades_soma_ambas(people):
    people.world.user("Duplo", role="USER", units=[people.ua, people.ub], auth_user_id="al-duplo")
    add_asset(people.world, people.ua, "1", responsible=False)
    add_asset(people.world, people.ub, "2", responsible=False)
    assert count_of(fetch(people, "al-duplo"), "assets_no_responsible") == 2


def test_bens_excluidos_logicamente_nao_contam_em_nenhuma_regra(people):
    add_asset(people.world, people.ua, "!!", responsible=False, located=False, deleted=True)
    assert fetch(people)["items"] == []


def test_parametros_de_unidade_no_cliente_sao_ignorados(people):
    add_asset(people.world, people.ub, "1", responsible=False)
    response = people.client.get(
        f"{URL}?unit_id={people.ub}", headers=auth_headers(SUB_A, aal="aal1")
    )
    assert response.status_code == 200
    assert count_of(response.get_json(), "assets_no_responsible") == 0


# --- RH: sem identificar pessoas ------------------------------------------------


def test_rh_recebe_apenas_contagens_sem_pessoas(people):
    w = people.world
    with w.session() as db:
        from app.models.people import ResponsiblePerson

        person = ResponsiblePerson(id=uuid.uuid4(), name="Fulano Sigiloso", unit_id=people.ua, email="f@x.invalid")
        db.add(person)
    add_asset(w, people.ua, "1", responsible=False)
    add_asset(w, people.ua, "2", responsible_person_id=person.id)
    for sub in (SUB_RH, SUB_A):
        body = people.client.get(URL, headers=auth_headers(sub, aal="aal1")).get_data(as_text=True)
        for secret in ("Fulano", "f@x.invalid", "Rita", "User A", "exemplo.invalid"):
            assert secret not in body
        assert count_of(fetch(people, sub), "assets_no_responsible") == 1


# --- isolamento de falha ---------------------------------------------------------


def test_regra_com_erro_vai_para_unavailable_sem_derrubar(people):
    add_asset(people.world, people.ua, "1", responsible=False)

    def boom(_ctx):
        raise RuntimeError("falha interna com segredo-xyz")

    from app.services.alerts import rules

    broken = tuple(
        AlertRule(r.code, boom) if r.code == "assets_unchecked" else r for r in rules.RULES
    )
    with patch("app.services.alerts.service.RULES", broken):
        response = people.client.get(URL, headers=auth_headers(SUB_A, aal="aal1"))
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["unavailable"] == ["assets_unchecked"]
    assert count_of(payload, "assets_no_responsible") == 1
    assert "segredo-xyz" not in response.get_data(as_text=True)


def test_erro_de_sql_em_uma_regra_nao_contamina_as_demais(people):
    from sqlalchemy.exc import OperationalError

    add_asset(people.world, people.ua, "1", located=False)

    def sql_fail(_ctx):
        raise OperationalError("select", {}, Exception("x"))

    from app.services.alerts import rules

    broken = tuple(AlertRule(r.code, sql_fail) if r.code == "assets_no_responsible" else r for r in rules.RULES)
    with patch("app.services.alerts.service.RULES", broken):
        payload = fetch(people)
    assert payload["unavailable"] == ["assets_no_responsible"]
    assert count_of(payload, "assets_no_location") == 1


def test_todas_as_regras_falhando_ainda_retorna_200(people):
    boom = tuple(AlertRule(f"r{i}", lambda _c: 1 / 0) for i in range(3))
    with patch("app.services.alerts.service.RULES", boom):
        payload = fetch(people)
    assert payload["items"] == [] and payload["unavailable"] == ["r0", "r1", "r2"]


def test_evaluate_alerts_usa_utc_e_now_injetado(people):
    fixed = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    with patch("app.services.alerts.service.get_db_session", people.world.session):
        payload = evaluate_alerts(uuid.uuid4(), now=fixed)
    assert payload["generated_at"] == "2026-01-02T03:04:05Z"


def test_rate_limit_moderado_429(people):
    # FakeRedis é compartilhado pelo patch; esgota o limite configurado da rota.
    from app.api.v1 import dashboard

    for _ in range(dashboard._ALERTS_LIMIT):
        assert people.client.get(URL, headers=auth_headers(SUB_A, aal="aal1")).status_code == 200
    assert people.client.get(URL, headers=auth_headers(SUB_A, aal="aal1")).status_code == 429
    assert people.client.get(URL, headers=auth_headers(SUB_B, aal="aal1")).status_code == 200
