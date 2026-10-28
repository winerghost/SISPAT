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
  type MockState,
} from "./support/mocks";
import { expectDashboardLoaded, expectPanelsLoaded } from "./support/screens";

// =============================================================================
// L-2 (docs/security/REVISAO_DASHBOARD_NIVO_2026-10-20.md): rótulos maliciosos
// são renderizados como TEXTO (escape do React) — legenda, tabela alternativa,
// eixo e tooltip — e dado de preferência/catálogo legado ou inválido nunca
// quebra a tela nem é exibido.
// Critério: `window.__xss` indefinido, nenhum <img src="x"> no DOM e o texto
// literal visível onde o rótulo aparece.
// Onda 3: /dashboard desenha SÓ o catálogo de painéis (seção "catálogo de
// painéis"); os 15 blocos antigos (variantes de gráfico, preferência
// `dashboard_charts`) só existem no relatório imprimível (/dashboard/relatorio)
// e são verificados lá.
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
    // `id` também malicioso: nunca vira filtro (o relatório não tem ação de clique).
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

async function open(page: Page, opts: MockOptions, path = "/dashboard/relatorio"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
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
async function hoverMarks(page: Page, scope: ReturnType<Page["locator"]>): Promise<void> {
  const surface = scope.locator("[data-chart-surface]").first();
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

test.describe("XSS por variante de gráfico — relatório imprimível (texto puro)", () => {
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
        await hoverMarks(page, block(page, id));
        await expectClean(page);
      }

      // O relatório não tem ação de clique: nenhum rótulo vira botão de filtro.
      await expect(page.getByRole("button", { name: /Filtrar/ })).toHaveCount(0);
      await expectClean(page);
    });
  }

  test("filtro malicioso herdado da URL: aparece como texto no cabeçalho do relatório, nada executa", async ({ page }) => {
    // `bond_status` com HTML na URL é listado como TEXTO literal (escape do React), sem virar <img>.
    const query = `bond_status=${encodeURIComponent(LABELS.bond)}`;
    await open(page, { role: "USER", dashboard: maliciousDashboard() }, `/dashboard/relatorio?${query}`);
    await expectDashboardLoaded(page);
    await expect(page.locator("[data-report-filters]")).toContainText(`Vínculo: ${LABELS.bond}`);
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

  test("situação com id desconhecido é só texto na legenda (sem botão no relatório)", async ({ page }) => {
    await open(page, { role: "USER", dashboard: maliciousDashboard(), prefs: { dashboard_charts: { status: "bar" } } });
    await expectDashboardLoaded(page);
    const legend = block(page, "por-situacao").getByRole("list", { name: /Legenda/ });
    await expect(legend).toContainText("Sit <img src=x");
    await expect(legend.getByRole("button")).toHaveCount(0);
  });
});

test.describe("preferência legada/inválida (relatório imprimível)", () => {
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
      await page.goto("/dashboard/relatorio");
      await waitForHydration(page);
      await expectDashboardLoaded(page);
      await expect(block(page, "por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "grouped");
      await expect(block(page, "por-vinculo").locator("figure")).toHaveAttribute("data-chart-kind", "donut");
      await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("donut");
      await expectClean(page);
    });
  }

  test("chave desconhecida é ignorada (valores válidos seguem valendo)", async ({ page }) => {
    const opts: MockOptions = { role: "USER" };
    await installMocks(page, opts);
    await routeRawPreferences(page, { units: "stacked", status: "pie", monthly: "line", x: 1, role: "ADM" });
    await seedSession(page, opts);
    await page.goto("/dashboard/relatorio");
    await waitForHydration(page);
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "stacked");
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });

  test("backend anterior (só units/status/monthly, sem layout): o relatório usa os padrões das chaves novas", async ({ page }) => {
    await open(page, { role: "USER", prefsLegacy: true, prefs: { dashboard_charts: { units: "horizontal" } } });
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "horizontal");
    await expect(block(page, "localizacao-por-unidade").locator("figure")).toHaveAttribute("data-chart-kind", "stacked");
    await expect(block(page, "por-sala").locator("figure")).toHaveAttribute("data-chart-kind", "horizontal");
  });
});

// ---------------------------------------------------------------------------
// Catálogo de painéis (/dashboard): equivalente, no contrato novo, do que as
// asserções acima protegem — rótulos do backend/planilha são texto, e resposta
// inválida do catálogo nunca é exibida nem quebra a tela.
// ---------------------------------------------------------------------------

const CAT = {
  unit: `Unid ${XSS_IMG}`,
  col: `Col ${XSS_SCRIPT}`,
  family: `Fam ${XSS_IMG}`,
  category: `Cat ${XSS_IMG}`,
};

