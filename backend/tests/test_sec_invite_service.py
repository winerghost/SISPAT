"""Testes de segurança — `InviteService` (corrida, reuso e escopo de convites).

Regressão de:
    - corrida TOCTOU na proteção do "último ADM" (advisory lock transacional);
    - corrida/reuso na ativação de convite (advisory lock por usuário);
    - convite adulterado com papel ADM nunca concede ADM na ativação;
    - convite emitido para outra identidade do Supabase não é aceito pelo
      fallback de e-mail;
    - revogação remove também os vínculos de unidade (sem acesso residual).
Banco sempre mockado (mesmo padrão de `test_invite_service.py`).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.models.invites import Invite, InviteUnit
from app.models.rbac import Role, User, UserRole
from app.services.invite_service import (
    InviteNotFoundError,
    InviteService,
    InviteServiceError,
    LastAdminError,
)


class _Router:
    def __init__(self):
        self.by_model: dict[type, MagicMock] = {}

    def register(self, model):
        self.by_model[model] = MagicMock()
        return self.by_model[model]

    def __call__(self, model):
        if model not in self.by_model:
            raise AssertionError(f"query inesperada: {model!r}")
        return self.by_model[model]


def _db():
    db = MagicMock()
    router = _Router()
    db.query.side_effect = router
    return db, router


def _settings():
    s = MagicMock()
    s.invite_allowed_redirect_urls_list = ["https://app.exemplo.com/convite"]
    s.invite_ttl_days = 7
    return s


def _user(auth_user_id="auth-1", email="fulano@exemplo.com"):
    return User(id=uuid.uuid4(), auth_user_id=auth_user_id, name="F", email=email, active=True)


def _invite(role="USER", invited_auth_user_id="auth-1"):
    return Invite(
        id=uuid.uuid4(), email="fulano@exemplo.com", name="F", intended_role_code=role,
        status="PENDENTE", invited_by=uuid.uuid4(), invited_auth_user_id=invited_auth_user_id,
        created_at=datetime.now(timezone.utc), expires_at=datetime.now(timezone.utc) + timedelta(days=1),
    )


def _lock_calls(db):
    return [c for c in db.execute.call_args_list if "pg_advisory_xact_lock" in str(c.args[0])]


def test_activate_adquire_lock_por_usuario_antes_de_ler_convite():
    user = _user()
    db, router = _db()
    router.register(User).filter.return_value.first.return_value = user
    router.register(Invite).filter.return_value.first.return_value = None
    with pytest.raises(InviteNotFoundError):
        InviteService(db, MagicMock(), settings=_settings()).activate_invite(current_user_id=user.id)
    locks = _lock_calls(db)
    assert len(locks) == 1
    assert locks[0].args[1]["key"] == user.id.int & 0x7FFF_FFFF_FFFF_FFFF


def test_activate_convite_adulterado_com_papel_adm_nao_concede_nada():
    user = _user()
    db, router = _db()
    router.register(User).filter.return_value.first.return_value = user
    router.register(Invite).filter.return_value.first.return_value = _invite(role="ADM")
    with pytest.raises(InviteServiceError):
        InviteService(db, MagicMock(), settings=_settings()).activate_invite(current_user_id=user.id)
    assert not [c for c in db.add.call_args_list if isinstance(c.args[0], UserRole)]
    db.commit.assert_not_called()


def test_activate_convite_de_outra_identidade_via_fallback_de_email_negado():
    user = _user(auth_user_id="auth-NOVO")
    db, router = _db()
    router.register(User).filter.return_value.first.return_value = user
    # 1ª busca (por auth_user_id) não acha; fallback por e-mail acha convite
    # emitido para OUTRA identidade do Supabase Auth.
    router.register(Invite).filter.return_value.first.side_effect = [
        None, _invite(invited_auth_user_id="auth-ANTIGO"),
    ]
    with pytest.raises(InviteNotFoundError):
        InviteService(db, MagicMock(), settings=_settings()).activate_invite(current_user_id=user.id)
    db.commit.assert_not_called()


def test_activate_fallback_email_com_convite_sem_auth_id_continua_funcionando():
    user = _user()
    db, router = _db()
    router.register(User).filter.return_value.first.return_value = user
    router.register(Invite).filter.return_value.first.side_effect = [None, _invite(invited_auth_user_id=None)]
    router.register(Role).filter.return_value.first.return_value = Role(
        id=uuid.uuid4(), code="USER", name="U", active=True
    )
    router.register(InviteUnit).filter.return_value.all.return_value = []
    result = InviteService(db, MagicMock(), settings=_settings()).activate_invite(current_user_id=user.id)
    assert result["role"] == "USER"


def _revoke_setup(adm_links):
    target = _user()
    db, router = _db()
    router.register(User).filter.return_value.first.return_value = target
    adm_role = Role(id=uuid.uuid4(), code="ADM", name="A", active=True)
    router.register(Role).filter.return_value.first.return_value = adm_role
    links = [UserRole(id=uuid.uuid4(), user_id=uid, role_id=adm_role.id) for uid in adm_links(target.id)]
    router.register(UserRole).filter.return_value.all.side_effect = [links, [links[0]]]
    router.register(Invite).filter.return_value.first.return_value = None
    return db, target


def test_revoke_adquire_lock_global_antes_de_contar_adms():
    db, target = _revoke_setup(lambda tid: [tid])
    with pytest.raises(LastAdminError):
        InviteService(db, MagicMock(), settings=_settings()).revoke_access(
            target_user_id=target.id, revoked_by_user_id=uuid.uuid4()
        )
    assert len(_lock_calls(db)) == 1


def test_revoke_remove_vinculos_de_unidade_e_audita():
    db, target = _revoke_setup(lambda tid: [tid, uuid.uuid4()])
    InviteService(db, MagicMock(), settings=_settings()).revoke_access(
        target_user_id=target.id, revoked_by_user_id=uuid.uuid4()
    )
    statements = [str(c.args[0]) for c in db.execute.call_args_list]
    assert any(s.startswith("DELETE FROM user_unit_access") for s in statements)
    audit = [c.args[0] for c in db.add.call_args_list if c.args[0].__class__.__name__ == "AuditLog"]
    assert audit and audit[0].new_values["unit_access_removed"] is True
    db.commit.assert_called_once()


def test_revoke_conta_apenas_adms_com_usuario_ativo():
    """Regressão: a checagem de último ADM ignora ADMs com `users.active=false`."""
    db, target = _revoke_setup(lambda tid: [tid])
    with pytest.raises(LastAdminError):
        InviteService(db, MagicMock(), settings=_settings()).revoke_access(
            target_user_id=target.id, revoked_by_user_id=uuid.uuid4()
        )
    adm_filter = db.query(UserRole).filter.call_args_list[0]
    rendered = " ".join(str(arg) for arg in adm_filter.args)
    assert "users.active" in rendered
