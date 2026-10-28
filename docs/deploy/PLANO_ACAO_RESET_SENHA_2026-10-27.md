# Plano de ação — "link de redefinição de senha chega expirado"

Data: 2026-10-27. Relato: em `/administracao/usuarios`, ao usar "Enviar
redefinição de senha", os usuários dizem que o link chega **expirado**.

Investigação feita por 4 frentes (frontend, backend, configuração/logs do
Supabase, QA/segurança). Nenhuma alteração foi aplicada em produção.

## 1. Causa raiz (confiança ~97%, com evidência nos logs)

**Não é expiração de tempo.** O token de uso único é consumido por um
**scanner de links de e-mail** (antivírus/anti-phishing do provedor do
destinatário) entre 2 e 4 segundos após o envio, antes de a pessoa abrir a
mensagem.

Evidência (`edge_logs` + `auth_logs` do projeto, 2026-10-27 UTC): nos 3 tokens
emitidos no dia, o PRIMEIRO acesso a `/auth/v1/verify` veio de IP da Amazon nos
EUA poucos segundos após o `mail.send`, retornou **303 com sucesso** e criou
sessão. Todos os acessos posteriores — inclusive os cliques do usuário real, de
IP da CLARO/BR, 6 a 11 min depois — falharam com:

```
403: Email link is invalid or has expired
error: One-time token not found
```

`One-time token not found` = token JÁ CONSUMIDO, não vencido.
`auth.one_time_tokens` estava com 0 linhas. Há também `HEAD /auth/v1/verify` de
`104.47.*` (Microsoft Exchange Online Protection / Safe Links) sem User-Agent.

Origem: o template "Reset Password" usa `{{ .ConfirmationURL }}`, que aponta
para `/auth/v1/verify` — GET de uso único. Documentado pelo Supabase em Email
Templates › "Email prefetching". **Aumentar o Email OTP Expiration não
resolve**: só amplia a janela do scanner. O template "Invite user" tem o mesmo
defeito (o convite de 18:54 foi consumido às 18:54:43).

## 2. Consequência de segurança (prioridade máxima)

O fluxo é **implícito**: o 303 do `/auth/v1/verify` devolve `access_token` e
`refresh_token` no fragmento. Os scanners receberam **credenciais válidas** e as
sessões ficaram ativas (`not_after = null`):

| Sessão | Usuário | IP | Criada (UTC) |
|---|---|---|---|
| `2f1fda49-…` | daniel.aires@agu.gov.br | `16.148.61.150` | 16:03:22 |
| `d7818abf-…` | daniel.aires@agu.gov.br | `54.202.47.122` | 16:07:22 |
| `da0ca594-…` | valeria.santos@agu.gov.br | `16.146.3.29` | 18:54:44 |

São `aal1`. Mitigação: "Encerrar sessões" na própria tela de usuários preenche
`sessions_revoked_at`, e `backend/app/auth/supabase_auth.py:199-217` rejeita com
401 inclusive tokens RENOVADOS (defesa UA-SESS-01/02, via menor instante do
claim `amr`). Resíduo: o refresh token segue vivo no GoTrue — sem acesso ao
backend, e as tabelas do `public` estão com RLS sem policy (deny-by-default).

## 3. Matriz de hipóteses

| # | Hipótese | Veredito |
|---|---|---|
| H1 | Página de destino não trata `type=recovery` | Refutada no repositório (trata desde 2026-10-21). **Confirmar o build publicado** — passo 6.1 |
| H2 | `password_reset_redirect_effective_url` = None → chamada sem redirect | **Refutada.** Com redirect inválido NADA é enviado (HTTP 200 `unavailable`); os e-mails chegaram |
| H3 | `redirect_to` fora das Redirect URLs do projeto → Site URL | **A confirmar no painel** (passo 4, P1) |
| H4 | Token de uso único consumido 2× | **CONFIRMADA** — pelo scanner de e-mail, não pela página |
| H5 | OTP expiry baixo / 2º envio invalida o 1º | Não é a causa. Contribui: 2 envios em 4 min e índice único `one_time_tokens_user_id_token_type_key` |
| H6 | UI traduz qualquer erro como "expirado" | **CONFIRMADA** — mascarou o diagnóstico |