const maliciousUnitRow = (unidade: string) => ({
  unidade,
  total: 15,
  valores: { COMPUTADOR: 10, NOTEBOOK: 5 },
});

const maliciousPayloads = {
  kpi_workstations: { tipo: "cartoes", dados: { itens: [{ id: "COMPUTADOR", label: CAT.col, value: 7 }], total: 7 } },
  equipment_by_unit_table: {
    tipo: "tabela",
    dados: {
      colunas: [
        { id: "COMPUTADOR", label: CAT.col },
        { id: "NOTEBOOK", label: "Notebook" },
      ],
      linhas: [maliciousUnitRow(CAT.unit)],
      total: 15,
    },
  },
  equipment_by_unit_chart: {
    tipo: "grafico",
    dados: {
      familia: "TI",
      familia_label: CAT.family,
      series: [
        { id: "COMPUTADOR", label: CAT.col },
        { id: "NOTEBOOK", label: "Notebook" },
      ],
      unidades: [maliciousUnitRow(CAT.unit)],
      total: 15,
    },
  },
  category_distribution: {
    tipo: "distribuicao",
    dados: {
      total: 20,
      familias: [{ id: "TI", label: CAT.family, value: 20, percentual: 100 }],
      categorias: [{ id: "COMPUTADOR", label: CAT.category, familia: "TI", value: 20, percentual: 100 }],
    },
  },
};

/** Catálogo mínimo VÁLIDO (1 painel) com um campo adulterado conforme `bad`. */
function catalogBody(bad: { id?: string; size?: string; prefId?: string; visible?: boolean }): Record<string, unknown> {
  const entry = {
    id: bad.id ?? "kpi_workstations",
    label: "Postos de trabalho",
    description: "",
    group: "indicadores",
    sizes: ["P", "M", "G"],
    default_size: "M",
    exportable: false,
  };
  const pref = { id: bad.prefId ?? entry.id, visible: bad.visible ?? true, size: bad.size ?? "M" };
  return { panels: [entry], sizes: ["P", "M", "G"], default_layout: [pref], preferences: { panels: [pref], version: 0 } };
}

test.describe("catálogo de painéis: rótulos maliciosos são texto puro", () => {
  test("cartões, tabela, gráfico (legenda, tabela alternativa, tooltip) e distribuição", async ({ page }) => {
    await open(page, { role: "USER", dashboardPanels: { payloadOverride: maliciousPayloads } }, "/dashboard");
    await expectPanelsLoaded(page, "USER");

    const panel = (id: string) => page.locator(`[data-equipment-panel=${id}]`);
    await expect(panel("kpi_workstations")).toContainText("Col <script>");
    await expect(panel("equipment_by_unit_table").locator("table")).toContainText(CAT.unit);
    await expect(panel("equipment_by_unit_table").locator("table")).toContainText("Col <script>");
    const chart = panel("equipment_by_unit_chart");
    await expect(chart).toContainText(CAT.unit);
    await expect(panel("category_distribution")).toContainText("Cat <img src=x");
    await expectClean(page);

    await hoverMarks(page, chart);
    await expectClean(page);
  });

  const invalidCatalogs: { name: string; body: unknown }[] = [
    { name: "não é objeto", body: ["kpi_workstations"] },
    { name: "id de painel com HTML", body: catalogBody({ id: XSS_IMG }) },
    { name: "tamanho fora de P/M/G", body: catalogBody({ size: "XG" }) },
    { name: "painel das preferências fora do catálogo", body: catalogBody({ prefId: "painel_inexistente" }) },
    { name: "nenhum painel visível", body: catalogBody({ visible: false }) },
  ];
  for (const { name, body } of invalidCatalogs) {
    test(`catálogo inválido (${name}): erro com nova tentativa, nenhum painel nem valor exibido`, async ({ page }) => {
      await open(page, { role: "USER", dashboardPanels: { rawCatalog: body } }, "/dashboard");
      await expect(page.locator("[data-equipment-catalog-error]")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-equipment-catalog-error]").getByRole("button", { name: "Tentar novamente" })).toBeVisible();
      await expect(page.locator("[data-equipment-panel]")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("XG");
      await expectClean(page);
    });
  }

  test("chave desconhecida/privilegiada na resposta é ignorada (perfil nunca vem do cliente)", async ({ page }) => {
    const body = { ...catalogBody({}), role: "ADM", x: 1 };
    await open(page, { role: "USER", dashboardPanels: { rawCatalog: body } }, "/dashboard");
    await expect(page.locator("[data-equipment-panel=kpi_workstations]")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-equipment-panel=sync_status]")).toHaveCount(0);
  });
});
