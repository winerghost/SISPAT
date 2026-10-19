import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// /administracao/perfis-permissoes — consulta SOMENTE LEITURA (ADM).
// Mocks sintéticos de GET /v1/admin/roles e /v1/admin/permissions. A autorização
// é do BACKEND (simulada no mock); aqui validamos o que a interface mostra,
// envia (só GET, sem query string) e a ausência de overflow/violações axe.
// O nome do arquivo casa com o projeto "e2e" (testMatch /functional\.spec\.ts/).
// =============================================================================

const PATH = "/administracao/perfis-permissoes";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.use({ viewport: { width: 1366, height: 768 } });

async function open(page: Page, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(PATH);
  await waitForHydration(page);
  return state;
}

function adminCalls(state: MockState): string[] {
  return state.calls.filter((c) => c.url.includes("/v1/admin/")).map((c) => `${c.method} ${c.url}`);
}

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
}

test.describe("ADM — perfis", () => {
  test("um cartão por perfil com código, descrição, contagem, nota de escopo e permissões por recurso", async ({
    page,
  }) => {
    const state = await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "Perfis e Permissões" })).toBeVisible();
    for (const [code, name, count, perms] of [
      ["ADM", "Administrador", 3, 40],
      ["USER", "Usuário", 12, 11],
      ["RH", "Recursos Humanos", 2, 6],
    ] as const) {
      const card = page.getByTestId(`role-card-${code}`);
      await expect(card).toBeVisible();
      await expect(card.getByRole("heading", { level: 2, name })).toBeVisible();
      await expect(card.getByText(code, { exact: true })).toBeVisible();
      await expect(page.getByTestId(`role-users-${code}`)).toContainText(`${count} usuário(s) ativo(s)`);
      await expect(card.locator("[data-resource]").first()).toBeVisible();
      await expect(card.getByRole("heading", { level: 3, name: "Permissões" }).locator("..")).toContainText(String(perms));
    }
    await expect(page.getByTestId("users-count-note")).toContainText("unidades do seu escopo");
    // Permissões agrupadas por recurso (RH: 6 permissões em 6 recursos).
    await expect(page.getByTestId("role-card-RH").locator("[data-resource]")).toHaveCount(6);
    // Somente leitura: só GET, sem query string, e sem botões de escrita.
    expect(adminCalls(state)).toEqual(["GET /api/v1/admin/roles"]);
    await expect(page.getByRole("main").getByRole("button", { name: /^(Nov|Editar|Salvar|Excluir|Inativar)/ })).toHaveCount(0);
  });

  test("os perfis exibidos vêm só da API (perfil extra aparece, perfil removido some)", async ({ page }) => {
    const base = (await import("./support/admin-access-mocks")).defaultAdminAccess();
    await open(page, {
      role: "ADM",
      adminAccess: { ...base, roles: base.roles.filter((r) => r.code !== "RH") },
    });
    await expect(page.getByTestId("role-card-ADM")).toBeVisible();
    await expect(page.getByTestId("role-card-RH")).toHaveCount(0);
  });

  test("texto vindo da API é inerte (sem HTML)", async ({ page }) => {
    const base = (await import("./support/admin-access-mocks")).defaultAdminAccess();
    const xss = `<img src=x onerror="window.__xss=1">`;
    const roles = base.roles.map((r) => (r.code === "USER" ? { ...r, description: xss } : r));
    await open(page, { role: "ADM", adminAccess: { ...base, roles } });
    await expect(page.getByTestId("role-card-USER")).toContainText(xss);
    expect(await page.locator("[data-testid=role-card-USER] img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

test.describe("ADM — matriz", () => {
  test("linhas = permissões, colunas = perfis, marca com texto acessível", async ({ page }) => {
    const state = await open(page);
    await page.getByRole("tab", { name: "Matriz" }).click();
    const table = page.getByRole("table", { name: "Matriz de permissões por perfil" });
    await expect(table).toBeVisible();
    for (const code of ["ADM", "USER", "RH"]) {
      await expect(table.getByRole("columnheader", { name: code })).toBeVisible();
    }
    await expect(table.locator("tbody tr")).toHaveCount(40);
    // users.delete: só ADM; assets.read: todos.
    const del = table.getByRole("row", { name: /users\.delete/ });
    await expect(del.getByText("Concedida", { exact: true })).toHaveCount(1);
    await expect(del.getByText("Não concedida", { exact: true })).toHaveCount(2);
    const read = table.getByRole("row", { name: /assets\.read/ });
    await expect(read.getByText("Concedida", { exact: true })).toHaveCount(3);
    expect(adminCalls(state)).toEqual(["GET /api/v1/admin/roles", "GET /api/v1/admin/permissions"]);
  });

  test("a matriz rola dentro do próprio contêiner em 320px, sem rolagem da página", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page);
    await page.getByRole("tab", { name: "Matriz" }).click();
    const region = page.getByRole("region", { name: "Matriz de permissões por perfil" });
    await expect(region).toBeVisible();
    expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("acesso restrito (negar por padrão)", () => {
  for (const role of ["USER", "RH"] as const) {
    test(`${role}: painel de acesso restrito, sem exibir perfis nem chamar /admin`, async ({ page }) => {
      const state = await open(page, { role });
      await expect(page.getByTestId("access-restricted")).toBeVisible();
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await expect(page.getByTestId("role-card-ADM")).toHaveCount(0);
      expect(adminCalls(state)).toEqual([]);
    });
  }

  test("/me com erro: nega por padrão", async ({ page }) => {
    await open(page, { role: "ADM", meStatus: 500 });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
  });

  test("ADM que recebe 403 do backend vê acesso restrito sem vazar detalhe", async ({ page }) => {
    await open(page, { role: "ADM", adminAccessStatus: 403 });
    const panel = page.getByTestId("access-restricted");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("verificação em duas etapas");
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
  });

  test("ADM com AAL1: backend nega (AAL2_REQUIRED) e a tela vira acesso restrito", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
    await expect(page.getByTestId("role-card-ADM")).toHaveCount(0);
  });
});

test.describe("estados", () => {
  test("carregando: esqueleto anunciado até a resposta chegar", async ({ page }) => {
    await open(page, { role: "ADM", adminAccessDelayMs: 1500 });
    await expect(page.getByRole("status").filter({ hasText: "Carregando perfis…" })).toBeVisible();
    await expect(page.getByTestId("role-card-ADM")).toBeVisible({ timeout: 10_000 });
  });

  test("erro 500: mensagem útil sem detalhe do backend e botão tentar de novo recupera", async ({ page }) => {
    const state = await open(page, { role: "ADM", adminAccessStatus: 500 });
    await expect(page.getByText("Não foi possível carregar os perfis. Tente novamente.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
    state.adminAccessStatus = null;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByTestId("role-card-ADM")).toBeVisible();
  });

  test("erro só na matriz: aviso na aba Matriz e perfis seguem disponíveis", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByTestId("role-card-ADM")).toBeVisible();
    state.adminAccessStatus = 500;
    await page.getByRole("tab", { name: "Matriz" }).click();
    await expect(page.getByText("Não foi possível carregar a matriz de permissões. Tente novamente.")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("tab", { name: "Perfis" }).click();
    await expect(page.getByTestId("role-card-ADM")).toBeVisible();
  });

  test("vazio: perfis e matriz mostram estado vazio", async ({ page }) => {
    await open(page, { role: "ADM", adminAccess: { roles: [], permissions: [] } });
    await expect(page.getByText("Nenhum perfil encontrado")).toBeVisible();
    await page.getByRole("tab", { name: "Matriz" }).click();
    await expect(page.getByText("Nenhuma permissão encontrada")).toBeVisible();
  });
});

test.describe("responsivo e acessibilidade", () => {
  for (const width of [320, 768, 1280, 1920]) {
    test(`${width}px: sem overflow horizontal e sem violações axe (Perfis e Matriz)`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await open(page);
      await expect(page.getByTestId("role-card-ADM")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(await axeViolations(page)).toEqual([]);

      await page.getByRole("tab", { name: "Matriz" }).click();
      await expect(page.getByRole("table", { name: "Matriz de permissões por perfil" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test("navegação por teclado entre abas (setas) e item destacado no menu", async ({ page }) => {
    await open(page);
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    await expect(nav.locator(`a[href="${PATH}"]`)).toHaveAttribute("aria-current", "page");
    await page.getByRole("tab", { name: "Perfis" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Matriz" })).toHaveAttribute("aria-selected", "true");
  });
});
