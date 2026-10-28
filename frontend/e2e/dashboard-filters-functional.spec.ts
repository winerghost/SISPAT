import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { DASHBOARD_ENDPOINTS, defaultDashboard, type DashboardEndpoint } from "./support/dashboard-mocks";
import {
  UNITS,
  XSS_IMG,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";
import {
  DASHBOARD_FILTERED_QUERY,
  expectDashboardLoaded,
  expectPanelsLoaded,
  panelIdsFor,
  waitForAnimations,
} from "./support/screens";

// =============================================================================
// Filtros do dashboard (Onda 3). /dashboard é governado pelo catálogo de painéis:
// os filtros são família, unidade e categoria (dentro da grade), enviados a
// GET /api/v1/dashboard/panels/<id>/data; o mock recusa (400) parâmetro fora
// dessa allowlist, como o backend. A antiga barra de filtros na URL (cerca de 10
// filtros dos 15 painéis antigos) não existe mais em /dashboard; o relatório
// imprimível (/dashboard/relatorio) ainda herda filtros legados da URL.
// Cobre: filtro → TODAS as consultas dos painéis visíveis levam o parâmetro (sem
// recarregar); família limita as categorias; "Limpar filtros"; URL legada é
// ignorada (nenhum parâmetro antigo sai); relatório lista e aplica os filtros;
// erro/XSS/números dos blocos do relatório; teclado, axe e 320/768px.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const [UNIT_1] = UNITS;
const UNIT_1_LABEL = `${UNIT_1!.code} — ${UNIT_1!.name}`;

async function open(page: Page, path = "/dashboard", opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);
const filters = (page: Page) => page.locator("[data-equipment-filters]");
/** Seletor nativo da barra de filtros pelo rótulo visível (exato). */
const select = (page: Page, name: string) => filters(page).getByLabel(name, { exact: true });

/** Query strings das consultas `/panels/<id>/data` (opcionalmente de um painel). */
function dataCalls(state: MockState, id?: string): URLSearchParams[] {
  return state.panels.calls
    .filter((c) => c.method === "GET" && c.url.includes("/data") && (!id || c.url.includes(`/panels/${id}/data`)))
    .map((c) => new URL(c.url, "http://x").searchParams);
}

/** Todo painel visível recebeu ao menos uma consulta com estes parâmetros. */
async function expectAllPanelsCalledWith(state: MockState, ids: readonly string[], expected: Record<string, string>) {
  await expect
    .poll(() =>
      ids.filter(
        (id) => !dataCalls(state, id).some((params) => Object.entries(expected).every(([k, v]) => params.get(k) === v)),
      ),
    )
    .toEqual([]);
}

function no400(state: MockState): void {
  // O mock responde 400 a qualquer chave fora da allowlist; nenhuma consulta pode
  // tê-la nem repetir chave.
  const allowed = new Set(["unit_id", "familia", "categoria"]);
  for (const params of dataCalls(state)) {
    for (const key of new Set(params.keys())) {
      expect(allowed.has(key), key).toBe(true);
      expect(params.getAll(key)).toHaveLength(1);
    }
  }
}

/** Query strings das chamadas GET a um endpoint (legado) do dashboard. */
function legacyCalls(state: MockState, endpoint: DashboardEndpoint): URLSearchParams[] {
  return state.calls
    .filter((c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `/api/v1/dashboard/${endpoint}`)
    .map((c) => new URL(c.url, "http://x").searchParams);
}

/** Todo endpoint (de bloco do relatório) recebeu ao menos uma chamada com estes parâmetros. */
async function expectAllEndpointsCalledWith(state: MockState, expected: Record<string, string>): Promise<void> {
  const panels = DASHBOARD_ENDPOINTS.filter((e) => e !== "tipos");
  await expect
    .poll(() =>
      panels.filter(
        (endpoint) =>
          !legacyCalls(state, endpoint).some((params) => Object.entries(expected).every(([k, v]) => params.get(k) === v)),
      ),
    )
    .toEqual([]);
}

test.describe("filtros dos painéis (família, unidade, categoria)", () => {
  test("filtro não recarrega a página e todas as consultas dos painéis visíveis levam o parâmetro", async ({ page }) => {
    const state = await open(page);
    const ids = panelIdsFor("USER");
    await expectPanelsLoaded(page, "USER");
    await expect(filters(page)).toContainText("Sem filtros: todos os bens visíveis ao seu perfil.");
    expect(dataCalls(state).every((p) => p.size === 0)).toBe(true);
    // Marca a página: se houver recarga, o marcador some.
    await page.evaluate(() => ((window as unknown as { __sameDoc: boolean }).__sameDoc = true));

    await select(page, "Família").selectOption("TI");
    await expectAllPanelsCalledWith(state, ids, { familia: "TI" });
    await select(page, "Categoria").selectOption("NOTEBOOK");
    await expectAllPanelsCalledWith(state, ids, { familia: "TI", categoria: "NOTEBOOK" });
    await select(page, "Unidade").selectOption(UNIT_1!.id);
    await expectAllPanelsCalledWith(state, ids, { familia: "TI", categoria: "NOTEBOOK", unit_id: UNIT_1!.id });
    expect(await page.evaluate(() => (window as unknown as { __sameDoc?: boolean }).__sameDoc)).toBe(true);

    await expect(filters(page)).toContainText("3 filtro(s) ativo(s).");
    await expectPanelsLoaded(page, "USER");
    no400(state);
  });

  test("a família limita as categorias e descarta a categoria incompatível", async ({ page }) => {
    const state = await open(page);
    await expectPanelsLoaded(page, "USER");
    await select(page, "Família").selectOption("TI");
    await select(page, "Categoria").selectOption("NOTEBOOK");
    await expect(select(page, "Categoria").locator("option", { hasText: "Mesa" })).toHaveCount(0);
    await select(page, "Família").selectOption("MOBILIARIO");
    await expect(select(page, "Categoria")).toHaveValue("");
    await expect(select(page, "Categoria").locator("option", { hasText: "Mesa" })).toHaveCount(1);
    await expect.poll(() => dataCalls(state).some((p) => p.get("familia") === "MOBILIARIO" && !p.has("categoria"))).toBe(true);
    no400(state);
  });

  test("Limpar filtros volta ao total (consultas sem parâmetro)", async ({ page }) => {
    const state = await open(page);
    await expectPanelsLoaded(page, "USER");
    await select(page, "Família").selectOption("OUTROS");
    await expect(filters(page)).toContainText("1 filtro(s) ativo(s).");
    await expectPanelsLoaded(page, "USER");
    const clear = filters(page).getByRole("button", { name: "Limpar filtros" });
    await expect(clear).toBeEnabled();
    state.panels.calls.length = 0;
    await clear.click();
    await expect(select(page, "Família")).toHaveValue("");
    await expect(clear).toBeDisabled();
    await expect(filters(page)).toContainText("Sem filtros");
    // A grade já tinha os dados sem filtro em cache ou os pede sem parâmetro: nunca com o antigo.
    await expectPanelsLoaded(page, "USER");
    expect(dataCalls(state).every((p) => !p.has("familia"))).toBe(true);
  });

  test("os filtros não vão para a URL e a URL legada é ignorada (nenhum parâmetro antigo sai)", async ({ page }) => {
    const state = await open(page, `/dashboard?${DASHBOARD_FILTERED_QUERY}&lixo=1&unit_id=nao-e-uuid`);
    await expectPanelsLoaded(page, "USER");
    await select(page, "Família").selectOption("TI");
    await expect(page).toHaveURL(/\/dashboard\?/);
    expect(new URL(page.url()).searchParams.has("familia")).toBe(false);
    // Filtros legados da URL (located, bond_status, unit_id...) não chegam aos painéis.
    for (const params of dataCalls(state)) {
      for (const key of ["located", "bond_status", "tipo", "registrado_desde", "inventario", "lixo", "unit_id"]) {
        expect(params.has(key), key).toBe(false);
      }
    }
    expect(dataCalls(state).length).toBeGreaterThan(0);
    for (const endpoint of DASHBOARD_ENDPOINTS) expect(legacyCalls(state, endpoint)).toHaveLength(0);
    no400(state);
  });

  test("filtro que não casa com nada: estado vazio claro em cada painel e nenhum valor de exemplo", async ({ page }) => {
    await open(page, "/dashboard", {
      role: "RH",
      dashboardPanels: { dataStatus: Object.fromEntries(panelIdsFor("RH").map((id) => [id, "empty" as const])) },
    });
    await expectPanelsLoaded(page, "RH", { state: "empty" });
    await select(page, "Família").selectOption("OUTROS");
    await expect(page.locator("[data-equipment-empty]").first()).toContainText("Nenhum bem com estes filtros");
    await expect(page.locator("figure")).toHaveCount(0);
  });
});

test.describe("relatório", () => {
  test("Imprimir relatório abre o relatório; ele lista os filtros herdados da URL e os aplica", async ({ page }) => {
    const state = await open(page, "/dashboard");
    await expectPanelsLoaded(page, "USER");
    // O dashboard não tem mais filtros legados para repassar: o link é fixo.
    const link = page.getByRole("link", { name: "Imprimir relatório" });
    await expect(link).toHaveAttribute("href", "/dashboard/relatorio");
    await link.click();
    await expect(page).toHaveURL(/\/dashboard\/relatorio$/);
    await expect(page.getByRole("heading", { level: 1, name: "Relatório patrimonial" })).toBeVisible();

    // O relatório ainda herda filtros legados da URL (parse defensivo) e os lista.
    state.calls.length = 0;
    await page.goto(`/dashboard/relatorio?${DASHBOARD_FILTERED_QUERY}`);
    await waitForHydration(page);
    const list = page.locator("[data-report-filters]");
    await expect(list.getByRole("heading", { name: "Filtros aplicados" })).toBeVisible();
    for (const text of [
      `Unidade de uso: ${UNIT_1_LABEL}`,
      "Localizado: Não",
      "Vínculo: Ocioso",
      "Registrado desde: 01/01/2026",
      "Inventário: Não conferido",
    ]) {
      await expect(list.getByText(text, { exact: true })).toBeVisible();
    }
    await expectDashboardLoaded(page);
    await expectAllEndpointsCalledWith(state, { located: "NAO", bond_status: "Ocioso", inventario: "nao_conferido" });
    // O relatório não oferece controles de filtro e volta ao dashboard.
    await expect(page.locator("[data-equipment-filters]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Voltar ao dashboard" })).toHaveAttribute(
      "href",
      `/dashboard?${DASHBOARD_FILTERED_QUERY}`,
    );
  });

  test("relatório sem filtros diz que não há filtro", async ({ page }) => {
    await open(page, "/dashboard/relatorio");
    await expect(page.locator("[data-report-filters]")).toContainText("Nenhum — todos os bens visíveis para o perfil.");
  });
});

test.describe("blocos do relatório (painéis patrimoniais)", () => {
  test("erro em um bloco não derruba os outros; nova tentativa recupera", async ({ page }) => {
    const state = await open(page, "/dashboard/relatorio", {
      role: "USER",
      dashboardStatus: { "por-vinculo": 500, inventario: 500 },
    });
    const failed = block(page, "por-vinculo");
    await expect(failed.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 20_000 });
    await expect(block(page, "inventario").locator("[data-dashboard-error]")).toBeVisible();
    await expect(failed).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(block(page, "por-sala").locator("figure")).toBeVisible({ timeout: 20_000 });
    await expect(block(page, "localizacao-por-unidade").locator("figure")).toBeVisible();
    await expect(block(page, "pendencias-cadastro").locator("[data-stat-card]")).toHaveCount(4);

    state.dashboardStatus = {};
    await failed.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(failed.locator("figure")).toBeVisible({ timeout: 20_000 });
  });

  test("rótulos da planilha (vínculo, sala, unidade) são texto puro: XSS não executa", async ({ page }) => {
    const base = defaultDashboard();
    const dashboard = {
      "por-vinculo": [{ id: "x", label: `Vínculo ${XSS_IMG}`, value: 10 }, ...base["por-vinculo"]],
      "por-sala": [{ id: "80000000-0000-4000-8000-0000000000ee", label: `Sala ${XSS_IMG}`, value: 9 }, ...base["por-sala"]],
      "localizacao-por-unidade": [
        { unidade: `Unid ${XSS_IMG}`, sim: 1, nao: 1, desconhecido: 0, total: 2 },
        ...base["localizacao-por-unidade"],
      ],
    };
    await open(page, "/dashboard/relatorio", { role: "USER", dashboard });
    await expectDashboardLoaded(page);
    await expect(block(page, "por-vinculo").getByRole("list", { name: /Legenda/ })).toContainText(`Vínculo ${XSS_IMG}`);
    await expect(block(page, "por-sala").getByRole("table")).toContainText(`Sala ${XSS_IMG}`);
    await expect(block(page, "localizacao-por-unidade").getByRole("table")).toContainText(`Unid ${XSS_IMG}`);
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("números exatos do backend", async ({ page }) => {
    await open(page, "/dashboard/relatorio");
    await expectDashboardLoaded(page);
    const loc = block(page, "localizacao-por-unidade");
    await expect(loc.getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(loc.getByRole("table").getByRole("row", { name: /Sede Sintética Palmas.*50.*620.*30/ })).toHaveCount(1);
    await expect(block(page, "por-vinculo").getByRole("list", { name: /Legenda/ })).toContainText("Sem vínculo");
    await expect(block(page, "por-sala").getByRole("table")).toContainText("Recepção Sintética");
    const pend = block(page, "pendencias-cadastro");
    await expect(pend.locator("[data-stat-card=sem-responsavel]")).toContainText("140");
    await expect(pend.locator("[data-stat-card=ociosos]")).toContainText("200");
    const inv = block(page, "inventario");
    await expect(inv.locator("[data-stat-card=conferidos]")).toContainText("900");
    await expect(inv.locator("[data-stat-card=nao-encontrados]")).toContainText("30");
  });
});

test.describe("teclado e acessibilidade", () => {
  test("filtros: ordem de Tab (Família, Unidade, Categoria, Limpar) e rótulos associados", async ({ page }) => {
    await open(page);
    await expectPanelsLoaded(page, "USER");
    await expect(filters(page)).toHaveAccessibleName("Filtros dos painéis de equipamentos");
    await select(page, "Família").focus();
    const order: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLSelectElement | HTMLButtonElement | null;
          return el?.labels?.[0]?.textContent ?? el?.textContent ?? "";
        }),
      );
      await page.keyboard.press("Tab");
    }
    expect(order).toEqual(["Família", "Unidade", "Categoria"]);
    // Seleção por teclado aplica o filtro.
    await select(page, "Família").focus();
    await page.keyboard.press("ArrowDown");
    await expect(select(page, "Família")).not.toHaveValue("");
    // Foco visível chegando por teclado (Shift+Tab e Tab de volta ao campo).
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(select(page, "Família")).toBeFocused();
    // O seletor compartilhado indica o foco pela borda (focus-visible:border-bone = #eeeeee).
    await expect(select(page, "Família")).toHaveCSS("border-color", "rgb(238, 238, 238)");
  });

  test("axe com filtro aplicado (WCAG 2.2 AA)", async ({ page }) => {
    await open(page);
    await expectPanelsLoaded(page, "USER");
    await select(page, "Família").selectOption("TI");
    await expect(page.locator("[data-equipment-panel][aria-busy=true]")).toHaveCount(0, { timeout: 20_000 });
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  for (const width of [320, 768]) {
    test(`${width}px: filtros sem rolagem horizontal, alvos >= 24px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await expectPanelsLoaded(page, "USER");
      await select(page, "Família").selectOption("TI");
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
      const controls = await filters(page).locator("select:visible, input:visible, button:visible").all();
      expect(controls.length).toBeGreaterThanOrEqual(4);
      for (const control of controls) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(24);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    });
  }
});
