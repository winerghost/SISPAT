"""Salas (`/api/v1/rooms`): CRUD com escopo de unidade.

Leitura (`GET`): qualquer perfil com `units.read` (USER/RH/ADM), limitada às
unidades do próprio usuário (`apply_unit_scope`); ADM exige AAL2.
Escrita: `require_auth -> require_role("ADM") -> require_aal2 ->
require_permission("rooms.manage") -> rate_limit`. "Excluir" = inativar
(`POST /<id>/deactivate`); reativar em `POST /<id>/activate`. Regras em
`app.services.catalog_service`; contrato em
`docs/architecture/cadastros-apoio-api.md`.
"""
from __future__ import annotations

import uuid

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import (
    ACTION_LIMIT,
    LIST_LIMIT,
    READ_LIMIT,
    WINDOW,
    WRITE_LIMIT,
    catalog_error_response,
    read_action_body,
    read_body,
    require_aal2_for_adm,
)
from app.api.v1.catalog_schemas import (
    ActiveActionRequest,
    RoomCreateRequest,
    RoomListQuery,
    RoomUpdateRequest,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import get_request_id
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.catalog_service import CatalogError, RoomService

rooms_bp = Blueprint("rooms", __name__, url_prefix="/rooms")


def _service(db) -> RoomService:
    return RoomService(db, request_id=get_request_id())


def _fail(exc: CatalogError, *, target_id=None, context: str):
    return catalog_error_response(
        exc, actor_id=g.current_user.id, target_type="room" if target_id else "unit",
        target_id=target_id, context=context,
    )


@rooms_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("units.read")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_rooms_endpoint():
    try:
        query = parse_query(RoomListQuery, request.args, context="rooms.list")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _service(db).list(g.current_user.id, query)
    return jsonify(payload), 200


@rooms_bp.route("/<uuid:room_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("units.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_room_endpoint(room_id: uuid.UUID):
    try:
        with get_db_session() as db:
            payload = _service(db).get(g.current_user.id, room_id)
    except CatalogError as exc:
        return _fail(exc, target_id=room_id, context="rooms.get")
    return jsonify(payload), 200


@rooms_bp.route("", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("rooms.manage")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def create_room_endpoint():
    body, error = read_body(RoomCreateRequest, "rooms.create")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).create(g.current_user.id, body)
    except CatalogError as exc:
        return _fail(exc, context="rooms.create")
    return jsonify(payload), 201


@rooms_bp.route("/<uuid:room_id>", methods=["PATCH"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("rooms.manage")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def update_room_endpoint(room_id: uuid.UUID):
    body, error = read_body(RoomUpdateRequest, "rooms.update")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            result = _service(db).update(g.current_user.id, room_id, body)
    except CatalogError as exc:
        return _fail(exc, target_id=room_id, context="rooms.update")
    return jsonify(result.payload), 200


def _set_active(room_id: uuid.UUID, active: bool, context: str):
    body, error = read_action_body(ActiveActionRequest, context)
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            result = _service(db).set_active(
                g.current_user.id, room_id, active,
                expected_updated_at=body.expected_updated_at, reason=body.reason,
            )
    except CatalogError as exc:
        return _fail(exc, target_id=room_id, context=context)
    return jsonify(result.payload), 200


@rooms_bp.route("/<uuid:room_id>/deactivate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("rooms.manage")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def deactivate_room_endpoint(room_id: uuid.UUID):
    return _set_active(room_id, False, "rooms.deactivate")


@rooms_bp.route("/<uuid:room_id>/activate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("rooms.manage")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def activate_room_endpoint(room_id: uuid.UUID):
    return _set_active(room_id, True, "rooms.activate")
