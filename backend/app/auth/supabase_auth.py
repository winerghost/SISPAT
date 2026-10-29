"""Verificação de autenticação via JWT do Supabase Auth.

Fluxo:
    1. Lê o header `Authorization: Bearer <token>` da requisição.
    2. Decodifica/verifica a assinatura do JWT com PyJWT, usando o segredo
       HS256 (`settings.supabase_jwt_secret`) ou o JWKS ES256, exigindo os
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

USUÁRIO EXCLUÍDO (`users.deleted_at`, migração 0019):
    A exclusão de usuário é LÓGICA + anonimização (ver
    `app.services.user_deletion_service`): a linha permanece em `users`
    porque o `audit_logs.actor_user_id` dela é preservado. `require_auth`
    recusa com 401 (evento `AUTH_FAILED`, motivo `deleted_user`) qualquer JWT
    de usuário com `deleted_at` preenchido — do mesmo modo que já recusa
    `active=False` e sessão anterior à revogação. A consulta de usuário
    também filtra `deleted_at IS NULL`.

SESSÕES REVOGADAS (`users.sessions_revoked_at`, AUD-14-08):
    Depois de carregar o usuário, `require_auth` rejeita com 401 (evento
    `AUTH_FAILED`, motivo `session_revoked`) todo JWT emitido ANTES da
    revogação — ver `session_predates_revocation`. O `iat` do JWT tem
    precisão de SEGUNDOS e `sessions_revoked_at` tem microssegundos; para a
    decisão ser determinística, compara-se com o segundo truncado da
    revogação e o token emitido NO MESMO SEGUNDO também é rejeitado
    (`iat <= floor(revogação)`): falha fechada, ao custo de exigir novo
    login de quem entrou na mesma fração de segundo da revogação.
    Defesa contra refresh (UA-SESS-01/02): um refresh do Supabase gera
    access token com `iat` novo, mas preserva o claim `amr` (métodos e
    instantes da autenticação da sessão). Com `sessions_revoked_at`
    preenchido, o token só é aceito se `iat > corte` E o `amr` for
    bem-formado (todas as entradas válidas) com o MENOR instante > corte,
    ou seja, TODA a autenticação da sessão é posterior à revogação. Um TOTP
    re-verificado (ou um fator novo cadastrado) numa sessão antiga acrescenta
    uma entrada recente, mas o primeiro fator continua anterior => 401.
    `amr` ausente ou malformado => sessão tratada como revogada (falha
    fechada). Um login novo tem todos os instantes após o corte => aceito.

CLAIM `amr` (suposição documentada, validar em homologação):
    O GoTrue emite `amr` como LISTA de objetos `{"method": str,
    "timestamp": int}` (ex.: `[{"method": "password", "timestamp": ...},
    {"method": "totp", "timestamp": ...}]`), em segundos Unix. Qualquer
    outro formato (string, lista de strings estilo RFC 8176, timestamp não
    numérico/booleano, lista gigante) é tratado como "sem informação":
    `has_recent_totp` responde False (falha fechada).

ALGORITMOS (HS256 legado + ES256/JWKS):
    Ver `_decode_supabase_jwt` e `app.auth.jwks`. O projeto atual assina com
    ES256 (JWKS público). O segredo HS256 legado continua aceito enquanto
    `SUPABASE_JWT_ALGORITHMS` incluir HS256; para eliminá-lo, defina
    `SUPABASE_JWT_ALGORITHMS=ES256` e revogue o segredo no Supabase.
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timezone
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
from app.auth.jwks import get_signing_key
from app.config.settings import get_settings
from app.database.session import get_db_session
from app.models.rbac import Role, RolePermission, User, UserRole

logger = logging.getLogger(__name__)

_AUTH_HEADER_PREFIX = "Bearer "

# Allowlist fixa de algoritmos (nunca "none"; nunca vinda do cliente).
_ALLOWED_ALGORITHMS = frozenset({"HS256", "ES256"})

# Limite de tamanho do token (defesa contra cabeçalhos gigantes).
_MAX_TOKEN_LENGTH = 8192

# Único valor aceito para o claim `role` (obrigatório) — tokens de
# usuário final do Supabase Auth. `anon`/`service_role` são rejeitados.
_EXPECTED_TOKEN_ROLE = "authenticated"

# Nível de garantia de autenticação (AAL) assumido quando o claim `aal` do
# JWT está ausente ou em formato inesperado — sempre o mais baixo (fail-safe,
# ver docstring do módulo). NUNCA alterar para "aal2".
_DEFAULT_AAL = "aal1"

# Limite defensivo de entradas lidas do claim `amr`.
_MAX_AMR_ENTRIES = 20

F = TypeVar("F", bound=Callable[..., Any])


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def amr_entries(claims: dict[str, Any]) -> list[tuple[str, float]]:
    """Entradas BEM-FORMADAS do claim `amr` como `(method, timestamp)`.

    Entradas malformadas são descartadas; formato inesperado do claim (não
    lista, lista grande demais) => lista vazia. Ver docstring do módulo.
    """
    amr = claims.get("amr")
    if not isinstance(amr, list) or len(amr) > _MAX_AMR_ENTRIES:
        return []
    entries: list[tuple[str, float]] = []
    for item in amr:
        if not isinstance(item, dict):
            continue
        method = item.get("method")
        timestamp = item.get("timestamp")
        if isinstance(method, str) and 0 < len(method) <= 64 and _is_number(timestamp):
            entries.append((method, float(timestamp)))
    return entries


def has_recent_totp(
    claims: dict[str, Any],
    *,
    max_age_seconds: int = 300,
    now: float | None = None,
    future_skew_seconds: int = 30,
) -> bool:
    """True se a sessão verificou TOTP há no máximo `max_age_seconds`.

    Exige uma entrada `{"method": "totp", "timestamp": t}` com
    `agora - max_age <= t <= agora + future_skew`. Qualquer outra situação
    (claim ausente, formato inesperado, só `password`, TOTP antigo ou
    "no futuro") => False (falha fechada).
    """
    current = time.time() if now is None else now
    for method, timestamp in amr_entries(claims):
        if method != "totp":
            continue
        if current - max_age_seconds <= timestamp <= current + future_skew_seconds:
            return True
    return False


def _to_utc_timestamp(value: datetime) -> float:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _strict_amr_timestamps(claims: dict[str, Any]) -> list[float] | None:
    """Instantes do `amr` SÓ se TODAS as entradas forem bem-formadas; senão None."""
    amr = claims.get("amr")
    if not isinstance(amr, list) or not amr or len(amr) > _MAX_AMR_ENTRIES:
        return None
    entries = amr_entries(claims)
    if len(entries) != len(amr):
        return None
    return [timestamp for _method, timestamp in entries]


def session_predates_revocation(claims: dict[str, Any], revoked_at: datetime | None) -> bool:
    """True se o JWT pertence a uma sessão anterior a `revoked_at` (=> 401).

    Regra (ver docstring do módulo): corte = segundo truncado de
    `revoked_at`; aceita só se `iat > corte` e o `amr` for bem-formado com
    o MENOR instante > corte. Qualquer outro caso => True (falha fechada).
    """
    if revoked_at is None:
        return False
    if not isinstance(revoked_at, datetime):
        return True  # valor inesperado no banco: falha fechada
    cutoff = math.floor(_to_utc_timestamp(revoked_at))
    iat = claims.get("iat")
    if not _is_number(iat) or iat <= cutoff:
        return True
    auth_times = _strict_amr_timestamps(claims)
    if auth_times is None:
        return True
    return min(auth_times) <= cutoff


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
    """Decodifica e valida o JWT do Supabase Auth (HS256 legado ou ES256/JWKS).

    O header é NÃO CONFIÁVEL: `alg` é despachado de forma estrita por
    allowlist fixa {HS256, ES256} (interseção com
    `SUPABASE_JWT_ALGORITHMS`). HS256 só verifica com `SUPABASE_JWT_SECRET`;
    ES256 só com a chave pública do JWKS localizada por `kid`. Nunca se usa
    uma chave de um tipo para o outro (algorithm confusion); `none` e
    qualquer outro `alg` são rejeitados.

    Validações (todas obrigatórias): assinatura; `exp`/`iat`/`sub`/`aud`
    (`options.require`); `exp`/`iat` com `JWT_LEEWAY_SECONDS`;
    `aud == SUPABASE_JWT_AUDIENCE`; `iss` esperado quando derivável.
    Levanta `jwt.PyJWTError` em qualquer falha.
    """
    header = jwt.get_unverified_header(token)  # só lê; não confia
    alg = header.get("alg")
    if not isinstance(alg, str) or alg not in _ALLOWED_ALGORITHMS:
        raise jwt.InvalidAlgorithmError("algorithm not allowed")
    if alg not in settings.supabase_jwt_algorithms_list:
        raise jwt.InvalidAlgorithmError("algorithm disabled")

    if alg == "HS256":
        if not settings.supabase_jwt_secret:
            raise jwt.InvalidAlgorithmError("hs256 not configured")
        key: Any = settings.supabase_jwt_secret
    else:  # ES256
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid or len(kid) > 128:
            raise jwt.InvalidTokenError("missing kid")
        key = get_signing_key(kid, settings)

    issuer = settings.supabase_jwt_expected_issuer
    required_claims = ["exp", "iat", "sub", "aud"]
    if issuer:
        required_claims.append("iss")
    decode_kwargs: dict[str, Any] = {
        "algorithms": [alg],
        "audience": settings.supabase_jwt_audience,
        "leeway": settings.jwt_leeway_seconds,
        "options": {"require": required_claims},
    }
    if issuer:
        decode_kwargs["issuer"] = issuer
    return jwt.decode(token, key, **decode_kwargs)


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
            # NÃO se filtra `deleted_at` aqui DE PROPÓSITO: a linha é
            # carregada para que a negação seja auditada com o motivo exato
            # (`deleted_user`, em `require_auth`), e não como `unknown_user`.
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

        algs = settings.supabase_jwt_algorithms_list
        hs_ok = "HS256" in algs and bool(settings.supabase_jwt_secret)
        es_ok = "ES256" in algs and bool(settings.supabase_jwks_effective_url)
        if not (hs_ok or es_ok):
            # Falha de configuração do servidor, não do cliente — ainda
            # assim respondemos 401 genérico, sem expor que é um problema
            # de configuração (não é um detalhe que o cliente deva saber).
            logger.error(
                "Nem SUPABASE_JWT_SECRET (HS256) nem JWKS (ES256) configurados; "
                "verificação de JWT indisponível."
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
            _auth_failed(
                getattr(exc, "audit_reason", None) or f"invalid_token:{exc.__class__.__name__}"
            )

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
        # Usuário logicamente EXCLUÍDO (migração 0019) nunca autentica: a
        # linha continua existindo (a trilha de `audit_logs` dele é
        # preservada), mas a conta deixou de existir para a API. Checado
        # ANTES de `active`. Na prática a anonimização também apaga
        # `auth_user_id` (a consulta acima nem casa e a resposta é 401
        # `unknown_user`); esta checagem é a que vale para QUALQUER linha com
        # `deleted_at` preenchido — sem ela um JWT ainda válido entraria.
        if getattr(user, "deleted_at", None) is not None:
            logger.info("Usuário %s está excluído (deleted_at); acesso negado.", user.id)
            _auth_failed("deleted_user", actor_user_id=getattr(user, "id", None))

        if not user.active:
            logger.info("Usuário %s está inativo (active=False); acesso negado.", user.id)
            _auth_failed("inactive_user", actor_user_id=getattr(user, "id", None))

        if session_predates_revocation(claims, getattr(user, "sessions_revoked_at", None)):
            logger.info("Usuário %s com JWT anterior à revogação de sessões; acesso negado.", user.id)
            _auth_failed("session_revoked", actor_user_id=getattr(user, "id", None))

        g.current_user = user
        g.current_user_roles = role_codes
        g.current_user_permissions = permission_codes
        g.current_user_claims = claims
        g.current_session_aal = _extract_session_aal(claims)

        return view_func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]
