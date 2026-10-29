"""`UserDeletionService` com SQL real (SQLite, ver `test_user_admin_db.py`).

Exclusão de usuário = LÓGICA + ANONIMIZAÇÃO (contrato: plano
`docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md` §2). Cobre, com banco
de verdade: a transação única (papéis/unidades/convite/anonimização), a
irreversibilidade, `audit_logs` intacto e com `actor_user_id` preservado, o
e-mail anonimizado único e não roteável com o ORIGINAL liberado para um
convite novo, as guardas (autoexclusão, último ADM, escopo/IDOR, `version`,
`confirm_text`, cota por alvo) e a tolerância a falha do Supabase/Storage.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import func, or_, select
from test_user_admin_db import FakeStorage, World, build_engine

from app.integrations.supabase_admin_client import (
    InvalidIdentifierError,
    SupabaseAdminClientError,
)
from app.models.audit import AuditLog
from app.models.invites import Invite
from app.models.rbac import User
from app.services import user_admin_service as svc_module
from app.services.user_admin_service import (
    LastAdminBlockedError,
    SelfChangeForbiddenError,
    TargetNotFoundError,
    TargetOutOfScopeError,
    TargetRateLimitedError,
    VersionConflictError,
)
from app.services.user_deletion_service import (
    ANONYMIZED_NAME,
    OP_DELETED,
    ConfirmationMismatchError,
    UserDeletionService,
    anonymized_email,
    confirmation_matches,
    is_anonymized_email,
    mask_email,
)

AVATAR_KEY = "11111111-1111-4111-8111-111111111111.webp"


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
    actor = world.user("Adm Atual", role="ADM", units=[a, c], auth_user_id="auth-actor")
    other_adm = world.user("Outro Adm", role="ADM", units=[a], auth_user_id="auth-adm-2")
    user_a = world.user(
        "Usuaria A",
        role="USER",
        units=[a],
        auth_user_id="auth-user-a",
        email="Ana.Silva@agu.gov.br",
        avatar=AVATAR_KEY,
    )
    user_b = world.user("Usuario B", role="USER", units=[b], auth_user_id="auth-user-b")
    adm_ab = world.user("Adm AB", role="ADM", units=[a, b], auth_user_id="auth-adm-ab")
    orphan = world.user("Sem Unidade", auth_user_id="auth-orfao")  # acesso já revogado
    return SimpleNamespace(
        a=a, b=b, c=c, actor=actor, other_adm=other_adm, user_a=user_a, user_b=user_b,
        adm_ab=adm_ab, orphan=orphan,
    )


@pytest.fixture()
def admin_client():
    client = MagicMock()
    client.delete_user.return_value = None
    return client


@pytest.fixture()
def storage():
    store = FakeStorage()
    store.objects[AVATAR_KEY] = b"webp"
    return store


def _service(db, admin_client=None, storage=None):
    return UserDeletionService(db, admin_client=admin_client, storage=storage)


def _delete(world, scene, target, *, admin_client=None, storage=None, version=1,
            confirm_text=None, quota=None, actor=None):
    with world.session() as db:
        target_email = db.get(User, target).email if confirm_text is None else None
        return _service(db, admin_client, storage).delete_user(
            actor if actor is not None else scene.actor,
            target,
            version=version,
            confirm_text=confirm_text if confirm_text is not None else target_email,
            consume_target_quota=quota,
        )


# ---------------------------------------------------------------------------
# Caminho feliz: uma transação, anonimização irreversível, trilha preservada
# ---------------------------------------------------------------------------


def test_exclusao_anonimiza_revoga_tudo_e_preserva_a_trilha(world, scene, admin_client, storage, locks):
    # Evento anterior do alvo (precisa continuar intacto DEPOIS da exclusão).
    with world.session() as db:
        db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=scene.user_a,
                entity_type="user",
                entity_id=str(scene.user_a),
                operation="USER_ROLE_CHANGED",
                previous_values={"role": "USER"},
                new_values={"role": "RH"},
                result="SUCESSO",
            )
        )
    world.pending_invite(scene.user_a, [scene.a], invited_by=scene.actor)
    original_email = world.get(scene.user_a).email
    world.set(scene.user_a, phone="63999887766")

    result = _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)

    user = world.get(scene.user_a)
    # 1) exclusão lógica: a LINHA continua existindo (nunca DELETE físico)
    assert user is not None and user.deleted_at is not None
    assert user.deleted_by == scene.actor and user.anonymized_at is not None
    # 2) conta inativa e sessões revogadas
    assert user.active is False and user.sessions_revoked_at is not None
    assert user.deactivated_at is not None and user.deactivated_by == scene.actor
    # 3) anonimização (SÓ em `users`), irreversível
    assert user.name == ANONYMIZED_NAME
    assert user.email == anonymized_email(scene.user_a) and is_anonymized_email(user.email)
    assert original_email.lower() not in user.email.lower()
    assert user.avatar_object_key is None and user.auth_user_id is None
    with world.session() as db:  # `phone` é deferred: lido dentro da sessão
        assert db.execute(select(User.phone).where(User.id == scene.user_a)).scalar_one() is None
    assert user.version == 2
    # 4) papéis, unidades e convite pendente
    assert world.role_codes(scene.user_a) == set() and world.unit_ids(scene.user_a) == set()
    with world.session() as db:
        statuses = db.execute(select(Invite.status)).scalars().all()
    assert statuses == ["REVOGADO"]
    # 5) lock global do "último ADM" tomado (sem TOCTOU)
    assert locks and locks[0] == svc_module._REVOKE_ADVISORY_LOCK_KEY
    # 6) Supabase Auth: a IDENTIDADE é apagada (pós-commit), o que libera o
    # e-mail para um convite futuro e leva embora sessões/identidades/MFA.
    admin_client.delete_user.assert_called_once_with("auth-user-a")
    assert admin_client.ban_user.call_count == 0
    assert admin_client.delete_all_mfa_factors.call_count == 0
    assert result.provider_synced is True
    # 7) foto removida do bucket privado
    assert storage.deleted == [AVATAR_KEY] and AVATAR_KEY not in storage.objects
    # 8) resumo devolvido já anonimizado
    assert result.summary["name"] == ANONYMIZED_NAME
    assert result.summary["email"] == anonymized_email(scene.user_a)
    assert result.summary["active"] is False and result.summary["deleted_at"]
    assert result.summary["role"] is None and result.summary["units"] == []


def test_auditoria_da_exclusao_nao_guarda_o_email_e_nada_e_apagado(world, scene, admin_client, storage):
    with world.session() as db:
        db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=scene.user_a,
                entity_type="asset",
                entity_id="ativo-1",
                operation="ASSET_UPDATED",
                result="SUCESSO",
            )
        )
    original_email = world.get(scene.user_a).email
    before = len(world.audits())

    _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)

    events = world.audits()
    assert len(events) == before + 1  # append-only: nada removido/reescrito
    (deleted_event,) = [e for e in events if e.operation == OP_DELETED]
    assert deleted_event.entity_type == "user"
    assert deleted_event.entity_id == str(scene.user_a)
    assert deleted_event.actor_user_id == scene.actor
    assert deleted_event.new_values["anonymized"] is True
    assert deleted_event.new_values["email_masked"] == "A***@a***.br"
    # O e-mail mascarado NUNCA sai pela API de auditoria: `email_masked` não
    # está na allowlist de leitura; `deleted`/`active`/`role`/`roles`/`avatar`/
    # `sessions_revoked_at` estão (é o que o ADM enxerga).
    from app.services.admin_audit_service import CHANGE_KEYS

    assert "email_masked" not in CHANGE_KEYS
    visible = (set(deleted_event.new_values) | set(deleted_event.previous_values)) & set(
        CHANGE_KEYS
    )
    assert {"deleted", "active", "role", "roles", "avatar", "sessions_revoked_at"} <= visible
    # Nenhum evento (novo ou antigo) guarda o e-mail em claro.
    for event in events:
        dumped = f"{event.previous_values}{event.new_values}"
        assert original_email not in dumped and original_email.lower() not in dumped.lower()
    # A trilha do próprio excluído continua lá, com o actor_user_id PRESERVADO.
    kept = [e for e in events if e.actor_user_id == scene.user_a]
    assert len(kept) == 1 and kept[0].operation == "ASSET_UPDATED"


def test_email_original_fica_livre_para_novo_convite_e_anonimizados_nao_colidem(
    world, scene, admin_client, storage
):
    original_email = world.get(scene.user_a).email
    _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)

    # A idempotência defensiva de `InviteService.create_invite`
    # (invite_service.py:345+) procura uma linha por `auth_user_id` OU e-mail
    # normalizado. Com o alvo excluído (auth_user_id NULL + e-mail
    # anonimizado), ela NÃO encontra nada: o convite novo cria uma linha nova
    # em vez de reaproveitar a conta excluída.
    with world.session() as db:
        existing = (
            db.query(User)
            .filter(
                or_(
                    User.auth_user_id == "auth-novo-do-supabase",
                    func.lower(User.email) == original_email.strip().lower(),
                )
            )
            .first()
        )
    assert existing is None
    # No provedor, a identidade foi APAGADA (e não banida): sem isso o GoTrue
    # manteria o e-mail ocupado e `generate_invite_token_hash` recusaria o
    # convite novo com 502.
    admin_client.delete_user.assert_any_call("auth-user-a")
    assert admin_client.ban_user.call_count == 0

    # O e-mail ORIGINAL voltou a estar livre: `users.email` é NOT NULL UNIQUE,
    # e a nova linha (um convite futuro) é criada sem violar a unicidade.
    new_id = uuid.uuid4()
    with world.session() as db:
        db.add(User(id=new_id, auth_user_id="auth-novo", name="Ana de Novo",
                    email=original_email, active=True))
    assert world.get(new_id).email == original_email

    # Dois excluídos nunca colidem (o valor é derivado da PK).
    _delete(world, scene, scene.user_b, admin_client=admin_client, storage=storage,
            actor=scene.adm_ab)
    with world.session() as db:
        total = db.execute(select(func.count()).select_from(User)).scalar_one()
        distinct = db.execute(
            select(func.count(func.distinct(func.lower(User.email)))).select_from(User)
        ).scalar_one()
    assert total == distinct


def test_exclusao_de_conta_orfa_e_permitida(world, scene, admin_client, storage):
    """Caso de uso principal: revogar o acesso e depois excluir. Conta órfã
    não tem papel, unidade nem acesso operacional algum."""
    result = _delete(world, scene, scene.orphan, admin_client=admin_client, storage=storage)
    assert result.summary["deleted_at"] and world.get(scene.orphan).deleted_at is not None


# ---------------------------------------------------------------------------
# Guardas
# ---------------------------------------------------------------------------


def test_autoexclusao_bloqueada(world, scene, admin_client, storage):
    with pytest.raises(SelfChangeForbiddenError):
        _delete(world, scene, scene.actor, admin_client=admin_client, storage=storage)
    assert world.get(scene.actor).deleted_at is None
    assert admin_client.ban_user.call_count == 0


@pytest.fixture()
def skip_actor_revalidation():
    """Isola a regra do último ADM: com o ator revalidado como ADM ativo
    (UA-TOCTOU-01) ela só é alcançável sob concorrência (o ator também conta).
    Os decorators da rota já exigem ADM + AAL2."""
    from app.services.user_admin_service import UserAdminService

    with patch.object(UserAdminService, "_revalidate_actor", lambda self, actor_id: None):
        yield


def test_ultimo_adm_ativo_nao_pode_ser_excluido(skip_actor_revalidation, admin_client, storage):
    w = World(build_engine())
    unit = w.unit("A")
    lone = w.user("Unico Adm", role="ADM", units=[unit], auth_user_id="auth-lone",
                  email="unico@agu.gov.br")
    w.user("Adm Inativo", role="ADM", units=[unit], active=False)  # não conta
    helper = w.user("Ajudante", role="USER", units=[unit])
    with w.session() as db, pytest.raises(LastAdminBlockedError) as exc:
        _service(db, admin_client, storage).delete_user(
            helper, lone, version=1, confirm_text="unico@agu.gov.br"
        )
    assert exc.value.status_code == 409 and exc.value.code == "last_admin"
    user = w.get(lone)
    assert user.deleted_at is None and user.version == 1 and user.name == "Unico Adm"
    assert w.role_codes(lone) == {"ADM"}
    assert admin_client.ban_user.call_count == 0


def test_alvo_alheio_inexistente_e_ja_excluido_dao_o_mesmo_erro(world, scene, admin_client, storage):
    for target in (scene.user_b, uuid.uuid4()):
        with pytest.raises(TargetNotFoundError):
            _delete(world, scene, target, admin_client=admin_client, storage=storage,
                    confirm_text="qualquer@exemplo.invalid")
    assert world.get(scene.user_b).deleted_at is None and world.get(scene.user_b).version == 1

    _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)
    # Segunda exclusão do mesmo alvo: ele já não existe para a API.
    with pytest.raises(TargetNotFoundError):
        _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage,
                version=2, confirm_text=anonymized_email(scene.user_a))


def test_excluir_adm_com_unidade_alheia_e_negado(world, scene, admin_client, storage):
    with pytest.raises(TargetOutOfScopeError):
        _delete(world, scene, scene.adm_ab, admin_client=admin_client, storage=storage)
    assert world.get(scene.adm_ab).deleted_at is None


def test_version_divergente_nao_altera_nada(world, scene, admin_client, storage):
    with pytest.raises(VersionConflictError):
        _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage, version=7)
    user = world.get(scene.user_a)
    assert user.deleted_at is None and user.version == 1 and user.name == "Usuaria A"


@pytest.mark.parametrize(
    "typed",
    ["", "   ", "outro@agu.gov.br", "ana.silva@agu.gov.b", "Usuaria A", "ana.silva"],
)
def test_confirm_text_errado_bloqueia_a_exclusao(world, scene, admin_client, storage, typed):
    with pytest.raises(ConfirmationMismatchError):
        _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage,
                confirm_text=typed)
    assert world.get(scene.user_a).deleted_at is None
    assert world.audits(OP_DELETED) == []


def test_confirm_text_ignora_caixa_e_espacos(world, scene, admin_client, storage):
    _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage,
            confirm_text="  ANA.SILVA@AGU.GOV.BR ")
    assert world.get(scene.user_a).deleted_at is not None


def test_cota_por_alvo_so_e_consumida_depois_do_escopo(world, scene, admin_client, storage):
    calls: list[int] = []

    def quota() -> None:
        calls.append(1)
        raise TargetRateLimitedError()

    # Alvo alheio: 404 ANTES de consumir a cota da vítima (UA-RL-01).
    with pytest.raises(TargetNotFoundError):
        _delete(world, scene, scene.user_b, admin_client=admin_client, storage=storage,
                confirm_text="x@y.invalid", quota=quota)
    assert calls == []
    with pytest.raises(TargetRateLimitedError):
        _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage, quota=quota)
    assert calls == [1]
    assert world.get(scene.user_a).deleted_at is None


def test_ator_que_deixou_de_ser_adm_nao_exclui(world, scene, admin_client, storage):
    from app.services.user_admin_service import ActorNotAuthorizedError

    world.set(scene.actor, active=False)
    with pytest.raises(ActorNotAuthorizedError):
        _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)
    assert world.get(scene.user_a).deleted_at is None


# ---------------------------------------------------------------------------
# Falhas externas NUNCA desfazem a exclusão local
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "failure",
    [SupabaseAdminClientError("fora"), InvalidIdentifierError("id")],
    ids=["provedor_fora", "id_invalido"],
)
def test_falha_no_supabase_nao_desfaz_a_exclusao(world, scene, admin_client, storage, failure):
    admin_client.delete_user.side_effect = failure
    result = _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)
    assert result.provider_synced is False
    user = world.get(scene.user_a)
    assert user.deleted_at is not None and user.auth_user_id is None
    assert user.name == ANONYMIZED_NAME


def test_storage_fora_nao_desfaz_a_exclusao(world, scene, admin_client, storage):
    storage.down = True
    result = _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)
    assert result.extra["avatar_purged"] is False
    user = world.get(scene.user_a)
    assert user.deleted_at is not None and user.avatar_object_key is None


def test_sem_cliente_do_supabase_a_exclusao_ocorre_e_marca_dessincronia(world, scene, storage):
    result = _delete(world, scene, scene.user_a, admin_client=None, storage=storage)
    assert result.provider_synced is False
    assert world.get(scene.user_a).deleted_at is not None


# ---------------------------------------------------------------------------
# Leituras do módulo de usuários deixam de ver o excluído
# ---------------------------------------------------------------------------


def test_excluido_sai_da_listagem_e_do_escopo(world, scene, admin_client, storage):
    from app.services.user_admin_service import UserAdminService

    _delete(world, scene, scene.user_a, admin_client=admin_client, storage=storage)
    query = SimpleNamespace(q=None, role=None, unit_id=None, active=None, sort="name",
                            page=1, page_size=25)
    with world.session() as db:
        payload = UserAdminService(db).list_users(scene.actor, query)
        with pytest.raises(TargetNotFoundError):
            UserAdminService(db).get_user(scene.actor, scene.user_a)
    assert payload["total"] == len(payload["users"])
    assert all(u["name"] != ANONYMIZED_NAME for u in payload["users"])
    assert ANONYMIZED_NAME not in str(payload)


def test_excluido_nao_conta_como_adm_ativo(world, scene, admin_client, storage):
    """`other_adm` excluído não mantém o sistema administrável."""
    _delete(world, scene, scene.other_adm, admin_client=admin_client, storage=storage)
    assert world.role_codes(scene.other_adm) == set()
    assert world.get(scene.other_adm).active is False


# ---------------------------------------------------------------------------
# Helpers puros
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("ana.silva@agu.gov.br", "a***@a***.br"),
        ("A@b.io", "A***@b***.io"),
        ("semarroba", "***"),
        ("", "***"),
        (None, "***"),
        ("@dominio.com", "***"),
        ("local@", "***"),
    ],
)
def test_mask_email_nunca_vaza_o_endereco(value, expected):
    assert mask_email(value) == expected


def test_email_anonimizado_e_unico_e_nao_roteavel():
    first, second = uuid.uuid4(), uuid.uuid4()
    assert anonymized_email(first) != anonymized_email(second)
    assert anonymized_email(first).endswith("@anonimizado.invalid")  # RFC 2606
    assert is_anonymized_email(anonymized_email(first))
    assert not is_anonymized_email("ana@agu.gov.br")


@pytest.mark.parametrize(
    "typed,email,expected",
    [
        ("ana@x.br", "ana@x.br", True),
        (" ANA@X.BR ", "ana@x.br", True),
        ("ana@x.b", "ana@x.br", False),
        (None, "ana@x.br", False),
        ("", "", False),
        ("a" * 400, "a" * 400, False),  # acima do limite: nunca confirma
    ],
)
def test_confirmation_matches(typed, email, expected):
    assert confirmation_matches(typed, email) is expected
