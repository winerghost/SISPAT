"""Infra de testes da gestão de usuários (Etapa 2): SQLite em memória com o
schema REAL dos modelos (tabelas de RBAC, unidades, convites e auditoria).

Por que SQLite: as regras de escopo, filtros, ordenação, último ADM e versão
são SQL de verdade; MagicMock esconderia erros de consulta. Adaptações (só
no DDL de teste): JSONB -> JSON, `gen_random_uuid()` removido (os serviços
sempre definem ids), `now()` -> CURRENT_TIMESTAMP, CHECKs de sintaxe
PostgreSQL removidos. `pg_advisory_xact_lock` não existe no SQLite e é
substituído por um registrador (os testes verificam que ele é chamado).

Este módulo também é importado pelos demais `test_user_admin_*`/`test_avatar_*`
(mesmo padrão de `test_sec_revoke_scope_extra.py`). Nenhuma rede, nenhum
Supabase/Redis real.
"""
from __future__ import annotations

import time
import uuid
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Iterable
from unittest.mock import MagicMock, patch

import jwt
import pytest
from sqlalchemy import CheckConstraint, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import DefaultClause

import app.models  # noqa: F401  (popula Base.metadata)
from app import create_app
from app.database.session import Base
from app.models.audit import AuditLog
from app.models.invites import Invite, InviteUnit
from app.models.rbac import Permission, Role, RolePermission, User, UserRole
from app.models.units import Unit, UserUnitAccess

JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # = tests/conftest.py

_TABLES = (
    "users",
    "roles",
    "permissions",
    "role_permissions",
    "user_roles",
    "units",
    "user_unit_access",
    "invites",
    "invite_units",
    "audit_logs",
    "user_preferences",
)

ADMIN_PERMISSIONS = (
    "users.manage",
    "users.invite",
    "users.revoke_access",
    "users.deactivate",
    "users.activate",
    "users.assign_role",
    "users.assign_unit",
    "users.revoke_sessions",
    "users.reset_password",
    "users.reset_mfa",
    "users.avatar.manage",
    "users.delete",
    "audit.read",
)


@compiles(JSONB, "sqlite")
def _jsonb_as_json(_type, _compiler, **_kw):  # pragma: no cover - trivial
    return "JSON"


def build_engine():
    engine = create_engine(
        "sqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
        future=True,
    )
    metadata = MetaData()
    for name in _TABLES:
        table = Base.metadata.tables[name].to_metadata(metadata)
        for constraint in list(table.constraints):
            if isinstance(constraint, CheckConstraint):
                table.constraints.discard(constraint)
        for column in table.columns:
            default = column.server_default
            if default is None:
                continue
            arg = str(getattr(default, "arg", "")).strip().lower()
            if "gen_random_uuid" in arg:
                column.server_default = None
            elif "now()" in arg:
                column.server_default = DefaultClause(text("CURRENT_TIMESTAMP"))
            elif arg == "true":
                column.server_default = DefaultClause(text("1"))
            elif arg == "false":
                column.server_default = DefaultClause(text("0"))
    metadata.create_all(engine)
    return engine


