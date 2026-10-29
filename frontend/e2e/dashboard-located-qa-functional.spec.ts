import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PFN_UNIT_ID, mockEquipment, type EquipmentState, type Role } from "./dashboard-equipment-support";
import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// ONDA C (QA): lacunas do spec funcional do painel `located_by_unit_chart`:
// axe + rolagem horizontal com a LISTA ABERTA em 320/768/1920 para os 3 perfis,
// diálogo com seletores, contraste/distinção das 3 séries, prefers-reduced-motion
// medido, foco (Shift+Tab preso, retorno), erro 400 sem eco, varredura estática
// (sem dangerouslySetInnerHTML/eval/storage) e nenhuma escrita de rede.
// =============================================================================

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const panel = (page: Page) => page.locator("[data-equipment-panel=located_by_unit_chart]");
const cell = (page: Page, unit: string, located: string) =>
  panel(page).locator(`[data-located-cell="${unit}:${located}"]:visible`);
const sheet = (page: Page, name?: string | RegExp) => page.getByRole("dialog", name ? { name } : undefined);

async function open(page: Page, role: Role = "USER", init: Parameters<typeof mockEquipment>[2] = {}): Promise<EquipmentState> {
  await installMocks(page, { role });
  const state = await mockEquipment(page, role, init);
  await seedSession(page, { role });
  await page.goto("/dashboard");
  await waitForHydration(page);
  await expect(panel(page).locator("figure")).toBeVisible({ timeout: 20_000 });
  return state;
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const dlg = document.querySelector("[role=dialog]");
    return {
      page: doc.scrollWidth - doc.clientWidth,
      dialog: dlg ? dlg.scrollWidth - dlg.clientWidth : 0,
    };
  });
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test.describe("varredura estática do código do painel", () => {
  const root = path.resolve(__dirname, "..", "src");
  const files = [
    "lib/dashboard-located-api.ts",
    "components/features/dashboard/located-chart-view.tsx",
    "components/features/dashboard/located-records-sheet.tsx",
  ];
  for (const rel of files) {
    test(`${rel}: sem HTML cru, eval, storage nem cookies`, () => {
      const src = readFileSync(path.join(root, rel), "utf8").replace(/\/\/.*$/gm, "");
      for (const banned of [/dangerouslySetInnerHTML/, /\beval\s*\(/, /new Function\(/, /innerHTML/, /localStorage/, /sessionStorage/, /document\.cookie/, /indexedDB/]) {
        expect(src, String(banned)).not.toMatch(banned);
      }
    });
  }
  test("a API do painel só usa GET", () => {
    const src = readFileSync(path.join(root, "lib/dashboard-located-api.ts"), "utf8");
    expect(src).not.toMatch(/apiClient\.(post|put|patch|delete)/);
  });
});

test.describe("contraste e distinção das séries", () => {
  test("as 3 cores têm >= 3:1 sobre o canvas e o padrão difere (não só cor)", async ({ page }) => {
    await open(page);
    const canvas = "#101010";
    for (const [name, hex] of [["verde", "#a0ca92"], ["laranja", "#ee6018"], ["granito", "#8a8380"]] as const) {
      expect(ratio(hex, canvas), name).toBeGreaterThanOrEqual(3);
    }
    const patterns = await panel(page).locator("[data-legend-pattern]").evaluateAll((els) => els.map((e) => e.getAttribute("data-legend-pattern")));
    expect(new Set(patterns).size).toBe(3);
  });
});

for (const role of ["ADM", "USER", "RH"] as const) {
  for (const width of [320, 768, 1920]) {
    test(`${role} ${width}px: gráfico + lista aberta sem rolagem horizontal e axe WCAG 2.2 AA`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, role);
      await waitForAnimations(page);
      expect((await overflow(page)).page).toBeLessThanOrEqual(1);
      let axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).include("[data-equipment-panel=located_by_unit_chart]").analyze();
      expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);

      const trigger = cell(page, PFN_UNIT_ID, "ALL");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const d = sheet(page, "Todas as situações — PFN-TO");
      await expect(d).toBeVisible();
      await expect(d.locator("[data-located-row]:visible").first()).toBeVisible({ timeout: 20_000 });
      await waitForAnimations(page);
      const o = await overflow(page);
      expect(o.page).toBeLessThanOrEqual(1);
      expect(o.dialog).toBeLessThanOrEqual(1);
      axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);

      // seletor aberto por teclado dentro do diálogo continua sem violação
      await d.getByLabel("Ordenar por").focus();
      axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).include("[role=dialog]").analyze();
      expect(axe.violations).toEqual([]);
    });
  }
}

