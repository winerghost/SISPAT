-- SISPAT-AGU - IDs de origem, unicidades dos cadastros de apoio e permissões
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado em banco
-- algum.
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0008_catalog_source_ids_permissions.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisito: 0010_unit_aliases.sql (Alembic 0007). Idempotente e aditivo.
-- Sem BEGIN/COMMIT (SQL Editor do Supabase). Falha (sem alterar dados) se
-- houver linhas existentes que violem os CHECKs/unicidades.
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

ALTER TABLE public.units ADD COLUMN IF NOT EXISTS source_record_id text NULL;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS source_record_id text NULL;
ALTER TABLE public.responsible_people ADD COLUMN IF NOT EXISTS source_record_id text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_units_source_record_id
    ON public.units (source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_source_record_id
    ON public.rooms (source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_responsible_people_source_record_id
    ON public.responsible_people (source_record_id) WHERE source_record_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_unit_name_lower
    ON public.rooms (unit_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_responsible_people_email_lower
    ON public.responsible_people (lower(btrim(email))) WHERE email IS NOT NULL;

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
