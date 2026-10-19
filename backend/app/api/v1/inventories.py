"""Inventários (`/api/v1/inventories`): campanhas de conferência física por unidade.

Leitura (`GET` lista, id, `/summary`, `/items`): `require_auth -> require_aal2_for_adm ->
require_permission("inventory.check") -> rate_limit` (ADM/USER; não existe
`inventory.read`; RH sem acesso). Conferir bem (`POST /<id>/items`): `inventory.check`
(ADM e USER; AAL2 só ADM). Criar/iniciar/encerrar/cancelar: `require_auth ->
require_role("ADM") -> require_aal2 -> require_permission("inventory.create") ->
rate_limit`. Sem PUT/PATCH/DELETE. Regras em `app.services.inventory_service`; contrato
em `docs/architecture/inventories-api.md`.
"""
from __future__ import annotations

import uuid
from typing import Any

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.catalog_http import (
    ACTION_LIMIT,
    LIST_LIMIT,
    READ_LIMIT,
    WINDOW,
    WRITE_LIMIT,
    read_action_body,
    read_body,
    require_aal2_for_adm,
)
from app.api.v1.inventory_schemas import (
    InventoryActionRequest,
    InventoryCreateRequest,
    InventoryGetQuery,
    InventoryItemCheckRequest,
    InventoryItemsQuery,
    InventoryListQuery,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import (
    EVENT_UNIT_SCOPE_DENIED,
    SEVERITY_MEDIUM,
    get_request_id,
    record_security_event,
)
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.inventory_service import InventoryError, InventoryNotFoundError, InventoryService

inventories_bp = Blueprint("inventories", __name__, url_prefix="/inventories")


def _service(db) -> InventoryService:
    return InventoryService(db, request_id=get_request_id())


def _fail(exc: InventoryError, *, inventory_id: Any = None, context: str):
    if isinstance(exc, InventoryNotFoundError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="inventory" if inventory_id else "unit",
            target_id=inventory_id,
            details={"context": context},
        )
    return error_response(exc.status_code, exc.code, exc.message)


@inventories_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("inventory.check")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_inventories_endpoint():
    try:
        query = parse_query(InventoryListQuery, request.args, context="inventories.list")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _service(db).list(g.current_user.id, query)
    return jsonify(payload), 200


@inventories_bp.route("/<uuid:inventory_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("inventory.check")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_inventory_endpoint(inventory_id: uuid.UUID):
    try:
        parse_query(InventoryGetQuery, request.args, context="inventories.get")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            payload = _service(db).get(g.current_user.id, inventory_id)
    except InventoryError as exc:
        return _fail(exc, inventory_id=inventory_id, context="inventories.get")
    return jsonify(payload), 200


@inventories_bp.route("/<uuid:inventory_id>/summary", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("inventory.check")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def inventory_summary_endpoint(inventory_id: uuid.UUID):
    try:
        parse_query(InventoryGetQuery, request.args, context="inventories.summary")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            payload = _service(db).summary(g.current_user.id, inventory_id)
    except InventoryError as exc:
        return _fail(exc, inventory_id=inventory_id, context="inventories.summary")
    return jsonify(payload), 200


@inventories_bp.route("/<uuid:inventory_id>/items", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("inventory.check")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_inventory_items_endpoint(inventory_id: uuid.UUID):
    try:
        query = parse_query(InventoryItemsQuery, request.args, context="inventories.items")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            payload = _service(db).list_items(g.current_user.id, inventory_id, query)
    except InventoryError as exc:
        return _fail(exc, inventory_id=inventory_id, context="inventories.items")
    return jsonify(payload), 200


@inventories_bp.route("/<uuid:inventory_id>/items", methods=["POST"])
@require_auth
@require_aal2_for_adm
@require_permission("inventory.check")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def check_inventory_item_endpoint(inventory_id: uuid.UUID):
    body, error = read_body(InventoryItemCheckRequest, "inventories.check")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).check_item(g.current_user.id, inventory_id, body)
    except InventoryError as exc:
        return _fail(exc, inventory_id=inventory_id, context="inventories.check")
    return jsonify(payload), 201


@inventories_bp.route("", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("inventory.create")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def create_inventory_endpoint():
    body, error = read_body(InventoryCreateRequest, "inventories.create")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).create(g.current_user.id, body)
    except InventoryError as exc:
        return _fail(exc, context="inventories.create")
    return jsonify(payload), 201


def _transition(inventory_id: uuid.UUID, action: str):
    body, error = read_action_body(InventoryActionRequest, f"inventories.{action}")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = getattr(_service(db), action)(g.current_user.id, inventory_id, body)
    except InventoryError as exc:
        return _fail(exc, inventory_id=inventory_id, context=f"inventories.{action}")
    return jsonify(payload), 200


@inventories_bp.route("/<uuid:inventory_id>/start", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("inventory.create")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def start_inventory_endpoint(inventory_id: uuid.UUID):
    return _transition(inventory_id, "start")


@inventories_bp.route("/<uuid:inventory_id>/close", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("inventory.create")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def close_inventory_endpoint(inventory_id: uuid.UUID):
    return _transition(inventory_id, "close")


@inventories_bp.route("/<uuid:inventory_id>/cancel", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("inventory.create")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def cancel_inventory_endpoint(inventory_id: uuid.UUID):
    return _transition(inventory_id, "cancel")
