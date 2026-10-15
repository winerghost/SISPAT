"""permissão settings.email.manage (somente ADM)

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum. Depende de 0005_settings_ai_users.

Aditiva e idempotente: apenas semeia a permissão `settings.email.manage`
(exigida por backend/app/api/v1/email_settings.py) e a vincula EXCLUSIVAMENTE
ao papel ADM. Nenhuma tabela, coluna ou linha preexistente é alterada.

Espelho SQL: backend/migrations/sql/0009_email_settings_permission.sql
(verificado por backend/tests/test_db_static.py).

Downgrade: remove somente o vínculo ADM <-> settings.email.manage e a própria
permissão.

Revision ID: 0006_email_settings_permission
Revises: 0005_settings_ai_users
Create Date: 2026-10-15

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0006_email_settings_permission"
down_revision: Union[str, None] = "0005_settings_ai_users"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

NEW_PERMISSIONS: tuple[str, ...] = ("settings.email.manage",)

SEED_PERMISSIONS_SQL = """
INSERT INTO public.permissions (code, description, resource, action) VALUES
    ('settings.email.manage', 'Gerenciar e testar a configuracao de e-mail (SMTP).', 'settings', 'email.manage')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN (
    'settings.email.manage'
)
WHERE r.code = 'ADM'
ON CONFLICT (role_id, permission_id) DO NOTHING;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (SEED_PERMISSIONS_SQL,)

# Downgrade: remove só o vínculo e a permissão desta migração.
DOWNGRADE_SQL = """
DELETE FROM public.role_permissions
WHERE permission_id IN (
    SELECT id FROM public.permissions WHERE code = 'settings.email.manage'
);
DELETE FROM public.permissions WHERE code = 'settings.email.manage';
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
