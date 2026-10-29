# Plano de ação — convite à prova de scanner, exclusão de usuários e correções do /ativar-conta

Data: 2026-10-28. Autorizado pelo responsável na mesma data.

Contexto: em 2026-10-27 o reset de senha foi corrigido (Plano B: o backend
monta e envia o e-mail) e **validado em produção em 2026-10-28**. Ver
`PLANO_ACAO_RESET_SENHA_2026-10-27.md`, §7. Este plano cobre o que ficou.

## 0. Ordem de execução e por quê

1. **Frente A — convite** (backend). Desbloqueia tudo: hoje só existe **1 ADM
   ativo e 0 usuários USER**, e criar usuário é por convite. Sem convite
   confiável não há 2º ADM, e sem 2º ADM não se testa exclusão sem risco de
   ficar sem administrador.
2. **Frente B — exclusão de usuário** (backend + migração).
3. **Frente C — exclusão na tela** (frontend) — contrato definido em §2, pode
   correr em paralelo com B.
4. **Frente D — correções F1–F6 do `/ativar-conta`** (frontend). Independente.
5. **Frente E — QA/segurança** depois de A–D.

## 1. Frente A — convite à prova de scanner

Problema: `POST /auth/v1/invite` usa o template do painel, cujo
`{{ .ConfirmationURL }}` aponta para `/auth/v1/verify` — GET de **uso único**.
Scanner de antivírus de e-mail abre o link segundos após o envio, gasta o token
e (fluxo implícito) fica com access/refresh token válidos. Provado nos logs em
2026-10-27 às 18:54:43. É o MESMO defeito já corrigido no reset de senha.

Solução: espelhar o Plano B.

- `supabase_admin_client.py`: novo método que chama
  `POST /auth/v1/admin/generate_link` com
  `{"type": "invite", "email": ..., "data": {"name": ...}, "redirect_to": ...}`.
  Valida `redirect_to` contra `invite_allowed_redirect_urls_list` ANTES de
  qualquer rede (como `generate_recovery_token_hash` já faz). Precisa devolver
  **duas** coisas: o `hashed_token` E o `id` do usuário criado no Auth —
  `invite_service.create_invite` depende desse `id` como `auth_user_id`
  (`invite_service.py:335-343`). `action_link` e `email_otp` são descartados e
  nunca logados.
- Novo módulo de entrega (ou generalização de `password_reset_delivery.py`):
  monta `<redirect_to>?token_hash=...&type=invite` com `quote(safe="")`,
  revalida com `validate_link` contra a allow-list e envia por
  `send_email_safely`. O template fixo `invite` já existe em
  `services/email/templates.py`.
- `invite_service.create_invite` passa a usar o caminho novo.
  `invite_user_by_email` fica no cliente apenas com aviso de não usar (como
  `send_password_recovery`), porque testes de segurança existentes o cobrem.

Garantias a preservar (idênticas ao reset): token e URL nunca em log,
auditoria, resposta HTTP ou exceção; link só no corpo do e-mail.

Atenção: `generate_link` com `type=invite` **falha para e-mail já cadastrado**,
igual ao `/invite`. O comportamento e a mensagem para o ADM não devem mudar.

Requisito operacional: já atendido — `EMAIL_ENABLED=true` com Gmail
(`smtp.gmail.com:587`, starttls) está em produção desde 2026-10-28, e
`EMAIL_FROM` é idêntico ao `EMAIL_USER`.

## 2. Frente B — exclusão de usuário (contrato autoritativo)

Desenho aprovado em 2026-10-27: **exclusão lógica + anonimização**, nunca
física.

### Rota

`POST /api/v1/users/<uuid:user_id>/delete` — POST, não DELETE, por dois
motivos: é o padrão das outras ações do módulo (`/deactivate`, `/activate`,
`/revoke`, `/revoke-sessions`) e corpo em DELETE é removido por alguns proxies
(temos Nginx do CloudPanel + Cloudflare na frente).

