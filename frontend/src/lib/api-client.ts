// =============================================================================
// SISPAT-AGU — api-client.ts
// =============================================================================
// Wrapper fetch tipado para falar com o backend Flask. Toda regra de negócio
// e validação crítica pertence ao backend (ver CLAUDE.md > Arquitetura) — este
// cliente é só a camada de transporte HTTP usada pelo frontend.
//
// Autenticação (auditoria 2026-10-13): o `Authorization: Bearer <token>` da
// sessão Supabase atual é anexado AUTOMATICAMENTE a toda chamada (antes só
// `users-api`/`session` o faziam manualmente; `imports-api` saía sem token).
// O token só é enviado para a URL da API (montada a partir de
// NEXT_PUBLIC_API_URL) — `path` é sempre relativo a ela.
//
// Outras proteções:
//   - `credentials: "omit"`: a API usa Bearer, não cookie — não enviar
//     cookies ambientes elimina superfície de CSRF;
//   - `cache: "no-store"`: respostas com dados pessoais não ficam no cache HTTP;
//   - timeout padrão (AbortController) para não pendurar a UI;
//   - erros do backend no formato `{"error": {"code", "message"}}` expõem
//     `ApiError.code` (ex.: `AAL2_REQUIRED`); a UI NÃO deve renderizar
//     `message` vinda da API como HTML (React escapa texto — nunca usar
//     dangerouslySetInnerHTML com ela);
//   - 401 dispara o evento `sispat:unauthorized` (tratado por `AuthGuard`).
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

  constructor(message: string, status: number, body?: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  /** Corpo da requisição; objetos são serializados automaticamente como JSON. */
  body?: unknown;
  /** Parâmetros de query string, anexados à URL. */
  searchParams?: Record<string, string | number | boolean | undefined>;
  /** Timeout em ms (padrão 30s). */
  timeoutMs?: number;
  /** `false` para NÃO anexar o token da sessão (padrão: anexa se houver). */
  auth?: boolean;
}

function buildUrl(path: string, searchParams?: ApiRequestOptions["searchParams"]): string {
  const base = API_BASE_URL.endsWith("/") ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${normalizedPath}`, base ? undefined : "http://localhost");

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // Quando API_BASE_URL é relativa (ex.: "/api"), retornamos apenas
  // pathname + search para evitar o host fictício "localhost" usado só
  // para satisfazer o construtor de URL.
  return base ? url.toString() : `${url.pathname}${url.search}`;
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

  if (body !== undefined && !finalHeaders.has("Content-Type")) {
    finalHeaders.set("Content-Type", "application/json");
  }
  if (!finalHeaders.has("Accept")) {
    finalHeaders.set("Accept", "application/json");
  }

  if (auth && !finalHeaders.has("Authorization")) {
    const token = await getSessionAccessToken();
    if (token) finalHeaders.set("Authorization", `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, searchParams), {
      credentials: "omit",
      cache: "no-store",
      ...init,
      signal: controller.signal,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiError(
      "Falha de rede ao comunicar com a API. Verifique sua conexão e tente novamente.",
      0,
      cause,
    );
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  const parsedBody = rawText
    ? safeJsonParse(rawText)
    : undefined;

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
    );
  }

  return parsedBody as TResponse;
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
