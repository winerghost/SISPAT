# Checklist de implantação — por funcionalidade

Complementa `docs/deployment/checklist-deploy-vps.md` (checklist canônico).
Nada aqui autoriza implantar em produção sem autorização explícita do
responsável.

## Estado de implantação (2026-10-29)

- Aplicação no ar desde 2026-10-20 (VPS Hostinger + CloudPanel + Cloudflare,
  vhost do CloudPanel; o Compose não ocupa 80/443 — publica só em
  `127.0.0.1:${BACKEND_PORT}` e `127.0.0.1:${FRONTEND_PORT}`).
- Rodadas posteriores implantadas: 2026-10-21 (Auditoria, Vínculos de Unidades,
  Relatórios) e 2026-10-29 (convite à prova de scanner, exclusão/anonimização
  de usuário, filtros de `/relatorios`, correções do `/ativar-conta` e
  logomarca sazonal do cabeçalho público — commits `be2a16c` e `6823803`).
- Banco: `alembic_version` = `0019_user_soft_delete`, que é o head do código
  (`backend/migrations/versions/0019_user_soft_delete.py`). Não há migração
  pendente de aplicação nem de carimbo.
- **Falta validar em produção** (aguardando validação do responsável): login
  real de ADM com MFA, convite real com entrega por e-mail, exclusão de usuário
  e os filtros novos de `/relatorios`. Já existem 2 ADMs ativos (consulta
  read-only em 2026-10-30), então criar um 2º ADM não é mais pré-requisito.

Comando padrão de rebuild e subida (executado pelo responsável, na VPS, só com
autorização explícita):

```
cd /opt/SISPAT && git pull --ff-only
docker compose build backend frontend && docker compose up -d backend frontend
docker compose ps        # backend, frontend e redis healthy
```

Se só o backend mudou: `docker compose build backend && docker compose up -d backend`
e depois `docker compose up -d` (recriar o backend derruba o frontend, que tem
`depends_on: backend`). Mudança em qualquer `NEXT_PUBLIC_*` ou em asset
importado pelo código do frontend exige rebuild do **frontend** (as variáveis e
os assets entram no bundle no build).

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

## Convite à prova de scanner + `/ativar-conta` (implantado em 2026-10-29)
- [ ] Novas variáveis de ambiente: **nenhuma**, mas `EMAIL_ENABLED=true` e o
      bloco `EMAIL_*` (host, porta, usuário, senha, remetente, segurança,
      domínios permitidos) passaram a ser **requisito do convite**: a entrega é
      feita pelo backend (`backend/app/services/invite_delivery.py`) e
      `POST /api/v1/users/invite` aborta com 502 se a entrega falhar.
- [ ] Migrações de banco: **nenhuma**.
- [ ] Rebuild necessário nas DUAS pontas (backend e frontend):
      `docker compose build backend frontend && docker compose up -d backend frontend`.
- [ ] Vhost: a `location ~ ^/api/v1/(users/invite|users/activate-invite|security/mfa/)`
      de `infra/cloudpanel/vhost.ueato-cloudpanel.conf` já cobre as rotas; sem
      mudança de porta.
- [ ] Validação pendente (responsável): convite real para um e-mail de teste; o
      link precisa chegar como `/ativar-conta?token_hash=...&type=invite` e
      NENHUM `verify` deve aparecer nos logs antes do clique.
- [ ] Logs sem segredos após o teste:
      `docker compose logs --since 30m backend | grep -iE 'token_hash|Bearer|eyJ|service_role|secret|password'`
      deve voltar vazia.

## Exclusão lógica + anonimização de usuário (implantado em 2026-10-29)
- [ ] Migração: `0019_user_soft_delete` — **já aplicada e carimbada**
      (`alembic_version` = `0019_user_soft_delete`). Espelho:
      `backend/migrations/sql/0022_user_soft_delete.sql`. Cria
      `users.deleted_at`, `users.deleted_by`, `users.anonymized_at`, o CHECK
      `ck_users_deleted_requires_anonymized` e a permissão `users.delete`
      (vinculada ao perfil ADM).
