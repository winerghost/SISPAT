import { expect, test, type Page, type Request } from "@playwright/test";

import {
  API_URL,
  installMocks,
  SESSION_STORAGE_KEY,
  seedSession,
  waitForHydration,
} from "./support/mocks";

// =============================================================================
// Auditoria pré-deploy (2026-10-14) — "o sistema sabe que o usuário está logado
// antes de qualquer ação?" visto pelo navegador.
//
// O frontend NÃO é mecanismo de segurança (AuthGuard é só UX; middleware.ts só
// emite CSP). Estes testes provam o complemento do lado do cliente:
//   1. o HTML do servidor (SSR, sem JS) de toda rota protegida não traz conteúdo
//      protegido nem links administrativos — só o "Verificando sessão…";
//   2. toda chamada à API Flask sai com `Authorization: Bearer` (nenhuma ação
//      sem credencial);
//   3. um 401 do backend encerra a sessão local e volta ao /login;
//   4. tokens não vão para localStorage (FE-SESS-1: só sessionStorage);
//   5. sem open redirect após o login;
//   6. páginas públicas (/login, /ativar-conta) não chamam a API nem mostram
//      navegação administrativa.
// O nome do arquivo casa com o projeto "e2e" do playwright.config.ts
// (testMatch /functional\.spec\.ts/). NÃO executado pela auditoria; comando:
//   cd frontend && npx playwright test --project=e2e e2e/security-auth-functional.spec.ts
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const PROTECTED = [
  "/",
  "/configuracoes",
  "/configuracoes/seguranca",
  "/configuracoes/inteligencia-artificial",
  "/administracao/usuarios",
  "/administracao/importacao/google-sheets",
  "/administracao/importacao/cadastros",
  "/administracao",
  "/patrimonios",
  "/unidades",
  "/salas-localizacoes",
  "/responsaveis",
  "/inventarios",
  "/movimentacoes",
  "/relatorios",
  "/dashboard",
  "/dashboard/relatorio",
  "/importacoes",
  "/administracao/perfis-permissoes",
  "/administracao/vinculos-unidades",
  "/administracao/auditoria",
  "/administracao/integracoes",
  "/administracao/configuracoes-sistema",
];

const ADMIN_HREFS = ["/administracao", "/configuracoes/inteligencia-artificial"];

/** Marcadores dos dados sintéticos dos mocks: nunca podem estar no HTML do SSR. */
const SENSITIVE_MARKERS = ["@exemplo.invalid", "Pessoa Sintética", "users.manage", "access_token"];

function apiCalls(requests: Request[]): Request[] {
  return requests.filter((r) => r.url().startsWith(`${API_URL}/`) && r.method() !== "OPTIONS");
}

function trackRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => seen.push(request));
  return seen;
}

test.describe("SSR sem JavaScript: nada protegido sai do servidor", () => {
  for (const path of PROTECTED) {
    test(`${path}: HTML do servidor só tem o placeholder da guarda`, async ({ request }) => {
      const response = await request.get(path, { headers: { accept: "text/html" } });
      expect(response.status()).toBe(200);
      const html = await response.text();

      expect(html).toContain("Verificando sessão");
      for (const marker of SENSITIVE_MARKERS) expect(html).not.toContain(marker);
      for (const href of ADMIN_HREFS) expect(html).not.toContain(`href="${href}`);

      // CSP com nonce em toda resposta HTML (o `next dev` adiciona 'unsafe-eval').
      const csp = response.headers()["content-security-policy"] ?? "";
      expect(csp).toMatch(/script-src [^;]*'nonce-[^']+'/);
      expect(csp).toContain("frame-ancestors 'none'");
    });
  }
});

// FE-SSR-01 (latente, Informativa): páginas que são Server Components (hoje só
// "/") são renderizadas no servidor e seguem no payload RSC como `children` do
// AuthGuard, mesmo sem sessão. Hoje o conteúdo é estático (sem dados), mas uma
// página server-side que buscasse dados vazaria para quem não está logado.
// Esperado falhar até que páginas protegidas sejam "use client" ou a guarda
// passe a ser feita no servidor (cookies @supabase/ssr). Se este teste PASSAR,
// a hipótese não se confirmou: remova o test.fail e registre.
test("FE-SSR-01: conteúdo de Server Component protegido não vai no HTML sem sessão", async ({ request }) => {
  test.fail(true, "FE-SSR-01: children Server Component do AuthGuard são serializados no payload RSC");
  const html = await (await request.get("/", { headers: { accept: "text/html" } })).text();
  expect(html).not.toContain("Fase 1 em andamento");
});

