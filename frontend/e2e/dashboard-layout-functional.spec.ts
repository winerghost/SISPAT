import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  DASHBOARD_PANEL_IDS,
  defaultDashboardLayout,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";
import {
  DASHBOARD_CUSTOM_HIDDEN_BLOCKS,
  DASHBOARD_CUSTOM_LAYOUT,
  expectDashboardLoaded,
  waitForAnimations,
} from "./support/screens";

// =============================================================================
// "Personalizar painéis" (preferência `dashboard_layout`). Contrato MOCKADO:
//   GET  /api/v1/me/preferences -> dashboard_layout: {order: [15 ids], hidden: [ids]}
//   PATCH {version, dashboard_layout: {order?, hidden?}} | {dashboard_layout: null}
//   400 se esconder todos; 409 em conflito de versão.
// Cobre: padrão, mover/ocultar por teclado (foco + anúncio), PATCH, estado
// honesto (nada muda antes da confirmação), persistência, relatório com a
// mesma ordem, restaurar, todos ocultos, 400, 409, backend anterior (sem a
// chave), resposta inválida, painel oculto não consulta, axe e 320px.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PREFS_URL = (url: string) => url.endsWith("/v1/me/preferences");
const BLOCK_OF: Record<string, string> = {
  kpis: "indicadores",
  units: "por-unidade",
  status: "por-situacao",
  monthly: "aquisicoes-mensais",
  location: "localizacao-por-unidade",
  bond: "por-vinculo",
  pending: "pendencias-cadastro",
  rooms: "por-sala",
  inventory: "inventario",
  tech_summary: "tecnologia-indicadores",
  tech_category: "tecnologia-categoria",
  tech_units: "tecnologia-por-unidade",
  tech_status: "tecnologia-situacao",
  tech_no_owner: "tecnologia-sem-responsavel",
  tech_age: "tecnologia-tempo-registro",
};

