import { expect, test, type Page } from "@playwright/test";

import { defaultDashboard, type DashboardMockData } from "./support/dashboard-mocks";
import {
  XSS_IMG,
  XSS_SCRIPT,
  expectNoXss,
  installMocks,
  seedSession,
  waitForHydration,
  type DashboardChartsMock,
  type MockOptions,
} from "./support/mocks";
import { expectDashboardLoaded } from "./support/screens";

// =============================================================================
// L-2 (docs/security/REVISAO_DASHBOARD_NIVO_2026-10-20.md): rótulos maliciosos
// em TODAS as variantes de gráfico são renderizados como TEXTO (escape do
// React) — legenda, tabela alternativa, eixo, tooltip e botões de filtro — e
// dado de preferência legado/inválido nunca quebra a tela nem é exibido.
// Critério: `window.__xss` indefinido, nenhum <img src="x"> no DOM e o texto
// literal visível onde o rótulo aparece.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);

const LABELS = {
  unit: `Unid ${XSS_IMG}`,
  type: `Tipo ${XSS_SCRIPT}`,
  situation: `Sit ${XSS_IMG}`,
  series: `Serie ${XSS_IMG}`,
  location: `Loc ${XSS_IMG}`,
  bond: `Vinc ${XSS_IMG}`,
  room: `Sala ${XSS_IMG}`,
};

function maliciousDashboard(): Partial<DashboardMockData> {
  const base = defaultDashboard();
  return {
    "por-unidade": [
      { unidade: LABELS.unit, total: 5010, tipos: { [LABELS.type]: 5000, MOBILIARIO: 10 } },
      ...base["por-unidade"],
    ],
    "por-situacao": [{ id: LABELS.situation, value: 7 }, ...base["por-situacao"]],
    "aquisicoes-mensais": [
      {
        id: LABELS.series,
        data: [
          { x: "2026-09", y: 3 },
          { x: "2026-10", y: 4 },
        ],
      },
      ...base["aquisicoes-mensais"],
    ],
    "localizacao-por-unidade": [
      { unidade: LABELS.location, sim: 3, nao: 2, desconhecido: 1, total: 6 },
      ...base["localizacao-por-unidade"],
    ],
    // `id` também malicioso: vira bond_status na URL (codificado) se clicado.
    "por-vinculo": [{ id: LABELS.bond, label: LABELS.bond, value: 900 }, ...base["por-vinculo"]],
    "por-sala": [{ id: "80000000-0000-4000-8000-0000000000ee", label: LABELS.room, value: 400 }, ...base["por-sala"]],
  };
}

const VARIANTS: { name: string; charts: DashboardChartsMock }[] = [
  {
    name: "padrões (agrupadas, pizza, linhas, empilhadas, rosca, horizontais)",
    charts: { units: "grouped", status: "pie", monthly: "line", location: "stacked", bond: "donut", rooms: "horizontal" },
  },
  {
    name: "alternativas 1 (empilhadas, rosca, área, agrupadas, pizza, verticais)",
    charts: { units: "stacked", status: "donut", monthly: "area", location: "grouped", bond: "pie", rooms: "bar" },
  },
  {
    name: "alternativas 2 (horizontais, barras, barras, horizontais, barras, horizontais)",
    charts: { units: "horizontal", status: "bar", monthly: "bar", location: "horizontal", bond: "bar", rooms: "horizontal" },
  },
];

async function open(page: Page, opts: MockOptions): Promise<void> {
  await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto("/dashboard");
  await waitForHydration(page);
}

/** Responde o GET de preferências com um corpo CRU (sem a mescla de padrões do mock). */
async function routeRawPreferences(page: Page, dashboardCharts: unknown): Promise<void> {
  await page.route("**/v1/me/preferences", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ density: "comfortable", font_scale: 100, dashboard_charts: dashboardCharts, version: 3 }),
    });
  });
}

async function expectClean(page: Page): Promise<void> {
  const xss = await expectNoXss(page);
  expect(xss.executed, "marcador XSS executou").toBeUndefined();
  expect(xss.injectedImgs, "<img src=x> injetado").toBe(0);
  expect(await page.locator("main img").count()).toBe(0);
}

