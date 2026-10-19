"""`GET /api/v1/units` — unidades do escopo do ADM (seletor de vínculos, Etapa 2).

Além da listagem, expõe os dados cadastrais da unidade (`GET/PATCH
/units/<id>`, `POST /units/<id>/{deactivate,activate}`): ver `catalog_service`.

Pilha da listagem: `require_auth -> require_role("ADM") -> require_aal2 ->
require_permission("users.manage") -> rate_limit` (fail-closed). Só unidades
ATIVAS em `user_unit_access` do próprio ADM (`apply_unit_scope`); ADM sem
unidades recebe lista vazia. Nenhum parâmetro de consulta é aceito.
"""
from __future__ import annotations

import uuid

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1 import catalog_http
from app.api.v1.catalog_http import (
    catalog_error_response,
    is_adm,
    read_action_body,
    read_body,
    require_aal2_for_adm,
)
from app.api.v1.catalog_schemas import ActiveActionRequest, UnitListQuery, UnitUpdateRequest
from app.api.v1.schemas import parse_query, reject_unexpected_fields
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import get_request_id
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.catalog_service import CatalogError, UnitCatalogService
from app.services.unit_scope_service import list_accessible_units
from app.services.user_admin_service import UserAdminService

units_bp = Blueprint("units", __name__, url_prefix="/units")

_LIMIT_PER_HOUR = 300
_READ_LIMIT_PER_HOUR = 600
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


# ---------------------------------------------------------------------------
# Dados cadastrais da unidade (cadastros de apoio; regra em catalog_service)
# ---------------------------------------------------------------------------


def _catalog_service(db):
    return UnitCatalogService(db, is_adm=is_adm(), request_id=get_request_id())


def _unit_fail(exc, unit_id, context):
    return catalog_error_response(
        exc, actor_id=g.current_user.id, target_type="unit", target_id=unit_id, context=context
    )


@units_bp.route("/catalog", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("units.update")
@rate_limit(admin_rate_limit_key, limit=catalog_http.LIST_LIMIT, window_seconds=_WINDOW_SECONDS)
def list_unit_catalog_endpoint():
    """Cadastro de unidades (ativas e inativas) do escopo do ADM, com `address`.

    Rota separada: `GET /units` (seletor, `users.manage`) mantém seu contrato.
    """
    try:
        query = parse_query(UnitListQuery, request.args, context="units.catalog")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _catalog_service(db).list_catalog(g.current_user.id, query)
    return jsonify(payload), 200


@units_bp.route("/accessible", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("units.read")
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def list_accessible_units_endpoint():
    """Unidades do ESCOPO do usuário (qualquer perfil com `units.read`).

    `{units: [{id, code, name, active}]}` ordenado por `code`; sem `address` nem
    ids de origem. Nenhum parâmetro de consulta é aceito (400).
    """
    if request.args:
        try:
            reject_unexpected_fields(
                set(request.args.keys()), context="units.accessible", location="na consulta"
            )
        except BadRequest as exc:
            return validation_error(exc)
    with get_db_session() as db:
        payload = list_accessible_units(db, g.current_user.id)
    return jsonify(payload), 200


@units_bp.route("/<uuid:unit_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("units.read")
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def get_unit_endpoint(unit_id: uuid.UUID):
    """Unidade do escopo; `address` só para ADM. Alheia/inexistente => 404 igual."""
    try:
        with get_db_session() as db:
            payload = _catalog_service(db).get(g.current_user.id, unit_id)
    except CatalogError as exc:
        return _unit_fail(exc, unit_id, "units.get")
    return jsonify(payload), 200


@units_bp.route("/<uuid:unit_id>", methods=["PATCH"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("units.update")
@rate_limit(admin_rate_limit_key, limit=catalog_http.WRITE_LIMIT, window_seconds=_WINDOW_SECONDS)
def update_unit_endpoint(unit_id: uuid.UUID):
    """Edita `name`, `description`, `address`; `code`/`active`/ids são recusados."""
    body, error = read_body(UnitUpdateRequest, "units.update")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            result = _catalog_service(db).update(g.current_user.id, unit_id, body)
    except CatalogError as exc:
        return _unit_fail(exc, unit_id, "units.update")
    return jsonify(result.payload), 200


def _set_unit_active(unit_id: uuid.UUID, active: bool, context: str):
    body, error = read_action_body(ActiveActionRequest, context)
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            result = _catalog_service(db).set_active(
                g.current_user.id, unit_id, active,
                expected_updated_at=body.expected_updated_at, reason=body.reason,
            )
    except CatalogError as exc:
        return _unit_fail(exc, unit_id, context)
    return jsonify(result.payload), 200


@units_bp.route("/<uuid:unit_id>/deactivate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("units.update")
@rate_limit(admin_rate_limit_key, limit=catalog_http.ACTION_LIMIT, window_seconds=_WINDOW_SECONDS)
def deactivate_unit_endpoint(unit_id: uuid.UUID):
    return _set_unit_active(unit_id, False, "units.deactivate")


@units_bp.route("/<uuid:unit_id>/activate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("units.update")
@rate_limit(admin_rate_limit_key, limit=catalog_http.ACTION_LIMIT, window_seconds=_WINDOW_SECONDS)
def activate_unit_endpoint(unit_id: uuid.UUID):
    return _set_unit_active(unit_id, True, "units.activate")
