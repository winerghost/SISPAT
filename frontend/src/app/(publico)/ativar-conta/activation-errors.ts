// =============================================================================
// /ativar-conta — mapeador puro de erros do Supabase Auth para mensagens fixas
// =============================================================================
// NUNCA exibe a mensagem crua do provedor (pode estar em inglês, vazar detalhe
// ou refletir entrada). Só `code`/`status` decidem o texto. Módulo sem
// dependências (testável sem navegador) e sem acesso a senha/token.
// =============================================================================

/**
 * Tamanho mínimo da senha validado localmente. Espelha a política documentada
 * em docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md (1.4); a autoridade
 * continua sendo o Supabase Auth (que responde `weak_password`).
 */
export const MIN_PASSWORD_LENGTH = 12;

export type AuthFailureKind =
  | "weak_password"
  | "same_password"
  | "mfa_required"
  | "expired"
  | "rate_limited"
  | "generic";

export interface AuthFailure {
  kind: AuthFailureKind;
  message: string;
  /** Só `code`/`status` — únicos campos que podem ir para o console. */
  code: string | null;
  status: number | null;
}

export const AUTH_FAILURE_MESSAGES: Record<AuthFailureKind, string> = {
  weak_password: `A senha não atende aos requisitos de segurança (mínimo de ${MIN_PASSWORD_LENGTH} caracteres; evite senhas comuns ou já vazadas). Escolha outra senha.`,
  same_password: "A nova senha precisa ser diferente da senha atual.",
  mfa_required:
    "Para definir a senha, confirme primeiro o código do seu aplicativo autenticador.",
  expired: "Este link já foi usado ou expirou. Peça um novo a um administrador.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  generic: "Não foi possível definir a senha agora. Tente novamente.",
};

export const PASSWORD_TOO_SHORT_MESSAGE = `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;

const EXPIRED_CODES = new Set([
  "otp_expired",
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "bad_jwt",
  "no_authorization",
  "user_not_found",
]);

/** Lê `code`/`status` de forma defensiva de qualquer valor lançado/retornado pelo SDK. */
export function readAuthErrorFields(error: unknown): { code: string | null; status: number | null } {
  if (typeof error !== "object" || error === null) return { code: null, status: null };
  const raw = error as { code?: unknown; status?: unknown; name?: unknown };
  let code = typeof raw.code === "string" && raw.code.length <= 64 ? raw.code : null;
  // O SDK converte `session_not_found` em AuthSessionMissingError (sem `code`).
  if (code === null && raw.name === "AuthSessionMissingError") code = "session_not_found";
  return { code, status: typeof raw.status === "number" ? raw.status : null };
}

export function classifyAuthError(error: unknown): AuthFailure {
  const { code, status } = readAuthErrorFields(error);
  const make = (kind: AuthFailureKind): AuthFailure => ({
    kind,
    message: AUTH_FAILURE_MESSAGES[kind],
    code,
    status,
  });

  if (code === "weak_password") return make("weak_password");
  if (code === "same_password") return make("same_password");
  if (code === "insufficient_aal") return make("mfa_required");
  if (code === "over_request_rate_limit" || status === 429) return make("rate_limited");
  if ((code !== null && EXPIRED_CODES.has(code)) || status === 401) return make("expired");
  return make("generic");
}

/** Registra no console SOMENTE `code`/`status` (nunca senha, token ou mensagem crua). */
export function logAuthFailure(failure: Pick<AuthFailure, "code" | "status">, context: string): void {
  console.warn(`[ativar-conta] falha em ${context}`, { code: failure.code, status: failure.status });
}
