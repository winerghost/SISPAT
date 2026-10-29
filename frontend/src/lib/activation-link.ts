// =============================================================================
// SISPAT-AGU — activation-link.ts
// =============================================================================
// Leitura PURA do link de convite/recuperação (sem rede, storage, DOM ou
// relógio): recebe `search`/`hash` e devolve a INTENÇÃO do link. Usada pela
// página `/ativar-conta` e pela rede de segurança da raiz
// (`activation-redirect.ts` + `auth-guard.tsx`), para que as duas leiam o link
// exatamente do mesmo jeito.
//
// Formatos tratados — `type` pode vir na QUERY ou no HASH (a query vence, igual
// ao `parseParametersFromURL` do supabase-js):
//
//   1. `?token_hash=<hash>&type=invite|recovery` — fluxo ATUAL (desde
//      2026-10-28 o próprio backend monta o link). Credencial de USO ÚNICO:
//      quem a consome é o clique da pessoa, nunca o carregamento da página
//      (scanner de antivírus de e-mail faz GET em todo link).
//   2. `?code=<code>` (+ `&type=`) — PKCE. Também de uso único. O cliente do
//      navegador é IMPLÍCITO (sem `flowType`), então o SDK NÃO processa
//      `?code=` sozinho: antes desta correção um link VÁLIDO aparecia como
//      inválido (F2).
//   3. `#access_token=...&type=...` — legado implícito: o SDK consome o hash ao
//      ser instanciado e a página só ADOTA a sessão daquele access_token.
//   4. `?error=...&error_code=...` ou `#error=...` — erro do provedor. Antes era
//      lido SÓ do hash: erro na query string virava "link de convite inválido"
//      e o `error_description` ficava na URL e no histórico (F1).
//
// `type` ausente/desconhecido => `mode: "unknown"`: a tela usa texto NEUTRO em
// vez de afirmar que é convite (F3).
//
// Nada aqui é mecanismo de segurança: valida só FORMATO (tamanho/charset) para
// não repassar lixo adiante. A autoridade sobre o token é do Supabase/backend.
// =============================================================================

/** Convite, recuperação ou indeterminado (link sem `type` reconhecível). */
export type ActivationMode = "invite" | "recovery" | "unknown";

/** Modo conhecido — o único que pode ir para `verifyOtp({ type })`. */
export type KnownActivationMode = Exclude<ActivationMode, "unknown">;

/**
 * Por que o link não pode ser usado:
 *  - `expired`: uso único já consumido ou prazo vencido (`otp_expired`);
 *  - `invalid`: o link não confere (`access_denied`, `bad_jwt`, formato);
 *  - `rate_limited`: tentativas demais (`over_request_rate_limit`);
 *  - `session`: a validação do link deixou de existir nesta aba.
 */
export type ActivationFailure = "expired" | "invalid" | "rate_limited" | "session";

export type ActivationIntent =
  | { kind: "token"; tokenHash: string; mode: KnownActivationMode }
  | { kind: "code"; code: string; mode: ActivationMode }
  | { kind: "legacy"; accessToken: string; mode: ActivationMode }
  | {
      kind: "error";
      failure: ActivationFailure;
      mode: ActivationMode;
      /** `provider` = erro vindo do Supabase; `link` = formato inaceitável. */
      source: "provider" | "link";
      /** Código do provedor já normalizado (minúsculas, `[a-z0-9_]`), ou null. */
      code: string | null;
    };

/** Credencial de uso único (`token_hash`/`code`): tamanho máximo aceito. */
export const CREDENTIAL_MAX_LENGTH = 512;

/** Charset dos tokens do Supabase (base64url + separadores usados em JWT). */
const CREDENTIAL_FORMAT = /^[A-Za-z0-9._~+/=-]+$/;

/** Código de erro do provedor: tokens curtos em snake_case. */
const ERROR_CODE_FORMAT = /^[a-z0-9_]{1,64}$/;

/** Parâmetros do hash do fluxo implícito que podem ser repassados. */
const LEGACY_HASH_FIELDS = [
  "access_token",
  "refresh_token",
  "expires_in",
  "expires_at",
  "token_type",
  "type",
] as const;