/** Passa o ponteiro sobre as marcas do gráfico (abre o tooltip do Nivo). */
async function hoverMarks(page: Page, id: string): Promise<void> {
  const surface = block(page, id).locator("[data-chart-surface]");
  await surface.scrollIntoViewIfNeeded();
  const marks = surface.locator("svg g rect, svg path");
  const count = Math.min(await marks.count(), 6);
  for (let i = 0; i < count; i += 1) {
    const mark = marks.nth(i);
    const box = await mark.boundingBox();
    if (box && box.width > 2 && box.height > 2) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe("XSS por variante de gráfico (texto puro)", () => {
  for (const variant of VARIANTS) {
    test(variant.name, async ({ page }) => {
      await open(page, { role: "USER", dashboard: maliciousDashboard(), prefs: { dashboard_charts: variant.charts } });
      await expectDashboardLoaded(page);

      // Texto literal nas tabelas alternativas / legendas de cada painel.
      await expect(block(page, "por-unidade").getByRole("table", { name: /em cada unidade/ })).toContainText(LABELS.unit);
      await expect(block(page, "por-unidade").getByRole("list", { name: /Legenda/ })).toContainText("Tipo <script>");
      await expect(block(page, "por-situacao").getByRole("list", { name: /Legenda/ })).toContainText("Sit <img src=x");
      await expect(block(page, "aquisicoes-mensais").getByRole("list", { name: /Legenda/ })).toContainText("Serie <img src=x");
      await expect(block(page, "localizacao-por-unidade").getByRole("table")).toContainText(LABELS.location);
      await expect(block(page, "por-vinculo").getByRole("table")).toContainText(LABELS.bond);
      await expect(block(page, "por-sala").getByRole("table")).toContainText(LABELS.room);
      await expect(page.getByRole("table", { name: /Detalhamento/ })).toContainText(LABELS.unit);

      for (const id of ["por-unidade", "por-situacao", "aquisicoes-mensais", "localizacao-por-unidade", "por-vinculo", "por-sala"]) {
        await hoverMarks(page, id);
        await expectClean(page);
      }

      // Botões de filtro com rótulo malicioso (sala) são texto.
      const rooms = block(page, "por-sala");
      await rooms.getByRole("button", { name: /Filtrar pelo gráfico/ }).click();
      await expect(rooms.getByRole("button", { name: LABELS.room })).toBeVisible();
      await expectClean(page);
    });
  }

  test("filtrar pelo vínculo malicioso: URL codificada, resumo em texto, nada executa", async ({ page }) => {
    await open(page, { role: "USER", dashboard: maliciousDashboard(), prefs: { dashboard_charts: { bond: "bar" } } });
    await expectDashboardLoaded(page);
    await block(page, "por-vinculo").getByRole("button", { name: /Filtrar por vínculo: Vinc/ }).click();
    await expect(page).toHaveURL(/bond_status=Vinc\+%3Cimg/);
    await expect(page.locator("[data-dashboard-filter-summary]")).toContainText(`Vínculo: ${LABELS.bond}`);
    await expectDashboardLoaded(page);
    await expectClean(page);
  });

  test("tooltip do Nivo mostra o rótulo malicioso como texto (barras e linhas)", async ({ page }) => {
    await open(page, { role: "USER", dashboard: maliciousDashboard() });
    await expectDashboardLoaded(page);
    // Unidades (barras agrupadas): a barra mais à esquerda é a da unidade maliciosa.
    const units = block(page, "por-unidade").locator("[data-chart-surface]");
    await units.scrollIntoViewIfNeeded();
    const rects = units.locator("svg g rect");
    const xs = await rects.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
    const first = rects.nth(xs.indexOf(Math.min(...xs)));
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + Math.max(2, box.height - 4));
    await expect(units).toContainText(LABELS.unit);
    await expectClean(page);
  });

  test("situação com id desconhecido não vira filtro (sem botão, sem ação no clique)", async ({ page }) => {
    await open(page, { role: "USER", dashboard: maliciousDashboard(), prefs: { dashboard_charts: { status: "bar" } } });
    await expectDashboardLoaded(page);
    const legend = block(page, "por-situacao").getByRole("list", { name: /Legenda/ });
    await expect(legend).toContainText("Sit <img src=x");
    await expect(legend.getByRole("button", { name: /Sit/ })).toHaveCount(0);
    await expect(legend.getByRole("button", { name: /Localizado/ })).toHaveCount(1);
  });
});

test.describe("preferência legada/inválida", () => {
  const invalidCharts: { name: string; charts: unknown }[] = [
    { name: "valor de outro painel (units: pie)", charts: { units: "pie", status: "pie", monthly: "line" } },
    { name: "valor com HTML", charts: { units: XSS_IMG, status: "pie", monthly: "line" } },
    { name: "chave nova com valor inválido (rooms: donut)", charts: { units: "grouped", status: "pie", monthly: "line", rooms: "donut" } },
    { name: "chave obrigatória ausente", charts: { status: "pie", monthly: "line" } },
    { name: "não é objeto", charts: ["grouped"] },
  ];
  for (const { name, charts } of invalidCharts) {
    test(`dashboard_charts inválido (${name}): padrões, sem seletor, sem exibir o valor`, async ({ page }) => {
      const opts: MockOptions = { role: "USER" };
      await installMocks(page, opts);
      await routeRawPreferences(page, charts);
      await seedSession(page, opts);
      await page.goto("/dashboard");
      await waitForHydration(page);
      await expectDashboardLoaded(page);
      await expect(block(page, "por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "grouped");
      await expect(block(page, "por-vinculo").locator("figure")).toHaveAttribute("data-chart-kind", "donut");
      await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Personalizar painéis" })).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("donut");
      await expectClean(page);
    });
  }

  test("chave desconhecida é ignorada (valores válidos seguem valendo)", async ({ page }) => {
    const opts: MockOptions = { role: "USER" };
    await installMocks(page, opts);
    await routeRawPreferences(page, { units: "stacked", status: "pie", monthly: "line", x: 1, role: "ADM" });
    await seedSession(page, opts);
    await page.goto("/dashboard");
    await waitForHydration(page);
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "stacked");
    await expect(block(page, "por-unidade").getByRole("button", { name: /^Tipo de gráfico/ })).toBeVisible();
  });

  test("backend anterior (só units/status/monthly, sem layout): novos painéis no padrão, PATCH funciona", async ({ page }) => {
    await open(page, { role: "USER", prefsLegacy: true, prefs: { dashboard_charts: { units: "horizontal" } } });
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "horizontal");
    await expect(block(page, "localizacao-por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "stacked");
    const request = page.waitForRequest((r) => r.url().endsWith("/v1/me/preferences") && r.method() === "PATCH");
    await block(page, "por-sala").getByRole("button", { name: /^Tipo de gráfico/ }).click();
    await page.getByRole("menuitemradio", { name: "Barras verticais" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 0, dashboard_charts: { rooms: "bar" } });
    await expect(block(page, "por-sala").locator("figure")).toHaveAttribute("data-chart-kind", "grouped");
  });
});
