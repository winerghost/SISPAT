"""Rotas da gestão de usuários (Etapa 2) ponta a ponta no test client.

Banco SQLite com schema real + carregador de usuário REAL de `require_auth`
(papéis/permissões lidos do banco), Redis/Supabase/Storage falsos (ver
`test_user_admin_db.py`). A matriz USER/RH/ADM-AAL1/ADM sem permissão de
TODAS as rotas novas está em `test_sec_route_inventory.py` (EXPECTED_POLICY)
e `test_sec_authz.py` (ADMIN_ENDPOINTS); aqui ficam IDOR, mass assignment,
regras de negócio na borda HTTP, sessões revogadas e reautenticação.
"""
from __future__ import annotations

import io
import math
import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from PIL import Image
from sqlalchemy import delete, select
from test_user_admin_db import (  # noqa: F401  (fixtures)
    api,
    auth_headers,
    recent_totp_amr,
    world,
)

from app.auth.supabase_auth import has_recent_totp, session_predates_revocation
from app.models.rbac import Permission, RolePermission

ADM_SUB = "auth-adm-principal"


@pytest.fixture()
def scene(api):
    w = api.world
    a, b = w.unit("A"), w.unit("B")
    actor = w.user("Adm Principal", role="ADM", units=[a], auth_user_id=ADM_SUB)
    second_adm = w.user("Adm Segundo", role="ADM", units=[a], auth_user_id="auth-adm-2")
    user_a = w.user("Usuaria A", role="USER", units=[a], auth_user_id="auth-user-a")
    user_b = w.user("Usuario B", role="USER", units=[b], auth_user_id="auth-user-b")
    return SimpleNamespace(api=api, w=w, a=a, b=b, actor=actor, second_adm=second_adm,
                           user_a=user_a, user_b=user_b)


def _headers(**kwargs):
    kwargs.setdefault("amr", recent_totp_amr())
    return auth_headers(ADM_SUB, **kwargs)


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 120, 200)).save(out, "PNG")
    return out.getvalue()


def _drop_permission(w, code: str) -> None:
    with w.session() as db:
        perm_id = db.execute(select(Permission.id).where(Permission.code == code)).scalar_one()
        db.execute(delete(RolePermission).where(RolePermission.permission_id == perm_id))


# (método, sufixo, corpo json, multipart?)
TARGET_ROUTES = [
    ("GET", "", None, False),
    ("PATCH", "", {"version": 1, "role": "RH"}, False),
    ("POST", "/deactivate", {"version": 1}, False),
    ("POST", "/activate", {"version": 1}, False),
    ("POST", "/revoke-sessions", None, False),
    ("POST", "/password-reset", None, False),
    ("POST", "/mfa-reset", None, False),
    ("GET", "/audit", None, False),
    ("PUT", "/avatar", None, True),
    ("DELETE", "/avatar", None, False),
    ("GET", "/avatar-url", None, False),
]


def _call(client, method, url, body, multipart):
    kwargs = {"headers": _headers()}
    if multipart:
        kwargs["data"] = {"file": (io.BytesIO(_png()), "foto.png", "image/png")}
        kwargs["content_type"] = "multipart/form-data"
    elif body is not None:
        kwargs["json"] = body
    return client.open(url, method=method, **kwargs)


# ---------------------------------------------------------------------------
# IDOR / BOLA: alheio = inexistente = malformado
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,suffix,body,multipart", TARGET_ROUTES)
def test_alvo_alheio_inexistente_e_malformado_tem_resposta_identica(scene, method, suffix, body, multipart):
    api = scene.api
    responses, query_counts = {}, {}
    for label, target in (("alheio", scene.user_b), ("inexistente", uuid.uuid4()), ("malformado", "nao-e-uuid")):
        start = len(api.queries)
        responses[label] = _call(api.client, method, f"/api/v1/users/{target}{suffix}", body, multipart)
        query_counts[label] = len(api.queries) - start
    bodies = {label: r.get_json() for label, r in responses.items()}
    assert {r.status_code for r in responses.values()} == {404}
    assert bodies["alheio"] == bodies["inexistente"] == bodies["malformado"]
    assert bodies["alheio"] == {"error": {"code": "not_found", "message": "Recurso não encontrado."}}
    assert str(scene.user_b) not in responses["alheio"].get_data(as_text=True)
    # Mesmo número de consultas para alheio e inexistente (sem oráculo de tempo).
    assert query_counts["alheio"] == query_counts["inexistente"]
    # Nada foi alterado no alvo alheio.
    assert scene.w.get(scene.user_b).version == 1 and scene.w.get(scene.user_b).active is True
    assert scene.w.audits("USER_ROLE_CHANGED") == []
    denied = [e for e in api.events if e["event_type"] == "UNIT_SCOPE_DENIED"]
    assert len(denied) == 2 and denied[0]["details"] == denied[1]["details"]


