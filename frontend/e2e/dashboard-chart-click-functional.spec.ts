import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { DASH_ROOM_ID, defaultDashboard, type DashboardMockData } from "./support/dashboard-mocks";
import { UNITS, installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";
import { DASHBOARD_FILTERED_QUERY, expectDashboardLoaded, openMobileFilters, waitForAnimations } from "./support/screens";

// =============================================================================
// Clique no gráfico → filtro da URL (docs/ux/DASHBOARD_PERSONALIZACAO.md).
//   situação/localizado → located; vínculo → bond_status; sala → room_id
//   ("Sem sala" → has_room=false); unidade → unit_id (sigla que identifica UMA
//   unidade acessível). "Outros"/"Outras" e unidade sem correspondência: sem ação.
// Alternativa por teclado: botões da legenda (situação, vínculo) e
// "Filtrar pelo gráfico" (unidade, localização, sala), com aria-pressed.
// Também: barra de filtros recolhível no celular (< 768px).
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const [UNIT_1, UNIT_2] = UNITS;

async function open(page: Page, opts: MockOptions = { role: "USER" }, path = "/dashboard"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  await expectDashboardLoaded(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);
const summary = (page: Page) => page.locator("[data-dashboard-filter-summary]");

/** Dados com siglas reais das unidades acessíveis (PSU-TO, ESC-02) + sem correspondência + "Outras". */
function unitCodeDashboard(): Partial<DashboardMockData> {
  const tipos = { MOBILIARIO: 10, INFORMATICA: 5 };
  return {
    "por-unidade": [
      { unidade: UNIT_1!.code, total: 300, tipos: { MOBILIARIO: 200, INFORMATICA: 100 } },
      { unidade: UNIT_2!.code, total: 120, tipos: { MOBILIARIO: 70, INFORMATICA: 50 } },
      { unidade: "SEM-CORRESP", total: 15, tipos },
      { unidade: "Outras", total: 15, tipos },
    ],
    "localizacao-por-unidade": [
      { unidade: UNIT_1!.code, sim: 250, nao: 40, desconhecido: 10, total: 300 },
      { unidade: UNIT_2!.code, sim: 100, nao: 15, desconhecido: 5, total: 120 },
      { unidade: "Outras", sim: 20, nao: 8, desconhecido: 2, total: 30 },
    ],
  };
}

/** Barras do Nivo (o 1º <rect> filho direto do <svg> é o fundo). */
const bars = (panel: Locator) => panel.locator("[data-chart-surface] svg g rect");

/** Barra mais à esquerda (= 1ª categoria nos gráficos verticais). */
async function leftmostBar(panel: Locator): Promise<Locator> {
  const rects = bars(panel);
  await expect(rects.first()).toBeVisible();
  const boxes = await rects.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, w: r.width, h: r.height };
    }),
  );
  let best = -1;
  boxes.forEach((b, i) => {
    if (b.w > 2 && b.h > 2 && (best < 0 || b.x < boxes[best]!.x)) best = i;
  });
  expect(best).toBeGreaterThanOrEqual(0);
  return rects.nth(best);
}