async function open(page: Page, opts: MockOptions = { role: "USER" }, path = "/dashboard"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const trigger = (page: Page) => page.getByRole("button", { name: "Personalizar painéis" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Personalizar painéis" });
const patches = (state: MockState) => state.calls.filter((c) => c.method === "PATCH" && PREFS_URL(c.url));

/** Ordem dos blocos na grade (DOM), sem o detalhamento fixo. */
async function gridOrder(page: Page): Promise<string[]> {
  return page
    .locator("[data-dashboard-panels] > [data-dashboard-block]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-dashboard-block") ?? "").filter((id) => id !== "detalhamento"));
}

async function dialogOrder(d: Locator): Promise<string[]> {
  return d.locator("[data-layout-item]").evaluateAll((els) => els.map((el) => el.getAttribute("data-layout-item") ?? ""));
}

function dashboardCalls(state: MockState, endpoint: string): number {
  return state.calls.filter(
    (c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `/api/v1/dashboard/${endpoint}`,
  ).length;
}

test.describe("padrão", () => {
  test("15 painéis na ordem padrão; diálogo lista todos; restaurar e salvar desabilitados", async ({ page }) => {
    await open(page);
    await expectDashboardLoaded(page);
    expect(await gridOrder(page)).toEqual(DASHBOARD_PANEL_IDS.map((id) => BLOCK_OF[id]));
    await expect(page.locator("[data-dashboard-block=detalhamento]")).toHaveCount(1);

    await trigger(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    expect(await dialogOrder(d)).toEqual([...DASHBOARD_PANEL_IDS]);
    await expect(d.getByRole("checkbox")).toHaveCount(DASHBOARD_PANEL_IDS.length);
    for (const box of await d.getByRole("checkbox").all()) await expect(box).toBeChecked();
    await expect(d.getByRole("button", { name: "Restaurar padrão" })).toBeDisabled();
    await expect(d.getByRole("button", { name: "Salvar" })).toBeDisabled();
    // Bordas: o primeiro não sobe e o último não desce.
    await expect(d.getByRole("button", { name: "Mover Indicadores para cima" })).toBeDisabled();
    await expect(d.getByRole("button", { name: "Mover Tecnologia: tempo desde o registro para baixo" })).toBeDisabled();
    await expect(d.getByRole("button", { name: "Mover Inventário para baixo" })).toBeEnabled();
  });
});

test.describe("personalizar", () => {
  test("teclado: move (foco acompanha + anúncio), oculta, salva só após confirmar e persiste", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    const d = dialog(page);
    await expect(d).toBeVisible();

    const up = d.getByRole("button", { name: "Mover Bens por vínculo para cima" });
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(up).toBeFocused();
    await expect(d.locator("[data-layout-announcement]")).toHaveText(
      "Bens por vínculo movido para a posição 5 de 15.",
    );
    await page.keyboard.press("Enter");
    await expect(d.locator("[data-layout-announcement]")).toHaveText(/posição 4 de 15/);
    // "Inventário" oculto pelo teclado (Espaço no checkbox).
    const inventory = d.getByRole("checkbox", { name: /Inventário/ });
    await inventory.focus();
    await page.keyboard.press(" ");
    await expect(inventory).not.toBeChecked();

    // Estado honesto: com o PATCH pendente, a grade continua a confirmada.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/v1/me/preferences", async (route) => {
      if (route.request().method() === "PATCH") await gate;
      await route.fallback();
    });
    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await d.getByRole("button", { name: "Salvar" }).click();
    const expectedOrder = [
      "kpis", "units", "status", "bond", "monthly", "location", "pending", "rooms", "inventory",
      "tech_summary", "tech_category", "tech_units", "tech_status", "tech_no_owner", "tech_age",
    ];
    expect((await request).postDataJSON()).toEqual({
      version: 0,
      dashboard_layout: { order: expectedOrder, hidden: ["inventory"] },
    });
    await expect(d.getByRole("button", { name: "Salvar" })).toHaveAttribute("aria-busy", "true");
    expect(await gridOrder(page)).toEqual(DASHBOARD_PANEL_IDS.map((id) => BLOCK_OF[id]));
    release();

    await expect(d).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(page.locator("[data-dashboard-layout-saved]")).toHaveText("Painéis do dashboard atualizados.");
    await expect.poll(() => gridOrder(page)).toEqual(expectedOrder.filter((id) => id !== "inventory").map((id) => BLOCK_OF[id]));
    await expect(page.locator("[data-dashboard-block=inventario]")).toHaveCount(0);
    expect(state.prefs.dashboard_layout).toEqual({ order: expectedOrder, hidden: ["inventory"] });
    expect(patches(state)).toHaveLength(1);

    await page.reload();
    await waitForHydration(page);
    await expectDashboardLoaded(page, { hidden: ["inventario"] });
    expect(await gridOrder(page)).toEqual(expectedOrder.filter((id) => id !== "inventory").map((id) => BLOCK_OF[id]));
  });

  test("relatório imprimível usa a mesma ordem e oculta os mesmos painéis", async ({ page }) => {
    await open(page, { role: "USER", prefs: { dashboard_layout: DASHBOARD_CUSTOM_LAYOUT } }, "/dashboard/relatorio");
    await expectDashboardLoaded(page, { hidden: DASHBOARD_CUSTOM_HIDDEN_BLOCKS });
    const expected = DASHBOARD_CUSTOM_LAYOUT.order
      .filter((id) => !DASHBOARD_CUSTOM_LAYOUT.hidden.includes(id))
      .map((id) => BLOCK_OF[id]);
    expect(await gridOrder(page)).toEqual(expected);
    // Relatório não oferece personalização.
    await expect(trigger(page)).toHaveCount(0);
  });

  test("painel oculto não é montado e não consulta o backend", async ({ page }) => {
    const state = await open(page, { role: "USER", prefs: { dashboard_layout: DASHBOARD_CUSTOM_LAYOUT } });
    await expectDashboardLoaded(page, { hidden: DASHBOARD_CUSTOM_HIDDEN_BLOCKS });
    expect(dashboardCalls(state, "aquisicoes-mensais")).toBe(0);
    expect(dashboardCalls(state, "inventario")).toBe(0);
    expect(dashboardCalls(state, "por-vinculo")).toBeGreaterThan(0);
  });

  test("grade sem buracos: painel de meia largura sozinho ocupa a linha inteira", async ({ page }) => {
    await open(page, {
      role: "USER",
      prefs: {
        dashboard_layout: {
          order: ["status", "kpis", "bond", "rooms", "units", "monthly", "location", "pending", "inventory"],
          hidden: [],
        },
      },
    });
    await expectDashboardLoaded(page);
    const width = async (id: string) => (await page.locator(`[data-dashboard-block=${id}]`).boundingBox())!.width;
    const kpis = await width("indicadores");
    // "status" fica sozinho antes dos KPIs (largos) => mesma largura dos KPIs.
    expect(Math.abs((await width("por-situacao")) - kpis)).toBeLessThan(2);
    // "bond" + "rooms" dividem a linha.
    expect(await width("por-vinculo")).toBeLessThan(kpis * 0.6);
    expect(await width("por-sala")).toBeLessThan(kpis * 0.6);
  });

  test("restaurar padrão envia null e volta à grade padrão", async ({ page }) => {
    const state = await open(page, { role: "USER", prefs: { dashboard_layout: DASHBOARD_CUSTOM_LAYOUT } });
    await expectDashboardLoaded(page, { hidden: DASHBOARD_CUSTOM_HIDDEN_BLOCKS });
    await trigger(page).click();
    const d = dialog(page);
    expect(await dialogOrder(d)).toEqual(DASHBOARD_CUSTOM_LAYOUT.order);
    await expect(d.getByRole("checkbox", { name: /Aquisições mensais/ })).not.toBeChecked();
    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await d.getByRole("button", { name: "Restaurar padrão" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 0, dashboard_layout: null });
    await expect(d).toHaveCount(0);
    await expectDashboardLoaded(page);
    expect(await gridOrder(page)).toEqual(DASHBOARD_PANEL_IDS.map((id) => BLOCK_OF[id]));
    expect(state.prefs.dashboard_layout).toEqual(defaultDashboardLayout());
  });

  test("cancelar descarta o rascunho sem PATCH", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await trigger(page).click();
    const d = dialog(page);
    await d.getByRole("button", { name: "Mover Inventário para cima" }).click();
    await d.getByRole("button", { name: "Cancelar" }).click();
    await expect(d).toHaveCount(0);
    expect(patches(state)).toHaveLength(0);
    await trigger(page).click();
    expect(await dialogOrder(dialog(page))).toEqual([...DASHBOARD_PANEL_IDS]);
  });
});

