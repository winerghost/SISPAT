# Ativação de conta por convite (/ativar-conta)

## Problema
Scanners de e-mail fazem GET automático no link do convite e consomem o token
de uso único; o clique do usuário então dá `otp_expired`.

## Fluxo atual (token_hash)
O e-mail traz `<RedirectTo>?token_hash=<hash>&type=invite`.

1. A página lê `token_hash`/`type` de `window.location.search`, remove-os da
   URL (`history.replaceState`) e guarda o hash só em memória (nunca
   localStorage/sessionStorage, nunca logado). Valida apenas o formato
   (`type=invite`, hash não vazio, até 512 caracteres, charset seguro).
2. Fase "confirm": texto + botão "Continuar". Carregar a página NÃO chama
   `/auth/v1/verify` (um GET de scanner não consome nada).
3. O clique chama `supabase.auth.verifyOtp({ token_hash, type: "invite" })`
   uma única vez. Sucesso -> fase "ready" (definir senha com `updateUser` e
   `POST /api/v1/users/activate-invite`). Falha -> fase "invalid" (mensagem
   genérica, sem detalhes do erro).

## Compatibilidade
- Legado: `#access_token=...&type=invite` ou `?code=...` continuam tratados
  pelo SDK (`detectSessionInUrl`).
- `#error=access_denied&error_code=otp_expired` -> fase "invalid".
- A rota `/` não redireciona esse hash (rota protegida; evitar lógica de
  redirecionamento baseada em dados da URL).

## Acessibilidade
Cada fase tem um `h2` que recebe foco ao entrar (exceto na carga inicial);
o indicador de etapas só reflete fases reais ("confirm" conta como etapa
"Validar convite").

## Testes
`frontend/e2e/activate-invite-functional.spec.ts` e a tela
`ativar-conta-confirmar` em `frontend/e2e/support/screens.ts`.

## Referrer-Policy (M3)
`/ativar-conta` carrega `token_hash` na URL, que não pode vazar por `Referer`.
`frontend/next.config.ts` (`headers()`) envia `Referrer-Policy: no-referrer`
somente em `/ativar-conta` (e subcaminhos); a regra geral exclui essa rota
(`strict-origin-when-cross-origin` nas demais), evitando cabeçalho duplicado.
A CSP com nonce segue emitida por `src/middleware.ts`, sem alteração. O spec
`activate-invite-functional.spec.ts` verifica o cabeçalho (e a CSP presente).
