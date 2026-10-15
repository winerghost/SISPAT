-- SISPAT-AGU - Permissão settings.email.manage (somente ADM)
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado em banco
-- algum.
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0006_email_settings_permission.py -- o teste
-- backend/tests/test_db_static.py verifica que o bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- Pré-requisito: 0007_settings_ai_users.sql (Alembic 0005).
-- Idempotente (ON CONFLICT DO NOTHING) e aditivo. Sem BEGIN/COMMIT: no SQL
-- Editor do Supabase a transação explícita não gravou (ver backend/README.md).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

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
