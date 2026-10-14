"""Verificação de autenticação via JWT do Supabase Auth.

Fluxo:
    1. Lê o header `Authorization: Bearer <token>` da requisição.
    2. Decodifica/verifica a assinatura do JWT com PyJWT, usando o segredo
       HS256 configurado em `settings.supabase_jwt_secret`, exigindo os
       claims `exp`, `iat`, `sub`, `aud` (= `SUPABASE_JWT_AUDIENCE`), `iss`
       (quando configurado/derivável de `SUPABASE_URL`) e `role ==
       "authenticated"` (rejeita chaves `anon`/`service_role`), com
       tolerância de relógio `JWT_LEEWAY_SECONDS` (ver `_decode_supabase_jwt`).
    3. Extrai o claim `sub` (o `auth_user_id` do Supabase Auth) e busca o
       usuário correspondente na tabela `users` (`User.auth_user_id`),
       carregando também seus papéis (`roles`) e permissões
       (`permissions`), via `user_roles -> roles -> role_permissions ->
       permissions`.
    4. Em caso de sucesso, popula em `flask.g`:
           g.current_user              -> instância `app.models.rbac.User`
           g.current_user_roles        -> set[str] com `Role.code` (papéis ativos)
           g.current_user_permissions  -> set[str] com `Permission.code`
           g.current_user_claims       -> dict com os claims decodificados do JWT
           g.current_session_aal       -> "aal1" | "aal2" (ver abaixo)
    5. Qualquer falha (token ausente/inválido/expirado, usuário inexistente
       ou inativo) resulta em 401, com corpo JSON padronizado (ver
       `app.errors`), SEM detalhes internos. O token completo NUNCA é
       logado; no máximo o tipo/causa do erro de verificação. Falhas com
       token presente são registradas como evento `AUTH_FAILED` em
       `audit_logs` (ver `app.authorization.security_events`); a ausência
       do header apenas é logada (evita amplificação de escrita).

AAL (Authenticator Assurance Level) — `flask.g.current_session_aal`:
    O Supabase GoTrue inclui no JWT da sessão o claim `aal`, uma STRING
    (`"aal1"` ou `"aal2"`) que indica se a sessão atual já completou um
    desafio de segundo fator (MFA/TOTP). O backend NUNCA gerencia segredos
    TOTP — isso é responsabilidade exclusiva do Supabase Auth — mas DEVE
    ler esse claim para decidir, no próprio backend, se uma operação
    administrativa sensível pode ou não ser executada (ver
    `app.authorization.rbac.require_aal2`).

    Política fail-safe: se o claim `aal` estiver ausente do JWT (por
    exemplo, tokens antigos emitidos antes da ativação de MFA no projeto,
    ou qualquer formato inesperado), assume-se `"aal1"` — o nível MAIS
    BAIXO de garantia — NUNCA `"aal2"`. Confiar em uma ausência de claim
    como se fosse `aal2` abriria uma brecha de segurança (um token sem
    esse claim passaria por uma checagem que exige segundo fator). O
    frontend NUNCA decide isso por conta própria; esta leitura no backend,
    a partir do JWT assinado pelo Supabase, é a única fonte de verdade.

LIMITAÇÃO DOCUMENTADA — HS256 (segredo legado) vs. JWKS/RS256:
    Esta implementação assume que o projeto Supabase ainda usa o esquema
    "legado" de assinatura simétrica HS256, com um único segredo
    compartilhado (`SUPABASE_JWT_SECRET`, disponível em
    Project Settings > API > JWT Settings no painel do Supabase).

    Projetos Supabase mais novos podem ter migrado para assinatura
    assimétrica (RS256/ES256) com rotação de chaves via JWKS, publicado em
    `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. Se
    for o caso deste projeto, a verificação aqui PRECISARÁ ser adaptada
    para: (a) ler o `kid` do header do JWT; (b) buscar (e cachear,
    idealmente com TTL e invalidação por `kid` desconhecido) a chave
    pública correspondente nesse endpoint JWKS; (c) verificar a assinatura
    com essa chave pública em vez do segredo HS256 fixo. Essa adaptação é
    uma pendência conhecida, fora do escopo desta fase — NÃO implementada
    aqui.
"""
from __future__ import annotations

import logging
from functools import wraps
from typing import Any, Callable, TypeVar

