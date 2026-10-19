"""Pessoas responsáveis (`/api/v1/responsible-people`): CRUD com escopo de unidade.

Leitura (`GET`): `responsible.read` (USER/RH/ADM) com escopo de unidade; ADM
exige AAL2. `phone` (dado pessoal) só aparece para ADM. USER (SEC-CAT-06) vê
SÓ pessoas vinculadas a bens do seu escopo e só id/name/unit_id/active; RH/ADM
veem o cadastro completo. Escrita: `require_auth
-> require_role("ADM") -> require_aal2 -> require_permission(
"responsible.manage") -> rate_limit`; "excluir" = inativar
(`POST /<id>/deactivate`). Regras em `app.services.catalog_service`.
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
    is_adm,
    is_minimal_people_view,
    read_action_body,
    read_body,
    require_aal2_for_adm,
)
from app.api.v1.catalog_schemas import (
    ActiveActionRequest,
    PersonCreateRequest,
    PersonListQuery,
    PersonUpdateRequest,
)
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, error_response, validation_error
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    SEVERITY_LOW,
    get_request_id,
    record_security_event,
)
from app.database.session import get_db_session
from app.security.rate_limit import rate_limit
from app.services.catalog_service import (
    MINIMAL_PERSON_SORTS,
    CatalogError,
    ResponsiblePersonService,
)

responsible_people_bp = Blueprint("responsible_people", __name__, url_prefix="/responsible-people")


def _service(db) -> ResponsiblePersonService:
    return ResponsiblePersonService(
        db, is_adm=is_adm(), request_id=get_request_id(), minimal=is_minimal_people_view()
    )


def _fail(exc: CatalogError, *, target_id=None, context: str):
    return catalog_error_response(
        exc, actor_id=g.current_user.id,
        target_type="responsible_person" if target_id else "unit",
        target_id=target_id, context=context,
    )


@responsible_people_bp.route("", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("responsible.read")
@rate_limit(admin_rate_limit_key, limit=LIST_LIMIT, window_seconds=WINDOW)
def list_people_endpoint():
    try:
        query = parse_query(PersonListQuery, request.args, context="responsible_people.list")
    except BadRequest as exc:
        return validation_error(exc)
    if is_minimal_people_view() and query.sort not in MINIMAL_PERSON_SORTS:
        record_security_event(
            EVENT_ACCESS_DENIED,
            severity=SEVERITY_LOW,
            actor_user_id=g.current_user.id,
            target_type="responsible_person",
            target_id=None,
            details={"context": "responsible_people.list", "fields": ["sort"]},
        )
        return error_response(400, "validation_error", "Parâmetro(s) inválido(s): sort.")
    with get_db_session() as db:
        payload = _service(db).list(g.current_user.id, query)
    return jsonify(payload), 200


@responsible_people_bp.route("/<uuid:person_id>", methods=["GET"])
@require_auth
@require_aal2_for_adm
@require_permission("responsible.read")
@rate_limit(admin_rate_limit_key, limit=READ_LIMIT, window_seconds=WINDOW)
def get_person_endpoint(person_id: uuid.UUID):
    try:
        with get_db_session() as db:
            payload = _service(db).get(g.current_user.id, person_id)
    except CatalogError as exc:
        return _fail(exc, target_id=person_id, context="responsible_people.get")
    return jsonify(payload), 200


@responsible_people_bp.route("", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("responsible.manage")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def create_person_endpoint():
    body, error = read_body(PersonCreateRequest, "responsible_people.create")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            payload = _service(db).create(g.current_user.id, body)
    except CatalogError as exc:
        return _fail(exc, context="responsible_people.create")
    return jsonify(payload), 201


@responsible_people_bp.route("/<uuid:person_id>", methods=["PATCH"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("responsible.manage")
@rate_limit(admin_rate_limit_key, limit=WRITE_LIMIT, window_seconds=WINDOW)
def update_person_endpoint(person_id: uuid.UUID):
    body, error = read_body(PersonUpdateRequest, "responsible_people.update")
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            result = _service(db).update(g.current_user.id, person_id, body)
    except CatalogError as exc:
        return _fail(exc, target_id=person_id, context="responsible_people.update")
    return jsonify(result.payload), 200


def _set_active(person_id: uuid.UUID, active: bool, context: str):
    body, error = read_action_body(ActiveActionRequest, context)
    if error is not None:
        return error
    try:
        with get_db_session() as db:
            result = _service(db).set_active(
                g.current_user.id, person_id, active,
                expected_updated_at=body.expected_updated_at, reason=body.reason,
            )
    except CatalogError as exc:
        return _fail(exc, target_id=person_id, context=context)
    return jsonify(result.payload), 200


@responsible_people_bp.route("/<uuid:person_id>/deactivate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("responsible.manage")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def deactivate_person_endpoint(person_id: uuid.UUID):
    return _set_active(person_id, False, "responsible_people.deactivate")


@responsible_people_bp.route("/<uuid:person_id>/activate", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("responsible.manage")
@rate_limit(admin_rate_limit_key, limit=ACTION_LIMIT, window_seconds=WINDOW)
def activate_person_endpoint(person_id: uuid.UUID):
    return _set_active(person_id, True, "responsible_people.activate")
