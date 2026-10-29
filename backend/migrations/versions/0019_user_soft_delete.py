"""users: exclusão LÓGICA + anonimização (deleted_at/deleted_by/anonymized_at)

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum. O banco está carimbado em `0018_equipment_classification`
e **dev = prod** neste projeto: o padrão é o responsável executar o espelho
`sql/0022_user_soft_delete.sql` no SQL Editor do Supabase e carimbar o
`alembic_version` por UPDATE (ou `alembic stamp 0019_user_soft_delete`, SEM
`upgrade`). Nenhum agente aplica DDL aqui.

ORDEM DE IMPLANTAÇÃO (obrigatória): aplicar este DDL ANTES de subir a imagem
nova do backend. `app.models.rbac.User` passa a declarar as três colunas e a
consulta de autenticação (`app.auth.supabase_auth`) as seleciona; sem as
colunas no banco, TODA requisição autenticada falharia (mesma classe de
problema do PREDEPLOY-01, quando `phone` foi adicionado).

Depende de 0018_equipment_classification (a cadeia Alembic é linear).

Exclusão de usuário é LÓGICA, nunca física — e isso é uma garantia do próprio
banco, não só da aplicação:
    - 4 FKs RESTRICT referenciam `users.id` (`asset_movements.requested_by`,
      `import_previews.requested_by`, `inventories.created_by`,
      `invites.invited_by`);
    - `audit_logs.actor_user_id` é `ON DELETE SET NULL`, e o gatilho
      `trg_audit_logs_block_update_delete` (0004) RECUSA esse UPDATE: a
      trilha é append-only.
Nenhuma dessas proteções é removida ou relaxada aqui. `audit_logs` do usuário
excluído permanece intacto, com o `actor_user_id` PRESERVADO — é exatamente
por isso que a linha de `users` precisa continuar existindo.

Aditiva e idempotente (nenhum dado preexistente é alterado; sem backfill —
todas as colunas ficam NULL):
    - `deleted_at timestamptz NULL`: instante da exclusão lógica. Toda
      consulta de usuário passa a filtrar `deleted_at IS NULL` e
      `require_auth` responde 401 a JWT de usuário excluído.
    - `deleted_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL`:
      o ADM que executou (mesmo padrão de `deactivated_by`, da 0005).
    - `anonymized_at timestamptz NULL`: instante da anonimização
      irreversível de `name`/`email`/`phone`/`avatar_object_key`/
      `auth_user_id` (ver `app.services.user_deletion_service`). Nenhuma
      cópia do dado removido é guardada — nem em `audit_logs`, que recebe
      apenas o e-mail MASCARADO.
    - CHECK `ck_users_deleted_requires_anonymized`: exclusão lógica sempre
      acompanhada de anonimização. Deliberadamente NÃO se usa um CHECK
      envolvendo `deleted_by`: aquela coluna pode virar NULL por
      `ON DELETE SET NULL`.
    - permissão dedicada `users.delete`, vinculada EXCLUSIVAMENTE ao papel
      ADM (exigida por `POST /api/v1/users/<id>/delete`).

`users.email` continua `NOT NULL UNIQUE`: a anonimização grava um endereço
único e não roteável derivado do `id` (domínio `.invalid`, RFC 2606), o que
libera o e-mail ORIGINAL para um convite futuro. Nenhuma constraint de
unicidade é alterada por esta migração.

Espelho SQL: backend/migrations/sql/0022_user_soft_delete.sql (a numeração do
espelho é deslocada em +3 desde sempre: 0018_equipment_classification.py ↔
0021_equipment_classification.sql). Verificado por
backend/tests/test_db_static.py.

Rollback: `alembic downgrade 0018_equipment_classification` (ou o
DOWNGRADE_SQL abaixo no SQL Editor) — remove só a permissão, o CHECK e as
três colunas criadas aqui; `audit_logs` e as demais colunas de `users` ficam
intactos. Perde-se a marcação de quem foi excluído (a anonimização, por
definição, não é reversível).

Revision ID: 0019_user_soft_delete
Revises: 0018_equipment_classification
Create Date: 2026-10-28
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0019_user_soft_delete"
down_revision: Union[str, None] = "0018_equipment_classification"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

NEW_COLUMNS: tuple[str, ...] = ("deleted_at", "deleted_by", "anonymized_at")
NEW_PERMISSIONS: tuple[str, ...] = ("users.delete",)

ADD_COLUMNS_SQL = """
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_by uuid NULL
    REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS anonymized_at timestamptz NULL;
"""

ADD_CHECKS_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_users_deleted_requires_anonymized'
          AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT ck_users_deleted_requires_anonymized
            CHECK (deleted_at IS NULL OR anonymized_at IS NOT NULL);
    END IF;
END
$do$;
"""

SEED_PERMISSIONS_SQL = """
INSERT INTO public.permissions (code, description, resource, action) VALUES
    ('users.delete', 'Excluir (logicamente) e anonimizar a conta de um usuario.', 'users', 'delete')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN (
    'users.delete'
)
WHERE r.code = 'ADM'
ON CONFLICT (role_id, permission_id) DO NOTHING;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    ADD_COLUMNS_SQL,
    ADD_CHECKS_SQL,
    SEED_PERMISSIONS_SQL,
)

# Downgrade: remove SOMENTE o que esta migração criou. Nenhuma linha de
# `users` nem de `audit_logs` é apagada; RLS intacta.
DOWNGRADE_SQL = """
DELETE FROM public.role_permissions
WHERE permission_id IN (
    SELECT id FROM public.permissions WHERE code = 'users.delete'
);
DELETE FROM public.permissions WHERE code = 'users.delete';

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS ck_users_deleted_requires_anonymized;
ALTER TABLE public.users DROP COLUMN IF EXISTS anonymized_at;
ALTER TABLE public.users DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE public.users DROP COLUMN IF EXISTS deleted_at;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