test.describe("erros e contrato", () => {
  test("todos ocultos: aviso e salvar desabilitado (nenhum PATCH)", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await trigger(page).click();
    const d = dialog(page);
    for (const box of await d.getByRole("checkbox").all()) await box.uncheck();
    await expect(d.getByRole("alert")).toHaveText(/Mantenha pelo menos um painel visível/);
    await expect(d.getByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(patches(state)).toHaveLength(0);
  });

  test("400 do backend: mensagem fixa (sem texto do servidor) e a grade não muda", async ({ page }) => {
    await open(page);
    await expectDashboardLoaded(page);
    await page.route("**/v1/me/preferences", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "validation_error", message: "SISPAT_BACKEND_MSG" } }),
      });
    });
    await trigger(page).click();
    const d = dialog(page);
    await d.getByRole("checkbox", { name: /Bens por sala/ }).uncheck();
    await d.getByRole("button", { name: "Salvar" }).click();
    await expect(d.getByRole("alert")).toHaveText(/Não foi possível salvar os painéis/);
    await expect(page.locator("body")).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(page.locator("[data-dashboard-block=por-sala]")).toHaveCount(1);
  });

  test("409: avisa, recarrega a versão nova (rascunho = servidor) e salva de novo", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await trigger(page).click();
    const d = dialog(page);
    await d.getByRole("checkbox", { name: /Bens por sala/ }).uncheck();
    // Outra sessão salvou antes: versão 4, "Pendências" oculto.
    state.prefs = { ...state.prefs, version: 4, dashboard_layout: { order: [...DASHBOARD_PANEL_IDS], hidden: ["pending"] } };
    await d.getByRole("button", { name: "Salvar" }).click();
    await expect(d.getByRole("alert")).toContainText(/alteradas em outra sessão/);
    await expect(d.getByRole("checkbox", { name: /Pendências de cadastro/ })).not.toBeChecked();
    await expect(d.getByRole("checkbox", { name: /Bens por sala/ })).toBeChecked();
    // A grade reflete o servidor (pendências oculto), não o pedido.
    await expect(page.locator("[data-dashboard-block=pendencias-cadastro]")).toHaveCount(0);
    await expect(page.locator("[data-dashboard-block=por-sala]")).toHaveCount(1);

    await d.getByRole("checkbox", { name: /Bens por sala/ }).uncheck();
    const request = page.waitForRequest((r) => PREFS_URL(r.url()) && r.method() === "PATCH");
    await d.getByRole("button", { name: "Salvar" }).click();
    expect((await request).postDataJSON()).toMatchObject({ version: 4, dashboard_layout: { hidden: ["pending", "rooms"] } });
    await expect(d).toHaveCount(0);
    await expect(page.locator("[data-dashboard-block=por-sala]")).toHaveCount(0);
  });

  test("backend anterior (sem dashboard_layout nem chaves novas): padrões, sem erro, controles funcionam", async ({ page }) => {
    const state = await open(page, { role: "USER", prefsLegacy: true });
    await expectDashboardLoaded(page);
    expect(await gridOrder(page)).toEqual(DASHBOARD_PANEL_IDS.map((id) => BLOCK_OF[id]));
    // Novos painéis no tipo padrão e com seletor.
    await expect(page.locator("[data-dashboard-block=localizacao-por-unidade] figure")).toHaveAttribute("data-chart-kind", "stacked");
    await expect(page.locator("[data-dashboard-block=por-vinculo] figure")).toHaveAttribute("data-chart-kind", "donut");
    await expect(page.locator("[data-dashboard-block=por-sala] figure")).toHaveAttribute("data-chart-kind", "horizontal");
    for (const id of ["localizacao-por-unidade", "por-vinculo", "por-sala"]) {
      await expect(page.locator(`[data-dashboard-block=${id}]`).getByRole("button", { name: /^Tipo de gráfico/ })).toBeVisible();
    }
    await expect(trigger(page)).toBeVisible();
    await expect(page.locator("[data-dashboard-error]")).toHaveCount(0);
    expect(state.prefsLegacy).toBe(true);
  });

  const invalidLayouts: { name: string; layout: unknown }[] = [
    { name: "id desconhecido", layout: { order: [...DASHBOARD_PANEL_IDS.slice(0, 8), "<img src=x>"], hidden: [] } },
    { name: "ordem incompleta", layout: { order: ["kpis", "units"], hidden: [] } },
    { name: "id repetido", layout: { order: [...DASHBOARD_PANEL_IDS.slice(0, 8), "kpis"], hidden: [] } },
    { name: "todos ocultos", layout: { order: [...DASHBOARD_PANEL_IDS], hidden: [...DASHBOARD_PANEL_IDS] } },
    { name: "não é objeto", layout: "kpis,units" },
  ];
  for (const { name, layout } of invalidLayouts) {
    test(`layout inválido na resposta (${name}): padrões, sem controles, sem quebrar`, async ({ page }) => {
      await open(page, {
        role: "USER",
        prefs: { dashboard_layout: layout as never },
      });
      await expectDashboardLoaded(page);
      expect(await gridOrder(page)).toEqual(DASHBOARD_PANEL_IDS.map((id) => BLOCK_OF[id]));
      await expect(trigger(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Tipo de gráfico/ })).toHaveCount(0);
      expect(await page.locator("main img").count()).toBe(0);
    });
  }

  test("GET de preferências falha: layout padrão e sem botão de personalizar", async ({ page }) => {
    await open(page, { role: "USER", prefsGetStatus: 500 });
    await expectDashboardLoaded(page);
    await expect(trigger(page)).toHaveCount(0);
  });
});

test.describe("acessibilidade e responsividade", () => {
  test("axe com o diálogo aberto (WCAG 2.2 AA) e Esc devolve o foco", async ({ page }) => {
    await open(page);
    await expectDashboardLoaded(page);
    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole("checkbox", { name: /Inventário/ }).uncheck();
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  for (const width of [320, 768]) {
    test(`${width}px: diálogo cabe na tela, alvos >= 24px, sem rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await open(page);
      await expectDashboardLoaded(page);
      await trigger(page).click();
      const d = dialog(page);
      await expect(d).toBeVisible();
      await waitForAnimations(page);
      const box = (await d.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      for (const control of await d.locator("button:visible, input").all()) {
        const b = (await control.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(16);
        if ((await control.getAttribute("type")) !== "checkbox") expect(b.height).toBeGreaterThanOrEqual(24);
      }
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  }
});
