"""Locais de guarda (`/api/v1/locations`): leitura com escopo de unidade.

`require_auth -> require_aal2_for_adm -> require_permission("units.read") -> rate_limit`
(USER/RH/ADM; AAL2 só ADM). Sem escrita. Contrato em `docs/architecture/cadastros-apoio-api.md`.
"""
from __future__ import annotations

import uuid

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import (
    LIST_LIMIT,
    READ_LIMIT,
    WINDOW,
    catalog_error_response,
    require_aal2_for_adm,
)
from app.api.v1.location_schemas import LocationGetQuery, LocationListQuery
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_permission
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.catalog_service import CatalogError
from app.services.location_service import LocationService

locations_bp = Blueprint("locations", __name__, url_prefix="/locations")


@locations_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("units.read")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_locations_endpoint():
    try:
        query = parse_query(LocationListQuery, request.args, context="locations.list")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = LocationService(db).list(g.current_user.id, query)
    return jsonify(payload), 200


@locations_bp.route("/<uuid:location_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("units.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_location_endpoint(location_id: uuid.UUID):
    try:
        parse_query(LocationGetQuery, request.args, context="locations.get")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            payload = LocationService(db).get(g.current_user.id, location_id)
    except CatalogError as exc:
        return catalog_error_response(
            exc, actor_id=g.current_user.id, target_type="location", target_id=location_id,
            context="locations.get",
        )
    return jsonify(payload), 200
