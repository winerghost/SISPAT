-- SISPAT-AGU - Fase 1: seeds idempotentes de roles, permissions e role_permissions
--
-- Pré-requisito: 0001_initial_schema.sql (ou a migração Alembic equivalente)
-- já aplicado.
--
-- Importante:
--   - NÃO cria nenhum usuário administrativo nem qualquer credencial.
--     Autenticação é externa (Supabase Auth); este banco não possui tabela
--     de senhas.
--   - NÃO insere nenhum dado de patrimônio (bens, unidades reais, etc.).
--   - Todas as inserções usam ON CONFLICT DO NOTHING, portanto este script
--     pode ser reexecutado sem duplicar dados ou falhar.

BEGIN;

-- ============================================================
-- roles
-- ============================================================
INSERT INTO roles (code, name, description, active) VALUES
    ('ADM', 'Administrador', 'Acesso administrativo completo ao sistema (gestão de usuários, papéis, integrações e todos os módulos).', true),
    ('USER', 'Usuário', 'Usuário operacional padrão, com acesso de leitura/escrita a bens, inventários e movimentações dentro do escopo de suas unidades.', true),
    ('RH', 'Recursos Humanos', 'Perfil de apoio para gestão de responsáveis por bens e consulta de relatórios, dentro do escopo de suas unidades.', true)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- permissions
-- ============================================================
INSERT INTO permissions (code, description, resource, action) VALUES
    ('assets.read',            'Consultar bens patrimoniais.',                                   'assets',        'read'),
    ('assets.create',          'Cadastrar novos bens patrimoniais.',                              'assets',        'create'),
    ('assets.update',          'Atualizar dados de bens patrimoniais.',                           'assets',        'update'),
    ('assets.delete',          'Excluir (logicamente) bens patrimoniais.',                        'assets',        'delete'),
    ('assets.export',          'Exportar listagens de bens patrimoniais.',                        'assets',        'export'),
    ('units.read',              'Consultar unidades organizacionais.',                             'units',         'read'),
    ('units.create',            'Cadastrar/editar unidades organizacionais.',                      'units',         'create'),
    ('rooms.manage',            'Gerenciar salas e locais de guarda de bens.',                     'rooms',         'manage'),
    ('responsible.read',        'Consultar pessoas responsáveis por bens.',                        'responsible',   'read'),
    ('responsible_link.manage', 'Vincular/desvincular responsáveis a bens.',                       'responsible',   'manage'),
    ('inventory.create',        'Criar campanhas de inventário.',                                  'inventory',     'create'),
    ('inventory.check',         'Realizar conferência de itens em um inventário.',                 'inventory',     'check'),
    ('movements.create',        'Solicitar movimentações (transferências) de bens.',               'movements',     'create'),
    ('movements.approve',       'Aprovar/rejeitar movimentações de bens.',                         'movements',     'approve'),
    ('reports.read',            'Consultar relatórios.',                                           'reports',       'read'),
    ('exports.create',          'Solicitar exportações de dados.',                                 'exports',       'create'),
    ('imports.execute',         'Executar importações manuais de dados.',                         'imports',       'execute'),
    ('sync.execute',            'Executar sincronizações com sistemas de origem externos.',        'sync',          'execute'),
    ('audit.read',              'Consultar trilhas de auditoria.',                                 'audit',         'read'),
    ('users.manage',            'Gerenciar usuários do sistema.',                                  'users',         'manage'),
    ('roles.manage',            'Gerenciar papéis (roles) e suas permissões.',                     'roles',         'manage'),
    ('integrations.manage',     'Gerenciar integrações com sistemas externos.',                    'integrations',  'manage'),
    ('system.manage',           'Gerenciar configurações gerais do sistema.',                       'system',        'manage')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- role_permissions
-- ============================================================

-- ADM: todas as permissions existentes.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ADM'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- USER: subconjunto operacional (escopo de unidade é aplicado pelo
-- backend via user_unit_access, não pelo banco).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
    'assets.read',
    'assets.create',
    'assets.update',
    'assets.export',
    'units.read',
    'rooms.manage',
    'responsible.read',
    'responsible_link.manage',
    'inventory.create',
    'inventory.check',
    'movements.create',
    'reports.read',
    'exports.create'
)
WHERE r.code = 'USER'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- RH: consulta e vínculo de responsáveis, dentro do escopo de unidade
-- aplicado pelo backend.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
    'assets.read',
    'units.read',
    'responsible.read',
    'responsible_link.manage',
    'reports.read',
    'exports.create'
)
WHERE r.code = 'RH'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
