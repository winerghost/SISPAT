import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LOCATED_CHART,
  LOCATED_SUMMARY,
  LOCATED_SUMMARY_ENTRY,
  mockEquipment,
  type EquipmentState,
  type Role,
} from "./dashboard-equipment-support";
import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Painel `located_summary` (rosca com o quantitativo GLOBAL por situação de
// localização) + linha de totais da tabela do painel por unidade.
// Cobre: rosca com textura por série, série em ZERO presente na legenda e na
// tabela, total e percentuais exatamente como o backend mandou, total sem
// percentual próprio, vazio honesto (`total = 0`), erro/404/contrato inválido,
// ausência de chamadas a `/records`, 320/768/1920 sem rolagem horizontal, axe
// WCAG 2.2 AA, XSS em rótulos e varredura estática do componente.
// Contrato MOCKADO (dashboard-equipment-support.ts); nada é real.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const panel = (page: Page) => page.locator("[data-equipment-panel=located_summary]");
const unitPanel = (page: Page) => page.locator("[data-equipment-panel=located_by_unit_chart]");

async function open(
  page: Page,
  role: Role = "USER",
  init: Parameters<typeof mockEquipment>[2] = {},
): Promise<EquipmentState> {
  await installMocks(page, { role });
  const state = await mockEquipment(page, role, { extraCatalog: [LOCATED_SUMMARY_ENTRY], ...init });
  await seedSession(page, { role });
  await page.goto("/dashboard");
  await waitForHydration(page);
  return state;
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main");
    return { page: doc.scrollWidth - doc.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.main).toBeLessThanOrEqual(1);
}

test.describe("rosca do resumo global", () => {
  test("rosca, legenda com textura, total e tabela com os números do backend", async ({ page }) => {
    await open(page);
    const p = panel(page);
    await expect(p.locator("figure")).toBeVisible({ timeout: 20_000 });
    await expect(p.locator("[data-chart-kind=donut]")).toBeVisible();

    // Nome acessível da figura: resume TODAS as séries (inclusive a zerada).
    const figure = p.locator('[role="img"]').first();
    await expect(figure).toHaveAccessibleName(/Gráfico de rosca/);
    await expect(figure).toHaveAccessibleName(/Localizados 129/);
    await expect(figure).toHaveAccessibleName(/Não localizados 15/);
    await expect(figure).toHaveAccessibleName(/Não informado 0/);

    // Legenda: 3 séries, cada uma com textura própria (nunca só cor).
    const legend = p.getByRole("list", { name: /Legenda/ });
    await expect(legend.locator("li")).toHaveCount(3);
    await expect(legend.locator("[data-legend-pattern=solid]")).toHaveCount(1);
    await expect(legend.locator("[data-legend-pattern=lines]")).toHaveCount(1);
    await expect(legend.locator("[data-legend-pattern=dots]")).toHaveCount(1);
    await expect(legend).toContainText("Não informado");
    await expect(legend).toContainText("0");
    // Texturas SVG nas fatias (listras + pontos).
    await expect.poll(() => p.locator("[data-chart-surface] svg pattern").count()).toBeGreaterThanOrEqual(2);

    // Total global do servidor (cartão "Metric Tile").
    await expect(p.locator("[data-stat-card=located-summary-total]")).toContainText("144");
    expect(LOCATED_SUMMARY.total).toBe(144);

    // Tabela de dados: contagem + percentual do backend e linha de total.
    const table = p.locator("[data-located-summary-matrix] table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("row", { name: /Localizados/ }).first()).toContainText("129");
    await expect(table.getByRole("row", { name: /Localizados/ }).first()).toContainText("89,6%");
    await expect(table.getByRole("row", { name: /Não localizados/ })).toContainText("10,4%");
    const zero = table.locator("[data-located-summary-row=DESCONHECIDO]");
    await expect(zero).toContainText("Não informado");
    await expect(zero).toContainText("0");
    const totals = table.locator("[data-located-summary-totals]");
    await expect(totals).toContainText("144");
    // O total não tem percentual próprio: "—", nunca 100% inventado.
    await expect(totals).toContainText("—");
    await expect(totals).not.toContainText("100");
    await expect(p.locator("[data-located-summary-zero]")).toBeVisible();
  });

  test("não pede registros e aponta o filtro de Patrimônios", async ({ page }) => {
    const state = await open(page);
    await expect(panel(page).locator("figure")).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator("[data-located-summary-hint]")).toContainText("filtro “Localizado”");
    await expect(panel(page).locator("[data-located-summary-link]")).toHaveAttribute("href", "/patrimonios");
    // O painel não tem endpoint de registros: nenhuma chamada é feita.
    expect(state.calls.filter((c) => c.url.includes("located_summary"))).not.toHaveLength(0);
    expect(state.calls.filter((c) => c.url.includes("located_summary") && c.url.includes("/records"))).toHaveLength(0);
  });

  test("total = 0: vazio honesto, sem rosca e sem número de exemplo", async ({ page }) => {
    await open(page, "USER", { dataStatus: { located_summary: "empty" } });
    const p = panel(page);
    await expect(p.locator("[data-equipment-empty]")).toBeVisible({ timeout: 20_000 });
    await expect(p.locator("figure")).toHaveCount(0);
    await expect(p.locator("[data-located-summary]")).toHaveCount(0);
  });

  test("erro: mensagem fixa e Tentar novamente; 404 oculta; contrato inválido não renderiza", async ({ page }) => {
    const state = await open(page, "USER", { dataStatus: { located_summary: 500 } });
    const p = panel(page);
    await expect(p.locator("[data-equipment-error]")).toBeVisible({ timeout: 20_000 });
    await expect(p).not.toContainText("SISPAT_BACKEND_MSG");
    delete state.dataStatus.located_summary;
    await p.getByRole("button", { name: /Tentar novamente/ }).click();
    await expect(p.locator("figure")).toBeVisible({ timeout: 20_000 });

    // Resposta fora do formato: rejeitada pelo type guard (nada é desenhado).
    state.payloadOverride = { located_summary: { tipo: "grafico", dados: { total: 5, series: [{ id: "SIM", label: "x" }] } } };
    await page.reload();
    await waitForHydration(page);
    await expect(panel(page).locator("[data-equipment-error]")).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator("[data-located-summary]")).toHaveCount(0);

    delete state.payloadOverride;
    state.dataStatus.located_summary = 404;
    await page.reload();
    await waitForHydration(page);
    await expect(page.locator("[data-equipment-panel=kpi_workstations]")).toBeVisible({ timeout: 20_000 });
    await expect(panel(page)).toHaveCount(0);
  });

  test("XSS no rótulo da série aparece como texto e não executa", async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await open(page, "USER", {
      payloadOverride: {
        located_summary: {
          tipo: "grafico",
          dados: { ...LOCATED_SUMMARY, series: LOCATED_SUMMARY.series.map((s, i) => (i === 0 ? { ...s, label: evil } : s)) },
        },
      },
    });
    const p = panel(page);
    await expect(p.locator("[data-located-summary-matrix]")).toContainText("<img src=x", { timeout: 20_000 });
    expect(await p.locator("img, script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

test.describe("linha de totais do painel por unidade", () => {
  test("tabela: total geral do servidor e total por situação de todas as unidades", async ({ page }) => {
    await open(page);
    const table = unitPanel(page).locator("[data-located-matrix] table");
    await expect(table).toBeVisible({ timeout: 20_000 });
    const totals = table.locator("[data-located-totals]");
    await expect(totals).toContainText("Total (todas as unidades)");
    // dados.total = 148 (servidor); por situação: 129 / 14 / 5 (soma das linhas que o servidor mandou).
    for (const value of ["148", "129", "14", "5"]) {
      await expect(totals).toContainText(value);
    }
    // Sem divergência entre a soma por situação e o total do servidor.
    await expect(unitPanel(page).locator("[data-located-totals-mismatch]")).toHaveCount(0);
    // A linha de totais não é clicável (não há unidade a listar).
    await expect(totals.getByRole("button")).toHaveCount(0);
  });

  test("divergência entre a soma por situação e o total do servidor é exibida", async ({ page }) => {
    await open(page, "USER", {
      payloadOverride: {
        located_by_unit_chart: { tipo: "grafico", dados: { ...LOCATED_CHART, total: 999 } },
      },
    });
    const mismatch = unitPanel(page).locator("[data-located-totals-mismatch]");
    await expect(mismatch).toBeVisible({ timeout: 20_000 });
    await expect(mismatch).toContainText("148");
    await expect(mismatch).toContainText("999");
  });

  test("320px: a linha de totais aparece como cartão", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await open(page);
    const p = unitPanel(page);
    await expect(p.locator("figure")).toBeVisible({ timeout: 20_000 });
    const card = p.locator("li[data-located-totals]");
    await expect(card).toBeVisible();
    await expect(card).toContainText("148");
    await expect(p.locator("[data-located-matrix] table")).toBeHidden();
    await noHorizontalScroll(page);
  });
});

test.describe("responsividade, acessibilidade e motion", () => {
  for (const width of [320, 768, 1920]) {
    test(`${width}px: sem rolagem horizontal, ${width < 1024 ? "cartões" : "tabela"} e axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const p = panel(page);
      await expect(p.locator("figure")).toBeVisible({ timeout: 20_000 });
      await waitForAnimations(page);
      await noHorizontalScroll(page);
      if (width < 1024) {
        await expect(p.locator("[data-located-summary-card=SIM]")).toBeVisible();
        await expect(p.locator("[data-located-summary-matrix] table")).toBeHidden();
        await expect(p.locator("li[data-located-summary-totals]")).toContainText("144");
      } else {
        await expect(p.locator("[data-located-summary-matrix] table")).toBeVisible();
        await expect(p.locator("[data-located-summary-card=SIM]")).toBeHidden();
      }
      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include("[data-equipment-panel=located_summary]")
        .analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

  for (const role of ["ADM", "USER", "RH"] as const) {
    test(`${role}: o painel do catálogo é desenhado como veio`, async ({ page }) => {
      await open(page, role);
      await expect(panel(page).locator("[data-stat-card=located-summary-total]")).toContainText("144", {
        timeout: 20_000,
      });
    });
  }

  test("prefers-reduced-motion: rosca e tabela sem animação pendente", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await expect(panel(page).locator("figure")).toBeVisible({ timeout: 20_000 });
    await waitForAnimations(page);
    const running = await page.evaluate(
      () =>
        document
          .querySelector("[data-equipment-panel=located_summary]")
          ?.getAnimations?.({ subtree: true })
          .filter((a) => a.playState === "running").length ?? 0,
    );
    expect(running).toBe(0);
  });

  test("nada de dado do painel em localStorage/sessionStorage", async ({ page }) => {
    await open(page);
    await expect(panel(page).locator("figure")).toBeVisible({ timeout: 20_000 });
    const dump = await page.evaluate(() =>
      JSON.stringify({ l: { ...window.localStorage }, s: { ...window.sessionStorage } }),
    );
    expect(dump).not.toMatch(/Não localizados|located_summary/i);
  });
});

test.describe("varredura estática", () => {
  test("located-summary-view.tsx: sem HTML cru, eval, storage nem cookies", () => {
    const file = path.resolve(__dirname, "..", "src", "components", "features", "dashboard", "located-summary-view.tsx");
    const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    for (const banned of [
      /dangerouslySetInnerHTML/,
      /\beval\s*\(/,
      /new Function\(/,
      /innerHTML/,
      /localStorage/,
      /sessionStorage/,
      /document\.cookie/,
      /indexedDB/,
    ]) {
      expect(src, String(banned)).not.toMatch(banned);
    }
  });
});
