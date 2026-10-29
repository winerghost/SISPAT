import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { mockEquipment, type EquipmentState, type Role } from "./dashboard-equipment-support";
import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Painéis do catálogo (equipamentos/mobiliário) e fila de revisão de
// classificação (ONDA 3). Contrato MOCKADO (ver dashboard-equipment-support.ts).
// Cobre: renderização por `tipo` com os números do backend, perfis (a tela
// desenha só o que o catálogo devolve), 404 oculta o painel, estados
// skeleton/vazio/erro+retry, filtros -> query, exportação só com exportable,
// aviso de estimativa, razão null, fila (override com confirmação, 409, 403,
// paginação, exportação), axe e 320/768/1920 sem rolagem horizontal.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function open(
  page: Page,
  role: Role,
  init: Parameters<typeof mockEquipment>[2] = {},
  path = "/dashboard",
): Promise<EquipmentState> {
  await installMocks(page, { role });
  const state = await mockEquipment(page, role, init);
  await seedSession(page, { role });
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const panel = (page: Page, id: string) => page.locator(`[data-equipment-panel=${id}]`);
const dataCalls = (state: EquipmentState) => state.calls.filter((c) => c.url.includes("/data"));

async function expectLoaded(page: Page, id: string) {
  await expect(panel(page, id)).toBeVisible({ timeout: 20_000 });
  await expect(panel(page, id).getByRole("status")).toHaveCount(0, { timeout: 20_000 });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main");
    return {
      page: doc.scrollWidth - doc.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.main).toBeLessThanOrEqual(1);
}

test.describe("renderização por tipo", () => {
  test("ADM: 13 painéis com os números exatos do backend", async ({ page }) => {
    await open(page, "ADM");
    const grid = page.locator("[data-equipment-grid]");
    await expect(grid).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-equipment-panel]")).toHaveCount(13);

    // cartoes
    const ws = panel(page, "kpi_workstations");
    await expect(ws.locator("[data-stat-card=computador]")).toContainText("120", { timeout: 20_000 });
    await expect(ws).toContainText("Total do grupo: 400");
    // tabela
    const table = panel(page, "equipment_by_unit_table");
    await expect(table.locator("table")).toContainText("PFN-TO", { timeout: 20_000 });
    await expect(table).toContainText("Total geral: 73");
    // grafico: figura + tabela de dados
    const chart = panel(page, "equipment_by_unit_chart");
    await expect(chart.locator("figure")).toBeVisible({ timeout: 20_000 });
    await expect(chart.locator('[role="img"]').first()).toHaveAccessibleName(/Tecnologia da Informação/);
    // distribuicao: percentual vindo pronto
    const dist = panel(page, "category_distribution");
    await expect(dist).toContainText("75,0%", { timeout: 20_000 });
    await expect(dist).toContainText("Por família");
    // ranking (estimativa)
    const rank = panel(page, "notebooks_without_docking");
    await expect(rank.locator("[data-estimate-notice]")).toContainText("Estimativa", { timeout: 20_000 });
    await expect(rank.locator("[data-estimate-notice]")).toContainText("não vincula");
    // razao com null -> "—"
    const ratio = panel(page, "workstation_ratio");
    await expect(ratio.locator("[data-stat-card=rz-por-notebook]")).toContainText("—", { timeout: 20_000 });
    await expect(ratio).toContainText("a razão não é calculada");
    // fila (indicador + link)
    const queue = panel(page, "unclassified_review");
    await expect(queue.locator("[data-stat-card=fila-pendentes]")).toContainText("7", { timeout: 20_000 });
    await expect(queue.locator("[data-review-link]")).toHaveAttribute("href", "/dashboard/classificacao");
    // lista
    await expect(panel(page, "classification_overrides")).toContainText("000123", { timeout: 20_000 });
    // status
    await expect(panel(page, "sync_status")).toContainText("Divergências pendentes", { timeout: 20_000 });
  });

  test("USER recebe só o que o catálogo devolve (10)", async ({ page }) => {
    await open(page, "USER");
    await expect(page.locator("[data-equipment-panel]")).toHaveCount(10, { timeout: 20_000 });
    await expect(panel(page, "unclassified_review")).toHaveCount(0);
  });

  test("RH: 8 painéis, sem análises nem administração", async ({ page }) => {
    const state = await open(page, "RH");
    await expect(page.locator("[data-equipment-panel]")).toHaveCount(8, { timeout: 20_000 });
    await expect(panel(page, "notebooks_without_docking")).toHaveCount(0);
    // O cliente não consulta dados de painéis que o catálogo não devolveu.
    await expect(page.locator("[data-equipment-panel=kpi_workstations] [data-stat-card]").first()).toBeVisible({ timeout: 20_000 });
    expect(dataCalls(state).some((c) => c.url.includes("unclassified_review"))).toBe(false);
  });

  test("404 de dados (proibido/inexistente) apenas oculta o painel, sem alerta", async ({ page }) => {
    await open(page, "USER", { dataStatus: { kpi_furniture: 404 } });
    await expect(panel(page, "kpi_workstations")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-equipment-panel=kpi_furniture]")).toHaveCount(0);
    await expect(page.locator("[data-equipment-error]")).toHaveCount(0);
  });
});

