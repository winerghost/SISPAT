"""Perfis, permissões e vínculos de unidades -- `GET /api/v1/admin/...` (LEITURA).

    - `GET /admin/roles`        -> `roles.manage`  (perfis + permissões + contagem)
    - `GET /admin/permissions`  -> `roles.manage`  (catálogo de permissões)
    - `GET /admin/unit-access`  -> `users.manage`  (usuário x unidades, paginado)

`require_auth -> require_role("ADM") -> require_aal2 -> require_permission ->
rate_limit` (fail-closed). Nenhuma escrita: a edição de perfil/unidades de um
usuário continua em `PATCH /api/v1/users/<id>`. Sem e-mail/telefone nas
respostas (ver `app.services.admin_access_service`).
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.admin_schemas import NoQuery, UnitAccessQuery, parse_admin_query
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.admin_access_service import AdminAccessService

admin_access_bp = Blueprint("admin_access", __name__, url_prefix="/admin")

_WINDOW = 3600
_READ_LIMIT = 600
_LIST_LIMIT = 1200


@admin_access_bp.route("/roles", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("roles.manage")
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT, window_seconds=_WINDOW)
def list_roles_endpoint():
    try:
        parse_admin_query(NoQuery, request.args, context="admin.roles")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = AdminAccessService(db).list_roles(g.current_user.id)
    return jsonify(payload), 200


@admin_access_bp.route("/permissions", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("roles.manage")
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT, window_seconds=_WINDOW)
def list_permissions_endpoint():
    try:
        parse_admin_query(NoQuery, request.args, context="admin.permissions")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = AdminAccessService(db).list_permissions()
    return jsonify(payload), 200


@admin_access_bp.route("/unit-access", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.manage")
@rate_limit(admin_rate_limit_key, limit=_LIST_LIMIT, window_seconds=_WINDOW)
def list_unit_access_endpoint():
    try:
        query = parse_admin_query(UnitAccessQuery, request.args, context="admin.unit_access")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = AdminAccessService(db).list_unit_access(g.current_user.id, query)
    return jsonify(payload), 200
