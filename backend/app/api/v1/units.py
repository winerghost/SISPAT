"""`GET /api/v1/units` — unidades do escopo do ADM (seletor de vínculos, Etapa 2).

Pilha: `require_auth -> require_role("ADM") -> require_aal2 ->
require_permission("users.manage") -> rate_limit` (fail-closed). Só unidades
ATIVAS em `user_unit_access` do próprio ADM (`apply_unit_scope`); ADM sem
unidades recebe lista vazia. Nenhum parâmetro de consulta é aceito.
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.schemas import reject_unexpected_fields
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.user_admin_service import UserAdminService

units_bp = Blueprint("units", __name__, url_prefix="/units")

_LIMIT_PER_HOUR = 300
_WINDOW_SECONDS = 3600


@units_bp.route("", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("users.manage")
@rate_limit(admin_rate_limit_key, limit=_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def list_units_endpoint():
    if request.args:
        try:
            reject_unexpected_fields(set(request.args.keys()), context="units.list", location="na consulta")
        except BadRequest as exc:
            return validation_error(exc)
    with get_db_session() as db:
        payload = UserAdminService(db).list_units(g.current_user.id)
    return jsonify(payload), 200
