"""`GET /api/v1/me` — identidade, papéis, permissões e AAL do usuário autenticado.

Este endpoint existe para que o FRONTEND saiba, a partir de uma única
fonte de verdade no backend, qual o papel/permissões do usuário logado e
se a sessão atual já completou o desafio MFA (`current_aal`). O frontend
NUNCA deve decidir isso por conta própria (ex.: a partir de algo que ele
mesmo armazenou) — este endpoint é a referência.

IMPORTANTE — `mfa_required` não autoriza nada:
    `mfa_required=true` é apenas uma DICA para o frontend decidir se deve
    rotear o usuário para a tela de cadastro/desafio de MFA (ela é `true`
    sempre que o papel `ADM` estiver entre os papéis do usuário,
    independentemente do `current_aal` da sessão atual — ou seja, mesmo que
    a sessão já esteja em `aal2`, a flag continua `true` para um ADM,
    porque ela reflete a POLÍTICA "ADM deve ter MFA", não o estado da
    sessão). A autorização real de qualquer operação administrativa
    continua sendo, sempre, `app.authorization.rbac.require_aal2` no
    backend — nunca esta flag.

Exige apenas `require_auth` (qualquer usuário autenticado pode consultar o
próprio estado).
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify

from app.auth.supabase_auth import require_auth

me_bp = Blueprint("me", __name__)

# Papel cuja presença implica a política obrigatória de MFA (ver docstring
# do módulo). Mantido como constante única para evitar divergência com
# outras checagens futuras de política de MFA obrigatório.
_ROLE_REQUIRING_MFA = "ADM"


@me_bp.route("/me", methods=["GET"])
@require_auth
def get_me():
    user = g.current_user
    role_codes = sorted(getattr(g, "current_user_roles", set()))
    permission_codes = sorted(getattr(g, "current_user_permissions", set()))
    current_aal = getattr(g, "current_session_aal", "aal1")

    return (
        jsonify(
            {
                "id": str(user.id),
                "name": user.name,
                "email": user.email,
                "roles": role_codes,
                "permissions": permission_codes,
                "current_aal": current_aal,
                "mfa_required": _ROLE_REQUIRING_MFA in role_codes,
            }
        ),
        200,
    )
