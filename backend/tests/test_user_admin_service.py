"""`UserAdminService` com SQL real (SQLite, ver `test_user_admin_db.py`).

Cobre: escopo de unidade (inclui convidados pendentes e usuários sem
unidade), busca com `escape_like`, filtros/ordenação por allowlist,
paginação, PATCH (confirmação de privilégio, auto-alteração, último ADM,
409 de versão, unidades fora do escopo preservadas), ativação/desativação
com Supabase falso, sessões, reset de senha/MFA, histórico com allowlist e
paridade de consultas entre alvo alheio e inexistente (AUD-14-07).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import event
from test_user_admin_db import World, build_engine

from app.config.settings import Settings
from app.integrations.supabase_admin_client import SupabaseAdminClientError
from app.models.audit import AuditLog
from app.models.invites import Invite
from app.services import user_admin_service as svc_module
from app.services.user_admin_service import (
    ActorNotAuthorizedError,
    AuthProviderUnavailableError,
    ConfirmationRequiredError,
    InvalidUnitError,
    LastAdminBlockedError,
    SelfChangeForbiddenError,
    TargetNotFoundError,
    TargetOutOfScopeError,
    UnitOutOfScopeError,
    UserAdminService,
    VersionConflictError,
    history_changes,
)

REDIRECT = "https://app.exemplo.invalid/ativar-conta"


@pytest.fixture()
def world():
    return World(build_engine())


@pytest.fixture(autouse=True)
def locks():
    taken: list[int] = []
    with patch.object(svc_module, "_acquire_advisory_xact_lock", lambda _db, key: taken.append(key)):
        yield taken


@pytest.fixture()
def scene(world):
    a, b, c = world.unit("A"), world.unit("B"), world.unit("C")
    actor = world.user("Adm Atual", role="ADM", units=[a, c])
    other_adm = world.user("Outro Adm", role="ADM", units=[a])
    user_a = world.user("Usuaria A", role="USER", units=[a])
    user_b = world.user("Usuario B", role="USER", units=[b])
    user_ab = world.user("Pessoa AB", role="RH", units=[a, b])
    orphan = world.user("Sem Unidade")  # acesso revogado: sem papel nem unidade
    pending_a = world.user("Convidado A")
    world.pending_invite(pending_a, [a], invited_by=actor)
    pending_b = world.user("Convidado B")
    world.pending_invite(pending_b, [b], invited_by=actor)
    return SimpleNamespace(
        a=a, b=b, c=c, actor=actor, other_adm=other_adm, user_a=user_a, user_b=user_b,
        user_ab=user_ab, orphan=orphan, pending_a=pending_a, pending_b=pending_b,
    )


def _service(db, **kwargs):
    kwargs.setdefault("settings", SimpleNamespace(password_reset_redirect_effective_url=REDIRECT))
    return UserAdminService(db, **kwargs)


def _query(**overrides):
    base = {"q": None, "role": None, "unit_id": None, "active": None, "sort": "name", "page": 1, "page_size": 25}
    base.update(overrides)
    return SimpleNamespace(**base)


def _body(**overrides):
    base = {"version": 1, "role": None, "unit_ids": None, "confirm_privilege_change": None}
    base.update(overrides)
    return SimpleNamespace(**base)


def _names(payload):
    return [u["name"] for u in payload["users"]]


# ---------------------------------------------------------------------------
# Listagem e escopo
# ---------------------------------------------------------------------------


def test_listagem_aplica_escopo_de_unidade(world, scene):
    with world.session() as db:
        payload = _service(db).list_users(scene.actor, _query())
    names = set(_names(payload))
    assert {"Adm Atual", "Outro Adm", "Usuaria A", "Pessoa AB", "Sem Unidade", "Convidado A"} == names
    assert "Usuario B" not in names and "Convidado B" not in names
    assert payload["total"] == 6


def test_unidades_do_resumo_ficam_restritas_ao_escopo_do_adm(world, scene):
    with world.session() as db:
        payload = _service(db).list_users(scene.actor, _query(q="Pessoa AB"))
    (summary,) = payload["users"]
    assert [u["id"] for u in summary["units"]] == [str(scene.a)]
    assert summary["role"] == "RH" and summary["has_avatar"] is False and summary["version"] == 1
    assert set(summary) == {
        "id", "name", "email", "active", "role", "units", "has_avatar",
        "created_at", "last_login_at", "deactivated_at", "version",
    }


def test_adm_sem_unidades_nao_enxerga_ninguem(world, scene):
    lonely = world.user("Adm Sem Unidade", role="ADM")
    with world.session() as db:
        assert _service(db).list_users(lonely, _query())["total"] == 0
        with pytest.raises(TargetNotFoundError):
            _service(db).get_user(lonely, scene.orphan)


def test_busca_escapa_curingas_like(world, scene):
    world.user("100% certo", role="USER", units=[scene.a])
    world.user("100x certo", role="USER", units=[scene.a])
    world.user("a_b", role="USER", units=[scene.a])
    world.user("axb", role="USER", units=[scene.a])
    with world.session() as db:
        assert _names(_service(db).list_users(scene.actor, _query(q="100%"))) == ["100% certo"]
        assert _names(_service(db).list_users(scene.actor, _query(q="a_b"))) == ["a_b"]
        by_email = _service(db).list_users(scene.actor, _query(q="USUARIA.A@"))
    assert _names(by_email) == ["Usuaria A"]


def test_filtros_de_perfil_unidade_e_ativo(world, scene):
    world.set(scene.user_a, active=False)
    with world.session() as db:
        service = _service(db)
        assert set(_names(service.list_users(scene.actor, _query(role="ADM")))) == {"Adm Atual", "Outro Adm"}
        assert _names(service.list_users(scene.actor, _query(active="false"))) == ["Usuaria A"]
        in_c = service.list_users(scene.actor, _query(unit_id=scene.c))
        out_b = service.list_users(scene.actor, _query(unit_id=scene.b))
        ghost = service.list_users(scene.actor, _query(unit_id=uuid.uuid4()))
    assert _names(in_c) == ["Adm Atual"]
    # Unidade fora do escopo e inexistente: mesma resposta vazia (sem revelar vínculos).
    assert out_b == ghost and out_b["total"] == 0


def test_ordenacao_e_paginacao(world, scene):
    now = datetime.now(timezone.utc)
    world.set(scene.user_a, last_login_at=now - timedelta(days=1))
    world.set(scene.other_adm, last_login_at=now)
    with world.session() as db:
        service = _service(db)
        names_desc = _names(service.list_users(scene.actor, _query(sort="-name")))
        by_login = _names(service.list_users(scene.actor, _query(sort="-last_login_at")))
        page2 = service.list_users(scene.actor, _query(page=2, page_size=4))
    assert names_desc == sorted(names_desc, key=str.lower, reverse=True)
    assert by_login[:2] == ["Outro Adm", "Usuaria A"]  # nulos por último
    assert page2["total"] == 6 and len(page2["users"]) == 2 and page2["page"] == 2


def test_listagem_sem_n_mais_1(world, scene):
    for index in range(15):
        world.user(f"Extra {index:02d}", role="USER", units=[scene.a])
    statements: list[str] = []
    event.listen(world.engine, "before_cursor_execute", lambda *a: statements.append(a[2]))
    with world.session() as db:
        payload = _service(db).list_users(scene.actor, _query(page_size=100))
    assert payload["total"] == 21
    # escopo do ator + count + página + 4 selectinloads (papéis, unidades)
    assert len(statements) <= 8, statements


def test_get_user_alheio_e_inexistente_mesmo_erro_e_mesmas_consultas(world, scene):
    counts = {}
    for label, target in (("alheio", scene.user_b), ("inexistente", uuid.uuid4())):
        statements: list[str] = []
        listener = lambda *a, _s=statements: _s.append(a[2])  # noqa: E731
        event.listen(world.engine, "before_cursor_execute", listener)
        with world.session() as db, pytest.raises(TargetNotFoundError) as exc:
            _service(db).get_user(scene.actor, target)
        event.remove(world.engine, "before_cursor_execute", listener)
        counts[label] = len(statements)
        assert exc.value.status_code == 404 and exc.value.code == "not_found"
    assert counts["alheio"] == counts["inexistente"] == 4


def test_convidado_pendente_e_usuario_sem_unidade_sao_visiveis(world, scene):
    with world.session() as db:
        service = _service(db)
        assert service.get_user(scene.actor, scene.pending_a)["role"] is None
        assert service.get_user(scene.actor, scene.orphan)["units"] == []
        with pytest.raises(TargetNotFoundError):
            service.get_user(scene.actor, scene.pending_b)


def test_unidades_do_seletor_sao_so_as_ativas_do_escopo(world, scene):
    inactive = world.unit("Z", active=False)
    with world.session() as db:
        from app.models.units import UserUnitAccess

        db.add(UserUnitAccess(id=uuid.uuid4(), user_id=scene.actor, unit_id=inactive))
    with world.session() as db:
        payload = _service(db).list_units(scene.actor)
    assert {u["id"] for u in payload["units"]} == {str(scene.a), str(scene.c)}
    assert set(payload["units"][0]) == {"id", "code", "name"}


# ---------------------------------------------------------------------------
# PATCH
# ---------------------------------------------------------------------------


def test_troca_de_perfil_incrementa_versao_e_audita(world, scene, locks):
    with world.session() as db:
        result = _service(db, request_id="req-1").update_user(scene.actor, scene.user_a, _body(role="RH"))
    assert result.summary["role"] == "RH" and result.summary["version"] == 2
    assert result.privilege_changed is False
    assert world.role_codes(scene.user_a) == {"RH"}
    (audit,) = world.audits("USER_ROLE_CHANGED")
    assert audit.previous_values == {"role": "USER"} and audit.new_values == {"role": "RH"}
    assert audit.actor_user_id == scene.actor and audit.request_id == "req-1"
    assert locks == [svc_module._REVOKE_ADVISORY_LOCK_KEY]


def test_promover_a_adm_exige_confirmacao(world, scene):
    with world.session() as db, pytest.raises(ConfirmationRequiredError) as exc:
        _service(db).update_user(scene.actor, scene.user_a, _body(role="ADM"))
    assert exc.value.code == "confirmation_required"
    assert world.role_codes(scene.user_a) == {"USER"} and world.get(scene.user_a).version == 1
    with world.session() as db:
        result = _service(db).update_user(
            scene.actor, scene.user_a, _body(role="ADM", confirm_privilege_change=True)
        )
    assert result.privilege_changed and (result.previous_role, result.new_role) == ("USER", "ADM")


def test_rebaixar_adm_exige_confirmacao(world, scene):
    with world.session() as db, pytest.raises(ConfirmationRequiredError):
        _service(db).update_user(scene.actor, scene.other_adm, _body(role="USER"))
    with world.session() as db:
        _service(db).update_user(
            scene.actor, scene.other_adm, _body(role="USER", confirm_privilege_change=True)
        )
    assert world.role_codes(scene.other_adm) == {"USER"}


def test_auto_alteracao_bloqueada(world, scene):
    with world.session() as db, pytest.raises(SelfChangeForbiddenError) as exc:
        _service(db).update_user(scene.actor, scene.actor, _body(role="USER", confirm_privilege_change=True))
    assert exc.value.status_code == 409 and exc.value.code == "self_change_forbidden"


@pytest.fixture()
def skip_actor_revalidation():
    """Isola a regra do último ADM: com o ator revalidado como ADM ativo
    (UA-TOCTOU-01) ela só é alcançável sob concorrência (o ator também conta)."""
    with patch.object(UserAdminService, "_revalidate_actor", lambda self, actor_id: None):
        yield


def test_ultimo_adm_ativo_nao_pode_ser_rebaixado(skip_actor_revalidation):
    """Ator sem ADM isola a regra do serviço (os decorators já exigem ADM)."""
    w = World(build_engine())
    unit = w.unit("A")
    lone = w.user("Unico Adm", role="ADM", units=[unit])
    w.user("Adm Inativo", role="ADM", units=[unit], active=False)  # não conta
    helper = w.user("Ajudante", role="USER", units=[unit])
    with w.session() as db, pytest.raises(LastAdminBlockedError) as exc:
        _service(db).update_user(helper, lone, _body(role="USER", confirm_privilege_change=True))
    assert exc.value.status_code == 409 and exc.value.code == "last_admin"
    assert w.role_codes(lone) == {"ADM"} and w.get(lone).version == 1


def test_versao_desatualizada_retorna_conflito_sem_alterar(world, scene):
    world.set(scene.user_a, version=5)
    with world.session() as db, pytest.raises(VersionConflictError) as exc:
        _service(db).update_user(scene.actor, scene.user_a, _body(version=4, role="RH"))
    assert exc.value.status_code == 409 and exc.value.code == "version_conflict"
    assert world.role_codes(scene.user_a) == {"USER"} and world.audits("USER_ROLE_CHANGED") == []


def test_unidade_fora_do_escopo_ou_inexistente_negada(world, scene):
    for unit in (scene.b, uuid.uuid4()):
        with world.session() as db, pytest.raises(UnitOutOfScopeError) as exc:
            _service(db).update_user(scene.actor, scene.user_a, _body(unit_ids=[unit]))
        assert exc.value.status_code == 403 and exc.value.unit_ids == [str(unit)]
    assert world.unit_ids(scene.user_a) == {scene.a}


def test_unidade_inativa_do_escopo_rejeitada(world, scene):
    inactive = world.unit("Z", active=False)
    with world.session() as db:
        from app.models.units import UserUnitAccess

        db.add(UserUnitAccess(id=uuid.uuid4(), user_id=scene.actor, unit_id=inactive))
    with world.session() as db, pytest.raises(InvalidUnitError):
        _service(db).update_user(scene.actor, scene.user_a, _body(unit_ids=[inactive]))


def test_troca_de_unidades_preserva_vinculos_fora_do_escopo(world, scene):
    with world.session() as db:
        result = _service(db).update_user(scene.actor, scene.user_ab, _body(unit_ids=[scene.c]))
    assert world.unit_ids(scene.user_ab) == {scene.b, scene.c}
    assert [u["id"] for u in result.summary["units"]] == [str(scene.c)]
    (audit,) = world.audits("USER_UNITS_CHANGED")
    assert audit.previous_values == {"units": [str(scene.a)]}
    assert audit.new_values == {"units": [str(scene.c)]}


def test_patch_sem_mudanca_nao_incrementa_versao(world, scene):
    with world.session() as db:
        result = _service(db).update_user(
            scene.actor, scene.user_a, _body(role="USER", unit_ids=[scene.a])
        )
    assert result.changed is False and result.summary["version"] == 1
    assert world.audits() == []


def test_atribuir_perfil_a_convidado_pendente_supera_o_convite(world, scene):
    with world.session() as db:
        _service(db).update_user(scene.actor, scene.pending_a, _body(role="USER", unit_ids=[scene.a]))
    with world.session() as db:
        statuses = {i.status for i in db.query(Invite).all() if i.email.startswith("convidado.a")}
    assert statuses == {"REVOGADO"}
    (audit,) = world.audits("USER_ROLE_CHANGED")
    assert audit.new_values["invite_superseded"] is True


# ---------------------------------------------------------------------------
# Ativação, desativação e sessões
# ---------------------------------------------------------------------------


def test_desativar_grava_estado_sessoes_e_bane(world, scene, locks):
    admin = MagicMock()
    with world.session() as db:
        result = _service(db, admin_client=admin).deactivate(scene.actor, scene.user_a, 1, "saiu")
    user = world.get(scene.user_a)
    assert user.active is False and user.deactivated_by == scene.actor
    assert user.deactivated_at is not None and user.sessions_revoked_at is not None
    assert user.version == 2 and result.summary["active"] is False
    assert result.summary["deactivated_at"] is not None
    admin.ban_user.assert_called_once_with(user.auth_user_id)
    (audit,) = world.audits("USER_DEACTIVATED")
    assert audit.previous_values == {"active": True}
    assert audit.new_values["active"] is False and audit.new_values["reason"] == "saiu"
    assert locks  # lock global do último ADM


def test_falha_no_ban_nao_desfaz_a_desativacao_local(world, scene):
    admin = MagicMock()
    admin.ban_user.side_effect = SupabaseAdminClientError("fora")
    with world.session() as db:
        result = _service(db, admin_client=admin).deactivate(scene.actor, scene.user_a, 1, None)
    assert result.provider_synced is False and world.get(scene.user_a).active is False


def test_desativar_a_si_mesmo_e_o_ultimo_adm_bloqueados(world, scene, skip_actor_revalidation):
    with world.session() as db, pytest.raises(SelfChangeForbiddenError):
        _service(db).deactivate(scene.actor, scene.actor, 1, None)
    lone_world = World(build_engine())
    unit = lone_world.unit("A")
    lone = lone_world.user("Unico", role="ADM", units=[unit])
    helper = lone_world.user("Ajudante", role="USER", units=[unit])
    with lone_world.session() as db, pytest.raises(LastAdminBlockedError):
        _service(db).deactivate(helper, lone, 1, None)
    assert lone_world.get(lone).active is True


def test_ativar_desbane_e_limpa_desativacao(world, scene):
    admin = MagicMock()
    with world.session() as db:
        _service(db, admin_client=admin).deactivate(scene.actor, scene.user_a, 1, None)
    with world.session() as db:
        result = _service(db, admin_client=admin).activate(scene.actor, scene.user_a, 2)
    user = world.get(scene.user_a)
    assert user.active is True and user.deactivated_at is None and user.version == 3
    assert user.sessions_revoked_at is not None  # tokens antigos continuam inválidos
    admin.unban_user.assert_called_once_with(user.auth_user_id)
    assert result.summary["active"] is True


def test_ativar_com_supabase_fora_nao_altera_nada(world, scene):
    world.set(scene.user_a, active=False)
    admin = MagicMock()
    admin.unban_user.side_effect = SupabaseAdminClientError("fora")
    with world.session() as db, pytest.raises(AuthProviderUnavailableError) as exc:
        _service(db, admin_client=admin).activate(scene.actor, scene.user_a, 1)
    assert exc.value.status_code == 502
    assert world.get(scene.user_a).active is False and world.audits("USER_ACTIVATED") == []


def test_revogar_sessoes_nao_incrementa_versao(world, scene):
    with world.session() as db:
        payload = _service(db).revoke_sessions(scene.actor, scene.user_a)
    user = world.get(scene.user_a)
    assert payload["sessions_revoked_at"].endswith("Z") and user.sessions_revoked_at is not None
    assert user.version == 1
    (audit,) = world.audits("USER_SESSIONS_REVOKED")
    assert audit.new_values == {"sessions_revoked_at": payload["sessions_revoked_at"]}


# ---------------------------------------------------------------------------
# Senha e MFA
# ---------------------------------------------------------------------------


def test_reset_de_senha_envia_pelo_supabase_sem_link(world, scene):
    admin = MagicMock()
    admin.send_password_recovery.return_value = None
    with world.session() as db:
        payload = _service(db, admin_client=admin).send_password_reset(scene.actor, scene.user_a)
    assert payload == {"result": "sent"}
    email = world.get(scene.user_a).email
    admin.send_password_recovery.assert_called_once_with(email, REDIRECT)
    (audit,) = world.audits("USER_PASSWORD_RESET_SENT")
    assert audit.result == "SUCESSO" and email not in str(audit.new_values)


@pytest.mark.parametrize("case", ["inativo", "sem_redirect", "erro_provedor"])
def test_reset_de_senha_indisponivel(world, scene, case):
    admin = MagicMock()
    settings = SimpleNamespace(password_reset_redirect_effective_url=REDIRECT)
    if case == "inativo":
        world.set(scene.user_a, active=False)
    elif case == "sem_redirect":
        settings = SimpleNamespace(password_reset_redirect_effective_url=None)
    else:
        admin.send_password_recovery.side_effect = SupabaseAdminClientError("fora")
    with world.session() as db:
        payload = _service(db, admin_client=admin, settings=settings).send_password_reset(
            scene.actor, scene.user_a
        )
    assert payload == {"result": "unavailable"}
    if case != "erro_provedor":
        admin.send_password_recovery.assert_not_called()
    (audit,) = world.audits("USER_PASSWORD_RESET_SENT")
    assert audit.result == "FALHA"


def test_reset_de_mfa_remove_fatores_e_encerra_sessoes(world, scene):
    admin = MagicMock()
    admin.delete_all_mfa_factors.return_value = 3
    with world.session() as db:
        payload = _service(db, admin_client=admin).reset_mfa(scene.actor, scene.user_a)
    assert payload == {"removed_factors": 3}
    assert world.get(scene.user_a).sessions_revoked_at is not None
    (audit,) = world.audits("USER_MFA_RESET")
    assert audit.new_values["removed_factors"] == 3


def test_reset_de_mfa_falha_no_provedor_e_auditado(world, scene):
    admin = MagicMock()
    admin.delete_all_mfa_factors.side_effect = SupabaseAdminClientError("fora")
    with world.session() as db, pytest.raises(AuthProviderUnavailableError):
        _service(db, admin_client=admin).reset_mfa(scene.actor, scene.user_a)
    (audit,) = world.audits("USER_MFA_RESET")
    assert audit.result == "FALHA"
    # UA-MFA-01: sessões encerradas mesmo com o reset falho/parcial.
    assert world.get(scene.user_a).sessions_revoked_at is not None
    with world.session() as db, pytest.raises(SelfChangeForbiddenError):
        _service(db, admin_client=admin).reset_mfa(scene.actor, scene.actor)


# ---------------------------------------------------------------------------
# Histórico
# ---------------------------------------------------------------------------


def test_historico_inclui_alvo_e_autor_com_allowlist(world, scene):
    with world.session() as db:
        db.add_all(
            [
                AuditLog(
                    id=uuid.uuid4(), actor_user_id=scene.actor, entity_type="user",
                    entity_id=str(scene.user_a), operation="USER_ROLE_CHANGED",
                    previous_values={"role": "USER", "email": "x@y", "token": "segredo"},
                    new_values={"role": "RH", "invite_superseded": True, "reason": "texto livre"},
                    result="SUCESSO",
                ),
                # Alvo como AUTOR sobre usuário do escopo: entra (UA-AUD-01).
                AuditLog(
                    id=uuid.uuid4(), actor_user_id=scene.user_a, entity_type="user",
                    entity_id=str(scene.other_adm), operation="USER_SESSIONS_REVOKED",
                    previous_values={"sessions_revoked_at": None},
                    new_values={"sessions_revoked_at": "2026-10-15T12:00:00Z"}, result="SUCESSO",
                ),
                # Alvo como AUTOR sobre usuário FORA do escopo / sobre convite: não entra.
                AuditLog(
                    id=uuid.uuid4(), actor_user_id=scene.user_a, entity_type="user",
                    entity_id=str(scene.user_b), operation="USER_ACTIVATED",
                    previous_values={"active": False}, new_values={"active": True}, result="SUCESSO",
                ),
                AuditLog(
                    id=uuid.uuid4(), actor_user_id=scene.user_a, entity_type="invite",
                    entity_id=str(uuid.uuid4()), operation="INVITE_ACCEPTED",
                    previous_values={"status": "PENDENTE"}, new_values={"status": "ACEITO"},
                    result="SUCESSO",
                ),
                AuditLog(
                    id=uuid.uuid4(), actor_user_id=None, entity_type="security_event",
                    entity_id=str(scene.user_a), operation="AUTH_FAILED",
                    new_values={"details": {"reason": "session_revoked"}, "active": True},
                    result="FALHA",
                ),
                AuditLog(
                    id=uuid.uuid4(), actor_user_id=scene.actor, entity_type="user",
                    entity_id=str(scene.user_b), operation="USER_ROLE_CHANGED",
                    previous_values={"role": "USER"}, new_values={"role": "RH"}, result="SUCESSO",
                ),
            ]
        )
    with world.session() as db:
        payload = _service(db).audit_history(scene.actor, scene.user_a, 1, 25)
    assert payload["total"] == 3
    by_op = {event["operation"]: event for event in payload["events"]}
    assert by_op["USER_ROLE_CHANGED"]["changes"] == {"role": {"from": "USER", "to": "RH"}}
    assert by_op["USER_ROLE_CHANGED"]["actor"] == {"id": str(scene.actor), "name": "Adm Atual"}
    assert "USER_ACTIVATED" not in by_op and "INVITE_ACCEPTED" not in by_op
    assert by_op["USER_SESSIONS_REVOKED"]["changes"] == {
        "sessions_revoked_at": {"from": None, "to": "2026-10-15T12:00:00Z"}
    }
    assert by_op["AUTH_FAILED"]["changes"] == {} and by_op["AUTH_FAILED"]["actor"] is None
    blob = str(payload)
    assert "segredo" not in blob and "x@y" not in blob and "texto livre" not in blob
    assert set(payload["events"][0]) == {"id", "occurred_at", "operation", "result", "actor", "changes"}


def test_historico_filtra_unidades_alheias_e_pagina(world, scene):
    row = AuditLog(
        id=uuid.uuid4(), entity_type="user", entity_id=str(scene.user_ab),
        operation="USER_UNITS_CHANGED",
        previous_values={"units": [str(scene.a), str(scene.b)]},
        new_values={"units": [str(scene.b)]}, result="SUCESSO",
    )
    assert history_changes(row, {str(scene.a)}) == {"units": {"from": [str(scene.a)], "to": []}}
    with world.session() as db:
        for _ in range(3):
            db.add(AuditLog(id=uuid.uuid4(), entity_type="user", entity_id=str(scene.user_a),
                            operation="USER_SESSIONS_REVOKED", result="SUCESSO"))
    with world.session() as db:
        page = _service(db).audit_history(scene.actor, scene.user_a, 2, 2)
        with pytest.raises(TargetNotFoundError):
            _service(db).audit_history(scene.actor, scene.user_b, 1, 25)
    assert page["total"] == 3 and len(page["events"]) == 1


# ---------------------------------------------------------------------------
# Configuração do redirect de recuperação de senha
# ---------------------------------------------------------------------------


def _settings(**overrides):
    base = {
        "database_url": "postgresql+psycopg2://u:p@localhost:5432/t",
        "secret_key": "s" * 40,
        "invite_allowed_redirect_urls": "https://a.invalid/ativar,https://a.invalid/senha",
    }
    base.update(overrides)
    return Settings(**base)


def test_redirect_de_senha_precisa_estar_na_allowlist():
    assert _settings().password_reset_redirect_effective_url == "https://a.invalid/ativar"
    assert (
        _settings(password_reset_redirect_url="https://a.invalid/senha").password_reset_redirect_effective_url
        == "https://a.invalid/senha"
    )
    assert _settings(password_reset_redirect_url="https://evil.invalid/x").password_reset_redirect_effective_url is None
    assert _settings(invite_allowed_redirect_urls="").password_reset_redirect_effective_url is None


# ---------------------------------------------------------------------------
# UA-SCOPE-01 (escopo total para privilégio; conta órfã) e UA-TOCTOU-01
# ---------------------------------------------------------------------------


def test_promover_quem_tem_unidade_alheia_e_negado(world, scene):
    with world.session() as db, pytest.raises(TargetOutOfScopeError) as exc:
        _service(db).update_user(
            scene.actor, scene.user_ab, _body(role="ADM", confirm_privilege_change=True, unit_ids=[scene.a])
        )
    assert exc.value.status_code == 403 and exc.value.code == "target_out_of_scope"
    assert world.role_codes(scene.user_ab) == {"RH"} and world.unit_ids(scene.user_ab) == {scene.a, scene.b}


def test_rebaixar_desativar_e_resetar_mfa_de_adm_multiunidade_negados(world, scene):
    multi_adm = world.user("Adm AB", role="ADM", units=[scene.a, scene.b])
    admin = MagicMock()
    with world.session() as db, pytest.raises(TargetOutOfScopeError):
        _service(db).update_user(scene.actor, multi_adm, _body(role="USER", confirm_privilege_change=True))
    with world.session() as db, pytest.raises(TargetOutOfScopeError):
        _service(db, admin_client=admin).deactivate(scene.actor, multi_adm, 1, None)
    with world.session() as db, pytest.raises(TargetOutOfScopeError):
        _service(db, admin_client=admin).reset_mfa(scene.actor, multi_adm)
    admin.delete_all_mfa_factors.assert_not_called()
    assert world.get(multi_adm).active is True and world.role_codes(multi_adm) == {"ADM"}


def test_mfa_reset_e_desativacao_de_usuario_comum_multiunidade(world, scene):
    admin = MagicMock()
    admin.delete_all_mfa_factors.return_value = 1
    # Usuário comum (não ADM) de A+B pode ser desativado; o reset de MFA exige escopo total.
    with world.session() as db, pytest.raises(TargetOutOfScopeError):
        _service(db, admin_client=admin).reset_mfa(scene.actor, scene.user_ab)
    with world.session() as db:
        _service(db, admin_client=admin).deactivate(scene.actor, scene.user_ab, 1, None)
    assert world.get(scene.user_ab).active is False


def test_promover_adm_com_escopo_total_permitido(world, scene):
    with world.session() as db:
        result = _service(db).update_user(
            scene.actor, scene.user_a, _body(role="ADM", confirm_privilege_change=True)
        )
    assert result.privilege_changed and world.role_codes(scene.user_a) == {"ADM"}


def test_conta_orfa_so_reativa_ou_recebe_unidades(world, scene):
    admin = MagicMock()
    world.set(scene.orphan, active=False)
    with world.session() as db:
        _service(db, admin_client=admin).activate(scene.actor, scene.orphan, 1)
    # Perfil sem unidades, ADM sem unidades, sessões, senha e MFA: negados.
    for call in (
        lambda svc: svc.update_user(scene.actor, scene.orphan, _body(version=2, role="USER")),
        lambda svc: svc.update_user(
            scene.actor, scene.orphan, _body(version=2, role="ADM", confirm_privilege_change=True)
        ),
        lambda svc: svc.revoke_sessions(scene.actor, scene.orphan),
        lambda svc: svc.send_password_reset(scene.actor, scene.orphan),
        lambda svc: svc.reset_mfa(scene.actor, scene.orphan),
        lambda svc: svc.deactivate(scene.actor, scene.orphan, 2, None),
    ):
        with world.session() as db, pytest.raises(TargetOutOfScopeError):
            call(_service(db, admin_client=admin))
    admin.send_password_recovery.assert_not_called()
    # Unidades do escopo (com ou sem perfil) são permitidas.
    with world.session() as db:
        _service(db).update_user(scene.actor, scene.orphan, _body(version=2, role="USER", unit_ids=[scene.a]))
    assert world.role_codes(scene.orphan) == {"USER"} and world.unit_ids(scene.orphan) == {scene.a}


def test_orfa_promovida_a_adm_so_junto_com_unidades_do_escopo(world, scene):
    with world.session() as db, pytest.raises(UnitOutOfScopeError):
        _service(db).update_user(
            scene.actor, scene.orphan, _body(role="ADM", confirm_privilege_change=True, unit_ids=[scene.b])
        )
    with world.session() as db:
        result = _service(db).update_user(
            scene.actor, scene.orphan, _body(role="ADM", confirm_privilege_change=True, unit_ids=[scene.c])
        )
    assert result.privilege_changed and world.unit_ids(scene.orphan) == {scene.c}


def test_ator_que_deixou_de_ser_adm_e_negado_dentro_da_transacao(world, scene, locks):
    with world.session() as db:
        from app.models.rbac import UserRole

        db.query(UserRole).filter(UserRole.user_id == scene.actor).delete()
    for call in (
        lambda svc: svc.update_user(scene.actor, scene.user_a, _body(role="RH")),
        lambda svc: svc.deactivate(scene.actor, scene.user_a, 1, None),
        lambda svc: svc.activate(scene.actor, scene.user_a, 1),
        lambda svc: svc.revoke_sessions(scene.actor, scene.user_a),
        lambda svc: svc.reset_mfa(scene.actor, scene.user_a),
    ):
        with world.session() as db, pytest.raises(ActorNotAuthorizedError):
            call(_service(db, admin_client=MagicMock()))
    world.set(scene.other_adm, active=False)
    with world.session() as db, pytest.raises(ActorNotAuthorizedError):
        _service(db).update_user(scene.other_adm, scene.user_a, _body(role="RH"))
    assert world.role_codes(scene.user_a) == {"USER"} and world.get(scene.user_a).active is True


def test_reset_de_mfa_parcial_encerra_sessoes_e_audita_quantidade(world, scene):
    from app.integrations.supabase_admin_client import MfaResetIncompleteError

    admin = MagicMock()
    admin.delete_all_mfa_factors.side_effect = MfaResetIncompleteError(1)
    with world.session() as db, pytest.raises(AuthProviderUnavailableError):
        _service(db, admin_client=admin).reset_mfa(scene.actor, scene.user_a)
    (audit,) = world.audits("USER_MFA_RESET")
    assert audit.result == "FALHA" and audit.new_values["removed_factors"] == 1
    assert audit.new_values["result"] == "incomplete"
    assert world.get(scene.user_a).sessions_revoked_at is not None


def test_cota_do_reset_de_senha_so_e_consumida_apos_o_escopo(world, scene):
    consumed: list[str] = []
    admin = MagicMock()
    with world.session() as db, pytest.raises(TargetNotFoundError):
        _service(db, admin_client=admin).send_password_reset(
            scene.actor, scene.user_b, consume_target_quota=lambda: consumed.append("x")
        )
    assert consumed == []
    with world.session() as db:
        _service(db, admin_client=admin).send_password_reset(
            scene.actor, scene.user_a, consume_target_quota=lambda: consumed.append("x")
        )
    assert consumed == ["x"]
