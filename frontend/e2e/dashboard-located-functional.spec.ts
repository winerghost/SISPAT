import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CGU_UNIT_ID,
  PFN_UNIT_ID,
  LOCATED_CHART,
  mockEquipment,
  type EquipmentState,
  type Role,
} from "./dashboard-equipment-support";
import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Painel `located_by_unit_chart` (Onda B): barras agrupadas por unidade com 3
// séries, clique/teclado que abre os bens da unidade + situação (painel lateral
// Radix), paginação, "Outras", estados vazio/erro/404, perfis, 320/768/1920,
// axe, XSS em rótulos e descrições, sem dado pessoal e sem storage.
// Contrato MOCKADO (dashboard-equipment-support.ts, espelha dashboard-api.md).
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function open(page: Page, role: Role = "USER", init: Parameters<typeof mockEquipment>[2] = {}): Promise<EquipmentState> {
  await installMocks(page, { role });
  const state = await mockEquipment(page, role, init);
  await seedSession(page, { role });
  await page.goto("/dashboard");
  await waitForHydration(page);
  await expect(panel(page).locator("figure")).toBeVisible({ timeout: 20_000 });
  await expect(panel(page)).toHaveAttribute("data-panel-size", "G");
  return state;
}

const panel = (page: Page) => page.locator("[data-equipment-panel=located_by_unit_chart]");
const cell = (page: Page, unit: string, located: string) =>
  panel(page).locator(`[data-located-cell="${unit}:${located}"]:visible`);
const sheet = (page: Page, name?: string | RegExp) => page.getByRole("dialog", name ? { name } : undefined);
const recordCalls = (state: EquipmentState) => state.located.calls;
const lastCall = (state: EquipmentState) => new URLSearchParams(state.located.calls.at(-1) ?? "");

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main");
    return { page: doc.scrollWidth - doc.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.main).toBeLessThanOrEqual(1);
}

test.describe("renderização", () => {
  test("barras agrupadas com 3 séries, legenda com textura e tabela com os números do backend", async ({ page }) => {
    await open(page);
    const p = panel(page);
    await expect(p.locator('[role="img"]').first()).toHaveAccessibleName(/Localização dos bens por unidade/);
    await expect(p.locator('[role="img"]').first()).toHaveAccessibleName(/Não localizados/);
    // Legenda: 3 séries, cada uma com textura própria (não só cor).
    const legend = p.getByRole("list", { name: /Legenda/ });
    await expect(legend.locator("li")).toHaveCount(3);
    await expect(legend).toContainText("Localizados");
    await expect(legend).toContainText("Não localizados");
    await expect(legend).toContainText("Não informado");
    await expect(legend.locator("[data-legend-pattern=solid]")).toHaveCount(1);
    await expect(legend.locator("[data-legend-pattern=lines]")).toHaveCount(1);
    await expect(legend.locator("[data-legend-pattern=dots]")).toHaveCount(1);
    // Barras texturizadas (padrões SVG) além da cor.
    await expect.poll(() => p.locator("[data-chart-surface] svg pattern").count()).toBeGreaterThanOrEqual(2);
    // Tabela de dados (os números exatos).
    const matrix = p.locator("[data-located-matrix] table");
    await expect(matrix).toContainText("PFN-TO");
    await expect(matrix.getByRole("row", { name: /PFN-TO/ })).toContainText("135");
    await expect(matrix.getByRole("row", { name: /Outras/ })).toContainText("6");
    await expect(p).toContainText("Total exibido: 148");
    expect(LOCATED_CHART.total).toBe(148);
  });

  test("respeita o filtro do painel (família vai na consulta de dados)", async ({ page }) => {
    const state = await open(page);
    await page.locator("[data-equipment-filters]").getByLabel("Família").selectOption("TI");
    await expect
      .poll(() => state.calls.some((c) => c.url.includes("located_by_unit_chart/data") && c.url.includes("familia=TI")))
      .toBe(true);
  });

  test("painel vazio: estado claro, sem gráfico de exemplo", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await mockEquipment(page, "USER", { dataStatus: { located_by_unit_chart: "empty" } });
    await seedSession(page, { role: "USER" });
    await page.goto("/dashboard");
    await waitForHydration(page);
    await expect(panel(page).locator("[data-equipment-empty]")).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator("figure")).toHaveCount(0);
  });

  test("painel com erro: mensagem fixa e Tentar novamente; 404 oculta o painel", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    const state = await mockEquipment(page, "USER", { dataStatus: { located_by_unit_chart: 500 } });
    await seedSession(page, { role: "USER" });
    await page.goto("/dashboard");
    await waitForHydration(page);
    const p = panel(page);
    await expect(p.locator("[data-equipment-error]")).toBeVisible({ timeout: 20_000 });
    await expect(p).not.toContainText("SISPAT_BACKEND_MSG");
    delete state.dataStatus.located_by_unit_chart;
    await p.getByRole("button", { name: /Tentar novamente/ }).click();
    await expect(p.locator("figure")).toBeVisible({ timeout: 20_000 });
    state.dataStatus.located_by_unit_chart = 404;
    await page.reload();
    await waitForHydration(page);
    await expect(page.locator("[data-equipment-panel=kpi_workstations]")).toBeVisible({ timeout: 20_000 });
    await expect(panel(page)).toHaveCount(0);
  });
});

