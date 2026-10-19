"""Endpoints administrativos de importação de dados (Google Sheets).

Blueprint `imports_bp`, registrado dentro de `api_v1_bp` (ver
`app/api/v1/__init__.py`), resultando no prefixo `/api/v1/imports`.

Todos os endpoints deste módulo são operações administrativas críticas
(leem a planilha de origem e, no caso da confirmação, gravam em `assets`) e
por isso exigem, empilhados na ordem correta (ver docstrings de
`app.auth.supabase_auth.require_auth` e `app.authorization.rbac`):

    @require_auth
    @require_role("ADM")
    @require_aal2
    @require_permission("imports.execute")

ou seja: 401 sem token válido; 403 para qualquer usuário autenticado que não
tenha o papel ADM OU não tenha a permissão granular `imports.execute`
(ambos são exigidos, replicando o padrão documentado em
`app.authorization.rbac`); 403 `AAL2_REQUIRED` se a sessão do ADM ainda não
completou o desafio MFA (operação administrativa crítica).

Escopo das prévias (decisão intencional, documentada): `imports.execute` é
GLOBAL na matriz de permissões (a importação do Google Sheets não é
fracionável por unidade) — por isso qualquer ADM com AAL2 e a permissão
pode listar/confirmar uma prévia gerada por outro ADM; não há vínculo de
prévia ao criador/unidade. `selected_item_ids` é limitado a 10.000 itens
(`ConfirmImportRequest`).

Corpos JSON são validados por schemas Pydantic estritos
(`app.api.v1.schemas`, `extra="forbid"`): campos desconhecidos são
rejeitados com 400 e registrados em `audit_logs`.

Nenhum detalhe interno (de `ImportServiceError`, de exceções do
SQLAlchemy, etc.) é exposto ao cliente — toda resposta de erro usa
`flask.abort(status, description=...)` com uma mensagem genérica seguindo
o formato padronizado de `app.errors`.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from flask import Blueprint, abort, g, jsonify, request

from app.api.v1.schemas import ConfirmImportRequest, ImportItemsQuery, parse_body, parse_query
from app.api.v1.user_admin_http import admin_rate_limit_key, reject_any_body
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_permission, require_role
from app.database.session import get_db_session
from app.integrations.google_sheets_client import GoogleSheetsClient
from app.models.imports import ImportPreview, ImportPreviewItem
from app.security.rate_limit import rate_limit
from app.services.import_service import (
    ImportService,
    PreviewNotConfirmableError,
    PreviewNotFoundError,
    UpstreamSourceError,
)

logger = logging.getLogger(__name__)

imports_bp = Blueprint("imports", __name__, url_prefix="/imports")

# B-1: limites por ADM (chave = id do usuário; Redis fora -> 503, fail-closed).
_PREVIEW_LIMIT_PER_HOUR = 10  # consome cota do Google Sheets e grava prévia
_CONFIRM_LIMIT_PER_HOUR = 10  # escrita em massa em `assets`
_ITEMS_LIMIT_PER_HOUR = 600
_WINDOW_SECONDS = 3600

_UPSTREAM_ERROR_MESSAGE = (
    "Não foi possível ler a planilha de origem (Google Sheets) neste momento. "
    "Tente novamente mais tarde."
)


def _serialize_item(item: ImportPreviewItem) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "source_record_id": item.source_record_id,
        "patrimony_number": item.patrimony_number,
        "description": item.description,
        "classification": item.classification,
        "selected": item.selected,
        "matched_asset_id": str(item.matched_asset_id) if item.matched_asset_id else None,
        "validation_errors": item.validation_errors,
    }


@imports_bp.route("/google-sheets/preview", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("imports.execute")
@rate_limit(admin_rate_limit_key, limit=_PREVIEW_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def create_preview_endpoint():
    """`POST /api/v1/imports/google-sheets/preview` — gera uma nova prévia.

    Sem corpo (usa a planilha já configurada em `settings`). Retorna 201
    com o resumo da classificação. Se a leitura do Google Sheets falhar,
    retorna 502 com uma mensagem genérica (nunca o detalhe interno do
    cliente). Qualquer corpo é rejeitado (400, campos auditados).
    """
    rejected = reject_any_body("imports.preview")
    if rejected is not None:
        return rejected
    user = g.current_user

    try:
        with get_db_session() as db:
            service = ImportService(db, GoogleSheetsClient())
            preview = service.create_preview(requested_by_user_id=user.id)
            payload = {
                "preview_id": str(preview.id),
                "summary": {
                    "total": preview.total_rows,
                    "novo": preview.count_novo,
                    "existente": preview.count_existente,
                    "duplicado": preview.count_duplicado,
                    "invalido": preview.count_invalido,
                    "conflitante": preview.count_conflitante,
                },
                "expires_at": preview.expires_at.isoformat(),
                # Pendências de vínculo (sala/pessoa/unidade pertencente...):
                # só contadores, nunca bloqueiam a confirmação.
                "pending_counts": dict(getattr(preview, "pending_counts", None) or {}),
            }
    except UpstreamSourceError:
        logger.error("imports_api: falha ao gerar prévia (origem Google Sheets indisponível).")
        abort(502, description=_UPSTREAM_ERROR_MESSAGE)
        raise AssertionError("inalcançável")  # pragma: no cover

    return jsonify(payload), 201


@imports_bp.route("/google-sheets/preview/<uuid:preview_id>/items", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("imports.execute")
@rate_limit(admin_rate_limit_key, limit=_ITEMS_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def list_preview_items_endpoint(preview_id: uuid.UUID):
    """`GET /api/v1/imports/google-sheets/preview/<preview_id>/items`.

    Query params: `status` (filtra por `classification`), `search` (busca
    em `patrimony_number`/`description`), `page` (default 1), `page_size`
    (default 25, máximo 100). Retorna 404 se a prévia não existir.
    """
    query = parse_query(ImportItemsQuery, request.args, context="imports.items")
    status, search, page, page_size = query.status, query.search, query.page, query.page_size

    try:
        with get_db_session() as db:
            # SEC-CAT-01: só prévia de BENS; cadastro/inexistente -> mesmo 404 genérico.
            if not _bens_preview_exists(db, preview_id):
                raise PreviewNotFoundError("pré-visualização não encontrada")
            service = ImportService(db, GoogleSheetsClient())
            result = service.list_preview_items(
                preview_id, status=status, search=search, page=page, page_size=page_size
            )
            payload = {
                "total": result["total"],
                "page": result["page"],
                "page_size": result["page_size"],
                "items": [_serialize_item(item) for item in result["items"]],
            }
    except PreviewNotFoundError:
        abort(404, description="Pré-visualização não encontrada.")
        raise AssertionError("inalcançável")  # pragma: no cover

    return jsonify(payload), 200


def _bens_preview_exists(db: Any, preview_id: uuid.UUID) -> bool:
    """True só para prévia de BENS (`source = 'google_sheets'`); prévias de
    cadastros (`catalog:*`) ou inexistentes -> False (mesmo 404)."""
    source = db.query(ImportPreview.source).filter(ImportPreview.id == preview_id).scalar()
    return source == "google_sheets"


@imports_bp.route("/google-sheets/<uuid:preview_id>/pending", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("imports.execute")
@rate_limit(admin_rate_limit_key, limit=_ITEMS_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def pending_report_endpoint(preview_id: uuid.UUID):
    """`GET /api/v1/imports/google-sheets/<preview_id>/pending`.

    Contadores de pendências de vínculo da prévia de bens (unidade sem alias,
    sala/pessoa não encontrada ou ambígua...). Somente contadores. 404 uniforme
    para prévia inexistente ou de outro tipo (cadastros).
    """
    rejected = reject_any_body("imports.pending")
    if rejected is not None:
        return rejected
    with get_db_session() as db:
        if not _bens_preview_exists(db, preview_id):
            abort(404)  # mensagem padrão = a do 404 de roteamento (id malformado)
        counts = ImportService(db, GoogleSheetsClient()).pending_report(preview_id)
    return jsonify({"preview_id": str(preview_id), "pending_counts": counts}), 200


@imports_bp.route("/google-sheets/confirm", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@require_permission("imports.execute")
@rate_limit(admin_rate_limit_key, limit=_CONFIRM_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def confirm_preview_endpoint():
    """`POST /api/v1/imports/google-sheets/confirm`.

    Corpo JSON obrigatório: `{"preview_id": "...", "selected_item_ids": [...]}`.
    Mapeia erros de domínio para HTTP: 404 (prévia inexistente), 409 (prévia
    não confirmável — já confirmada, falhou ou expirada; este é também o
    mecanismo de idempotência desta operação, ver
    `app.services.import_service.ImportService.confirm_preview`).
    """
    body_in = parse_body(
        ConfirmImportRequest, request.get_json(silent=True), context="imports.confirm"
    )
    preview_id = body_in.preview_id
    selected_item_ids: list[uuid.UUID] = list(body_in.selected_item_ids)

    user = g.current_user

    try:
        with get_db_session() as db:
            service = ImportService(db, GoogleSheetsClient())
            result = service.confirm_preview(
                preview_id=preview_id,
                confirmed_by_user_id=user.id,
                selected_item_ids=selected_item_ids,
            )
            payload = {
                "sync_job_id": str(result["sync_job_id"]),
                "created": result["created"],
                "updated": result["updated"],
                "ignorados": result["ignorados"],
                "falhas": result["falhas"],
            }
    except PreviewNotFoundError:
        abort(404, description="Pré-visualização não encontrada.")
        raise AssertionError("inalcançável")  # pragma: no cover
    except PreviewNotConfirmableError as exc:
        abort(409, description=str(exc))
        raise AssertionError("inalcançável")  # pragma: no cover

    return jsonify(payload), 200
