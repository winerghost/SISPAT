# UX — Ativação por convite e redefinição de senha (`/ativar-conta`)

Estado do código verificado em 2026-10-29. Rota pública (grupo `(publico)`, sem
shell do app e sem `AuthGuard`). Código:
`frontend/src/app/(publico)/ativar-conta/page.tsx`,
`frontend/src/app/(publico)/ativar-conta/activation-errors.ts`,
`frontend/src/lib/activation-link.ts`, `frontend/src/lib/activation-redirect.ts`,
`frontend/src/lib/recovery-session.ts`, `frontend/src/lib/auth-guard.tsx`.

A mesma tela atende **convite** e **recuperação de senha**: o que muda é o texto.
Nada aqui é mecanismo de segurança — a autoridade sobre o token é do Supabase e do
backend; a tela valida apenas FORMATO para não repassar lixo adiante.

## Problema que o desenho resolve
Scanners de antivírus de e-mail fazem GET automático em todo link. Um link de uso
único consumido pelo scanner chegava ao usuário como `otp_expired`. Por isso a
página **não consome nada ao carregar**: lê a credencial, limpa a URL
(`history.replaceState`), guarda o valor **só em memória** (ref; nunca
`localStorage`/`sessionStorage`, nunca logado) e mostra a fase "confirm". Quem
consome a credencial é o clique em "Continuar". Correção do incidente de
2026-10-27 — não remover.

## Leitura do link (`@/lib/activation-link`, função pura)
Sem rede, storage, DOM ou relógio: recebe `search`/`hash` e devolve a intenção.
A mesma função é usada pela rede de segurança da raiz, para as duas lerem igual.
`type` pode vir na query ou no hash (a query vence, como no `supabase-js`).

| Formato | Tratamento |
|---|---|
| `?token_hash=<hash>&type=invite\|recovery` | fluxo **atual** (desde 2026-10-28 o backend monta o link). Trocado por sessão com `verifyOtp({ token_hash, type })` **no clique** |
| `?code=<code>` (+ `&type=`) | **PKCE**. O cliente do navegador é implícito (sem `flowType`), então o SDK não processa `?code=` sozinho — antes da correção F2 um link válido aparecia como inválido. Agora o `code` segue o mesmo caminho: memória + `exchangeCodeForSession` no clique |
| `#access_token=…&type=…` | legado implícito: o SDK consome o hash ao ser instanciado (`detectSessionInUrl`). A página só **adota** a sessão cujo `access_token` é IDÊNTICO ao do hash lido na carga |
| `?error=…&error_code=…` ou `#error=…` | erro do provedor → fase "invalid". Antes só o hash era lido: erro na query virava texto de "convite" e o `error_description` ficava na URL e no histórico (F1) |

Sem `type` reconhecível o modo é **`unknown`** e os textos ficam **neutros** — a
tela nunca afirma que é convite sem saber (F3).

## Fases (`Phase`)
`checking` → `confirm` → (`mfa`) → `ready` → `activated`, ou `invalid`.

1. **checking** — esqueleto com "Validando seu link de convite…" / "…de
   recuperação…" / "…seu link…", conforme o modo.
2. **confirm** — título "Confirme a ativação" / "Confirme a redefinição" /
   "Confirme a validação do link", texto explicativo e botão **"Continuar"**.
   Carregar a página NÃO chama `verifyOtp`.
3. **mfa** (condicional) — se a sessão nasceu em `aal1` e a pessoa tem TOTP
   (`nextLevel = aal2`), pede o código do autenticador
   (`mfa.challengeAndVerify`, como no login) **antes** do formulário de senha.
   `insufficient_aal` no `updateUser` leva à mesma fase e, verificado o código,
   repete a troca. Nada do código ou do segredo é armazenado.
