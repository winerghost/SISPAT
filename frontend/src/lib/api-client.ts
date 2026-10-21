// =============================================================================
// SISPAT-AGU — api-client.ts
// =============================================================================
// Wrapper fetch tipado para falar com o backend Flask. Toda regra de negócio
// e validação crítica pertence ao backend (ver CLAUDE.md > Arquitetura) — este
// cliente é só a camada de transporte HTTP usada pelo frontend.
//
// Autenticação (auditoria 2026-10-13): o `Authorization: Bearer <token>` da
// sessão Supabase atual é anexado AUTOMATICAMENTE a toda chamada. O token só
// é enviado para a origem da API (NEXT_PUBLIC_API_URL): antes de anexar (ou de
// aceitar um `Authorization` explícito) a URL final tem a origem conferida
// (`assertApiOrigin`, auditoria F-1) e, em produção, exige-se https (exceto
// loopback). `path` é sempre relativo à API.
//
// Outras proteções:
//   - `credentials: "omit"`: a API usa Bearer, não cookie — não enviar
//     cookies ambientes elimina superfície de CSRF;
//   - `cache: "no-store"`: respostas com dados pessoais não ficam no cache HTTP;
//   - timeout padrão (AbortController) cobrindo headers E leitura do corpo;
//   - erros do backend no formato `{"error": {"code", "message"}}` expõem
//     `ApiError.code` (ex.: `AAL2_REQUIRED`); a UI NÃO deve renderizar
//     `message` vinda da API como HTML (React escapa texto — nunca usar
//     dangerouslySetInnerHTML com ela);
//   - 401 dispara o evento `sispat:unauthorized` (tratado por `AuthGuard`).
//
// Corpo: objetos simples viram JSON (`Content-Type: application/json`).
// `FormData` (upload multipart, ex.: foto de perfil) é enviado como está e SEM
// `Content-Type` manual — o navegador gera `multipart/form-data; boundary=…`.
// =============================================================================

import { getSupabaseClient } from "@/lib/supabase-client";

export const UNAUTHORIZED_EVENT = "sispat:unauthorized";
const DEFAULT_TIMEOUT_MS = 30_000;

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Código de erro do backend (`error.code`), ex.: `AAL2_REQUIRED`. */
  readonly code: string | undefined;
  /** Segundos do cabeçalho `Retry-After` (429/503), quando presente e válido. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    status: number,
    body?: unknown,
    code?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  /**
   * Corpo da requisição; objetos são serializados como JSON. `FormData` é
   * enviado sem serialização (multipart, boundary definido pelo navegador).
   */
  body?: unknown;
  /** Parâmetros de query string, anexados à URL. */
  searchParams?: Record<string, string | number | boolean | undefined>;
  /** Timeout em ms (padrão 30s). */
  timeoutMs?: number;
  /** `false` para NÃO anexar o token da sessão (padrão: anexa se houver). */
  auth?: boolean;
}

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function buildUrl(path: string, searchParams?: ApiRequestOptions["searchParams"]): string {
  return buildApiUrl(path, searchParams, API_BASE_URL);
}

/**
 * Monta a URL final. `apiBase` vazio/relativo => caminho relativo ao próprio
 * site. Lança se o resultado sair da origem de `apiBase` (ex.: `//evil.test/x`).
 */
