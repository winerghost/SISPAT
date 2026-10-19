"""Segurança dos alertas determinísticos (Etapa 4a): lacunas além de test_alerts_api.

Escopo (IDOR/BOLA) em CADA uma das 9 regras, tabelas sem unit_id, PII para RH,
regex só de settings, SQL parametrizado, erros sem vazamento, métodos HTTP.
"""
from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from sqlalchemy import event

from app.config.settings import Settings, get_settings
from app.models.sync import RawImportRecord, SyncConflict, SyncJob
from app.services.alerts import RULES, AlertRule
from test_alerts_api import (  # noqa: F401  (fixtures reutilizadas)
    SUB_A,
    SUB_B,
    SUB_RH,
    URL,
    add_asset,
    add_check,
    add_movement,
    api,
    by_code,
    count_of,
    fetch,
    people,
    world,
)
from test_user_admin_db import auth_headers

ALL_CODES = {rule.code for rule in RULES}


def _seed_everything_in_unit(people, unit, tag):
    """Cria na `unit` dados que disparam TODAS as 9 regras."""
    w = people.world
    sid = f"src-{tag}"
    # duplicado + sem responsável + sem local + fora do padrão + nunca conferido/movido
    for _ in range(2):
        add_asset(w, unit, "##dup##", responsible=False, located=False, source_record_id=sid)
    with w.session() as db:
        job = SyncJob(id=uuid.uuid4(), source="sheets", status="CONCLUIDO")
        db.add(job)
        db.flush()
        asset_id = add_asset(w, unit, "ok1", source_record_id=sid + "-x")
        db.add(
            SyncConflict(
                id=uuid.uuid4(), asset_id=asset_id, source_record_id="x", source_values={}, status="PENDENTE"
            )
        )
        db.add(
            RawImportRecord(
                id=uuid.uuid4(), sync_job_id=job.id, source_record_id=sid, raw_values={}, import_status="CONFLITO"
            )
        )
    for _ in range(30):
        add_movement(w, asset_id, 2, f"TIPO_{tag}")
    for week in range(1, 9):
        add_movement(w, asset_id, 7 * week + 2, f"TIPO_{tag}")


def test_todas_as_nove_regras_registradas():
    assert len(RULES) == 9 and len(ALL_CODES) == 9


def test_nenhuma_regra_vaza_dados_da_unidade_alheia(people):
    _seed_everything_in_unit(people, people.ub, "B")
    # A não tem NENHUM dado: todas as 9 regras devem dar zero (sem item, sem unavailable).
    payload = fetch(people, SUB_A)
    assert payload["items"] == [] and payload["unavailable"] == []
    # Controle positivo: B enxerga as 9 regras (prova que o seed realmente dispara todas).
    seen = {i["code"] for i in fetch(people, SUB_B)["items"]}
    assert seen == ALL_CODES


def test_regras_individualmente_isoladas_por_unidade(people):
    _seed_everything_in_unit(people, people.ub, "B")
    _seed_everything_in_unit(people, people.ua, "A")
    a, b = fetch(people, SUB_A), fetch(people, SUB_B)
    for code in ALL_CODES - {"movement_spike"}:
        assert count_of(a, code) == count_of(b, code) > 0, code
    for payload, tag in ((a, "A"), (b, "B")):
        titles = [i["title"] for i in by_code(payload)["movement_spike"]]
        assert titles and all(f"TIPO_{tag}" in t for t in titles)


