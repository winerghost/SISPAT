-- SISPAT-AGU - users: exclusão LÓGICA + anonimização
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. Este script NÃO foi
-- executado em banco algum. O banco está carimbado em
-- 0018_equipment_classification e dev = prod neste projeto: o responsável
-- executa este espelho no SQL Editor do Supabase e só então carimba o
-- Alembic com `alembic stamp 0019_user_soft_delete` (SEM upgrade) ou
-- `UPDATE public.alembic_version SET version_num = '0019_user_soft_delete';`.
--
-- ORDEM DE IMPLANTAÇÃO (obrigatória): executar ANTES de subir a imagem nova
-- do backend. `app.models.rbac.User` declara as três colunas novas e a
-- consulta de autenticação as seleciona; sem elas no banco, toda requisição
-- autenticada falharia (mesma classe do PREDEPLOY-01, quando `phone` entrou).
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0019_user_soft_delete.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos DOIS arquivos.
--
-- Exclusão de usuário é LÓGICA, nunca física, e o banco já garante isso: 4
-- FKs RESTRICT para `users.id` (asset_movements.requested_by,
-- import_previews.requested_by, inventories.created_by, invites.invited_by) e
-- o gatilho append-only `trg_audit_logs_block_update_delete`, que recusa o
-- UPDATE do `ON DELETE SET NULL` de `audit_logs.actor_user_id`. Este script
-- NÃO remove nem relaxa FK, gatilho ou RLS. A trilha de auditoria do usuário
-- excluído permanece intacta, com `actor_user_id` PRESERVADO.
--
-- Aditivo, idempotente e sem backfill (as três colunas ficam NULL):
--   deleted_at    timestamptz NULL - instante da exclusão lógica;
--   deleted_by    uuid NULL        - ADM que executou (FK ON DELETE SET NULL,
--                                    igual a deactivated_by, da 0007);
--   anonymized_at timestamptz NULL - instante da anonimização irreversível de
--                                    name/email/phone/avatar_object_key/
--                                    auth_user_id;
--   CHECK ck_users_deleted_requires_anonymized - exclusão lógica sempre vem
--                                    com anonimização;
--   permissão users.delete, ligada EXCLUSIVAMENTE ao papel ADM.
-- `users.email` continua NOT NULL UNIQUE: a anonimização grava um endereço
-- único e não roteável derivado do id (domínio .invalid, RFC 2606), liberando
-- o e-mail ORIGINAL para um convite futuro. Nenhuma unicidade é alterada.
--
-- Pré-requisito: 0021_equipment_classification.sql (Alembic 0018). Tabela
-- existente: RLS/REVOKE já vêm de 0006_db_security_hardening.sql (Alembic
-- 0004; as numerações do espelho .sql e do Alembic diferem em +3). Nenhuma
-- tabela nova aqui.
-- Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Rollback: ver DOWNGRADE_SQL na migração Alembic correspondente
-- (`alembic downgrade 0018_equipment_classification`).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_by uuid NULL
    REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS anonymized_at timestamptz NULL;

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
