// =============================================================================
// SISPAT-AGU — activation-redirect.ts
// =============================================================================
// Rede de segurança para e-mails do Supabase que caem na RAIZ (Site URL) em vez
// de `/ativar-conta`. Converte o que chegou na raiz no destino FIXO
// `/ativar-conta`, preservando apenas o necessário:
//
//   `/?token_hash=..&type=..`        -> `/ativar-conta?token_hash=..&type=..`
//   `/?code=..[&type=..]`            -> `/ativar-conta?code=..[&type=..]`   (PKCE, F2)
//   `/#access_token=..&type=..`      -> `/ativar-conta#<hash em allowlist>`  (legado, F6)
//   `/?error=..&error_code=..`       -> `/ativar-conta?error_code=..[&type=..]` (F1)
//
// Destino SEMPRE fixo (nunca vindo da URL — sem open redirect) e só parâmetros
// de uma allowlist, validados por formato (`activation-link.ts`); `error_description`
// (texto livre do provedor) é descartado. Link fora de formato => `null`, sem
// redirecionar. A autoridade sobre o token continua sendo do Supabase
// (`verifyOtp`/`exchangeCodeForSession` em `/ativar-conta`).
//
// Por que isso importa (F6): sem este desvio, um link LEGADO de recuperação
// caindo na raiz fazia o SDK criar a sessão e a pessoa entrava no sistema SEM
// trocar a senha. O desvio aqui é o caminho normal; a garantia que não depende
// de tempo nem de URL está em `recovery-session.ts` (sessão de recuperação
// nunca libera o app).
// =============================================================================

import {
  parseActivationLink,
  serializeLegacyHash,
  type ActivationIntent,
} from "@/lib/activation-link";

export const ACTIVATION_ROUTE = "/ativar-conta";

/** Destino em `/ativar-conta` para a intenção lida, ou `null` (não desviar). */
export function activationRouteFor(intent: ActivationIntent | null): string | null {
  if (!intent) return null;
  switch (intent.kind) {
    case "token":
      return `${ACTIVATION_ROUTE}?token_hash=${encodeURIComponent(intent.tokenHash)}&type=${intent.mode}`;
    case "code":
      return (
        `${ACTIVATION_ROUTE}?code=${encodeURIComponent(intent.code)}` +
        (intent.mode === "unknown" ? "" : `&type=${intent.mode}`)
      );
    case "legacy":
      return null; // tratado por `activationRedirectFor` (precisa do hash cru)
    case "error": {
      // Só erro REAL do provedor justifica desviar: link malformado segue o
      // comportamento normal da rota (login).
      if (intent.source !== "provider" || !intent.code) return null;
      return (
        `${ACTIVATION_ROUTE}?error_code=${intent.code}` +
        (intent.mode === "unknown" ? "" : `&type=${intent.mode}`)
      );
    }
  }
}

/**
 * Destino em `/ativar-conta` para a URL da raiz (`search` + `hash`), ou `null`
 * quando não há nada de ativação. Função PURA.
 */
export function activationRedirectFor(search: string, hash = ""): string | null {
  const intent = parseActivationLink(search, hash);
  if (intent?.kind === "legacy") {
    const legacyHash = serializeLegacyHash(hash);
    return legacyHash ? `${ACTIVATION_ROUTE}${legacyHash}` : null;
  }
  return activationRouteFor(intent);
}
