# Ativação de conta por convite (/ativar-conta)

## Problema
Scanners de e-mail fazem GET automático no link do convite e consomem o token
de uso único; o clique do usuário então dá `otp_expired`.

## Fluxo atual (token_hash)
O e-mail traz `<RedirectTo>?token_hash=<hash>&type=invite`.

1. A página lê `token_hash`/`type` de `window.location.search`, remove-os da
   URL (`history.replaceState`) e guarda o hash só em memória (nunca
   localStorage/sessionStorage, nunca logado). Valida apenas o formato
   (`type=invite|recovery`, hash não vazio, até 512 caracteres, charset seguro).
2. Fase "confirm": texto + botão "Continuar". Carregar a página NÃO chama
   `/auth/v1/verify` (um GET de scanner não consome nada).
3. O clique chama `supabase.auth.verifyOtp({ token_hash, type: "invite" })`
   uma única vez. Sucesso -> fase "ready" (definir senha com `updateUser` e
   `POST /api/v1/users/activate-invite`). Falha -> fase "invalid" (mensagem
   genérica, sem detalhes do erro).

## Compatibilidade
- Legado: `#access_token=...&type=invite|recovery` continua tratado pelo SDK
  (`detectSessionInUrl`). A página só adota a sessão cujo `access_token` é
  IGUAL ao do hash lido na carga; uma sessão preexistente (de outra pessoa ou
  aba) nunca é aceita para definir senha. Sem `access_token` no hash -> fase
  "invalid". O fluxo PKCE (`?code=`) não é usado (o cliente é implícito).
- `#error=access_denied&error_code=otp_expired` (ou só `#error_code=...`) ->
  fase "invalid" com a mensagem "link já foi usado ou expirou, peça novo".
- Rede de segurança na raiz: `/?token_hash=<hash>&type=invite|recovery`
  (formato validado: type da lista, hash de 1 a 512 caracteres, charset seguro)
  redireciona (client-side, `router.replace`) para
  `/ativar-conta?token_hash=..&type=..`. Destino FIXO, só esses dois
  parâmetros são repassados (qualquer `next=`/`redirect=` é descartado), sem
  open redirect, e o token NÃO é consumido na raiz. Lógica em
  `src/lib/activation-redirect.ts`, aplicada por `src/lib/auth-guard.tsx`.
  Motivo: o convite era emitido sem `/ativar-conta` (o `redirect_to` ia no
  corpo do POST e o GoTrue só o lê da query) e caía no Site URL.

## Senha, MFA e erros
- Mínimo local de senha: 12 caracteres (constante `MIN_PASSWORD_LENGTH` em
  `ativar-conta/activation-errors.ts`; mesma política da pendência 1.4). A
  autoridade é o Supabase.
- Passo TOTP: após `verifyOtp` (ou sessão legada), `mfa.getAuthenticatorAssuranceLevel()`;
  `currentLevel=aal1` e `nextLevel=aal2` -> fase "mfa" (código do autenticador,
  `mfa.challengeAndVerify`) antes do formulário de senha. `insufficient_aal` no
  `updateUser` leva à mesma fase e, verificado o código, repete a troca. Nada é
  armazenado (código só no input; limpo ao concluir).
- Mapeador puro `classifyAuthError` (`activation-errors.ts`): `weak_password`,
  `same_password`, `insufficient_aal`, `session_not_found`/`otp_expired`/401
  (link expirado), 429 (limite) e fallback genérico. Nunca exibe a mensagem
  crua do provedor; no console só `code`/`status` (nunca senha/token).

## Acessibilidade
Cada fase tem um `h2` que recebe foco ao entrar (exceto na carga inicial);
o indicador de etapas só reflete fases reais ("confirm" conta como etapa
"Validar convite").

## Testes
`frontend/e2e/activate-invite-functional.spec.ts` (inclui unitários do
mapeador e do redirecionamento da raiz; mocks em `frontend/e2e/support/mocks.ts`:
`userUpdateErrors`, `verifySessionHasFactor`) e a tela `ativar-conta-confirmar`
em `frontend/e2e/support/screens.ts`. Backend: `backend/tests/test_supabase_admin_client.py`
(`redirect_to` na query, nunca no corpo).

## Referrer-Policy (M3)
`/ativar-conta` carrega `token_hash` na URL, que não pode vazar por `Referer`.
`frontend/next.config.ts` (`headers()`) envia `Referrer-Policy: no-referrer`
somente em `/ativar-conta` (e subcaminhos); a regra geral exclui essa rota
(`strict-origin-when-cross-origin` nas demais), evitando cabeçalho duplicado.
A CSP com nonce segue emitida por `src/middleware.ts`, sem alteração. O spec
`activate-invite-functional.spec.ts` verifica o cabeçalho (e a CSP presente).
