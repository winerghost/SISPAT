import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  defaultDashboardCharts,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
  type PreferencesMock,
} from "./support/mocks";
import { expectDashboardLoaded, waitForAnimations } from "./support/screens";

// =============================================================================
// Tipo de gráfico de cada painel do dashboard (preferência `dashboard_charts`).
// Contrato MOCKADO (o backend é feito em paralelo):
//   GET/PATCH /api/v1/me/preferences
//     { dashboard_charts: { units, status, monthly, location, bond, rooms }, version }
//   PATCH envia só as chaves alteradas (+ version); `null` restaura o padrão; 409 = versão.
// Cobre: troca por mouse e teclado, persistência após recarregar, restaurar
// padrão, estado honesto (nada muda antes da confirmação), 409, 400, GET falho,
// tabela alternativa em todos os tipos, axe (menu aberto) e 320–1280 sem overflow.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PREFS_URL = (url: string) => url.endsWith("/v1/me/preferences");

type Charts = PreferencesMock["dashboard_charts"];

async function open(page: Page, opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto("/dashboard");
  await waitForHydration(page);
  await expectDashboardLoaded(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);
/** Painéis com seletor de tipo (dashboard_charts). */
const CHART_PANELS = [
  "por-unidade",
  "por-situacao",
  "aquisicoes-mensais",
  "localizacao-por-unidade",
  "por-vinculo",
  "por-sala",
] as const;
const trigger = (panel: Locator) => panel.getByRole("button", { name: /^Tipo de gráfico/ });
const patches = (state: MockState) => state.calls.filter((c) => c.method === "PATCH" && PREFS_URL(c.url));

async function choose(page: Page, panel: Locator, option: string): Promise<void> {
  await trigger(panel).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);
}

test.describe("padrões", () => {
  test("sem escolha: barras agrupadas, pizza e linhas; seletor em cada painel", async ({ page }) => {
    await open(page);
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de pizza/ })).toBeVisible();
    await expect(block(page, "aquisicoes-mensais").getByRole("img", { name: /Gráfico de linhas/ })).toBeVisible();
    await expect(block(page, "localizacao-por-unidade").getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(block(page, "por-vinculo").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    await expect(block(page, "por-sala").getByRole("img", { name: /Gráfico de barras horizontais/ })).toBeVisible();
    for (const id of CHART_PANELS) {
      const button = trigger(block(page, id));
      await expect(button).toHaveAttribute("aria-haspopup", "menu");
      await expect(button).toHaveAttribute("aria-expanded", "false");
    }
    // Pendências e inventário (cartões) também não têm seletor.
    await expect(trigger(block(page, "pendencias-cadastro"))).toHaveCount(0);
    await expect(trigger(block(page, "inventario"))).toHaveCount(0);
    // Indicadores e detalhamento não têm seletor.
    await expect(trigger(block(page, "indicadores"))).toHaveCount(0);
    await expect(trigger(block(page, "detalhamento"))).toHaveCount(0);
  });

  test("preferência salva no backend é aplicada ao abrir", async ({ page }) => {
    await open(page, {
      role: "ADM",
      prefs: {
        dashboard_charts: { units: "horizontal", status: "donut", monthly: "area", location: "grouped", bond: "pie", rooms: "bar" },
      },
    });
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras horizontais/ })).toBeVisible();
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    await expect(block(page, "aquisicoes-mensais").getByRole("img", { name: /Gráfico de áreas/ })).toBeVisible();
    await expect(block(page, "localizacao-por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(block(page, "por-vinculo").getByRole("img", { name: /Gráfico de pizza/ })).toBeVisible();
    await expect(block(page, "por-sala").getByRole("img", { name: /Gráfico de barras verticais/ })).toBeVisible();
  });
});