def test_adm_le_e_edita_usuario_do_escopo(scene):
    api = scene.api
    got = api.client.get(f"/api/v1/users/{scene.user_a}", headers=_headers())
    assert got.status_code == 200 and got.get_json()["role"] == "USER"
    patched = api.client.patch(
        f"/api/v1/users/{scene.user_a}", json={"version": 1, "role": "RH"}, headers=_headers()
    )
    assert patched.status_code == 200
    assert patched.get_json()["role"] == "RH" and patched.get_json()["version"] == 2
    assert api.locks  # lock global do "último ADM" reaproveitado


def test_listagem_e_unidades_respeitam_escopo(scene):
    api = scene.api
    listing = api.client.get("/api/v1/users?sort=-name&page_size=10", headers=_headers())
    assert listing.status_code == 200
    names = [u["name"] for u in listing.get_json()["users"]]
    assert "Usuario B" not in names and "Usuaria A" in names
    units = api.client.get("/api/v1/units", headers=_headers())
    assert units.get_json() == {"units": [{"id": str(scene.a), "code": "A", "name": "Unidade A"}]}
    assert api.client.get("/api/v1/units?x=1", headers=_headers()).status_code == 400


@pytest.mark.parametrize(
    "query",
    ["foo=1", "role=SUPER", "sort=password", "sort=name;drop", "page=0", "page_size=101",
     "q=" + "x" * 101, "active=yes", "unit_id=nao-uuid", "page=1&page=2"],
)
def test_listagem_rejeita_parametros_fora_da_allowlist(scene, query):
    response = scene.api.client.get(f"/api/v1/users?{query}", headers=_headers())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"


