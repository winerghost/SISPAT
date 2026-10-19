import { expect, test, type Page } from "@playwright/test";

import {
  defaultAlerts,
  installMocks,
  seedSession,
  waitForHydration,
  XSS_IMG,
  type AlertsMock,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Widget "Alertas patrimoniais" (Etapa 4a). Contrato mockado:
// GET /api/v1/dashboard/alerts. Cobre números exatos do backend, severidade
// com texto, texto puro (sem HTML), validação por allowlist e estados.
// (axe + 320–1920px: telas dashboard* em support/screens.ts.)
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

async function openHome(page: Page, opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto("/");
  await waitForHydration(page);
  return state;
}

const widget = (page: Page) => page.locator("[data-alerts-widget]");

test("mostra os números exatamente como o backend e a severidade em texto", async ({ page }) => {
  await openHome(page);
  const w = widget(page);
  await expect(w.getByRole("heading", { level: 2, name: "Alertas patrimoniais" })).toBeVisible();
  const items = w.locator("li[data-severity]");
  await expect(items).toHaveCount(3);
  // Críticos primeiro; contagens sem formatação/arredondamento.
  await expect(items.nth(0)).toContainText("Crítico");
  await expect(items.nth(0).locator("[data-alert-count]")).toHaveText("7");
  await expect(items.nth(1)).toContainText("Atenção");
  await expect(items.nth(1).locator("[data-alert-count]")).toHaveText("1234");
  await expect(items.nth(2)).toContainText("Informação");
  await expect(items.nth(2).locator("[data-alert-count]")).toHaveText("0");
  await expect(w).not.toContainText(/\bIA\b|inteligência artificial/i);
});

test("texto do backend é puro: HTML não vira elemento", async ({ page }) => {
  const alerts = defaultAlerts();
  alerts.items[0]!.title = `Título ${XSS_IMG}`;
  alerts.items[0]!.description = "**negrito** <b>tag</b>";
  await openHome(page, { role: "USER", alerts });
  const w = widget(page);
  await expect(w.getByText(`Título ${XSS_IMG}`)).toBeVisible();
  await expect(w.getByText("**negrito** <b>tag</b>")).toBeVisible();
  expect(await w.locator("img, b, strong").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("estado vazio: Nenhum alerta", async ({ page }) => {
  await openHome(page, { role: "USER", alerts: { generated_at: "2026-10-15T15:00:00Z", items: [], unavailable: [] } });
  await expect(widget(page).getByText("Nenhum alerta", { exact: true })).toBeVisible();
  await expect(widget(page).locator("[data-alerts-partial]")).toHaveCount(0);
});

test("estado parcial: lista o que está indisponível sem afirmar que está tudo certo", async ({ page }) => {
  await openHome(page, {
    role: "USER",
    alerts: { generated_at: "2026-10-15T15:00:00Z", items: [], unavailable: ["sheets_conflicts"] },
  });
  await expect(widget(page).locator("[data-alerts-partial]")).toContainText("sheets_conflicts");
  await expect(widget(page)).toContainText("não é possível afirmar que está tudo em ordem");
});

test("erro 500: mensagem neutra, sem detalhe do backend, e nova tentativa funciona", async ({ page }) => {
  const state = await openHome(page, { role: "USER", alertsStatus: 500 });
  const retry = widget(page).getByRole("button", { name: "Tentar novamente" });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(widget(page)).not.toContainText("SISPAT_BACKEND_MSG");
  state.alertsStatus = null;
  await retry.click();
  await expect(widget(page).locator("li[data-severity]")).toHaveCount(3);
});

test("resposta fora da allowlist é rejeitada (estado de erro)", async ({ page }) => {
  const alerts = defaultAlerts();
  (alerts.items[0] as { severity: string }).severity = "catastrophic";
  await openHome(page, { role: "USER", alerts: alerts as AlertsMock });
  await expect(widget(page).getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
  await expect(widget(page).locator("li[data-severity]")).toHaveCount(0);
});
