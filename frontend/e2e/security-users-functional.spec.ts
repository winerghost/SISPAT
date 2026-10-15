import { expect, test, type Page, type Route } from "@playwright/test";

import {
  API_URL,
  COMMON_USER_ID,
  expectNoXss,
  installMocks,
  seedSession,
  SUPABASE_URL,
  TINY_PNG,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Segurança — gestão de usuários (Etapa 2) e "Meu perfil".
// Revisor AppSec (2026-10-15). Evidência: docs/security/evidence/settings-module-etapa2.md
//
// 1. Nenhum `error.message` vindo do backend aparece na tela, em nenhuma rota
//    nova: o backend (mock) devolve uma mensagem-marcador com HTML ativo e a
//    UI só pode mostrar as frases fixas mapeadas por `error.code`.
// 2. CSP emitida pelo middleware: `img-src` limitado a 'self' data: blob: e ao
//    prefixo `<Supabase>/storage/v1/object/sign/avatars/` (sem curingas de esquema), `script-src` sem
//    'unsafe-inline'.
// O nome do arquivo casa com o projeto "e2e" (testMatch /functional\.spec\.ts/).
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const USERS_PATH = "/administracao/usuarios";
const COMMON_NAME = 'Usuário <img src=x onerror="window.__xss=1">';
const MARKER = "MARCADOR-BACKEND-CRU-7f3a";
const RAW_MESSAGE = `${MARKER} <img src=x onerror="window.__xss=9"> detalhe interno SQL users.version`;
const JSON_HEADERS = { "access-control-allow-origin": "*", "content-type": "application/json" };

function rawError(route: Route, status: number, code: string) {
  return route.fulfill({
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: { code, message: RAW_MESSAGE } }),
  });
}

/** Responde com erro cru para `method` + caminho que termina em `suffix` (demais: fallback). */
async function failApi(page: Page, method: string, suffix: string | RegExp, status: number, code: string) {
  await page.route(
    (url) => {
      if (!url.href.startsWith(API_URL)) return false;
      return typeof suffix === "string" ? url.pathname.endsWith(suffix) : suffix.test(url.pathname);
    },
    (route) => (route.request().method() === method ? rawError(route, status, code) : route.fallback()),
  );
}

async function expectNoRawMessage(page: Page) {
  await expect(page.getByText(MARKER)).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toContain(MARKER);
  expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
}

async function openUsers(page: Page, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(USERS_PATH);
  await waitForHydration(page);
  return state;
}