Corpo: `{"version": <int>, "confirm_text": "<e-mail exato do alvo>"}`.
Schema Pydantic `extra="forbid"`, sem nulos explícitos, como os demais.

Respostas: `200` com o resumo do usuário; `409` em `version` divergente;
`400` em `confirm_text` que não bate; `404` idêntico para alvo inexistente e
alvo fora do escopo de unidade (sem vazamento); `423`/`403` conforme os guards
já usados pelo módulo.

### Guardas obrigatórias (todas já têm precedente no serviço)

- ADM com AAL2 (`require_aal2`), permissão `users.*`.
- `require_unit_access` + `apply_unit_scope` no alvo.
- Nunca o próprio ator (`SelfChangeForbiddenError`).
- Nunca o último ADM ativo (`_ensure_not_last_admin`).
- Controle otimista por `version`.
- Rate limit por ator e por alvo, no padrão do `password-reset`.

### Efeitos (uma transação)

1. `deleted_at`, `deleted_by`, `anonymized_at` preenchidos.
2. `active = false`, `sessions_revoked_at = now()`.
3. Anonimização: `name` → rótulo fixo; `email` → valor **único e não
   roteável** (a coluna é `NOT NULL UNIQUE`); `phone` → `NULL`;
   `avatar_object_key` → `NULL` com o objeto removido do bucket privado;
   `auth_user_id` → `NULL`.
4. Supabase Auth: **APAGAR** a identidade
   (`DELETE /auth/v1/admin/users/{id}` com `should_soft_delete: false`), não
   banir. Decisão revista em 2026-10-28: banir deixava o e-mail ocupado no
   GoTrue e, como o convite passou a usar `generate_link type=invite` (que
   recusa e-mail já cadastrado), reconvidar a mesma pessoa dava 502 — a
   exclusão ficava pela metade. Apagar a linha leva embora sessões, refresh
   tokens, identidades e fatores MFA de uma vez. Falha do provedor **não**
   pode desfazer a exclusão local: registrar `USER_PROVIDER_SYNC_FAILED` e
   seguir, como já faz o `revoke_access`.
5. `audit_logs.actor_user_id` **preservado** — é o motivo de a linha não poder
   ser apagada. Evento de auditoria sem dado pessoal (e-mail mascarado).
6. `role_links` e `UserUnitAccess` removidos.

### O que mais precisa mudar

- **Listagens e consultas**: todo `GET` do módulo passa a filtrar
  `deleted_at IS NULL`. Varrer o repositório de usuários inteiro, não só a
  listagem.
- **Autenticação**: `app/auth/supabase_auth.py` precisa recusar usuário
  excluído com 401, do mesmo jeito que já recusa inativo. Sem isso um JWT
  ainda válido continua entrando.
- **Convite/`create_invite`**: a idempotência defensiva por `email`/
  `auth_user_id` (`invite_service.py:345+`) precisa saber lidar com linha
  excluída — o e-mail anonimizado é outro, então o e-mail original volta a
  estar livre para um convite novo. Confirmar que é isso que acontece.

### Migração

Nova `backend/migrations/versions/0019_user_soft_delete.py` + espelho
`backend/migrations/sql/0022_user_soft_delete.sql` (a numeração do espelho é
deslocada em +3 desde sempre: `0018_equipment_classification.py` ↔
`0021_equipment_classification.sql`).

**O banco está carimbado em `0018` e dev = prod.** NÃO rodar `alembic upgrade`
nem aplicar nada. O padrão do projeto é o responsável executar o espelho `.sql`
no SQL Editor e carimbar `alembic_version` por `UPDATE`. Entregar os dois
arquivos idênticos em efeito e parar aí.

## 3. Frente C — exclusão na tela

`frontend/src/components/features/users/`:

- Nova ação no `user-account-actions.tsx` (hoje são 5: `deactivate`,
  `activate`, `sessions`, `password`, `mfa`). Confirmação **forte**: digitar o
  e-mail exato do alvo, no padrão do `confirm-action-dialog.tsx`, com o texto
  dizendo que é irreversível e que o histórico de auditoria é preservado.
