"""Endpoints administrativos de importação dos CADASTROS de apoio (Sheets).

Blueprint `catalog_imports_bp` (prefixo `/api/v1/catalog-imports`). Cadastros
(`kind`): `units`, `rooms`, `people` (allowlist fixa, ver `CATALOG_KINDS`).

Pilha de decorators (padrão de rota administrativa crítica):

    @require_auth -> @require_role("ADM") -> @require_aal2
    -> @_require_any_catalog_permission -> @rate_limit(...)

A permissão granular depende do cadastro (`units.update`, `rooms.manage`,
`responsible.manage`): o decorator estático exige ao menos UMA delas (negar por
padrão) e a view exige a específica do `kind` (na prévia, vindo da URL; nas
demais rotas, vindo da PRÓPRIA prévia gravada). Regras de resposta:

- `preview_id` inexistente, de OUTRO ADM (a prévia é do autor), malformado, de OUTRO TIPO (prévia de bens) ou de um
  cadastro para o qual o ADM não tem a permissão -> MESMA resposta 404
  (sem oráculo de existência); a negação é auditada (`ACCESS_DENIED`).
- `kind` fora da allowlist -> 404; sem a permissão do `kind` -> 403.
- Erros de domínio mapeados com mensagem GENÉRICA (nenhum detalhe interno):
  `CatalogSourceNotConfiguredError` -> 409 (a aba não está configurada: é um
  estado do sistema que impede a operação e se resolve por configuração, não
  um erro do corpo enviado); `CatalogSchemaError` -> 422 (a planilha existe mas
  seu conteúdo/colunas não são processáveis); `UpstreamSourceError` -> 502;
  `PreviewNotFoundError` -> 404; prévia expirada/já confirmada -> 409.
- LGPD: relatório e itens passam por `catalog_import_view` (allowlist): o
  telefone nunca é devolvido e o e-mail sai mascarado; a auditoria da prévia
  guarda só tipo e contadores (jamais valores de pessoas).
"""
from __future__ import annotations

import logging
import uuid
from functools import wraps
from typing import Any, Callable, TypeVar

from flask import Blueprint, g, jsonify, request

