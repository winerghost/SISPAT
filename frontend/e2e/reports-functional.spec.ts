import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { PERSON_IDS, ROOM_IDS } from "./support/catalog-mocks";
import { installMocks, seedSession, UNITS, waitForHydration, type MockOptions, type MockState } from "./support/mocks";

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

const columnsGroup = (page: Page) => page.getByRole("group", { name: "Colunas do arquivo" });
const col = (page: Page, name: string) => columnsGroup(page).getByRole("checkbox", { name, exact: true });
/** Alterna pelo rótulo (o input nativo é sr-only; o rótulo é o alvo de clique). */
async function setCol(page: Page, name: string, on: boolean) {
  if ((await col(page, name).isChecked()) !== on) await columnsGroup(page).locator("label", { hasText: name }).first().click();
  if (on) await expect(col(page, name)).toBeChecked();
  else await expect(col(page, name)).not.toBeChecked();
}
const columnsOf = (call: string) => new URL(call.replace("GET ", ""), "http://x").searchParams.get("columns");
const filters = (page: Page) => page.getByRole("group", { name: "Filtros" });
const lookupField = (page: Page, label: string) => filters(page).getByLabel(label, { exact: true });
const optionTexts = (page: Page, label: string) => lookupField(page, label).locator("option").allInnerTexts();
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
    for (const label of [
      "Busca (número ou descrição)",
      "Unidade",
      "Unidade proprietária",
      "Sala",
      "Responsável",
      "Localizado",
      "Vínculo",
    ]) {
      await expect(filters(page).getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(form(page).getByLabel("Ordenar por")).toHaveValue("patrimony_number");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(columnsGroup(page).getByRole("checkbox", { name: "Observações" })).toBeChecked();
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
    const columns = columnsGroup(page);
    await expect(columns.getByRole("checkbox", { name: "Nº patrimonial" })).toBeChecked();
    await expect(columns.getByRole("checkbox", { name: "Observações" })).toHaveCount(0);
    await expect(page.getByTestId("column-count")).toHaveText("6 de 6 selecionadas");
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("trocar de relatório recria os filtros (datas, tipo, inventário)", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    await pickReport(page, "movements");
    await expect(filters(page).getByLabel("Solicitada a partir de")).toHaveAttribute("type", "date");
    await expect(filters(page).getByLabel("Tipo de movimentação").locator("option")).toHaveCount(4);
    await expect(form(page).getByLabel("Ordenar por")).toHaveValue("-created_at");
    await pickReport(page, "inventory-items");
    const inventory = filters(page).getByLabel("Inventário", { exact: true });
    await expect(inventory.locator("option")).not.toHaveCount(1);
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/inventories"))).toBe(true);
  });

  test("inventários indisponíveis para o perfil: aviso e seletor desabilitado (RH)", async ({ page }) => {
    await open(page, { role: "RH" });
    await pickReport(page, "inventory-items");
    await expect(form(page).getByText(/Lista de inventários indisponível/)).toBeVisible();
    await expect(filters(page).getByLabel("Inventário", { exact: true })).toBeDisabled();
  });

  test("unidades do escopo alimentam o seletor", async ({ page }) => {
    await open(page);
    const unit = filters(page).getByLabel("Unidade", { exact: true });
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
    await filters(page).getByLabel("Busca (número ou descrição)").fill("  cadeira   azul ");
    await filters(page).getByLabel("Localizado").selectOption("SIM");
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
    const unit = filters(page).getByLabel("Unidade", { exact: true });
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
    await expect(filters(page).getByLabel("Busca (número ou descrição)")).toBeDisabled();
    await downloadPromise;
    await expect(exportButton(page)).not.toHaveAttribute("aria-busy", "true");
  });

  test("resultado vazio: arquivo só com cabeçalho e mensagem própria", async ({ page }) => {
    await open(page);
    await filters(page).getByLabel("Busca (número ou descrição)").fill("vazio");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    await expect(outcome(page)).toContainText("Nenhum registro encontrado para estes filtros");
  });
});

