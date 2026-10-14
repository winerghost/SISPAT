"""Pacote de autorização (RBAC) do SISPAT-AGU.

Depende de `app.auth.supabase_auth.require_auth` já ter executado antes
(ver docstrings de `require_auth` e de `app.authorization.rbac` sobre a
ordem correta dos decorators).
"""
from app.authorization.rbac import (  # noqa: F401
    apply_unit_scope,
    get_accessible_unit_ids,
    has_unit_access,
    require_aal2,
    require_permission,
    require_role,
    require_unit_access,
    units_outside_scope,
)

__all__ = [
    "require_permission",
    "require_role",
    "require_aal2",
    "has_unit_access",
    "get_accessible_unit_ids",
    "units_outside_scope",
    "apply_unit_scope",
    "require_unit_access",
]
