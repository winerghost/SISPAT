// =============================================================================
// SISPAT-AGU — auth-errors.ts
// =============================================================================
// Classifica erros do `signInWithPassword` do Supabase Auth em mensagens
// GENÉRICAS (nunca o texto do provedor). Distingue falha de rede/servidor,
// limite de tentativas (429) e credencial. Só UX: não enumera contas — qualquer
// 4xx que não seja 429 vira "E-mail ou senha incorretos.".
// =============================================================================

export type SignInErrorKind = "network" | "rate_limit" | "credentials";

interface SignInErrorLike {
  status?: number;
  code?: string;
  name?: string;
}

export const SIGN_IN_MESSAGES: Record<SignInErrorKind, string> = {
  network: "Não foi possível conectar. Tente novamente.",
  rate_limit: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  credentials: "E-mail ou senha incorretos.",
};

export function classifySignInError(error: unknown): SignInErrorKind {
  const e: SignInErrorLike = typeof error === "object" && error !== null ? error : {};
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === 429 || e.code === "over_request_rate_limit") return "rate_limit";
  // Rede fora do ar, CORS, timeout ou erro de servidor (SDK: AuthRetryableFetchError).
  if (
    e.name === "AuthRetryableFetchError" ||
    status === undefined ||
    status === 0 ||
    status >= 500
  ) {
    return "network";
  }
  return "credentials";
}

export function signInErrorMessage(error: unknown): string {
  return SIGN_IN_MESSAGES[classifySignInError(error)];
}