async function openSheet(page: Page, name: string, tab?: string) {
  await page.getByRole("button", { name: `Gerenciar ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name, exact: true });
  await expect(sheet).toBeVisible();
  if (tab) await sheet.getByRole("tab", { name: tab }).click();
  return sheet;
}

const LIST_ERRORS: Array<[number, string]> = [
  [400, "validation_error"],
  [403, "forbidden"],
  [403, "AAL2_REQUIRED"],
  [404, "not_found"],
  [429, "rate_limited"],
  [500, "internal_error"],
  [503, "rate_limit_unavailable"],
  [418, "codigo_desconhecido"],
];

test.describe("UA-FE: mensagens cruas do backend nunca são exibidas", () => {
  for (const [status, code] of LIST_ERRORS) {
    test(`lista de usuários: ${status} ${code}`, async ({ page }) => {
      await installMocks(page, { role: "ADM" });
      await failApi(page, "GET", "/v1/users", status, code);
      await seedSession(page, { role: "ADM" });
      await page.goto(USERS_PATH);
      await waitForHydration(page);
      await expect(page.getByRole("main").getByRole("alert").first()).toBeVisible();
      await expectNoRawMessage(page);
    });
  }

  test("detalhe, PATCH, ações de conta, foto e histórico", async ({ page }) => {
    await openUsers(page);
    // PATCH com código fora do contrato e com códigos conhecidos.
    await failApi(page, "PATCH", `/v1/users/${COMMON_USER_ID}`, 409, "codigo_novo_nao_mapeado");
    const sheet = await openSheet(page, COMMON_NAME);
    await sheet.getByRole("radio", { name: /RH — Recursos Humanos/ }).check();
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    await expect(sheet.getByRole("alert").first()).toBeVisible();
    await expectNoRawMessage(page);

    // Ações de conta: 502 do provedor e 500 genérico.
    await failApi(page, "POST", `/v1/users/${COMMON_USER_ID}/revoke-sessions`, 502, "auth_provider_unavailable");
    await failApi(page, "POST", `/v1/users/${COMMON_USER_ID}/password-reset`, 500, "internal_error");
    await sheet.getByRole("tab", { name: "Conta" }).click();
    for (const [button, dialogName, confirmLabel] of [
      ["Encerrar sessões", "Encerrar sessões", "Encerrar sessões"],
      ["Enviar redefinição de senha", "Enviar redefinição de senha", "Enviar e-mail"],
    ] as const) {
      await sheet.getByRole("button", { name: button, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: dialogName });
      await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: /./ }).first()).toBeVisible();
      await expectNoRawMessage(page);
      if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    // Foto: 413 do servidor.
    await failApi(page, "PUT", `/v1/users/${COMMON_USER_ID}/avatar`, 413, "file_too_large");
    await sheet.getByRole("tab", { name: "Foto" }).click();
    await sheet.getByLabel(/Escolher (outra )?foto/).first().setInputFiles({ name: "a.png", mimeType: "image/png", buffer: TINY_PNG });
    await sheet.getByRole("button", { name: "Enviar foto" }).click();
    await expect(sheet.getByRole("alert").first()).toBeVisible();
    await expectNoRawMessage(page);

    // Histórico: 500.
    await failApi(page, "GET", `/v1/users/${COMMON_USER_ID}/audit`, 500, "internal_error");
    await sheet.getByRole("tab", { name: "Histórico" }).click();
    await expect(sheet.getByRole("alert").first()).toBeVisible();
    await expectNoRawMessage(page);
  });

  test("detalhe 404 com mensagem crua: aviso neutro", async ({ page }) => {
    await openUsers(page);
    await failApi(page, "GET", `/v1/users/${COMMON_USER_ID}`, 404, "not_found");
    await page.getByRole("button", { name: `Gerenciar ${COMMON_NAME}`, exact: true }).click();
    await expect(page.getByRole("dialog").getByText(/não encontrado/i)).toBeVisible();
    await expectNoRawMessage(page);
  });

  test("Meu perfil: 413/400/503 do /me/avatar não vazam a mensagem", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER" });
    await page.goto("/configuracoes/perfil");
    await waitForHydration(page);
    const main = page.getByRole("main");
    for (const [status, code] of [
      [413, "file_too_large"],
      [400, "unsupported_image"],
      [503, "storage_unavailable"],
    ] as Array<[number, string]>) {
      await failApi(page, "PUT", "/v1/me/avatar", status, code);
      const chooser = main.getByLabel(/Escolher (outra )?foto/).first();
      await chooser.setInputFiles({ name: "eu.png", mimeType: "image/png", buffer: TINY_PNG });
      await main.getByRole("button", { name: "Enviar foto" }).click();
      await expect(main.getByRole("alert").first()).toBeVisible();
      await expectNoRawMessage(page);
    }
  });
});

test.describe("UA-FE: CSP do middleware", () => {
  test("img-src restrito (sem curinga de esquema) e script-src sem 'unsafe-inline'", async ({ request }) => {
    const response = await request.get("/login");
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp).not.toBe("");
    const directives = new Map(
      csp
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .filter((tokens) => tokens[0])
        .map((tokens) => [tokens[0]!, tokens.slice(1)] as const),
    );
    const imgSrc = directives.get("img-src") ?? [];
    // UA-CSP-01: só o prefixo das URLs assinadas do bucket `avatars` (barra final = prefixo).
    expect(new Set(imgSrc)).toEqual(
      new Set(["'self'", "data:", "blob:", `${new URL(SUPABASE_URL).origin}/storage/v1/object/sign/avatars/`]),
    );
    expect(imgSrc).not.toContain(new URL(SUPABASE_URL).origin);
    for (const token of imgSrc) expect(["*", "https:", "http:"]).not.toContain(token);
    const scriptSrc = directives.get("script-src") ?? [];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc.some((t) => t.startsWith("'nonce-"))).toBe(true);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  });
});