test.describe("estados", () => {
  test("skeleton durante o carregamento", async ({ page }) => {
    await open(page, "USER", { delayData: 1500 });
    await expect(page.getByRole("status", { name: /Carregando Postos de trabalho/ }).or(panel(page, "kpi_workstations").getByText("Carregando Postos de trabalho"))).toBeAttached({ timeout: 20_000 });
    await expect(panel(page, "kpi_workstations").locator("[data-stat-card]").first()).toBeVisible({ timeout: 20_000 });
  });

  test("vazio claro, sem gráfico de exemplo", async ({ page }) => {
    await open(page, "USER", { dataStatus: { equipment_by_unit_chart: "empty", category_distribution: "empty" } });
    for (const id of ["equipment_by_unit_chart", "category_distribution"]) {
      await expect(panel(page, id).locator("[data-equipment-empty]")).toBeVisible({ timeout: 20_000 });
    }
    await expect(panel(page, "equipment_by_unit_chart").locator("figure")).toHaveCount(0);
  });

  test("erro isolado com 'Tentar novamente' e sem a mensagem do backend", async ({ page }) => {
    const state = await open(page, "USER", { dataStatus: { kpi_infrastructure: 500 } });
    const broken = panel(page, "kpi_infrastructure");
    await expect(broken.locator("[data-equipment-error]")).toBeVisible({ timeout: 20_000 });
    await expect(broken).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(panel(page, "kpi_workstations").locator("[data-stat-card]").first()).toBeVisible();
    state.dataStatus.kpi_infrastructure = 0 as never;
    delete state.dataStatus.kpi_infrastructure;
    await broken.getByRole("button", { name: /Tentar novamente/ }).click();
    await expect(broken.locator("[data-stat-card=impressora]")).toContainText("30", { timeout: 20_000 });
  });

  test("catálogo indisponível: erro com retry", async ({ page }) => {
    await open(page, "USER", { catalogStatus: 500 });
    const alert = page.locator("[data-equipment-catalog-error]");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  });
});

