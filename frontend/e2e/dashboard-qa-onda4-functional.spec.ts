import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { mockEquipment, type Role } from "./dashboard-equipment-support";
import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// ONDA 4 (QA): lacunas de a11y/responsividade/segurança de frontend.
//  - axe WCAG 2.2 AA em 320/768/1920px para o dashboard (ADM/USER/RH) e para a
//    fila /dashboard/classificacao (inclui o diálogo de confirmação aberto);
//  - sem rolagem horizontal da página em cada largura;
//  - prefers-reduced-motion no dashboard e na fila;
//  - nada em localStorage/sessionStorage e nenhum texto do servidor na tela.
// Contrato MOCKADO (dashboard-equipment-support.ts); nenhuma chamada sai da máquina.
// =============================================================================

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const WIDTHS = [320, 768, 1920] as const;

async function open(page: Page, role: Role, path: string, init: Parameters<typeof mockEquipment>[2] = {}) {
  await installMocks(page, { role });
  const state = await mockEquipment(page, role, init);
  await seedSession(page, { role });
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main");
    return { page: doc.scrollWidth - doc.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.main).toBeLessThanOrEqual(1);
}

async function dashboardReady(page: Page, role: Role) {
  const expected = { ADM: 12, USER: 9, RH: 7 }[role];
  await expect(page.locator("[data-equipment-panel]")).toHaveCount(expected, { timeout: 20_000 });
  await expect(page.locator("[data-equipment-panel=equipment_by_unit_chart] figure")).toBeVisible({ timeout: 20_000 });
  await waitForAnimations(page);
}

test.describe("QA onda 4: axe + 320/768/1920 no dashboard", () => {
  for (const width of WIDTHS) {
    for (const role of ["ADM", "USER", "RH"] as const) {
      test(`${role} ${width}px: axe sem violações e sem rolagem horizontal`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 1920 ? 1000 : 800 });
        await open(page, role, "/dashboard");
        await dashboardReady(page, role);
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(results.violations).toEqual([]);
        await expectNoHorizontalScroll(page);
      });
    }
  }
});

test.describe("QA onda 4: fila /dashboard/classificacao", () => {
  for (const width of WIDTHS) {
    test(`${width}px: axe (com e sem diálogo aberto) e sem rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1920 ? 1000 : 800 });
      await open(page, "ADM", "/dashboard/classificacao");
      await expect(page.locator("[data-review-table] [data-review-row]")).toHaveCount(3, { timeout: 20_000 });
      await waitForAnimations(page);
      let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations).toEqual([]);
      await expectNoHorizontalScroll(page);
      // Em larguras estreitas a tabela vira cartões: usa o seletor VISÍVEL.
      await page.locator("[data-review-select]:visible").first().selectOption("MESA");
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitForAnimations(page);
      results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations).toEqual([]);
      await expectNoHorizontalScroll(page);
    });
  }

  test("prefers-reduced-motion: fila e dashboard carregam e o override continua exigindo confirmação", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await open(page, "ADM", "/dashboard/classificacao");
    await expect(page.locator("[data-review-table] [data-review-row]")).toHaveCount(3, { timeout: 20_000 });
    await page.locator("[data-review-select]:visible").first().selectOption("MESA");
    await expect(page.getByRole("dialog")).toBeVisible();
    // Selecionar não grava: só o botão de confirmar dispara o POST.
    expect(state.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/dashboard");
    await waitForHydration(page);
    await dashboardReady(page, "ADM");
    const animated = await page.evaluate(() =>
      document.getAnimations().filter((a) => a.playState === "running").length,
    );
    expect(animated).toBeLessThanOrEqual(2); // sem animações decorativas em curso
  });
});

test.describe("QA onda 4: armazenamento e erros do servidor", () => {
  test("nenhum dado de painel/preferência em localStorage ou sessionStorage", async ({ page }) => {
    await open(page, "ADM", "/dashboard");
    await dashboardReady(page, "ADM");
    // A sessão sintética do harness (sb-*/sispat-auth) é semeada pelo mock; aqui só
    // importa que o MÓDULO de painéis/classificação não persista nada no navegador.
    const dump = await page.evaluate(() =>
      JSON.stringify(
        [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(
          ([key]) => !/^(sb-|sispat-auth|__e2e)/.test(key),
        ),
      ),
    );
    expect(dump).toBe("[]");
  });

  test("falha da fila (500): mensagem neutra, sem texto do servidor", async ({ page }) => {
    await open(page, "ADM", "/dashboard/classificacao", { queueStatus: 500 });
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
    const text = (await page.locator("main").innerText()).toLowerCase();
    expect(text).not.toMatch(/traceback|exception|sqlalchemy|psycopg|stack|internal server error/);
  });
});
