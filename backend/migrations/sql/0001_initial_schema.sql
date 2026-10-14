-- SISPAT-AGU - Fase 1: schema inicial (banco de dados e permissionamento)
--
-- Este arquivo espelha SEMANTICAMENTE a migração Alembic
-- backend/migrations/versions/0001_initial_schema.py. Use-o apenas quando
-- não houver conectividade Python -> Postgres (ex.: aplicar manualmente via
-- Supabase SQL Editor / MCP). Qualquer alteração aqui deve ser replicada na
-- migração Alembic correspondente (e vice-versa).
--
-- Idempotência: as instruções abaixo assumem um banco "limpo" (schema
-- public sem estas tabelas). Para reexecução segura em ambiente já criado,
-- use IF NOT EXISTS / DO $$ ... $$ blocks conforme necessário antes de
-- reaplicar.

BEGIN;

-- ============================================================
-- Extensões
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- busca textual aproximada (GIN trigram)

-- ============================================================
-- Tipo ENUM: situação de localização física do bem
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_located_status') THEN
        CREATE TYPE asset_located_status AS ENUM ('SIM', 'NAO', 'DESCONHECIDO');
    END IF;
END $$;

-- ============================================================
-- roles
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL,
    name        text NOT NULL,
    description text,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_roles_code UNIQUE (code)
);
COMMENT ON TABLE roles IS 'Papéis de acesso (ex.: ADM, USER, RH) atribuíveis a usuários.';

-- ============================================================
-- permissions
-- ============================================================
CREATE TABLE IF NOT EXISTS permissions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL,
    description text,
    resource    text NOT NULL,
    action      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_permissions_code UNIQUE (code)
);
COMMENT ON TABLE permissions IS 'Permissões granulares (ex.: assets.read) usadas na autorização.';

-- ============================================================
-- users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id  text,
    name          text NOT NULL,
    email         text NOT NULL,
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT uq_users_auth_user_id UNIQUE (auth_user_id)
);
COMMENT ON TABLE users IS 'Usuários da aplicação. Autenticação é externa (Supabase Auth); nenhuma senha é armazenada aqui.';

-- ============================================================
-- role_permissions
-- ============================================================
CREATE TABLE IF NOT EXISTS role_permissions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    CONSTRAINT uq_role_permissions_role_permission UNIQUE (role_id, permission_id)
);
COMMENT ON TABLE role_permissions IS 'Associação N:N entre roles e permissions.';

CREATE INDEX IF NOT EXISTS ix_role_permissions_role_id ON role_permissions (role_id);
CREATE INDEX IF NOT EXISTS ix_role_permissions_permission_id ON role_permissions (permission_id);

-- ============================================================
-- user_roles
-- ============================================================
CREATE TABLE IF NOT EXISTS user_roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT uq_user_roles_user_role UNIQUE (user_id, role_id)
);
COMMENT ON TABLE user_roles IS 'Associação N:N entre usuários e roles, com auditoria de atribuição.';

CREATE INDEX IF NOT EXISTS ix_user_roles_user_id ON user_roles (user_id);
CREATE INDEX IF NOT EXISTS ix_user_roles_role_id ON user_roles (role_id);
CREATE INDEX IF NOT EXISTS ix_user_roles_assigned_by ON user_roles (assigned_by);

-- ============================================================
-- units
-- ============================================================
CREATE TABLE IF NOT EXISTS units (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL,
    name        text NOT NULL,
    description text,
    address     text,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_units_code UNIQUE (code)
);
COMMENT ON TABLE units IS 'Unidades organizacionais da AGU.';

-- ============================================================
-- user_unit_access
-- ============================================================
CREATE TABLE IF NOT EXISTS user_unit_access (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    unit_id    uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT uq_user_unit_access_user_unit UNIQUE (user_id, unit_id)
);
COMMENT ON TABLE user_unit_access IS 'Escopo de acesso de um usuário a uma unidade organizacional.';

CREATE INDEX IF NOT EXISTS ix_user_unit_access_user_id ON user_unit_access (user_id);
CREATE INDEX IF NOT EXISTS ix_user_unit_access_unit_id ON user_unit_access (unit_id);
CREATE INDEX IF NOT EXISTS ix_user_unit_access_created_by ON user_unit_access (created_by);

-- ============================================================
-- rooms
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    floor       text,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE rooms IS 'Salas/ambientes físicos dentro de uma unidade.';

