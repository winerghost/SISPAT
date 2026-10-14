"""Regressão proposta (auditoria 2026-10-14, achado AUD-14-01).

`POST /api/v1/users/<id>/revoke` exige ADM+AAL2+`users.revoke_access`, mas
NÃO verifica se o usuário-alvo pertence ao escopo de unidades do ADM que
revoga (BOLA/IDOR horizontal entre ADMs de unidades distintas), e a resposta
para alvo inexistente (404 'usuário ... não encontrado') difere de um alvo
fora do escopo. Marcado xfail(strict) até a correção em produção; ao
corrigir, remova o xfail.
"""
from __future__ import annotations

import inspect

import pytest

from app.api.v1 import users as users_module


@pytest.mark.xfail(
    strict=True,
    reason="AUD-14-01: revoke sem checagem de escopo de unidade do alvo",
)
def test_revoke_checa_escopo_de_unidade_do_alvo():
    source = inspect.getsource(users_module.revoke_user_access_endpoint)
    assert any(
        marker in source
        for marker in ("units_outside_scope", "require_unit_access", "apply_unit_scope")
    ), "o handler de revoke deve negar alvo fora do escopo com a MESMA resposta de ID inexistente"