export function buildApiUrl(
  path: string,
  searchParams: ApiRequestOptions["searchParams"],
  apiBase: string,
): string {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const placeholder = "http://localhost";
  const isAbsolute = /^https?:\/\//i.test(base);
  const url = new URL(`${base}${normalizedPath}`, isAbsolute ? undefined : placeholder);

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // Origem final deve ser a da API (absoluta) ou do próprio site (relativa;
  // o host fictício só satisfaz o construtor de URL).
  const expected = isAbsolute ? new URL(base).origin : placeholder;
  if (url.origin !== expected) {
    throw new ApiError("Destino de requisição inválido.", 0);
  }
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * Defesa em profundidade (F-1): só permite anexar credencial quando a origem
 * de `finalUrl` é a da API. Relativa => origem da página. Em produção exige
 * https, exceto loopback (desenvolvimento/E2E).
 */
export function assertApiOrigin(
  finalUrl: string,
  apiBase: string,
  pageOrigin: string,
  isProduction: boolean,
): void {
  const apiOrigin = /^https?:\/\//i.test(apiBase) ? new URL(apiBase).origin : pageOrigin;
  let target: URL;
  try {
    target = new URL(finalUrl, pageOrigin);
  } catch {
    throw new ApiError("Destino de requisição inválido.", 0);
  }
  if (target.origin !== apiOrigin) {
    throw new ApiError("Destino de requisição não autorizado a receber credenciais.", 0);
  }
  if (isProduction && target.protocol !== "https:" && !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new ApiError("Credenciais só podem trafegar por HTTPS.", 0);
  }
}

/** `Retry-After` em segundos (inteiro ou data HTTP), limitado a 24 h; inválido => undefined. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d{1,9}$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    seconds = Math.ceil((date - nowMs) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

async function getSessionAccessToken(): Promise<string | undefined> {
  if (typeof window === "undefined") return undefined;
  try {
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.access_token ?? undefined;
  } catch {
    // Supabase não configurado: segue sem token (o backend responderá 401).
    return undefined;
  }
}

async function request<TResponse>(
  path: string,
  { body, searchParams, headers, timeoutMs, auth = true, ...init }: ApiRequestOptions = {},
): Promise<TResponse> {
  const finalHeaders = new Headers(headers);
  const isMultipart = typeof FormData !== "undefined" && body instanceof FormData;

  if (body !== undefined && !isMultipart && !finalHeaders.has("Content-Type")) {
    finalHeaders.set("Content-Type", "application/json");
  }
  if (!finalHeaders.has("Accept")) {
    finalHeaders.set("Accept", "application/json");
  }

  const url = buildUrl(path, searchParams);

  if (auth && !finalHeaders.has("Authorization")) {
    const token = await getSessionAccessToken();
    if (token) finalHeaders.set("Authorization", `Bearer ${token}`);
  }
  // Vale também para `Authorization` explícito vindo do chamador (ex.: fetchMe).
  if (finalHeaders.has("Authorization") && typeof window !== "undefined") {
    assertApiOrigin(
      url,
      API_BASE_URL,
      window.location.origin,
      process.env.NODE_ENV === "production",
    );
  }

  const controller = new AbortController();
  // O timer cobre headers E leitura do corpo (F-2): só é limpo no `finally`.
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  let rawText: string;
  try {
    response = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      ...init,
      signal: controller.signal,
      headers: finalHeaders,
      body: serializeBody(body, isMultipart),
    });
    rawText = await response.text();
  } catch (cause) {
    throw new ApiError(
      "Falha de rede ao comunicar com a API. Verifique sua conexão e tente novamente.",
      0,
      cause,
    );
  } finally {
    clearTimeout(timer);
  }

  const parsedBody = rawText ? safeJsonParse(rawText) : undefined;

  if (!response.ok) {
    const { code, message } = extractError(parsedBody);
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { path } }));
    }
    throw new ApiError(
      message || `Erro ${response.status} ao chamar a API.`,
      response.status,
      parsedBody,
      code,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }

  return parsedBody as TResponse;
}

function serializeBody(body: unknown, isMultipart: boolean): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (isMultipart) return body as FormData;
  return JSON.stringify(body);
}

/** Lê `{"error": {"code", "message"}}` (padrão do backend) ou `{"message"}`. */
function extractError(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error : body;
  return {
    code: typeof nested.code === "string" ? nested.code : undefined,
    message: typeof nested.message === "string" ? nested.message : undefined,
  };
}

/** `true` quando o backend exige MFA concluído (sessão AAL2) para a operação. */
export function isAal2RequiredError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === "AAL2_REQUIRED";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface ApiFileResult {
  blob: Blob;
  contentType: string;
}

/**
 * `GET` que devolve um ARQUIVO (exportações CSV/XLSX). Mesmas proteções de
 * `request` (Bearer só para a origem da API, `credentials: "omit"`, `no-store`,
 * timeout cobrindo o corpo, 401 → evento, erros `{error:{code,message}}`), mas
 * o corpo de sucesso é lido como Blob. O token nunca vai em URL/storage.
 */
export async function requestFile(
  path: string,
  { searchParams, timeoutMs, accept }: { searchParams?: ApiRequestOptions["searchParams"]; timeoutMs?: number; accept?: string } = {},
): Promise<ApiFileResult> {
  const headers = new Headers({ Accept: accept ?? "*/*" });
  const url = buildUrl(path, searchParams);
  const token = await getSessionAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    if (typeof window !== "undefined") {
      assertApiOrigin(url, API_BASE_URL, window.location.origin, process.env.NODE_ENV === "production");
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 120_000);
  let response: Response;
  let blob: Blob;
  try {
    response = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal, headers });
    blob = await response.blob();
  } catch (cause) {
    throw new ApiError("Falha de rede ao comunicar com a API. Verifique sua conexão e tente novamente.", 0, cause);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = safeJsonParse(await blob.text());
    } catch {
      parsed = undefined;
    }
    const { code, message } = extractError(parsed);
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { path } }));
    }
    throw new ApiError(
      message || `Erro ${response.status} ao chamar a API.`,
      response.status,
      parsed,
      code,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }
  return { blob, contentType: (response.headers.get("Content-Type") ?? blob.type ?? "").toLowerCase() };
}

export const apiClient = {
  get: <TResponse>(path: string, options?: ApiRequestOptions) =>
    request<TResponse>(path, { ...options, method: "GET" }),
  post: <TResponse>(path: string, body?: unknown, options?: ApiRequestOptions) =>
    request<TResponse>(path, { ...options, method: "POST", body }),
  put: <TResponse>(path: string, body?: unknown, options?: ApiRequestOptions) =>
    request<TResponse>(path, { ...options, method: "PUT", body }),
  patch: <TResponse>(path: string, body?: unknown, options?: ApiRequestOptions) =>
    request<TResponse>(path, { ...options, method: "PATCH", body }),
  delete: <TResponse>(path: string, options?: ApiRequestOptions) =>
    request<TResponse>(path, { ...options, method: "DELETE" }),
};
