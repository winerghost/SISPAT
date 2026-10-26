import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";

// =============================================================================
// Patrimônios — busca, paginação/clamp, estados vazios e "Limpar filtros".
// Mocks sintéticos; o escopo e os totais são do backend (simulado).
// =============================================================================

const SEARCH_LABEL = "Buscar por número patrimonial ou descrição";
const table = (page: Page) => page.getByRole("table", { name: "Patrimônios" });
const rows = (page: Page) => table(page).locator("tbody tr");

async function open(page: Page, opts: MockOptions = { role: "ADM" }, path = "/patrimonios"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("patrimônios — estados", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("busca por bem semeado encontra só ele e não mostra 'vazio'", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(6);
    await page.getByLabel(SEARCH_LABEL).fill("A-2025/007");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("A-2025/007");
    await expect(page.getByText("Nenhum bem encontrado")).toHaveCount(0);
  });

  test("?page=999 é ajustado para a última página, sem flash de 'Nenhum bem'", async ({ page }) => {
    await open(page, { role: "ADM", assetsBulk: 120 }, "/patrimonios?page=999");
    // Nunca exibe afirmação de vazio durante o ajuste.
    await expect(page.getByText(/Nenhum bem/)).toHaveCount(0);
    await expect(page.getByText(/Exibindo 101–\d+ de \d+ bem\(ns\)/)).toBeVisible();
    await expect(rows(page).first()).not.toContainText("Nenhum bem");
    await expect(page.getByRole("navigation", { name: "Paginação" }).getByRole("button", { name: "Próxima" })).toBeDisabled();
  });

  test("?page= inválido volta à página 1", async ({ page }) => {
    await open(page, { role: "ADM" }, "/patrimonios?page=abc");
    await expect(page.getByText("Exibindo 1–6 de 6 bem(ns)")).toBeVisible();
  });

  test("filtro sem resultado: mensagem de filtros, Limpar restaura lista, ordenação e excluídos", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(6);

    // Ordenação e "Incluir excluídos" também contam como filtro e são desfeitos por Limpar.
    await page.getByRole("columnheader", { name: /Descrição/ }).getByRole("button").click();
    await page.getByRole("switch", { name: "Incluir excluídos" }).check();
    await expect(rows(page)).toHaveCount(7);
    const clear = page.getByRole("button", { name: "Limpar filtros" });
    await expect(clear).toBeVisible();

    await page.getByLabel(SEARCH_LABEL).fill("nada-corresponde");
    await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible();
    await expect(page.getByText("Você não tem unidades no seu escopo de acesso.")).toHaveCount(0);

    await clear.click();
    await expect(page.getByLabel(SEARCH_LABEL)).toHaveValue("");
    await expect(page.getByRole("switch", { name: "Incluir excluídos" })).not.toBeChecked();
    await expect(page.getByRole("columnheader", { name: /Patrimônio/ })).toHaveAttribute("aria-sort", "ascending");
    await expect(rows(page)).toHaveCount(6);
    await expect(clear).toHaveCount(0);
  });

  test("busca global (?busca=) sem resultado conta como filtro e Limpar a remove", async ({ page }) => {
    await open(page, { role: "USER" }, "/patrimonios?busca=nada-corresponde");
    await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(6);
  });

  test("escopo com unidades e sem bens: 'Nenhum bem no seu escopo.'", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    state.assets.length = 0;
    await seedSession(page, { role: "USER" });
    await page.goto("/patrimonios");
    await waitForHydration(page);
    await expect(page.getByText("Nenhum bem no seu escopo.")).toBeVisible();
    await expect(page.getByText("Você não tem unidades no seu escopo de acesso.")).toHaveCount(0);
  });

  test("sem unidades no escopo: mensagem própria (distinta de filtros e de 'nenhum bem')", async ({ page }) => {
    await open(page, { role: "USER", noUnitScope: true });
    await expect(page.getByText("Você não tem unidades no seu escopo de acesso.")).toBeVisible();
    await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toHaveCount(0);
    await expect(page.getByText("Nenhum bem no seu escopo.")).toHaveCount(0);
  });

  test("estado de carregamento é anunciado e não afirma 'vazio' com dado provisório", async ({ page }) => {
    const opts: MockOptions = { role: "USER" };
    await installMocks(page, opts);
    // Atrasa só a consulta com busca para observar o dado provisório.
    await page.route(/\/v1\/assets\?.*q=nada/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fallback();
    });
    await seedSession(page, opts);
    await page.goto("/patrimonios?busca=nada-corresponde");
    await waitForHydration(page);
    await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible({ timeout: 15_000 });

    // Limpar com a lista cheia ainda em cache: nunca mostra "vazio" no meio.
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(6);
  });

  test("axe WCAG 2.2 AA nos estados vazios", async ({ page }) => {
    await open(page, { role: "USER", noUnitScope: true });
    await expect(page.getByText("Você não tem unidades no seu escopo de acesso.")).toBeVisible();
    const noScope = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("nextjs-portal")
      .analyze();
    expect(noScope.violations.map((v) => v.id)).toEqual([]);

    await open(page, { role: "USER" });
    await page.getByLabel(SEARCH_LABEL).fill("nada-corresponde");
    await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible();
    const filtered = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("nextjs-portal")
      .analyze();
    expect(filtered.violations.map((v) => v.id)).toEqual([]);
  });
});

for (const width of [320, 768, 1024, 1366, 1920]) {
  test.describe(`patrimônios — estados a ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("sem rolagem horizontal: lista, filtro vazio, sem escopo e página ajustada", async ({ page }) => {
      await open(page, { role: "ADM", assetsBulk: 120 }, "/patrimonios?page=999");
      await expect(page.getByText(/Exibindo 101–\d+ de \d+ bem\(ns\)/)).toBeVisible();
      expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

      await page.getByLabel(SEARCH_LABEL).fill("nada-corresponde");
      await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible();
      expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

      await open(page, { role: "USER", noUnitScope: true });
      await expect(page.getByText("Você não tem unidades no seu escopo de acesso.")).toBeVisible();
      expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
    });
  });
}