- [ ] Ordem obrigatória para quem replicar em outro ambiente: aplicar o DDL
      ANTES de subir a imagem nova do backend (o modelo `User` e a consulta de
      autenticação já selecionam as três colunas).
- [ ] Backup antes de qualquer DDL:
      `pg_dump "$DATABASE_URL" --schema=public -Fc -f backup-pre-0019-$(date +%F-%H%M).dump`
      (ou backup/PITR confirmado no painel do Supabase, com data e hora
      registradas).
- [ ] Reversão (só com autorização explícita; perde as colunas):
      `docker compose run --rm --no-deps backend alembic downgrade 0018_equipment_classification`
      — ou o `DOWNGRADE_SQL` do próprio arquivo de migração no SQL Editor.
- [ ] Novas variáveis de ambiente e portas: **nenhuma**.
- [ ] Rebuild: backend e frontend (rota `POST /api/v1/users/<id>/delete` e as
      ações novas da tela de usuários).
- [ ] Validação pendente (responsável): login real (exercita a checagem de
      `deleted_at` em `require_auth`), exclusão de um usuário de teste com
      confirmação por e-mail digitado + TOTP, e confirmação de que o
      `audit_logs` do excluído continua íntegro.
- [x] Segundo ADM: já existem **2 ADMs ativos** (consulta read-only em
      2026-10-30; também 4 RH ativos de 5 cadastrados). Pré-requisito
      atendido — a exclusão de usuário pode ser exercitada sem risco de
      cair na proteção do último ADM. Conferir na tela antes de agir.

## Filtros de `/relatorios` (implantado em 2026-10-29)
- [ ] Novas variáveis de ambiente, migrações e portas: **nenhuma**.
- [ ] Rebuild: backend e frontend.
- [ ] As opções de vínculo (`bond_status`) são dinâmicas (valores distintos no
      escopo do ator), logo dependem dos dados importados. Com os Bens já
      importados a lista não vem mais vazia: em 2026-11-01 o acervo tem
      Servidor (733), Terceirizado (70), Ocioso (32) e Estagiario (11), além
      de 223 bens sem vínculo.
- [ ] Validação pendente (responsável): os três selects novos em `/relatorios`
      e uma exportação CSV/XLSX por perfil ADM e RH.
- [ ] Exportação passa pela `location /api/` do vhost, com
      `proxy_read_timeout 60s`: exportação muito grande pode ser cortada antes
      do gunicorn (180 s). Medir o tempo da primeira exportação real.

## Logomarca do cabeçalho público (revertida em 2026-11-01)

> A troca sazonal implantada em 2026-10-29 **foi revertida em 2026-11-01**: o
> cabeçalho público voltou à logomarca oficial da AGU. Esta seção deixa de ser
> um item a validar e passa a registrar a reversão.

- [x] `frontend/src/components/brand/agu-logo.tsx` voltou ao estado oficial:
      importa `@/assets/brand/agu-logo.png`, dimensionada por largura
      (`h-auto w-36 brightness-125 sm:w-44`, 144 px / 176 px), sem
      `mix-blend-screen`. O `alt` nunca mudou, então os testes que acham a
      imagem pelo nome acessível seguem válidos.
- [x] O ativo temporário `frontend/src/assets/brand/halloween-agu.png` foi
      apagado; `src/assets/brand/` tem só o oficial, com o mesmo SHA-256 de
      sempre. `og/route.tsx` e `(publico)/layout.tsx` não mudaram em nenhum
      dos dois sentidos.
- [ ] **Pendente:** como o asset é importado pelo código, a reversão só vale em
      produção depois do rebuild do frontend:
      `docker compose up -d --build frontend`.
- [x] Novas variáveis de ambiente, migrações e portas: **nenhuma**.
- Vale para `/login` **e** `/ativar-conta` — o componente serve o layout de
  todas as rotas públicas.