export function isKnownActivationMode(value: string | null): value is KnownActivationMode {
  return value === "invite" || value === "recovery";
}

/** Valida só o FORMATO de uma credencial de uso único. */
export function isPlausibleCredential(value: string | null): value is string {
  return !!value && value.length <= CREDENTIAL_MAX_LENGTH && CREDENTIAL_FORMAT.test(value);
}

function normalizeErrorCode(value: string | null): string | null {
  if (!value) return null;
  const code = value.trim().toLowerCase();
  return ERROR_CODE_FORMAT.test(code) ? code : null;
}

/**
 * Traduz o `error_code`/`error` do Supabase em uma causa. Só três causas se
 * distinguem (`otp_expired`, `access_denied`/`bad_jwt`, `over_request_rate_limit`);
 * qualquer outra cai em `invalid`. Em especial NÃO existe causa própria para
 * `user_not_found`: numa página pública isso seria oráculo de enumeração de
 * usuários (mesma regra de `activation-errors.ts`).
 */
export function failureFromErrorCode(code: string | null): ActivationFailure {
  const normalized = normalizeErrorCode(code);
  if (normalized === "otp_expired") return "expired";
  if (normalized === "over_request_rate_limit") return "rate_limited";
  return "invalid";
}

/**
 * Intenção do link, ou `null` quando a URL não tem NADA de ativação (visita
 * direta a `/ativar-conta`, raiz sem parâmetros...).
 */
export function parseActivationLink(search: string, hash = ""): ActivationIntent | null {
  const query = new URLSearchParams(search.replace(/^\?/, ""));
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  // Query vence o hash (mesma precedência do supabase-js).
  const read = (key: string): string | null => query.get(key) ?? hashParams.get(key);

  const rawType = read("type");
  const mode: ActivationMode = isKnownActivationMode(rawType) ? rawType : "unknown";

  // 1) Erro do provedor vence tudo (pode chegar na query OU no hash).
  const errorCode = read("error_code");
  const error = read("error");
  if (errorCode || error || read("error_description")) {
    return {
      kind: "error",
      failure: failureFromErrorCode(errorCode ?? error),
      mode,
      source: "provider",
      code: normalizeErrorCode(errorCode ?? error),
    };
  }

  const malformed = (): ActivationIntent => ({
    kind: "error",
    failure: "invalid",
    mode,
    source: "link",
    code: null,
  });

  // 2) Fluxo atual: token_hash + type conhecido.
  const tokenHash = read("token_hash");
  if (tokenHash !== null) {
    if (!isPlausibleCredential(tokenHash) || mode === "unknown") return malformed();
    return { kind: "token", tokenHash, mode };
  }

  // 3) PKCE: `?code=` (o `type` costuma não vir — resolvido após a troca).
  const code = read("code");
  if (code !== null) {
    if (!isPlausibleCredential(code)) return malformed();
    return { kind: "code", code, mode };
  }

  // 4) Legado implícito: o SDK é quem troca o hash por sessão.
  const accessToken = hashParams.get("access_token");
  if (accessToken) {
    if (!isPlausibleCredential(accessToken)) return malformed();
    return { kind: "legacy", accessToken, mode };
  }

  // 5) Só `type=` (sem credencial): link quebrado, mas é um link de ativação.
  if (rawType !== null) return malformed();
  return null;
}

/**
 * Reserializa o hash do fluxo implícito a partir de uma ALLOWLIST (nada de
 * repassar a URL crua). Devolve "" quando não há `access_token` utilizável.
 */
export function serializeLegacyHash(hash: string): string {
  const source = new URLSearchParams(hash.replace(/^#/, ""));
  const out = new URLSearchParams();
  for (const field of LEGACY_HASH_FIELDS) {
    const value = source.get(field);
    if (value === null) continue;
    if (field === "type") {
      if (isKnownActivationMode(value)) out.set(field, value);
      continue;
    }
    if (field === "expires_in" || field === "expires_at") {
      if (/^\d{1,19}$/.test(value)) out.set(field, value);
      continue;
    }
    if (isPlausibleCredential(value)) out.set(field, value);
  }
  return out.get("access_token") ? `#${out.toString()}` : "";
}
