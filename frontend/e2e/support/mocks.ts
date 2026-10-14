import type { Page, Request, Route } from "@playwright/test";

// =============================================================================
// Mocks SINTÉTICOS do Supabase Auth e da API Flask para os testes e2e.
// =============================================================================
// Nenhum dado aqui é real: e-mails usam o TLD reservado `.invalid`, UUIDs são
// fixos e artificiais, tokens são JWTs falsos sem assinatura válida.
// Qualquer requisição para fora de localhost (inclusive para o Supabase/VPS
// reais) é ABORTADA — ver `installMocks`.
// =============================================================================

export const SUPABASE_URL = "http://127.0.0.1:54321";
export const API_URL = "http://127.0.0.1:5000/api";
/**
 * Chaves de storage da sessão: `sispat-auth` em sessionStorage (cliente atual,
 * ver src/lib/supabase-client.ts) e a chave padrão do supabase-js em
 * localStorage (versões anteriores). Semeamos as duas para não acoplar os
 * testes a esse detalhe de implementação.
 */
export const SESSION_STORAGE_KEY = "sispat-auth";
export const LEGACY_STORAGE_KEY = "sb-127-auth-token";

/** Marcador XSS inofensivo: se executar, define `window.__xss`. */
export const XSS_IMG = `<img src=x onerror="window.__xss=1">`;
export const XSS_SCRIPT = `<script>window.__xss=2</script>`;

export type Role = "ADM" | "USER" | "RH";

export interface MockOptions {
  /** Perfil devolvido por `GET /api/v1/me`. */
  role?: Role;
  /** AAL inicial informado por `/me` (o verify do MFA o promove para aal2). */
  aal?: "aal1" | "aal2";
  /** Se o usuário tem fator TOTP verificado (Supabase `user.factors`). */
  hasVerifiedFactor?: boolean;
}

interface MockState {
  role: Role;
  aal: "aal1" | "aal2";
  hasVerifiedFactor: boolean;
  calls: { method: string; url: string; body: unknown }[];
}

const USER_ID = "00000000-0000-4000-8000-0000000000e2";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function fakeJwt(aal: "aal1" | "aal2" = "aal2"): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      sub: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      aal,
      email: "pessoa.sintetica@exemplo.invalid",
      iat: now,
      exp: now + 86_400,
    }),
    "assinatura-ficticia-e2e",
  ].join(".");
}

function fakeUser(state: Pick<MockState, "hasVerifiedFactor">) {
  return {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "pessoa.sintetica@exemplo.invalid",
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    factors: state.hasVerifiedFactor
      ? [
          {
            id: "factor-totp-e2e",
            friendly_name: `Autenticador ${XSS_IMG}`,
            factor_type: "totp",
            status: "verified",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]
      : [],
  };
}

export function fakeSession(aal: "aal1" | "aal2" = "aal2", hasVerifiedFactor = true) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt(aal),
    refresh_token: "refresh-ficticio-e2e",
    token_type: "bearer",
    expires_in: 86_400,
    expires_at: now + 86_400,
    user: fakeUser({ hasVerifiedFactor }),
  };
}

/** Injeta uma sessão Supabase sintética no localStorage (uma vez por aba). */
export async function seedSession(page: Page, opts: MockOptions = {}): Promise<void> {
  const session = fakeSession(opts.aal ?? "aal2", opts.hasVerifiedFactor ?? opts.role === "ADM");
  await page.addInitScript(
    ([sessionKey, legacyKey, value]) => {
      // O marcador vive em sessionStorage (sobrevive a navegações na mesma
      // aba): a sessão é semeada só na primeira carga, permitindo testar o logout.
      if (window.sessionStorage.getItem("__e2e_seeded")) return;
      window.sessionStorage.setItem("__e2e_seeded", "1");
      window.sessionStorage.setItem(sessionKey, value);
      window.localStorage.setItem(legacyKey, value);
    },
    [SESSION_STORAGE_KEY, LEGACY_STORAGE_KEY, JSON.stringify(session)] as const,
  );
}

