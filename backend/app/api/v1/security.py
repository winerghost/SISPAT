"""Endpoints de segurança relacionados a MFA (`/api/v1/security/...`).

`DELETE /api/v1/security/mfa/factors/<factor_id>`:
    Permite que o PRÓPRIO usuário autenticado remova um dos seus fatores
    MFA cadastrados no Supabase Auth. A remoção efetiva é sempre feita pelo
    backend, via `app.integrations.supabase_admin_client.SupabaseAdminClient`
    (Service Role Key) — NUNCA diretamente do frontend via SDK do Supabase
    — justamente para poder aplicar aqui a regra de negócio "um
    administrador (papel `ADM`) não pode remover unilateralmente seu único
    fator MFA ativo" (política obrigatória de MFA para `ADM`).

    Requer `require_auth` + `require_aal2`: a própria sessão que está
    removendo o fator precisa já ter completado o desafio MFA (estar em
    `aal2`) — não basta estar autenticado em `aal1`. Isso evita que uma
    sessão que nunca passou pelo MFA (ex.: um token roubado antes do
    primeiro desafio) possa desabilitar o MFA da conta.

ESCOPO E PENDÊNCIA DOCUMENTADA — autorremoção vs. recuperação administrativa:
    Este endpoint cobre APENAS o caso em que o usuário gerencia seus
    PRÓPRIOS fatores MFA (`auth_user_id` da sessão autenticada). A remoção
    de um fator MFA de OUTRO usuário, por um administrador, em nome de um
    procedimento de recuperação (ex.: o usuário perdeu o dispositivo TOTP e
    não consegue mais fazer login), é uma funcionalidade DIFERENTE e FORA
    do escopo exato deste endpoint — ela exigiria uma rota/fluxo
    administrativo próprio (algo como
    `POST /api/v1/security/users/<user_id>/mfa/factors/<factor_id>/revoke`,
    com seu próprio rate limiting, auditoria e, possivelmente, confirmação
    adicional), explicitamente NÃO implementada nesta rodada. O cliente
    `SupabaseAdminClient.list_mfa_factors`/`delete_mfa_factor` já suporta
    operar sobre qualquer `auth_user_id`, portanto esse fluxo de
    recuperação assistida pode ser construído por cima dele numa próxima
    rodada, sem alterações no cliente — apenas um novo endpoint/rota com
    sua própria checagem de autorização (tipicamente `require_role("ADM")`
    + `require_aal2` do PRÓPRIO administrador que está executando a
    recuperação em nome de outro usuário).

DECISÃO AUD-14-03 — `security.manage_mfa` NÃO é exigida aqui:
    A permissão `security.manage_mfa` (seed 0005, vinculada só ao ADM) é
    reservada para a gestão ADMINISTRATIVA de fatores de OUTROS usuários
    (rota de recuperação assistida descrita acima, ainda inexistente). Esta
    rota é autosserviço: age só sobre `auth_user_id` da sessão, exige AAL2,
    é limitada por rate limit e protegida pela regra do último fator do ADM.
    Exigir `security.manage_mfa` aqui impediria USER/RH de remover o próprio
    fator (a permissão é só do ADM) sem ganho de segurança. A emissão do
    primeiro fator (enroll/verify) é feita pelo frontend direto no Supabase
    Auth e não passa por este módulo, portanto o bootstrap do ADM em AAL1
    não é afetado. A rota administrativa futura DEVE usar:
    `require_auth → require_role("ADM") → require_aal2 →
    require_permission("security.manage_mfa") → rate_limit`.

VALIDAÇÃO DO `factor_id` (auditoria 2026-10-13):
    A rota usa o conversor `<uuid:factor_id>`: qualquer valor que não seja
    um UUID (ex.: `..`, `%2E%2E`, `x?y=1`) resulta em 404 ANTES de chegar à
    view — impedindo que o segmento seja interpretado pelo cliente HTTP
    (normalização de `..` pelo urllib3 transformaria
    `/admin/users/<id>/factors/..` em `/admin/users/<id>/`) ou injete query
    string na URL da API Admin do Supabase. O UUID é canonicalizado
    (minúsculas) antes de ser comparado com os fatores do usuário — sem
    isso, um ADM poderia contornar a regra do "único fator verificado"
    enviando o mesmo UUID em maiúsculas. Além disso, o fator precisa
    pertencer ao próprio usuário (consulta prévia a `list_mfa_factors`);
    caso contrário, 404.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from flask import Blueprint, abort, g

from app.auth.supabase_auth import require_auth
from app.authorization.rbac import require_aal2
from app.api.v1.user_admin_http import reject_any_body
from app.authorization.security_events import (
    EVENT_ADM_TOTP_ENROLL_AAL1,
    EVENT_MFA_FACTOR_DELETE_BLOCKED,
    EVENT_MFA_FACTOR_DELETED,
    SEVERITY_HIGH,
    record_security_event,
)
from app.integrations.supabase_admin_client import (
    InvalidIdentifierError,
    SupabaseAdminClient,
    SupabaseAdminClientError,
)
from app.security.rate_limit import rate_limit

logger = logging.getLogger(__name__)

security_bp = Blueprint("security", __name__, url_prefix="/security")

_ADM_ROLE_CODE = "ADM"
_VERIFIED_FACTOR_STATUS = "verified"

# Remoção de fator MFA: 5 tentativas/hora por usuário; Redis indisponível
# bloqueia (operação de segurança crítica).
_MFA_DELETE_RATE_LIMIT_PER_HOUR = 5
_MFA_DELETE_RATE_LIMIT_WINDOW_SECONDS = 3600

_UPSTREAM_ERROR_MESSAGE = "Não foi possível concluir a operação no provedor de autenticação."


def _current_user_rate_limit_key(*_args: Any, **_kwargs: Any) -> str:
    user = getattr(g, "current_user", None)
    return str(getattr(user, "id", "desconhecido"))


def _canonical_factor_id(value: Any) -> str | None:
    """Normaliza um id de fator para UUID canônico (minúsculas) ou `None`."""
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        return None


@security_bp.route("/mfa/factors/<uuid:factor_id>", methods=["DELETE"])
@require_auth
@require_aal2
@rate_limit(
    _current_user_rate_limit_key,
    limit=_MFA_DELETE_RATE_LIMIT_PER_HOUR,
    window_seconds=_MFA_DELETE_RATE_LIMIT_WINDOW_SECONDS,
    fail_open=False,
)
def delete_my_mfa_factor(factor_id: uuid.UUID):
    """Remove um fator MFA do PRÓPRIO usuário autenticado.

    Ver docstring do módulo para a distinção entre esta autorremoção e um
    futuro fluxo de recuperação administrativa assistida (fora de escopo
    aqui).

    Regras:
        - Exige `require_auth` + `require_aal2` (ver docstring do módulo) e
          é limitado a 5 chamadas/hora por usuário.
        - `factor_id` precisa ser um UUID (conversor da rota) e pertencer
          aos fatores do próprio usuário; caso contrário, 404.
        - Se o usuário atual tiver o papel `ADM`: BLOQUEIA (409) a remoção
          se `factor_id` for o ÚNICO fator MFA `verified` restante do
          usuário — política obrigatória de MFA para `ADM` ("um ADM não
          pode remover unilateralmente seu único fator").
        - Qualquer falha ao falar com a API Admin do Supabase resulta em
          502, sem detalhes internos expostos ao cliente (ver `app.errors`).
        - Remoções e bloqueios são registrados em `audit_logs`.
    """
    user = g.current_user
    auth_user_id = getattr(user, "auth_user_id", None)
    if not auth_user_id:
        # Usuário existe na base local, mas sem vínculo com o Supabase Auth
        # (não deveria ocorrer para um usuário que acabou de se autenticar
        # via `require_auth`, mas tratado defensivamente).
        logger.error(
            "Usuário %s autenticado sem 'auth_user_id'; remoção de fator MFA abortada.",
            getattr(user, "id", "?"),
        )
        abort(409, description="Usuário sem vínculo com o provedor de autenticação.")

    canonical_factor_id = str(factor_id)
    role_codes = getattr(g, "current_user_roles", set())
    client = SupabaseAdminClient()

    try:
        factors = client.list_mfa_factors(auth_user_id)
        own_factor_ids = {
            _canonical_factor_id(f.get("id")) for f in factors if isinstance(f, dict)
        }
        own_factor_ids.discard(None)
        if canonical_factor_id not in own_factor_ids:
            abort(404, description="Fator de autenticação não encontrado.")

        if _ADM_ROLE_CODE in role_codes:
            verified_factor_ids = {
                _canonical_factor_id(f.get("id"))
                for f in factors
                if isinstance(f, dict) and f.get("status") == _VERIFIED_FACTOR_STATUS
            }
            verified_factor_ids.discard(None)
            if canonical_factor_id in verified_factor_ids and len(verified_factor_ids) <= 1:
                logger.info(
                    "Bloqueada remoção do único fator MFA ativo do administrador %s.",
                    getattr(user, "id", "?"),
                )
                record_security_event(
                    EVENT_MFA_FACTOR_DELETE_BLOCKED,
                    severity=SEVERITY_HIGH,
                    actor_user_id=getattr(user, "id", None),
                    target_type="mfa_factor",
                    target_id=canonical_factor_id,
                    details={"reason": "adm_last_verified_factor"},
                )
                abort(
                    409,
                    description=(
                        "Administradores não podem remover seu único fator de "
                        "autenticação multifator (MFA) ativo."
                    ),
                )

        client.delete_mfa_factor(auth_user_id, canonical_factor_id)
    except InvalidIdentifierError:
        # Identificador rejeitado pelo cliente antes de qualquer chamada de
        # rede (defesa em profundidade): erro do cliente, não do upstream.
        abort(404, description="Fator de autenticação não encontrado.")
    except SupabaseAdminClientError as exc:
        # Mensagem de `exc` já é segura (nunca contém a service role key —
        # ver `SupabaseAdminClient`), mas ainda assim não a repassamos ao
        # cliente final; apenas logamos no servidor.
        logger.error(
            "Falha ao remover fator MFA %s do usuário %s via API Admin do Supabase: %s",
            canonical_factor_id,
            getattr(user, "id", "?"),
            exc,
        )
        abort(502, description=_UPSTREAM_ERROR_MESSAGE)

    record_security_event(
        EVENT_MFA_FACTOR_DELETED,
        severity=SEVERITY_HIGH,
        actor_user_id=getattr(user, "id", None),
        target_type="mfa_factor",
        target_id=canonical_factor_id,
        result="SUCESSO",
    )
    return "", 204


# Aviso de cadastro de 1º fator por ADM em sessão AAL1 (apoio ao achado B-3).
_ENROLL_NOTICE_LIMIT_PER_HOUR = 10


@security_bp.route("/mfa/factor-added-notice", methods=["POST"])
@require_auth
@rate_limit(
    _current_user_rate_limit_key,
    limit=_ENROLL_NOTICE_LIMIT_PER_HOUR,
    window_seconds=_MFA_DELETE_RATE_LIMIT_WINDOW_SECONDS,
    fail_open=False,
)
def mfa_factor_added_notice():
    """Aviso (best effort) de que o usuário acabou de cadastrar um fator TOTP.

    NÃO altera o fluxo de cadastro (feito no Supabase Auth): o frontend pode
    chamar esta rota depois do `enroll`. Se o usuário tem o papel `ADM` e a
    sessão atual é `aal1` (só senha), registra o evento HIGH
    `ADM_TOTP_ENROLL_AAL1` (alerta de segurança: quem tem só a senha pode
    ter virado dono do 2º fator). Qualquer outro caso (não-ADM, `aal2`)
    responde igual e não registra nada — a rota não vira oráculo de papel.
    O alvo é sempre o usuário do JWT; sem corpo (400 se houver).
    """
    rejected = reject_any_body("security.mfa_factor_added_notice")
    if rejected is not None:
        return rejected
    user = g.current_user
    role_codes = getattr(g, "current_user_roles", set())
    if _ADM_ROLE_CODE in role_codes and getattr(g, "current_session_aal", "aal1") != "aal2":
        total: int | None = None
        auth_user_id = getattr(user, "auth_user_id", None)
        if auth_user_id:
            try:
                factors = SupabaseAdminClient().list_mfa_factors(auth_user_id)
                total = sum(1 for f in factors if isinstance(f, dict))
            except Exception as exc:  # noqa: BLE001 - o evento sai mesmo sem a checagem
                logger.warning(
                    "mfa_factor_added_notice: não foi possível listar fatores (%s).", type(exc).__name__
                )
        if total == 0:  # checado e sem fator: nada foi cadastrado, nada a alertar
            return "", 204
        record_security_event(
            EVENT_ADM_TOTP_ENROLL_AAL1,
            severity=SEVERITY_HIGH,
            actor_user_id=getattr(user, "id", None),
            target_type="user",
            target_id=getattr(user, "id", None),
            details={"session_aal": "aal1", "factors_total": total, "factors_checked": total is not None},
            result="SUCESSO",
        )
    return "", 204