4. **ready** — formulário de senha ("Defina sua senha" / "Defina a nova senha").
5. **activated** — "Ativação concluída" / "Senha redefinida" / "Senha definida".
6. **invalid** — mensagem por causa **e** por modo, sem detalhe do provedor:
   expirado ("já foi usado ou expirou"), inválido, `rate_limited` ("Houve muitas
   tentativas com este link. Aguarde alguns minutos…") e `session` ("A validação
   deste link não está mais ativa. Abra o link do e-mail novamente.").

## Depois que a sessão existe
1. A pessoa define a senha (`supabase.auth.updateUser({ password })`).
2. **Convite**: em sucesso, `POST /api/v1/users/activate-invite` (sem corpo — o
   backend identifica o convite pela sessão). `404`/`409` = convite
   inválido/expirado, com mensagem clara.
3. **Recuperação**: NÃO chama `activate-invite` (o usuário já está ativo; daria
   404). Encerra a sessão local de recuperação — o próximo acesso passa pelo login
   e pelo MFA — mostra o sucesso e leva ao `/login`.
4. **Modo indeterminado**: tenta a ativação; se o backend disser que não há
   convite (404/409), a senha já foi trocada e o caso é tratado como redefinição.

## Sessão de recuperação não libera o sistema (correção F6)
`frontend/src/lib/recovery-session.ts`: o `supabase-js` anuncia
`PASSWORD_RECOVERY` (em vez de `SIGNED_IN`) quando a sessão veio de um link
`type=recovery`. O observador é registrado no MESMO bloco síncrono da criação do
cliente (`supabase-client.ts`), antes de o SDK processar a URL, para não existir
janela sem ouvinte. Guarda **apenas** o `access_token` dessa sessão, em memória do
módulo, para duas coisas: (1) o shell/guarda saberem que a sessão atual é de
recuperação e bloquearem o app; (2) `/ativar-conta` poder adotar essa sessão
quando a pessoa chega da raiz sem credencial na URL — e somente ela. Uma sessão
preexistente (de outra pessoa ou de outra aba) **nunca** é aceita para definir
senha.

## Rede de segurança na raiz
`frontend/src/lib/activation-redirect.ts`, aplicada por
`frontend/src/lib/auth-guard.tsx` (client-side, `router.replace`). Converte o que
cair na raiz (Site URL do Supabase) para o destino **FIXO** `/ativar-conta`:

```
/?token_hash=..&type=..    -> /ativar-conta?token_hash=..&type=..
/?code=..[&type=..]        -> /ativar-conta?code=..[&type=..]      (PKCE, F2)
/#access_token=..&type=..  -> /ativar-conta#<hash em allowlist>    (legado, F6)
/?error=..&error_code=..   -> /ativar-conta?error_code=..[&type=..] (F1)
```

Destino sempre fixo (nunca vindo da URL — sem *open redirect*), só parâmetros de
uma allowlist validados por formato, `error_description` (texto livre do provedor)
descartado, e o token **não** é consumido na raiz. Link fora de formato → não
redireciona. Motivo original: o convite era emitido sem `/ativar-conta` (o
`redirect_to` ia no corpo do POST e o GoTrue só o lê da query) e caía no Site URL.

## Senha e erros
- Mínimo local de 12 caracteres (`MIN_PASSWORD_LENGTH` em `activation-errors.ts`);
  a autoridade é o Supabase.
- Mapeador puro `classifyAuthError`: `weak_password`, `same_password`,
  `insufficient_aal`, `session_not_found`/`otp_expired`/401 (link expirado), 429
  (limite) e fallback genérico. **Nunca** exibe a mensagem crua do provedor; no
  console só `code`/`status` (nunca senha nem token), via `logAuthFailure`.
- Falha de **rede** não descarta a credencial: a pessoa pode clicar de novo (F5).

## Acessibilidade
- Cada fase tem um `h2` que recebe foco ao entrar (exceto na carga inicial).
- `StepIndicator` com três etapas reais, nomeadas por modo — convite: "Validar
  convite · Definir senha · Conta ativada"; recuperação: "Validar link · Nova
  senha · Senha redefinida"; indeterminado: "Validar link · Definir senha ·
  Concluído". A etapa final só aparece após a resposta real.
- Mensagens de erro em `AnimatedFormMessage` (`role="alert"`); campos via
  `AuthField`. Animações só de `@/components/animations` (150–200 ms),
  respeitando `prefers-reduced-motion`.
- Layout público (logomarca, nome da unidade, rodapé "Acesso apenas por convite"):
  `frontend/src/app/(publico)/layout.tsx` — ver `ANIMACOES.md`.

## Referrer-Policy (M3)
`/ativar-conta` pode carregar `token_hash`/`code` na URL, que não podem vazar por
`Referer`. `frontend/next.config.ts` (`headers()`) envia
`Referrer-Policy: no-referrer` em `/ativar-conta` e subcaminhos; a regra geral
exclui essa rota (`strict-origin-when-cross-origin` nas demais), evitando
cabeçalho duplicado. A CSP com nonce segue emitida por
`frontend/src/middleware.ts`, sem alteração.

## Testes (não reexecutados nesta data)
- `frontend/e2e/activate-invite-functional.spec.ts` — inclui unitários do
  mapeador de erros e do redirecionamento da raiz; mocks em
  `frontend/e2e/support/mocks.ts` (`userUpdateErrors`,
  `verifySessionHasFactor`).
- `frontend/e2e/password-recovery-link-functional.spec.ts` — regressão das
  correções **F1–F6** (erro na query, PKCE, modo sem `type`, causas distintas de
  falha, rede que não descarta a credencial e link legado de recuperação na raiz
  que não loga mais a pessoa). Afirma o invariante do incidente de 2026-10-27:
  carregar a página não chama `/auth/v1/verify` nem
  `/token?grant_type=pkce` — só o clique.
- Telas em `frontend/e2e/support/screens.ts` (responsivo 320–1920 + axe):
  `ativar-conta`, `ativar-conta-confirmar`, `ativar-conta-codigo`,
  `ativar-conta-recuperacao`, `ativar-conta-invalido` e
  `ativar-conta-erro-query`.
- Backend: `backend/tests/test_supabase_admin_client.py` (`redirect_to` na query,
  nunca no corpo).

## A confirmar
- O passo de MFA nesta tela só aparece quando o Supabase informa
  `nextLevel = aal2`; hoje apenas o perfil ADM faz o cadastro de TOTP, então o
  caminho é raro em produção.
