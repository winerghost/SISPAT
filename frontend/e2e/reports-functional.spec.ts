import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";

// =============================================================================
// /relatorios — relatórios e exportações (CSV/XLSX).
// Mock sintético de GET /v1/reports e /v1/reports/<kind>/export. A autorização,
// o escopo e o limite de linhas são do BACKEND (simulados no mock); aqui
// validamos o que a interface mostra e envia: formulário gerado do catálogo,
// query em allowlist, download autenticado (Blob), mensagens por status,
// estado de carregamento e overflow/axe.
// O nome do arquivo casa com o projeto "e2e" (testMatch /functional\.spec\.ts/).
// =============================================================================

const PATH = "/relatorios";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.use({ viewport: { width: 1366, height: 768 } });

async function open(page: Page, opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(PATH);
  await waitForHydration(page);
  return state;
}

const reportCalls = (state: MockState) =>
  state.calls.filter((c) => c.url.startsWith("/api/v1/reports")).map((c) => `${c.method} ${c.url}`);
const exportCalls = (state: MockState) => reportCalls(state).filter((c) => c.includes("/export"));

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
}

/** Clica no cartão (o radio nativo fica visualmente oculto; o rótulo é o alvo). */
async function pickReport(page: Page, id: string) {
  await page.locator(`label[for=rel-card-${id}]`).click();
  await expect(page.locator(`#rel-card-${id}`)).toBeChecked();
}

const form = (page: Page) => page.getByTestId("report-form");
const outcome = (page: Page) => page.getByTestId("report-outcome");
const exportButton = (page: Page, format = "CSV") => page.getByRole("button", { name: new RegExp(`^(Exportar|Gerando) ${format}`) });

