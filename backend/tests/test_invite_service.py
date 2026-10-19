"""Testes de `app.services.invite_service.InviteService`.

Mesmo espírito de `backend/tests/test_import_service.py`: a sessão de banco
(`sqlalchemy.orm.Session`) e o `SupabaseAdminClient` são sempre mockados via
`unittest.mock.MagicMock` -- nenhuma chamada de rede ou conexão real de
banco é feita neste arquivo. `Session.query(Model)` é roteado por um
`_QueryRouter` dedicado por modelo, permitindo configurar
`.filter(...).first()/.all()` de forma independente por teste.

Cobre explicitamente os cenários de segurança pedidos:
    - Convite para `intended_role_code='ADM'` é rejeitado (nunca permite
      auto-atribuição/atribuição de ADM pelo fluxo de convite).
    - Convite duplicado pendente (mesmo e-mail, case-insensitive) é
      rejeitado com `InviteAlreadyPendingError`.
    - Convite expirado nunca pode ser aceito (`InviteExpiredError`), e a
      transição para `EXPIRADO` é persistida mesmo assim.
    - Aceitar um convite não duplica papéis/unidades numa segunda chamada
      (idempotência: a segunda chamada não encontra mais um convite
      `PENDENTE` e levanta `InviteNotFoundError`).
    - Revogar o único usuário com papel `ADM` restante é bloqueado
      (`LastAdminError`), sem remover nada.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.models.invites import Invite, InviteUnit
from app.models.rbac import Role, User, UserRole
from app.models.units import Unit
from app.services.invite_service import (
    InviteAlreadyPendingError,
    InviteExpiredError,
    InviteNotFoundError,
    InviteService,
    InviteServiceError,
    InviteValidationError,
    LastAdminError,
    UserNotFoundError,
)


# ---------------------------------------------------------------------------
# Helpers (mesmo espírito de test_import_service.py)
# ---------------------------------------------------------------------------


class _QueryRouter:
    """Mock de `Session.query(Model)` que direciona cada modelo para um mock
    dedicado, configurável de forma independente por teste."""

    def __init__(self) -> None:
        self.by_model: dict[type, MagicMock] = {}

    def register(self, model: type) -> MagicMock:
        mock = MagicMock()
        self.by_model[model] = mock
        return mock

    def __call__(self, model: type) -> MagicMock:
        if model not in self.by_model:
            raise AssertionError(f"query inesperada para o modelo {model!r} neste teste")
        return self.by_model[model]


def _make_db_mock() -> tuple[MagicMock, _QueryRouter]:
    db = MagicMock()
    router = _QueryRouter()
    db.query.side_effect = router
    return db, router


def _make_settings(
    redirect_urls: list[str] | None = None, ttl_days: int = 7
) -> MagicMock:
    settings = MagicMock()
    settings.invite_allowed_redirect_urls_list = redirect_urls or [
        "https://app.exemplo.com/ativar-conta"
    ]
    settings.invite_ttl_days = ttl_days
    return settings


def _make_unit(unit_id: uuid.UUID | None = None, active: bool = True) -> Unit:
    return Unit(
        id=unit_id or uuid.uuid4(), code="SEDE", name="Sede", active=active
    )


def _make_user(
    user_id: uuid.UUID | None = None,
    auth_user_id: str | None = "auth-1",
    email: str = "fulano@exemplo.com",
    active: bool = True,
) -> User:
    return User(
        id=user_id or uuid.uuid4(),
        auth_user_id=auth_user_id,
        name="Fulano",
        email=email,
        active=active,
    )


def _make_invite(
    *,
    invite_id: uuid.UUID | None = None,
    email: str = "fulano@exemplo.com",
    status: str = "PENDENTE",
    intended_role_code: str = "USER",
    invited_by: uuid.UUID | None = None,
    invited_auth_user_id: str | None = "auth-1",
    expires_at: datetime | None = None,
) -> Invite:
    return Invite(
        id=invite_id or uuid.uuid4(),
        email=email,
        name="Fulano",
        intended_role_code=intended_role_code,
        status=status,
        invited_by=invited_by or uuid.uuid4(),
        invited_auth_user_id=invited_auth_user_id,
        created_at=datetime.now(timezone.utc),
        expires_at=expires_at or (datetime.now(timezone.utc) + timedelta(days=7)),
    )


# ---------------------------------------------------------------------------
# create_invite: papel 'ADM' é sempre rejeitado
# ---------------------------------------------------------------------------


def test_create_invite_rejeita_intended_role_code_adm():
    db, _router = _make_db_mock()
    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(InviteValidationError):
        service.create_invite(
            invited_by_user_id=uuid.uuid4(),
            email="novo.adm@exemplo.com",
            name="Novo Administrador",
            intended_role_code="ADM",
            unit_ids=[uuid.uuid4()],
        )

    # Nenhuma chamada de rede/efeito colateral deve ocorrer antes dessa
    # validação -- é a primeira checagem feita por `create_invite`.
    admin_client.invite_user_by_email.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize("role_code", ["adm", "SUPERADMIN", "", "root"])
def test_create_invite_rejeita_qualquer_papel_fora_de_user_rh(role_code):
    db, _router = _make_db_mock()
    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(InviteValidationError):
        service.create_invite(
            invited_by_user_id=uuid.uuid4(),
            email="novo@exemplo.com",
            name="Novo Usuário",
            intended_role_code=role_code,
            unit_ids=[uuid.uuid4()],
        )


# ---------------------------------------------------------------------------
# create_invite: convite duplicado pendente é rejeitado (409 de domínio)
# ---------------------------------------------------------------------------


def test_create_invite_convite_duplicado_pendente_e_rejeitado():
    unit = _make_unit()

    db, router = _make_db_mock()
    unit_query = router.register(Unit)
    unit_query.filter.return_value.all.return_value = [unit]

    existing_pending = _make_invite(email="dup@exemplo.com", status="PENDENTE")
    invite_query = router.register(Invite)
    invite_query.filter.return_value.first.return_value = existing_pending

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(InviteAlreadyPendingError):
        service.create_invite(
            invited_by_user_id=uuid.uuid4(),
            email="DUP@exemplo.com",  # mesma caixa variada -- comparação é case-insensitive
            name="Pessoa Duplicada",
            intended_role_code="USER",
            unit_ids=[unit.id],
        )

    # A existência de um convite pendente é verificada ANTES de qualquer
    # chamada à API Admin do Supabase -- nenhum convite extra deve ser
    # disparado.
    admin_client.invite_user_by_email.assert_not_called()
    db.commit.assert_not_called()


# ---------------------------------------------------------------------------
# create_invite: unidade inexistente/inativa é rejeitada (sanity adicional)
# ---------------------------------------------------------------------------


def test_create_invite_rejeita_unidade_inativa():
    unit = _make_unit(active=False)

    db, router = _make_db_mock()
    unit_query = router.register(Unit)
    unit_query.filter.return_value.all.return_value = [unit]

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(InviteValidationError):
        service.create_invite(
            invited_by_user_id=uuid.uuid4(),
            email="novo@exemplo.com",
            name="Novo Usuário",
            intended_role_code="USER",
            unit_ids=[unit.id],
        )
    admin_client.invite_user_by_email.assert_not_called()


@pytest.mark.parametrize(
    "urls",
    [
        [],
        ["http://localhost:3000"],
        ["http://localhost:3000/"],
        ["https://app.exemplo.com/convite"],
        ["https://app.exemplo.com/x/ativar-conta/y"],
        ["https://app.exemplo.com/ativar-conta-falso"],
    ],
)
def test_create_invite_falha_se_primeira_url_nao_e_ativar_conta(urls):
    unit = _make_unit()
    db, router = _make_db_mock()
    router.register(Unit).filter.return_value.all.return_value = [unit]
    router.register(Invite).filter.return_value.first.return_value = None

    admin_client = MagicMock()
    settings = _make_settings()
    settings.invite_allowed_redirect_urls_list = urls
    service = InviteService(db, admin_client, settings=settings)

    with pytest.raises(InviteServiceError):
        service.create_invite(
            invited_by_user_id=uuid.uuid4(),
            email="novo@exemplo.com",
            name="Novo Usuário",
            intended_role_code="USER",
            unit_ids=[unit.id],
        )
    admin_client.invite_user_by_email.assert_not_called()
    db.commit.assert_not_called()


# ---------------------------------------------------------------------------
# create_invite: fluxo de sucesso (sanity adicional)
# ---------------------------------------------------------------------------


def test_create_invite_sucesso_cria_user_invite_e_invite_units():
    unit = _make_unit()

    db, router = _make_db_mock()
    unit_query = router.register(Unit)
    unit_query.filter.return_value.all.return_value = [unit]

    invite_query = router.register(Invite)
    invite_query.filter.return_value.first.return_value = None  # sem convite pendente

    user_query = router.register(User)
    user_query.filter.return_value.first.return_value = None  # sem usuário local ainda

    admin_client = MagicMock()
    admin_client.invite_user_by_email.return_value = {"id": "auth-novo-usuario"}

    service = InviteService(db, admin_client, settings=_make_settings())

    invite = service.create_invite(
        invited_by_user_id=uuid.uuid4(),
        email="novo@exemplo.com",
        name="Novo Usuário",
        intended_role_code="USER",
        unit_ids=[unit.id],
    )

    assert invite.status == "PENDENTE"
    assert invite.invited_auth_user_id == "auth-novo-usuario"
    admin_client.invite_user_by_email.assert_called_once()
    db.commit.assert_called_once()

    added_types = [type(call.args[0]) for call in db.add.call_args_list]
    assert User in added_types
    assert Invite in added_types


# ---------------------------------------------------------------------------
# activate_invite: convite expirado nunca pode ser aceito
# ---------------------------------------------------------------------------


def test_activate_invite_convite_expirado_nao_pode_ser_aceito():
    user_id = uuid.uuid4()
    user = _make_user(user_id=user_id)
    expired_invite = _make_invite(
        expires_at=datetime.now(timezone.utc) - timedelta(days=1)
    )

    db, router = _make_db_mock()
    user_query = router.register(User)
    user_query.filter.return_value.first.return_value = user

    invite_query = router.register(Invite)
    invite_query.filter.return_value.first.return_value = expired_invite

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(InviteExpiredError):
        service.activate_invite(current_user_id=user_id)

    assert expired_invite.status == "EXPIRADO"
    # A transição para EXPIRADO precisa ser persistida mesmo que a ativação
    # como um todo falhe.
    db.commit.assert_called_once()


# ---------------------------------------------------------------------------
# activate_invite: idempotência -- segunda chamada não duplica papéis/unidades
# ---------------------------------------------------------------------------


def test_activate_invite_chamada_repetida_nao_duplica_papeis_ou_unidades():
    user_id = uuid.uuid4()
    invited_by = uuid.uuid4()
    unit_id = uuid.uuid4()
    user = _make_user(user_id=user_id)
    role = Role(id=uuid.uuid4(), code="USER", name="Usuário", active=True)
    invite = _make_invite(invited_by=invited_by)
    invite_unit = InviteUnit(id=uuid.uuid4(), invite_id=invite.id, unit_id=unit_id)

    db, router = _make_db_mock()
    user_query = router.register(User)
    user_query.filter.return_value.first.return_value = user

    invite_query = router.register(Invite)
    # 1ª chamada: encontrado via auth_user_id (1 chamada ao Invite.filter().first()).
    # 2ª chamada: já não está mais PENDENTE -- nem a busca por auth_user_id
    # nem o fallback por e-mail encontram o convite (2 chamadas retornando None).
    invite_query.filter.return_value.first.side_effect = [invite, None, None]

    role_query = router.register(Role)
    role_query.filter.return_value.first.return_value = role

    invite_unit_query = router.register(InviteUnit)
    invite_unit_query.filter.return_value.all.return_value = [invite_unit]

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    result = service.activate_invite(current_user_id=user_id)
    assert result == {"role": "USER", "units": [str(unit_id)]}
    assert invite.status == "ACEITO"

    with pytest.raises(InviteNotFoundError):
        service.activate_invite(current_user_id=user_id)

    # Apenas UMA UserRole deve ter sido adicionada em toda a execução
    # (somente na 1ª chamada) -- a 2ª chamada não duplica nada.
    added_user_roles = [
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], UserRole)
    ]
    assert len(added_user_roles) == 1


# ---------------------------------------------------------------------------
# revoke_access: revogar o único ADM restante é bloqueado
# ---------------------------------------------------------------------------


def test_revoke_access_bloqueia_revogar_ultimo_adm():
    target_user_id = uuid.uuid4()
    target_user = _make_user(user_id=target_user_id, auth_user_id="auth-adm", email="adm@exemplo.com")
    adm_role = Role(id=uuid.uuid4(), code="ADM", name="Administrador", active=True)
    only_adm_link = UserRole(id=uuid.uuid4(), user_id=target_user_id, role_id=adm_role.id)

    db, router = _make_db_mock()
    user_query = router.register(User)
    user_query.filter.return_value.first.return_value = target_user

    role_query = router.register(Role)
    role_query.filter.return_value.first.return_value = adm_role

    user_role_query = router.register(UserRole)
    user_role_query.filter.return_value.all.return_value = [only_adm_link]

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(LastAdminError):
        service.revoke_access(target_user_id=target_user_id, revoked_by_user_id=uuid.uuid4())

    db.delete.assert_not_called()
    db.commit.assert_not_called()


def test_revoke_access_usuario_inexistente_retorna_erro_especifico():
    db, router = _make_db_mock()
    user_query = router.register(User)
    user_query.filter.return_value.first.return_value = None

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    with pytest.raises(UserNotFoundError):
        service.revoke_access(target_user_id=uuid.uuid4(), revoked_by_user_id=uuid.uuid4())


def test_revoke_access_permite_revogar_adm_quando_ha_outros_adms():
    target_user_id = uuid.uuid4()
    other_adm_id = uuid.uuid4()
    target_user = _make_user(user_id=target_user_id, auth_user_id="auth-adm-1", email="adm1@exemplo.com")
    adm_role = Role(id=uuid.uuid4(), code="ADM", name="Administrador", active=True)
    target_link = UserRole(id=uuid.uuid4(), user_id=target_user_id, role_id=adm_role.id)

    db, router = _make_db_mock()
    user_query = router.register(User)
    user_query.filter.return_value.first.return_value = target_user

    role_query = router.register(Role)
    role_query.filter.return_value.first.return_value = adm_role

    user_role_query = router.register(UserRole)
    # 1ª chamada (contagem de ADMs ativos): dois ADMs distintos.
    # 2ª chamada (papéis do usuário alvo, para remoção): apenas o link ADM dele.
    adm_link_other = UserRole(id=uuid.uuid4(), user_id=other_adm_id, role_id=adm_role.id)
    user_role_query.filter.return_value.all.side_effect = [
        [target_link, adm_link_other],
        [target_link],
    ]

    invite_query = router.register(Invite)
    invite_query.filter.return_value.first.return_value = None

    admin_client = MagicMock()
    service = InviteService(db, admin_client, settings=_make_settings())

    service.revoke_access(target_user_id=target_user_id, revoked_by_user_id=uuid.uuid4())

    db.delete.assert_called_once_with(target_link)
    db.commit.assert_called_once()