def test_parametro_desconhecido_na_listagem_e_auditado(scene):
    scene.api.client.get("/api/v1/users?is_admin=true", headers=_headers())
    escalations = [e for e in scene.api.events if e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"]
    assert escalations and escalations[0]["details"]["fields"] == ["is_admin"]


# ---------------------------------------------------------------------------
# Mass assignment, permissões por campo, regras do PATCH
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,value",
    [
        ("active", False),
        ("deleted_at", "2026-01-01T00:00:00Z"),
        ("auth_user_id", "auth-outro"),
        ("email", "novo@exemplo.invalid"),
        ("sessions_revoked_at", None),
        ("avatar_object_key", "x.webp"),
        ("deactivated_at", None),
        ("roles", ["ADM"]),
        ("is_admin", True),
    ],
)
def test_patch_rejeita_campos_nao_editaveis_com_evento(scene, field, value):
    api = scene.api
    response = api.client.patch(
        f"/api/v1/users/{scene.user_a}",
        json={"version": 1, "role": "RH", field: value},
        headers=_headers(),
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert str(value) not in response.get_json()["error"]["message"] or value in (None, True, False)
    assert scene.w.role_codes(scene.user_a) == {"USER"} and scene.w.get(scene.user_a).version == 1
    flagged = [
        e for e in api.events
        if e["event_type"] in {"PRIVILEGE_ESCALATION_ATTEMPT", "MASS_ASSIGNMENT_REJECTED"}
    ]
    assert flagged and field in flagged[0]["details"]["fields"]
    if field != "email":
        assert flagged[0]["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"


@pytest.mark.parametrize(
    "body",
    [{"version": 1}, {"version": 1, "role": None}, {"version": "1", "role": "RH"},
     {"version": 1, "unit_ids": []}, {"version": 1, "role": "SUPERADM"}, {"role": "RH"},
     {"version": 1, "unit_ids": ["nao-uuid"]}, {"version": 1, "role": "RH", "confirm_privilege_change": "sim"}],
)
def test_patch_corpo_invalido(scene, body):
    response = scene.api.client.patch(f"/api/v1/users/{scene.user_a}", json=body, headers=_headers())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize(
    "missing,body",
    [
        ("users.assign_role", {"version": 1, "role": "RH"}),
        ("users.assign_unit", {"version": 1, "unit_ids": [None]}),
    ],
)
def test_patch_exige_permissao_do_campo_antes_do_banco(scene, missing, body):
    api = scene.api
    _drop_permission(scene.w, missing)
    if body.get("unit_ids"):
        body = {"version": 1, "unit_ids": [str(scene.a)]}
    start = len(api.queries)
    response = api.client.patch(f"/api/v1/users/{scene.user_a}", json=body, headers=_headers())
    assert response.status_code == 403 and response.get_json()["error"]["code"] == "forbidden"
    # Só as consultas do require_auth (carregar usuário/papéis/permissões).
    assert all("user_unit_access" not in q.lower() or "role" in q.lower() for q in api.queries[start:])
    denied = [e for e in api.events if e["event_type"] == "ACCESS_DENIED"]
    assert denied and denied[-1]["details"] == {"reason": "missing_permission", "required": missing}


def test_patch_proprio_perfil_bloqueado_e_auditado(scene):
    api = scene.api
    response = api.client.patch(
        f"/api/v1/users/{scene.actor}",
        json={"version": 1, "role": "USER", "confirm_privilege_change": True},
        headers=_headers(),
    )
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "self_change_forbidden"
    assert any(e["event_type"] == "USER_ADMIN_BLOCKED" for e in api.events)


def test_promocao_a_adm_exige_confirmacao_e_gera_evento_high(scene):
    api = scene.api
    url = f"/api/v1/users/{scene.user_a}"
    first = api.client.patch(url, json={"version": 1, "role": "ADM"}, headers=_headers())
    assert first.status_code == 400 and first.get_json()["error"]["code"] == "confirmation_required"
    ok = api.client.patch(
        url, json={"version": 1, "role": "ADM", "confirm_privilege_change": True}, headers=_headers()
    )
    assert ok.status_code == 200 and ok.get_json()["role"] == "ADM"
    (event,) = [e for e in api.events if e["event_type"] == "USER_PRIVILEGE_CHANGED"]
    assert event["severity"] == "high" and event["details"] == {"from": "USER", "to": "ADM"}
    (audit,) = scene.w.audits("USER_ROLE_CHANGED")
    assert audit.previous_values == {"role": "USER"} and audit.new_values == {"role": "ADM"}


def test_versao_em_conflito_retorna_409(scene):
    response = scene.api.client.patch(
        f"/api/v1/users/{scene.user_a}", json={"version": 7, "role": "RH"}, headers=_headers()
    )
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "version_conflict"


def test_unidade_fora_do_escopo_403_auditado(scene):
    api = scene.api
    response = api.client.patch(
        f"/api/v1/users/{scene.user_a}", json={"version": 1, "unit_ids": [str(scene.b)]}, headers=_headers()
    )
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "unit_out_of_scope"
    assert str(scene.b) not in response.get_data(as_text=True)
    assert any(e["event_type"] == "UNIT_SCOPE_DENIED" and e["target"]["type"] == "unit" for e in api.events)


def test_desativar_ultimo_adm_409(scene):
    api = scene.api
    # Segundo ADM desativado => o ator é o único ADM ativo; ele não pode se
    # desativar (auto-alteração) e o outro ADM inativo não conta.
    api.client.post(f"/api/v1/users/{scene.second_adm}/deactivate", json={"version": 1}, headers=_headers())
    response = api.client.post(f"/api/v1/users/{scene.actor}/deactivate", json={"version": 1}, headers=_headers())
    assert response.status_code == 409 and response.get_json()["error"]["code"] == "self_change_forbidden"


# ---------------------------------------------------------------------------
# Ações de conta e sessões revogadas (require_auth)
# ---------------------------------------------------------------------------


def test_desativar_bloqueia_o_jwt_ja_emitido_do_alvo(scene):
    api = scene.api
    target_headers = auth_headers("auth-user-a")
    assert api.client.get("/api/v1/me", headers=target_headers).status_code == 200
    response = api.client.post(
        f"/api/v1/users/{scene.user_a}/deactivate", json={"version": 1, "reason": "saiu"}, headers=_headers()
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["active"] is False and body["version"] == 2 and body["deactivated_at"]
    api.admin.ban_user.assert_called_once_with("auth-user-a")
    assert api.client.get("/api/v1/me", headers=target_headers).status_code == 401
    activated = api.client.post(f"/api/v1/users/{scene.user_a}/activate", json={"version": 2}, headers=_headers())
    assert activated.status_code == 200 and activated.get_json()["active"] is True
    api.admin.unban_user.assert_called_once_with("auth-user-a")
    # Token antigo continua inválido (sessions_revoked_at mantido).
    assert api.client.get("/api/v1/me", headers=target_headers).status_code == 401


def test_revogar_sessoes_rejeita_token_antigo_e_aceita_novo_login(scene):
    api = scene.api
    old = auth_headers("auth-user-a", iat=int(time.time()) - 60)
    assert api.client.get("/api/v1/me", headers=old).status_code == 200
    response = api.client.post(f"/api/v1/users/{scene.user_a}/revoke-sessions", headers=_headers())
    assert response.status_code == 200 and set(response.get_json()) == {"sessions_revoked_at"}
    assert api.client.get("/api/v1/me", headers=old).status_code == 401
    failed = [e for e in api.events if e["event_type"] == "AUTH_FAILED"]
    assert failed[-1]["details"] == {"reason": "session_revoked"}
    login = int(time.time()) + 2
    fresh = auth_headers("auth-user-a", iat=login, amr=[{"method": "password", "timestamp": login}])
    assert api.client.get("/api/v1/me", headers=fresh).status_code == 200
    # UA-SESS-02: com revogação gravada, `amr` ausente => sessão tratada como revogada.
    assert api.client.get("/api/v1/me", headers=auth_headers("auth-user-a", iat=login)).status_code == 401


def test_rota_sem_corpo_rejeita_corpo(scene):
    response = scene.api.client.post(
        f"/api/v1/users/{scene.user_a}/revoke-sessions", json={"user_id": "x"}, headers=_headers()
    )
    assert response.status_code == 400 and response.get_json()["error"]["code"] == "validation_error"


def test_revoke_legado_agora_desativa_e_encerra_sessoes(scene):
    api = scene.api
    response = api.client.post(f"/api/v1/users/{scene.user_a}/revoke", headers=_headers())
    assert response.status_code == 200
    user = scene.w.get(scene.user_a)
    assert user.active is False and user.sessions_revoked_at is not None and user.version == 2
    api.admin.deactivate_user.assert_called_once_with("auth-user-a")
    assert scene.w.role_codes(scene.user_a) == set()


def test_reset_de_senha_limite_por_alvo_e_sem_link(scene, monkeypatch):
    api = scene.api
    from app.config.settings import get_settings

    monkeypatch.setattr(
        type(get_settings()), "password_reset_redirect_effective_url",
        property(lambda _self: "https://app.exemplo.invalid/ativar-conta"),
    )
    api.admin.send_password_recovery.return_value = None
    url = f"/api/v1/users/{scene.user_a}/password-reset"
    for _ in range(5):
        response = api.client.post(url, headers=_headers())
        assert response.status_code == 200 and response.get_json() == {"result": "sent"}
    assert api.client.post(url, headers=_headers()).status_code == 429
    assert api.admin.send_password_recovery.call_count == 5


def test_historico_do_usuario(scene):
    api = scene.api
    api.client.patch(f"/api/v1/users/{scene.user_a}", json={"version": 1, "role": "RH"}, headers=_headers())
    response = api.client.get(f"/api/v1/users/{scene.user_a}/audit?page_size=5", headers=_headers())
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["total"] == 1 and payload["page_size"] == 5
    (event,) = payload["events"]
    assert event["operation"] == "USER_ROLE_CHANGED" and event["result"] == "SUCESSO"
    assert event["changes"] == {"role": {"from": "USER", "to": "RH"}}
    assert event["actor"]["name"] == "Adm Principal"
    assert api.client.get(f"/api/v1/users/{scene.user_a}/audit?x=1", headers=_headers()).status_code == 400


# ---------------------------------------------------------------------------
# Reset de MFA: reautenticação pelo claim `amr`
# ---------------------------------------------------------------------------


def _bad_amr_cases():
    """Fábricas: o instante é calculado NA EXECUÇÃO do teste (suíte longa
    não pode transformar o caso "no futuro" em válido)."""
    now = lambda: int(time.time())  # noqa: E731
    return [
        lambda: None,
        lambda: "totp",
        lambda: ["totp"],
        lambda: {"method": "totp", "timestamp": now()},
        lambda: [{"method": "password", "timestamp": now()}],
        lambda: [{"method": "totp", "timestamp": now() - 301}],
        lambda: [{"method": "totp", "timestamp": now() + 120}],
        lambda: [{"method": "totp", "timestamp": str(now())}],
        lambda: [{"method": "totp", "timestamp": True}],
        lambda: [{"method": "TOTP", "timestamp": now()}],
        lambda: [{"method": "totp"}],
        lambda: [{"timestamp": now()}],
        lambda: [{"method": "otp", "timestamp": now()}] * 21 + [{"method": "totp", "timestamp": now()}],
    ]


BAD_AMR = _bad_amr_cases()


@pytest.mark.parametrize("amr_factory", BAD_AMR, ids=[f"amr{i}" for i in range(len(BAD_AMR))])
def test_mfa_reset_sem_reautenticacao_recente_e_negado(scene, amr_factory):
    api = scene.api
    amr = amr_factory()
    headers = auth_headers(ADM_SUB, amr=amr) if amr is not None else auth_headers(ADM_SUB)
    response = api.client.post(f"/api/v1/users/{scene.user_a}/mfa-reset", headers=headers)
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "REAUTH_REQUIRED"
    api.admin.delete_all_mfa_factors.assert_not_called()
    assert any(e["event_type"] == "REAUTH_REQUIRED" for e in api.events)


def test_mfa_reset_com_totp_recente_remove_fatores(scene):
    api = scene.api
    response = api.client.post(f"/api/v1/users/{scene.user_a}/mfa-reset", headers=_headers())
    assert response.status_code == 200 and response.get_json() == {"removed_factors": 2}
    api.admin.delete_all_mfa_factors.assert_called_once_with("auth-user-a")
    (event,) = [e for e in api.events if e["event_type"] == "USER_MFA_RESET"]
    assert event["severity"] == "high"
    assert scene.w.get(scene.user_a).sessions_revoked_at is not None


def test_mfa_reset_proprio_bloqueado(scene):
    response = scene.api.client.post(f"/api/v1/users/{scene.actor}/mfa-reset", headers=_headers())
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "self_change_forbidden"


def test_has_recent_totp_aceita_formato_documentado():
    now = 1_800_000_000
    claims = {"amr": [{"method": "password", "timestamp": now - 900}, {"method": "totp", "timestamp": now - 299}]}
    assert has_recent_totp(claims, now=now) is True
    assert has_recent_totp({"amr": [{"method": "totp", "timestamp": math.nan}]}, now=now) is False
    assert has_recent_totp({"amr": [{"method": "totp", "timestamp": now - 301}]}, now=now) is False


# ---------------------------------------------------------------------------
# iat x sessions_revoked_at (precisão de segundos)
# ---------------------------------------------------------------------------


REVOKED = datetime(2026, 10, 14, 12, 0, 0, 500_000, tzinfo=timezone.utc)
CUTOFF = int(datetime(2026, 10, 14, 12, 0, 0, tzinfo=timezone.utc).timestamp())


@pytest.mark.parametrize(
    "claims,revoked,expected",
    [
        ({"iat": CUTOFF - 1}, REVOKED, True),
        ({"iat": CUTOFF}, REVOKED, True),  # mesmo segundo: rejeitado (determinístico)
        ({"iat": CUTOFF + 1, "amr": [{"method": "password", "timestamp": CUTOFF + 1}]}, REVOKED, False),
        (
            {"iat": CUTOFF + 1, "amr": [{"method": "password", "timestamp": CUTOFF + 1}]},
            REVOKED.replace(tzinfo=None),  # naive = UTC
            False,
        ),
        ({"iat": CUTOFF + 1}, REVOKED, True),  # UA-SESS-02: sem amr => falha fechada
        ({"iat": "123"}, REVOKED, True),
        ({"iat": True}, REVOKED, True),
        ({}, REVOKED, True),
        ({"iat": CUTOFF - 999}, None, False),
        ({"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF - 10}]}, REVOKED, True),
        ({"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF + 30}]}, REVOKED, False),
        ({"iat": CUTOFF + 60, "amr": "password"}, REVOKED, True),  # UA-SESS-02
        ({"iat": CUTOFF + 60, "amr": []}, REVOKED, True),
        (
            {"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF + 30}, "lixo"]},
            REVOKED,
            True,
        ),
        # UA-SESS-01: TOTP re-verificado numa sessão antiga não a reabre.
        (
            {"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF - 10},
                                         {"method": "totp", "timestamp": CUTOFF + 50}]},
            REVOKED,
            True,
        ),
        ({"iat": CUTOFF + 60}, "2026-10-14", True),
    ],
)
def test_session_predates_revocation(claims, revoked, expected):
    assert session_predates_revocation(claims, revoked) is expected


def test_refresh_apos_revogacao_nao_ressuscita_a_sessao(scene):
    """Refresh do Supabase gera `iat` novo, mas preserva o `amr` da sessão."""
    api = scene.api
    login_at = int(time.time()) - 120
    api.client.post(f"/api/v1/users/{scene.user_a}/revoke-sessions", headers=_headers())
    refreshed = auth_headers(
        "auth-user-a", iat=int(time.time()) + 2, amr=[{"method": "password", "timestamp": login_at}]
    )
    assert api.client.get("/api/v1/me", headers=refreshed).status_code == 401


def test_revogacao_antiga_nao_afeta_sessoes_novas(scene):
    scene.w.set(scene.user_a, sessions_revoked_at=datetime.now(timezone.utc) - timedelta(days=1))
    now = int(time.time())
    headers = auth_headers("auth-user-a", amr=[{"method": "password", "timestamp": now}])
    assert scene.api.client.get("/api/v1/me", headers=headers).status_code == 200


# ---------------------------------------------------------------------------
# Correções da revisão AppSec (UA-SCOPE-01, UA-RL-01, UA-FE-01)
# ---------------------------------------------------------------------------


def test_promocao_de_alvo_com_unidade_alheia_403_target_out_of_scope_auditado(scene):
    api = scene.api
    multi = scene.w.user("Pessoa AB", role="USER", units=[scene.a, scene.b], auth_user_id="auth-ab")
    response = api.client.patch(
        f"/api/v1/users/{multi}",
        json={"version": 1, "role": "ADM", "confirm_privilege_change": True},
        headers=_headers(),
    )
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "target_out_of_scope"
    assert str(scene.b) not in response.get_data(as_text=True)
    (event,) = [e for e in api.events if e["event_type"] == "ACCESS_DENIED"]
    assert event["details"]["reason"] == "target_out_of_scope" and event["target"]["id"] == str(multi)
    assert scene.w.role_codes(multi) == {"USER"}


def test_cota_do_reset_de_senha_nao_e_consumida_por_alvo_alheio(scene, monkeypatch):
    """UA-RL-01: 404 de escopo não gasta o limite de 5/h do alvo."""
    api = scene.api
    from app.config.settings import get_settings

    monkeypatch.setattr(
        type(get_settings()), "password_reset_redirect_effective_url",
        property(lambda _self: "https://app.exemplo.invalid/ativar-conta"),
    )
    other_unit_adm = scene.w.user("Adm B", role="ADM", units=[scene.b], auth_user_id="auth-adm-b")
    assert other_unit_adm
    for _ in range(6):
        denied = api.client.post(
            f"/api/v1/users/{scene.user_a}/password-reset", headers=auth_headers("auth-adm-b", amr=recent_totp_amr())
        )
        assert denied.status_code == 404
    assert not [k for k in api.redis.counts if "target_quota" in k]
    ok = api.client.post(f"/api/v1/users/{scene.user_a}/password-reset", headers=_headers())
    assert ok.status_code == 200 and ok.get_json() == {"result": "sent"}


def test_me_informa_has_avatar(scene):
    api = scene.api
    headers = auth_headers("auth-user-a")
    assert api.client.get("/api/v1/me", headers=headers).get_json()["has_avatar"] is False
    scene.w.set(scene.user_a, avatar_object_key=f"{uuid.uuid4()}.webp")
    assert api.client.get("/api/v1/me", headers=headers).get_json()["has_avatar"] is True
