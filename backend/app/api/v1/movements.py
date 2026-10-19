"""Movimentações de bens (`/api/v1/movements`): histórico imutável de transferências.

Leitura (`GET`): `require_auth -> require_aal2_for_adm -> require_permission(
"assets.read") -> rate_limit` (não existe `movements.read`; RH lê sem motivo/autoria).
Solicitar/cancelar (`POST`, `POST /<id>/cancel`): `movements.create` (ADM e USER; AAL2
só ADM; cancelar = solicitante ou ADM). Aprovar/rejeitar (`POST /<id>/approve|reject`):
`require_auth -> require_role("ADM") -> require_aal2 -> require_permission(
"movements.approve") -> rate_limit`. Não há PUT/PATCH/DELETE. Regras em
`app.services.movement_service`; contrato em `docs/architecture/movements-api.md`.
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
from app.api.v1.movement_schemas import (
    MovementApproveRequest,
    MovementCreateRequest,
    MovementDecisionRequest,
    MovementGetQuery,
    MovementListQuery,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    EVENT_UNIT_SCOPE_DENIED,
    SEVERITY_MEDIUM,
    get_request_id,
    record_security_event,
)
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.movement_service import (
    MovementError,
    MovementForbiddenError,
    MovementNotFoundError,
    MovementService,
)

movements_bp = Blueprint("movements", __name__, url_prefix="/movements")


def _service(db) -> MovementService:
    roles = getattr(g, "current_user_roles", set())
    return MovementService(
        db,
        is_adm="ADM" in roles,
        can_view_internal=bool(roles & {"ADM", "USER"}),
        request_id=get_request_id(),
    )


def _fail(exc: MovementError, *, movement_id: Any = None, context: str):
    """Converte o erro de domínio, auditando negações (404 de escopo é uniforme)."""
    if isinstance(exc, MovementNotFoundError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="asset_movement" if movement_id else "asset",
            target_id=movement_id,
            details={"context": context},
        )
    elif isinstance(exc, MovementForbiddenError):
        record_security_event(
            EVENT_ACCESS_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="asset_movement",
            target_id=movement_id,
            details={"context": context},
        )
    return error_response(exc.status_code, exc.code, exc.message)


@movements_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.read")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_movements_endpoint():
    try:
        query = parse_query(MovementListQuery, request.args, context="movements.list")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _service(db).list(g.current_user.id, query)
    return jsonify(payload), 200


@movements_bp.route("/<uuid:movement_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_movement_endpoint(movement_id: uuid.UUID):
    try:
        parse_query(MovementGetQuery, request.args, context="movements.get")
    except BadRequest as exc:
        return validation_error(exc)
    try:
        with get_db_session() as db:
            payload = _service(db).get(g.current_user.id, movement_id)
    except MovementError as exc:
        return _fail(exc, movement_id=movement_id, context="movements.get")
    return jsonify(payload), 200


@movements_bp.route("", methods=["POST"])
@require_auth
@require_aal2_for_adm
@require_permission("movements.create")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def create_movement_endpoint():
    body, error = read_body(MovementCreateRequest, "movements.create")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).create(g.current_user.id, body)
    except MovementError as exc:
        return _fail(exc, context="movements.create")
    return jsonify(payload), 201


@movements_bp.route("/<uuid:movement_id>/cancel", methods=["POST"])
@require_auth
@require_aal2_for_adm
@require_permission("movements.create")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def cancel_movement_endpoint(movement_id: uuid.UUID):
    body, error = read_action_body(MovementDecisionRequest, "movements.cancel")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).cancel(g.current_user.id, movement_id, body)
    except MovementError as exc:
        return _fail(exc, movement_id=movement_id, context="movements.cancel")
    return jsonify(payload), 200


@movements_bp.route("/<uuid:movement_id>/approve", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("movements.approve")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def approve_movement_endpoint(movement_id: uuid.UUID):
    body, error = read_body(MovementApproveRequest, "movements.approve")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).approve(g.current_user.id, movement_id, body)
    except MovementError as exc:
        return _fail(exc, movement_id=movement_id, context="movements.approve")
    return jsonify(payload), 200


@movements_bp.route("/<uuid:movement_id>/reject", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("movements.approve")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def reject_movement_endpoint(movement_id: uuid.UUID):
    body, error = read_action_body(MovementDecisionRequest, "movements.reject")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).reject(g.current_user.id, movement_id, body)
    except MovementError as exc:
        return _fail(exc, movement_id=movement_id, context="movements.reject")
    return jsonify(payload), 200
