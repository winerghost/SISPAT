import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Importação de bens: (1) confirmação em modo "todos os elegíveis"
// (select_all_eligible + excluded_item_ids) e (2) painel de reconciliação (ADM).
// Mocks sintéticos; autorização e regras são do backend.
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const PATH = "/administracao/importacao/google-sheets";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FIRST_ITEM_ID = "10000000-0000-4000-8000-000000000001";

async function axeViolations(page: Page): Promise<string[]> {
  await waitForAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return results.violations.map((v) => v.id);
}

async function openPreview(page: Page, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(PATH);
  await waitForHydration(page);
  await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
  await expect(page.getByText("Exibindo 1–8 de 8 item(ns)")).toBeVisible();
  return state;
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("confirmação: todos os elegíveis", () => {
  test("padrão envia select_all_eligible=true e excluded_item_ids vazio (sem lista de ids)", async ({ page }) => {
    await openPreview(page);
    await expect(page.getByTestId("selection-summary")).toContainText("5 de 5 elegível(is) selecionado(s)");
    await page.getByRole("button", { name: "Confirmar Importação" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
    await expect(dialog.getByTestId("confirm-excluded")).toContainText("Todos os itens elegíveis");
    const confirm = page.waitForRequest((r) => r.url().endsWith("/confirm") && r.method() === "POST");
    await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
    const body = (await confirm).postDataJSON() as Record<string, unknown>;
    expect(body).toEqual({ preview_id: expect.any(String), select_all_eligible: true, excluded_item_ids: [] });
    await expect(page.getByTestId("catalog-import-result").locator("[data-stat=Salvos]")).toHaveText("5");
  });

  test("desmarcar uma linha envia só a exclusão e atualiza o resumo (elegíveis vs desmarcados)", async ({ page }) => {
    await openPreview(page);
    await page.getByRole("checkbox", { name: "Selecionar item 000123" }).uncheck();
    await expect(page.getByTestId("selection-summary")).toContainText("4 de 5 elegível(is) selecionado(s); 1 desmarcado(s)");
    await page.getByRole("button", { name: "Confirmar Importação" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
    await expect(dialog.getByTestId("confirm-excluded")).toContainText("1 item(ns) elegível(is) desmarcado(s)");
    expect(await axeViolations(page)).toEqual([]);
    const confirm = page.waitForRequest((r) => r.url().endsWith("/confirm") && r.method() === "POST");
    await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
    const body = (await confirm).postDataJSON() as Record<string, unknown>;
    expect(body).toEqual({ preview_id: expect.any(String), select_all_eligible: true, excluded_item_ids: [FIRST_ITEM_ID] });
    await expect(page.getByTestId("catalog-import-result").locator("[data-stat=Salvos]")).toHaveText("4");
  });

  test("desmarcar todos os elegíveis desabilita a confirmação", async ({ page }) => {
    await openPreview(page);
    for (const number of ["000123", "000124", "000125", "000130", "0001290000000000000000000000000000"]) {
      await page.getByRole("checkbox", { name: `Selecionar item ${number}` }).uncheck();
    }
    await expect(page.getByTestId("selection-summary")).toContainText("0 de 5 elegível(is) selecionado(s)");
    await expect(page.getByRole("button", { name: "Confirmar Importação" })).toBeDisabled();
  });
});

test.describe("reconciliação (ADM)", () => {
  test("carrega totais, motivos e itens; filtra por motivo; número patrimonial como texto", async ({ page }) => {
    const state = await openPreview(page);
    const panel = page.getByTestId("reconciliation-panel");
    await expect(panel.getByRole("table")).toHaveCount(0);
    await panel.getByRole("button", { name: "Carregar reconciliação" }).click();
    await expect(panel.locator("[data-stat=total_itens]")).toHaveText("8");
    await expect(panel.locator("[data-stat=localizados]")).toHaveText("5");
    await expect(panel.locator("[data-stat=nao_importados]")).toHaveText("3");
    const table = panel.getByRole("table", { name: "Itens não importados" });
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect(table).toContainText("000126");
    await expect(table).toContainText("Linha");

    const filtered = page.waitForRequest((r) => r.url().includes("/reconciliation") && r.url().includes("reason=unidade_sem_alias"));
    await panel.getByRole("button", { name: /Unidade sem alias/ }).click();
    await filtered;
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(panel.getByRole("button", { name: /Unidade sem alias/ })).toHaveAttribute("aria-pressed", "true");
    // O filtro continua com todos os motivos disponíveis.
    await expect(panel.getByRole("button", { name: "Todos os motivos" })).toBeVisible();
    await panel.getByRole("button", { name: "Todos os motivos" }).click();
    await expect(table.locator("tbody tr")).toHaveCount(3);

    const urls = state.calls.filter((c) => c.url.includes("/reconciliation")).map((c) => new URL(c.url, "http://x"));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      for (const key of url.searchParams.keys()) expect(["reason", "page", "page_size"]).toContain(key);
      expect(["50", "100", "200"]).toContain(url.searchParams.get("page_size"));
    }
    expect(await axeViolations(page)).toEqual([]);
  });

  test("paginação 50/100/200 no servidor", async ({ page }) => {
    await openPreview(page, { role: "ADM", catalogImport: { reconciliationBulk: 120 } });
    const panel = page.getByTestId("reconciliation-panel");
    await panel.getByRole("button", { name: "Carregar reconciliação" }).click();
    await expect(panel.getByText("Exibindo 1–50 de 123 item(ns) não importado(s)")).toBeVisible();
    const next = page.waitForRequest((r) => r.url().includes("/reconciliation") && r.url().includes("page=2"));
    await panel.getByRole("navigation", { name: "Paginação da reconciliação" }).getByRole("button", { name: "Próxima" }).click();
    await next;
    await expect(panel.getByText("Exibindo 51–100 de 123 item(ns) não importado(s)")).toBeVisible();
    await panel.getByLabel("Registros por página").selectOption("200");
    await expect(panel.getByText("Exibindo 1–123 de 123 item(ns) não importado(s)")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test("erro: mensagem fixa (nunca a do backend) e tentar novamente", async ({ page }) => {
    const state = await openPreview(page, { role: "ADM", catalogImport: { reconciliationStatus: 500 } });
    const panel = page.getByTestId("reconciliation-panel");
    await panel.getByRole("button", { name: "Carregar reconciliação" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível carregar a reconciliação." })).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    state.catalogImport.reconciliationStatus = null;
    await panel.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(panel.locator("[data-stat=nao_importados]")).toHaveText("3");
  });

  for (const width of [320, 768, 1024, 1366, 1920]) {
    test(`sem rolagem horizontal da página a ${width}px (com reconciliação aberta)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openPreview(page);
      await page.getByRole("button", { name: "Carregar reconciliação" }).click();
      await expect(page.getByTestId("reconciliation-panel").locator("[data-stat=localizados]")).toHaveText("5");
      expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
    });
  }
});
