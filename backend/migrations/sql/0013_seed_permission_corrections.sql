-- SISPAT-AGU - Correção de menor privilégio: USER perde rooms.manage e
-- inventory.create
--
-- PENDENTE DE APLICAÇÃO MEDIANTE AUTORIZAÇÃO EXPLÍCITA. NÃO aplicado em banco
-- algum.
--
-- Espelha a migração Alembic
-- backend/migrations/versions/0010_seed_permission_corrections.py -- o teste
-- backend/tests/test_db_static.py verifica que cada bloco do upgrade está
-- presente aqui. Qualquer alteração deve ser feita nos dois arquivos.
--
-- O seed 0002 concedeu essas permissões ao USER; a matriz diz que são só do
-- ADM. As rotas já exigem papel ADM: não muda o comportamento da API.
-- Pré-requisito: 0012_unique_indexes_assets_movements.sql (Alembic 0009).
-- Idempotente. Sem BEGIN/COMMIT (SQL Editor do Supabase).
-- Downgrade: ver DOWNGRADE_SQL na migração Alembic correspondente.

DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'USER'
  AND p.code IN ('rooms.manage', 'inventory.create');