from app.api.v1.catalog_import_schemas import (
    CATALOG_KINDS,
    KIND_PERMISSION,
    CatalogConfirmRequest,
    CatalogConfirmResponse,
    CatalogItemsQuery,
)
from app.api.v1.catalog_http import read_body
from app.api.v1.schemas import parse_query
from app.api.v1.user_admin_http import (
    admin_rate_limit_key,
    error_response,
    not_found_response,
    reject_any_body,
)
from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2, require_role
from app.authorization.security_events import (
    EVENT_ACCESS_DENIED,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.database.session import get_db_session
from app.integrations.google_sheets_client import GoogleSheetsClient
from app.models.audit import AuditLog
from app.models.imports import ImportPreview
from app.security.rate_limit import rate_limit
from app.services.catalog_import_service import (
    SOURCE_PREFIX,
    CatalogImportService,
    CatalogSchemaError,
    CatalogSourceNotConfiguredError,
)
from app.services.catalog_import_view import list_items, serialize_item
from app.services.import_service import (
    PreviewNotConfirmableError,
    PreviewNotFoundError,
    UpstreamSourceError,
)

logger = logging.getLogger(__name__)

catalog_imports_bp = Blueprint("catalog_imports", __name__, url_prefix="/catalog-imports")

F = TypeVar("F", bound=Callable[..., Any])

_PREVIEW_LIMIT_PER_HOUR = 10  # consome cota do Google Sheets e grava prévia
_CONFIRM_LIMIT_PER_HOUR = 10  # escrita em massa nos cadastros
_READ_LIMIT_PER_HOUR = 600
_WINDOW_SECONDS = 3600

_MSG_NOT_CONFIGURED = "A aba deste cadastro não está configurada para importação."
_MSG_SCHEMA = "A aba de origem não tem a estrutura esperada para este cadastro."
_MSG_UPSTREAM = (
    "Não foi possível ler a planilha de origem (Google Sheets) neste momento. "
    "Tente novamente mais tarde."
)
_MSG_NOT_CONFIRMABLE = "A pré-visualização já foi confirmada, expirou ou não pode ser confirmada."
_MSG_FORBIDDEN = "Acesso negado."


def _require_any_catalog_permission(view_func: F) -> F:
    """Exige ao menos uma permissão de cadastro (negar por padrão; 403)."""

    @wraps(view_func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        permissions = getattr(g, "current_user_permissions", set())
        if not permissions.intersection(KIND_PERMISSION.values()):
            record_security_event(
                EVENT_ACCESS_DENIED,
                severity=SEVERITY_MEDIUM,
                actor_user_id=getattr(g.current_user, "id", None),
                details={"reason": "missing_permission", "required": "catalog_import.any"},
            )
            return error_response(403, "forbidden", _MSG_FORBIDDEN)
        return view_func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _has_kind_permission(kind: str) -> bool:
    return KIND_PERMISSION[kind] in getattr(g, "current_user_permissions", set())


def _deny_not_found(reason: str):
    """404 uniforme + evento (mesmo evento para inexistente/alheio/tipo trocado)."""
    record_security_event(
        EVENT_ACCESS_DENIED,
        severity=SEVERITY_MEDIUM,
        actor_user_id=getattr(g.current_user, "id", None),
        details={"reason": reason, "context": "catalog_imports"},
    )
    return not_found_response()


def _parse_uuid(raw: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(raw)
    except (ValueError, AttributeError, TypeError):
        return None


def _authorized_preview(db: Any, raw_id: str) -> tuple[ImportPreview | None, str | None, Any]:
    """Resolve a prévia de CADASTRO e confere a permissão do seu tipo.

    Retorna `(preview, kind, None)` ou `(None, None, resposta_404)`.
    """
    preview_id = _parse_uuid(raw_id)
    if preview_id is None:
        return None, None, _deny_not_found("catalog_preview_not_found")
    preview = db.get(ImportPreview, preview_id)
    source = str(preview.source) if preview is not None else ""
    kind = source[len(SOURCE_PREFIX):] if source.startswith(SOURCE_PREFIX) else ""
    if preview is None or kind not in CATALOG_KINDS:
        return None, None, _deny_not_found("catalog_preview_not_found")
    if not _has_kind_permission(kind):
        return None, None, _deny_not_found("catalog_preview_not_found")
    # SEC-CAT-02: a prévia é do AUTOR; outro ADM -> mesmo 404 (leitura e confirmação).
    if preview.requested_by != getattr(g.current_user, "id", None):
        return None, None, _deny_not_found("catalog_preview_not_found")
    return preview, kind, None


@catalog_imports_bp.route("/<kind>/preview", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@_require_any_catalog_permission
@rate_limit(admin_rate_limit_key, limit=_PREVIEW_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def create_catalog_preview_endpoint(kind: str):
    """`POST /api/v1/catalog-imports/<kind>/preview` — gera a prévia (201).

    Sem corpo. Retorna `preview_id`, `kind`, `summary`, `expires_at` e o
    `report` (pendências, IDs repetidos, nomes suspeitos, prováveis duplicatas).
    """
    rejected = reject_any_body("catalog_imports.preview")
    if rejected is not None:
        return rejected
    if kind not in CATALOG_KINDS:
        return _deny_not_found("catalog_kind_invalid")
    if not _has_kind_permission(kind):
        record_security_event(
            EVENT_ACCESS_DENIED,
            severity=SEVERITY_MEDIUM,
            actor_user_id=getattr(g.current_user, "id", None),
            details={"reason": "missing_permission", "required": KIND_PERMISSION[kind]},
        )
        return error_response(403, "forbidden", _MSG_FORBIDDEN)
    user = g.current_user

    try:
        with get_db_session() as db:
            service = CatalogImportService(db, GoogleSheetsClient())
            result = service.create_preview(kind, requested_by_user_id=user.id)
            preview = result.preview
            summary = {
                "total": preview.total_rows,
                "novo": preview.count_novo,
                "existente": preview.count_existente,
                "duplicado": preview.count_duplicado,
                "invalido": preview.count_invalido,
                "conflitante": preview.count_conflitante,
            }
            db.add(
                AuditLog(
                    id=uuid.uuid4(),
                    actor_user_id=user.id,
                    entity_type="catalog_import",
                    entity_id=str(preview.id),
                    operation="CREATE_CATALOG_PREVIEW",
                    new_values={"kind": kind, **summary},
                    result="SUCESSO",
                )
            )
            payload = {
                "preview_id": str(preview.id),
                "kind": kind,
                "summary": summary,
                "expires_at": preview.expires_at.isoformat(),
                "report": result.report,
            }
    except CatalogSourceNotConfiguredError:
        return error_response(409, "catalog_source_not_configured", _MSG_NOT_CONFIGURED)
    except CatalogSchemaError:
        return error_response(422, "catalog_schema_invalid", _MSG_SCHEMA)
    except UpstreamSourceError:
        logger.error("catalog_imports: falha ao gerar prévia (origem indisponível).")
        return error_response(502, "upstream_unavailable", _MSG_UPSTREAM)

    return jsonify(payload), 201


@catalog_imports_bp.route("/<preview_id>/report", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@_require_any_catalog_permission
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def catalog_report_endpoint(preview_id: str):
    """`GET /api/v1/catalog-imports/<preview_id>/report` — relatório da prévia."""
    rejected = reject_any_body("catalog_imports.report")
    if rejected is not None:
        return rejected
    with get_db_session() as db:
        preview, kind, denied = _authorized_preview(db, preview_id)
        if denied is not None:
            return denied
        try:
            report = CatalogImportService(db, GoogleSheetsClient()).get_report(
                preview.id, g.current_user.id
            )
        except PreviewNotFoundError:
            return _deny_not_found("catalog_preview_not_found")
        payload = {
            "preview_id": str(preview.id),
            "status": preview.status,
            "expires_at": preview.expires_at.isoformat(),
            "report": report,
        }
    return jsonify(payload), 200


@catalog_imports_bp.route("/<preview_id>/items", methods=["GET"])
@require_auth
@require_role("ADM")
@require_aal2
@_require_any_catalog_permission
@rate_limit(admin_rate_limit_key, limit=_READ_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def catalog_items_endpoint(preview_id: str):
    """`GET /api/v1/catalog-imports/<preview_id>/items`.

    Query: `status`, `search`, `sort` (allowlist em `CatalogItemSort`), `page`,
    `page_size` (50, 100 ou 200; default 50). Desconhecido/repetido -> 400. Telefone nunca sai.
    """
    rejected = reject_any_body("catalog_imports.items")
    if rejected is not None:
        return rejected
    query = parse_query(CatalogItemsQuery, request.args, context="catalog_imports.items")
    with get_db_session() as db:
        preview, kind, denied = _authorized_preview(db, preview_id)
        if denied is not None:
            return denied
        result = list_items(
            db,
            preview.id,
            status=query.status,
            search=query.search,
            sort=query.sort,
            page=query.page,
            page_size=query.page_size,
        )
        payload = {
            "preview_id": str(preview.id),
            "kind": kind,
            "total": result["total"],
            "page": result["page"],
            "page_size": result["page_size"], "pages": result["pages"],
            "items": [serialize_item(kind, item) for item in result["items"]],
        }
    return jsonify(payload), 200


@catalog_imports_bp.route("/<preview_id>/confirm", methods=["POST"])
@require_auth
@require_role("ADM")
@require_aal2
@_require_any_catalog_permission
@rate_limit(admin_rate_limit_key, limit=_CONFIRM_LIMIT_PER_HOUR, window_seconds=_WINDOW_SECONDS)
def catalog_confirm_endpoint(preview_id: str):
    """`POST /api/v1/catalog-imports/<preview_id>/confirm`.

    Corpo: `{"item_ids": [...]}` (máx. 10.000). Idempotente: a 2ª confirmação
    da mesma prévia responde 409 sem gravar nada.
    """
    body, bad_request = read_body(CatalogConfirmRequest, "catalog_imports.confirm")
    if bad_request is not None:
        return bad_request
    user = g.current_user
    try:
        with get_db_session() as db:
            preview, kind, denied = _authorized_preview(db, preview_id)
            if denied is not None:
                return denied
            result = CatalogImportService(db, GoogleSheetsClient()).confirm_preview(
                preview_id=preview.id,
                confirmed_by_user_id=user.id,
                selected_item_ids=list(body.item_ids),
                alias_item_ids=list(body.alias_item_ids),
            )
            payload = CatalogConfirmResponse.model_validate(
                {
                    "preview_id": str(preview.id),
                    "kind": kind,
                    "sync_job_id": str(result["sync_job_id"]),
                    "status": result["status"],
                    "created": result["created"],
                    "updated": result["updated"],
                    "ignorados": result["ignorados"],
                    "inalterados": result["inalterados"],
                    "nao_gravados": result["nao_gravados"],
                    "falhas_total": result["falhas_total"],
                    "falhas": [
                        {
                            "item_id": f.get("item_id"),
                            "row": f.get("row"),
                            "label": str(f["label"])[:300] if f.get("label") else None,
                            "reason": str(f["reason"])[:300] if f.get("reason") else None,
                        }
                        for f in result["falhas"]
                    ],
                }
            ).model_dump()
    except PreviewNotFoundError:
        return _deny_not_found("catalog_preview_not_found")
    except PreviewNotConfirmableError:
        return error_response(409, "conflict", _MSG_NOT_CONFIRMABLE)
    return jsonify(payload), 200