- Adicionar também o botão do **`POST /users/{id}/revoke`**, que existe no
  backend e nunca teve interface.
- `frontend/src/lib/users-api.ts`: as duas funções novas.
- Usuário excluído sai da listagem; se aparecer em algum lugar (histórico,
  movimentação antiga), mostrar o rótulo anonimizado, nunca o e-mail original.
- `pending` da mutação precisa bloquear duplo envio, como já é feito.
- DESIGN.md é a fonte do visual e não se altera. 320px–1920px sem rolagem
  horizontal, WCAG 2.2 AA, foco preso no modal, `prefers-reduced-motion`.

## 4. Frente D — correções F1–F6 do `/ativar-conta`

Detalhadas em `PLANO_ACAO_RESET_SENHA_2026-10-27.md` §P2. Resumo:

| Id | Defeito |
|---|---|
| F1 | Erro na QUERY STRING não é lido (só o hash) → texto de "convite" em erro de recovery, e `error_description` fica na URL/histórico |
| F2 | Link PKCE `?code=` não tratado → link VÁLIDO exibido como inválido |
| F3 | Sem `type` na URL, `mode` cai para `invite` |
| F4 | `EXPIRED_CODES` + qualquer `status 401` → tudo vira "expirou" |
| F5 | `tokenHashRef = null` ANTES do `await verifyOtp`: falha de rede descarta o token |
| F6 | Link legado de recovery na raiz LOGA a pessoa sem trocar a senha |

F6 é o mais grave dos seis. Restrição de segurança em F4: `user_not_found`
**não** pode ganhar mensagem própria (oráculo de enumeração de usuários); só
podem se diferenciar `otp_expired` × `access_denied`/`bad_jwt` ×
`over_request_rate_limit`.

Fora da lista, no backend: F7 (docstring de `settings.py:590` contradiz o
código) e F8 (produção sobe com `PASSWORD_RESET_REDIRECT_URL` inútil e degrada
em silêncio).

## 5. Frente E — QA e segurança (depois de A–D)

- Exclusão: escalonamento de privilégio, último ADM, autoexclusão, IDOR em
  alvo de outra unidade (404 idêntico), integridade do `audit_logs` após a
  exclusão, irreversibilidade da anonimização, JWT de usuário excluído → 401.
- Convite: token nunca em log/auditoria/resposta; redirect fora da allow-list
  não chama a rede; e-mail já cadastrado mantém a mensagem antiga.
- `frontend/e2e/password-recovery-link-functional.spec.ts` (erro na query
  string, `?code=`, token já consumido, GET de scanner não consome, duplo
  clique = 1 `/verify`, mensagens distintas, axe em 320/768/1920).
- Os 2 `toHaveURL` instáveis de `activate-invite-functional.spec.ts:202` e
  `:214` devem usar o `FIRST_COMPILE_TIMEOUT` de
  `users-functional.spec.ts:31-33`.
- Bug PRÉ-EXISTENTE: `backend/tests/test_db_static.py:942-943` tem bytes 0x08
  onde deveria haver `\b`, deixando duas guardas antidestrutivas VAZIAS.
  Corrigir escapando certo (remover o `\b` geraria falso positivo em
  `deleted_at`).
- Guardas estáticas (`test_db_static`, `test_sec_route_inventory`): declarar a
  rota e as colunas novas. **Nunca relaxar asserção** para fazer passar.
- `scripts/security-audit.sh` antes do deploy.

## 6. Implantação

- Frentes A, B: rebuild do backend —
  `cd /opt/SISPAT && docker compose build backend && docker compose up -d backend`.
- Frentes C, D: rebuild do frontend —
  `docker compose build frontend && docker compose up -d frontend`. As três
  `NEXT_PUBLIC_*` são fixadas no BUILD: confirmar que estão no `.env` antes.
- Migração da frente B: executada pelo responsável, nunca pelo agente.
- git é manual: o responsável commita e faz `git pull --ff-only` na VPS. No
  `build`, `COPY app ./app` **sem** `CACHED` é a prova de que o código novo
  subiu.