CREATE INDEX IF NOT EXISTS ix_rooms_unit_id ON rooms (unit_id);

-- ============================================================
-- locations
-- ============================================================
CREATE TABLE IF NOT EXISTS locations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    room_id     uuid REFERENCES rooms(id) ON DELETE SET NULL,
    name        text NOT NULL,
    description text,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE locations IS 'Locais específicos de guarda de bens, dentro de uma unidade e, opcionalmente, de uma sala.';

CREATE INDEX IF NOT EXISTS ix_locations_unit_id ON locations (unit_id);
CREATE INDEX IF NOT EXISTS ix_locations_room_id ON locations (room_id);

-- ============================================================
-- responsible_people
-- ============================================================
CREATE TABLE IF NOT EXISTS responsible_people (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     text NOT NULL,
    institutional_identifier text,
    email                    text,
    unit_id                  uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    active                   boolean NOT NULL DEFAULT true,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_responsible_people_institutional_identifier UNIQUE (institutional_identifier)
);
COMMENT ON TABLE responsible_people IS 'Pessoas responsáveis institucionais por bens patrimoniais.';

CREATE INDEX IF NOT EXISTS ix_responsible_people_unit_id ON responsible_people (unit_id);

-- ============================================================
-- assets
-- ============================================================
CREATE TABLE IF NOT EXISTS assets (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_record_id        text,
    source_system           text,
    -- patrimony_number é sempre TEXT: nunca numérico/float (zeros à
    -- esquerda, prefixos, formatos variados de origem).
    patrimony_number        text NOT NULL,
    description             text,
    unit_id                 uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    owner_unit_id           uuid REFERENCES units(id) ON DELETE SET NULL,
    responsible_person_id   uuid REFERENCES responsible_people(id) ON DELETE SET NULL,
    assigned_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    room_id                 uuid REFERENCES rooms(id) ON DELETE SET NULL,
    location_id             uuid REFERENCES locations(id) ON DELETE SET NULL,
    located                 asset_located_status NOT NULL DEFAULT 'DESCONHECIDO',
    notes                   text,
    registration_date       date,
    source_updated_at       timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    deleted_at              timestamptz,
    deleted_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    version                 integer NOT NULL DEFAULT 1,
    CONSTRAINT ck_assets_version_positive CHECK (version >= 1)
);
COMMENT ON TABLE assets IS 'Bens patrimoniais. Exclusão sempre lógica (deleted_at/deleted_by). version é usado para controle otimista de concorrência.';

CREATE INDEX IF NOT EXISTS ix_assets_patrimony_number ON assets (patrimony_number);
CREATE INDEX IF NOT EXISTS ix_assets_unit_id ON assets (unit_id);
CREATE INDEX IF NOT EXISTS ix_assets_owner_unit_id ON assets (owner_unit_id);
CREATE INDEX IF NOT EXISTS ix_assets_room_id ON assets (room_id);
CREATE INDEX IF NOT EXISTS ix_assets_location_id ON assets (location_id);
CREATE INDEX IF NOT EXISTS ix_assets_responsible_person_id ON assets (responsible_person_id);
CREATE INDEX IF NOT EXISTS ix_assets_assigned_user_id ON assets (assigned_user_id);
CREATE INDEX IF NOT EXISTS ix_assets_source_record_id ON assets (source_record_id);
CREATE INDEX IF NOT EXISTS ix_assets_created_by ON assets (created_by);
CREATE INDEX IF NOT EXISTS ix_assets_updated_by ON assets (updated_by);
CREATE INDEX IF NOT EXISTS ix_assets_deleted_by ON assets (deleted_by);
-- Índice parcial: consultas de "bens ativos por unidade" são o caso comum.
CREATE INDEX IF NOT EXISTS ix_assets_active_unit ON assets (unit_id) WHERE deleted_at IS NULL;
-- Índice GIN trigram para busca textual aproximada em description.
CREATE INDEX IF NOT EXISTS ix_assets_description_trgm ON assets USING gin (description gin_trgm_ops);

