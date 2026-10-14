-- SISPAT-AGU - Seed idempotente de permissions de segurança/gestão de usuários
--
-- Pré-requisito: 0002_seeds_roles_permissions.sql (roles/permissions base) e
-- 0004_invites.sql / migração Alembic 0003_invites equivalente já aplicados.
--
-- Importante:
--   - NÃO cria nenhum usuário nem credencial. Autenticação e MFA (TOTP) são
--     geridos inteiramente pelo Supabase Auth; este banco não armazena
--     senhas, tokens ou segredos.
--   - Todas as inserções usam ON CONFLICT DO NOTHING, portanto este script
--     pode ser reexecutado sem duplicar dados ou falhar.
--   - As 8 novas permissions abaixo são vinculadas EXCLUSIVAMENTE ao role
--     ADM. São operações administrativas sensíveis de gestão de usuários e
--     segurança (convite, ativação/desativação de contas, atribuição de
--     papel/unidade, revogação de acesso, gestão de MFA e consulta a logs
--     de autenticação) e NUNCA são concedidas a USER/RH.

BEGIN;

-- ============================================================
-- permissions (novas: gestão de usuários e segurança)
-- ============================================================
INSERT INTO permissions (code, description, resource, action) VALUES
    ('users.invite',          'Convidar novos usuários (cadastro exclusivamente por convite).', 'users',    'invite'),
    ('users.activate',        'Ativar contas de usuários convidados.',                           'users',    'activate'),
    ('users.deactivate',      'Desativar contas de usuários existentes.',                         'users',    'deactivate'),
    ('users.assign_role',     'Atribuir/alterar o papel (role) de um usuário.',                   'users',    'assign_role'),
    ('users.assign_unit',     'Atribuir/revogar o acesso de um usuário a unidades.',               'users',    'assign_unit'),
    ('users.revoke_access',   'Revogar o acesso de um usuário ao sistema.',                        'users',    'revoke_access'),
    ('security.manage_mfa',   'Gerenciar a exigência e o estado de MFA dos usuários.',             'security', 'manage_mfa'),
    ('security.view_auth_logs', 'Consultar logs/trilhas de autenticação e segurança.',             'security', 'view_auth_logs')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- role_permissions
-- ============================================================

-- ADM: vínculo exclusivo das 8 novas permissions de gestão de
-- usuários/segurança. Nunca concedidas a USER/RH.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
    'users.invite',
    'users.activate',
    'users.deactivate',
    'users.assign_role',
    'users.assign_unit',
    'users.revoke_access',
    'security.manage_mfa',
    'security.view_auth_logs'
)
WHERE r.code = 'ADM'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
