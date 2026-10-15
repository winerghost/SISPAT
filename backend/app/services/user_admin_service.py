"""Gestão administrativa de usuários (Etapa 2) — toda a regra; rotas finas.

Contrato: `docs/architecture/modulo-configuracoes.md` ("Etapa 2 — Gestão de
usuários"). Consumido por `app/api/v1/users.py`, `units.py` e `me.py`.

ESCOPO (anti-IDOR/BOLA):
    "Unidades do alvo" = vínculos `user_unit_access` UNIDOS às unidades de
    convites PENDENTES dele (mesmo critério do `revoke`). O ADM enxerga/altera
    o alvo se (a) alguma dessas unidades está no escopo dele, ou (b) o alvo não
    tem NENHUMA unidade (ex.: acesso revogado — sem isso ninguém conseguiria
    reativá-lo). ADM sem nenhuma unidade não enxerga ninguém (falha fechada).
    `units` do `UserSummary` lista só unidades DO ESCOPO do ADM; vínculos com
    unidades alheias nunca são exibidos nem removidos por ele.
    Alvo fora do escopo, inexistente ou com ID malformado => o mesmo 404
    `not_found`; `_load_scoped_target` executa SEMPRE as mesmas 4 consultas
    (sem retorno antecipado), para não haver oráculo de tempo (AUD-14-07).

ESCOPO TOTAL PARA PRIVILÉGIO (UA-SCOPE-01, negar por padrão):
    Promover a ADM, rebaixar um ADM, desativar um ADM e `mfa-reset` exigem
    que TODAS as unidades do alvo (vínculos + convites pendentes) estejam no
    escopo do ator, e que o alvo tenha ao menos uma. Conta órfã (sem
    unidades): o ator só pode reativá-la ou atribuir unidades do próprio
    escopo (perfil só junto com unidades; ADM só se, na mesma operação, ela
    receber unidades do escopo e não tiver nenhuma alheia). Demais casos =>
    403 `target_out_of_scope` (auditado como acesso negado).

ATOR REVALIDADO (UA-TOCTOU-01): toda mutação administrativa confere, dentro
da transação (e, quando há, depois do advisory lock), que o ator continua
ADM ativo; senão 403 `forbidden`.

CONCORRÊNCIA:
    - Controle otimista por `users.version`: linha lida com `FOR UPDATE`,
      comparação com o `version` do cliente (409 `version_conflict`) e
      incremento EXPLÍCITO em toda alteração de perfil/unidades/ativação.
      `revoke-sessions`, `mfa-reset` e foto NÃO incrementam `version` (não são
      edições do formulário; o cliente não precisa recarregar).
    - PATCH e desativação (que podem tirar um ADM) tomam o advisory lock
      GLOBAL do "último ADM" (`invite_service._REVOKE_ADVISORY_LOCK_KEY`)
      ANTES do `FOR UPDATE` da linha — mesma ordem do `revoke_access`
      (lock global -> linha), sem ciclo de espera (deadlock).

AUDITORIA: `AuditLog` de negócio na MESMA transação, com previous/new só das
chaves da allowlist do histórico (`role`, `units`, `active`, `avatar`,
`sessions_revoked_at`) + metadados não sensíveis. Nunca e-mail, token, link.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import and_, delete, exists, false, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.authorization.rbac import apply_unit_scope, get_accessible_unit_ids
from app.config.settings import Settings, get_settings
from app.integrations.supabase_admin_client import (
    MfaResetIncompleteError,
    SupabaseAdminClient,
    SupabaseAdminClientError,
)
from app.integrations.supabase_storage_client import SupabaseStorageClient
from app.models.audit import AuditLog
from app.models.invites import Invite, InviteUnit
from app.models.rbac import Role, User, UserRole
from app.models.units import Unit, UserUnitAccess
from app.security.sanitize import LIKE_ESCAPE_CHAR, escape_like
from app.services.avatar_service import AvatarService
from app.services.invite_service import (
    _REVOKE_ADVISORY_LOCK_KEY,
    _acquire_advisory_xact_lock,
    _normalize_email,
)

logger = logging.getLogger(__name__)

ADM = "ADM"
ROLE_PRECEDENCE = ("ADM", "RH", "USER")
_PENDING = "PENDENTE"
_REVOKED = "REVOGADO"

OP_ROLE_CHANGED = "USER_ROLE_CHANGED"
OP_UNITS_CHANGED = "USER_UNITS_CHANGED"
OP_DEACTIVATED = "USER_DEACTIVATED"
OP_ACTIVATED = "USER_ACTIVATED"
OP_SESSIONS_REVOKED = "USER_SESSIONS_REVOKED"
OP_PASSWORD_RESET_SENT = "USER_PASSWORD_RESET_SENT"
OP_MFA_RESET = "USER_MFA_RESET"

HISTORY_CHANGE_KEYS = ("role", "units", "active", "avatar", "sessions_revoked_at")
_MAX_HISTORY_LIST = 50
_MAX_HISTORY_STR = 64


# ---------------------------------------------------------------------------
# Erros de domínio (status + código estável do contrato)
# ---------------------------------------------------------------------------


class UserAdminError(Exception):
    status_code = 400
    code = "bad_request"
    message = "Requisição inválida."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class TargetNotFoundError(UserAdminError):
    status_code = 404
    code = "not_found"
    message = "Recurso não encontrado."


class VersionConflictError(UserAdminError):
    status_code = 409
    code = "version_conflict"
    message = "O usuário foi alterado por outra pessoa. Recarregue e tente novamente."


class ConfirmationRequiredError(UserAdminError):
    status_code = 400
    code = "confirmation_required"
    message = "Mudança de privilégio exige confirmação (confirm_privilege_change: true)."


class SelfChangeForbiddenError(UserAdminError):
    status_code = 409
    code = "self_change_forbidden"
    message = "Não é permitido executar esta operação sobre a própria conta."


class LastAdminBlockedError(UserAdminError):
    status_code = 409
    code = "last_admin"
    message = "Operação bloqueada: o sistema ficaria sem nenhum administrador (ADM) ativo."


class UnitOutOfScopeError(UserAdminError):
    status_code = 403
    code = "unit_out_of_scope"
    message = "Você não possui acesso administrativo a uma ou mais unidades informadas."

    def __init__(self, unit_ids: list[str]) -> None:
        super().__init__()
        self.unit_ids = unit_ids


class TargetOutOfScopeError(UserAdminError):
    status_code = 403
    code = "target_out_of_scope"
    message = (
        "Operação não permitida: o usuário possui vínculos fora das unidades que "
        "você administra (ou não possui unidade alguma)."
    )

    def __init__(self, reason: str) -> None:
        super().__init__()
        self.reason = reason


class ActorNotAuthorizedError(UserAdminError):
    status_code = 403
    code = "forbidden"
    message = "Acesso negado."


class TargetRateLimitedError(UserAdminError):
    status_code = 429
    code = "rate_limited"
    message = "Muitas tentativas. Tente novamente mais tarde."


class RateLimitUnavailableError(UserAdminError):
    status_code = 503
    code = "rate_limit_unavailable"
    message = "Serviço de limitação de tentativas indisponível."


class InvalidUnitError(UserAdminError):
    status_code = 400
    code = "validation_error"
    message = "Unidade inativa não pode receber novos vínculos."


class AuthProviderUnavailableError(UserAdminError):
    status_code = 502
    code = "auth_provider_unavailable"
    message = "Não foi possível concluir a operação no provedor de autenticação. Tente novamente."


# ---------------------------------------------------------------------------
# Serialização
# ---------------------------------------------------------------------------


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def primary_role(codes: set[str]) -> str | None:
    for code in ROLE_PRECEDENCE:
        if code in codes:
            return code
    return None


def _active_role_codes_of(user: User) -> set[str]:
    return {
        link.role.code
        for link in user.role_links
        if link.role is not None and link.role.active
    }


def user_summary(user: User, actor_units: set[uuid.UUID]) -> dict[str, Any]:
    """`UserSummary` do contrato (unidades limitadas ao escopo do ADM)."""
    units = sorted(
        (
            access.unit
            for access in user.unit_access
            if access.unit is not None and access.unit_id in actor_units
        ),
        key=lambda unit: ((unit.name or "").lower(), str(unit.id)),
    )
    return {
        "id": str(user.id),
        "name": user.name,
        "email": user.email,
        "active": bool(user.active),
        "role": primary_role(_active_role_codes_of(user)),
        "units": [{"id": str(u.id), "code": u.code, "name": u.name} for u in units],
        "has_avatar": user.avatar_object_key is not None,
        "created_at": iso_utc(user.created_at),
        "last_login_at": iso_utc(user.last_login_at),
        "deactivated_at": iso_utc(user.deactivated_at),
        "version": int(user.version or 1),
    }


def _summary_options() -> tuple[Any, ...]:
    return (
        selectinload(User.role_links).selectinload(UserRole.role),
        selectinload(User.unit_access).selectinload(UserUnitAccess.unit),
    )


_SORTS: dict[str, tuple[Any, ...]] = {
    "name": (func.lower(User.name).asc(), User.id.asc()),
    "-name": (func.lower(User.name).desc(), User.id.desc()),
    "email": (func.lower(User.email).asc(), User.id.asc()),
    "-email": (func.lower(User.email).desc(), User.id.desc()),
    "created_at": (User.created_at.asc(), User.id.asc()),
    "-created_at": (User.created_at.desc(), User.id.desc()),
    "last_login_at": (User.last_login_at.asc().nulls_last(), User.id.asc()),
    "-last_login_at": (User.last_login_at.desc().nulls_last(), User.id.desc()),
}


@dataclass
class MutationResult:
    """Resultado de uma alteração (o `summary` vai para a resposta)."""

    summary: dict[str, Any]
    changed: bool = False
    privilege_changed: bool = False
    previous_role: str | None = None
    new_role: str | None = None
    provider_synced: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Serviço
# ---------------------------------------------------------------------------


class UserAdminService:
    """Regras da gestão de usuários. `db` é a sessão aberta pela rota."""

    def __init__(
        self,
        db: Session,
        *,
        admin_client: SupabaseAdminClient | None = None,
        storage: SupabaseStorageClient | None = None,
        settings: Settings | None = None,
        request_id: str | None = None,
    ) -> None:
        self._db = db
        self._admin_client = admin_client
        self._storage = storage
        self._settings = settings or get_settings()
        self._request_id = request_id
        self._target_units: set[uuid.UUID] = set()
        self._target_link_units: set[uuid.UUID] = set()

    # -- escopo ---------------------------------------------------------------

    def _pending_invite_unit_ids(self, target: User | None) -> set[uuid.UUID]:
        # Sempre a mesma consulta (mesmo formato), exista o alvo ou não.
        email = _normalize_email(target.email or "") if target is not None else ""
        auth_user_id = (target.auth_user_id or "") if target is not None else ""
        rows = (
            self._db.query(InviteUnit.unit_id)
            .join(Invite, Invite.id == InviteUnit.invite_id)
            .filter(
                Invite.status == _PENDING,
                or_(func.lower(Invite.email) == email, Invite.invited_auth_user_id == auth_user_id),
            )
            .all()
        )
        units: set[uuid.UUID] = set()
        for row in rows:
            value = row[0] if isinstance(row, (tuple, list)) or hasattr(row, "_mapping") else row
            try:
                units.add(value if isinstance(value, uuid.UUID) else uuid.UUID(str(value)))
            except (ValueError, TypeError, AttributeError):
                continue
        return units

    def _load_scoped_target(
        self, actor_id: Any, target_id: uuid.UUID, *, for_update: bool = False
    ) -> tuple[User, set[uuid.UUID]]:
        """Alvo dentro do escopo do ADM, ou `TargetNotFoundError` (404 único).

        Executa SEMPRE 4 consultas, na mesma ordem, para qualquer alvo.
        """
        actor_units = get_accessible_unit_ids(actor_id, self._db)
        stmt = select(User).where(User.id == target_id)
        if for_update:
            stmt = stmt.with_for_update()
        target = self._db.execute(stmt).scalar_one_or_none()
        target_units = get_accessible_unit_ids(target_id, self._db)
        pending_units = self._pending_invite_unit_ids(target)

        if target is None or not actor_units:
            raise TargetNotFoundError()
        all_units = target_units | pending_units
        if all_units and not (all_units & actor_units):
            raise TargetNotFoundError()
        self._target_units = all_units
        self._target_link_units = set(target_units)
        return target, actor_units

    def _require_full_scope(self, actor_units: set[uuid.UUID], reason: str) -> None:
        """UA-SCOPE-01: todas as unidades do alvo no escopo e ao menos uma."""
        units = self._target_units
        if not units or not units <= actor_units:
            raise TargetOutOfScopeError(reason)

    def _require_not_orphan(self, reason: str) -> None:
        """Conta órfã só pode ser reativada ou receber unidades do escopo."""
        if not self._target_units:
            raise TargetOutOfScopeError(reason)

    def _revalidate_actor(self, actor_id: Any) -> None:
        """UA-TOCTOU-01: o ator continua ADM ativo (relido na transação)."""
        row = (
            self._db.query(UserRole.id)
            .join(Role, Role.id == UserRole.role_id)
            .join(User, User.id == UserRole.user_id)
            .filter(
                UserRole.user_id == actor_id,
                Role.code == ADM,
                Role.active.is_(True),
                User.active.is_(True),
            )
            .first()
        )
        if row is None:
            logger.warning("user_admin_service: ator deixou de ser ADM ativo; operação negada.")
            raise ActorNotAuthorizedError()

    def _reload_summary(self, target_id: uuid.UUID, actor_units: set[uuid.UUID]) -> dict[str, Any]:
        stmt = (
            select(User)
            .where(User.id == target_id)
            .options(*_summary_options())
            .execution_options(populate_existing=True)
        )
        user = self._db.execute(stmt).scalar_one()
        return user_summary(user, actor_units)

    def _scope_clause(self, actor_units: set[uuid.UUID]) -> Any:
        units = sorted(actor_units, key=str)
        invite_match = and_(
            Invite.id == InviteUnit.invite_id,
            Invite.status == _PENDING,
            or_(
                func.lower(Invite.email) == func.lower(User.email),
                and_(
                    Invite.invited_auth_user_id.is_not(None),
                    Invite.invited_auth_user_id == User.auth_user_id,
                ),
            ),
        )
        in_scope_access = exists().where(
            UserUnitAccess.user_id == User.id, UserUnitAccess.unit_id.in_(units)
        )
        any_access = exists().where(UserUnitAccess.user_id == User.id)
        in_scope_invite = exists().where(invite_match, InviteUnit.unit_id.in_(units))
        any_invite = exists().where(invite_match)
        return or_(in_scope_access, in_scope_invite, and_(~any_access, ~any_invite))

    def _active_role_codes(self, user_id: uuid.UUID) -> set[str]:
        rows = (
            self._db.query(Role.code)
            .join(UserRole, UserRole.role_id == Role.id)
            .filter(UserRole.user_id == user_id, Role.active.is_(True))
            .all()
        )
        return {row[0] for row in rows}

    def _ensure_not_last_admin(self, target_id: uuid.UUID) -> None:
        """Mesma regra de `InviteService.revoke_access` (só ADMs ATIVOS contam).

        Chamado com o advisory lock global já adquirido.
        """
        rows = (
            self._db.query(UserRole.user_id)
            .join(Role, Role.id == UserRole.role_id)
            .join(User, User.id == UserRole.user_id)
            .filter(Role.code == ADM, Role.active.is_(True), User.active.is_(True))
            .all()
        )
        admin_ids = {row[0] for row in rows}
        if target_id in admin_ids and len(admin_ids) <= 1:
            raise LastAdminBlockedError()

    def _lock_admin_mutations(self) -> None:
        _acquire_advisory_xact_lock(self._db, _REVOKE_ADVISORY_LOCK_KEY)

    def _audit(
        self,
        operation: str,
        actor_id: Any,
        target_id: uuid.UUID,
        previous: dict[str, Any] | None,
        new: dict[str, Any] | None,
        result: str = "SUCESSO",
    ) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=actor_id,
                entity_type="user",
                entity_id=str(target_id),
                operation=operation,
                previous_values=previous,
                new_values=new,
                request_id=self._request_id,
                result=result,
            )
        )

    @staticmethod
    def _check_version(target: User, version: int) -> None:
        if int(target.version or 1) != int(version):
            raise VersionConflictError()

    @staticmethod
    def _bump_version(target: User) -> None:
        target.version = int(target.version or 1) + 1

    # -- leitura ---------------------------------------------------------------

    def list_users(self, actor_id: Any, query: Any) -> dict[str, Any]:
        page, page_size = int(query.page), int(query.page_size)
        empty = {"total": 0, "page": page, "page_size": page_size, "users": []}
        actor_units = get_accessible_unit_ids(actor_id, self._db)
        if not actor_units:
            return empty

        conditions: list[Any] = [self._scope_clause(actor_units)]
        if query.q:
            pattern = f"%{escape_like(query.q)}%"
            conditions.append(
                or_(
                    User.name.ilike(pattern, escape=LIKE_ESCAPE_CHAR),
                    User.email.ilike(pattern, escape=LIKE_ESCAPE_CHAR),
                )
            )
        if query.role:
            conditions.append(
                exists().where(
                    UserRole.user_id == User.id,
                    UserRole.role_id == Role.id,
                    Role.code == query.role,
                    Role.active.is_(True),
                )
            )
        if query.unit_id is not None:
            if query.unit_id in actor_units:
                conditions.append(
                    exists().where(
                        UserUnitAccess.user_id == User.id, UserUnitAccess.unit_id == query.unit_id
                    )
                )
            else:
                # Unidade alheia/inexistente: lista vazia (não revela vínculos).
                conditions.append(false())
        if query.active is not None:
            conditions.append(User.active.is_(query.active == "true"))

        total = self._db.execute(
            select(func.count()).select_from(User).where(*conditions)
        ).scalar_one()
        stmt = (
            select(User)
            .where(*conditions)
            .options(*_summary_options())
            .order_by(*_SORTS[query.sort])
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        users = self._db.execute(stmt).scalars().all()
        return {
            "total": int(total),
            "page": page,
            "page_size": page_size,
            "users": [user_summary(user, actor_units) for user in users],
        }

    def get_user(self, actor_id: Any, target_id: uuid.UUID) -> dict[str, Any]:
        target, actor_units = self._load_scoped_target(actor_id, target_id)
        return self._reload_summary(target.id, actor_units)

    def list_units(self, actor_id: Any) -> dict[str, Any]:
        query = apply_unit_scope(self._db.query(Unit), Unit.id, actor_id, self._db)
        units = query.filter(Unit.active.is_(True)).order_by(func.lower(Unit.name), Unit.id).all()
        return {"units": [{"id": str(u.id), "code": u.code, "name": u.name} for u in units]}

    # -- PATCH -------------------------------------------------------------------

    def update_user(self, actor_id: Any, target_id: uuid.UUID, body: Any) -> MutationResult:
        if target_id == actor_id:
            raise SelfChangeForbiddenError()
        self._lock_admin_mutations()
        self._revalidate_actor(actor_id)
        target, actor_units = self._load_scoped_target(actor_id, target_id, for_update=True)
        self._check_version(target, body.version)

        current_codes = self._active_role_codes(target.id)
        old_role = primary_role(current_codes)
        role_change = body.role is not None and current_codes != {body.role}
        privilege_change = role_change and (body.role == ADM or ADM in current_codes)
        if privilege_change and body.confirm_privilege_change is not True:
            raise ConfirmationRequiredError()

        units_change = False
        to_add: list[uuid.UUID] = []
        to_remove: set[uuid.UUID] = set()
        previous_units: list[str] = []
        requested: list[uuid.UUID] = []
        if body.unit_ids is not None:
            requested = list(dict.fromkeys(body.unit_ids))
            outside = [str(uid) for uid in requested if uid not in actor_units]
            if outside:
                raise UnitOutOfScopeError(outside)
            found = self._db.query(Unit).filter(Unit.id.in_(requested)).all()
            if len(found) != len(requested) or any(not unit.active for unit in found):
                raise InvalidUnitError()
            links = self._db.query(UserUnitAccess).filter(UserUnitAccess.user_id == target.id).all()
            linked = {link.unit_id for link in links}
            current_in_scope = {uid for uid in linked if uid in actor_units}
            previous_units = sorted(str(uid) for uid in current_in_scope)
            to_remove = current_in_scope - set(requested)
            to_add = [uid for uid in requested if uid not in linked]
            units_change = bool(to_remove or to_add)

        # UA-SCOPE-01: unidades finais = vínculos atuais sem os removidos do
        # escopo, mais os pedidos (a troca de perfil supera o convite pendente,
        # então as unidades do convite não contam como "finais").
        final_units = (self._target_link_units - to_remove) | set(requested)
        if privilege_change:
            if not self._target_units <= actor_units or not final_units or not final_units <= actor_units:
                raise TargetOutOfScopeError("privilege_change")
        elif role_change and not final_units:
            raise TargetOutOfScopeError("orphan_role_without_units")

        if role_change and ADM in current_codes and body.role != ADM and target.active:
            self._ensure_not_last_admin(target.id)

        if not role_change and not units_change:
            return MutationResult(summary=self._reload_summary(target.id, actor_units))

        now = _utcnow()
        if role_change:
            role = (
                self._db.query(Role).filter(Role.code == body.role, Role.active.is_(True)).first()
            )
            if role is None:
                logger.error("user_admin_service: papel '%s' inexistente/inativo.", body.role)
                raise UserAdminError("Perfil indisponível.")
            self._db.execute(delete(UserRole).where(UserRole.user_id == target.id))
            self._db.add(
                UserRole(
                    id=uuid.uuid4(),
                    user_id=target.id,
                    role_id=role.id,
                    assigned_at=now,
                    assigned_by=actor_id,
                )
            )
            superseded = self._supersede_pending_invites(target, actor_id, now)
            new_values: dict[str, Any] = {"role": body.role}
            if superseded:
                new_values["invite_superseded"] = True
            self._audit(OP_ROLE_CHANGED, actor_id, target.id, {"role": old_role}, new_values)

        if units_change:
            if to_remove:
                self._db.execute(
                    delete(UserUnitAccess).where(
                        UserUnitAccess.user_id == target.id,
                        UserUnitAccess.unit_id.in_(sorted(to_remove, key=str)),
                    )
                )
            for unit_id in to_add:
                self._db.add(
                    UserUnitAccess(
                        id=uuid.uuid4(),
                        user_id=target.id,
                        unit_id=unit_id,
                        created_at=now,
                        created_by=actor_id,
                    )
                )
            self._audit(
                OP_UNITS_CHANGED,
                actor_id,
                target.id,
                {"units": previous_units},
                {"units": sorted(str(uid) for uid in requested)},
            )

        self._bump_version(target)
        self._db.add(target)
        self._db.commit()
        return MutationResult(
            summary=self._reload_summary(target.id, actor_units),
            changed=True,
            privilege_changed=privilege_change,
            previous_role=old_role,
            new_role=body.role if role_change else old_role,
        )

    def _supersede_pending_invites(self, target: User, actor_id: Any, now: datetime) -> bool:
        """Convite pendente do alvo vira REVOGADO quando o ADM atribui o perfil
        diretamente (senão a ativação posterior duplicaria papel/unidades)."""
        filters = [func.lower(Invite.email) == _normalize_email(target.email or "")]
        if target.auth_user_id:
            filters.append(Invite.invited_auth_user_id == target.auth_user_id)
        pending = self._db.query(Invite).filter(Invite.status == _PENDING, or_(*filters)).all()
        for invite in pending:
            invite.status = _REVOKED
            invite.revoked_at = now
            invite.revoked_by = actor_id
            self._db.add(invite)
        return bool(pending)

    # -- ativação / desativação / sessões -------------------------------------

    def deactivate(
        self, actor_id: Any, target_id: uuid.UUID, version: int, reason: str | None
    ) -> MutationResult:
        if target_id == actor_id:
            raise SelfChangeForbiddenError()
        self._lock_admin_mutations()
        self._revalidate_actor(actor_id)
        target, actor_units = self._load_scoped_target(actor_id, target_id, for_update=True)
        self._check_version(target, version)
        if not target.active:
            return MutationResult(summary=self._reload_summary(target.id, actor_units))
        self._require_not_orphan("orphan_deactivate")
        if ADM in self._active_role_codes(target.id):
            self._require_full_scope(actor_units, "deactivate_admin")
            self._ensure_not_last_admin(target.id)

        now = _utcnow()
        target.active = False
        target.deactivated_at = now
        target.deactivated_by = actor_id
        target.sessions_revoked_at = now
        self._bump_version(target)
        self._db.add(target)
        new_values: dict[str, Any] = {"active": False, "sessions_revoked_at": iso_utc(now)}
        if reason:
            new_values["reason"] = reason
        self._audit(OP_DEACTIVATED, actor_id, target.id, {"active": True}, new_values)
        self._db.commit()

        # Ban no Supabase DEPOIS do commit (melhor esforço): o bloqueio que
        # vale para a API é `active=false` + `sessions_revoked_at`, já
        # gravados; o ban impede novo login/refresh no próprio Supabase.
        synced = True
        if target.auth_user_id and self._admin_client is not None:
            try:
                self._admin_client.ban_user(target.auth_user_id)
            except SupabaseAdminClientError as exc:
                synced = False
                logger.error(
                    "user_admin_service: ban no Supabase falhou (%s); conta já desativada "
                    "localmente.",
                    exc.__class__.__name__,
                )
        return MutationResult(
            summary=self._reload_summary(target.id, actor_units), changed=True, provider_synced=synced
        )

    def activate(self, actor_id: Any, target_id: uuid.UUID, version: int) -> MutationResult:
        self._revalidate_actor(actor_id)
        target, actor_units = self._load_scoped_target(actor_id, target_id, for_update=True)
        self._check_version(target, version)
        if target.active:
            return MutationResult(summary=self._reload_summary(target.id, actor_units))
        if target.auth_user_id:
            if self._admin_client is None:
                raise AuthProviderUnavailableError()
            try:
                self._admin_client.unban_user(target.auth_user_id)
            except SupabaseAdminClientError as exc:
                logger.error("user_admin_service: unban falhou (%s).", exc.__class__.__name__)
                raise AuthProviderUnavailableError() from exc
        target.active = True
        target.deactivated_at = None
        target.deactivated_by = None
        self._bump_version(target)
        self._db.add(target)
        self._audit(OP_ACTIVATED, actor_id, target.id, {"active": False}, {"active": True})
        self._db.commit()
        return MutationResult(summary=self._reload_summary(target.id, actor_units), changed=True)

    def revoke_sessions(self, actor_id: Any, target_id: uuid.UUID) -> dict[str, Any]:
        self._revalidate_actor(actor_id)
        target, _ = self._load_scoped_target(actor_id, target_id, for_update=True)
        self._require_not_orphan("orphan_revoke_sessions")
        previous = iso_utc(target.sessions_revoked_at)
        now = _utcnow()
        target.sessions_revoked_at = now
        self._db.add(target)
        self._audit(
            OP_SESSIONS_REVOKED,
            actor_id,
            target.id,
            {"sessions_revoked_at": previous},
            {"sessions_revoked_at": iso_utc(now)},
        )
        self._db.commit()
        return {"sessions_revoked_at": iso_utc(now)}

    # -- senha / MFA ---------------------------------------------------------------

    def send_password_reset(
        self,
        actor_id: Any,
        target_id: uuid.UUID,
        *,
        consume_target_quota: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """`consume_target_quota` (UA-RL-01) só roda com o escopo já confirmado:
        um ADM de outra unidade não consegue esgotar o limite do alvo."""
        target, _ = self._load_scoped_target(actor_id, target_id)
        self._require_not_orphan("orphan_password_reset")
        if consume_target_quota is not None:
            consume_target_quota()
        redirect_to = self._settings.password_reset_redirect_effective_url
        result = "unavailable"
        reason = None
        if not target.active:
            reason = "inactive_user"
        elif not redirect_to:
            reason = "redirect_not_configured"
        elif self._admin_client is None:
            reason = "provider_unavailable"
        else:
            try:
                self._admin_client.send_password_recovery(target.email, redirect_to)
                result = "sent"
            except SupabaseAdminClientError as exc:
                reason = "provider_error"
                logger.error(
                    "user_admin_service: recuperação de senha falhou (%s).", exc.__class__.__name__
                )
        new_values: dict[str, Any] = {"result": result}
        if reason:
            new_values["reason"] = reason
        self._audit(
            OP_PASSWORD_RESET_SENT,
            actor_id,
            target.id,
            None,
            new_values,
            result="SUCESSO" if result == "sent" else "FALHA",
        )
        self._db.commit()
        return {"result": result}

    def reset_mfa(self, actor_id: Any, target_id: uuid.UUID) -> dict[str, Any]:
        if target_id == actor_id:
            raise SelfChangeForbiddenError()
        self._revalidate_actor(actor_id)
        target, actor_units = self._load_scoped_target(actor_id, target_id, for_update=True)
        self._require_full_scope(actor_units, "mfa_reset")
        removed = 0
        failure: SupabaseAdminClientError | None = None
        if target.auth_user_id:
            if self._admin_client is None:
                raise AuthProviderUnavailableError()
            try:
                removed = int(self._admin_client.delete_all_mfa_factors(target.auth_user_id))
            except MfaResetIncompleteError as exc:
                removed, failure = int(exc.removed), exc
            except SupabaseAdminClientError as exc:
                failure = exc
        # Sessões em AAL2 emitidas antes do reset deixam de valer — também no
        # reset parcial/falho (UA-MFA-01): parte dos fatores pode já ter saído.
        now = _utcnow()
        previous = iso_utc(target.sessions_revoked_at)
        target.sessions_revoked_at = now
        self._db.add(target)
        new_values: dict[str, Any] = {"removed_factors": removed, "sessions_revoked_at": iso_utc(now)}
        if failure is not None:
            new_values["result"] = "incomplete"
        self._audit(
            OP_MFA_RESET,
            actor_id,
            target.id,
            {"sessions_revoked_at": previous},
            new_values,
            result="FALHA" if failure is not None else "SUCESSO",
        )
        self._db.commit()
        if failure is not None:
            logger.error(
                "user_admin_service: reset de MFA incompleto (%s); sessões encerradas.",
                failure.__class__.__name__,
            )
            raise AuthProviderUnavailableError() from failure
        return {"removed_factors": removed}

    # -- histórico ---------------------------------------------------------------

    def audit_history(
        self, actor_id: Any, target_id: uuid.UUID, page: int, page_size: int
    ) -> dict[str, Any]:
        target, actor_units = self._load_scoped_target(actor_id, target_id)
        # UA-AUD-01: eventos em que o alvo é só o AUTOR entram apenas se o alvo
        # do evento for um usuário vinculado a unidade do escopo do consultante.
        scoped_user_ids = [
            str(row[0])
            for row in self._db.query(UserUnitAccess.user_id)
            .filter(UserUnitAccess.unit_id.in_(sorted(actor_units, key=str)))
            .distinct()
            .all()
        ]
        condition = or_(
            AuditLog.entity_id == str(target.id),
            and_(AuditLog.actor_user_id == target.id, AuditLog.entity_id.in_(scoped_user_ids)),
        )
        total = self._db.execute(
            select(func.count()).select_from(AuditLog).where(condition)
        ).scalar_one()
        rows = (
            self._db.execute(
                select(AuditLog)
                .where(condition)
                .options(selectinload(AuditLog.actor))
                .order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            .scalars()
            .all()
        )
        scope_ids = {str(uid) for uid in actor_units}
        return {
            "total": int(total),
            "page": page,
            "page_size": page_size,
            "events": [self._history_event(row, scope_ids) for row in rows],
        }

    @staticmethod
    def _history_event(row: AuditLog, scope_ids: set[str]) -> dict[str, Any]:
        actor = row.actor
        return {
            "id": str(row.id),
            "occurred_at": iso_utc(row.occurred_at),
            "operation": row.operation,
            "result": row.result,
            "actor": {"id": str(actor.id), "name": actor.name} if actor is not None else None,
            "changes": history_changes(row, scope_ids),
        }

    # -- foto --------------------------------------------------------------------

    def _avatar_service(self) -> AvatarService:
        storage = self._storage if self._storage is not None else SupabaseStorageClient()
        return AvatarService(self._db, storage)

    def _load_self(self, user_id: uuid.UUID, *, for_update: bool = False) -> User:
        stmt = select(User).where(User.id == user_id)
        if for_update:
            stmt = stmt.with_for_update()
        user = self._db.execute(stmt).scalar_one_or_none()
        if user is None:
            raise TargetNotFoundError()
        return user

    def set_avatar(
        self, actor_id: Any, target_id: uuid.UUID, webp: bytes, *, self_service: bool = False
    ) -> dict[str, Any]:
        if self_service:
            target = self._load_self(target_id, for_update=True)
        else:
            target, _ = self._load_scoped_target(actor_id, target_id, for_update=True)
            self._require_not_orphan("orphan_avatar")
        self._avatar_service().replace(target, webp, actor_id=actor_id, request_id=self._request_id)
        return {"has_avatar": True}

    def remove_avatar(
        self, actor_id: Any, target_id: uuid.UUID, *, self_service: bool = False
    ) -> dict[str, Any]:
        if self_service:
            target = self._load_self(target_id, for_update=True)
        else:
            target, _ = self._load_scoped_target(actor_id, target_id, for_update=True)
            self._require_not_orphan("orphan_avatar")
        self._avatar_service().remove(target, actor_id=actor_id, request_id=self._request_id)
        return {"has_avatar": False}

    def avatar_url(
        self, actor_id: Any, target_id: uuid.UUID, *, self_service: bool = False
    ) -> dict[str, Any]:
        if self_service:
            target = self._load_self(target_id)
        else:
            target, _ = self._load_scoped_target(actor_id, target_id)
        payload = self._avatar_service().signed_url(target)
        if payload is None:
            raise TargetNotFoundError()
        return payload


def _safe_history_value(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value[:_MAX_HISTORY_STR]
    if isinstance(value, list):
        return [str(item)[:_MAX_HISTORY_STR] for item in value[:_MAX_HISTORY_LIST]]
    return None


def history_changes(row: AuditLog, scope_ids: set[str]) -> dict[str, Any]:
    """`changes` do histórico: SÓ chaves da allowlist, valores primitivos.

    Eventos de segurança (`entity_type="security_event"`) não têm `changes`.
    Listas de unidades são reduzidas ao escopo do ADM que consulta.
    """
    if row.entity_type == "security_event":
        return {}
    previous = row.previous_values if isinstance(row.previous_values, dict) else {}
    new = row.new_values if isinstance(row.new_values, dict) else {}
    changes: dict[str, Any] = {}
    for key in HISTORY_CHANGE_KEYS:
        if key not in previous and key not in new:
            continue
        before = _safe_history_value(previous.get(key))
        after = _safe_history_value(new.get(key))
        if key == "units":
            before = [u for u in before or [] if u in scope_ids]
            after = [u for u in after or [] if u in scope_ids]
        changes[key] = {"from": before, "to": after}
    return changes
