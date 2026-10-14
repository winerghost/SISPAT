import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { VIEWPORTS, waitForAnimations } from "./support/screens";

// =============================================================================
// Dashboard (/) — estado vazio honesto (sem números fictícios), entrada
// nomeada sfDashboardFrameIn aplicada UMA vez, reduced motion, overflow nas 9
// resoluções, axe e console. Os componentes de gráfico (AnimatedChart,
// StatCard com dados) não têm página com dados reais — não testados aqui.
// =============================================================================

async function openDashboard(page: Page): Promise<void> {
  await installMocks(page, { role: "ADM" });
  await seedSession(page, { role: "ADM" });
  await page.goto("/");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
}

test.describe("dashboard", () => {
  test("estado vazio honesto: nenhum número, skeleton, gráfico ou filtro falso", async ({ page }) => {
    await openDashboard(page);
    const frame = page.getByRole("region", { name: "Painel patrimonial" });
    await expect(frame).toBeVisible();
    await expect(frame.getByRole("heading", { name: "Indicadores ainda indisponíveis" })).toBeVisible();
    await expect(frame).toContainText("Aguardando dados");
    await expect(frame).toContainText("não usa dados de demonstração");

    const text = (await frame.innerText()) ?? "";
    expect(text, "nenhum dígito (número fictício) no painel").not.toMatch(/\d/);
    await expect(frame.locator("[data-stat-card]")).toHaveCount(0);
    await expect(frame.locator("svg.recharts-surface, figure")).toHaveCount(0);
    await expect(frame.getByRole("status")).toHaveCount(0);
    await expect(frame.getByRole("group", { name: "Período" })).toHaveCount(0);
  });

  test("sfDashboardFrameIn aplicada uma única vez e termina visível", async ({ page }) => {
    await openDashboard(page);
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*")).filter(
        (el) => getComputedStyle(el).animationName === "sfDashboardFrameIn",
      ).length,
    );
    expect(names).toBe(1);
    await waitForAnimations(page);
    const frame = page.locator("[data-dashboard-frame]");
    await expect
      .poll(() => frame.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
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

  test("reduced motion: painel visível sem deslocamento", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDashboard(page);
    const style = await page
      .locator("[data-dashboard-frame]")
      .evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform }));
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
          frameRight: document.querySelector("[data-dashboard-frame]")!.getBoundingClientRect().right,
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