test.describe("seleção de colunas", () => {
  test("todas marcadas por padrão, contador e ordem do catálogo; exportar tudo omite 'columns'", async ({ page }) => {
    const state = await open(page);
    await expect(columnsGroup(page).getByRole("checkbox")).toHaveCount(7);
    await expect(columnsGroup(page).getByRole("checkbox").first()).toBeChecked();
    await expect(page.getByTestId("column-count")).toHaveText("7 de 7 selecionadas");
    await expect(columnsGroup(page).getByRole("button", { name: "Marcar todas" })).toBeDisabled();
    const labels = await columnsGroup(page).locator("label").allInnerTexts();
    expect(labels.map((l) => l.trim())).toEqual([
      "Nº patrimonial",
      "Descrição",
      "Vínculo",
      "Unidade (código)",
      "Responsável",
      "Criado em (UTC)",
      "Observações",
    ]);
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    expect(columnsOf(exportCalls(state)[0]!)).toBeNull();
  });

  test("poucas colunas (CSV): query ordenada pelo catálogo", async ({ page }) => {
    const state = await open(page);
    await columnsGroup(page).getByRole("button", { name: "Limpar" }).click();
    await setCol(page, "Observações", true);
    await setCol(page, "Nº patrimonial", true);
    await expect(page.getByTestId("column-count")).toHaveText("2 de 7 selecionadas");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    const download = await downloadPromise;
    expect(columnsOf(exportCalls(state)[0]!)).toBe("patrimony_number,notes");
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    await expect(outcome(page)).toContainText("3 registro(s)");
  });

  test("várias colunas e mudança de seleção antes de exportar; XLSX leva 'columns'", async ({ page }) => {
    const state = await open(page);
    await setCol(page, "Descrição", false);
    await setCol(page, "Responsável", false);
    await setCol(page, "Observações", false);
    await setCol(page, "Responsável", true);
    await expect(page.getByTestId("column-count")).toHaveText("5 de 7 selecionadas");
    await page.locator("label[for=rel-formato-xlsx]").click();
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page, "XLSX").click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/\.xlsx$/);
    expect(columnsOf(exportCalls(state)[0]!)).toBe("patrimony_number,bond_status,unit_code,responsible,created_at");
    await columnsGroup(page).getByRole("button", { name: "Marcar todas" }).click();
    const again = page.waitForEvent("download");
    await exportButton(page, "XLSX").click();
    await again;
    expect(columnsOf(exportCalls(state)[1]!)).toBeNull();
  });

  test("0 colunas: Exportar desabilitado, aviso em região viva, sem chamada", async ({ page }) => {
    const state = await open(page);
    await columnsGroup(page).getByRole("button", { name: "Limpar" }).click();
    await expect(exportButton(page)).toBeDisabled();
    await expect(page.getByTestId("column-warning")).toHaveText("Selecione ao menos uma coluna para exportar.");
    await expect(page.locator("[aria-live=polite]:has([data-testid=column-warning])")).toHaveCount(1);
    await setCol(page, "Descrição", true);
    await expect(exportButton(page)).toBeEnabled();
    await expect(page.getByTestId("column-warning")).toHaveCount(0);
    expect(exportCalls(state)).toEqual([]);
  });

  test("trocar de relatório e voltar restaura 'todas'; teclado alterna a coluna", async ({ page }) => {
    await open(page);
    await col(page, "Descrição").focus();
    await page.keyboard.press("Space");
    await expect(col(page, "Descrição")).not.toBeChecked();
    await pickReport(page, "movements");
    await expect(columnsGroup(page).getByRole("checkbox")).toHaveCount(5);
    await expect(page.getByTestId("column-count")).toHaveText("5 de 5 selecionadas");
    await pickReport(page, "assets");
    await expect(page.getByTestId("column-count")).toHaveText("7 de 7 selecionadas");
  });

  test("400 invalid_columns do backend: mensagem clara", async ({ page }) => {
    const state = await open(page);
    await setCol(page, "Descrição", false);
    // Coluna que o catálogo não conhece não é enviável pela UI; simula o backend recusando.
    await page.route("**/api/v1/reports/assets/export**", (route) =>
      route.fulfill({
        status: 400,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: { code: "invalid_columns", message: "interno" } }),
      }),
    );
    await exportButton(page).click();
    await expect(outcome(page)).toContainText("colunas escolhidas não foram aceitas");
    await expect(page.getByText("interno", { exact: true })).toHaveCount(0);
    expect(exportCalls(state).length).toBeLessThanOrEqual(1);
  });

  test("320px: seleção de colunas sem overflow e sem violações axe", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page, { role: "ADM" });
    await columnsGroup(page).getByRole("button", { name: "Limpar" }).click();
    await expectNoHorizontalOverflow(page);
    expect(await axeViolations(page)).toEqual([]);
    await columnsGroup(page).getByRole("button", { name: "Marcar todas" }).click();
    await expectNoHorizontalOverflow(page);
    expect(await axeViolations(page)).toEqual([]);
  });
});