test.describe("catálogo e formulário", () => {
  test("USER: cards por relatório, filtros gerados do catálogo, sem switch de excluídos", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();
    const group = page.getByRole("radiogroup", { name: "Escolha o relatório" });
    await expect(group.getByRole("radio")).toHaveCount(3);
    await expect(group.getByRole("radio", { name: /Patrimônios/ })).toBeChecked();
    for (const label of ["Busca (número ou descrição)", "Unidade", "Unidade proprietária", "Localizado", "Vínculo"]) {
      await expect(form(page).getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(form(page).getByLabel("Ordenar por")).toHaveValue("patrimony_number");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Colunas incluídas no arquivo" }).getByText("Observações")).toBeVisible();
    // Só leitura de catálogo e de unidades; nenhuma exportação sem clique.
    expect(reportCalls(state)).toEqual(["GET /api/v1/reports"]);
    expect(state.calls.some((c) => c.url.includes("/v1/units/accessible"))).toBe(true);
    expect(state.calls.some((c) => c.url.includes("/v1/inventories"))).toBe(false);
  });

  test("ADM mostra 'Incluir registros excluídos'; RH não recebe a coluna de texto livre", async ({ page }) => {
    await open(page, { role: "ADM" });
    await expect(page.getByRole("switch", { name: "Incluir registros excluídos" })).toBeVisible();
  });

  test("RH: colunas sem Observações e sem switch", async ({ page }) => {
    await open(page, { role: "RH" });
    const columns = page.getByRole("list", { name: "Colunas incluídas no arquivo" });
    await expect(columns.getByText("Nº patrimonial")).toBeVisible();
    await expect(columns.getByText("Observações")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("trocar de relatório recria os filtros (datas, tipo, inventário)", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    await pickReport(page, "movements");
    await expect(form(page).getByLabel("Solicitada a partir de")).toHaveAttribute("type", "date");
    await expect(form(page).getByLabel("Tipo de movimentação").locator("option")).toHaveCount(4);
    await expect(form(page).getByLabel("Ordenar por")).toHaveValue("-created_at");
    await pickReport(page, "inventory-items");
    const inventory = form(page).getByLabel("Inventário", { exact: true });
    await expect(inventory.locator("option")).not.toHaveCount(1);
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/inventories"))).toBe(true);
  });

  test("inventários indisponíveis para o perfil: aviso e seletor desabilitado (RH)", async ({ page }) => {
    await open(page, { role: "RH" });
    await pickReport(page, "inventory-items");
    await expect(form(page).getByText(/Lista de inventários indisponível/)).toBeVisible();
    await expect(form(page).getByLabel("Inventário", { exact: true })).toBeDisabled();
  });

  test("unidades do escopo alimentam o seletor", async ({ page }) => {
    await open(page);
    const unit = form(page).getByLabel("Unidade", { exact: true });
    await expect(unit.locator("option")).toHaveCount(5);
    await expect(unit.locator("option").nth(1)).toContainText("—");
  });
});

test.describe("exportação", () => {
  test("CSV: Bearer, query em allowlist, arquivo nomeado no cliente e contagem", async ({ page }) => {
    const state = await open(page);
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^sispat-assets-\d{8}T\d{6}Z\.csv$/);
    await expect(outcome(page)).toContainText("3 registro(s)");
    expect(exportCalls(state)).toEqual(["GET /api/v1/reports/assets/export?format=csv&sort=patrimony_number"]);
    const joined = state.calls.map((c) => c.url).join(" ");
    expect(joined).not.toMatch(/token|apikey|access_token/i);
    // O Blob não contém o texto do backend como HTML nem é renderizado na página.
    await expect(page.locator("a[download]")).toHaveCount(0);
  });

  test("filtros preenchidos e XLSX seguem para a query; vazios são omitidos", async ({ page }) => {
    const state = await open(page);
    await form(page).getByLabel("Busca (número ou descrição)").fill("  cadeira   azul ");
    await form(page).getByLabel("Localizado").selectOption("SIM");
    await form(page).getByLabel("Ordenar por").selectOption("-created_at");
    await page.locator("label[for=rel-formato-xlsx]").click();
    await expect(exportButton(page, "XLSX")).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page, "XLSX").click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/\.xlsx$/);
    await expect(outcome(page)).toContainText("gerado");
    const [call] = exportCalls(state);
    const params = new URL(call!.replace("GET ", ""), "http://x").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      format: "xlsx",
      sort: "-created_at",
      q: "cadeira azul",
      located: "SIM",
    });
  });

  test("unidade escolhida vai como unit_id e ADM envia include_deleted", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    const unit = form(page).getByLabel("Unidade", { exact: true });
    const value = await unit.locator("option").nth(1).getAttribute("value");
    await unit.selectOption(value!);
    await page.getByRole("switch", { name: "Incluir registros excluídos" }).check();
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    const [call] = exportCalls(state);
    const params = new URL(call!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("unit_id")).toBe(value);
    expect(params.get("include_deleted")).toBe("true");
  });

  test("estado de carregamento: aria-busy, botão e campos desabilitados até o fim", async ({ page }) => {
    await open(page, { role: "USER", reports: { exportDelayMs: 1200 } });
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    const busy = page.getByRole("button", { name: "Gerando CSV…" });
    await expect(busy).toHaveAttribute("aria-busy", "true");
    await expect(busy).toBeDisabled();
    await expect(form(page).getByLabel("Busca (número ou descrição)")).toBeDisabled();
    await downloadPromise;
    await expect(exportButton(page)).not.toHaveAttribute("aria-busy", "true");
  });

  test("resultado vazio: arquivo só com cabeçalho e mensagem própria", async ({ page }) => {
    await open(page);
    await form(page).getByLabel("Busca (número ou descrição)").fill("vazio");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    await expect(outcome(page)).toContainText("Nenhum registro encontrado para estes filtros");
  });
});

test.describe("filtros dos relatórios", () => {
  test("movimentações: tipo, estado e datas vão na query; 'Limpar filtros' zera e omite", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    await pickReport(page, "movements");
    await expect(form(page).getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);

    await form(page).getByLabel("Tipo de movimentação").selectOption({ index: 1 });
    await form(page).getByLabel("Solicitada a partir de").fill("2026-05-01");
    await form(page).getByLabel("Solicitada até").fill("2026-05-31");
    await form(page).getByLabel("Situação", { exact: true }).selectOption("PENDENTE");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    const params = new URL(exportCalls(state)[0]!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("movement_type")).toBeTruthy();
    expect(params.get("status")).toBe("PENDENTE");
    expect(params.get("created_from")).toBe("2026-05-01");
    expect(params.get("created_to")).toBe("2026-05-31");

    await form(page).getByRole("button", { name: "Limpar filtros" }).click();
    await expect(form(page).getByLabel("Solicitada a partir de")).toHaveValue("");
    await expect(form(page).getByLabel("Tipo de movimentação")).toHaveValue("");
    await expect(form(page).getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);
    const again = page.waitForEvent("download");
    await exportButton(page).click();
    await again;
    const cleared = new URL(exportCalls(state)[1]!.replace("GET ", ""), "http://x").searchParams;
    expect([...cleared.keys()].sort()).toEqual(["format", "sort"]);
  });

  test("'Limpar filtros' também remove mensagens de validação", async ({ page }) => {
    const state = await open(page);
    await form(page).getByLabel("Sala (identificador)").fill("nao-e-uuid");
    await exportButton(page).click();
    await expect(form(page).getByText("Informe um identificador (UUID) válido.")).toBeVisible();
    await form(page).getByRole("button", { name: "Limpar filtros" }).click();
    await expect(form(page).getByText("Informe um identificador (UUID) válido.")).toHaveCount(0);
    expect(exportCalls(state)).toEqual([]);
  });

  test("lista de inventários do filtro usa page_size válido (50/100/200)", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    await pickReport(page, "inventory-items");
    await expect(form(page).getByLabel("Inventário", { exact: true }).locator("option")).not.toHaveCount(1);
    const lookups = state.calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/inventories"));
    expect(lookups.length).toBeGreaterThan(0);
    for (const call of lookups) {
      expect(["50", "100", "200"]).toContain(new URL(call.url, "http://x").searchParams.get("page_size"));
    }
  });
});