class World:
    """Fábrica de dados sintéticos sobre o SQLite."""

    def __init__(self, engine) -> None:
        self.engine = engine
        self.roles: dict[str, uuid.UUID] = {}
        with self.session() as db:
            for code in ("ADM", "USER", "RH"):
                role = Role(id=uuid.uuid4(), code=code, name=code, active=True)
                db.add(role)
                self.roles[code] = role.id
            for perm in ADMIN_PERMISSIONS:
                permission = Permission(
                    id=uuid.uuid4(), code=perm, resource=perm.split(".")[0], action=perm
                )
                db.add(permission)
                db.add(
                    RolePermission(
                        id=uuid.uuid4(), role_id=self.roles["ADM"], permission_id=permission.id
                    )
                )

    @contextmanager
    def session(self):
        db = Session(self.engine, expire_on_commit=False, future=True)
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def unit(self, code: str, *, active: bool = True) -> uuid.UUID:
        unit_id = uuid.uuid4()
        with self.session() as db:
            db.add(Unit(id=unit_id, code=code, name=f"Unidade {code}", active=active))
        return unit_id

    def user(
        self,
        name: str,
        *,
        role: str | None = None,
        roles: Iterable[str] = (),
        units: Iterable[uuid.UUID] = (),
        active: bool = True,
        auth_user_id: str | None = None,
        email: str | None = None,
        version: int = 1,
        avatar: str | None = None,
        last_login_at: datetime | None = None,
        created_at: datetime | None = None,
        sessions_revoked_at: datetime | None = None,
    ) -> uuid.UUID:
        user_id = uuid.uuid4()
        with self.session() as db:
            db.add(
                User(
                    id=user_id,
                    auth_user_id=auth_user_id or f"auth-{user_id.hex[:12]}",
                    name=name,
                    email=email or f"{name.lower().replace(' ', '.')}@exemplo.invalid",
                    active=active,
                    version=version,
                    avatar_object_key=avatar,
                    last_login_at=last_login_at,
                    created_at=created_at or datetime.now(timezone.utc),
                    sessions_revoked_at=sessions_revoked_at,
                )
            )
            db.flush()
            for code in ([role] if role else []) + list(roles):
                db.add(UserRole(id=uuid.uuid4(), user_id=user_id, role_id=self.roles[code]))
            for unit_id in units:
                db.add(UserUnitAccess(id=uuid.uuid4(), user_id=user_id, unit_id=unit_id))
        return user_id

    def pending_invite(self, user_id: uuid.UUID, units: Iterable[uuid.UUID], invited_by: uuid.UUID):
        with self.session() as db:
            user = db.get(User, user_id)
            invite = Invite(
                id=uuid.uuid4(),
                email=user.email,
                name=user.name,
                intended_role_code="USER",
                status="PENDENTE",
                invited_by=invited_by,
                invited_auth_user_id=user.auth_user_id,
                created_at=datetime.now(timezone.utc),
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
            db.add(invite)
            db.flush()
            for unit_id in units:
                db.add(InviteUnit(id=uuid.uuid4(), invite_id=invite.id, unit_id=unit_id))
            return invite.id

    def get(self, user_id: uuid.UUID) -> User:
        with self.session() as db:
            return db.get(User, user_id)

    def role_codes(self, user_id: uuid.UUID) -> set[str]:
        with self.session() as db:
            rows = db.execute(
                select(Role.code).join(UserRole, UserRole.role_id == Role.id).where(
                    UserRole.user_id == user_id
                )
            ).all()
            return {row[0] for row in rows}

    def unit_ids(self, user_id: uuid.UUID) -> set[uuid.UUID]:
        with self.session() as db:
            rows = db.execute(
                select(UserUnitAccess.unit_id).where(UserUnitAccess.user_id == user_id)
            ).all()
            return {row[0] for row in rows}

    def audits(self, operation: str | None = None) -> list[AuditLog]:
        with self.session() as db:
            stmt = select(AuditLog).order_by(AuditLog.occurred_at)
            if operation:
                stmt = stmt.where(AuditLog.operation == operation)
            return list(db.execute(stmt).scalars().all())

    def set(self, user_id: uuid.UUID, **values: Any) -> None:
        with self.session() as db:
            user = db.get(User, user_id)
            for key, value in values.items():
                setattr(user, key, value)


def make_token(sub: str, *, aal: str = "aal2", amr: Any = None, iat: int | None = None) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": sub,
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now if iat is None else iat,
        "exp": now + 3600,
        "aal": aal,
    }
    if amr is not None:
        claims["amr"] = amr
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def recent_totp_amr(seconds_ago: int = 10) -> list[dict[str, Any]]:
    now = int(time.time())
    return [
        {"method": "password", "timestamp": now - 3600},
        {"method": "totp", "timestamp": now - seconds_ago},
    ]