function lastCall(state: MockState, endpoint: string): URLSearchParams | undefined {
  return state.calls
    .filter((c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `/api/v1/dashboard/${endpoint}`)
    .map((c) => new URL(c.url, "http://x").searchParams)
    .at(-1);
}

test.describe("situação e vínculo (legenda + clique)", () => {
  test("teclado na legenda da situação aplica located e alterna", async ({ page }) => {
    const state = await open(page);
    const legendButton = block(page, "por-situacao").getByRole("button", { name: /Filtrar por situação: Nao localizado/ });
    await legendButton.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dashboard\?located=NAO$/);
    await expect(summary(page)).toContainText("Localizado: Não");
    await expect(legendButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => lastCall(state, "por-vinculo")?.get("located")).toBe("NAO");
    // Seletor da barra de filtros acompanha a URL.
    await expect(page.getByLabel("Localizado", { exact: true })).toHaveValue("NAO");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(legendButton).toHaveAttribute("aria-pressed", "false");
  });

  test("mouse numa fatia da pizza aplica o filtro de situação", async ({ page }) => {
    await open(page);
    const surface = block(page, "por-situacao").locator("[data-chart-surface]");
    await expect(surface).toHaveAttribute("data-chart-interactive", "true");
    await surface.scrollIntoViewIfNeeded();
    const box = (await surface.boundingBox())!;
    const radius = Math.min(box.width, box.height) / 2 - 8;
    // "LOCALIZADO" (1.100 de 1.234) começa às 12h e cobre ~89% do círculo no
    // sentido horário: o ponto às 9h fica dentro dele.
    await page.mouse.click(box.x + box.width / 2 - radius * 0.5, box.y + box.height / 2);
    await expect(page).toHaveURL(/located=SIM/);
  });

  test("vínculo em barras: clique aplica bond_status; 'Sem vínculo' usa __none__", async ({ page }) => {
    await open(page, { role: "USER", prefs: { dashboard_charts: { bond: "bar" } } });
    const panel = block(page, "por-vinculo");
    await (await leftmostBar(panel)).click();
    await expect(page).toHaveURL(/bond_status=Servidor/);
    await expect(summary(page)).toContainText("Vínculo: Servidor");
    await panel.getByRole("button", { name: /Filtrar por vínculo: Sem vínculo/ }).click();
    await expect(page).toHaveURL(/bond_status=__none__/);
    await expect(summary(page)).toContainText("Vínculo: Sem vínculo");
  });

  test("'Outros' (agregado) não é botão nem filtra", async ({ page }) => {
    const base = defaultDashboard();
    await open(page, {
      role: "USER",
      prefs: { dashboard_charts: { bond: "bar" } },
      dashboard: { "por-vinculo": [...base["por-vinculo"], { id: "__outros__", label: "Outros", value: 30 }] },
    });
    const legend = block(page, "por-vinculo").getByRole("list", { name: /Legenda/ });
    await expect(legend).toContainText("Outros");
    await expect(legend.getByRole("button", { name: /Outros/ })).toHaveCount(0);
  });
});