test.describe("abrir os registros", () => {
  test("botão da tabela abre a lista da unidade + situação, com colunas e sem dado pessoal", async ({ page }) => {
    const state = await open(page);
    await cell(page, PFN_UNIT_ID, "NAO").click();
    const d = sheet(page, "Não localizados — PFN-TO");
    await expect(d).toBeVisible();
    await expect(d.locator("[data-located-table] [data-located-row]")).toHaveCount(12, { timeout: 20_000 });
    const params = lastCall(state);
    expect(params.get("unit_id")).toBe(PFN_UNIT_ID);
    expect(params.get("located")).toBe("NAO");
    expect(params.get("page")).toBe("1");
    expect(params.get("page_size")).toBe("50");
    for (const heading of ["Patrimônio", "Descrição", "Unidade", "Sala", "Situação", "Categoria"]) {
      await expect(d.locator("[data-located-table]").getByRole("columnheader", { name: heading })).toBeVisible();
    }
    // Nenhum dado pessoal é pedido ou exibido.
    await expect(d).not.toContainText(/Responsável|E-mail|CPF|Telefone/i);
    await expect(d.locator("[data-located-table]")).toContainText("Não localizados");
    await expect(d.locator("[data-located-table]")).toContainText("Monitor");
  });

  test("teclado: Enter e Espaço abrem; foco preso; Esc fecha e devolve o foco ao botão", async ({ page }) => {
    await open(page);
    const trigger = cell(page, PFN_UNIT_ID, "DESCONHECIDO");
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    const d = sheet(page, "Não informado — PFN-TO");
    await expect(d).toBeVisible();
    await expect(d.locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.keyboard.press("Space");
    await expect(sheet(page, "Não informado — PFN-TO")).toBeVisible();
    await page.getByRole("button", { name: "Fechar painel" }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("clique na barra abre a mesma lista e devolve o foco ao botão equivalente", async ({ page }) => {
    const state = await open(page);
    const bar = panel(page).locator("[data-chart-surface] svg g rect").first();
    await bar.scrollIntoViewIfNeeded();
    const box = (await bar.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const d = sheet(page, "Localizados — PFN-TO");
    await expect(d).toBeVisible();
    await expect.poll(() => lastCall(state).get("located")).toBe("SIM");
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
    await expect(cell(page, PFN_UNIT_ID, "SIM")).toBeFocused();
  });

  test("botão Total lista todas as situações; o seletor Situação filtra", async ({ page }) => {
    const state = await open(page);
    await cell(page, PFN_UNIT_ID, "ALL").click();
    const d = sheet(page, "Todas as situações — PFN-TO");
    await expect(d).toBeVisible();
    await expect(d.locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    expect(lastCall(state).has("located")).toBe(false);
    await d.getByLabel("Situação").selectOption("NAO");
    await expect(sheet(page, "Não localizados — PFN-TO")).toBeVisible();
    await expect.poll(() => lastCall(state).get("located")).toBe("NAO");
    await expect(sheet(page).locator("[data-located-table] [data-located-row]")).toHaveCount(12);
  });

  test("zero não vira botão (nada a listar)", async ({ page }) => {
    await open(page);
    await expect(cell(page, CGU_UNIT_ID, "NAO")).toHaveCount(0);
    await expect(cell(page, CGU_UNIT_ID, "SIM")).toHaveCount(1);
  });
});

test.describe("paginação e ordenação", () => {
  test("50/100/200, próxima página e ordenação vão ao servidor", async ({ page }) => {
    const state = await open(page);
    await cell(page, PFN_UNIT_ID, "SIM").click();
    const d = sheet(page, "Localizados — PFN-TO");
    await expect(d.locator("[data-located-table] [data-located-row]")).toHaveCount(50, { timeout: 20_000 });
    await expect(d).toContainText("Exibindo 1–50 de 120 bem(ns)");

    await d.getByRole("button", { name: "Próxima" }).click();
    await expect.poll(() => lastCall(state).get("page")).toBe("2");
    await expect(d.locator("[data-located-table] [data-located-row]")).toHaveCount(50);
    await expect(d).toContainText("Exibindo 51–100 de 120 bem(ns)");

    await d.getByLabel("Registros por página").selectOption("100");
    await expect.poll(() => lastCall(state).get("page_size")).toBe("100");
    expect(lastCall(state).get("page")).toBe("1");
    await expect(d.locator("[data-located-table] [data-located-row]")).toHaveCount(100);

    await d.getByLabel("Ordenar por").selectOption("-patrimony_number");
    await expect.poll(() => lastCall(state).get("sort")).toBe("-patrimony_number");
    expect(lastCall(state).get("page")).toBe("1");
    await expect(d.locator("[data-located-table] [data-located-row]").first()).toContainText("100120");
  });
});

test.describe("Outras", () => {
  test("unit_id=outras com familia/categoria do painel e SEM o filtro de unidade do painel", async ({ page }) => {
    const state = await open(page);
    const filters = page.locator("[data-equipment-filters]");
    await filters.getByLabel("Família").selectOption("TI");
    await filters.getByLabel("Categoria").selectOption("NOTEBOOK");
    await filters.getByLabel("Unidade").selectOption({ index: 1 });
    await expect(panel(page).locator("figure")).toBeVisible({ timeout: 20_000 });
    await cell(page, "outras", "NAO").click();
    const d = sheet(page, "Não localizados — Outras");
    await expect(d).toBeVisible();
    await expect(d.locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    const params = lastCall(state);
    expect(params.getAll("unit_id")).toEqual(["outras"]);
    expect(params.get("familia")).toBe("TI");
    expect(params.get("categoria")).toBe("NOTEBOOK");
    expect(params.get("located")).toBe("NAO");
    await expect(d.locator("[data-located-table] [data-located-row]")).toHaveCount(2);
    await expect(d).toContainText("Unidade extra");
  });
});

test.describe("estados da lista", () => {
  test("skeleton, vazio claro", async ({ page }) => {
    await open(page, "USER", { delayData: 0, located: { status: null, empty: true, calls: [] } });
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page).locator("[data-located-empty]")).toContainText("Nenhum bem nesta seleção", { timeout: 20_000 });
    await expect(sheet(page).locator("[data-located-row]")).toHaveCount(0);
  });

  test("erro com mensagem fixa e 'Tentar novamente' recupera", async ({ page }) => {
    const state = await open(page, "USER", { located: { status: 500, empty: false, calls: [] } });
    await cell(page, PFN_UNIT_ID, "NAO").click();
    const d = sheet(page);
    await expect(d.locator("[data-located-error]")).toContainText("Não foi possível carregar os bens", { timeout: 20_000 });
    await expect(d).not.toContainText("SISPAT_BACKEND_MSG");
    state.located.status = null;
    await d.getByRole("button", { name: /Tentar novamente/ }).click();
    await expect(d.locator("[data-located-table] [data-located-row]")).toHaveCount(12, { timeout: 20_000 });
  });

  test("404: mensagem neutra, sem tentar de novo", async ({ page }) => {
    const state = await open(page, "USER", { located: { status: 404, empty: false, calls: [] } });
    await cell(page, PFN_UNIT_ID, "NAO").click();
    const d = sheet(page);
    await expect(d.locator("[data-located-error]")).toContainText("não está disponível para o seu perfil", { timeout: 20_000 });
    await expect(d.getByRole("button", { name: /Tentar novamente/ })).toHaveCount(0);
    expect(recordCalls(state)).toHaveLength(1);
  });

  test("skeleton durante o carregamento", async ({ page }) => {
    await open(page, "USER", { delayData: 1200 });
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page).getByRole("status", { name: /Carregando bens/ }).or(sheet(page).getByText("Carregando bens"))).toBeAttached();
    await expect(sheet(page).locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
  });
});

test.describe("perfis", () => {
  for (const role of ["ADM", "USER", "RH"] as const) {
    test(`${role}: painel presente e lista abre`, async ({ page }) => {
      await open(page, role);
      await cell(page, PFN_UNIT_ID, "NAO").click();
      await expect(sheet(page, "Não localizados — PFN-TO").locator("[data-located-table] [data-located-row]")).toHaveCount(12, {
        timeout: 20_000,
      });
    });
  }
});

test.describe("segurança de apresentação", () => {
  test("XSS em rótulo de unidade e descrição aparece como texto e não executa", async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const dados = {
      ...LOCATED_CHART,
      unidades: LOCATED_CHART.unidades.map((u, i) => (i === 0 ? { ...u, unidade: evil } : u)),
    };
    await open(page, "USER", {
      payloadOverride: { located_by_unit_chart: { tipo: "grafico", dados } },
      located: { status: null, empty: false, description: evil, calls: [] },
    });
    await expect(panel(page).locator("[data-located-matrix]").first()).toContainText("<img src=x");
    await panel(page).locator(`[data-located-cell="${PFN_UNIT_ID}:NAO"]:visible`).click();
    const d = sheet(page);
    await expect(d).toContainText("<img src=x", { timeout: 20_000 });
    await expect(d.locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    expect(await d.locator("img, script").count()).toBe(0);
    expect(await panel(page).locator("img, script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("nada em localStorage nem sessionStorage com dados dos bens", async ({ page }) => {
    await open(page);
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page).locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    await sheet(page).getByLabel("Registros por página").selectOption("100");
    const dump = await page.evaluate(() =>
      JSON.stringify({ l: { ...window.localStorage }, s: { ...window.sessionStorage } }),
    );
    expect(dump).not.toMatch(/Bem sintético|PFN-TO/i);
  });
});

test.describe("acessibilidade e responsividade", () => {
  test("axe sem violações: painel e lista aberta (1366)", async ({ page }) => {
    await open(page);
    await waitForAnimations(page);
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).include("[data-equipment-panel=located_by_unit_chart]").analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page).locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    await waitForAnimations(page);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  for (const width of [320, 768, 1920]) {
    test(`${width}px: sem rolagem horizontal; lista em ${width < 1024 ? "cartões" : "tabela"}; axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await waitForAnimations(page);
      await noHorizontalScroll(page);
      const trigger: Locator = cell(page, PFN_UNIT_ID, "NAO");
      await trigger.scrollIntoViewIfNeeded();
      const b = (await trigger.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(24);
      expect(b.height).toBeGreaterThanOrEqual(24);
      await trigger.click();
      const d = sheet(page, "Não localizados — PFN-TO");
      await expect(d).toBeVisible();
      await expect(d.locator("[data-located-row]:visible").first()).toBeVisible({ timeout: 20_000 });
      if (width < 1024) {
        await expect(d.locator("[data-located-cards]")).toBeVisible();
        await expect(d.locator("[data-located-table]")).toBeHidden();
      } else {
        await expect(d.locator("[data-located-table]")).toBeVisible();
        await expect(d.locator("[data-located-cards]")).toBeHidden();
      }
      await waitForAnimations(page);
      await noHorizontalScroll(page);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

  test("prefers-reduced-motion: abre e fecha sem deslocamento", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page, "Não localizados — PFN-TO")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
  });
});