-- ============================================================
-- asset_movements
-- ============================================================
CREATE TABLE IF NOT EXISTS asset_movements (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id                 uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    origin_unit_id           uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    destination_unit_id      uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    origin_room_id           uuid REFERENCES rooms(id) ON DELETE SET NULL,
    destination_room_id      uuid REFERENCES rooms(id) ON DELETE SET NULL,
    previous_responsible_id  uuid REFERENCES responsible_people(id) ON DELETE SET NULL,
    new_responsible_id       uuid REFERENCES responsible_people(id) ON DELETE SET NULL,
    movement_type            text NOT NULL,
    status                   text NOT NULL DEFAULT 'PENDENTE',
    reason                   text,
    requested_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    approved_at              timestamptz,
    completed_at             timestamptz,
    CONSTRAINT ck_asset_movements_status CHECK (status IN ('PENDENTE','APROVADA','REJEITADA','CONCLUIDA','CANCELADA'))
);
COMMENT ON TABLE asset_movements IS 'Movimentações (transferências) de bens entre unidades/salas/responsáveis. Histórico, nunca apagado.';

CREATE INDEX IF NOT EXISTS ix_asset_movements_asset_id ON asset_movements (asset_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_origin_unit_id ON asset_movements (origin_unit_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_destination_unit_id ON asset_movements (destination_unit_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_origin_room_id ON asset_movements (origin_room_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_destination_room_id ON asset_movements (destination_room_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_previous_responsible_id ON asset_movements (previous_responsible_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_new_responsible_id ON asset_movements (new_responsible_id);
CREATE INDEX IF NOT EXISTS ix_asset_movements_requested_by ON asset_movements (requested_by);
CREATE INDEX IF NOT EXISTS ix_asset_movements_approved_by ON asset_movements (approved_by);

-- ============================================================
-- inventories
-- ============================================================
CREATE TABLE IF NOT EXISTS inventories (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    unit_id    uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    start_date date NOT NULL,
    end_date   date,
    status     text NOT NULL DEFAULT 'ABERTO',
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at  timestamptz,
    CONSTRAINT ck_inventories_status CHECK (status IN ('ABERTO','EM_ANDAMENTO','CONCLUIDO','CANCELADO'))
);
COMMENT ON TABLE inventories IS 'Campanhas de inventário (conferência física) de bens por unidade.';

CREATE INDEX IF NOT EXISTS ix_inventories_unit_id ON inventories (unit_id);
CREATE INDEX IF NOT EXISTS ix_inventories_created_by ON inventories (created_by);

-- ============================================================
-- inventory_items
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_items (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id         uuid NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
    asset_id             uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    found                boolean,
    observed_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    checked_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    checked_at           timestamptz,
    notes                text,
    CONSTRAINT uq_inventory_items_inventory_asset UNIQUE (inventory_id, asset_id)
);
COMMENT ON TABLE inventory_items IS 'Itens conferidos em um inventário. Política atual: 1 conferência por bem por inventário (uq_inventory_items_inventory_asset). Se o processo evoluir para permitir múltiplas conferências/recontagens, esta constraint deve ser revista em migração própria.';

CREATE INDEX IF NOT EXISTS ix_inventory_items_inventory_id ON inventory_items (inventory_id);
CREATE INDEX IF NOT EXISTS ix_inventory_items_asset_id ON inventory_items (asset_id);
CREATE INDEX IF NOT EXISTS ix_inventory_items_observed_location_id ON inventory_items (observed_location_id);
CREATE INDEX IF NOT EXISTS ix_inventory_items_checked_by ON inventory_items (checked_by);

-- ============================================================
-- audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    entity_type     text NOT NULL,
    entity_id       text,
    operation       text NOT NULL,
    previous_values jsonb,
    new_values      jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    request_id      text,
    result          text NOT NULL DEFAULT 'SUCESSO',
    CONSTRAINT ck_audit_logs_result CHECK (result IN ('SUCESSO','FALHA'))
);
COMMENT ON TABLE audit_logs IS 'Trilha de auditoria imutável. Nunca é apagada ou atualizada após a inserção.';

CREATE INDEX IF NOT EXISTS ix_audit_logs_actor_user_id ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_entity_type ON audit_logs (entity_type);
CREATE INDEX IF NOT EXISTS ix_audit_logs_entity_id ON audit_logs (entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_occurred_at ON audit_logs (occurred_at);
CREATE INDEX IF NOT EXISTS ix_audit_logs_request_id ON audit_logs (request_id);

-- ============================================================
-- sync_jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source          text NOT NULL,
    status          text NOT NULL DEFAULT 'EM_EXECUCAO',
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    records_read    integer NOT NULL DEFAULT 0,
    records_created integer NOT NULL DEFAULT 0,
    records_updated integer NOT NULL DEFAULT 0,
    records_failed  integer NOT NULL DEFAULT 0,
    error_summary   text,
    CONSTRAINT ck_sync_jobs_status CHECK (status IN ('EM_EXECUCAO','CONCLUIDO','FALHOU','PARCIAL'))
);
COMMENT ON TABLE sync_jobs IS 'Execuções de jobs de sincronização/importação de dados externos. Histórico, nunca apagado.';

CREATE INDEX IF NOT EXISTS ix_sync_jobs_source ON sync_jobs (source);
CREATE INDEX IF NOT EXISTS ix_sync_jobs_status ON sync_jobs (status);

-- ============================================================
-- sync_conflicts
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_conflicts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id          uuid REFERENCES assets(id) ON DELETE SET NULL,
    source_record_id  text NOT NULL,
    source_values     jsonb NOT NULL,
    database_values   jsonb,
    status            text NOT NULL DEFAULT 'PENDENTE',
    detected_at       timestamptz NOT NULL DEFAULT now(),
    resolved_at       timestamptz,
    resolved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT ck_sync_conflicts_status CHECK (status IN ('PENDENTE','RESOLVIDO_MANTER_BANCO','RESOLVIDO_USAR_ORIGEM','IGNORADO'))
);
COMMENT ON TABLE sync_conflicts IS 'Conflitos entre dados de origem externa e dados já existentes no banco. Histórico, nunca apagado.';

CREATE INDEX IF NOT EXISTS ix_sync_conflicts_asset_id ON sync_conflicts (asset_id);
CREATE INDEX IF NOT EXISTS ix_sync_conflicts_source_record_id ON sync_conflicts (source_record_id);
CREATE INDEX IF NOT EXISTS ix_sync_conflicts_resolved_by ON sync_conflicts (resolved_by);
CREATE INDEX IF NOT EXISTS ix_sync_conflicts_status ON sync_conflicts (status);

-- ============================================================
-- raw_import_records
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_import_records (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_job_id        uuid NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
    source_record_id   text NOT NULL,
    source_row_number  integer,
    raw_values         jsonb NOT NULL,
    normalized_values  jsonb,
    validation_errors  jsonb,
    import_status      text NOT NULL DEFAULT 'PENDENTE',
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_raw_import_records_import_status CHECK (import_status IN ('PENDENTE','IMPORTADO','REJEITADO','CONFLITO'))
);
COMMENT ON TABLE raw_import_records IS 'Linhas cruas importadas por um job de sincronização, antes/depois da normalização. Histórico, nunca apagado.';

CREATE INDEX IF NOT EXISTS ix_raw_import_records_sync_job_id ON raw_import_records (sync_job_id);
CREATE INDEX IF NOT EXISTS ix_raw_import_records_source_record_id ON raw_import_records (source_record_id);
CREATE INDEX IF NOT EXISTS ix_raw_import_records_import_status ON raw_import_records (import_status);

-- ============================================================
-- saved_filters
-- ============================================================
CREATE TABLE IF NOT EXISTS saved_filters (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              text NOT NULL,
    filter_definition jsonb NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE saved_filters IS 'Filtros de busca salvos por usuário (ex.: filtros de listagem de bens).';

CREATE INDEX IF NOT EXISTS ix_saved_filters_user_id ON saved_filters (user_id);

-- ============================================================
-- export_jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS export_jobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    format        text NOT NULL,
    filters       jsonb,
    columns       jsonb,
    status        text NOT NULL DEFAULT 'PENDENTE',
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,
    CONSTRAINT ck_export_jobs_format CHECK (format IN ('CSV','XLSX','PDF')),
    CONSTRAINT ck_export_jobs_status CHECK (status IN ('PENDENTE','PROCESSANDO','CONCLUIDO','FALHOU'))
);
COMMENT ON TABLE export_jobs IS 'Solicitações de exportação de dados (CSV/XLSX/PDF) geradas por usuários.';

CREATE INDEX IF NOT EXISTS ix_export_jobs_requested_by ON export_jobs (requested_by);
CREATE INDEX IF NOT EXISTS ix_export_jobs_status ON export_jobs (status);

COMMIT;