test.describe("validação de UX e erros", () => {
  test("intervalo de datas invertido bloqueia a exportação, sem chamar a API", async ({ page }) => {
    const state = await open(page);
    await pickReport(page, "movements");
    await form(page).getByLabel("Solicitada a partir de").fill("2026-05-10");
    await form(page).getByLabel("Solicitada até").fill("2026-05-01");
    await exportButton(page).click();
    await expect(form(page).getByText("A data final não pode ser anterior à inicial.")).toBeVisible();
    await expect(form(page).getByLabel("Solicitada até")).toBeFocused();
    expect(exportCalls(state)).toEqual([]);
  });

  test("UUID inválido em sala é recusado no cliente", async ({ page }) => {
    const state = await open(page);
    await form(page).getByLabel("Sala (identificador)").fill("nao-e-uuid");
    await exportButton(page).click();
    await expect(form(page).getByText("Informe um identificador (UUID) válido.")).toBeVisible();
    expect(exportCalls(state)).toEqual([]);
  });

  test("413: pede para refinar os filtros", async ({ page }) => {
    await open(page);
    await form(page).getByLabel("Busca (número ou descrição)").fill("limite");
    await exportButton(page).click();
    await expect(outcome(page)).toContainText("Refine os filtros");
    await expect(outcome(page)).toContainText("10.000");
    await expect(outcome(page)).not.toContainText("detalhe interno sintético");
  });

  test("429: mostra o tempo de espera do Retry-After", async ({ page }) => {
    await open(page, { role: "USER", reports: { exportStatus: 429, retryAfter: 90 } });
    await exportButton(page).click();
    await expect(outcome(page)).toContainText("Aguarde 2 minutos");
  });

  test("403 e 500 têm mensagens próprias, sem eco do backend", async ({ page }) => {
    const state = await open(page);
    state.reports.exportStatus = 403;
    await exportButton(page).click();
    await expect(outcome(page)).toContainText("não tem permissão");
    state.reports.exportStatus = 500;
    await exportButton(page).click();
    await expect(outcome(page)).toContainText("Não foi possível gerar o arquivo");
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
    await expect(exportButton(page)).toBeEnabled();
  });

  test("catálogo com erro: 'Tentar novamente' recupera", async ({ page }) => {
    const state = await open(page, { role: "USER", reports: { catalogStatus: 500 } });
    await expect(page.getByText("Não foi possível carregar os relatórios. Tente novamente.")).toBeVisible({ timeout: 15_000 });
    state.reports.catalogStatus = null;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByTestId("report-form")).toBeVisible();
  });

  test("ADM sem MFA (AAL2_REQUIRED): acesso restrito com orientação", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    const panel = page.getByTestId("access-restricted");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("verificação em duas etapas");
  });
});

test.describe("responsivo e acessibilidade", () => {
  for (const width of [320, 768, 1280, 1920]) {
    test(`${width}px: sem overflow horizontal e sem violações axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await open(page, { role: "ADM" });
      await expect(page.getByTestId("report-form")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test("item destacado no menu e navegação por teclado nos cards", async ({ page }) => {
    await open(page);
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    await expect(nav.locator(`a[href="${PATH}"]`)).toHaveAttribute("aria-current", "page");
    await page.getByRole("radio", { name: /Patrimônios/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: /Movimentações/ })).toBeChecked();
  });
});