import jwt
from flask import abort, g, request
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.authorization.security_events import (
    EVENT_AUTH_FAILED,
    SEVERITY_LOW,
    record_security_event,
)
from app.config.settings import get_settings
from app.database.session import get_db_session
from app.models.rbac import Role, RolePermission, User, UserRole

logger = logging.getLogger(__name__)

_AUTH_HEADER_PREFIX = "Bearer "

# Limite de tamanho do token (defesa contra cabeçalhos gigantes).
_MAX_TOKEN_LENGTH = 8192

# Único valor aceito para o claim `role` (obrigatório) — tokens de
# usuário final do Supabase Auth. `anon`/`service_role` são rejeitados.
_EXPECTED_TOKEN_ROLE = "authenticated"

# Nível de garantia de autenticação (AAL) assumido quando o claim `aal` do
# JWT está ausente ou em formato inesperado — sempre o mais baixo (fail-safe,
# ver docstring do módulo). NUNCA alterar para "aal2".
_DEFAULT_AAL = "aal1"

F = TypeVar("F", bound=Callable[..., Any])


def _extract_session_aal(claims: dict[str, Any]) -> str:
    """Extrai o claim `aal` dos claims do JWT, com fallback fail-safe para `aal1`.

    O Supabase GoTrue emite `aal` como string (`"aal1"` ou `"aal2"`). Qualquer
    valor que não seja exatamente `"aal2"` é tratado como `"aal1"` — isso
    inclui o claim ausente, `None`, ou qualquer outro tipo/valor inesperado.
    """
    aal = claims.get("aal")
    if aal == "aal2":
        return "aal2"
    return _DEFAULT_AAL


def _decode_supabase_jwt(token: str, settings: Any) -> dict[str, Any]:
    """Decodifica e valida o JWT do Supabase Auth.

    Validações (todas obrigatórias):
        - assinatura HS256 com `SUPABASE_JWT_SECRET` (somente HS256 — impede
          `alg=none`/confusão de algoritmo);
        - presença de `exp`, `iat`, `sub` e `aud` (`options.require`);
        - `exp`/`iat` com tolerância de relógio `JWT_LEEWAY_SECONDS`;
        - `aud == SUPABASE_JWT_AUDIENCE` (padrão "authenticated");
        - `iss == SUPABASE_JWT_ISSUER` (ou `<SUPABASE_URL>/auth/v1`), quando
          configurado/derivável.
    Levanta `jwt.PyJWTError` em qualquer falha.
    """
    issuer = settings.supabase_jwt_expected_issuer
    required_claims = ["exp", "iat", "sub", "aud"]
    if issuer:
        required_claims.append("iss")
    decode_kwargs: dict[str, Any] = {
        "algorithms": ["HS256"],
        "audience": settings.supabase_jwt_audience,
        "leeway": settings.jwt_leeway_seconds,
        "options": {"require": required_claims},
    }
    if issuer:
        decode_kwargs["issuer"] = issuer
    return jwt.decode(token, settings.supabase_jwt_secret, **decode_kwargs)


def _auth_failed(reason: str, actor_user_id: Any = None) -> None:
    """Registra a falha de autenticação (sem token) e responde 401."""
    record_security_event(
        EVENT_AUTH_FAILED,
        severity=SEVERITY_LOW,
        actor_user_id=actor_user_id,
        details={"reason": reason},
    )
    abort(401)