test.describe("filtros dos relatórios", () => {
  test("movimentações: tipo, estado e datas vão na query; 'Limpar filtros' zera e omite", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    await pickReport(page, "movements");
    await expect(form(page).getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);

    await filters(page).getByLabel("Tipo de movimentação").selectOption({ index: 1 });
    await filters(page).getByLabel("Solicitada a partir de").fill("2026-05-01");
    await filters(page).getByLabel("Solicitada até").fill("2026-05-31");
    await filters(page).getByLabel("Situação", { exact: true }).selectOption("PENDENTE");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    const params = new URL(exportCalls(state)[0]!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("movement_type")).toBeTruthy();
    expect(params.get("status")).toBe("PENDENTE");
    expect(params.get("created_from")).toBe("2026-05-01");
    expect(params.get("created_to")).toBe("2026-05-31");

    await form(page).getByRole("button", { name: "Limpar filtros" }).click();
    await expect(filters(page).getByLabel("Solicitada a partir de")).toHaveValue("");
    await expect(filters(page).getByLabel("Tipo de movimentação")).toHaveValue("");
    await expect(form(page).getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);
    const again = page.waitForEvent("download");
    await exportButton(page).click();
    await again;
    const cleared = new URL(exportCalls(state)[1]!.replace("GET ", ""), "http://x").searchParams;
    expect([...cleared.keys()].sort()).toEqual(["format", "sort"]);
  });

  test("'Limpar filtros' também remove mensagens de validação", async ({ page }) => {
    const state = await open(page);
    await pickReport(page, "movements");
    await filters(page).getByLabel("Solicitada a partir de").fill("2026-05-10");
    await filters(page).getByLabel("Solicitada até").fill("2026-05-01");
    await exportButton(page).click();
    await expect(form(page).getByText("A data final não pode ser anterior à inicial.")).toBeVisible();
    await form(page).getByRole("button", { name: "Limpar filtros" }).click();
    await expect(form(page).getByText("A data final não pode ser anterior à inicial.")).toHaveCount(0);
    expect(exportCalls(state)).toEqual([]);
  });

  test("lista de inventários do filtro usa page_size válido (50/100/200)", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    await pickReport(page, "inventory-items");
    await expect(filters(page).getByLabel("Inventário", { exact: true }).locator("option")).not.toHaveCount(1);
    const lookups = state.calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/inventories"));
    expect(lookups.length).toBeGreaterThan(0);
    for (const call of lookups) {
      expect(["50", "100", "200"]).toContain(new URL(call.url, "http://x").searchParams.get("page_size"));
    }
  });
});