def test_raw_import_e_conflito_sem_unit_id_nao_cruzam_unidades(people):
    """Mesmo `source_record_id` em bens de duas unidades: cada lado conta 1, nunca 2."""
    w = people.world
    add_asset(w, people.ua, "1", source_record_id="shared")
    add_asset(w, people.ub, "2", source_record_id="shared")
    add_asset(w, people.ub, "3", source_record_id="only-b")
    with w.session() as db:
        job = SyncJob(id=uuid.uuid4(), source="sheets", status="CONCLUIDO")
        db.add(job)
        db.flush()
        for src in ("shared", "only-b", "orphan"):
            db.add(
                RawImportRecord(
                    id=uuid.uuid4(), sync_job_id=job.id, source_record_id=src, raw_values={}, import_status="CONFLITO"
                )
            )
    assert count_of(fetch(people, SUB_A), "import_records_conflict") == 1
    assert count_of(fetch(people, SUB_B), "import_records_conflict") == 2


def test_rh_nunca_recebe_nomes_emails_ou_ids(people):
    from app.models.people import ResponsiblePerson

    w = people.world
    pid = uuid.uuid4()
    with w.session() as db:
        db.add(ResponsiblePerson(id=pid, name="Beltrano Reservado", unit_id=people.ua, email="b@x.invalid"))
    add_asset(w, people.ua, "1", responsible_person_id=pid, located=False)
    add_asset(w, people.ua, "2", responsible=False)
    body = people.client.get(URL, headers=auth_headers(SUB_RH, aal="aal1")).get_data(as_text=True)
    for secret in ("Beltrano", "b@x.invalid", str(pid), str(people.ua), str(people.ub), "Rita"):
        assert secret not in body


@pytest.mark.parametrize(
    "qs",
    ["unit_id=%s", "units=%s", "unit=%s", "scope=all", "role=ADM", "regex=.*", "days=1", "limit=0"],
)
def test_parametros_do_cliente_nao_alteram_escopo_nem_regras(people, qs):
    add_asset(people.world, people.ub, "ab#", responsible=False, located=False)
    query = qs % people.ub if "%s" in qs else qs
    response = people.client.get(f"{URL}?{query}", headers=auth_headers(SUB_A, aal="aal1"))
    assert response.status_code == 200 and response.get_json()["items"] == []


def test_cabecalhos_do_cliente_nao_alteram_escopo(people):
    add_asset(people.world, people.ub, "1", responsible=False)
    headers = auth_headers(SUB_A, aal="aal1") | {
        "X-Unit-Id": str(people.ub),
        "X-Forwarded-User": SUB_B,
        "X-User-Role": "ADM",
    }
    assert people.client.get(URL, headers=headers).get_json()["items"] == []


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_metodos_de_escrita_nao_existem(people, method):
    response = getattr(people.client, method)(URL, headers=auth_headers(SUB_A, aal="aal1"), json={"unit_id": "x"})
    assert response.status_code == 405


def test_sql_parametrizado_sem_regex_nem_ids_no_texto(people):
    add_asset(people.world, people.ua, "x", responsible=False)
    statements: list[str] = []

    def spy(_conn, _cur, statement, _params, _ctx, _many):
        statements.append(statement)

    event.listen(people.world.engine, "before_cursor_execute", spy)
    try:
        fetch(people)
    finally:
        event.remove(people.world.engine, "before_cursor_execute", spy)
    joined = "\n".join(statements)
    assert statements
    assert get_settings().alerts_patrimony_regex not in joined
    assert str(people.ua) not in joined and people.ua.hex not in joined


def test_regex_so_vem_de_settings_e_tem_limite_de_tamanho():
    with pytest.raises(ValidationError):
        Settings(alerts_patrimony_regex="a" * 201)
    for name in ("alerts_unchecked_days", "alerts_no_movement_days"):
        with pytest.raises(ValidationError):
            Settings(**{name: 0})
    with pytest.raises(ValidationError):
        Settings(alerts_spike_baseline_weeks=100000)