test.describe("unidade, localização e sala (barras + 'Filtrar pelo gráfico')", () => {
  test("unidade: só siglas com UMA unidade acessível viram botão; clique aplica unit_id", async ({ page }) => {
    await open(page, { role: "USER", dashboard: unitCodeDashboard() });
    const panel = block(page, "por-unidade");
    const toggle = panel.getByRole("button", { name: /Filtrar pelo gráfico/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const group = panel.getByRole("list", { name: "Unidade de uso" });
    await expect(group.getByRole("button")).toHaveCount(2);
    await expect(group.getByRole("button", { name: "SEM-CORRESP" })).toHaveCount(0);
    await expect(group.getByRole("button", { name: "Outras" })).toHaveCount(0);

    const esc = group.getByRole("button", { name: UNIT_2!.code });
    await esc.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`unit_id=${UNIT_2!.id}`));
    await expect(esc).toHaveAttribute("aria-pressed", "true");
    await expect(summary(page)).toContainText(`Unidade de uso: ${UNIT_2!.code}`);
  });

  test("unidade: clique na barra (mouse) aplica unit_id da 1ª unidade", async ({ page }) => {
    await open(page, { role: "USER", dashboard: unitCodeDashboard() });
    await (await leftmostBar(block(page, "por-unidade"))).click();
    await expect(page).toHaveURL(new RegExp(`unit_id=${UNIT_1!.id}`));
  });

  test("localização: segmento aplica unidade + localizado; botões oferecem os dois grupos", async ({ page }) => {
    await open(page, { role: "USER", dashboard: unitCodeDashboard() });
    const panel = block(page, "localizacao-por-unidade");
    await (await leftmostBar(panel)).click();
    await expect(page).toHaveURL(new RegExp(`unit_id=${UNIT_1!.id}&located=(SIM|NAO|DESCONHECIDO)`));

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await panel.getByRole("button", { name: /Filtrar pelo gráfico/ }).click();
    await expect(panel.getByRole("list", { name: "Unidade de uso" }).getByRole("button")).toHaveCount(2);
    await panel.getByRole("list", { name: "Localizado" }).getByRole("button", { name: "Não localizado" }).click();
    await expect(page).toHaveURL(/\/dashboard\?located=NAO$/);
  });

  test("sala: botão aplica room_id; 'Sem sala' troca por has_room=false; 'Outras' não aparece", async ({ page }) => {
    const state = await open(page);
    const panel = block(page, "por-sala");
    await panel.getByRole("button", { name: /Filtrar pelo gráfico/ }).click();
    const group = panel.getByRole("list", { name: "Sala" });
    await expect(group.getByRole("button", { name: "Outras" })).toHaveCount(0);
    await group.getByRole("button", { name: "Recepção Sintética" }).click();
    await expect(page).toHaveURL(new RegExp(`room_id=${DASH_ROOM_ID}$`));
    await expect.poll(() => lastCall(state, "resumo")?.get("room_id")).toBe(DASH_ROOM_ID);

    await group.getByRole("button", { name: "Sem sala" }).click();
    await expect(page).toHaveURL(/\/dashboard\?has_room=false$/);
    await expect(summary(page)).toContainText("Sala cadastrada: Sem sala");
  });

  test("sala: clique na barra horizontal mais alta (1ª sala) aplica room_id", async ({ page }) => {
    await open(page);
    const rects = bars(block(page, "por-sala"));
    await expect(rects.first()).toBeVisible();
    const tops = await rects.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    const first = tops.indexOf(Math.min(...tops));
    await rects.nth(first).click();
    await expect(page).toHaveURL(new RegExp(`room_id=${DASH_ROOM_ID}`));
  });

  test("axe com 'Filtrar pelo gráfico' aberto e filtro aplicado (WCAG 2.2 AA)", async ({ page }) => {
    await open(page, { role: "USER", dashboard: unitCodeDashboard() });
    for (const id of ["por-unidade", "localizacao-por-unidade", "por-sala"]) {
      await block(page, id).getByRole("button", { name: /Filtrar pelo gráfico/ }).click();
    }
    await block(page, "por-sala").getByRole("button", { name: "Recepção Sintética" }).click();
    await expect(page).toHaveURL(/room_id=/);
    await expectDashboardLoaded(page);
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});

test.describe("relatório", () => {
  test("sem ação de clique: nem legenda clicável nem 'Filtrar pelo gráfico'", async ({ page }) => {
    await open(page, { role: "USER" }, "/dashboard/relatorio");
    await expect(page.getByRole("button", { name: /Filtrar pelo gráfico/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Filtrar por (situação|vínculo)/ })).toHaveCount(0);
    await expect(page.locator("[data-chart-interactive]")).toHaveCount(0);
  });
});

test.describe("barra de filtros no celular", () => {
  for (const width of [320, 375, 430]) {
    test(`${width}px: recolhida por padrão com "Filtros (N ativos)"; abre e fecha; sem rolagem`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, { role: "USER" }, `/dashboard?${DASHBOARD_FILTERED_QUERY}`);
      const toggle = page.locator("[data-dashboard-filters-toggle]");
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveText(/Filtros \(5 ativos\)/);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByLabel("Localizado", { exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: "Limpar filtros" })).toBeHidden();
      // O resumo continua visível com a barra fechada.
      await expect(summary(page)).toContainText("Vínculo: Ocioso");
      const box = (await toggle.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(24);

      await openMobileFilters(page);
      await expect(page.getByLabel("Localizado", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Localizado", { exact: true })).toHaveValue("NAO");
      for (const control of await page.locator("[data-dashboard-filters]").locator("select:visible, input:visible, button:visible").all()) {
        const b = (await control.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(24);
        expect(b.x + b.width).toBeLessThanOrEqual(width);
      }
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
      await waitForAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByLabel("Localizado", { exact: true })).toBeHidden();
    });
  }

  test("1 filtro: texto no singular; sem filtros: 0 ativos", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, { role: "USER" }, "/dashboard?located=SIM");
    await expect(page.locator("[data-dashboard-filters-toggle]")).toHaveText(/Filtros \(1 ativo\)/);
    await page.getByRole("button", { name: /Filtros \(1 ativo\)/ }).click();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.locator("[data-dashboard-filters-toggle]")).toHaveText(/Filtros \(0 ativos\)/);
  });

  for (const width of [768, 1024, 1920]) {
    test(`${width}px: sem botão de recolher; controles sempre visíveis`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await expect(page.locator("[data-dashboard-filters-toggle]")).toBeHidden();
      await expect(page.getByLabel("Localizado", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Filtros", exact: true })).toBeVisible();
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  }
});
