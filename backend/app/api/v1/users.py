"""Endpoints administrativos de gestão de usuários (`/api/v1/users/...`).

Blueprint `users_bp`, registrado dentro de `api_v1_bp` (ver
`app/api/v1/__init__.py`), resultando no prefixo `/api/v1/users`.

Endpoints deste módulo:
    - `POST /api/v1/users/invite`: convida um novo usuário (`ADM` + AAL2 +
      permissão granular `users.invite`, com limitação de tentativas).
    - `POST /api/v1/users/activate-invite`: o PRÓPRIO usuário convidado
      aceita seu convite pendente (apenas `require_auth` -- ver abaixo; sem
      corpo, com limitação de tentativas).
    - `POST /api/v1/users/<user_id>/revoke`: revoga todo o acesso
      operacional de um usuário (`ADM` + AAL2 + permissão granular
      `users.revoke_access`).
    - Gestão de usuários (Etapa 2, contrato em
      `docs/architecture/modulo-configuracoes.md`; regra em
      `app.services.user_admin_service`): `GET /users`, `GET/PATCH
      /users/<id>`, `POST /users/<id>/{deactivate,activate,revoke-sessions,
      password-reset,mfa-reset}`, `GET /users/<id>/audit`,
      `PUT/DELETE /users/<id>/avatar` e `GET /users/<id>/avatar-url`.
      Todas: `require_auth -> require_role("ADM") -> require_aal2 ->
      require_permission(...) -> rate_limit` (fail-closed). Alvo fora do
      escopo de unidade, inexistente ou malformado => o MESMO 404 `not_found`.

Nenhum detalhe interno (de `InviteServiceError`, de exceções do
SQLAlchemy, etc.) é exposto ao cliente -- toda resposta de erro usa
`flask.abort(status, description=...)` com uma mensagem genérica seguindo
o formato padronizado de `app.errors`. Em especial, NENHUMA resposta deste
módulo inclui token, link de convite ou qualquer segredo do Supabase Auth
-- esse lado do fluxo é inteiramente gerenciado pelo Supabase (envio do
e-mail de convite) via `app.integrations.supabase_admin_client`.

IMPORTANTE -- `POST /activate-invite` exige APENAS `require_auth`:
    O usuário que acabou de ser convidado já possui uma linha em `users`
    (`active=True`, ver `app.services.invite_service.InviteService.
    create_invite`) assim que define sua senha no Supabase Auth, mas AINDA
    NÃO possui nenhum papel/permissão (`user_roles` vazio) até chamar este
    endpoint. Isso é suficiente, por si só, para que ele não consiga
    acessar NENHUMA outra rota administrativa -- `require_permission`/
    `require_role` sempre negam um usuário sem papéis. Não é necessário (e
    seria incorreto) exigir aqui `require_role`/`require_permission`, já
    que o próprio propósito deste endpoint é conceder o primeiro papel do
    usuário.

PENDÊNCIA DE CONFIGURAÇÃO MANUAL -- cadastro público desabilitado:
    O SISPAT-AGU NUNCA permite cadastro público de contas (nenhuma rota
    `/register`/`/signup` é exposta por este backend, em nenhum blueprint --
    toda conta é criada exclusivamente pelo fluxo de convite deste módulo,
    via `SupabaseAdminClient.invite_user_by_email`). Entretanto, impedir que
    um usuário crie uma conta DIRETAMENTE pelo Supabase Auth (ex.: chamando
    `POST /auth/v1/signup` do GoTrue por fora deste backend, com a chave
    pública `anon`) é uma CONFIGURAÇÃO do painel do Supabase --
    Authentication > Settings > "Allow new users to sign up" -- que deve
    ser DESATIVADA manualmente no projeto Supabase. Este backend não tem
    nenhum mecanismo de código para impor essa configuração (ela vive
    inteiramente no lado do GoTrue); é uma pendência operacional a ser
    comunicada e verificada pela equipe responsável pelo projeto Supabase,
    não uma falha de implementação deste módulo.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from flask import Blueprint, abort, g, jsonify, request
from sqlalchemy import func, or_
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import (
    DeactivateRequest,
    InviteRequest,
    PageQuery,
    RevokeRequest,
    UserListQuery,
    UserUpdateRequest,
    VersionRequest,
    get_json_body,
    parse_body,
    parse_query,
    reject_unexpected_fields,
)
from app.api.v1.user_admin_http import (
    StorageUnavailableError,
    admin_rate_limit_key,
    avatar_error_response,
    error_response,
    read_avatar_upload,
    reject_any_body,
    service_error_response,
    storage_unavailable_response,
    make_target_quota,
    validation_error,
)
from app.auth.supabase_auth import has_recent_totp, require_auth
from app.authorization.rbac import (
    get_accessible_unit_ids,
    require_aal2,
    require_permission,
    require_role,
    units_outside_scope,
)
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    EVENT_INVITE_ACTIVATION_FAILED,
    EVENT_PRIVILEGE_ESCALATION_ATTEMPT,
    EVENT_REAUTH_REQUIRED,
    EVENT_REVOKE_BLOCKED,
    EVENT_UNIT_SCOPE_DENIED,
    EVENT_USER_ACCESS_REVOKED,
    EVENT_USER_MFA_RESET,
    EVENT_USER_PRIVILEGE_CHANGED,
    EVENT_USER_PROVIDER_SYNC_FAILED,
    SEVERITY_HIGH,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    get_request_id,
    record_security_event,
)
from app.database.session import get_db_session
from app.integrations.supabase_admin_client import SupabaseAdminClient
from app.integrations.supabase_storage_client import SupabaseStorageClient
from app.models.invites import Invite, InviteUnit
from app.models.rbac import User
from app.security.rate_limit import rate_limit
from app.services.avatar_service import AvatarError, process_avatar
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
from app.services.user_admin_service import (
    SelfChangeForbiddenError,
    UserAdminError,
    UserAdminService,
)

logger = logging.getLogger(__name__)

users_bp = Blueprint("users", __name__, url_prefix="/users")

# Gestão de usuários (Etapa 2): limites por ADM/hora (fail-closed).
_WINDOW = 3600
_READ_LIMIT = 600
_LIST_LIMIT = 1200  # busca/filtros da tela (digitação)
_AUDIT_LIMIT = 300
_PATCH_LIMIT = 60
_ACCOUNT_ACTION_LIMIT = 30
_PASSWORD_RESET_PER_ADMIN = 20
_PASSWORD_RESET_PER_TARGET = 5
_MFA_RESET_LIMIT = 10
_AVATAR_WRITE_LIMIT = 30

# Reautenticação do reset de MFA: TOTP verificado na sessão há <= 5 min.
_REAUTH_MAX_AGE_SECONDS = 300

# Limite de tentativas de convite: 10 convites/hora por usuário
# administrador (ver `app.security.rate_limit`). `fail_open=False`
# (padrão): se o Redis estiver indisponível, a requisição é bloqueada
# (503) -- este é um endpoint administrativo crítico, nunca deve permitir
# contornar a limitação apenas por falha de infraestrutura.
_INVITE_RATE_LIMIT_PER_HOUR = 10
_INVITE_RATE_LIMIT_WINDOW_SECONDS = 3600

# Limite de tentativas de ativação de convite; chave: o próprio usuário.
_ACTIVATE_RATE_LIMIT_PER_HOUR = 10
_ACTIVATE_RATE_LIMIT_WINDOW_SECONDS = 3600

# Papéis atribuíveis por convite (espelha `InviteService`); checado também
# aqui para registrar a tentativa de escalonamento em `audit_logs`.
_INVITABLE_ROLE_CODES = ("USER", "RH")

# Revogação: 10/hora por ADM, fail-closed (coerente com o convite).
_REVOKE_RATE_LIMIT_PER_HOUR = 10
_REVOKE_RATE_LIMIT_WINDOW_SECONDS = 3600
# Mesma mensagem do 404 padrão (rota com UUID malformado): alvo inexistente,
# alheio e malformado têm corpo idêntico.
_REVOKE_TARGET_NOT_FOUND_MESSAGE = "Recurso não encontrado."

_UNIT_SCOPE_DENIED_MESSAGE = (
    "Você não possui acesso administrativo a uma ou mais unidades informadas."
)

_UPSTREAM_ERROR_MESSAGE = "Não foi possível enviar o convite no momento. Tente novamente mais tarde."
_ACTIVATE_ERROR_MESSAGE = "Não foi possível concluir a ativação do convite no momento."


def _current_user_rate_limit_key(*_args: Any, **_kwargs: Any) -> str:
    """Chave de limitação: o id do usuário ADM autenticado que está
    convidando (não o e-mail do convidado) -- ver docstring do módulo e de
    `app.security.rate_limit`.

    Funciona porque, na pilha de decorators desta view, `rate_limit` é o
    decorator MAIS INTERNO (mais próximo da função), aplicado DEPOIS de
    `require_auth` já ter populado `flask.g.current_user`.
    """
    user = getattr(g, "current_user", None)
    return str(getattr(user, "id", "desconhecido"))


def _serialize_invite(invite: Any, unit_ids: list[uuid.UUID]) -> dict[str, Any]:
    return {
        "id": str(invite.id),
        "email": invite.email,
        "name": invite.name,
        "intended_role_code": invite.intended_role_code,
        "status": invite.status,
        "unit_ids": [str(uid) for uid in unit_ids],
        "created_at": invite.created_at.isoformat(),
        "expires_at": invite.expires_at.isoformat(),
    }


@users_bp.route("/invite", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.invite")
@rate_limit(
    _current_user_rate_limit_key,
    limit=_INVITE_RATE_LIMIT_PER_HOUR,
    window_seconds=_INVITE_RATE_LIMIT_WINDOW_SECONDS,
    fail_open=False,
)
def invite_user_endpoint():
    """`POST /api/v1/users/invite` -- convida um novo usuário.

    Corpo JSON obrigatório: `{"email", "name", "intended_role_code",
    "unit_ids": [...], "justification"?}`. Retorna 201 com os dados do
    convite (NUNCA nenhum token/link -- ver docstring do módulo). Mapeia
    erros de domínio: 400 (corpo/validação inválida, inclusive
    `intended_role_code='ADM'`), 409 (já existe convite pendente para o
    e-mail), 502 (falha ao falar com o Supabase Auth).
    """
    payload_in = parse_body(InviteRequest, get_json_body(), context="users.invite")
    email = payload_in.email
    name = payload_in.name
    intended_role_code = payload_in.intended_role_code
    unit_ids = payload_in.unit_ids
    justification = payload_in.justification

    user = g.current_user

    # Convite NUNCA concede ADM (nem qualquer papel fora de USER/RH):
    # negado e registrado como tentativa de escalonamento de privilégio.
    if intended_role_code not in _INVITABLE_ROLE_CODES:
        record_security_event(
            EVENT_PRIVILEGE_ESCALATION_ATTEMPT,
            severity=SEVERITY_HIGH,
            actor_user_id=user.id,
            details={"context": "users.invite", "requested_role": intended_role_code[:32]},
        )
        abort(
            400,
            description=(
                "intended_role_code deve ser 'USER' ou 'RH'; a atribuição do papel "
                "'ADM' não é permitida por este fluxo de convite."
            ),
        )

    try:
        with get_db_session() as db:
            # Escopo de unidade: o ADM só concede acesso a unidades que ele
            # próprio administra (matriz de permissões, princípio 3).
            # Unidade inexistente e fora do escopo têm a MESMA resposta.
            outside = units_outside_scope(user.id, unit_ids, db)
            if outside:
                record_security_event(
                    EVENT_UNIT_SCOPE_DENIED,
                    severity=SEVERITY_MEDIUM,
                    actor_user_id=user.id,
                    target_type="unit",
                    details={"context": "users.invite", "unit_ids": outside},
                )
                abort(403, description=_UNIT_SCOPE_DENIED_MESSAGE)

            service = InviteService(db, SupabaseAdminClient())
            invite = service.create_invite(
                invited_by_user_id=user.id,
                email=email,
                name=name,
                intended_role_code=intended_role_code,
                unit_ids=unit_ids,
                justification=justification,
            )
            payload = _serialize_invite(invite, unit_ids)
    except InviteValidationError as exc:
        abort(400, description=str(exc))
        raise AssertionError("inalcançável")  # pragma: no cover
    except InviteAlreadyPendingError as exc:
        abort(409, description=str(exc))
        raise AssertionError("inalcançável")  # pragma: no cover
    except InviteServiceError:
        logger.error("users_api.invite: falha ao criar convite (provedor de autenticação).")
        abort(502, description=_UPSTREAM_ERROR_MESSAGE)
        raise AssertionError("inalcançável")  # pragma: no cover

    return jsonify(payload), 201


@users_bp.route("/activate-invite", methods=["POST"])
@require_auth
@rate_limit(
    _current_user_rate_limit_key,
    limit=_ACTIVATE_RATE_LIMIT_PER_HOUR,
    window_seconds=_ACTIVATE_RATE_LIMIT_WINDOW_SECONDS,
    fail_open=False,
)
def activate_invite_endpoint():
    """`POST /api/v1/users/activate-invite` -- o próprio usuário convidado
    aceita seu convite pendente.

    Exige apenas `require_auth` (ver docstring do módulo: um usuário sem
    papéis não consegue fazer mais nada de qualquer forma). Sem corpo.
    Retorna 200 com `{"role", "units"}` em sucesso; 404 se não houver
    convite pendente para o usuário atual; 409 se o convite encontrado já
    tiver expirado.

    O papel e as unidades vêm EXCLUSIVAMENTE do convite registrado pelo
    ADM: qualquer corpo com campos (ex.: `role`, `unit_ids`, `is_admin`) é
    rejeitado com 400 e registrado em `audit_logs` (tentativa de
    escalonamento). Limitado a 10 chamadas/hora por usuário.
    """
    body = get_json_body()
    if body is not None and body != {}:
        if isinstance(body, dict):
            reject_unexpected_fields(set(body.keys()), context="users.activate_invite")
        abort(400, description="Este endpoint não aceita corpo na requisição.")

    user = g.current_user

    try:
        with get_db_session() as db:
            service = InviteService(db, SupabaseAdminClient())
            result = service.activate_invite(current_user_id=user.id)
    except InviteNotFoundError as exc:
        record_security_event(
            EVENT_INVITE_ACTIVATION_FAILED,
            severity=SEVERITY_LOW,
            actor_user_id=user.id,
            details={"reason": "not_found"},
        )
        abort(404, description=str(exc))
        raise AssertionError("inalcançável")  # pragma: no cover
    except InviteExpiredError as exc:
        record_security_event(
            EVENT_INVITE_ACTIVATION_FAILED,
            severity=SEVERITY_LOW,
            actor_user_id=user.id,
            details={"reason": "expired"},
        )
        abort(409, description=str(exc))
        raise AssertionError("inalcançável")  # pragma: no cover
    except InviteServiceError:
        logger.error("users_api.activate_invite: falha inesperada ao ativar convite.")
        abort(502, description=_ACTIVATE_ERROR_MESSAGE)
        raise AssertionError("inalcançável")  # pragma: no cover

    return jsonify(result), 200


def _target_unit_ids(db: Any, target_id: uuid.UUID) -> set[uuid.UUID]:
    """Unidades do alvo: vínculos ativos (`UserUnitAccess`) UNIDOS às
    unidades de convites PENDENTES dele (casados por `auth_user_id` ou
    e-mail normalizado, mesmo critério de `InviteService.revoke_access`).

    Convidado pendente ainda não tem `UserUnitAccess` (criado só na
    ativação); sem esta união ele ficaria irrevogável.
    """
    units = set(get_accessible_unit_ids(target_id, db))
    target = db.query(User).filter(User.id == target_id).first()
    # AUD-14-07: a consulta de convites roda SEMPRE (alvo inexistente usa
    # valores que não casam com nada), para que alvo alheio e inexistente
    # executem o mesmo número de consultas (sem oráculo de tempo).
    email = (target.email or "").strip().lower() if target is not None else ""
    auth_user_id = (getattr(target, "auth_user_id", None) or "") if target is not None else ""
    filters = [
        func.lower(Invite.email) == email,
        Invite.invited_auth_user_id == auth_user_id,
    ]
    rows = (
        db.query(InviteUnit.unit_id)
        .join(Invite, Invite.id == InviteUnit.invite_id)
        .filter(Invite.status == "PENDENTE", or_(*filters))
        .all()
    )
    for row in rows:
        value = row[0] if isinstance(row, tuple) else getattr(row, "unit_id", row)
        try:
            units.add(value if isinstance(value, uuid.UUID) else uuid.UUID(str(value)))
        except (ValueError, AttributeError, TypeError):
            continue
    return units


def _target_in_actor_scope(db: Any, actor_id: Any, target_id: uuid.UUID) -> bool:
    """True se o alvo (acesso ativo ou convite pendente) compartilha ao
    menos uma unidade com o ator. Fail-closed: sem unidades => False."""
    actor_units = get_accessible_unit_ids(actor_id, db)
    if not actor_units:
        return False
    return bool(actor_units & _target_unit_ids(db, target_id))


def _deny_revoke_target(actor_id: Any, target_id: uuid.UUID) -> None:
    """Audita e responde 404 genérico (igual p/ inexistente e alheio)."""
    record_security_event(
        EVENT_UNIT_SCOPE_DENIED,
        severity=SEVERITY_MEDIUM,
        actor_user_id=actor_id,
        target_type="user",
        target_id=target_id,
        details={"context": "users.revoke"},
    )
    abort(404, description=_REVOKE_TARGET_NOT_FOUND_MESSAGE)


@users_bp.route("/<uuid:user_id>/revoke", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.revoke_access")
@rate_limit(
    _current_user_rate_limit_key,
    limit=_REVOKE_RATE_LIMIT_PER_HOUR,
    window_seconds=_REVOKE_RATE_LIMIT_WINDOW_SECONDS,
    fail_open=False,
)
def revoke_user_access_endpoint(user_id: uuid.UUID):
    """`POST /api/v1/users/<user_id>/revoke` -- revoga todo o acesso
    operacional do usuário informado.

    Corpo JSON opcional: `{"reason"?}`. Retorna 200 em sucesso; 404 se o
    usuário não existir OU não compartilhar nenhuma unidade com o ADM
    (resposta idêntica, sem enumeração; negação auditada); 409 se `user_id`
    for o último administrador (ADM) ativo do sistema (revogação bloqueada
    para nunca deixar o sistema sem nenhum ADM); 429 acima de 10/hora.
    """
    body = get_json_body()
    reason = None
    if body is not None:
        reason = parse_body(RevokeRequest, body, context="users.revoke").reason or None

    actor = g.current_user

    # Autorrevogação bloqueada: evita que um ADM se tranque fora do sistema
    # por engano e mantém a separação "quem revoga" x "quem é revogado".
    if user_id == getattr(actor, "id", None):
        record_security_event(
            EVENT_REVOKE_BLOCKED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor.id,
            target_type="user",
            target_id=user_id,
            details={"reason": "self_revoke"},
        )
        abort(409, description="Não é permitido revogar o próprio acesso.")

    try:
        with get_db_session() as db:
            # Escopo de unidade do alvo (AUD-14-01): o alvo precisa
            # compartilhar ao menos uma unidade com o ADM. Alvo inexistente,
            # sem unidades ou alheio caem na MESMA resposta (404 genérico).
            if not _target_in_actor_scope(db, actor.id, user_id):
                _deny_revoke_target(actor.id, user_id)
            service = InviteService(db, SupabaseAdminClient())
            service.revoke_access(
                target_user_id=user_id, revoked_by_user_id=actor.id, reason=reason
            )
    except UserNotFoundError:
        _deny_revoke_target(actor.id, user_id)
        raise AssertionError("inalcançável")  # pragma: no cover
    except LastAdminError as exc:
        record_security_event(
            EVENT_REVOKE_BLOCKED,
            severity=SEVERITY_HIGH,
            actor_user_id=actor.id,
            target_type="user",
            target_id=user_id,
            details={"reason": "last_admin"},
        )
        abort(409, description=str(exc))
        raise AssertionError("inalcançável")  # pragma: no cover

    record_security_event(
        EVENT_USER_ACCESS_REVOKED,
        severity=SEVERITY_HIGH,
        actor_user_id=actor.id,
        target_type="user",
        target_id=user_id,
        result="SUCESSO",
    )
    return jsonify({"status": "revoked", "user_id": str(user_id)}), 200


# ---------------------------------------------------------------------------
# Gestão de usuários (Etapa 2) — rotas finas sobre `UserAdminService`
# ---------------------------------------------------------------------------


def _service(db: Any, *, storage: bool = False) -> UserAdminService:
    return UserAdminService(
        db,
        admin_client=SupabaseAdminClient(),
        storage=SupabaseStorageClient() if storage else None,
        request_id=get_request_id(),
    )


def _deny_missing_field_permission(actor: Any, permission: str):
    record_security_event(
        EVENT_ACCESS_DENIED,
        severity=SEVERITY_MEDIUM,
        actor_user_id=actor.id,
        details={"reason": "missing_permission", "required": permission},
    )
    return error_response(403, "forbidden", "Acesso negado.")


@users_bp.route("", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.manage")
@rate_limit(admin_rate_limit_key, limit=_LIST_LIMIT, window_seconds=_WINDOW)
def list_users_endpoint():
    """`GET /api/v1/users` — busca/filtros/ordenação por allowlist, com escopo."""
    try:
        query = parse_query(UserListQuery, request.args, context="users.list")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _service(db).list_users(g.current_user.id, query)
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.manage")
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT, window_seconds=_WINDOW)
def get_user_endpoint(user_id: uuid.UUID):
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db).get_user(actor.id, user_id)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.get")
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>", methods=["PATCH"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.manage")
@rate_limit(admin_rate_limit_key, limit=_PATCH_LIMIT, window_seconds=_WINDOW)
def update_user_endpoint(user_id: uuid.UUID):
    """`PATCH /api/v1/users/<id>` — perfil (`users.assign_role`) e/ou
    unidades (`users.assign_unit`); a permissão de cada campo é checada
    ANTES de tocar o banco (além de `users.manage`, exigida no decorator)."""
    try:
        body = parse_body(UserUpdateRequest, get_json_body(), context="users.update")
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    permissions = getattr(g, "current_user_permissions", set())
    if body.role is not None and "users.assign_role" not in permissions:
        return _deny_missing_field_permission(actor, "users.assign_role")
    if body.unit_ids is not None and "users.assign_unit" not in permissions:
        return _deny_missing_field_permission(actor, "users.assign_unit")
    try:
        with get_db_session() as db:
            result = _service(db).update_user(actor.id, user_id, body)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.update")
    if result.privilege_changed:
        record_security_event(
            EVENT_USER_PRIVILEGE_CHANGED,
            severity=SEVERITY_HIGH,
            actor_user_id=actor.id,
            target_type="user",
            target_id=user_id,
            details={"from": result.previous_role, "to": result.new_role},
            result="SUCESSO",
        )
    return jsonify(result.summary), 200


@users_bp.route("/<uuid:user_id>/deactivate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.deactivate")
@rate_limit(admin_rate_limit_key, limit=_ACCOUNT_ACTION_LIMIT, window_seconds=_WINDOW)
def deactivate_user_endpoint(user_id: uuid.UUID):
    try:
        body = parse_body(DeactivateRequest, get_json_body(), context="users.deactivate")
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    try:
        with get_db_session() as db:
            result = _service(db).deactivate(actor.id, user_id, body.version, body.reason or None)
    except UserAdminError as exc:
        return service_error_response(
            exc, actor_id=actor.id, target_id=user_id, context="users.deactivate"
        )
    if result.changed and not result.provider_synced:
        record_security_event(
            EVENT_USER_PROVIDER_SYNC_FAILED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor.id,
            target_type="user",
            target_id=user_id,
            details={"operation": "ban"},
        )
    return jsonify(result.summary), 200


@users_bp.route("/<uuid:user_id>/activate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.activate")
@rate_limit(admin_rate_limit_key, limit=_ACCOUNT_ACTION_LIMIT, window_seconds=_WINDOW)
def activate_user_endpoint(user_id: uuid.UUID):
    try:
        body = parse_body(VersionRequest, get_json_body(), context="users.activate")
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    try:
        with get_db_session() as db:
            result = _service(db).activate(actor.id, user_id, body.version)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.activate")
    return jsonify(result.summary), 200


@users_bp.route("/<uuid:user_id>/revoke-sessions", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.revoke_sessions")
@rate_limit(admin_rate_limit_key, limit=_ACCOUNT_ACTION_LIMIT, window_seconds=_WINDOW)
def revoke_sessions_endpoint(user_id: uuid.UUID):
    rejected = reject_any_body("users.revoke_sessions")
    if rejected is not None:
        return rejected
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db).revoke_sessions(actor.id, user_id)
    except UserAdminError as exc:
        return service_error_response(
            exc, actor_id=actor.id, target_id=user_id, context="users.revoke_sessions"
        )
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>/password-reset", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.reset_password")
@rate_limit(admin_rate_limit_key, limit=_PASSWORD_RESET_PER_ADMIN, window_seconds=_WINDOW)
def password_reset_endpoint(user_id: uuid.UUID):
    """E-mail de recuperação enviado pelo Supabase; o ADM nunca vê link/senha.

    Limite de 5/h por ALVO consumido no serviço só depois do escopo (UA-RL-01).
    """
    rejected = reject_any_body("users.password_reset")
    if rejected is not None:
        return rejected
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db).send_password_reset(
                actor.id,
                user_id,
                consume_target_quota=make_target_quota(
                    "password_reset",
                    user_id,
                    limit=_PASSWORD_RESET_PER_TARGET,
                    window_seconds=_WINDOW,
                ),
            )
    except UserAdminError as exc:
        return service_error_response(
            exc, actor_id=actor.id, target_id=user_id, context="users.password_reset"
        )
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>/mfa-reset", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.reset_mfa")
@rate_limit(admin_rate_limit_key, limit=_MFA_RESET_LIMIT, window_seconds=_WINDOW)
def mfa_reset_endpoint(user_id: uuid.UUID):
    """Remove todos os fatores MFA do alvo. Exige reautenticação: a sessão do
    ADM precisa ter verificado TOTP há <= 5 min (claim `amr`, ver
    `app.auth.supabase_auth.has_recent_totp`)."""
    rejected = reject_any_body("users.mfa_reset")
    if rejected is not None:
        return rejected
    actor = g.current_user
    if user_id == actor.id:
        return service_error_response(
            SelfChangeForbiddenError(), actor_id=actor.id, target_id=user_id, context="users.mfa_reset"
        )
    claims = getattr(g, "current_user_claims", None) or {}
    if not has_recent_totp(claims, max_age_seconds=_REAUTH_MAX_AGE_SECONDS):
        record_security_event(
            EVENT_REAUTH_REQUIRED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=actor.id,
            target_type="user",
            target_id=user_id,
            details={"context": "users.mfa_reset"},
        )
        return error_response(
            403,
            "REAUTH_REQUIRED",
            "Confirme sua identidade com o código do autenticador (TOTP) e tente novamente.",
        )
    try:
        with get_db_session() as db:
            payload = _service(db).reset_mfa(actor.id, user_id)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.mfa_reset")
    record_security_event(
        EVENT_USER_MFA_RESET,
        severity=SEVERITY_HIGH,
        actor_user_id=actor.id,
        target_type="user",
        target_id=user_id,
        details={"removed_factors": payload["removed_factors"]},
        result="SUCESSO",
    )
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>/audit", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("audit.read")
@rate_limit(admin_rate_limit_key, limit=_AUDIT_LIMIT, window_seconds=_WINDOW)
def user_audit_endpoint(user_id: uuid.UUID):
    try:
        query = parse_query(PageQuery, request.args, context="users.audit")
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db).audit_history(actor.id, user_id, query.page, query.page_size)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.audit")
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>/avatar", methods=["PUT"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.avatar.manage")
@rate_limit(admin_rate_limit_key, limit=_AVATAR_WRITE_LIMIT, window_seconds=_WINDOW)
def put_user_avatar_endpoint(user_id: uuid.UUID):
    try:
        webp = process_avatar(read_avatar_upload())
    except AvatarError as exc:
        return avatar_error_response(exc)
    except BadRequest as exc:
        return validation_error(exc)
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db, storage=True).set_avatar(actor.id, user_id, webp)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.avatar")
    except StorageUnavailableError:
        return storage_unavailable_response()
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>/avatar", methods=["DELETE"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.avatar.manage")
@rate_limit(admin_rate_limit_key, limit=_AVATAR_WRITE_LIMIT, window_seconds=_WINDOW)
def delete_user_avatar_endpoint(user_id: uuid.UUID):
    rejected = reject_any_body("users.avatar.delete")
    if rejected is not None:
        return rejected
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db, storage=True).remove_avatar(actor.id, user_id)
    except UserAdminError as exc:
        return service_error_response(exc, actor_id=actor.id, target_id=user_id, context="users.avatar")
    except StorageUnavailableError:
        return storage_unavailable_response()
    return jsonify(payload), 200


@users_bp.route("/<uuid:user_id>/avatar-url", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.manage")
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT, window_seconds=_WINDOW)
def user_avatar_url_endpoint(user_id: uuid.UUID):
    actor = g.current_user
    try:
        with get_db_session() as db:
            payload = _service(db, storage=True).avatar_url(actor.id, user_id)
    except UserAdminError as exc:
        return service_error_response(
            exc, actor_id=actor.id, target_id=user_id, context="users.avatar_url"
        )
    except StorageUnavailableError:
        return storage_unavailable_response()
    return jsonify(payload), 200
