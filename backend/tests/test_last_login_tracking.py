"""Registro do último LOGIN (`users.last_login_at`) — regressão completa.

Até esta correção a coluna existia (migração 0001), era LIDA pela gestão de
usuários (`user_summary` e a allowlist de ordenação) e NUNCA era escrita: em
produção estava `NULL` para todos. Agora `require_auth` a grava uma vez por
SESSÃO (`app.services.login_tracking_service`).

Infra: SQLite com o schema real dos modelos + carregador de usuário REAL de
`require_auth` (fixture `api` de `test_user_admin_db.py`). Nenhuma rede,
nenhum Supabase/Redis real.

O que estes testes travam:
    - primeiro acesso: `NULL` -> instante do PRIMEIRO fator da sessão (`amr`);
    - mesma sessão: exatamente UM `UPDATE users` e UMA linha `LOGIN`;
    - nunca retrocede (token de sessão mais antiga não sobrescreve);
    - acesso NEGADO (inativo, excluído, sessão revogada, token inválido, `sub`
      órfão) não grava nada;
    - falha de banco no registro não derruba a autenticação;
    - a gravação não mexe em `users.version` (nada de 409 no PATCH seguinte);
    - `GET /api/v1/me` devolve `last_login_at` ao titular;
    - a anonimização do usuário excluído apaga a coluna.
"""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.exc import OperationalError
from test_user_admin_db import (  # noqa: F401  (fixtures)
    FakeStorage,
    World,
    api,
    auth_headers,
    build_engine,
    make_token,
    world,
)

from app.auth import supabase_auth
from app.services.login_tracking_service import (
    AUDIT_ENTITY_TYPE,
    FALLBACK_MIN_INTERVAL_SECONDS,
    OP_LOGIN,
    as_utc,
    resolve_login_instant,
    session_started_at,
    should_record_login,
)

SUB = "auth-login-1"
ME_URL = "/api/v1/me"


def _amr(started_ago: int = 120, *, totp_ago: int | None = None) -> list[dict[str, object]]:
    """Claim `amr` do GoTrue: o MENOR `timestamp` é o início da sessão."""
    now = int(time.time())
    entries: list[dict[str, object]] = [{"method": "password", "timestamp": now - started_ago}]
    if totp_ago is not None:
        entries.append({"method": "totp", "timestamp": now - totp_ago})
    return entries


def _session_start(amr: list[dict[str, object]]) -> datetime:
    return datetime.fromtimestamp(
        min(float(entry["timestamp"]) for entry in amr), tz=timezone.utc
    )


def _updates(api) -> list[str]:
    """`UPDATE users` que tocam `last_login_at` (ignora os da própria fixture)."""
    return [
        sql
        for sql in api.queries
        if sql.strip().upper().startswith("UPDATE USERS") and "last_login_at" in sql
    ]


def _logins(api) -> list:
    return api.world.audits(OP_LOGIN)


def _stored(api, user_id: uuid.UUID) -> datetime | None:
    # SQLite devolve `datetime` sem tzinfo (no Postgres a coluna é
    # `timestamptz` e volta com fuso); `as_utc` normaliza os dois casos.
    return as_utc(api.world.get(user_id).last_login_at)


# ---------------------------------------------------------------------------
# 1) Caminho feliz: primeiro acesso de uma sessão
# ---------------------------------------------------------------------------


