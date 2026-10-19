# Checklist de implantação — por funcionalidade

Complementa `docs/deployment/checklist-deploy-vps.md`. Nada aqui autoriza
implantar em produção sem autorização explícita.

## Tela Perfis e Permissões (`/administracao/perfis-permissoes`)
- [ ] Novas variáveis de ambiente: **nenhuma**.
- [ ] Migrações de banco: **nenhuma**.
- [ ] Novas portas / alterações no Compose: **nenhuma**.
- [ ] Backend publicado com `GET /api/v1/admin/roles` e
      `GET /api/v1/admin/permissions` (ADM + AAL2 + `roles.manage`; sem query
      string).
- [ ] Permissão `roles.manage` atribuída ao perfil ADM no banco alvo (seed
      existente).
- [ ] CSP padrão existente (nonce) inalterada: a tela não usa scripts/estilos
      inline novos, `dangerouslySetInnerHTML` nem origens adicionais.
- [ ] CORS: só `GET` (já permitido).
- [ ] Verificação pós-implantação: ADM com MFA (AAL2) vê perfis e matriz; USER e
      RH veem "Acesso restrito"; nenhuma resposta de erro expõe detalhes.

## Convite de usuários (e-mail e redirecionamento)
- [ ] Supabase Auth › URL Configuration: Site URL e Redirect URLs no domínio
      final (HTTPS), incluindo `https://<domínio>/ativar-conta`.
- [ ] Template "Invite user" atualizado conforme
      `docs/deploy/email-template-convite.md` (token_hash; exige autorização do
      dono do projeto Supabase).
- [ ] SMTP próprio configurado no Supabase (o embutido dá `429 email rate
      limit`); SPF/DKIM/DMARC do domínio remetente.
- [ ] `INVITE_ALLOWED_REDIRECT_URLS` com o 1º item `https://<domínio>/ativar-conta`
      (o backend recusa o convite se não terminar em `/ativar-conta`).
- [ ] Teste real: convidar e-mail de teste, link só é consumido após o clique.
