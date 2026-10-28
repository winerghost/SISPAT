import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  defaultDashboardCharts,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
  type PreferencesMock,
} from "./support/mocks";
import { expectDashboardLoaded, expectPanelsLoaded, waitForAnimations } from "./support/screens";

// =============================================================================
// Gráficos do dashboard (Onda 3).
// - /dashboard desenha o catálogo de painéis: o gráfico de "Equipamentos por
//   unidade" tem formato FIXO (barras agrupadas); não existe seletor de tipo nem
//   escrita em /me/preferences a partir da tela. O menu "Tipo de gráfico"
//   (preferência `dashboard_charts`, PATCH /me/preferences) pertencia aos 15
//   painéis antigos e foi removido junto com eles da grade.
// - A preferência `dashboard_charts` ainda é LIDA pelo relatório imprimível
//   (/dashboard/relatorio), que compõe os blocos antigos: o tipo escolhido
//   (salvo antes da migração) continua valendo ali, sem seletor.
// Cobre: padrão e fixo no catálogo; todos os tipos no relatório com role=img,
// legenda e tabela alternativa; GET de preferências falho/inválido no relatório;
// axe e 320–1280px sem rolagem horizontal; reduced motion.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Charts = PreferencesMock["dashboard_charts"];

const ALTERNATIVE: Charts[] = [
  { units: "horizontal", status: "donut", monthly: "area", location: "horizontal", bond: "pie", rooms: "bar" },
  { units: "stacked", status: "bar", monthly: "bar", location: "grouped", bond: "bar", rooms: "horizontal" },
];

async function open(page: Page, opts: MockOptions = { role: "USER" }, path = "/dashboard/relatorio"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);

/** Muda a preferência no backend simulado e recarrega o relatório (mesma sessão e mesmos mocks). */
async function reloadWithCharts(page: Page, state: MockState, charts: Partial<Charts>): Promise<void> {
  state.prefs = { ...state.prefs, dashboard_charts: { ...defaultDashboardCharts(), ...charts } };
  await page.reload();
  await waitForHydration(page);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);
}