def test_regex_malicioso_nao_executa_em_python_e_nao_vem_do_cliente(people):
    """O backend só chama re.compile (não re.match) no padrão; padrão catastrófico não trava."""
    add_asset(people.world, people.ua, "a" * 30 + "!")
    evil = get_settings().model_copy(update={"alerts_patrimony_regex": r"^(a+)+$"})
    from app.services.alerts import rules

    called = []
    real_match = re.match
    with patch("app.services.alerts.service.get_settings", return_value=evil):
        with patch.object(rules.re, "match", side_effect=lambda *a, **k: called.append(a) or real_match(*a, **k)):
            payload = fetch(people)
    assert called == []  # nunca avaliado em Python sobre dados importados
    assert payload["unavailable"] in ([], ["assets_nonstandard_patrimony"])


def test_regra_com_excecao_nao_vaza_mensagem_nem_dados_no_log(people, caplog):
    add_asset(people.world, people.ua, "1", responsible=False)

    def boom(_ctx):
        raise RuntimeError("SEGREDO postgresql://u:p@h/db token=abc")

    broken = (AlertRule("assets_unchecked", boom),)
    caplog.set_level(logging.DEBUG)
    with patch("app.services.alerts.service.RULES", broken):
        response = people.client.get(URL, headers=auth_headers(SUB_A, aal="aal1"))
    assert response.get_json()["unavailable"] == ["assets_unchecked"]
    assert "SEGREDO" not in response.get_data(as_text=True)
    assert "SEGREDO" not in caplog.text and "postgresql://" not in caplog.text


def test_titulos_e_descricoes_de_pico_sem_controle_nem_bidi(people):
    from test_alerts_api import _spike_world

    _spike_world(people, 20, [1] * 8, "<img src=x onerror=alert(1)>‮​ABC")
    (item,) = by_code(fetch(people))["movement_spike"]
    for field in ("title", "description"):
        assert "‮" not in item[field] and "​" not in item[field]
    assert len(item["title"]) <= 200 and len(item["description"]) <= 1000


def test_resposta_so_tem_codigos_conhecidos(people):
    _seed_everything_in_unit(people, people.ua, "A")
    for item in fetch(people)["items"]:
        assert item["code"] in ALL_CODES


def test_erro_de_autenticacao_nao_executa_regras(people):
    with patch("app.services.alerts.service.RULES", (AlertRule("r", lambda _c: pytest.fail("rodou")),)):
        assert people.client.get(URL).status_code == 401


def test_rate_limit_falha_fechada_sem_redis(people):
    import redis

    class Down:
        def incr(self, *a, **k):
            raise redis.RedisError("down")

        pipeline = expire = incr

    with patch("redis.Redis.from_url", return_value=Down()):
        import importlib
        rl = importlib.import_module("app.security.rate_limit")

        rl.reset_redis_client_cache()
        response = people.client.get(URL, headers=auth_headers(SUB_A, aal="aal1"))
        rl.reset_redis_client_cache()
    assert response.status_code == 503


# --- frontend (análise estática) -------------------------------------------------

_FRONT = Path(__file__).resolve().parents[2] / "frontend" / "src"


@pytest.mark.parametrize(
    "rel",
    [
        "components/features/dashboard/alerts-widget.tsx",
        "lib/alerts-api.ts",
    ],
)
def test_frontend_sem_html_inseguro(rel):
    text = (_FRONT / rel).read_text(encoding="utf-8")
    for token in ("dangerouslySetInnerHTML", "innerHTML", "eval(", "new Function", "localStorage"):
        assert token not in text, (rel, token)


def test_frontend_valida_allowlist_e_limpa_cookie():
    api_ts = (_FRONT / "lib/alerts-api.ts").read_text(encoding="utf-8")
    assert "isDashboardAlerts(data)" in api_ts and "ALERT_SEVERITIES" in api_ts
    assert "clearUiCookie()" in (_FRONT / "lib/session.ts").read_text(encoding="utf-8")
    assert "clearUiCookie()" in (_FRONT / "lib/auth-guard.tsx").read_text(encoding="utf-8")


def test_frontend_chave_react_unica_por_item():
    text = (_FRONT / "components/features/dashboard/alerts-widget.tsx").read_text(encoding="utf-8")
    assert "key={alert.code}" not in text