## 4. Plano de ação

### P0 — Conter o incidente (sem rebuild, sem painel)

1. `/administracao/usuarios` → "Encerrar sessões" para `daniel.aires@agu.gov.br`
   e `valeria.santos@agu.gov.br`.
2. Conferir em `/administracao/auditoria` os eventos `USER_SESSIONS_REVOKED`.
3. **Não reenviar redefinição a ninguém** até o P1: cada envio invalida o token
   anterior.
4. Opcional (escrita em produção, exige autorização explícita): apagar as 3
   linhas de `auth.sessions` para revogar também no GoTrue.

### P1 — IMPLEMENTADO: o backend passou a enviar o e-mail (Plano B)

A edição de templates não está disponível no plano free deste projeto
(verificado pelo responsável em 2026-10-27), então a correção foi feita em
código, sem depender do painel:

- `app/integrations/supabase_admin_client.py` → `generate_recovery_token_hash`:
  `POST /auth/v1/admin/generate_link` (`type=recovery`), que cria o token e
  **não envia e-mail**. Devolve só o `hashed_token`; `action_link` e
  `email_otp` são descartados e nunca logados.
- `app/services/password_reset_delivery.py` (novo): monta
  `<redirect>?token_hash=...&type=recovery` (token escapado com
  `quote(safe="")`), revalida o link contra `INVITE_ALLOWED_REDIRECT_URLS` com
  `validate_link` e envia por `send_email_safely`.
- `app/services/email/templates.py`: novo template fixo `recovery`
  (texto + HTML com autoescape).
- `app/services/user_admin_service.py` → `send_password_reset` usa a entrega
  nova; `send_password_recovery` segue existindo apenas com aviso de não usar.

**Requisito operacional novo:** `EMAIL_ENABLED=true` com `EMAIL_HOST/PORT/USER/
PASSWORD/FROM` no `.env` da VPS. Com e-mail desligado a resposta é
`unavailable` com `reason=email_disabled` (nada é enviado em silêncio). Se
`EMAIL_ALLOWED_RECIPIENT_DOMAINS` estiver preenchida, precisa conter o domínio
dos usuários, senão o envio falha com `recipient_domain_not_allowed`.

Rebuild: só backend — `cd /opt/SISPAT && docker compose build backend &&
docker compose up -d backend`.

### P1-alternativo — Corrigir os templates (indisponível no plano free)

`Authentication › Emails › Templates`:

- **Reset Password** → HTML de `docs/deploy/email-template-reset-senha.md`.
  Link: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`
- **Invite user** → HTML de `docs/deploy/email-template-convite.md`.
  Link: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite`

Pré-requisito: build do frontend de 2026-10-21 ou posterior. Verificação que
não consome token: abrir
`https://ueato.revizzicar.com.br/ativar-conta?token_hash=teste123&type=recovery`
→ o título precisa ser **"Redefinir senha"**.

Cuidado: copiar o HTML do convite mantendo `type=invite` no template de reset
faz o GoTrue recusar o token com a MESMA mensagem de "expirado".

`Authentication › URL Configuration`: Site URL `https://ueato.revizzicar.com.br`
(sem barra final); Redirect URLs só `https://ueato.revizzicar.com.br/ativar-conta`.
**Feito pelo responsável em 2026-10-27.**

Observação: o **convite** (`POST /auth/v1/invite`) continua usando o template do
painel e, portanto, continua vulnerável ao scanner. Precisa do mesmo tratamento
do Plano B (`generate_link` com `type=invite` + envio pelo backend).

### P2 — Correções de código (exigem rebuild do frontend)

Nenhuma é a causa do relato; todas são defeitos reais.

