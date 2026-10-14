import { expect, test } from "@playwright/test";

import { collectLayoutReport } from "./support/layout-checks";
import { expectNoXss, installMocks, seedSession, waitForHydration } from "./support/mocks";
import { LG, openScreen, SCREENS, VIEWPORTS } from "./support/screens";

// =============================================================================
// Matriz de responsividade: cada tela × cada viewport.
// Critérios: sem rolagem horizontal da página (tabelas rolam no próprio
// contêiner), sem sobreposição de regiões/alvos, alvos >= 24px (WCAG 2.5.8),
// texto >= 12px, modais cabendo na tela. Screenshot como evidência em
// test-results/ (fora do versionamento).
// =============================================================================

// O `next dev` compila cada rota na primeira visita (~8,5 s medidos para
// /administracao/usuarios, isolado). Com workers em paralelo isso passava dos
// 15 s padrão. Só a navegação para uma rota ainda não compilada usa este limite.
const FIRST_COMPILE_TIMEOUT = 45_000;

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const screen of SCREENS) {
      test(`${screen.id}`, async ({ page }, testInfo) => {
        await openScreen(page, screen);

        const report = await collectLayoutReport(page);
        await page.screenshot({
          path: testInfo.outputPath(`${screen.id}-${viewport.width}.png`),
        });
        await testInfo.attach("layout-report", {
          body: JSON.stringify(report, null, 2),
          contentType: "application/json",
        });

        expect.soft(report.docScrollWidth, "rolagem horizontal do documento").toBeLessThanOrEqual(viewport.width);
        expect.soft(report.mainOverflowX, "rolagem horizontal do <main>").toBeLessThanOrEqual(1);
        expect.soft(report.outOfViewport, "elementos fora do viewport").toEqual([]);
        expect.soft(report.regionOverlap, "sobreposição de regiões").toEqual([]);
        expect.soft(report.overlapping, "alvos sobrepostos").toEqual([]);
        expect.soft(report.smallTargets, "alvos < 24px (WCAG 2.5.8)").toEqual([]);
        expect.soft(report.tinyText, "texto < 12px").toEqual([]);
        expect.soft(report.dialogIssues, "modal não cabe na tela").toEqual([]);

        const xss = await expectNoXss(page);
        expect(xss.executed, "marcador XSS executou").toBeUndefined();
        expect(xss.injectedImgs, "<img src=x> injetado no DOM").toBe(0);
      });
    }

    test("menu de navegação funcional", async ({ page }) => {
      await installMocks(page, { role: "ADM" });
      await seedSession(page, { role: "ADM" });
      await page.goto("/");
      await waitForHydration(page);
      await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();

      const trigger = page.getByRole("button", { name: "Abrir menu de navegação" });
      const desktopNav = page.getByRole("navigation", { name: "Navegação principal", exact: true });

      if (viewport.width < LG) {
        await expect(desktopNav).toBeHidden();
        await expect(trigger).toBeVisible();
        await trigger.click();
        const drawer = page.getByRole("dialog", { name: "SISPAT-AGU" });
        await expect(drawer).toBeVisible();
        await drawer.getByRole("button", { name: "Administração" }).click();
        await drawer.getByRole("link", { name: "Usuários" }).click();
        await expect(page).toHaveURL(/\/administracao\/usuarios$/, { timeout: FIRST_COMPILE_TIMEOUT });
        await expect(drawer).toBeHidden();
        await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
      } else {
        await expect(trigger).toBeHidden();
        await expect(desktopNav).toBeVisible();
        await desktopNav.getByRole("button", { name: "Administração" }).click();
        await desktopNav.getByRole("link", { name: "Usuários" }).click();
        await expect(page).toHaveURL(/\/administracao\/usuarios$/, { timeout: FIRST_COMPILE_TIMEOUT });
        await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
      }
    });
  });
}