class FakeRedis:
    """INCR/EXPIRE em memória (rate limit determinístico)."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def incr(self, key: str) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    def expire(self, *_a: Any, **_k: Any) -> bool:
        return True


class FakeStorage:
    """Storage falso: guarda objetos em memória; `down=True` simula indisponível."""

    def __init__(self) -> None:
        from app.integrations.supabase_storage_client import StorageUnavailableError

        self._error = StorageUnavailableError
        self.objects: dict[str, bytes] = {}
        self.down = False
        self.deleted: list[str] = []

    def upload(self, key: str, data: bytes, content_type: str = "image/webp") -> None:
        if self.down:
            raise self._error("fora")
        self.objects[key] = data

    def delete(self, key: str) -> None:
        if self.down:
            raise self._error("fora")
        self.objects.pop(key, None)
        self.deleted.append(key)

    def create_signed_url(self, key: str, expires_in: int = 300) -> str:
        if self.down:
            raise self._error("fora")
        return f"https://projeto.supabase.co/storage/v1/object/sign/avatars/{key}?token=t.t.t"


@pytest.fixture()
def world():
    return World(build_engine())


@pytest.fixture()
def api(world):
    """App com banco SQLite, carregador de usuário REAL, Redis/Supabase/Storage falsos."""
    events: list[dict[str, Any]] = []
    locks: list[int] = []
    admin_client = MagicMock()
    admin_client.delete_all_mfa_factors.return_value = 2
    storage = FakeStorage()
    redis = FakeRedis()
    queries: list[str] = []

    @event.listens_for(world.engine, "before_cursor_execute")
    def _count(_conn, _cursor, statement, *_args):  # pragma: no cover - contador
        queries.append(statement)

    with ExitStack() as stack:
        for target in (
            "app.api.v1.users.get_db_session",
            "app.api.v1.units.get_db_session",
            "app.api.v1.me.get_db_session",
            "app.auth.supabase_auth.get_db_session",
        ):
            stack.enter_context(patch(target, world.session))
        stack.enter_context(
            patch(
                "app.services.user_admin_service._acquire_advisory_xact_lock",
                lambda _db, key: locks.append(key),
            )
        )
        stack.enter_context(
            patch(
                "app.services.invite_service._acquire_advisory_xact_lock",
                lambda _db, key: locks.append(key),
            )
        )
        stack.enter_context(patch("redis.Redis.from_url", return_value=redis))
        stack.enter_context(
            patch("app.api.v1.users.SupabaseAdminClient", MagicMock(return_value=admin_client))
        )
        stack.enter_context(
            patch("app.api.v1.users.SupabaseStorageClient", MagicMock(return_value=storage))
        )
        stack.enter_context(
            patch("app.api.v1.me.SupabaseStorageClient", MagicMock(return_value=storage))
        )
        stack.enter_context(
            patch("app.authorization.security_events._dispatch", side_effect=events.append)
        )
        yield SimpleNamespace(
            client=create_app().test_client(),
            world=world,
            events=events,
            locks=locks,
            admin=admin_client,
            storage=storage,
            redis=redis,
            queries=queries,
        )
    event.remove(world.engine, "before_cursor_execute", _count)


def auth_headers(sub: str, **kwargs: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub, **kwargs)}"}


# ---------------------------------------------------------------------------
# Sanidade da própria infra (o schema adaptado aceita o fluxo do ORM)
# ---------------------------------------------------------------------------


def test_harness_cria_schema_e_persiste_relacoes(world):
    unit = world.unit("A")
    user_id = world.user("Ana", role="USER", units=[unit])
    assert world.role_codes(user_id) == {"USER"}
    assert world.unit_ids(user_id) == {unit}
    assert world.get(user_id).version == 1


def test_harness_carregador_real_de_auth_le_permissoes_do_banco(world):
    from app.auth import supabase_auth

    unit = world.unit("A")
    world.user("Adm", role="ADM", units=[unit], auth_user_id="auth-adm-h")
    with patch.object(supabase_auth, "get_db_session", world.session):
        user, roles, perms = supabase_auth._load_user_with_roles_and_permissions("auth-adm-h")
    assert roles == {"ADM"} and set(ADMIN_PERMISSIONS) <= perms
    assert user.sessions_revoked_at is None