test.describe("filtros de sala, responsável e vínculo", () => {
  // Contrato: o catálogo declara `room`/`person` (listas carregadas de
  // `/v1/rooms` e `/v1/responsible-people`) e manda as opções de `bond_status`
  // (valores existentes no escopo + a sentinela `__none__`). O escopo de
  // unidade e o que entra em cada lista são decididos pelo BACKEND.
  test("os três filtros são selects alimentados pelo backend, sem digitar UUID", async ({ page }) => {
    const state = await open(page);
    for (const label of ["Sala", "Responsável", "Vínculo"]) {
      await expect(lookupField(page, label)).toBeEnabled();
      expect(await lookupField(page, label).evaluate((el) => el.tagName)).toBe("SELECT");
    }
    const salas = await optionTexts(page, "Sala");
    const pessoas = await optionTexts(page, "Responsável");
    expect(salas[0]).toBe("Todas as salas");
    expect(pessoas[0]).toBe("Todos os responsáveis");
    expect(salas).toHaveLength(5); // 4 salas sintéticas (inclusive a inativa) + "Todas as salas"
    expect(pessoas).toHaveLength(5);
    expect(salas.slice(1, 3)).toEqual(["Almoxarifado Sintético", "Auditório Sintético"]);
    // Nome vindo da planilha é TEXTO: o marcador XSS não executa nem vira HTML.
    expect(salas.some((text) => text.includes('<img src=x onerror="window.__xss=1">'))).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    // As listas usam `page_size` aceito pelo backend (50/100/200).
    const lookupCalls = state.calls.filter(
      (c) => c.method === "GET" && (c.url.startsWith("/api/v1/rooms") || c.url.startsWith("/api/v1/responsible-people")),
    );
    expect(lookupCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of lookupCalls) {
      expect(["50", "100", "200"]).toContain(new URL(call.url, "http://x").searchParams.get("page_size"));
    }
  });

  test("vínculo: opções do catálogo em ordem alfabética e 'Sem vínculo' por último", async ({ page }) => {
    await open(page);
    expect(await optionTexts(page, "Vínculo")).toEqual([
      "Todos os vínculos",
      "Estagiario",
      "Ocioso",
      "Servidor",
      "Terceirizado",
      "Sem vínculo",
    ]);
  });

  test("vínculo: opções dinâmicas são reordenadas na tela e lista vazia não é falha", async ({ page }) => {
    // O backend manda os valores do escopo do ator; a tela não inventa opção.
    await open(page, { role: "USER", reports: { bondStatusOptions: ["__none__", "Terceirizado", "Estagiario"] } });
    expect(await optionTexts(page, "Vínculo")).toEqual([
      "Todos os vínculos",
      "Estagiario",
      "Terceirizado",
      "Sem vínculo",
    ]);
  });

  test("vínculo sem opções (usuário sem unidade): campo utilizável, sem aviso de erro", async ({ page }) => {
    const state = await open(page, { role: "USER", reports: { bondStatusOptions: [] } });
    const vinculo = lookupField(page, "Vínculo");
    await expect(vinculo).toBeEnabled();
    expect(await optionTexts(page, "Vínculo")).toEqual(["Todos os vínculos"]);
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    const params = new URL(exportCalls(state)[0]!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("bond_status")).toBeNull();
  });

  test("vínculo que saiu das opções é preservado e NÃO bloqueia a exportação", async ({ page }) => {
    await page.clock.install();
    const state = await open(page);
    const vinculo = lookupField(page, "Vínculo");
    await vinculo.selectOption("Servidor");
    // Nova importação do Sheets muda os valores existentes no escopo.
    state.reports.bondStatusOptions = ["Ocioso"];
    await page.clock.fastForward("05:00");
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(vinculo.locator("option", { hasText: "Selecionado anteriormente" })).toHaveCount(1);
    await expect(vinculo).toHaveValue("Servidor");
    await exportButton(page).click();
    // Sem validação no cliente: a decisão sobre o valor é do backend.
    await expect(form(page).getByText("Escolha uma das opções.")).toHaveCount(0);
    await expect.poll(() => exportCalls(state).length).toBeGreaterThan(0);
    const params = new URL(exportCalls(state)[0]!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("bond_status")).toBe("Servidor");
  });

  test("escolhas vão na query (inclusive __none__ para sem vínculo)", async ({ page }) => {
    const state = await open(page);
    await lookupField(page, "Sala").selectOption(ROOM_IDS.a);
    await lookupField(page, "Responsável").selectOption(PERSON_IDS.a);
    await lookupField(page, "Vínculo").selectOption("__none__");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    const params = new URL(exportCalls(state)[0]!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("room_id")).toBe(ROOM_IDS.a);
    expect(params.get("responsible_person_id")).toBe(PERSON_IDS.a);
    expect(params.get("bond_status")).toBe("__none__");
    await expect(outcome(page)).toContainText("registro(s)");
  });

  test("salas homônimas de unidades diferentes ganham o código da unidade", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER" });
    const room = (id: string, unitId: string, name: string) => ({
      id,
      unit_id: unitId,
      name,
      description: null,
      floor: null,
      active: true,
      source_record_id: null,
      created_at: "2026-10-01T12:00:00+00:00",
      updated_at: "2026-10-01T12:00:00+00:00",
    });
    // Resposta fora de ordem: a ordenação alfabética é feita na interface.
    await page.route("**/api/v1/rooms**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({
          total: 3,
          page: 1,
          page_size: 200,
          rooms: [
            room(ROOM_IDS.other, UNITS[1]!.id, "Sala 101"),
            room(ROOM_IDS.a, UNITS[0]!.id, "Sala 101"),
            room(ROOM_IDS.inactive, UNITS[0]!.id, "Arquivo Sintético"),
          ],
        }),
      });
    });
    await page.goto(PATH);
    await waitForHydration(page);
    await expect(page.getByTestId("report-form")).toBeVisible();
    expect(await optionTexts(page, "Sala")).toEqual([
      "Todas as salas",
      "Arquivo Sintético",
      `Sala 101 (${UNITS[1]!.code})`,
      `Sala 101 (${UNITS[0]!.code})`,
    ]);
  });

  test("listas indisponíveis (403): aviso, campo desabilitado e relatório ainda exportável", async ({ page }) => {
    const state = await open(page, { role: "USER", lookupListStatus: 403 });
    await expect(form(page).getByText("Lista de salas indisponível para o seu perfil ou no momento.")).toBeVisible();
    await expect(
      form(page).getByText("Lista de responsáveis indisponível para o seu perfil ou no momento."),
    ).toBeVisible();
    await expect(lookupField(page, "Sala")).toBeDisabled();
    await expect(lookupField(page, "Responsável")).toBeDisabled();
    // O resto da tela continua: unidade, vínculo e a exportação.
    await expect(lookupField(page, "Unidade")).toBeEnabled();
    await lookupField(page, "Vínculo").selectOption("Servidor");
    const downloadPromise = page.waitForEvent("download");
    await exportButton(page).click();
    await downloadPromise;
    const params = new URL(exportCalls(state)[0]!.replace("GET ", ""), "http://x").searchParams;
    expect(params.get("bond_status")).toBe("Servidor");
    expect(params.get("room_id")).toBeNull();
  });

  test("valor escolhido que sai da lista fica como 'Selecionado anteriormente'", async ({ page }) => {
    await page.clock.install();
    const state = await open(page);
    const sala = lookupField(page, "Sala");
    await sala.selectOption(ROOM_IDS.a);
    // A sala deixa de existir no escopo (inativada/removida pelo backend) e a
    // lista é recarregada: o valor já escolhido não pode desaparecer calado.
    state.rooms = state.rooms.filter((r) => r.id !== ROOM_IDS.a);
    await page.clock.fastForward("05:00");
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(sala.locator("option", { hasText: "Selecionado anteriormente" })).toHaveCount(1);
    await expect(sala).toHaveValue(ROOM_IDS.a);
  });

  for (const width of [320, 768, 1920]) {
    test(`${width}px: os três selects sem overflow e sem violações axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await open(page);
      await expect(page.getByTestId("report-form")).toBeVisible();
      for (const label of ["Sala", "Responsável", "Vínculo"]) {
        await expect(lookupField(page, label)).toBeVisible();
      }
      await lookupField(page, "Sala").selectOption(ROOM_IDS.xss);
      await lookupField(page, "Vínculo").selectOption("__none__");
      await expectNoHorizontalOverflow(page);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

test.describe("validação de UX e erros", () => {
  test("intervalo de datas invertido bloqueia a exportação, sem chamar a API", async ({ page }) => {
    const state = await open(page);
    await pickReport(page, "movements");
    await filters(page).getByLabel("Solicitada a partir de").fill("2026-05-10");
    await filters(page).getByLabel("Solicitada até").fill("2026-05-01");
    await exportButton(page).click();
    await expect(form(page).getByText("A data final não pode ser anterior à inicial.")).toBeVisible();
    await expect(filters(page).getByLabel("Solicitada até")).toBeFocused();
    expect(exportCalls(state)).toEqual([]);
  });

  test("catálogo sem os tipos novos (contrato antigo): campo livre e UUID validado", async ({ page }) => {
    const state = await open(page, { role: "USER", reports: { legacyFilterTypes: true } });
    const sala = lookupField(page, "Sala");
    await expect(sala).toHaveAttribute("type", "text");
    await expect(form(page).getByText("UUID da sala, como exibido no cadastro.")).toBeVisible();
    await sala.fill("nao-e-uuid");
    await exportButton(page).click();
    await expect(form(page).getByText("Informe um identificador (UUID) válido.")).toBeVisible();
    expect(exportCalls(state)).toEqual([]);
    // Sem tipo de lookup declarado, a tela não pede as listas de apoio.
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/rooms"))).toBe(false);
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/responsible-people"))).toBe(false);
  });

  test("413: pede para refinar os filtros", async ({ page }) => {
    await open(page);
    await filters(page).getByLabel("Busca (número ou descrição)").fill("limite");
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
