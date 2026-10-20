"""Patrimônios (`/api/v1/assets`): leitura, escrita e exclusão lógica com escopo.

Leitura (`GET`, `history`, `bond-statuses`): `require_auth -> require_aal2_for_adm ->
require_permission("assets.read") -> rate_limit`; ADM exige AAL2, USER/RH não.
Escrita de cadastro (`POST`, `PATCH`): `assets.create`/`assets.update`
(ADM e USER; AAL2 só para ADM; campos por perfil no serviço). Exclusão lógica
(`POST /<id>/delete`, `/restore`): `require_auth -> require_role("ADM") ->
require_aal2 -> require_permission("assets.delete") -> rate_limit`. Não há rota
DELETE. Regras em `app.services.asset_service`; contrato em
`docs/architecture/assets-api.md`.
"""
from __future__ import annotations

import uuid
from typing import Any

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import BadRequest

from app.api.v1.asset_schemas import (
    AssetActionRequest,
    AssetBondStatusQuery,
    AssetCreateRequest,
    AssetGetQuery,
    AssetHistoryQuery,
    AssetListQuery,
    AssetUpdateRequest,
)
from app.api.v1.catalog_http import (
    ACTION_LIMIT,
    LIST_LIMIT,
    READ_LIMIT,
    WINDOW,
    WRITE_LIMIT,
    is_adm,
    read_body,
    require_aal2_for_adm,
)
from app.api.v1.schemas import parse_query, reject_unexpected_fields
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
from app.services.asset_service import (
    AssetError,
    AssetFieldForbiddenError,
    AssetNotFoundError,
    AssetService,
)

assets_bp = Blueprint("assets", __name__, url_prefix="/assets")


def _service(db) -> AssetService:
    roles = getattr(g, "current_user_roles", set())
    return AssetService(
        db,
        is_adm="ADM" in roles,
        can_view_notes=bool(roles & {"ADM", "USER"}),  # RH-only: sem notas internas
        request_id=get_request_id(),
    )


def _fail(exc: AssetError, *, asset_id: Any = None, context: str):
    """Converte o erro de domínio; auditando negações (404 de escopo é uniforme)."""
    if isinstance(exc, AssetNotFoundError):
        record_security_event(
            EVENT_UNIT_SCOPE_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="asset" if asset_id else "unit",
            target_id=asset_id,
            details={"context": context},
        )
    elif isinstance(exc, AssetFieldForbiddenError):
        try:
            reject_unexpected_fields(set(exc.fields), context=context)
        except BadRequest as bad:
            return validation_error(bad)
    return error_response(exc.status_code, exc.code, exc.message)


def _deny_include_deleted(query: Any, context: str):
    """`include_deleted=true` é exclusivo do ADM (403 + evento para os demais)."""
    if query.include_deleted == "true" and not is_adm():
        record_security_event(
            EVENT_ACCESS_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=g.current_user.id,
            target_type="asset",
            details={"context": context, "reason": "include_deleted_requires_adm"},
        )
        return error_response(403, "forbidden", "Acesso negado.")
    return None


@assets_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.read")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_assets_endpoint():
    try:
        query = parse_query(AssetListQuery, request.args, context="assets.list")
    except BadRequest as exc:
        return validation_error(exc)
    denied = _deny_include_deleted(query, "assets.list")
    if denied is not None:
        return denied
    with get_db_session() as db:
        payload = _service(db).list(g.current_user.id, query)
    return jsonify(payload), 200


@assets_bp.route("/bond-statuses", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def list_bond_statuses_endpoint():
    """Opções do filtro "Vínculo" (contagens só dos bens no escopo do usuário)."""
    try:
        parse_query(AssetBondStatusQuery, request.args, context="assets.bond_statuses")
    except BadRequest as exc:
        return validation_error(exc)
    with get_db_session() as db:
        payload = _service(db).bond_statuses(g.current_user.id)
    return jsonify(payload), 200


@assets_bp.route("/<uuid:asset_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_asset_endpoint(asset_id: uuid.UUID):
    try:
        query = parse_query(AssetGetQuery, request.args, context="assets.get")
    except BadRequest as exc:
        return validation_error(exc)
    denied = _deny_include_deleted(query, "assets.get")
    if denied is not None:
        return denied
    try:
        with get_db_session() as db:
            payload = _service(db).get(
                g.current_user.id, asset_id, include_deleted=query.include_deleted == "true"
            )
    except AssetError as exc:
        return _fail(exc, asset_id=asset_id, context="assets.get")
    return jsonify(payload), 200


@assets_bp.route("/<uuid:asset_id>/history", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def asset_history_endpoint(asset_id: uuid.UUID):
    try:
        query = parse_query(AssetHistoryQuery, request.args, context="assets.history")
    except BadRequest as exc:
        return validation_error(exc)
    denied = _deny_include_deleted(query, "assets.history")
    if denied is not None:
        return denied
    try:
        with get_db_session() as db:
            payload = _service(db).history(g.current_user.id, asset_id, query)
    except AssetError as exc:
        return _fail(exc, asset_id=asset_id, context="assets.history")
    return jsonify(payload), 200


@assets_bp.route("", methods=["POST"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.create")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def create_asset_endpoint():
    body, error = read_body(AssetCreateRequest, "assets.create")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).create(g.current_user.id, body)
    except AssetError as exc:
        return _fail(exc, context="assets.create")
    return jsonify(payload), 201


@assets_bp.route("/<uuid:asset_id>", methods=["PATCH"])
@require_auth
@require_aal2_for_adm
@require_permission("assets.update")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def update_asset_endpoint(asset_id: uuid.UUID):
    body, error = read_body(AssetUpdateRequest, "assets.update")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload, _changed = _service(db).update(g.current_user.id, asset_id, body)
    except AssetError as exc:
        return _fail(exc, asset_id=asset_id, context="assets.update")
    return jsonify(payload), 200


@assets_bp.route("/<uuid:asset_id>/delete", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("assets.delete")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def delete_asset_endpoint(asset_id: uuid.UUID):
    body, error = read_body(AssetActionRequest, "assets.delete")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).delete(g.current_user.id, asset_id, body)
    except AssetError as exc:
        return _fail(exc, asset_id=asset_id, context="assets.delete")
    return jsonify(payload), 200


@assets_bp.route("/<uuid:asset_id>/restore", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("assets.delete")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def restore_asset_endpoint(asset_id: uuid.UUID):
    body, error = read_body(AssetActionRequest, "assets.restore")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).restore(g.current_user.id, asset_id, body)
    except AssetError as exc:
        return _fail(exc, asset_id=asset_id, context="assets.restore")
    return jsonify(payload), 200
