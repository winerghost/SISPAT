"""Leitura de perfis, permissões e vínculos usuário x unidades -- SOMENTE LEITURA.

Privacidade: as consultas selecionam COLUNAS (nunca a entidade `User`), de modo
que e-mail, telefone, `auth_user_id` e chave de foto nem são lidos do banco.
Do usuário só saem `id`, `name` (exibição mínima), `active` e o perfil.

Escopo: contagens de usuários por perfil e a lista de vínculos consideram só
usuários ligados a unidades do ADM consultante (e unidades devolvidas são
apenas as do escopo dele). Sem unidades => resultado vazio (negar por padrão).
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from sqlalchemy import exists, false, func, select

from app.authorization.rbac import get_accessible_unit_ids
from app.models.rbac import Permission, Role, RolePermission, User, UserRole
from app.models.units import Unit, UserUnitAccess
from app.services.user_admin_service import primary_role
from app.services.pagination import page_count

_ROLE_ORDER = {"ADM": 0, "USER": 1, "RH": 2}


class AdminAccessService:
    def __init__(self, db: Any) -> None:
        self._db = db

    # -- perfis e permissões ------------------------------------------------

    def list_roles(self, actor_id: Any) -> dict[str, Any]:
        roles = self._db.execute(
            select(Role.id, Role.code, Role.name, Role.description, Role.active)
        ).all()
        links = self._db.execute(
            select(
                RolePermission.role_id,
                Permission.code,
                Permission.description,
                Permission.resource,
                Permission.action,
            ).join(Permission, Permission.id == RolePermission.permission_id)
        ).all()
        perms_by_role: dict[Any, list[dict[str, Any]]] = defaultdict(list)
        for role_id, code, description, resource, action in links:
            perms_by_role[role_id].append(
                {"code": code, "description": description, "resource": resource, "action": action}
            )
        counts: dict[Any, int] = {}
        actor_units = get_accessible_unit_ids(actor_id, self._db)
        if actor_units:
            rows = self._db.execute(
                select(UserRole.role_id, func.count(func.distinct(User.id)))
                .join(User, User.id == UserRole.user_id)
                .where(
                    User.active.is_(True),
                    exists().where(
                        UserUnitAccess.user_id == User.id,
                        UserUnitAccess.unit_id.in_(sorted(actor_units, key=str)),
                    ),
                )
                .group_by(UserRole.role_id)
            ).all()
            counts = {role_id: int(total) for role_id, total in rows}
        ordered = sorted(roles, key=lambda r: (_ROLE_ORDER.get(r.code, 99), r.code))
        return {
            "roles": [
                {
                    "code": r.code,
                    "name": r.name,
                    "description": r.description,
                    "active": bool(r.active),
                    "permissions": sorted(perms_by_role.get(r.id, []), key=lambda p: p["code"]),
                    "active_users_count": counts.get(r.id, 0),
                }
                for r in ordered
            ],
            "users_count_scope": "actor_units",
        }

    def list_permissions(self) -> dict[str, Any]:
        perms = self._db.execute(
            select(Permission.id, Permission.code, Permission.description, Permission.resource, Permission.action)
            .order_by(Permission.code)
        ).all()
        roles_by_perm: dict[Any, list[str]] = defaultdict(list)
        for perm_id, role_code in self._db.execute(
            select(RolePermission.permission_id, Role.code).join(Role, Role.id == RolePermission.role_id)
        ).all():
            roles_by_perm[perm_id].append(role_code)
        return {
            "permissions": [
                {
                    "code": p.code,
                    "description": p.description,
                    "resource": p.resource,
                    "action": p.action,
                    "roles": sorted(roles_by_perm.get(p.id, []), key=lambda c: (_ROLE_ORDER.get(c, 99), c)),
                }
                for p in perms
            ]
        }

    # -- vínculos usuário x unidades -----------------------------------------

    def list_unit_access(self, actor_id: Any, query: Any) -> dict[str, Any]:
        page, page_size = int(query.page), int(query.page_size)
        empty = {"total": 0, "page": page, "page_size": page_size, "pages": 0, "items": []}
        actor_units = get_accessible_unit_ids(actor_id, self._db)
        if not actor_units:
            return empty
        units = sorted(actor_units, key=str)

        conditions: list[Any] = [
            exists().where(UserUnitAccess.user_id == User.id, UserUnitAccess.unit_id.in_(units))
        ]
        if query.unit_id is not None:
            if query.unit_id in actor_units:
                conditions.append(
                    exists().where(
                        UserUnitAccess.user_id == User.id, UserUnitAccess.unit_id == query.unit_id
                    )
                )
            else:
                # Unidade alheia/inexistente: vazio (não revela vínculos).
                conditions.append(false())
        if query.role:
            conditions.append(
                exists().where(
                    UserRole.user_id == User.id,
                    UserRole.role_id == Role.id,
                    Role.code == query.role,
                    Role.active.is_(True),
                )
            )
        if query.active is not None:
            conditions.append(User.active.is_(query.active == "true"))

        total = self._db.execute(select(func.count()).select_from(User).where(*conditions)).scalar_one()
        name_key = func.lower(User.name)
        order = (name_key.desc(), User.id.desc()) if query.sort == "-name" else (name_key.asc(), User.id.asc())
        users = self._db.execute(
            select(User.id, User.name, User.active)
            .where(*conditions)
            .order_by(*order)
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        ids = [u.id for u in users]

        roles_by_user: dict[Any, set[str]] = defaultdict(set)
        units_by_user: dict[Any, list[dict[str, str]]] = defaultdict(list)
        if ids:
            for user_id, code in self._db.execute(
                select(UserRole.user_id, Role.code)
                .join(Role, Role.id == UserRole.role_id)
                .where(UserRole.user_id.in_(ids), Role.active.is_(True))
            ).all():
                roles_by_user[user_id].add(code)
            for user_id, unit_id, code in self._db.execute(
                select(UserUnitAccess.user_id, Unit.id, Unit.code)
                .join(Unit, Unit.id == UserUnitAccess.unit_id)
                .where(UserUnitAccess.user_id.in_(ids), UserUnitAccess.unit_id.in_(units))
                .order_by(Unit.code, Unit.id)
            ).all():
                units_by_user[user_id].append({"id": str(unit_id), "code": code})
        return {
            "total": int(total),
            "page": page,
            "page_size": page_size, "pages": page_count(total, page_size),
            "items": [
                {
                    "user_id": str(u.id),
                    "name": u.name,
                    "role": primary_role(roles_by_user.get(u.id, set())),
                    "active": bool(u.active),
                    "units": units_by_user.get(u.id, []),
                }
                for u in users
            ],
        }


__all__ = ["AdminAccessService"]
