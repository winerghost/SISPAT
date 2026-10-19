"""IDs de origem e unicidades dos cadastros de apoio; permissões responsible.manage e units.update

PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Esta migração NÃO foi
aplicada em banco algum. Depende de 0007_unit_aliases.

Aditiva e idempotente:
1. `source_record_id text NULL` (ID original da planilha) em `units`, `rooms`
   e `responsible_people`, com unicidade parcial WHERE source_record_id IS NOT
   NULL e CHECK de tamanho (1..64) quando preenchido.
2. Sala única por (unit_id, lower(btrim(name))).
3. E-mail de pessoa único por lower(btrim(email)) WHERE email IS NOT NULL.
4. CHECK de tamanho (1..200) e sem espaços nas pontas em `rooms.name` e
   `responsible_people.name`. (Tabelas vazias na data da escrita; se houver
   dados que violem, a migração falha em vez de alterá-los.)
5. Permissões `responsible.manage` e `units.update`, concedidas SOMENTE ao ADM.
6. `phone text NULL` em `responsible_people` e `users` (dado pessoal, LGPD:
   leitura/escrita restritas por campo ao ADM no backend), CHECK de formato
   `^[0-9]{10,13}$` e COMMENT de coluna. Sem coluna de foto em
   responsible_people (`users.avatar_object_key` já cobre usuários).

Espelho SQL: backend/migrations/sql/0011_catalog_source_ids_permissions.sql.

Downgrade: remove índices, constraints e colunas criados aqui e as duas
permissões (com seus vínculos).

Revision ID: 0008_catalog_source_ids_permissions
Revises: 0007_unit_aliases
Create Date: 2026-10-16

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0008_catalog_source_ids_permissions"
down_revision: Union[str, None] = "0007_unit_aliases"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None

NEW_PERMISSIONS: tuple[str, ...] = ("responsible.manage", "units.update")

ADD_SOURCE_COLUMNS_SQL = """
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS source_record_id text NULL;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS source_record_id text NULL;
ALTER TABLE public.responsible_people ADD COLUMN IF NOT EXISTS source_record_id text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_units_source_record_id
    ON public.units (source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_source_record_id
    ON public.rooms (source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_responsible_people_source_record_id
    ON public.responsible_people (source_record_id) WHERE source_record_id IS NOT NULL;
"""

UNIQUENESS_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_unit_name_lower
    ON public.rooms (unit_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_responsible_people_email_lower
    ON public.responsible_people (lower(btrim(email))) WHERE email IS NOT NULL;
"""

CHECKS_SQL = """
DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_rooms_name_trimmed' AND conrelid = 'public.rooms'::regclass) THEN
        ALTER TABLE public.rooms ADD CONSTRAINT ck_rooms_name_trimmed
            CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_responsible_people_name_trimmed'
                     AND conrelid = 'public.responsible_people'::regclass) THEN
        ALTER TABLE public.responsible_people ADD CONSTRAINT ck_responsible_people_name_trimmed
            CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_units_source_record_id_length' AND conrelid = 'public.units'::regclass) THEN
        ALTER TABLE public.units ADD CONSTRAINT ck_units_source_record_id_length
            CHECK (source_record_id IS NULL OR char_length(source_record_id) BETWEEN 1 AND 64);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_rooms_source_record_id_length' AND conrelid = 'public.rooms'::regclass) THEN
        ALTER TABLE public.rooms ADD CONSTRAINT ck_rooms_source_record_id_length
            CHECK (source_record_id IS NULL OR char_length(source_record_id) BETWEEN 1 AND 64);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_responsible_people_source_record_id_length'
                     AND conrelid = 'public.responsible_people'::regclass) THEN
        ALTER TABLE public.responsible_people ADD CONSTRAINT ck_responsible_people_source_record_id_length
            CHECK (source_record_id IS NULL OR char_length(source_record_id) BETWEEN 1 AND 64);
    END IF;
END
$do$;
"""

PHONE_SQL = """
ALTER TABLE public.responsible_people ADD COLUMN IF NOT EXISTS phone text NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text NULL;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_responsible_people_phone_format'
                     AND conrelid = 'public.responsible_people'::regclass) THEN
        ALTER TABLE public.responsible_people ADD CONSTRAINT ck_responsible_people_phone_format
            CHECK (phone IS NULL OR phone ~ '^[0-9]{10,13}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_users_phone_format' AND conrelid = 'public.users'::regclass) THEN
        ALTER TABLE public.users ADD CONSTRAINT ck_users_phone_format
            CHECK (phone IS NULL OR phone ~ '^[0-9]{10,13}$');
    END IF;
END
$do$;

COMMENT ON COLUMN public.responsible_people.phone IS
    'DADO PESSOAL (LGPD): telefone, somente digitos (10 a 13). Leitura/escrita restritas ao ADM no backend.';
COMMENT ON COLUMN public.users.phone IS
    'DADO PESSOAL (LGPD): telefone, somente digitos (10 a 13). Leitura/escrita restritas ao ADM no backend.';
"""

SEED_PERMISSIONS_SQL = """
INSERT INTO public.permissions (code, description, resource, action) VALUES
    ('responsible.manage', 'Criar, alterar e inativar pessoas responsaveis.', 'responsible', 'manage'),
    ('units.update',       'Alterar dados cadastrais de unidades.',           'units',       'update')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN (
    'responsible.manage',
    'units.update'
)
WHERE r.code = 'ADM'
ON CONFLICT (role_id, permission_id) DO NOTHING;
"""

UPGRADE_STATEMENTS: tuple[str, ...] = (
    ADD_SOURCE_COLUMNS_SQL,
    UNIQUENESS_SQL,
    CHECKS_SQL,
    PHONE_SQL,
    SEED_PERMISSIONS_SQL,
)

DOWNGRADE_SQL = """
DELETE FROM public.role_permissions
WHERE permission_id IN (
    SELECT id FROM public.permissions WHERE code IN ('responsible.manage', 'units.update')
);
DELETE FROM public.permissions WHERE code IN ('responsible.manage', 'units.update');

ALTER TABLE public.responsible_people DROP CONSTRAINT IF EXISTS ck_responsible_people_phone_format;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS ck_users_phone_format;
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS ck_rooms_name_trimmed;
ALTER TABLE public.responsible_people DROP CONSTRAINT IF EXISTS ck_responsible_people_name_trimmed;
ALTER TABLE public.units DROP CONSTRAINT IF EXISTS ck_units_source_record_id_length;
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS ck_rooms_source_record_id_length;
ALTER TABLE public.responsible_people DROP CONSTRAINT IF EXISTS ck_responsible_people_source_record_id_length;
DROP INDEX IF EXISTS public.uq_rooms_unit_name_lower;
DROP INDEX IF EXISTS public.uq_responsible_people_email_lower;
DROP INDEX IF EXISTS public.uq_units_source_record_id;
DROP INDEX IF EXISTS public.uq_rooms_source_record_id;
DROP INDEX IF EXISTS public.uq_responsible_people_source_record_id;
ALTER TABLE public.responsible_people DROP COLUMN IF EXISTS phone;
ALTER TABLE public.users DROP COLUMN IF EXISTS phone;
ALTER TABLE public.units DROP COLUMN IF EXISTS source_record_id;
ALTER TABLE public.rooms DROP COLUMN IF EXISTS source_record_id;
ALTER TABLE public.responsible_people DROP COLUMN IF EXISTS source_record_id;
"""


def upgrade() -> None:
    for statement in UPGRADE_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
