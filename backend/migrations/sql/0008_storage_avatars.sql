-- SISPAT-AGU - Supabase Storage: bucket PRIVADO `avatars` (fotos de perfil)
--
-- NÃO APLICADO — requer autorização explícita. Não executado em banco algum
-- (nem no Supabase de produção, tocbtonqnahmtegfkrmn). Arquivo SQL-only: o
-- schema `storage` pertence ao Supabase, por isso NÃO há par Alembic (o
-- Alembic do projeto só gerencia o schema `public`).
--
-- Modelo de acesso:
--   - Somente o backend (Service Role Key, que ignora RLS) envia, apaga e
--     assina URLs (`app/integrations/supabase_storage_client.py`).
--   - Nenhum acesso para `anon`/`authenticated`: o bucket é privado e uma
--     política RESTRITIVA nega qualquer operação desses papéis no bucket,
--     mesmo que alguém crie no futuro uma política permissiva genérica.
--   - O navegador só recebe URLs assinadas de 300 s geradas pelo backend.
-- Limites do bucket (defesa em profundidade; o backend já recodifica para
-- WebP 512x512): 1 MiB por objeto e apenas image/webp.
-- Idempotente; não destrutivo.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 1048576, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND policyname = 'sispat_avatars_deny_client_roles'
    ) THEN
        CREATE POLICY sispat_avatars_deny_client_roles
            ON storage.objects
            AS RESTRICTIVE
            FOR ALL
            TO anon, authenticated
            USING (bucket_id <> 'avatars')
            WITH CHECK (bucket_id <> 'avatars');
    END IF;
END
$$;

COMMIT;

-- Verificação (somente leitura), após aplicar com autorização:
--   SELECT id, public, file_size_limit, allowed_mime_types
--     FROM storage.buckets WHERE id = 'avatars';
--   SELECT policyname, permissive, roles, cmd
--     FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
-- Reversão (manual, com autorização): remover a política
-- `sispat_avatars_deny_client_roles` e, se vazio, o bucket pelo painel.
