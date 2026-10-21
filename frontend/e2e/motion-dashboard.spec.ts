import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { VIEWPORTS, waitForAnimations } from "./support/screens";

// =============================================================================
// Home (/) — sem texto de fase antiga nem painel falso, atalho para /dashboard,
// entrada sequencial, reduced motion, overflow nas 9 resoluções, axe e console.
// =============================================================================

async function openDashboard(page: Page): Promise<void> {
  await installMocks(page, { role: "ADM" });
  await seedSession(page, { role: "ADM" });
  await page.goto("/");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
}

test.describe("dashboard", () => {
  test("Home sem texto de fase antiga nem painel falso; atalho para /dashboard", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByText("Fase 1 em andamento")).toHaveCount(0);
    await expect(page.getByText("ainda não exibem dados reais")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Painel patrimonial" })).toHaveCount(0);
    await expect(page.locator("[data-dashboard-frame]")).toHaveCount(0);
    const link = page.getByRole("main").getByRole("link", { name: "Abrir o Dashboard" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/dashboard");
  });

  test("entrada sequencial em navegação client-side termina estável", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    await page
      .getByRole("navigation", { name: "Navegação principal", exact: true })
      .getByRole("link", { name: "Home" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
    await waitForAnimations(page);
    await expect
      .poll(() =>
        page
          .getByRole("heading", { level: 1, name: "SISPAT-AGU" })
          .evaluate((el) => getComputedStyle(el.parentElement!).opacity),
      )
      .toBe("1");
  });

  test("reduced motion: introdução visível sem deslocamento", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDashboard(page);
    const style = await page
      .getByRole("heading", { level: 1, name: "SISPAT-AGU" })
      .evaluate((el) => ({
        opacity: getComputedStyle(el.parentElement!).opacity,
        transform: getComputedStyle(el.parentElement!).transform,
      }));
    expect(style.opacity).toBe("1");
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(style.transform);
  });

  test("sem overflow horizontal nas 9 resoluções", async ({ page }) => {
    await openDashboard(page);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await waitForAnimations(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        return {
          doc: document.documentElement.scrollWidth,
          main: main.scrollWidth - main.clientWidth,
          frameRight: document.querySelector("main h1")!.getBoundingClientRect().right,
        };
      });
      expect(m.doc, `${viewport.width}: documento`).toBeLessThanOrEqual(viewport.width);
      expect(m.main, `${viewport.width}: <main>`).toBeLessThanOrEqual(1);
      expect(m.frameRight, `${viewport.width}: frame`).toBeLessThanOrEqual(viewport.width);
    }
  });

  test("axe limpo e sem erros de console/hidratação", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (/Failed to load resource|net::ERR_FAILED/.test(msg.text())) return;
      errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    await openDashboard(page);
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("nextjs-portal")
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.waitForTimeout(300);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