| Id | Onde | Defeito |
|---|---|---|
| F1 | `ativar-conta/page.tsx` (`readAndCleanUrl`) | Erro na QUERY STRING não é lido (só o hash) → texto de "convite" num erro de recovery, e `error_description` fica na URL/histórico (sem `history.replaceState`) |
| F2 | idem | Link PKCE `?code=` não tratado → link VÁLIDO exibido como inválido |
| F3 | idem | Sem `type` na URL, `mode` cai para `invite` |
| F4 | `activation-errors.ts:44-52` | `EXPIRED_CODES` + qualquer `status 401` → tudo vira "expirou" |
| F5 | `page.tsx:270-273` | `tokenHashRef = null` ANTES do `await verifyOtp`: falha de rede descarta o token e vira "expirado" sem retry |
| F6 | `auth-guard.tsx:45` + `activation-redirect.ts:17-24` | Link legado de recovery na raiz LOGA a pessoa sem trocar a senha |
| F7 | `settings.py:590-597`, `.env.example:55-56`, `docs/architecture/modulo-configuracoes.md:268` | Docstring promete "senão a 1ª da lista"; o código devolve `None` |
| F8 | `settings.py:530-536` | Produção sobe com `PASSWORD_RESET_REDIRECT_URL` inútil e degrada em silêncio |

Restrição de segurança em F4: `user_not_found` **não** pode ganhar mensagem
própria na página pública (oráculo de enumeração de usuários). Só podem se
diferenciar `otp_expired` × `access_denied`/`bad_jwt` × `over_request_rate_limit`.

Rebuild: `cd /opt/SISPAT && docker compose build frontend && docker compose up -d frontend`

### P3 — Operacional

- SMTP próprio (hoje `noreply@mail.app.supabase.io`: ~2 e-mails/hora e só para
  membros do projeto) — item 1.3 das pendências.
- Leaked Password Protection está DESABILITADA (advisor WARN).
- Mascarar `token_hash` nos logs do nginx/CloudPanel (pendência B-1).
- `gitleaks` e `trivy` não instalados; `pip-audit` do `requirements-dev.txt`
  falha na execução (o do lock está limpo: `vulns: []` em 58 pacotes).

## 5. Testes de regressão (a criar)

- `backend/tests/test_sec_password_reset_link.py`: redirect fora da allow-list
  em variações mínimas (barra final, caixa, esquema) → `None`; sem redirect →
  falha explícita sem tocar o Supabase, com `reason=redirect_not_configured` e
  sem a URL no audit; `POST /recover` NUNCA retentado (rede, 5xx, 429) e
  `allow_redirects=False`; contrato de que a URL efetiva aponta para página que
  trata `recovery`.
- `frontend/e2e/password-recovery-link-functional.spec.ts`: erro na query string;
  `?code=` PKCE; token já consumido (sucesso na 1ª, `otp_expired` na 2ª); GET do
  scanner não consome; duplo clique = 1 `/verify`; mensagens distintas por causa;
  axe em 320/768/1920; `prefers-reduced-motion`.

Linha de base de 2026-10-27: 268 pytest passed no módulo de usuários; 40
Playwright de usuários passed; `activate-invite-functional` 34/36 com 4 workers
e 36/36 com `--workers=1` (contenção do `next dev`; os 2 `toHaveURL` de `:202` e
`:214` devem usar o `FIRST_COMPILE_TIMEOUT` de `users-functional.spec.ts:31-33`).

## 6. Validação manual (fecha o diagnóstico com evidência real)

1. Build publicado: abrir `/ativar-conta?token_hash=diagnostico&type=recovery` →
   título "Redefinir senha".
2. `grep -n 'INVITE_ALLOWED_REDIRECT_URLS\|PASSWORD_RESET_REDIRECT_URL' /opt/SISPAT/.env | cat -A`
   (procurar barra final, espaço, `\r`, `http://`).
3. Um único envio para um usuário de teste seu; **copiar o link sem clicar**.
   Esperado: `…/ativar-conta?token_hash=…&type=recovery`.
4. `Authentication › Logs`: NÃO deve haver `verify` antes do seu clique.
5. Clicar em "Continuar", definir senha de 12+ caracteres, entrar com ela.
6. Negativos: reabrir o mesmo link (deve dizer "recuperação", não "convite");
   conferir no Histórico do alvo que `USER_PASSWORD_RESET_SENT` não traz link,
   e-mail nem `redirect_to`.