test.describe("filtros e exportação", () => {
  test("família/unidade/categoria vão para a consulta e 'Limpar' volta ao padrão", async ({ page }) => {
    const state = await open(page, "USER");
    await expect(panel(page, "kpi_workstations").locator("[data-stat-card]").first()).toBeVisible({ timeout: 20_000 });
    const filters = page.locator("[data-equipment-filters]");
    await filters.getByLabel("Família").selectOption("TI");
    await expect.poll(() => dataCalls(state).some((c) => c.url.includes("familia=TI"))).toBe(true);
    await filters.getByLabel("Categoria").selectOption("NOTEBOOK");
    await expect.poll(() => dataCalls(state).some((c) => c.url.includes("categoria=NOTEBOOK") && c.url.includes("familia=TI"))).toBe(true);
    // Categoria de outra família não fica oferecida com a família TI.
    await expect(filters.getByLabel("Categoria").locator("option[value=MESA]")).toHaveCount(0);
    await filters.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(filters.getByLabel("Família")).toHaveValue("");
    await expect(filters).toContainText("Sem filtros");
  });

  test("botões de exportar só nos painéis exportable e baixam o arquivo", async ({ page }) => {
    const state = await open(page, "USER");
    await expect(panel(page, "equipment_by_unit_table")).toContainText("Total geral", { timeout: 20_000 });
    await expect(page.locator("[data-equipment-export]")).toHaveCount(2);
    await expect(panel(page, "kpi_workstations").locator("[data-equipment-export]")).toHaveCount(0);
    const download = page.waitForEvent("download");
    await panel(page, "equipment_by_unit_table").getByRole("button", { name: /Exportar CSV/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^sispat-equipment-by-unit-table-\d{8}T\d{6}Z\.csv$/);
    await expect(panel(page, "equipment_by_unit_table").getByRole("status").filter({ hasText: "gerado" })).toBeVisible();
    expect(state.calls.some((c) => c.url.includes("/export") && c.url.includes("format=csv"))).toBe(true);
  });
});

test.describe("fila de revisão", () => {
  test("ADM corrige a categoria só depois de confirmar; o item sai após o 200", async ({ page }) => {
    const state = await open(page, "ADM", {}, "/dashboard/classificacao");
    const rows = page.locator("[data-review-table] [data-review-row]");
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    const first = rows.first();
    await first.getByLabel(/Nova categoria do bem 1000/).selectOption("MESA");
    // Escolher não grava.
    const dialog = page.getByRole("dialog", { name: "Confirmar correção de categoria" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("“Mesa”");
    expect(state.overrides).toHaveLength(0);
    await dialog.getByRole("button", { name: "Confirmar correção" }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]?.body).toEqual({ category: "MESA", version: 3 });
    await expect(page.locator("[data-review-notice]")).toContainText("corrigido para “Mesa”");
    await expect(rows).toHaveCount(2);
  });

  test("cancelar não grava nada", async ({ page }) => {
    const state = await open(page, "ADM", {}, "/dashboard/classificacao");
    const rows = page.locator("[data-review-table] [data-review-row]");
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await rows.first().getByLabel(/Nova categoria/).selectOption("NOTEBOOK");
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click();
    expect(state.overrides).toHaveLength(0);
    await expect(rows).toHaveCount(3);
  });

  test("409: recarrega a fila e avisa, sem detalhe do backend", async ({ page }) => {
    const state = await open(page, "ADM", { overrideStatus: 409 }, "/dashboard/classificacao");
    const rows = page.locator("[data-review-table] [data-review-row]");
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await rows.first().getByLabel(/Nova categoria/).selectOption("MESA");
    await page.getByRole("dialog").getByRole("button", { name: "Confirmar correção" }).click();
    const notice = page.locator("[data-review-notice]");
    await expect(notice).toContainText("alterado por outra pessoa", { timeout: 20_000 });
    await expect(notice).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // A fila foi recarregada e a versão nova está no item.
    const before = state.calls.filter((c) => c.url.includes("/revisao?")).length;
    expect(before).toBeGreaterThanOrEqual(2);
    await rows.first().getByLabel(/Nova categoria/).selectOption("MESA");
    await page.getByRole("dialog").getByRole("button", { name: "Confirmar correção" }).click();
    expect(state.overrides.at(-1)?.body).toEqual({ category: "MESA", version: 4 });
  });

  test("403 no override: mensagem neutra no diálogo, item permanece", async ({ page }) => {
    await open(page, "ADM", { overrideStatus: 403 }, "/dashboard/classificacao");
    const rows = page.locator("[data-review-table] [data-review-row]");
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await rows.first().getByLabel(/Nova categoria/).selectOption("MESA");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Confirmar correção" }).click();
    await expect(dialog).toContainText("não está disponível ou seu perfil não permite");
    await expect(dialog).not.toContainText("SISPAT_BACKEND_MSG");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(rows).toHaveCount(3);
  });

  test("não-ADM: mensagem neutra, sem lista nem retry", async ({ page }) => {
    await open(page, "USER", {}, "/dashboard/classificacao");
    await expect(page.locator("[data-review-error]")).toContainText("não está disponível para o seu perfil", { timeout: 20_000 });
    await expect(page.locator("[data-review-row]")).toHaveCount(0);
  });

  test("vazio, erro com retry e paginação", async ({ page }) => {
    await open(page, "ADM", { queueSize: 0 }, "/dashboard/classificacao");
    await expect(page.locator("[data-review-empty]")).toContainText("Nenhum bem aguardando revisão", { timeout: 20_000 });
  });

  test("erro 500 da fila: retry recupera", async ({ page }) => {
    const state = await open(page, "ADM", { queueStatus: 500 }, "/dashboard/classificacao");
    const alert = page.locator("[data-review-error]");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    state.queueStatus = null;
    await alert.getByRole("button", { name: /Tentar novamente/ }).click();
    await expect(page.locator("[data-review-table] [data-review-row]")).toHaveCount(3, { timeout: 20_000 });
  });

  test("paginação usa page_size 50/100/200 e exportação baixa o arquivo", async ({ page }) => {
    const state = await open(page, "ADM", { queueSize: 120 }, "/dashboard/classificacao");
    await expect(page.locator("[data-review-table] [data-review-row]")).toHaveCount(50, { timeout: 20_000 });
    await page.getByRole("button", { name: /Próxima/ }).first().click();
    await expect.poll(() => state.calls.some((c) => c.url.includes("page=2") && c.url.includes("page_size=50"))).toBe(true);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar fila CSV" }).click();
    expect((await download).suggestedFilename()).toMatch(/^sispat-revisao-classificacao-.*\.csv$/);
  });

  test("tabela vira cartões no celular", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page, "ADM", {}, "/dashboard/classificacao");
    await expect(page.locator("[data-review-cards] [data-review-row]")).toHaveCount(3, { timeout: 20_000 });
    await expect(page.locator("[data-review-table]")).toBeHidden();
    await noHorizontalScroll(page);
  });
});

