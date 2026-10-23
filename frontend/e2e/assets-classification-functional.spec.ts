import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

import { ASSET_IDS, type AssetMock } from "./support/asset-mocks";
import { API_URL, installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";

// =============================================================================
// Patrimônios — edição manual da classificação (categoria, tipo de TI e
// situação operacional). Mocks sintéticos; a autoridade (allowlist, escopo,
// version, consistência tipo x categoria) é do backend e está simulada no mock.
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

async function open(page: Page, opts: MockOptions = { role: "USER" }, prepare?: (s: MockState) => void) {
  const state = await installMocks(page, opts);
  prepare?.(state);
  await seedSession(page, opts);
  await page.goto("/patrimonios");
  await waitForHydration(page);
  return state;
}

function waitPatch(page: Page, id: string): Promise<Request> {
  return page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().startsWith(API_URL) && new URL(r.url()).pathname.endsWith(id),
  );
}

async function openEdit(page: Page, number = "000123") {
  await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
  await page.getByRole("button", { name: `Ver detalhes do patrimônio ${number}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(`Patrimônio ${number}`) });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Editar" }).click();
  const dialog = page.getByRole("dialog", { name: "Editar bem" });
  await expect(dialog).toBeVisible();
  return { sheet, dialog };
}

const asset = (state: MockState, id: string): AssetMock => state.assets.find((a) => a.id === id)!;

test.describe("patrimônios — classificação manual", () => {
  test("selects com 'Não informado'; tipo de TI só habilita em Tecnologia; PATCH só com os campos alterados", async ({ page }) => {
    const state = await open(page);
    const { sheet, dialog } = await openEdit(page);
    const category = dialog.getByLabel("Categoria");
    const tech = dialog.getByLabel("Tipo de TI");
    const status = dialog.getByLabel("Situação operacional");
    await expect(category).toHaveValue("");
    await expect(category.locator("option").first()).toHaveText("Não informado");
    await expect(tech).toBeDisabled();
    await expect(dialog.getByText("Disponível só para a categoria Tecnologia.")).toBeVisible();

    await category.selectOption("TECNOLOGIA");
    await expect(tech).toBeEnabled();
    await tech.selectOption("NOTEBOOK");
    await status.selectOption("EM_USO");
    const request = waitPatch(page, ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({
      version: 3,
      asset_category: "TECNOLOGIA",
      tech_type: "NOTEBOOK",
      operational_status: "EM_USO",
    });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText("Notebook")).toBeVisible();
    await expect(sheet.getByText("Em uso")).toBeVisible();
    expect(asset(state, ASSET_IDS.long).tech_type).toBe("NOTEBOOK");
  });

  test("trocar para categoria não-TI limpa o tipo (envia null) e 'Não informado' limpa a situação", async ({ page }) => {
    const state = await open(page, { role: "USER" }, (s) => {
      Object.assign(asset(s, ASSET_IDS.long), {
        asset_category: "TECNOLOGIA",
        tech_type: "MONITOR",
        operational_status: "ESTOQUE",
      });
    });
    const { dialog } = await openEdit(page);
    await expect(dialog.getByLabel("Tipo de TI")).toHaveValue("MONITOR");
    await dialog.getByLabel("Categoria").selectOption("MOBILIARIO");
    await expect(dialog.getByLabel("Tipo de TI")).toBeDisabled();
    await dialog.getByLabel("Situação operacional").selectOption("");
    const request = waitPatch(page, ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({
      version: 3,
      asset_category: "MOBILIARIO",
      tech_type: null,
      operational_status: null,
    });
    await expect(dialog).toBeHidden();
    expect(asset(state, ASSET_IDS.long).operational_status).toBeNull();
  });

  test("ADM também edita; histórico mostra 'Classificação atualizada' com rótulos em português", async ({ page }) => {
    await open(page, { role: "ADM" });
    const { sheet, dialog } = await openEdit(page);
    await dialog.getByLabel("Situação operacional").selectOption("MANUTENCAO");
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    await expect(dialog).toBeHidden();
    await sheet.getByRole("tab", { name: "Histórico" }).click();
    await expect(sheet.getByText("Classificação atualizada")).toBeVisible();
    await expect(sheet.getByText("Situação operacional: Não informado → Em manutenção")).toBeVisible();
  });

  test("RH: sem botão de editar e sem selects de classificação (somente leitura)", async ({ page }) => {
    await open(page, { role: "RH" });
    await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
    await page.getByRole("button", { name: "Ver detalhes do patrimônio 000123", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /Patrimônio 000123/ });
    await expect(sheet.getByText("Categoria")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Editar" })).toHaveCount(0);
    await expect(page.getByLabel("Categoria")).toHaveCount(0);
  });

  for (const [status, code, text] of [
    [422, "classification_inconsistent", "O tipo de TI só vale para a categoria Tecnologia."],
    [403, "forbidden", "Você não tem permissão para esta ação."],
    [409, "version_conflict", "Outra pessoa alterou este bem enquanto você editava."],
  ] as const) {
    test(`erro ${status}: mensagem fixa em português, nunca a do backend`, async ({ page }) => {
      await open(page, { role: "USER" }, (s) => {
        s.forceWriteError = { status, code };
      });
      const { dialog } = await openEdit(page);
      await dialog.getByLabel("Situação operacional").selectOption("BAIXADO");
      await dialog.getByRole("button", { name: "Salvar bem" }).click();
      await expect(dialog.getByText(text).first()).toBeVisible();
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    });
  }

  test("axe WCAG 2.2 AA com o formulário aberto e sem rolagem horizontal a 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await open(page);
    const { dialog } = await openEdit(page);
    await dialog.getByLabel("Categoria").selectOption("TECNOLOGIA");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("nextjs-portal")
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
