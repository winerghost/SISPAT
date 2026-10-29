"""`POST /api/v1/users/<id>/delete` ponta a ponta no test client.

Banco SQLite com schema real + carregador de usuário REAL de `require_auth`
(papéis/permissões lidos do banco), Redis/Supabase/Storage falsos (ver
`test_user_admin_db.py`). Contrato: plano
`docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md` §2.

Cobre na borda HTTP: 200 com o resumo anonimizado, 404 IDÊNTICO para alvo
inexistente/malformado/de outra unidade (IDOR/BOLA), 409 de `version` e de
autoexclusão, 400 de `confirm_text`, mass assignment, AAL2/permissão
dedicada, limite por alvo, o JWT do excluído recebendo 401 e o
desaparecimento do excluído das leituras do módulo.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, select
from test_user_admin_db import (  # noqa: F401  (fixtures)
    api,
    auth_headers,
    recent_totp_amr,
    world,
)

from app.models.rbac import Permission, RolePermission, User
from app.services.user_deletion_service import ANONYMIZED_NAME, anonymized_email

ADM_SUB = "auth-adm-principal"
USER_A_EMAIL = "Ana.Silva@agu.gov.br"


@pytest.fixture()
def scene(api):
    w = api.world
    a, b = w.unit("A"), w.unit("B")
    actor = w.user("Adm Principal", role="ADM", units=[a], auth_user_id=ADM_SUB)
    second_adm = w.user("Adm Segundo", role="ADM", units=[a], auth_user_id="auth-adm-2")
    user_a = w.user("Usuaria A", role="USER", units=[a], auth_user_id="auth-user-a",
                    email=USER_A_EMAIL)
    user_b = w.user("Usuario B", role="USER", units=[b], auth_user_id="auth-user-b")
    return SimpleNamespace(api=api, w=w, a=a, b=b, actor=actor, second_adm=second_adm,
                           user_a=user_a, user_b=user_b)


def _headers(**kwargs):
    kwargs.setdefault("amr", recent_totp_amr())
    return auth_headers(ADM_SUB, **kwargs)


def _url(target) -> str:
    return f"/api/v1/users/{target}/delete"


def _body(email: str = USER_A_EMAIL, version: int = 1) -> dict:
    return {"version": version, "confirm_text": email}


def _drop_permission(w, code: str) -> None:
    with w.session() as db:
        perm_id = db.execute(select(Permission.id).where(Permission.code == code)).scalar_one()
        db.execute(delete(RolePermission).where(RolePermission.permission_id == perm_id))


# ---------------------------------------------------------------------------
# Caminho feliz
# ---------------------------------------------------------------------------


def test_exclui_anonimiza_e_derruba_o_jwt_do_alvo(scene):
    api = scene.api
    target_headers = auth_headers("auth-user-a")
    assert api.client.get("/api/v1/me", headers=target_headers).status_code == 200

    response = api.client.post(_url(scene.user_a), json=_body(), headers=_headers())

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["name"] == ANONYMIZED_NAME
    assert payload["email"] == anonymized_email(scene.user_a)
    assert payload["active"] is False and payload["deleted_at"] and payload["version"] == 2
    assert USER_A_EMAIL not in response.get_data(as_text=True)
    # A LINHA continua existindo (exclusão nunca é física).
    with scene.w.session() as db:
        assert db.get(User, scene.user_a) is not None
    # O JWT já emitido do excluído deixa de valer.
    assert api.client.get("/api/v1/me", headers=target_headers).status_code == 401
    # A identidade no Supabase Auth é APAGADA (libera o e-mail p/ reconvite);
    # nunca banida, e não é preciso remover fatores MFA antes.
    api.admin.delete_user.assert_called_once_with("auth-user-a")
    assert api.admin.ban_user.call_count == 0
    assert api.admin.delete_all_mfa_factors.call_count == 0
    deleted = [e for e in api.events if e["event_type"] == "USER_DELETED"]
    assert len(deleted) == 1 and deleted[0]["severity"] == "high"
    assert deleted[0]["details"] == {
        "operation": "delete",
        "anonymized": True,
        "provider_identity_removed": True,
    }
    assert deleted[0]["result"] == "SUCESSO"
    # Nenhum dado pessoal no evento de segurança.
    assert USER_A_EMAIL not in str(deleted[0]) and "Usuaria A" not in str(deleted[0])


def test_falha_no_provedor_nao_impede_a_exclusao_e_gera_evento(scene):
    api = scene.api
    from app.integrations.supabase_admin_client import SupabaseAdminClientError

    api.admin.delete_user.side_effect = SupabaseAdminClientError("fora")
    response = api.client.post(_url(scene.user_a), json=_body(), headers=_headers())
    assert response.status_code == 200
    assert scene.w.get(scene.user_a).deleted_at is not None
    sync_failed = [e for e in api.events if e["event_type"] == "USER_PROVIDER_SYNC_FAILED"]
    assert sync_failed and sync_failed[-1]["details"] == {"operation": "delete"}
    deleted = [e for e in api.events if e["event_type"] == "USER_DELETED"]
    assert deleted[-1]["details"]["provider_identity_removed"] is False


def test_excluido_desaparece_das_leituras_do_modulo(scene):
    api = scene.api
    assert api.client.post(_url(scene.user_a), json=_body(), headers=_headers()).status_code == 200

    listing = api.client.get("/api/v1/users", headers=_headers())
    assert listing.status_code == 200
    names = [u["name"] for u in listing.get_json()["users"]]
    assert "Usuaria A" not in names and ANONYMIZED_NAME not in names
    assert listing.get_json()["total"] == len(names)
    for url in (f"/api/v1/users/{scene.user_a}", f"/api/v1/users/{scene.user_a}/audit"):
        assert api.client.get(url, headers=_headers()).status_code == 404
    # Ações de conta no excluído também respondem o 404 único.
    again = api.client.post(_url(scene.user_a), json=_body(version=2), headers=_headers())
    assert again.status_code == 404 and again.get_json()["error"]["code"] == "not_found"


def test_jwt_de_usuario_excluido_e_recusado_com_401(scene):
    """Mesmo que o `auth_user_id` siga preenchido (linha marcada como excluída
    por outra via), `require_auth` nega e audita o motivo `deleted_user`."""
    api = scene.api
    headers = auth_headers("auth-user-a")
    assert api.client.get("/api/v1/me", headers=headers).status_code == 200
    now = datetime.now(timezone.utc)
    scene.w.set(scene.user_a, deleted_at=now, anonymized_at=now)
    response = api.client.get("/api/v1/me", headers=headers)
    assert response.status_code == 401
    failed = [e for e in api.events if e["event_type"] == "AUTH_FAILED"]
    assert failed[-1]["details"] == {"reason": "deleted_user"}


# ---------------------------------------------------------------------------
# IDOR/BOLA e guardas
# ---------------------------------------------------------------------------


def test_alvo_alheio_inexistente_e_malformado_tem_resposta_identica(scene):
    api = scene.api
    responses = {}
    for label, target in (
        ("alheio", scene.user_b),
        ("inexistente", uuid.uuid4()),
        ("malformado", "nao-e-uuid"),
    ):
        responses[label] = api.client.post(
            _url(target), json=_body("usuario.b@exemplo.invalid"), headers=_headers()
        )
    bodies = {label: r.get_json() for label, r in responses.items()}
    assert {r.status_code for r in responses.values()} == {404}
    assert bodies["alheio"] == bodies["inexistente"] == bodies["malformado"]
    assert bodies["alheio"] == {"error": {"code": "not_found", "message": "Recurso não encontrado."}}
    assert str(scene.user_b) not in responses["alheio"].get_data(as_text=True)
    user_b = scene.w.get(scene.user_b)
    assert user_b.deleted_at is None and user_b.version == 1 and user_b.active is True
    denied = [e for e in api.events if e["event_type"] == "UNIT_SCOPE_DENIED"]
    assert len(denied) == 2 and denied[0]["details"] == denied[1]["details"]
    assert denied[0]["details"] == {"context": "users.delete"}


def test_autoexclusao_bloqueada_e_auditada(scene):
    api = scene.api
    response = api.client.post(
        _url(scene.actor),
        json={"version": 1, "confirm_text": "adm.principal@exemplo.invalid"},
        headers=_headers(),
    )
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "self_change_forbidden"
    assert scene.w.get(scene.actor).deleted_at is None
    blocked = [e for e in api.events if e["event_type"] == "USER_ADMIN_BLOCKED"]
    assert blocked and blocked[-1]["details"]["reason"] == "self_change_forbidden"


def test_version_divergente_409_sem_excluir(scene):
    response = scene.api.client.post(_url(scene.user_a), json=_body(version=9), headers=_headers())
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "version_conflict"
    assert scene.w.get(scene.user_a).deleted_at is None


def test_confirm_text_errado_400_sem_excluir(scene):
    response = scene.api.client.post(
        _url(scene.user_a), json=_body("outro@agu.gov.br"), headers=_headers()
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "confirmation_mismatch"
    user = scene.w.get(scene.user_a)
    assert user.deleted_at is None and user.name == "Usuaria A"


def test_adm_inativo_e_excluivel_e_o_ultimo_adm_ativo_nao(scene):
    api = scene.api
    # Desativa o 2º ADM: sobra só o ator como ADM ativo. Excluí-lo seria
    # autoexclusão, então o cenário do "último ADM" é exercido pelo serviço
    # (`test_user_deletion_service.py`); aqui garante-se que um ADM inativo
    # continua excluível e que o sistema não fica sem administrador.
    api.client.post(
        f"/api/v1/users/{scene.second_adm}/deactivate", json={"version": 1}, headers=_headers()
    )
    response = api.client.post(
        _url(scene.second_adm),
        json={"version": 2, "confirm_text": "adm.segundo@exemplo.invalid"},
        headers=_headers(),
    )
    assert response.status_code == 200
    assert scene.w.get(scene.second_adm).deleted_at is not None
    # O ator (último ADM ativo) não pode se excluir.
    self_delete = api.client.post(
        _url(scene.actor),
        json={"version": 1, "confirm_text": "adm.principal@exemplo.invalid"},
        headers=_headers(),
    )
    assert self_delete.status_code == 409
    assert scene.w.get(scene.actor).deleted_at is None


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"version": 1},
        {"confirm_text": USER_A_EMAIL},
        {"version": 1, "confirm_text": USER_A_EMAIL, "role": "ADM"},
        {"version": 1, "confirm_text": USER_A_EMAIL, "deleted_at": "2026-01-01T00:00:00Z"},
        {"version": 1, "confirm_text": None},
        {"version": "1", "confirm_text": USER_A_EMAIL},
        {"version": 1, "confirm_text": "a" * 400},
    ],
)
def test_corpo_invalido_ou_com_campo_privilegiado_400(scene, body):
    response = scene.api.client.post(_url(scene.user_a), json=body, headers=_headers())
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert scene.w.get(scene.user_a).deleted_at is None


def test_campo_desconhecido_no_corpo_e_auditado(scene):
    api = scene.api
    response = api.client.post(
        _url(scene.user_a),
        json={"version": 1, "confirm_text": USER_A_EMAIL, "is_admin": True},
        headers=_headers(),
    )
    assert response.status_code == 400
    # `is_admin` é campo privilegiado: a tentativa é auditada (escalonamento).
    types = {e["event_type"] for e in api.events}
    assert types & {"MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT"}
    assert scene.w.get(scene.user_a).deleted_at is None


def test_sem_aal2_nao_exclui(scene):
    response = scene.api.client.post(
        _url(scene.user_a), json=_body(), headers=_headers(aal="aal1")
    )
    assert response.status_code == 403
    assert scene.w.get(scene.user_a).deleted_at is None


def test_sem_a_permissao_dedicada_nao_exclui(scene):
    _drop_permission(scene.w, "users.delete")
    response = scene.api.client.post(_url(scene.user_a), json=_body(), headers=_headers())
    assert response.status_code == 403
    assert scene.w.get(scene.user_a).deleted_at is None
    # As outras ações do módulo continuam funcionando (permissão é dedicada).
    assert scene.api.client.get(f"/api/v1/users/{scene.user_a}", headers=_headers()).status_code == 200


def test_limite_por_alvo_bloqueia_tentativas_repetidas(scene):
    api = scene.api
    # A cota por ALVO é consumida depois do escopo e ANTES de `version`/
    # `confirm_text`: tentativas erradas também contam.
    for _ in range(3):
        response = api.client.post(
            _url(scene.user_a), json=_body("errado@agu.gov.br"), headers=_headers()
        )
        assert response.status_code == 400
    limited = api.client.post(_url(scene.user_a), json=_body(), headers=_headers())
    assert limited.status_code == 429
    assert limited.get_json()["error"]["code"] == "rate_limited"
    assert scene.w.get(scene.user_a).deleted_at is None
