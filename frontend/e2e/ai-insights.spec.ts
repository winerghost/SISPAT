import { expect, test, type Page } from "@playwright/test";

import {
  defaultAiInsights,
  installMocks,
  seedSession,
  waitForHydration,
  XSS_IMG,
  type AiInsightsMock,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Widgets de IA na Home (Etapa 4b). Contrato mockado: GET /api/v1/ai/insights e
// POST /api/v1/ai/ask. Cobre estados ok/unavailable/erro/429/403, texto puro
// (HTML/markdown nunca vira elemento) e envio vazio/duplo/limite de tamanho.
// (axe + 320–1920px: telas dashboard-ia* em support/screens.ts.)
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

async function openHome(page: Page, opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto("/");
  await waitForHydration(page);
  return state;
}

const insights = (page: Page) => page.locator("[data-ai-insights-widget]");
const ask = (page: Page) => page.locator("[data-ask-sispat]");
const askCalls = (state: MockState) => state.calls.filter((c) => c.method === "POST" && c.url === "/api/v1/ai/ask");

test("status ok: seções por tipo, aviso de IA e texto preservado em quebras de linha", async ({ page }) => {
  await openHome(page);
  const w = insights(page);
  await expect(w.getByRole("heading", { level: 2, name: "Insights de IA" })).toBeVisible();
  await expect(w.locator("[data-insight-kind]")).toHaveCount(3);
  await expect(w.getByRole("heading", { level: 3, name: "Prioridade dos alertas" })).toBeVisible();
  await expect(w.getByRole("heading", { level: 3, name: "Resumo executivo" })).toBeVisible();
  await expect(w.getByRole("heading", { level: 3, name: "Sugestões de qualidade de dados" })).toBeVisible();
  await expect(w.getByText("Gerado por IA — pode conter erros")).toBeVisible();
  await expect(ask(page).getByText("Gerado por IA — pode conter erros")).toBeVisible();
  await expect(w.getByText("Resolva primeiro", { exact: false })).toHaveCSS("white-space", "pre-wrap");
  // Os alertas seguem funcionando ao lado.
  await expect(page.locator("[data-alerts-widget] li[data-severity]")).toHaveCount(3);
});

test("payload com HTML/markdown é renderizado como texto, sem links nem elementos", async ({ page }) => {
  const payload: AiInsightsMock = {
    ...defaultAiInsights(),
    items: [
      {
        kind: "executive_summary",
        title: `Título ${XSS_IMG}`,
        text: "**negrito** [link](https://evil.example) <a href=\"https://evil.example\">x</a> <script>window.__xss=3</script>",
      },
    ],
  };
  await openHome(page, { role: "USER", aiInsights: payload, aiAsk: { status: "ok", answer: `<b>oi</b> ${XSS_IMG}\n# h1`, tools_used: ["<i>x</i>"] } });
  const w = insights(page);
  await expect(w.getByText(`Título ${XSS_IMG}`)).toBeVisible();
  await expect(w.getByText("**negrito** [link](https://evil.example)", { exact: false })).toBeVisible();
  expect(await w.locator("img, b, strong, a, script").count()).toBe(0);

  await ask(page).getByLabel("Sua pergunta").fill("pergunta");
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  // tools_used fora do padrão invalida a resposta (allowlist) -> erro neutro, nada renderizado como HTML.
  await expect(ask(page).locator("[data-ask-error]")).toBeVisible();
  expect(await ask(page).locator("img, b, strong, a, i").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("resposta da pergunta com HTML/markdown vira texto puro", async ({ page }) => {
  await openHome(page, {
    role: "USER",
    aiAsk: { status: "ok", answer: `<b>oi</b> ${XSS_IMG}\n# título [x](https://evil.example)`, tools_used: [] },
  });
  await ask(page).getByLabel("Sua pergunta").fill("pergunta");
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  const answer = ask(page).locator("[data-ask-answer]");
  await expect(answer).toContainText("<b>oi</b>");
  await expect(answer).toContainText("# título [x](https://evil.example)");
  expect(await answer.locator("img, b, strong, a, h1").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("status unavailable: estado neutro, alertas e Home normais", async ({ page }) => {
  await openHome(page, { role: "USER", aiInsights: { status: "unavailable", generated_at: null, items: [] } });
  await expect(insights(page).getByText("Insights de IA indisponíveis")).toBeVisible();
  await expect(page.locator("[data-alerts-widget] li[data-severity]")).toHaveCount(3);
  await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
});

test("erro 500 nos insights: estado neutro sem detalhe do backend", async ({ page }) => {
  await openHome(page, { role: "USER", aiInsightsStatus: 500 });
  await expect(insights(page).locator("[data-ai-unavailable]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).not.toContainText("SISPAT_BACKEND_MSG");
  await expect(page.locator("[data-alerts-widget] li[data-severity]")).toHaveCount(3);
});

test("resposta de insights fora da allowlist cai no estado neutro", async ({ page }) => {
  const bad = defaultAiInsights();
  (bad.items[0] as { kind: string }).kind = "desconhecido";
  await openHome(page, { role: "USER", aiInsights: bad });
  await expect(insights(page).locator("[data-ai-unavailable]")).toBeVisible({ timeout: 15_000 });
});

test("pergunta: ok mostra resposta, tools_used discreto e não persiste nada no navegador", async ({ page }) => {
  const state = await openHome(page);
  const box = ask(page);
  await box.getByLabel("Sua pergunta").fill("  Quantos bens sem responsável?  ");
  await box.getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(box.locator("[data-ask-answer]")).toContainText("Existem 1234 bens sem responsável.");
  await expect(box.locator("[data-ask-tools]")).toContainText("não verificadas");
  expect(askCalls(state)).toHaveLength(1);
  expect(askCalls(state)[0]!.body).toEqual({ question: "Quantos bens sem responsável?" });
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain("Quantos bens");
  expect(stored).not.toContain("1234 bens");
});

test("pergunta: unavailable mostra estado neutro", async ({ page }) => {
  await openHome(page, { role: "USER", aiAsk: { status: "unavailable" } });
  await ask(page).getByLabel("Sua pergunta").fill("pergunta");
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(ask(page).locator("[data-ask-unavailable]")).toContainText("Insights de IA indisponíveis");
});

test("pergunta: 429 mostra limite atingido", async ({ page }) => {
  await openHome(page, { role: "USER", aiAskStatus: 429 });
  await ask(page).getByLabel("Sua pergunta").fill("pergunta");
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(ask(page).getByRole("alert")).toContainText("Limite atingido, tente mais tarde");
});

test("pergunta: erro 500 mostra mensagem neutra e permite reenviar", async ({ page }) => {
  const state = await openHome(page, { role: "USER", aiAskStatus: 500 });
  await ask(page).getByLabel("Sua pergunta").fill("pergunta");
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(ask(page).locator("[data-ask-error]")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("SISPAT_BACKEND_MSG");
  state.aiAskStatus = null;
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(ask(page).locator("[data-ask-answer]")).toBeVisible();
});

test("pergunta: 403 esconde a caixa sem erro", async ({ page }) => {
  await openHome(page, { role: "RH", aiAskStatus: 403 });
  await ask(page).getByLabel("Sua pergunta").fill("pergunta");
  await ask(page).getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(ask(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("insights 403 também esconde a caixa; widget de insights fica neutro", async ({ page }) => {
  await openHome(page, { role: "RH", aiInsightsStatus: 403 });
  await expect(insights(page).locator("[data-ai-unavailable]")).toBeVisible({ timeout: 15_000 });
  await expect(ask(page)).toHaveCount(0);
});

test("envio vazio desabilitado, contador, maxLength 500 e sem envio duplo", async ({ page }) => {
  const state = await openHome(page, { role: "USER", aiAskDelayMs: 600 });
  const box = ask(page);
  const send = box.getByRole("button", { name: "Enviar pergunta" });
  const field = box.getByLabel("Sua pergunta");
  await expect(send).toBeDisabled();
  await field.fill("    ");
  await expect(send).toBeDisabled();
  await expect(field).toHaveAttribute("maxlength", "500");
  await field.fill("x".repeat(600));
  await expect(box.locator("[data-ask-counter]")).toHaveText("500/500 caracteres");

  await field.fill("pergunta");
  await send.click();
  await expect(box.getByRole("button", { name: "Enviando…" })).toBeDisabled();
  await expect(field).toBeDisabled();
  await expect(box.locator("[data-ask-answer]")).toBeVisible();
  expect(askCalls(state)).toHaveLength(1);
});
