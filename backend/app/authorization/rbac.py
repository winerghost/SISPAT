"""Autorização RBAC (papéis e permissões) do SISPAT-AGU.

Pressupõe que `app.auth.supabase_auth.require_auth` já executou ANTES
destes decorators na pilha de decorators da view (ver docstring de
`require_auth` sobre a ordem correta), pois os decorators aqui leem
`flask.g.current_user`, `flask.g.current_user_roles` e
`flask.g.current_user_permissions`, todos populados por `require_auth`.

Política "negar por padrão":
    - Se `flask.g.current_user` não existir (ninguém autenticou a
      requisição ainda, ou `require_auth` não foi aplicado), responde 401.
    - Se o usuário autenticado existir, mas não possuir a
      permissão/papel exigido, responde 403.
    - Em ambos os casos a resposta é o JSON padronizado de `app.errors`,
      sem detalhes internos.

Padrão recomendado para endpoints administrativos críticos:
    Operações sensíveis (ex.: confirmar a execução de uma importação de
    dados) devem exigir tanto o PAPEL `ADM` quanto a PERMISSÃO granular
    específica da operação (ex.: `imports.execute`), combinando os dois
    decorators abaixo. Checar apenas a permissão granular não é
    suficiente para esses casos, pois permissões podem no futuro ser
    atribuídas a outros papéis; exigir explicitamente `require_role("ADM")`
    garante que a operação continue restrita ao perfil administrativo
    mesmo que a matriz de permissões mude. Exemplo:

        @app.route("/api/v1/imports/<id>/confirm", methods=["POST"])
        @require_auth
        @require_role("ADM")
        @require_permission("imports.execute")
        def confirmar_importacao(id):
            ...

    Este é o padrão a ser replicado por outros endpoints administrativos
    igualmente sensíveis.

Padrão recomendado para QUALQUER rota administrativa CRÍTICA (convites de
usuário, gestão de usuários, operações de segurança como remoção de fator
MFA): a pilha de decorators deve ser, nesta ordem exata:

    @app.route(...)
    @require_auth
    @require_role("ADM")
    @require_aal2
    @require_permission("<recurso>.<ação>")
    def view(...):
        ...

`require_auth` resolve quem é o usuário e qual o AAL da sessão atual;
`require_role("ADM")` restringe ao perfil administrativo; `require_aal2`
garante que a sessão já completou o desafio de segundo fator (MFA) ANTES de
permitir a operação — nunca confiar em uma flag vinda do frontend para isso
(ver `app.api.v1.me`, que apenas INFORMA o AAL atual ao frontend, sem
autorizar nada); e `require_permission(...)` aplica a checagem granular
final. Pular `require_aal2` em uma rota administrativa crítica é um erro de
segurança — mesmo que o usuário já tenha o papel e a permissão corretos, uma
sessão que ainda não completou o MFA não deve conseguir executar a
operação.
"""
from __future__ import annotations

import logging
import uuid
from functools import wraps
from typing import Any, Callable, TypeVar

from flask import abort, g, jsonify, request
from sqlalchemy import false

from app.authorization.security_events import (
    EVENT_AAL2_REQUIRED,
    EVENT_ACCESS_DENIED,
    EVENT_UNIT_SCOPE_DENIED,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    record_security_event,
)
from app.database.session import get_db_session
from app.models.units import UserUnitAccess

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


def _require_current_user() -> Any:
    """Retorna o usuário autenticado em `flask.g.current_user`, ou aborta com 401."""
    user = getattr(g, "current_user", None)
    if user is None:
        logger.info("Checagem de autorização sem usuário autenticado em flask.g (require_auth não executou?).")
        abort(401)
    return user