test.describe("troca de tipo", () => {
  test("mouse: escolhe barras empilhadas, PATCH só com a chave alterada, persiste após recarregar", async ({ page }) => {
    const state = await open(page);
    const panel = block(page, "por-unidade");
    await trigger(panel).click();
    await expect(trigger(panel)).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
    await expect(menu.getByRole("menuitemradio", { name: "Barras agrupadas" })).toHaveAttribute("aria-checked", "true");

    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await menu.getByRole("menuitemradio", { name: "Barras empilhadas" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 0, dashboard_charts: { units: "stacked" } });

    await expect(panel.getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    // O foco volta ao botão do painel.
    await expect(trigger(panel)).toBeFocused();
    expect(state.prefs.dashboard_charts).toEqual({ ...defaultDashboardCharts(), units: "stacked" });
    // Os outros painéis não mudaram.
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de pizza/ })).toBeVisible();

    await page.reload();
    await waitForHydration(page);
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await trigger(block(page, "por-unidade")).click();
    await expect(page.getByRole("menuitemradio", { name: "Barras empilhadas" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("teclado: abre, navega por setas, seleciona com Enter, Esc fecha e devolve o foco", async ({ page }) => {
    const state = await open(page);
    const panel = block(page, "por-situacao");
    const button = trigger(panel);

    await button.focus();
    await page.keyboard.press("Enter");
    // Foco cai no item atual (Pizza).
    await expect(page.getByRole("menuitemradio", { name: "Pizza" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Rosca" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Barras" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitemradio", { name: "Pizza" })).toBeFocused();
    await page.keyboard.press("End");
    // "Restaurar padrão" está desabilitado no padrão: End para no último item habilitado.
    await expect(page.getByRole("menuitemradio", { name: "Barras" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(patches(state)).toHaveLength(0);

    await page.keyboard.press("ArrowDown"); // abre pelo teclado
    await expect(page.getByRole("menuitemradio", { name: "Pizza" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    await expect(button).toBeFocused();
    expect(state.prefs.dashboard_charts.status).toBe("donut");
  });

  test("clicar fora fecha o menu sem salvar", async ({ page }) => {
    const state = await open(page);
    await trigger(block(page, "aquisicoes-mensais")).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("heading", { level: 1, name: "Dashboard" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(patches(state)).toHaveLength(0);
  });

  const cases: { panel: string; title: string; option: string; name: RegExp; table: string; kind: string }[] = [
    { panel: "por-unidade", title: "units", option: "Barras empilhadas", name: /Gráfico de barras empilhadas/, table: "Quantidade de bens por tipo em cada unidade", kind: "stacked" },
    { panel: "por-unidade", title: "units", option: "Barras horizontais", name: /Gráfico de barras horizontais/, table: "Quantidade de bens por tipo em cada unidade", kind: "horizontal" },
    { panel: "por-unidade", title: "units", option: "Barras agrupadas", name: /Gráfico de barras agrupadas/, table: "Quantidade de bens por tipo em cada unidade", kind: "grouped" },
    { panel: "por-situacao", title: "status", option: "Rosca", name: /Gráfico de rosca/, table: "Distribuição por situação", kind: "donut" },
    { panel: "por-situacao", title: "status", option: "Barras", name: /Gráfico de barras:/, table: "Distribuição por situação", kind: "bar" },
    { panel: "por-situacao", title: "status", option: "Pizza", name: /Gráfico de pizza/, table: "Distribuição por situação", kind: "pie" },
    { panel: "aquisicoes-mensais", title: "monthly", option: "Área", name: /Gráfico de áreas/, table: "Bens adquiridos por mês", kind: "area" },
    { panel: "aquisicoes-mensais", title: "monthly", option: "Barras", name: /Gráfico de barras:/, table: "Bens adquiridos por mês", kind: "grouped" },
    { panel: "aquisicoes-mensais", title: "monthly", option: "Linhas", name: /Gráfico de linhas/, table: "Bens adquiridos por mês", kind: "line" },
    { panel: "localizacao-por-unidade", title: "location", option: "Barras agrupadas", name: /Gráfico de barras agrupadas/, table: "Situação de localização em cada unidade de uso", kind: "grouped" },
    { panel: "localizacao-por-unidade", title: "location", option: "Barras horizontais", name: /Gráfico de barras horizontais/, table: "Situação de localização em cada unidade de uso", kind: "horizontal" },
    { panel: "localizacao-por-unidade", title: "location", option: "Barras empilhadas", name: /Gráfico de barras empilhadas/, table: "Situação de localização em cada unidade de uso", kind: "stacked" },
    { panel: "por-vinculo", title: "bond", option: "Pizza", name: /Gráfico de pizza/, table: "Quantidade de bens por vínculo", kind: "pie" },
    { panel: "por-vinculo", title: "bond", option: "Barras", name: /Gráfico de barras:/, table: "Quantidade de bens por vínculo", kind: "bar" },
    { panel: "por-vinculo", title: "bond", option: "Rosca", name: /Gráfico de rosca/, table: "Quantidade de bens por vínculo", kind: "donut" },
    { panel: "por-sala", title: "rooms", option: "Barras verticais", name: /Gráfico de barras verticais/, table: "Quantidade de bens por sala", kind: "grouped" },
    { panel: "por-sala", title: "rooms", option: "Barras horizontais", name: /Gráfico de barras horizontais/, table: "Quantidade de bens por sala", kind: "horizontal" },
  ];

  test("todos os tipos: role=img com resumo, legenda e tabela alternativa", async ({ page }) => {
    await open(page);
    for (const c of cases) {
      const panel = block(page, c.panel);
      await choose(page, panel, c.option);
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

  test("gráfico horizontal usa os mesmos números do backend na tabela", async ({ page }) => {
    await open(page);
    await choose(page, block(page, "por-unidade"), "Barras horizontais");
    const table = block(page, "por-unidade").getByRole("table", { name: "Quantidade de bens por tipo em cada unidade" });
    await expect(table.getByRole("row", { name: /Sede Sintética Palmas/ })).toBeVisible();
  });
});

test.describe("painéis novos (localização, vínculo, sala)", () => {
  test("PATCH só com a chave do painel; os outros não mudam; persiste após recarregar", async ({ page }) => {
    const state = await open(page);
    const steps = [
      { panel: "localizacao-por-unidade", option: "Barras horizontais", body: { location: "horizontal" }, name: /Gráfico de barras horizontais/ },
      { panel: "por-vinculo", option: "Barras", body: { bond: "bar" }, name: /Gráfico de barras:/ },
      { panel: "por-sala", option: "Barras verticais", body: { rooms: "bar" }, name: /Gráfico de barras verticais/ },
    ];
    for (const step of steps) {
      const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
      await choose(page, block(page, step.panel), step.option);
      const sent = (await request).postDataJSON() as { dashboard_charts: unknown };
      expect(sent.dashboard_charts).toEqual(step.body);
      await expect(block(page, step.panel).getByRole("img", { name: step.name })).toBeVisible();
      await expect(trigger(block(page, step.panel))).toBeFocused();
    }
    expect(state.prefs.dashboard_charts).toEqual({
      ...defaultDashboardCharts(),
      location: "horizontal",
      bond: "bar",
      rooms: "bar",
    });
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await page.reload();
    await waitForHydration(page);
    await expectDashboardLoaded(page);
    await expect(block(page, "por-vinculo").getByRole("img", { name: /Gráfico de barras:/ })).toBeVisible();
    await expect(block(page, "por-sala").getByRole("img", { name: /Gráfico de barras verticais/ })).toBeVisible();
  });

  test("menu do vínculo e da sala oferece só as opções do contrato; restaurar envia null", async ({ page }) => {
    const state = await open(page, { role: "USER", prefs: { dashboard_charts: { bond: "bar", rooms: "bar" } } });
    await trigger(block(page, "por-sala")).click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await trigger(block(page, "por-vinculo")).click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(3);
    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await page.getByRole("menuitem", { name: "Restaurar padrão" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 0, dashboard_charts: { bond: null } });
    await expect(block(page, "por-vinculo").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    expect(state.prefs.dashboard_charts.bond).toBe("donut");
    expect(state.prefs.dashboard_charts.rooms).toBe("bar");
  });
});

test.describe("restaurar padrão", () => {
  test("desabilitado no padrão; depois de escolher, envia null só daquele painel", async ({ page }) => {
    const state = await open(page, {
      role: "USER",
      prefs: { dashboard_charts: { units: "stacked", status: "bar", monthly: "line" } },
    });
    const panel = block(page, "por-situacao");

    // Painel já no padrão (linhas) => "Restaurar padrão" desabilitado.
    await trigger(block(page, "aquisicoes-mensais")).click();
    await expect(page.getByRole("menuitem", { name: "Restaurar padrão" })).toBeDisabled();
    await page.keyboard.press("Escape");

    await trigger(panel).click();
    const restore = page.getByRole("menuitem", { name: "Restaurar padrão" });
    await expect(restore).toBeEnabled();
    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await restore.click();
    expect((await request).postDataJSON()).toEqual({ version: 0, dashboard_charts: { status: null } });
    await expect(panel.getByRole("img", { name: /Gráfico de pizza/ })).toBeVisible();
    expect(state.prefs.dashboard_charts).toEqual({ ...defaultDashboardCharts(), units: "stacked" });
    // Os outros painéis seguem como estavam.
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
  });

  test("restaurar por teclado", async ({ page }) => {
    const state = await open(page, {
      role: "USER",
      prefs: { dashboard_charts: { units: "horizontal", status: "pie", monthly: "line" } },
    });
    const panel = block(page, "por-unidade");
    await trigger(panel).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Restaurar padrão" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    expect(state.prefs.dashboard_charts.units).toBe("grouped");
  });
});

test.describe("estado honesto e erros", () => {
  test("nada muda antes da confirmação do backend; durante o salvamento há aviso", async ({ page }) => {
    const state = await open(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let patchRequests = 0;
    await page.route("**/v1/me/preferences", async (route) => {
      if (route.request().method() === "PATCH") {
        patchRequests += 1;
        await gate;
      }
      await route.fallback();
    });

    const panel = block(page, "por-unidade");
    await choose(page, panel, "Barras empilhadas");
    await expect(panel.locator("[data-chart-saving]")).toHaveText(/Salvando/);
    // Pendente: o gráfico exibido continua o confirmado.
    await expect(panel.getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(panel.getByRole("img", { name: /Gráfico de barras empilhadas/ })).toHaveCount(0);
    expect(state.prefs.dashboard_charts.units).toBe("grouped");
    // Nenhum seletor abre enquanto salva (aria-disabled): clique real do mouse
    // (sem `force`, coordenadas do botão), Enter, Espaço e setas. O Playwright
    // não "clica" em elemento aria-disabled pelo locator (espera habilitar),
    // por isso o clique é feito pelo ponteiro na posição do botão.
    for (const id of ["por-situacao", "por-unidade"]) {
      const button = trigger(block(page, id));
      await expect(button).toHaveAttribute("aria-disabled", "true");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await button.focus();
      for (const key of ["Enter", " ", "ArrowDown", "ArrowUp"]) {
        await page.keyboard.press(key);
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(button).toHaveAttribute("aria-expanded", "false");
      }
    }
    // Nenhum PATCH além do pendente (o mock só registra após o portão abrir).
    expect(patchRequests).toBe(1);

    release();
    await expect(panel.getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(panel.locator("[data-chart-saving]")).toHaveCount(0);
    // Ao terminar o salvamento, o seletor volta a abrir normalmente.
    const other = trigger(block(page, "por-situacao"));
    await expect(other).not.toHaveAttribute("aria-disabled", "true");
    await other.click();
    await expect(page.getByRole("menu")).toBeVisible();
  });

  test("409: avisa, recarrega a versão nova e permite escolher de novo", async ({ page }) => {
    const state = await open(page);
    // Outra sessão salvou antes (versão 5, status em rosca).
    state.prefs = { ...state.prefs, version: 5, dashboard_charts: { ...defaultDashboardCharts(), status: "donut" } };
    const panel = block(page, "por-unidade");
    await choose(page, panel, "Barras horizontais");
    await expect(panel.getByRole("alert")).toContainText(/alteradas em outra sessão/);
    // Nada foi aplicado do que o usuário pediu; o estado novo do servidor vale.
    await expect(panel.getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();

    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await choose(page, panel, "Barras horizontais");
    expect((await request).postDataJSON()).toEqual({ version: 5, dashboard_charts: { units: "horizontal" } });
    await expect(panel.getByRole("img", { name: /Gráfico de barras horizontais/ })).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });

  test("400: mensagem fixa (sem texto do servidor) e o gráfico não muda", async ({ page }) => {
    await open(page);
    await page.route("**/v1/me/preferences", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "validation_error", message: "SISPAT_BACKEND_MSG" } }),
      });
    });
    const panel = block(page, "aquisicoes-mensais");
    await choose(page, panel, "Área");
    await expect(panel.getByRole("alert")).toHaveText("Não foi possível salvar o tipo de gráfico. Tente novamente.");
    await expect(page.locator("main")).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(panel.getByRole("img", { name: /Gráfico de linhas/ })).toBeVisible();
  });

  test("GET de preferências falha: padrões, sem seletor e sem quebrar o painel", async ({ page }) => {
    await open(page, { role: "USER", prefsGetStatus: 500 });
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });

  test("valor fora da allowlist na resposta é rejeitado (usa padrões, sem seletor)", async ({ page }) => {
    await open(page, {
      role: "USER",
      prefs: { dashboard_charts: { units: "3d-explosion", status: "pie", monthly: "line" } as unknown as Charts },
    });
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras agrupadas/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });
});

test.describe("acessibilidade e responsividade", () => {
  test("axe: menu aberto e cada combinação de tipos (WCAG 2.2 AA)", async ({ page }) => {
    await open(page);
    await trigger(block(page, "por-unidade")).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await waitForAnimations(page);
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await page.keyboard.press("Escape");

    await choose(page, block(page, "por-unidade"), "Barras horizontais");
    await choose(page, block(page, "por-situacao"), "Rosca");
    await choose(page, block(page, "aquisicoes-mensais"), "Área");
    await expect(block(page, "aquisicoes-mensais").getByRole("img", { name: /Gráfico de áreas/ })).toBeVisible();
    await waitForAnimations(page);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    await choose(page, block(page, "por-unidade"), "Barras empilhadas");
    await choose(page, block(page, "por-situacao"), "Barras");
    await choose(page, block(page, "aquisicoes-mensais"), "Barras");
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await waitForAnimations(page);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  for (const width of [320, 375, 768, 1280]) {
    test(`${width}px: sem rolagem horizontal (padrão, alternativos e menu aberto), axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 800 : 900 });
      const configs: Charts[] = [
        defaultDashboardCharts(),
        { units: "horizontal", status: "donut", monthly: "area", location: "horizontal", bond: "pie", rooms: "bar" },
        { units: "stacked", status: "bar", monthly: "bar", location: "grouped", bond: "bar", rooms: "horizontal" },
      ];
      const state = await open(page, { role: "USER", prefs: { dashboard_charts: configs[0]! } });
      await noHorizontalOverflow(page);
      for (const config of configs.slice(1)) {
        state.prefs = { ...state.prefs, dashboard_charts: config };
        await page.reload();
        await waitForHydration(page);
        await expectDashboardLoaded(page);
        await waitForAnimations(page);
        await noHorizontalOverflow(page);
      }

      // Menu aberto no último painel de cada linha (pior caso lateral) sem estourar a página.
      for (const id of CHART_PANELS) {
        await trigger(block(page, id)).click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        await noHorizontalOverflow(page);
        const box = await menu.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
      }

      await trigger(block(page, "por-unidade")).click();
      await waitForAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

  test("alvos de toque >= 44px no celular (botão e itens do menu)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page);
    const button = trigger(block(page, "por-unidade"));
    const buttonBox = await button.boundingBox();
    expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
    expect(buttonBox!.width).toBeGreaterThanOrEqual(44);
    await button.click();
    for (const item of await page.getByRole("menuitemradio").all()) {
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("foco visível no botão e nos itens do menu", async ({ page }) => {
    await open(page);
    const button = trigger(block(page, "por-situacao"));
    await button.focus();
    await expect(button).toHaveCSS("box-shadow", /rgb/);
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitemradio", { name: "Pizza" });
    await expect(item).toBeFocused();
    await expect(item).toHaveCSS("box-shadow", /rgb/);
  });

  test("reduced motion: troca de tipo funciona e o resultado é o mesmo", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await open(page);
    await choose(page, block(page, "por-situacao"), "Rosca");
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    expect(state.prefs.dashboard_charts.status).toBe("donut");
  });
});

test.describe("relatório imprimível", () => {
  test("usa o tipo escolhido e não mostra seletor", async ({ page }) => {
    const opts: MockOptions = {
      role: "USER",
      prefs: {
        dashboard_charts: { units: "stacked", status: "donut", monthly: "area", location: "horizontal", bond: "bar", rooms: "bar" },
      },
    };
    await installMocks(page, opts);
    await seedSession(page, opts);
    await page.goto("/dashboard/relatorio");
    await waitForHydration(page);
    await expectDashboardLoaded(page);
    await expect(block(page, "por-unidade").getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(block(page, "por-situacao").getByRole("img", { name: /Gráfico de rosca/ })).toBeVisible();
    await expect(block(page, "localizacao-por-unidade").getByRole("img", { name: /Gráfico de barras horizontais/ })).toBeVisible();
    await expect(block(page, "por-vinculo").getByRole("img", { name: /Gráfico de barras:/ })).toBeVisible();
    await expect(block(page, "por-sala").getByRole("img", { name: /Gráfico de barras verticais/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
  });
});
