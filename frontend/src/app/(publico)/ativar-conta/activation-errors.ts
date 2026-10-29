// =============================================================================
// /ativar-conta — mapeador puro de erros do Supabase Auth para mensagens fixas
// =============================================================================
// NUNCA exibe a mensagem crua do provedor (pode estar em inglês, vazar detalhe
// ou refletir entrada). Só `code`/`status`/`name` decidem o texto. Módulo sem
// dependências (testável sem navegador) e sem acesso a senha/token.
//
// Correção F4 — antes, `EXPIRED_CODES` juntava `otp_expired`, `bad_jwt`,
// `user_not_found`, `session_not_found`, `refresh_token_*` e QUALQUER
// `status === 401` numa única resposta "o link expirou". Isso escondeu por dias
// o diagnóstico de um incidente real (o token era consumido por scanner de
// e-mail, não expirava). Agora cada causa tem um destino próprio:
//
//   | causa                         | kind           |
//   |-------------------------------|----------------|
//   | `otp_expired`                 | `expired`      |
//   | `access_denied`, `bad_jwt`, … | `link_invalid` |
//   | `over_request_rate_limit`/429 | `rate_limited` |
//   | sessão/refresh ausente, 401   | `session_lost` |
//   | falha de transporte/5xx       | `network`      |
//   | qualquer outra                | `generic`      |
//
// RESTRIÇÃO DE SEGURANÇA (não negociável): numa página PÚBLICA, mensagem
// própria para `user_not_found` seria um ORÁCULO DE ENUMERAÇÃO DE USUÁRIOS
// (permitiria descobrir quais e-mails existem). Esse código — e qualquer outro
// que fale sobre a existência/estado da conta (`email_not_confirmed`,
// `user_banned`, `email_exists`…) — cai deliberadamente em `generic`. Só se
// distinguem as três causas do LINK (`otp_expired`, `access_denied`/`bad_jwt`,
// `over_request_rate_limit`), que nada dizem sobre a conta.
//
// `network` existe por causa da correção F5: falha de rede NÃO é link inválido,
// então a credencial de uso único é preservada para uma nova tentativa.
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
  | "link_invalid"
  | "rate_limited"
  | "session_lost"
  | "network"
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
  link_invalid: "Este link não é válido. Peça um novo a um administrador.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  session_lost: "A validação deste link não está mais ativa. Abra o link do e-mail novamente.",
  network:
    "Não foi possível falar com o servidor agora. Verifique sua conexão e tente novamente — o link continua válido.",
  generic: "Não foi possível definir a senha agora. Tente novamente.",
};

export const PASSWORD_TOO_SHORT_MESSAGE = `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;

/** Link de uso único já consumido ou com prazo vencido. */
const EXPIRED_CODES = new Set(["otp_expired"]);

/** O link/credencial não confere (não é questão de prazo). */
const INVALID_LINK_CODES = new Set([
  "access_denied",
  "bad_jwt",
  "bad_code_verifier",
  "flow_state_not_found",
  "flow_state_expired",
  "validation_failed",
]);

/** A sessão que validava o link deixou de existir (não é o link em si). */
const SESSION_LOST_CODES = new Set([
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "no_authorization",
]);

/**
 * Erro de transporte do SDK: `_request` converte fetch abortado/CORS/5xx em
 * `AuthRetryableFetchError` (status 0 ou 5xx). Ver `network` acima.
 */
const NETWORK_ERROR_NAMES = new Set(["AuthRetryableFetchError"]);

/** Lê `code`/`status`/`name` de forma defensiva de qualquer valor lançado/retornado pelo SDK. */
export function readAuthErrorFields(error: unknown): {
  code: string | null;
  status: number | null;
  name: string | null;
} {
  if (typeof error !== "object" || error === null) return { code: null, status: null, name: null };
  const raw = error as { code?: unknown; status?: unknown; name?: unknown };
  const name = typeof raw.name === "string" && raw.name.length <= 64 ? raw.name : null;
  let code = typeof raw.code === "string" && raw.code.length <= 64 ? raw.code : null;
  // O SDK converte `session_not_found` em AuthSessionMissingError (sem `code`).
  if (code === null && name === "AuthSessionMissingError") code = "session_not_found";
  return { code, status: typeof raw.status === "number" ? raw.status : null, name };
}

export function classifyAuthError(error: unknown): AuthFailure {
  const { code, status, name } = readAuthErrorFields(error);
  const make = (kind: AuthFailureKind): AuthFailure => ({
    kind,
    message: AUTH_FAILURE_MESSAGES[kind],
    code,
    status,
  });

  if (code === "weak_password") return make("weak_password");
  if (code === "same_password") return make("same_password");
  if (code === "insufficient_aal") return make("mfa_required");
  // 429 é limite de tentativas, não falha de transporte: vem antes de `network`.
  if (code === "over_request_rate_limit" || status === 429) return make("rate_limited");
  // Falha de rede/servidor: o link NÃO foi consumido (F5).
  if (name !== null && NETWORK_ERROR_NAMES.has(name)) return make("network");
  if (status === 0 || (status !== null && status >= 500)) return make("network");
  if (code !== null && EXPIRED_CODES.has(code)) return make("expired");
  if (code !== null && INVALID_LINK_CODES.has(code)) return make("link_invalid");
  if (code !== null && SESSION_LOST_CODES.has(code)) return make("session_lost");
  // 401 sem código conhecido = sessão da validação sumiu (nunca "expirou").
  if (code === null && status === 401) return make("session_lost");
  return make("generic");
}

/** Registra no console SOMENTE `code`/`status` (nunca senha, token ou mensagem crua). */
export function logAuthFailure(failure: Pick<AuthFailure, "code" | "status">, context: string): void {
  console.warn(`[ativar-conta] falha em ${context}`, { code: failure.code, status: failure.status });
}
