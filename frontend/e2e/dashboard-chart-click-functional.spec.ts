import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";
import { expectDashboardLoaded, expectPanelsLoaded, waitForAnimations } from "./support/screens";

// =============================================================================
// Interação com gráficos e filtros em telas estreitas (Onda 3).
// Antes: clique numa barra/fatia aplicava filtro na URL (situação, vínculo, sala,
// unidade) com alternativa por teclado ("Filtrar pelo gráfico") e a barra de
// filtros era recolhível no celular. Esses 15 painéis só existem agora no
// relatório imprimível (sem ação de clique). O /dashboard desenha o catálogo de
// painéis, cujos filtros (família, unidade, categoria) ficam sempre visíveis:
//   - gráfico do catálogo NÃO filtra ao clicar: o filtro é só pelos selects;
//   - os mesmos números do gráfico estão numa tabela alternativa (teclado/leitor);
//   - 320–1920px sem rolagem horizontal, alvos >= 24px e axe sem violações.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function open(page: Page, opts: MockOptions = { role: "USER" }, path = "/dashboard"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const filters = (page: Page) => page.locator("[data-equipment-filters]");

test.describe("relatório", () => {
  test("sem ação de clique: nem legenda clicável nem 'Filtrar pelo gráfico'", async ({ page }) => {
    await open(page, { role: "USER" }, "/dashboard/relatorio");
    await expectDashboardLoaded(page);
    await expect(page.getByRole("button", { name: /Filtrar pelo gráfico/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Filtrar por (situação|vínculo)/ })).toHaveCount(0);
    await expect(page.locator("[data-chart-interactive]")).toHaveCount(0);
  });
});

test.describe("gráfico do catálogo (equipamentos por unidade)", () => {
  test("clicar na barra não altera URL nem consultas; o filtro é só pelos selects", async ({ page }) => {
    const state = await open(page);
    await expectPanelsLoaded(page, "USER");
    const chart = page.locator("[data-equipment-panel=equipment_by_unit_chart]");
    const before = state.panels.calls.length;
    const url = page.url();
    const rect = chart.locator("[data-chart-surface] svg g rect").first();
    const box = await rect.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(chart.getByRole("button", { name: /Filtrar/ })).toHaveCount(0);
    await expect(chart.locator("[data-chart-interactive]")).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect(state.panels.calls.length).toBe(before);
  });

  test("alternativa sem mouse: a tabela de dados traz os mesmos números do gráfico", async ({ page }) => {
    await open(page);
    await expectPanelsLoaded(page, "USER");
    const chart = page.locator("[data-equipment-panel=equipment_by_unit_chart]");
    await expect(chart.locator('[role="img"]').first()).toHaveAccessibleName(/Tecnologia da Informação/);
    const table = chart.getByRole("table").first();
    await expect(table).toContainText("PFN-TO");
    await expect(table).toContainText("CGU-TO");
    await expect(table).toContainText("31"); // monitores de PFN-TO, número do backend
  });
});

test.describe("filtros em telas estreitas e largas", () => {
  for (const width of [320, 375, 430]) {
    test(`${width}px: filtros sempre visíveis (sem recolher), alvos >= 24px, sem rolagem, axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page);
      await expectPanelsLoaded(page, "USER");
      await expect(filters(page).getByLabel("Família", { exact: true })).toBeVisible();
      await expect(filters(page).getByRole("button", { name: "Limpar filtros" })).toBeVisible();
      await filters(page).getByLabel("Família", { exact: true }).selectOption("TI");
      for (const control of await filters(page).locator("select:visible, input:visible, button:visible").all()) {
        const b = (await control.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(24);
        expect(b.x + b.width).toBeLessThanOrEqual(width);
      }
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
      await expect(page.locator("[data-equipment-panel][aria-busy=true]")).toHaveCount(0, { timeout: 20_000 });
      await waitForAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

  test("1 filtro: texto indica a contagem; Limpar filtros zera", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page);
    await expectPanelsLoaded(page, "USER");
    await filters(page).getByLabel("Família", { exact: true }).selectOption("TI");
    await expect(filters(page)).toContainText("1 filtro(s) ativo(s).");
    await filters(page).getByRole("button", { name: "Limpar filtros" }).click();
    await expect(filters(page)).toContainText("Sem filtros");
  });

  for (const width of [768, 1024, 1920]) {
    test(`${width}px: filtros visíveis, sem rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await expectPanelsLoaded(page, "USER");
      await expect(filters(page).getByLabel("Categoria", { exact: true })).toBeVisible();
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  }
});