test.describe("toda ação na API sai autenticada", () => {
  // Um teste por (perfil, rota): no `next dev` cada rota compila na 1ª visita e,
  // sob a carga da suíte completa, um único teste com todas as rotas estourava
  // o limite. As asserções são as mesmas, só distribuídas e paralelizáveis.
  for (const role of ["ADM", "USER", "RH"] as const) {
    for (const path of PROTECTED) {
      test(`${role}: ${path}: nenhuma requisição à API sem Authorization: Bearer`, async ({ page }) => {
        test.setTimeout(180_000);
        await installMocks(page, { role, aal: "aal2" });
        await seedSession(page, { role, aal: "aal2" });
        const requests = trackRequests(page);

        await page.goto(path);
        await waitForHydration(page);
        await page.waitForLoadState("networkidle", { timeout: 90_000 });

        const calls = apiCalls(requests);
        expect(calls.length).toBeGreaterThan(0); // ao menos /v1/me
        for (const call of calls) {
          expect(call.headers()["authorization"] ?? "", `${call.method()} ${call.url()}`).toMatch(
            /^Bearer \S+$/,
          );
        }
      });
    }
  }

  test("sessão expirada sem refresh possível: nenhuma chamada à API sem Bearer", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    // Sessão já expirada; o refresh (POST /token?grant_type=refresh_token) não é
    // mockado => falha. Qualquer chamada à API deve continuar com Bearer ou não ocorrer.
    await page.addInitScript((key) => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
      const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "x", aud: "authenticated", role: "authenticated", iat: past - 60, exp: past })}.sig`;
      if (!window.sessionStorage.getItem("__e2e_seeded")) {
        window.sessionStorage.setItem("__e2e_seeded", "1");
        window.sessionStorage.setItem(
          key,
          JSON.stringify({ access_token: token, refresh_token: "r", token_type: "bearer", expires_in: 1, expires_at: past, user: { id: "x" } }),
        );
      }
    }, SESSION_STORAGE_KEY);
    const requests = trackRequests(page);
    await page.goto("/administracao/usuarios");
    await page.waitForLoadState("networkidle");
    for (const call of apiCalls(requests)) {
      expect(call.headers()["authorization"] ?? "").toMatch(/^Bearer \S+$/);
    }
  });
});

test.describe("401 do backend encerra a sessão", () => {
  test("/v1/me → 401: logout local, storage limpo e volta ao /login", async ({ page }) => {
    const state = await installMocks(page, { role: "ADM", aal: "aal2" });
    await seedSession(page, { role: "ADM", aal: "aal2" });
    // Registrada depois => tem prioridade sobre o mock padrão de /v1/me.
    await page.route(`${API_URL}/v1/me`, (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type" } })
        : route.fulfill({
            status: 401,
            headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
            body: JSON.stringify({ error: { code: "unauthorized", message: "Autenticação necessária ou inválida." } }),
          }),
    );

    await page.goto("/administracao/usuarios");
    await expect(page).toHaveURL(/\/login$/);
    const stored = await page.evaluate((key) => window.sessionStorage.getItem(key), SESSION_STORAGE_KEY);
    expect(stored).toBeNull();
    // Nenhum dado administrativo foi pedido depois do 401.
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/users"))).toBe(false);
  });
});

test.describe("armazenamento de tokens e redirecionamento", () => {
  test("login pelo formulário: token só em sessionStorage, nunca em localStorage", async ({ page }) => {
    await installMocks(page, { role: "USER", hasVerifiedFactor: false });
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("usuario.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/$/);

    const storage = await page.evaluate(() => {
      const dump = (s: Storage) =>
        Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? "")}`).join("\n");
      return { local: dump(localStorage), session: dump(sessionStorage) };
    });
    expect(storage.local).not.toMatch(/access_token|refresh_token|eyJ/);
    expect(storage.session).toContain("access_token");
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => /token|auth|sb-/i.test(c.name))).toEqual([]);
  });

  test("parâmetros de redirecionamento na URL do login são ignorados (sem open redirect)", async ({ page }) => {
    await installMocks(page, { role: "USER", hasVerifiedFactor: false });
    await page.goto("/login?next=https://atacante.example/&redirect=//atacante.example&returnTo=https:%2F%2Fatacante.example");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("usuario.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
  });
});

test.describe("páginas públicas", () => {
  for (const path of ["/login", "/ativar-conta"]) {
    test(`${path}: sem chamadas à API e sem navegação administrativa`, async ({ page }) => {
      await installMocks(page);
      const requests = trackRequests(page);
      await page.goto(path);
      await waitForHydration(page);
      await page.waitForLoadState("networkidle");

      expect(apiCalls(requests)).toEqual([]);
      for (const href of ADMIN_HREFS) {
        await expect(page.locator(`a[href^="${href}"]`)).toHaveCount(0);
      }
    });
  }
});
