"""`GET /api/v1/me` — identidade, papéis, permissões e AAL do usuário autenticado.

Este endpoint existe para que o FRONTEND saiba, a partir de uma única
fonte de verdade no backend, qual o papel/permissões do usuário logado e
se a sessão atual já completou o desafio MFA (`current_aal`). O frontend
NUNCA deve decidir isso por conta própria (ex.: a partir de algo que ele
mesmo armazenou) — este endpoint é a referência.

IMPORTANTE — `mfa_required` não autoriza nada:
    `mfa_required=true` é apenas uma DICA para o frontend decidir se deve
    rotear o usuário para a tela de cadastro/desafio de MFA (ela é `true`
    sempre que o papel `ADM` estiver entre os papéis do usuário,
    independentemente do `current_aal` da sessão atual — ou seja, mesmo que
    a sessão já esteja em `aal2`, a flag continua `true` para um ADM,
    porque ela reflete a POLÍTICA "ADM deve ter MFA", não o estado da
    sessão). A autorização real de qualquer operação administrativa
    continua sendo, sempre, `app.authorization.rbac.require_aal2` no
    backend — nunca esta flag.

Exige apenas `require_auth` (qualquer usuário autenticado pode consultar o
próprio estado).

Foto de perfil do PRÓPRIO usuário (Etapa 2; contrato em
`docs/architecture/modulo-configuracoes.md`):
    - `PUT /api/v1/me/avatar` (multipart, campo `file`, até 2 MiB) e
      `DELETE /api/v1/me/avatar` -> `{"has_avatar": bool}`;
    - `GET /api/v1/me/avatar-url` -> `{"url", "expires_in": 300}` ou 404.
    O alvo é SEMPRE o usuário do JWT (nenhum id vem do cliente); mesma
    validação de imagem das rotas administrativas; Storage fora -> 503
    `storage_unavailable`. Limitadas por usuário (fail-closed).
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import PreferencesUpdateRequest, parse_body
from app.api.v1.user_admin_http import (
    StorageUnavailableError,
    admin_rate_limit_key,
    avatar_error_response,
    error_response,
    not_found_response,
    read_avatar_upload,
    reject_any_body,
    storage_unavailable_response,
    validation_error,
)
from app.auth.supabase_auth import require_auth
from app.authorization.security_events import get_request_id
from app.database.session import get_db_session
from app.integrations.supabase_storage_client import SupabaseStorageClient
from app.security.rate_limit import rate_limit
from app.services.avatar_service import AvatarError, process_avatar
from app.services.preferences_service import PreferencesService, PreferencesVersionConflictError
from app.services.user_admin_service import UserAdminError, UserAdminService

me_bp = Blueprint("me", __name__)

# Papel cuja presença implica a política obrigatória de MFA (ver docstring
# do módulo). Mantido como constante única para evitar divergência com
# outras checagens futuras de política de MFA obrigatório.
_ROLE_REQUIRING_MFA = "ADM"

_AVATAR_WRITE_LIMIT = 20
_AVATAR_READ_LIMIT = 600
_PREFS_READ_LIMIT = 600
_PREFS_WRITE_LIMIT = 60
_WINDOW_SECONDS = 3600


@me_bp.route("/me", methods=["GET"])
@require_auth
def get_me():
    user = g.current_user
    role_codes = sorted(getattr(g, "current_user_roles", set()))
    permission_codes = sorted(getattr(g, "current_user_permissions", set()))
    current_aal = getattr(g, "current_session_aal", "aal1")

    return (
        jsonify(
            {
                "id": str(user.id),
                "name": user.name,
                "email": user.email,
                "roles": role_codes,
                "permissions": permission_codes,
                "current_aal": current_aal,
                "mfa_required": _ROLE_REQUIRING_MFA in role_codes,
                # UA-FE-01: só o booleano; a URL vem de GET /me/avatar-url.
                "has_avatar": getattr(user, "avatar_object_key", None) is not None,
            }
        ),
        200,
    )


@me_bp.route("/me/preferences", methods=["GET"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_PREFS_READ_LIMIT, window_seconds=_WINDOW_SECONDS)
def get_my_preferences():
    user = g.current_user
    with get_db_session() as db:
        payload = PreferencesService(db).get_view(user.id)
    return jsonify(payload), 200


@me_bp.route("/me/preferences", methods=["PATCH"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_PREFS_WRITE_LIMIT, window_seconds=_WINDOW_SECONDS)
def update_my_preferences():
    try:
        changes = parse_body(
            PreferencesUpdateRequest, request.get_json(silent=True), context="me.preferences.update"
        )
    except BadRequest as exc:
        return validation_error(exc)
    user = g.current_user
    try:
        with get_db_session() as db:
            payload = PreferencesService(db, request_id=get_request_id()).update(user.id, changes)
    except PreferencesVersionConflictError as exc:
        return error_response(exc.status_code, exc.code, exc.message)
    return jsonify(payload), 200


def _self_service(db):
    return UserAdminService(db, storage=SupabaseStorageClient(), request_id=get_request_id())


@me_bp.route("/me/avatar", methods=["PUT"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_AVATAR_WRITE_LIMIT, window_seconds=_WINDOW_SECONDS)
def put_my_avatar():
    try:
        webp = process_avatar(read_avatar_upload())
    except AvatarError as exc:
        return avatar_error_response(exc)
    except BadRequest as exc:
        return validation_error(exc)
    user = g.current_user
    try:
        with get_db_session() as db:
            payload = _self_service(db).set_avatar(user.id, user.id, webp, self_service=True)
    except UserAdminError:
        return not_found_response()
    except StorageUnavailableError:
        return storage_unavailable_response()
    return jsonify(payload), 200


@me_bp.route("/me/avatar", methods=["DELETE"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_AVATAR_WRITE_LIMIT, window_seconds=_WINDOW_SECONDS)
def delete_my_avatar():
    rejected = reject_any_body("me.avatar.delete")
    if rejected is not None:
        return rejected
    user = g.current_user
    try:
        with get_db_session() as db:
            payload = _self_service(db).remove_avatar(user.id, user.id, self_service=True)
    except UserAdminError:
        return not_found_response()
    except StorageUnavailableError:
        return storage_unavailable_response()
    return jsonify(payload), 200


@me_bp.route("/me/avatar-url", methods=["GET"])
@require_auth
@rate_limit(admin_rate_limit_key, limit=_AVATAR_READ_LIMIT, window_seconds=_WINDOW_SECONDS)
def my_avatar_url():
    user = g.current_user
    try:
        with get_db_session() as db:
            payload = _self_service(db).avatar_url(user.id, user.id, self_service=True)
    except UserAdminError:
        return not_found_response()
    except StorageUnavailableError:
        return storage_unavailable_response()
    return jsonify(payload), 200
