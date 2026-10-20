"""correção de menor privilégio: USER perde rooms.manage e inventory.create

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum. Depende de 0009_uniq_idx_assets_movements
(independente em conteúdo, mas a cadeia Alembic é linear).

O seed 0002 concedeu `rooms.manage` e `inventory.create` ao perfil USER, mas a
matriz de permissões (docs/permissions/matriz-permissoes.md) as reserva ao
ADM. As rotas já exigem papel ADM além da permissão, então esta é uma
correção de MENOR PRIVILÉGIO: não muda o comportamento da API, só alinha o
banco à matriz.

Idempotente: remove de `role_permissions` apenas os vínculos do perfil USER
para essas duas permissões (DELETE por join em roles/permissions); rodar de
novo não afeta nada. As permissões em si e os vínculos do ADM são mantidos.

Espelho SQL: backend/migrations/sql/0013_seed_permission_corrections.sql.

Downgrade: devolve os dois vínculos ao USER (INSERT ... ON CONFLICT DO NOTHING).

Revision ID: 0010_seed_permission_corrections
Revises: 0009_uniq_idx_assets_movements
Create Date: 2026-10-17

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0010_seed_permission_corrections"
down_revision: Union[str, None] = "0009_uniq_idx_assets_movements"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

REVOKED_FROM_USER: tuple[str, ...] = ("rooms.manage", "inventory.create")

REVOKE_USER_PERMISSIONS_SQL = """
DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'USER'
  AND p.code IN ('rooms.manage', 'inventory.create');
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (REVOKE_USER_PERMISSIONS_SQL,)

DOWNGRADE_SQL = """
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('rooms.manage', 'inventory.create')
WHERE r.code = 'USER'
ON CONFLICT (role_id, permission_id) DO NOTHING;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
