import { expect, test } from "@playwright/test";

import { installMocks, seedSession, waitForHydration } from "./support/mocks";

// Busca global do topo (desktop): Enter abre a lista de patrimônios com o termo
// normalizado em `?busca=`. Vazio/só espaços não navega; limite de 100.
test.use({ viewport: { width: 1366, height: 768 } });

test.describe("busca global do header", () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/dashboard");
    await waitForHydration(page);
  });

  test("Enter navega para patrimônios com o termo aparado; vazio não navega", async ({ page }) => {
    const search = page.getByRole("search").getByLabel("Busca global");
    await expect(search).toHaveAttribute("maxlength", "100");

    await search.fill("    ");
    await search.press("Enter");
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/dashboard");

    await search.fill("   cadeira   giratória ");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/patrimonios\?busca=cadeira%20girat%C3%B3ria$/);
  });
});
