-- SISPAT-AGU - Convites de cadastro (cadastro exclusivamente por convite)
--
-- Este arquivo espelha SEMANTICAMENTE a migração Alembic
-- backend/migrations/versions/0003_invites.py. Use-o apenas quando não
-- houver conectividade Python -> Postgres (ex.: aplicar manualmente via
-- Supabase SQL Editor / MCP). Qualquer alteração aqui deve ser replicada na
-- migração Alembic correspondente (e vice-versa).
--
-- Cria invites e invite_units, usadas pelo fluxo administrativo de convite
-- de novos usuários. O cadastro público NUNCA é permitido: toda conta nasce
-- de um convite emitido por um administrador (ADM). O mecanismo de convite
-- propriamente dito (token, criação do usuário, e-mail, segredo TOTP de
-- MFA) é inteiramente gerido pelo Supabase Auth -- este banco armazena
-- apenas o registro local administrativo do convite (quem, para qual
-- papel/unidades, status), nunca um token ou segredo.
--
-- intended_role_code aceita exclusivamente 'USER' ou 'RH'. A atribuição do
-- papel 'ADM' NUNCA ocorre via convite direto; é um processo administrativo
-- separado e mais restrito, fora do escopo desta migração.
--
-- Idempotência: as instruções abaixo assumem que o schema inicial (ver
-- 0001_initial_schema.sql) já foi aplicado. Para reexecução segura em
-- ambiente já criado, use IF NOT EXISTS / DO $$ ... $$ blocks conforme
-- necessário antes de reaplicar.

BEGIN;

-- ============================================================
-- invites
-- ============================================================
CREATE TABLE IF NOT EXISTS invites (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                text NOT NULL,
    name                 text NOT NULL,
    intended_role_code   text NOT NULL,
    justification        text,
    status               text NOT NULL DEFAULT 'PENDENTE',
    invited_by           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- Preenchido quando o Supabase Auth cria o usuário convidado; usado
    -- para religar este registro ao users.auth_user_id real na ativação.
    invited_auth_user_id text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- TTL do registro local do convite (ex.: 7 dias); calculado pela
    -- aplicação, sem default no banco.
    expires_at           timestamptz NOT NULL,
    accepted_at          timestamptz,
    revoked_at           timestamptz,
    revoked_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT ck_invites_intended_role_code CHECK (intended_role_code IN ('USER','RH')),
    CONSTRAINT ck_invites_status CHECK (status IN ('PENDENTE','ACEITO','EXPIRADO','REVOGADO'))
);
COMMENT ON TABLE invites IS 'Registro local administrativo de convites de cadastro. NENHUM token ou segredo (convite, TOTP/MFA) é armazenado aqui -- isso é gerido inteiramente pelo Supabase Auth. Cadastro público NUNCA é permitido; intended_role_code nunca é ''ADM'' (processo administrativo separado, fora do escopo desta tabela).';

CREATE INDEX IF NOT EXISTS ix_invites_email ON invites (email);
CREATE INDEX IF NOT EXISTS ix_invites_status ON invites (status);
CREATE INDEX IF NOT EXISTS ix_invites_invited_by ON invites (invited_by);
-- Índice único parcial: no máximo um convite PENDENTE por e-mail
-- (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_pending_email ON invites (lower(email)) WHERE status = 'PENDENTE';

-- ============================================================
-- invite_units
-- ============================================================
CREATE TABLE IF NOT EXISTS invite_units (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_id  uuid NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    unit_id    uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    CONSTRAINT uq_invite_units_invite_unit UNIQUE (invite_id, unit_id)
);
COMMENT ON TABLE invite_units IS 'Unidades autorizadas em um convite, aplicadas ao usuário real (via user_unit_access) assim que o convite for aceito.';

CREATE INDEX IF NOT EXISTS ix_invite_units_invite_id ON invite_units (invite_id);
CREATE INDEX IF NOT EXISTS ix_invite_units_unit_id ON invite_units (unit_id);

COMMIT;