test.describe("foco e teclado", () => {
  test("Shift+Tab também fica preso no diálogo e o foco volta ao botão de origem", async ({ page }) => {
    await open(page);
    const trigger = cell(page, PFN_UNIT_ID, "NAO");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const d = sheet(page, "Não localizados — PFN-TO");
    await expect(d).toBeVisible();
    await expect(d.locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("conteúdo de fora do diálogo fica inerte (aria-hidden/inert) enquanto aberto", async ({ page }) => {
    await open(page);
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page)).toBeVisible();
    const leaked = await page.evaluate(() => {
      const dlg = document.querySelector("[role=dialog]");
      return Array.from(document.querySelectorAll("main button")).filter((b) => {
        const el = b as HTMLElement;
        return !dlg?.contains(el) && !el.closest("[aria-hidden=true], [inert]");
      }).length;
    });
    expect(leaked).toBe(0);
  });
});

test.describe("erros e rede", () => {
  test("400 do servidor: mensagem fixa, sem eco do texto do servidor e sem nova tentativa automática", async ({ page }) => {
    const state = await open(page, "USER", { located: { status: 400, empty: false, calls: [] } });
    await cell(page, PFN_UNIT_ID, "NAO").click();
    const d = sheet(page);
    await expect(d.locator("[data-located-error]")).toContainText("Não foi possível carregar os bens", { timeout: 20_000 });
    await expect(d).not.toContainText("SISPAT_BACKEND_MSG");
    await page.waitForTimeout(1500);
    expect(state.located.calls).toHaveLength(1); // 4xx não repete
  });

  test("só GET na API de registros; nunca envia parâmetros fora da allowlist nem dado pessoal", async ({ page }) => {
    const state = await open(page);
    const writes: string[] = [];
    page.on("request", (r) => {
      if (/\/dashboard\/panels\/located_by_unit_chart/.test(r.url()) && r.method() !== "GET") writes.push(r.method());
    });
    await cell(page, PFN_UNIT_ID, "NAO").click();
    await expect(sheet(page).locator("[data-located-row]").first()).toBeAttached({ timeout: 20_000 });
    await sheet(page).getByLabel("Ordenar por").selectOption("description");
    await sheet(page).getByLabel("Situação").selectOption("");
    await expect.poll(() => state.located.calls.length).toBeGreaterThan(2);
    const allowed = new Set(["unit_id", "located", "familia", "categoria", "page", "page_size", "sort"]);
    for (const call of state.located.calls) {
      for (const key of new URLSearchParams(call).keys()) expect(allowed.has(key), key).toBe(true);
    }
    expect(writes).toEqual([]);
  });
});

test.describe("prefers-reduced-motion", () => {
  test("transições e animações do diálogo são desligadas", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await cell(page, PFN_UNIT_ID, "NAO").click();
    const d = sheet(page, "Não localizados — PFN-TO");
    await expect(d).toBeVisible();
    const t = await d.evaluate((el) => {
      const s = getComputedStyle(el);
      const secs = (v: string) => Math.max(0, ...v.split(",").map((x) => parseFloat(x) || 0));
      return { anim: secs(s.animationDuration), trans: secs(s.transitionDuration) };
    });
    expect(t.anim).toBeLessThanOrEqual(0.01);
    expect(t.trans).toBeLessThanOrEqual(0.01);
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
  });
});