function corsHeaders(request: Request): Record<string, string> {
  const headers = request.headers();
  return {
    "access-control-allow-origin": headers["origin"] ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      headers["access-control-request-headers"] ?? "authorization,content-type,apikey,x-client-info",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

async function json(route: Route, status: number, body?: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...corsHeaders(route.request()), "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

function parseBody(request: Request): unknown {
  const raw = request.postData();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Dados sintéticos da prévia de importação
// ---------------------------------------------------------------------------

type Classification = "NOVO" | "EXISTENTE" | "DUPLICADO" | "INVALIDO" | "CONFLITANTE";

const LONG_DESCRIPTION =
  "Cadeira giratória sintética de teste com braços reguláveis, encosto em tela, base cromada de cinco pés, " +
  "rodízios de nylon e ajuste de altura a gás — descrição propositalmente longa para validar quebra de linha " +
  "em telas de 320px sem rolagem horizontal da página";

export const PREVIEW_ITEMS: {
  id: string;
  source_record_id: string;
  patrimony_number: string;
  description: string;
  classification: Classification;
  selected: boolean;
  validation_errors: string[] | null;
}[] = [
  ["NOVO", "000123", LONG_DESCRIPTION],
  ["NOVO", "000124", `Mesa sintética ${XSS_IMG}`],
  ["EXISTENTE", "000125", `Armário sintético ${XSS_SCRIPT}`],
  ["DUPLICADO", "000126", "Cadeira sintética duplicada na planilha"],
  ["INVALIDO", "", "Registro sintético sem número patrimonial"],
  ["CONFLITANTE", "000128", "Monitor sintético em conflito"],
  ["NOVO", "0001290000000000000000000000000000", "Patrimônio sintético com número muito longo sem espaços"],
  ["EXISTENTE", "000130", "Cadeira sintética existente"],
].map(([classification, num, description], index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  source_record_id: `linha-${index + 2}`,
  patrimony_number: num as string,
  description: description as string,
  classification: classification as Classification,
  selected: classification === "NOVO" || classification === "EXISTENTE",
  validation_errors:
    classification === "INVALIDO" ? ["numero_patrimonial ausente", `campo ${XSS_IMG} inválido`] : null,
}));

export const USERS = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Pessoa Sintética Administradora com Nome Bastante Longo para Teste",
    email: "administradora.sintetica.com.email.extremamente.longo@exemplo.invalid",
    active: true,
    roles: ["ADM"],
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    name: `Usuário ${XSS_IMG}`,
    email: "usuario.sintetico@exemplo.invalid",
    active: true,
    roles: ["USER"],
  },
  {
    id: "20000000-0000-4000-8000-000000000003",
    name: "Pessoa Sintética RH",
    email: "rh.sintetico@exemplo.invalid",
    active: false,
    roles: ["RH"],
  },
];

const PERMISSIONS: Record<Role, string[]> = {
  ADM: ["users.manage", "users.invite", "imports.execute"],
  USER: ["assets.read"],
  RH: ["assets.read"],
};

/**
 * Instala os mocks na página. Retorna o estado (inclui o log de chamadas
 * para asserções). Toda requisição externa não mockada é abortada.
 */
export async function installMocks(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const state: MockState = {
    role: opts.role ?? "ADM",
    aal: opts.aal ?? "aal2",
    hasVerifiedFactor: opts.hasVerifiedFactor ?? (opts.role ?? "ADM") === "ADM",
    calls: [],
  };

  // 1) Bloqueio de rede externa (registrado primeiro = menor prioridade).
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => route.abort("blockedbyclient"),
  );

  // 2) Supabase Auth sintético.
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = parseBody(request);
    state.calls.push({ method, url: url.pathname + url.search, body });

    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(request) });

    const path = url.pathname.replace(/^\/auth\/v1/, "");
    if (path === "/token" && url.searchParams.get("grant_type") === "password") {
      const email = (body as { email?: string } | undefined)?.email ?? "";
      if (email.startsWith("invalido")) {
        return json(route, 400, {
          code: "invalid_credentials",
          error: "invalid_grant",
          error_description: "Invalid login credentials",
          msg: "Invalid login credentials",
        });
      }
      return json(route, 200, fakeSession(state.aal, state.hasVerifiedFactor));
    }
    if (path === "/user" && method === "GET") return json(route, 200, fakeUser(state));
    if (path === "/user" && method === "PUT") return json(route, 200, fakeUser(state));
    if (path === "/logout") return json(route, 204);
    if (path === "/factors" && method === "POST") {
      return json(route, 200, {
        id: "factor-novo-e2e",
        type: "totp",
        friendly_name: "",
        totp: {
          qr_code:
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
          secret: "E2EFICTICIOSECRETAAAAAAAAAAAAAAAA",
          uri: "otpauth://totp/SISPAT-E2E:sintetico?secret=E2EFICTICIO",
        },
      });
    }
    const challenge = path.match(/^\/factors\/([^/]+)\/challenge$/);
    if (challenge) {
      return json(route, 200, {
        id: "challenge-e2e",
        type: "totp",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }
    const verify = path.match(/^\/factors\/([^/]+)\/verify$/);
    if (verify) {
      const code = (body as { code?: string } | undefined)?.code;
      if (code !== "123456") {
        return json(route, 422, { code: "mfa_verification_failed", msg: "Invalid TOTP code" });
      }
      state.aal = "aal2";
      return json(route, 200, fakeSession("aal2", true));
    }
    return json(route, 404, { msg: `rota Supabase não mockada: ${method} ${path}` });
  });

  // 3) API Flask sintética.
  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = parseBody(request);
    state.calls.push({ method, url: url.pathname + url.search, body });

    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(request) });

    // Como o backend real: sem Bearer => 401 (exceto ativação, que também exige).
    const auth = request.headers()["authorization"] ?? "";
    if (!auth.startsWith("Bearer ")) {
      return json(route, 401, { error: { code: "UNAUTHENTICATED", message: "Não autenticado" } });
    }

    const path = url.pathname.replace(/^\/api/, "");

    if (path === "/v1/me") {
      return json(route, 200, {
        id: USER_ID,
        name: "Pessoa Sintética",
        email: "pessoa.sintetica@exemplo.invalid",
        roles: [state.role],
        permissions: PERMISSIONS[state.role],
        current_aal: state.aal,
        mfa_required: state.role === "ADM",
      });
    }

    if (path === "/v1/users" && method === "GET") {
      if (state.role !== "ADM") return json(route, 403, { error: { code: "FORBIDDEN", message: "Proibido" } });
      return json(route, 200, { total: USERS.length, page: 1, page_size: 20, users: USERS });
    }

    if (path === "/v1/users/invite" && method === "POST") {
      const email = (body as { email?: string } | undefined)?.email ?? "";
      if (email.startsWith("duplicado")) {
        return json(route, 409, { error: { code: "INVITE_PENDING", message: "Convite pendente" } });
      }
      return json(route, 201, {
        id: "30000000-0000-4000-8000-000000000001",
        email,
        name: (body as { name?: string }).name,
        intended_role_code: (body as { intended_role_code?: string }).intended_role_code,
        status: "PENDING",
        unit_ids: (body as { unit_ids?: string[] }).unit_ids,
      });
    }

    if (path === "/v1/users/activate-invite" && method === "POST") {
      return json(route, 200, { role: "USER", units: [] });
    }

    if (/^\/v1\/users\/[^/]+\/revoke$/.test(path)) return json(route, 204);
    if (/^\/v1\/security\/mfa\/factors\/[^/]+$/.test(path)) return json(route, 204);

    if (path === "/v1/imports/google-sheets/preview" && method === "POST") {
      const count = (c: Classification) => PREVIEW_ITEMS.filter((i) => i.classification === c).length;
      return json(route, 201, {
        preview_id: "40000000-0000-4000-8000-000000000001",
        summary: {
          total: PREVIEW_ITEMS.length,
          novo: count("NOVO"),
          existente: count("EXISTENTE"),
          duplicado: count("DUPLICADO"),
          invalido: count("INVALIDO"),
          conflitante: count("CONFLITANTE"),
        },
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    if (/^\/v1\/imports\/google-sheets\/preview\/[^/]+\/items$/.test(path)) {
      const status = url.searchParams.get("status");
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("page_size") ?? 20);
      const filtered = PREVIEW_ITEMS.filter(
        (i) =>
          (!status || i.classification === status) &&
          (!search ||
            i.patrimony_number.toLowerCase().includes(search) ||
            i.description.toLowerCase().includes(search)),
      );
      return json(route, 200, {
        total: filtered.length,
        page,
        page_size: pageSize,
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
      });
    }

    if (path === "/v1/imports/google-sheets/confirm" && method === "POST") {
      const ids = (body as { selected_item_ids?: string[] }).selected_item_ids ?? [];
      return json(route, 200, {
        sync_job_id: "50000000-0000-4000-8000-000000000001",
        created: ids.length,
        updated: 0,
        ignorados: 0,
        falhas: [],
      });
    }

    return json(route, 404, { error: { code: "NOT_FOUND", message: `não mockado: ${method} ${path}` } });
  });

  return state;
}

/** Espera o React hidratar (handlers ligados) antes de interagir. */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return !!main && Object.keys(main).some((key) => key.startsWith("__react"));
  });
}

/** Garante que nenhum marcador XSS executou e nenhum <img src=x> foi injetado. */
export async function expectNoXss(page: Page): Promise<{ executed: unknown; injectedImgs: number }> {
  return page.evaluate(() => ({
    executed: (window as unknown as { __xss?: unknown }).__xss,
    injectedImgs: document.querySelectorAll('img[src="x"]').length,
  }));
}