test.describe("catálogo de painéis (/dashboard)", () => {
  test("gráfico de equipamentos por unidade: barras agrupadas fixas, sem seletor de tipo nem PATCH de preferências", async ({
    page,
  }) => {
    const state = await open(page, { role: "USER" }, "/dashboard");
    await expectPanelsLoaded(page, "USER");
    const chart = page.locator("[data-equipment-panel=equipment_by_unit_chart]");
    await expect(chart.locator("figure")).toHaveAttribute("data-chart-kind", "grouped");
    await expect(chart.getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(chart.getByRole("list", { name: /Legenda/ })).toBeVisible();
    await expect(chart.getByRole("table")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
    expect(state.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/v1/me/preferences"))).toEqual([]);
  });

  test("preferência dashboard_charts salva (legado) não muda o gráfico do catálogo", async ({ page }) => {
    await open(page, { role: "USER", prefs: { dashboard_charts: ALTERNATIVE[0]! } }, "/dashboard");
    await expectPanelsLoaded(page, "USER");
    await expect(page.locator("[data-equipment-panel=equipment_by_unit_chart] figure")).toHaveAttribute(
      "data-chart-kind",
      "grouped",
    );
  });

  test("reduced motion: o gráfico e os números finais são exatos", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, { role: "USER" }, "/dashboard");
    await expectPanelsLoaded(page, "USER");
    await expect(page.locator("[data-equipment-panel=kpi_workstations] [data-stat-card=computador]")).toContainText("120");
  });
});

test.describe("relatório imprimível (lê a preferência dashboard_charts)", () => {
  test("padrões: barras agrupadas, pizza e linhas, sem seletor", async ({ page }) => {
    await open(page);
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de pizza/ })).toBeVisible();
    await expect(block(page, "aquisicoes-mensais").getByRole("img", { name: /Gráfico de linhas/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });

  test("usa o tipo escolhido e não mostra seletor", async ({ page }) => {
    await open(page, {
      role: "USER",
      prefs: {
        dashboard_charts: { units: "stacked", status: "donut", monthly: "area", location: "horizontal", bond: "bar", rooms: "bar" },
      },
    });
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    await expect(block(page, "localizacao-por-unidade").getByRole("img", { name: /Gráfico de barras horizontais/ })).toBeVisible();
    await expect(block(page, "por-vinculo").getByRole("img", { name: /Gráfico de barras:/ })).toBeVisible();
    await expect(block(page, "por-sala").getByRole("img", { name: /Gráfico de barras verticais/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });

  test("todos os tipos: role=img com resumo, legenda e tabela alternativa", async ({ page }) => {
    const cases = [
      { panel: "por-unidade", key: "units", value: "horizontal", name: /Gráfico de barras horizontais/, table: "Quantidade de bens por tipo em cada unidade", kind: "horizontal" },
      { panel: "por-unidade", key: "units", value: "stacked", name: /Gráfico de barras empilhadas/, table: "Quantidade de bens por tipo em cada unidade", kind: "stacked" },
      { panel: "por-situacao", key: "status", value: "donut", name: /Gráfico de rosca/, table: "Distribuição por situação", kind: "donut" },
      { panel: "por-situacao", key: "status", value: "bar", name: /Gráfico de barras:/, table: "Distribuição por situação", kind: "bar" },
      { panel: "aquisicoes-mensais", key: "monthly", value: "area", name: /Gráfico de áreas/, table: "Bens adquiridos por mês", kind: "area" },
      { panel: "aquisicoes-mensais", key: "monthly", value: "bar", name: /Gráfico de barras/, table: "Bens adquiridos por mês", kind: "grouped" },
      { panel: "por-vinculo", key: "bond", value: "pie", name: /Gráfico de pizza/, table: "Quantidade de bens por vínculo", kind: "pie" },
      { panel: "por-sala", key: "rooms", value: "bar", name: /Gráfico de barras verticais/, table: "Quantidade de bens por sala", kind: "grouped" },
    ] as const;
    const state = await open(page);
    for (const c of cases) {
      await reloadWithCharts(page, state, { [c.key]: c.value });
      await expectDashboardLoaded(page);
      const panel = block(page, c.panel);
      const img = panel.getByRole("img", { name: c.name });
      await expect(img).toBeVisible();
      await expect(img).toHaveAttribute("aria-label", /\d/);
      await expect(panel.getByRole("list", { name: /Legenda/ })).toBeVisible();
      await expect(panel.getByRole("table", { name: c.table })).toHaveCount(1);
      await expect(panel.locator("[data-chart-surface=nivo] svg")).toHaveCount(1);
      await expect(panel.locator("figure")).toHaveAttribute("data-chart-kind", c.kind);
      await expect(panel.getByRole("table", { name: c.table }).getByRole("row").nth(1)).toBeVisible();
    }
  });

  test("GET de preferências falha: padrões, sem seletor e sem quebrar o relatório", async ({ page }) => {
    await open(page, { role: "USER", prefsGetStatus: 500 });
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });

  test("valor fora da allowlist na resposta é rejeitado (usa padrões, sem seletor)", async ({ page }) => {
    await open(page, {
      role: "USER",
      prefs: { dashboard_charts: { units: "3d-explosion", status: "pie", monthly: "line" } as unknown as Charts },
    });
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });
});

test.describe("acessibilidade e responsividade", () => {
  test("axe: cada combinação de tipos no relatório e o catálogo (WCAG 2.2 AA)", async ({ page }) => {
    const state = await open(page);
    for (const charts of [defaultDashboardCharts(), ...ALTERNATIVE]) {
      await reloadWithCharts(page, state, charts);
      await expectDashboardLoaded(page);
      await waitForAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    }
    await page.goto("/dashboard");
    await waitForHydration(page);
    await expectPanelsLoaded(page, "USER");
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  for (const width of [320, 375, 768, 1280]) {
    test(`${width}px: sem rolagem horizontal (catálogo e relatório, padrão e alternativos)`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 800 : 900 });
      const state = await open(page, { role: "USER" }, "/dashboard");
      await expectPanelsLoaded(page, "USER");
      await waitForAnimations(page);
      await noHorizontalOverflow(page);
      await page.goto("/dashboard/relatorio");
      for (const charts of [defaultDashboardCharts(), ...ALTERNATIVE]) {
        await reloadWithCharts(page, state, charts);
        await expectDashboardLoaded(page);
        await waitForAnimations(page);
        await noHorizontalOverflow(page);
      }
    });
  }
});