def _extract_bearer_token() -> str | None:
    """Extrai o token do header `Authorization: Bearer <token>`, se presente."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith(_AUTH_HEADER_PREFIX):
        return None
    token = auth_header[len(_AUTH_HEADER_PREFIX) :].strip()
    return token or None


def _load_user_with_roles_and_permissions(
    auth_user_id: str,
) -> tuple[User, set[str], set[str]] | None:
    """Carrega o `User` (por `auth_user_id`) e os códigos de papéis/permissões.

    Usa `selectinload` para carregar, em uma única sessão,
    `user_roles -> roles -> role_permissions -> permissions`, evitando
    lazy-loading após o encerramento da sessão (o que geraria
    `DetachedInstanceError`, já que a sessão é fechada ao final do
    `with get_db_session()`).

    Retorna `None` se nenhum usuário com esse `auth_user_id` existir.
    """
    with get_db_session() as db:
        stmt = (
            select(User)
            .where(User.auth_user_id == auth_user_id)
            .options(
                selectinload(User.role_links)
                .selectinload(UserRole.role)
                .selectinload(Role.permission_links)
                .selectinload(RolePermission.permission)
            )
        )
        user = db.execute(stmt).scalar_one_or_none()
        if user is None:
            return None

        role_codes: set[str] = set()
        permission_codes: set[str] = set()
        for user_role in user.role_links:
            role = user_role.role
            if role is None or not role.active:
                continue
            role_codes.add(role.code)
            for role_permission in role.permission_links:
                permission = role_permission.permission
                if permission is not None:
                    permission_codes.add(permission.code)

        return user, role_codes, permission_codes


def require_auth(view_func: F) -> F:
    """Decorator que exige um JWT Supabase válido no header `Authorization`.

    Em caso de sucesso, popula `flask.g.current_user`,
    `flask.g.current_user_roles` e `flask.g.current_user_permissions` (ver
    docstring do módulo) e então chama a view normalmente.

    Em caso de falha (token ausente, assinatura/expiração inválida, usuário
    não encontrado ou `active=False`), responde 401 via `flask.abort`, que é
    tratado pelos handlers padronizados em `app.errors` — nenhum detalhe
    interno é exposto ao cliente.

    ORDEM DOS DECORATORS: `require_auth` deve ser o decorator mais EXTERNO
    em relação aos decorators de autorização de `app.authorization.rbac`
    (`require_permission`, `require_role`), pois estes dependem dos valores
    de `flask.g` definidos aqui. Como decorators Python se aplicam de baixo
    para cima na definição mas executam de fora para dentro na chamada,
    o uso correto é:

        @app.route(...)
        @require_auth
        @require_permission("assets.read")
        def view(...):
            ...

    (ou seja, `require_auth` listado ANTES/ACIMA dos decorators de
    autorização na pilha de decorators da view).
    """

    @wraps(view_func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        settings = get_settings()

        token = _extract_bearer_token()
        if not token:
            logger.info("Acesso negado: header Authorization ausente ou mal-formado.")
            abort(401)

        if not settings.supabase_jwt_secret:
            # Falha de configuração do servidor, não do cliente — ainda
            # assim respondemos 401 genérico, sem expor que é um problema
            # de configuração (não é um detalhe que o cliente deva saber).
            logger.error(
                "SUPABASE_JWT_SECRET não configurado; verificação de JWT indisponível."
            )
            abort(401)

        if len(token) > _MAX_TOKEN_LENGTH:
            logger.info("Token JWT rejeitado (tamanho acima do limite).")
            _auth_failed("token_too_large")

        try:
            claims = _decode_supabase_jwt(token, settings)
        except jwt.PyJWTError as exc:
            # Nunca logar o token em si — apenas a classe do erro.
            logger.info("Token JWT rejeitado (%s).", exc.__class__.__name__)
            _auth_failed(f"invalid_token:{exc.__class__.__name__}")

        auth_user_id = claims.get("sub")
        if not isinstance(auth_user_id, str) or not auth_user_id or len(auth_user_id) > 255:
            logger.info("Token JWT válido, porém sem claim 'sub' utilizável.")
            _auth_failed("invalid_sub")

        # Tokens de chave de API do Supabase (`anon`/`service_role`) e de
        # outros papéis do Postgres NUNCA representam um usuário final.
        if claims.get("role") != _EXPECTED_TOKEN_ROLE:
            logger.info("Token JWT com claim 'role' inesperado; acesso negado.")
            _auth_failed("unexpected_role_claim")

        loaded = _load_user_with_roles_and_permissions(auth_user_id)
        if loaded is None:
            logger.info("Usuário autenticado no Supabase sem registro correspondente em 'users'.")
            _auth_failed("unknown_user")

        user, role_codes, permission_codes = loaded
        if not user.active:
            logger.info("Usuário %s está inativo (active=False); acesso negado.", user.id)
            _auth_failed("inactive_user", actor_user_id=getattr(user, "id", None))

        g.current_user = user
        g.current_user_roles = role_codes
        g.current_user_permissions = permission_codes
        g.current_user_claims = claims
        g.current_session_aal = _extract_session_aal(claims)

        return view_func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]