test.describe("acessibilidade e responsividade", () => {
  test("axe sem violações no dashboard (ADM, todos os painéis)", async ({ page }) => {
    await open(page, "ADM");
    await expect(page.locator("[data-equipment-panel]")).toHaveCount(13, { timeout: 20_000 });
    await expect(page.locator("[data-equipment-panel=sync_status]")).toContainText("Divergências", { timeout: 20_000 });
    await expect(page.locator("[data-equipment-panel=equipment_by_unit_chart] figure")).toBeVisible({ timeout: 20_000 });
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).include("[data-equipment-section]").analyze();
    expect(results.violations).toEqual([]);
  });

  test("axe sem violações na fila de revisão (com diálogo aberto)", async ({ page }) => {
    await open(page, "ADM", {}, "/dashboard/classificacao");
    await expect(page.locator("[data-review-table] [data-review-row]")).toHaveCount(3, { timeout: 20_000 });
    await waitForAnimations(page);
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
    await page.locator("[data-review-table] [data-review-row]").first().getByLabel(/Nova categoria/).selectOption("MESA");
    await expect(page.getByRole("dialog")).toBeVisible();
    await waitForAnimations(page);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  for (const width of [320, 768, 1920]) {
    test(`sem rolagem horizontal da página em ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "ADM");
      await expect(page.locator("[data-equipment-panel]")).toHaveCount(13, { timeout: 20_000 });
      await expect(page.locator("[data-equipment-panel=equipment_by_unit_chart] figure")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-equipment-panel=sync_status]")).toContainText("Divergências", { timeout: 20_000 });
      await waitForAnimations(page);
      await noHorizontalScroll(page);
      if (width === 320) {
        // Tabela vira cartões no celular.
        await expect(panel(page, "equipment_by_unit_table").locator("ul[aria-label]").first()).toBeVisible();
        await expect(panel(page, "equipment_by_unit_table").locator("table:visible")).toHaveCount(0);
      }
    });
  }
});