def test_primeiro_acesso_grava_instante_do_inicio_da_sessao_em_utc(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    assert api.world.get(user_id).last_login_at is None

    amr = _amr()
    response = api.client.get(ME_URL, headers=auth_headers(SUB, amr=amr))

    assert response.status_code == 200
    expected = _session_start(amr)
    stored = _stored(api, user_id)
    assert stored is not None
    assert stored.tzinfo is not None and stored.utcoffset() == timedelta(0)
    assert stored == expected
    # O titular já vê o login NESTA resposta (instância em memória atualizada).
    body = response.get_json()
    assert body["last_login_at"] == expected.isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def test_login_registra_uma_linha_em_audit_logs_com_o_aal_da_sessao(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)

    api.client.get(ME_URL, headers=auth_headers(SUB, aal="aal2", amr=_amr()))

    rows = _logins(api)
    assert len(rows) == 1
    row = rows[0]
    assert row.entity_type == AUDIT_ENTITY_TYPE == "auth"
    assert row.entity_id == str(user_id)
    assert row.actor_user_id == user_id
    assert row.operation == "LOGIN"
    # `ck_audit_logs_result` só aceita SUCESSO/FALHA.
    assert row.result == "SUCESSO"
    assert row.new_values == {"aal": "aal2"}
    assert row.previous_values is None


def test_auditoria_do_login_nunca_guarda_token_email_ou_claims(api):
    api.world.user(
        "Ana",
        role="USER",
        auth_user_id=SUB,
        email="ana.silva@agu.gov.br",
        last_login_at=None,
    )
    headers = auth_headers(SUB, amr=_amr())
    token = headers["Authorization"].split(" ", 1)[1]

    api.client.get(ME_URL, headers=headers)

    dumped = "".join(
        f"{row.new_values}{row.previous_values}{row.entity_id}" for row in _logins(api)
    )
    assert token not in dumped
    assert "ana.silva@agu.gov.br" not in dumped
    assert "amr" not in dumped and "password" not in dumped


# ---------------------------------------------------------------------------
# 2) Dedupe por sessão: uma escrita por LOGIN, nunca por requisição
# ---------------------------------------------------------------------------


def test_mesmo_token_duas_vezes_gera_exatamente_um_update(api):
    api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    headers = auth_headers(SUB, amr=_amr())

    assert api.client.get(ME_URL, headers=headers).status_code == 200
    assert api.client.get(ME_URL, headers=headers).status_code == 200

    assert len(_updates(api)) == 1


def test_varias_requisicoes_da_mesma_sessao_geram_uma_unica_linha_login(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    amr = _amr()

    for _ in range(5):
        # Tokens diferentes (refresh do Supabase muda `iat`), MESMA sessão: o
        # `amr` é preservado, então o instante calculado é o mesmo.
        headers = auth_headers(SUB, amr=amr, iat=int(time.time()))
        assert api.client.get(ME_URL, headers=headers).status_code == 200

    assert len(_logins(api)) == 1
    assert len(_updates(api)) == 1
    assert _stored(api, user_id) == _session_start(amr)


def test_sessao_nova_grava_de_novo(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    primeira = _amr(started_ago=7200)
    segunda = _amr(started_ago=60)

    api.client.get(ME_URL, headers=auth_headers(SUB, amr=primeira))
    api.client.get(ME_URL, headers=auth_headers(SUB, amr=segunda))

    assert len(_logins(api)) == 2
    assert _stored(api, user_id) == _session_start(segunda)


def test_token_de_sessao_mais_antiga_nao_faz_o_valor_retroceder(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    recente = _amr(started_ago=60)
    antiga = _amr(started_ago=86_000)

    api.client.get(ME_URL, headers=auth_headers(SUB, amr=recente))
    api.client.get(ME_URL, headers=auth_headers(SUB, amr=antiga))

    assert _stored(api, user_id) == _session_start(recente)
    assert len(_logins(api)) == 1


# ---------------------------------------------------------------------------
# 3) Fallback (sem `amr` utilizável): janela mínima, não uma escrita por request
# ---------------------------------------------------------------------------


def test_sem_amr_grava_uma_vez_e_respeita_a_janela_de_15_min(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    headers = auth_headers(SUB)  # `make_token` sem `amr`

    api.client.get(ME_URL, headers=headers)
    primeiro = _stored(api, user_id)
    api.client.get(ME_URL, headers=headers)

    assert primeiro is not None
    assert len(_updates(api)) == 1 and len(_logins(api)) == 1

    # Janela vencida: volta a gravar.
    api.world.set(
        user_id,
        last_login_at=datetime.now(timezone.utc)
        - timedelta(seconds=FALLBACK_MIN_INTERVAL_SECONDS + 60),
    )
    api.client.get(ME_URL, headers=headers)
    assert len(_logins(api)) == 2


@pytest.mark.parametrize(
    "amr",
    [
        "password",                                   # string em vez de lista
        [],                                           # lista vazia
        [{"method": "password"}],                     # sem timestamp
        [{"method": "password", "timestamp": "x"}],   # timestamp não numérico
        [{"method": "password", "timestamp": True}],  # bool não é número
        ["password"],                                 # lista de strings (RFC 8176)
        [{"method": "password", "timestamp": 1}, "lixo"],  # entrada malformada
    ],
)
def test_amr_malformado_cai_no_fallback_sem_quebrar(api, amr):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)

    response = api.client.get(ME_URL, headers=auth_headers(SUB, amr=amr))

    assert response.status_code == 200
    assert _stored(api, user_id) is not None


# ---------------------------------------------------------------------------
# 4) Acesso NEGADO nunca registra login
# ---------------------------------------------------------------------------


def test_usuario_inativo_nao_registra_login(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, active=False, last_login_at=None)

    response = api.client.get(ME_URL, headers=auth_headers(SUB, amr=_amr()))

    assert response.status_code == 401
    assert api.world.get(user_id).last_login_at is None
    assert _updates(api) == [] and _logins(api) == []


def test_usuario_excluido_nao_registra_login(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    now = datetime.now(timezone.utc)
    api.world.set(user_id, deleted_at=now, anonymized_at=now)

    response = api.client.get(ME_URL, headers=auth_headers(SUB, amr=_amr()))

    assert response.status_code == 401
    assert api.world.get(user_id).last_login_at is None
    assert _updates(api) == [] and _logins(api) == []


def test_sessao_revogada_nao_registra_login(api):
    user_id = api.world.user(
        "Ana",
        role="USER",
        auth_user_id=SUB,
        sessions_revoked_at=datetime.now(timezone.utc),
        last_login_at=None,
    )

    response = api.client.get(
        ME_URL, headers=auth_headers(SUB, amr=_amr(), iat=int(time.time()) - 600)
    )

    assert response.status_code == 401
    assert api.world.get(user_id).last_login_at is None
    assert _updates(api) == [] and _logins(api) == []


def test_token_invalido_nao_registra_login(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)

    response = api.client.get(ME_URL, headers={"Authorization": "Bearer nao.e.um.jwt"})

    assert response.status_code == 401
    assert api.world.get(user_id).last_login_at is None
    assert _updates(api) == [] and _logins(api) == []


def test_sub_orfao_nao_registra_login_em_ninguem(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)

    response = api.client.get(ME_URL, headers=auth_headers("auth-inexistente", amr=_amr()))

    assert response.status_code == 401
    assert api.world.get(user_id).last_login_at is None
    assert _updates(api) == [] and _logins(api) == []


# ---------------------------------------------------------------------------
# 5) Melhor-esforço: falha no registro NUNCA quebra a autenticação
# ---------------------------------------------------------------------------


def test_falha_de_banco_no_registro_nao_derruba_a_requisicao(api, caplog):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)
    boom = OperationalError("UPDATE users", {}, Exception("banco fora"))

    with patch.object(supabase_auth, "record_login", side_effect=boom), caplog.at_level(
        "WARNING"
    ):
        response = api.client.get(ME_URL, headers=auth_headers(SUB, amr=_amr()))

    assert response.status_code == 200
    assert response.get_json()["id"] == str(user_id)
    assert api.world.get(user_id).last_login_at is None
    assert "OperationalError" in caplog.text
    # Só a CLASSE do erro vai para o log (nem SQL nem mensagem do banco).
    assert "banco fora" not in caplog.text


def test_usuario_nao_ORM_nunca_abre_sessao_de_banco():
    """Dezenas de testes injetam `SimpleNamespace` no carregador de usuário;
    a guarda `isinstance(user, User)` evita qualquer toque no banco."""
    fake = SimpleNamespace(id=uuid.uuid4(), last_login_at=None)
    sessions = MagicMock()

    with patch.object(supabase_auth, "get_db_session", sessions):
        supabase_auth._record_login_best_effort(fake, {"amr": _amr()}, "aal2")

    sessions.assert_not_called()


# ---------------------------------------------------------------------------
# 6) Controle otimista: o login não mexe em `version`
# ---------------------------------------------------------------------------


def test_registro_de_login_nao_incrementa_version_nem_causa_409(api):
    unit = api.world.unit("A")
    adm = api.world.user("Adm", role="ADM", units=[unit], auth_user_id=SUB, last_login_at=None)
    alvo = api.world.user("Ana", role="USER", units=[unit], auth_user_id="auth-alvo", last_login_at=None)
    headers = auth_headers(SUB, amr=_amr(totp_ago=5))

    # O ALVO faz login (é o `version` dele que o PATCH confere) e o ADM também.
    assert api.client.get(ME_URL, headers=auth_headers("auth-alvo", amr=_amr())).status_code == 200
    assert api.client.get(ME_URL, headers=headers).status_code == 200
    assert api.world.get(alvo).last_login_at is not None
    assert api.world.get(adm).last_login_at is not None
    # Login NÃO é alteração de cadastro: `version` intacto nos dois.
    assert api.world.get(alvo).version == 1 and api.world.get(adm).version == 1

    # O `version` que o ADM tinha em mãos continua válido (nada de 409).
    response = api.client.patch(
        f"/api/v1/users/{alvo}", json={"version": 1, "role": "RH"}, headers=headers
    )
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["version"] == 2


def test_login_atualiza_apenas_last_login_at(api):
    user_id = api.world.user("Ana", role="USER", auth_user_id=SUB, avatar="x.webp", last_login_at=None)
    antes = api.world.get(user_id)
    snapshot = (antes.name, antes.email, antes.active, antes.version, antes.avatar_object_key)

    api.client.get(ME_URL, headers=auth_headers(SUB, amr=_amr()))

    depois = api.world.get(user_id)
    assert (
        depois.name,
        depois.email,
        depois.active,
        depois.version,
        depois.avatar_object_key,
    ) == snapshot
    assert depois.last_login_at is not None
    assert depois.deleted_at is None and depois.sessions_revoked_at is None


# ---------------------------------------------------------------------------
# 7) Transparência ao titular e anonimização
# ---------------------------------------------------------------------------


def test_me_expoe_last_login_at_nulo_antes_do_primeiro_registro(api):
    api.world.user("Ana", role="USER", auth_user_id=SUB, last_login_at=None)

    with patch.object(supabase_auth, "_record_login_best_effort", lambda *_a: None):
        body = api.client.get(ME_URL, headers=auth_headers(SUB, amr=_amr())).get_json()

    assert "last_login_at" in body and body["last_login_at"] is None


def test_listagem_administrativa_passa_a_mostrar_o_ultimo_login(api):
    unit = api.world.unit("A")
    api.world.user("Adm", role="ADM", units=[unit], auth_user_id=SUB, last_login_at=None)
    api.world.user("Ana", role="USER", units=[unit], auth_user_id="auth-ana", last_login_at=None)
    amr = _amr(totp_ago=5)

    api.client.get(ME_URL, headers=auth_headers("auth-ana", amr=_amr(started_ago=30)))
    listing = api.client.get(
        "/api/v1/users?sort=-last_login_at", headers=auth_headers(SUB, amr=amr)
    )

    assert listing.status_code == 200
    por_nome = {item["name"]: item["last_login_at"] for item in listing.get_json()["users"]}
    assert por_nome["Ana"] is not None and por_nome["Adm"] is not None


def test_anonimizacao_apaga_o_last_login_at(world):
    """LGPD: dado comportamental não sobrevive à anonimização (seria
    re-identificável via `audit_logs.actor_user_id`, que é preservado)."""
    from app.models.rbac import User
    from app.services import user_admin_service as svc_module
    from app.services.user_deletion_service import UserDeletionService

    unit = world.unit("A")
    actor = world.user("Adm", role="ADM", units=[unit], auth_user_id="auth-adm", last_login_at=None)
    world.user("Outro Adm", role="ADM", units=[unit], auth_user_id="auth-adm-2", last_login_at=None)
    alvo = world.user("Ana", role="USER", units=[unit], auth_user_id="auth-ana", last_login_at=None)
    world.set(alvo, last_login_at=datetime.now(timezone.utc))

    with patch.object(svc_module, "_acquire_advisory_xact_lock", lambda _db, _key: None):
        with world.session() as db:
            email = db.get(User, alvo).email
            UserDeletionService(
                db, admin_client=MagicMock(), storage=FakeStorage()
            ).delete_user(actor, alvo, version=1, confirm_text=email)

    linha = world.get(alvo)
    assert linha.last_login_at is None
    assert linha.deleted_at is not None and linha.anonymized_at is not None


# ---------------------------------------------------------------------------
# 8) Unidades puras das regras (sem banco)
# ---------------------------------------------------------------------------


def test_session_started_at_usa_o_menor_instante_do_amr():
    now = time.time()
    claims = {
        "amr": [
            {"method": "totp", "timestamp": now - 10},
            {"method": "password", "timestamp": now - 300},
        ]
    }
    assert session_started_at(claims) == datetime.fromtimestamp(now - 300, tz=timezone.utc)


@pytest.mark.parametrize(
    "claims",
    [
        {},
        {"amr": None},
        {"amr": [{"method": "password", "timestamp": time.time() + 3600}]},  # futuro
        {"amr": [{"method": "password", "timestamp": 0}]},  # 1970
        {"amr": [{"method": "password", "timestamp": float("inf")}]},
        "nao e dict",
    ],
)
def test_session_started_at_descarta_o_que_nao_da_para_confiar(claims):
    assert session_started_at(claims) is None


def test_resolve_login_instant_cai_no_fallback_com_janela():
    quando, janela = resolve_login_instant({})
    assert janela == FALLBACK_MIN_INTERVAL_SECONDS
    assert quando.tzinfo is not None

    amr = _amr(started_ago=60)
    quando, janela = resolve_login_instant({"amr": amr})
    assert janela == 0 and quando == _session_start(amr)


def test_should_record_login_compara_com_a_janela():
    agora = datetime.now(timezone.utc)
    assert should_record_login(None, agora, 0) is True
    assert should_record_login(agora, agora, 0) is False
    assert should_record_login(agora - timedelta(seconds=1), agora, 0) is True
    # Dentro da janela do fallback: não grava.
    assert should_record_login(agora - timedelta(minutes=5), agora, 900) is False
    assert should_record_login(agora - timedelta(minutes=20), agora, 900) is True
    # Valor naive no banco é tratado como UTC; lixo é tratado como ausente.
    assert should_record_login(agora.replace(tzinfo=None), agora, 0) is False
    assert should_record_login("ontem", agora, 0) is True