def require_permission(permission_code: str) -> Callable[[F], F]:
    """Decorator-factory: exige que o usuário atual possua `permission_code`.

    Deve ser usado depois de `@require_auth` (mais interno na pilha de
    decorators — ver docstring do módulo e de `require_auth`).
    """

    def decorator(view_func: F) -> F:
        @wraps(view_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            user = _require_current_user()
            permissions = getattr(g, "current_user_permissions", set())
            if permission_code not in permissions:
                logger.info(
                    "Usuário %s sem a permissão '%s'; acesso negado.",
                    getattr(user, "id", "?"),
                    permission_code,
                )
                record_security_event(
                    EVENT_ACCESS_DENIED,
                    severity=SEVERITY_MEDIUM,
                    actor_user_id=getattr(user, "id", None),
                    details={"reason": "missing_permission", "required": permission_code},
                )
                abort(403)
            return view_func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def require_role(*role_codes: str) -> Callable[[F], F]:
    """Decorator-factory: exige que o usuário atual possua ao menos um dos papéis em `role_codes`.

    Uso recomendado: operações administrativas tão sensíveis que a checagem
    de permissão granular isolada não é suficiente (ver docstring do
    módulo) — combine com `require_permission(...)` nesses casos.
    """

    def decorator(view_func: F) -> F:
        @wraps(view_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            user = _require_current_user()
            user_roles = getattr(g, "current_user_roles", set())
            if not user_roles.intersection(role_codes):
                logger.info(
                    "Usuário %s sem nenhum dos papéis exigidos %s; acesso negado.",
                    getattr(user, "id", "?"),
                    role_codes,
                )
                record_security_event(
                    EVENT_ACCESS_DENIED,
                    severity=SEVERITY_MEDIUM,
                    actor_user_id=getattr(user, "id", None),
                    details={"reason": "missing_role", "required": sorted(role_codes)},
                )
                abort(403)
            return view_func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def require_aal2(view_func: F) -> F:
    """Decorator: exige que a sessão atual já tenha completado o desafio MFA
    (AAL2 — Authenticator Assurance Level 2), lendo
    `flask.g.current_session_aal` (populado por
    `app.auth.supabase_auth.require_auth` a partir do claim `aal` do JWT do
    Supabase Auth).

    Deve ser usado DEPOIS de `@require_auth` na pilha de decorators (mais
    interno) — ver docstring do módulo para a ordem completa recomendada em
    rotas administrativas críticas:

        @require_auth
        @require_role("ADM")
        @require_aal2
        @require_permission(...)

    Se `flask.g.current_user` não existir, responde 401 (mesma política
    "negar por padrão" dos demais decorators deste módulo).

    Se a sessão não estiver em `aal2` (seja porque o usuário nunca
    completou o desafio MFA na sessão atual, seja porque o claim `aal`
    estava ausente do JWT — tratado como `aal1`, nunca como `aal2`; ver
    `app.auth.supabase_auth._extract_session_aal`), responde 403 com um
    corpo de erro ESPECÍFICO e distinguível do 403 genérico de
    permissão/papel insuficiente:

        {"error": {"code": "AAL2_REQUIRED", "message": "..."}}

    Esse código customizado (`AAL2_REQUIRED`) permite ao frontend
    diferenciar duas situações bem distintas que, de outra forma, dariam o
    mesmo HTTP 403 genérico de `app.errors`:
        - "você não tem permissão/papel para isso" (403 genérico, código
          padrão `forbidden`) -> não há nada que o usuário possa fazer além
          de pedir acesso a um administrador;
        - "você tem permissão, mas sua sessão precisa completar o desafio
          MFA antes" (este 403, código `AAL2_REQUIRED`) -> o frontend deve
          rotear o usuário para a tela de desafio MFA (ou cadastro de MFA,
          se ainda não tiver fator nenhum) e, após sucesso, repetir a
          requisição original com a nova sessão (agora em aal2).

    Esta resposta é construída diretamente aqui (em vez de `flask.abort`)
    porque os handlers padronizados de `app.errors` não propagam um `code`
    customizado para `HTTPException.description` — este módulo não foi
    incluído no escopo de alteração de `app.errors` nesta fase.
    """

    @wraps(view_func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        user = _require_current_user()
        current_aal = getattr(g, "current_session_aal", "aal1")
        if current_aal != "aal2":
            logger.info(
                "Usuário %s com sessão em AAL '%s' (!= aal2); operação administrativa "
                "bloqueada até a conclusão do desafio MFA.",
                getattr(user, "id", "?"),
                current_aal,
            )
            record_security_event(
                EVENT_AAL2_REQUIRED,
                severity=SEVERITY_LOW,
                actor_user_id=getattr(user, "id", None),
                details={"current_aal": current_aal},
            )
            response = jsonify(
                {
                    "error": {
                        "code": "AAL2_REQUIRED",
                        "message": (
                            "Esta operação exige que a sessão tenha completado a "
                            "verificação em duas etapas (MFA)."
                        ),
                    }
                }
            )
            response.status_code = 403
            return response
        return view_func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _normalize_uuid(value: Any) -> uuid.UUID | None:
    """Converte `value` em `uuid.UUID`; retorna `None` se inválido (negar por padrão)."""
    if isinstance(value, uuid.UUID):
        return value
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


def has_unit_access(user: Any, unit_id: uuid.UUID | str) -> bool:
    """Verifica se `user` possui acesso explícito à unidade `unit_id`.

    Consulta a tabela `user_unit_access`. NÃO há bypass para `ADM` (ver
    `docs/permissions/matriz-permissoes.md`, princípio 3): todo perfil só
    opera sobre as unidades explicitamente vinculadas.

    Negar por padrão: usuário ausente/inativo, ou `unit_id` que não seja um
    UUID válido, resultam em `False` SEM consultar o banco — e o resultado
    para "unidade inexistente" e "unidade fora do escopo" é idêntico
    (`False`), evitando enumeração de unidades.
    """
    if user is None or getattr(user, "id", None) is None:
        return False
    if getattr(user, "active", True) is False:
        return False
    normalized_unit_id = _normalize_uuid(unit_id)
    if normalized_unit_id is None:
        return False
    with get_db_session() as db:
        link = (
            db.query(UserUnitAccess)
            .filter(
                UserUnitAccess.user_id == user.id,
                UserUnitAccess.unit_id == normalized_unit_id,
            )
            .first()
        )
        return link is not None


def get_accessible_unit_ids(user_id: Any, db: Any) -> set[uuid.UUID]:
    """Retorna o conjunto de `unit_id` às quais `user_id` tem acesso.

    Recebe a sessão do chamador (`db`) para reaproveitar a transação. Base
    para filtros de listagem com escopo de unidade (ver `apply_unit_scope`).
    """
    if user_id is None:
        return set()
    rows = db.query(UserUnitAccess.unit_id).filter(UserUnitAccess.user_id == user_id).all()
    accessible: set[uuid.UUID] = set()
    for row in rows:
        value = row[0] if isinstance(row, tuple) else getattr(row, "unit_id", row)
        normalized = _normalize_uuid(value)
        if normalized is not None:
            accessible.add(normalized)
    return accessible


def units_outside_scope(user_id: Any, unit_ids: list[Any], db: Any) -> list[str]:
    """Retorna os `unit_ids` (como string) que NÃO estão no escopo de `user_id`.

    Usado, por exemplo, para impedir que um `ADM` conceda (via convite)
    acesso a unidades que ele próprio não administra. Unidades inexistentes
    também aparecem como "fora do escopo" (mesma resposta, sem enumeração).
    """
    accessible = get_accessible_unit_ids(user_id, db)
    outside: list[str] = []
    for raw in unit_ids:
        normalized = _normalize_uuid(raw)
        if normalized is None or normalized not in accessible:
            outside.append(str(raw))
    return outside


def apply_unit_scope(query: Any, unit_column: Any, user_id: Any, db: Any) -> Any:
    """Restringe `query` às linhas cuja `unit_column` esteja no escopo do usuário.

    Uso previsto pelos futuros endpoints patrimoniais (listagens, relatórios,
    exportações), para que o filtro de unidade seja aplicado NO BANCO e não
    em memória:

        query = apply_unit_scope(db.query(Asset), Asset.unit_id, user.id, db)

    Escopo vazio resulta em consulta vazia (negar por padrão), nunca em
    "sem filtro".
    """
    accessible = get_accessible_unit_ids(user_id, db)
    if not accessible:
        return query.filter(false())
    return query.filter(unit_column.in_(sorted(accessible, key=str)))


def require_unit_access(
    unit_id_arg: str = "unit_id",
    *,
    source: str = "view_args",
    deny_status: int = 403,
) -> Callable[[F], F]:
    """Decorator-factory: exige que o usuário atual tenha acesso à unidade
    identificada por `unit_id_arg` (escopo por unidade / anti-IDOR).

    `source`:
        - "view_args" (padrão): parâmetro de rota (ex.: `/units/<uuid:unit_id>/...`);
        - "json": campo do corpo JSON;
        - "args": parâmetro de query string.

    Deve ser usado DEPOIS de `@require_auth` (e dos decorators de papel/
    permissão). Unidade inexistente, inválida ou fora do escopo produzem a
    MESMA resposta (`deny_status`, 403 por padrão), sem diferenças que
    permitam enumeração, e o evento é registrado em `audit_logs`.
    """
    if source not in ("view_args", "json", "args"):
        raise ValueError(f"source inválido: {source!r}")

    def decorator(view_func: F) -> F:
        @wraps(view_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            user = _require_current_user()
            if source == "view_args":
                raw_unit_id = kwargs.get(unit_id_arg)
            elif source == "json":
                body = request.get_json(silent=True)
                raw_unit_id = body.get(unit_id_arg) if isinstance(body, dict) else None
            else:
                raw_unit_id = request.args.get(unit_id_arg)

            if not has_unit_access(user, raw_unit_id):
                logger.info(
                    "Usuário %s sem acesso à unidade solicitada; acesso negado.",
                    getattr(user, "id", "?"),
                )
                record_security_event(
                    EVENT_UNIT_SCOPE_DENIED,
                    severity=SEVERITY_MEDIUM,
                    actor_user_id=getattr(user, "id", None),
                    target_type="unit",
                    target_id=raw_unit_id if isinstance(raw_unit_id, (str, uuid.UUID)) else None,
                )
                abort(deny_status)
            return view_func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator
