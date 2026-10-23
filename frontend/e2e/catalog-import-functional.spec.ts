import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { CATALOG_PREVIEW_IDS } from "./support/catalog-import-mocks";
import { expectNoXss, installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";
import { CADASTROS_PATH, generateCatalogPreview, waitForAnimations } from "./support/screens";

// =============================================================================
// Importação dos cadastros de apoio (unidades, salas, pessoas) e pendências de
// bens — telas do ADM. Mocks sintéticos que seguem
// docs/architecture/cadastros-apoio-api.md. Perfil, AAL2, permissão do tipo,
// expiração e idempotência são do BACKEND (simulados no mock); aqui validamos o
// que a interface envia e como explica cada resposta. LGPD: telefone nunca
// aparece e nada vai para storage. O nome do arquivo casa com o projeto "e2e".
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const BENS_PATH = "/administracao/importacao/google-sheets";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axeViolations(page: Page): Promise<string[]> {
  await waitForAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return results.violations.map((v) => v.id);
}

async function open(page: Page, path: string, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

function calls(state: MockState, method: string, pathPart: string) {
  return state.calls.filter((c) => c.method === method && c.url.includes(pathPart));
}

async function openConfirm(page: Page, title: string) {
  await page.getByRole("button", { name: "Confirmar importação" }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("cadastros — prévia, relatório e itens", () => {
  test("unidades: POST sem corpo, resumo do backend, relatório por código e tabela", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await expect(page.getByText("Nenhuma prévia de unidades gerada nesta sessão.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();

    await generateCatalogPreview(page, "units");

    const preview = calls(state, "POST", "/v1/catalog-imports/units/preview");
    expect(preview).toHaveLength(1);
    expect(preview[0]!.body).toBeUndefined();

    // Resumo = contadores do backend (3 elegíveis, 1 inválido, 1 duplicado).
    await expect(page.locator("[data-metric=total]")).toContainText("5");
    await expect(page.locator("[data-metric=novo]")).toContainText("2");
    await expect(page.locator("[data-metric=invalido]")).toContainText("1");

    const report = page.getByTestId("catalog-import-report");
    await expect(report.locator("[data-pending-code=sigla_invalida]")).toContainText("Sigla vazia ou longa demais: 1");
    await expect(report.locator("[data-pending-code=sigla_repetida_com_outro_orgao]")).toContainText("1");
    await expect(report.getByRole("region", { name: "IDs repetidos: 1" })).toContainText("ID 2 em linhas 3, 6");

    const table = page.getByRole("table", { name: "Itens da prévia de unidades" });
    await expect(table.getByRole("row")).toHaveCount(6); // cabeçalho + 5
    const invalid = table.getByRole("row").filter({ hasText: "Linha sem sigla" });
    await expect(invalid).toContainText("Inválido");
    await expect(invalid).toContainText("Sigla vazia ou longa demais");
    // Inválido/duplicado nunca são selecionáveis; elegíveis vêm marcados.
    await expect(invalid.getByRole("checkbox")).toBeDisabled();
    const eligible = table.getByRole("row").filter({ hasText: "Procuradoria Sintética B" });
    await expect(eligible.getByRole("checkbox", { name: /^Selecionar/ })).toBeChecked();
  });

  test("filtro, busca (debounce) e ordenação enviam só a allowlist; estado vazio orienta", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    const rows = page.getByRole("table", { name: "Itens da prévia de unidades" }).locator("tbody tr");

    await page.getByRole("group", { name: "Filtrar por classificação" }).getByRole("button", { name: "Inválido" }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(5);

    await page.getByLabel("Buscar unidades na prévia").fill("procuradoria");
    await expect(rows).toHaveCount(1);
    await page.getByLabel("Buscar unidades na prévia").fill("nada-corresponde");
    await expect(page.getByText("Nenhum item encontrado para os filtros atuais.")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(5);

    const nameHeader = page.getByRole("columnheader", { name: /Nome/ });
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    await nameHeader.getByRole("button").click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");

    const allowed = new Set(["status", "search", "sort", "page", "page_size"]);
    const itemCalls = calls(state, "GET", `/v1/catalog-imports/${CATALOG_PREVIEW_IDS.units}/items`);
    expect(itemCalls.length).toBeGreaterThan(3);
    for (const call of itemCalls) {
      for (const key of new URL(call.url, "http://x").searchParams.keys()) expect(allowed.has(key)).toBe(true);
    }
    expect(itemCalls.some((c) => c.url.includes("sort=-label"))).toBe(true);
    expect(itemCalls.some((c) => c.url.includes("status=INVALIDO"))).toBe(true);
  });

  test("salas: provável duplicata no relatório e na tabela; nome com marcador XSS é texto", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "rooms");
    const report = page.getByTestId("catalog-import-report");
    await expect(report.getByRole("region", { name: "Prováveis duplicatas: 1" })).toContainText("06 ≈ 6");
    await expect(report.locator("[data-pending-code=unidade_sem_alias]")).toContainText("Unidade sem alias");
    const table = page.getByRole("table", { name: "Itens da prévia de salas" });
    await expect(table.getByText("Provável duplicata")).toHaveCount(2);
    await expect(table.getByText('Sala <img src=x onerror="window.__xss=1">').first()).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("pessoas: e-mail mascarado, telefone nunca exibido, nome suspeito, paginação e nada em storage", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "people");
    const main = page.getByRole("main");

    await expect(main.getByText("E-mail: p***@exemplo.invalid").first()).toBeVisible();
    await expect(main.getByText("Telefone: informado (oculto)").first()).toBeVisible();
    await expect(main.getByText("Telefone: não informado").first()).toBeVisible();
    // Nenhuma sequência que pareça telefone (10+ dígitos) e nenhum e-mail completo.
    expect(await main.innerText()).not.toMatch(/\d{10,}/);
    expect(await main.innerText()).not.toMatch(/[a-z0-9._-]{2,}@/);

    const report = page.getByTestId("catalog-import-report");
    await expect(report.getByRole("region", { name: "Nomes suspeitos: 1" })).toContainText("JÕAO Sintético");
    await expect(report.getByRole("region", { name: "IDs repetidos: 1" })).toContainText("ID 35");

    // 30 itens cabem numa página de 50 (padrão): sem próxima página.
    await expect(page.getByText("Exibindo 1–30 de 30 item(ns)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Próxima" })).toBeDisabled();

    // Dados da prévia só em memória: nem storage nem cookies.
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    for (const marker of ["p***@", "JÕAO", "Pessoa Sintética 0"]) expect(stored).not.toContain(marker);
    const cookies = JSON.stringify(await page.context().cookies());
    for (const marker of ["p***@", "JÕAO", "Pessoa Sintética 0"]) expect(cookies).not.toContain(marker);
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("paginação 50/100/200: resumo, navegação, troca de tamanho e parâmetros aceitos", async ({ page }) => {
    // 30 + 100 extras = 130 itens: 3 páginas de 50; 2 de 100; 1 de 200.
    const state = await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { extraPeople: 100 } });
    await generateCatalogPreview(page, "people");
    const rows = page.getByRole("table", { name: "Itens da prévia de pessoas" }).locator("tbody tr");

    await expect(page.getByText("Exibindo 1–50 de 130 item(ns)")).toBeVisible();
    await expect(rows).toHaveCount(50);
    await expect(page.getByRole("button", { name: "Anterior" })).toBeDisabled();
    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page.getByText("Exibindo 51–100 de 130 item(ns)")).toBeVisible();
    await page.getByRole("button", { name: "Última" }).click();
    await expect(page.getByText("Exibindo 101–130 de 130 item(ns)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Próxima" })).toBeDisabled();

    // Trocar o tamanho volta à página 1.
    await page.getByLabel("Registros por página").selectOption("100");
    await expect(page.getByText("Exibindo 1–100 de 130 item(ns)")).toBeVisible();
    await expect(rows).toHaveCount(100);
    await page.getByLabel("Registros por página").selectOption("200");
    await expect(page.getByText("Exibindo 1–130 de 130 item(ns)")).toBeVisible();
    await expect(rows).toHaveCount(130);

    // Buscar/filtrar volta à página 1 (e o tamanho escolhido é mantido).
    await page.getByLabel("Registros por página").selectOption("50");
    await page.getByRole("button", { name: "Próxima" }).click();
    await page.getByLabel("Buscar pessoas responsáveis na prévia").fill("extra 1");
    await expect(page.getByText(/Exibindo 1–\d+ de \d+ item\(ns\)/)).toBeVisible();

    const itemCalls = calls(state, "GET", `/v1/catalog-imports/${CATALOG_PREVIEW_IDS.people}/items`);
    const sizes = new Set(itemCalls.map((c) => new URL(c.url, "http://x").searchParams.get("page_size")));
    for (const size of sizes) expect(["50", "100", "200"]).toContain(size);
    expect(sizes.has("100") && sizes.has("200")).toBe(true);
  });

  test("busca: espaços são aparados, limite de 100 e 'Limpar filtros' zera tudo", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    const search = page.getByLabel("Buscar unidades na prévia");
    await expect(search).toHaveAttribute("maxlength", "100");

    await search.fill("   procuradoria   ");
    await expect.poll(() => calls(state, "GET", "/items").some((c) => c.url.includes("search=procuradoria"))).toBe(true);
    expect(calls(state, "GET", "/items").some((c) => /search=(%20|\+)/.test(c.url))).toBe(false);

    // Só espaços não é busca: nenhum `search=` novo.
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(search).toHaveValue("");
    const before = calls(state, "GET", "/items").length;
    await search.fill("    ");
    await page.waitForTimeout(700);
    expect(calls(state, "GET", "/items").length).toBe(before);
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(search).toHaveValue("");
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);
  });

  test("prévia sem pendências mostra o relatório limpo", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { cleanReport: true } });
    await generateCatalogPreview(page, "units");
    await expect(page.getByTestId("catalog-import-report")).toContainText("Nenhuma pendência, ID repetido");
  });

  test("trocar de aba descarta a prévia em tela e permite gerar a outra", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    await page.getByRole("tab", { name: "Salas" }).click();
    await expect(page.getByText("Nenhuma prévia de salas gerada nesta sessão.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Salas" })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("cadastros — seleção e confirmação em massa", () => {
  test("diálogo explica gravação em massa idempotente; envia TODOS os elegíveis (todas as páginas)", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "people");

    const dialog = await openConfirm(page, "Confirmar importação de pessoas responsáveis");
    await expect(dialog).toContainText("grava em massa");
    await expect(dialog).toContainText("idempotente");
    await expect(dialog).toContainText("Serão criados: 25 (Novo). Serão atualizados: 1 (Existente).");
    await expect(dialog).toContainText("Nenhum registro é excluído");

    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    const result = page.getByTestId("catalog-import-result");
    await expect(result).toBeVisible();
    await expect(result.locator("[data-stat=Criados]")).toHaveText("25");
    await expect(result.locator("[data-stat=Atualizados]")).toHaveText("1");
    await expect(result.locator("[data-stat=Ignorados]")).toHaveText("0");
    await expect(result.locator("[data-stat=Salvos]")).toHaveText("26");
    await expect(result.locator("[data-stat=Rejeitados]")).toHaveText("0");
    await expect(page.getByText("Importação concluída: 25 criado(s), 1 atualizado(s), 0 inalterado(s), 0 ignorado(s).")).toBeVisible();

    const confirm = calls(state, "POST", `/v1/catalog-imports/${CATALOG_PREVIEW_IDS.people}/confirm`);
    expect(confirm).toHaveLength(1);
    const body = confirm[0]!.body as { item_ids: string[] };
    expect(Object.keys(body)).toEqual(["item_ids"]);
    expect(body.item_ids).toHaveLength(26);
    expect(new Set(body.item_ids).size).toBe(26);
    // Itens da 2ª página (nunca visitada) entram na gravação.
    expect(body.item_ids).toContain("42300000-0000-4000-8000-000000000024");
    // Prévia consumida: o botão de confirmar volta a ficar desabilitado.
    await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();
  });

  test("seleção: limpar, selecionar todos e exceção por item refletem na contagem do diálogo", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "people");

    await page.getByRole("button", { name: "Limpar seleção" }).click();
    let dialog = await openConfirm(page, "Confirmar importação de pessoas responsáveis");
    await expect(dialog).toContainText("Serão criados: 0 (Novo). Serão atualizados: 0 (Existente).");
    await expect(dialog.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Selecionar todos os elegíveis (26)" }).click();
    await page.getByRole("checkbox", { name: "Selecionar Pessoa Sintética 01" }).uncheck();
    dialog = await openConfirm(page, "Confirmar importação de pessoas responsáveis");
    await expect(dialog).toContainText("Serão criados: 24 (Novo). Serão atualizados: 1 (Existente).");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(page.getByTestId("catalog-import-result")).toBeVisible();
    const body = calls(state, "POST", "/confirm").at(-1)!.body as { item_ids: string[] };
    expect(body.item_ids).toHaveLength(25);
    expect(body.item_ids).not.toContain("42300000-0000-4000-8000-000000000001");
  });

  test("unidades: padrão sem sigla — nada marcado e o corpo da confirmação omite alias_item_ids", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    const table = page.getByRole("table", { name: "Itens da prévia de unidades" });
    const optIns = table.locator("input[data-alias-optin]");
    // Só NOVO com create_alias=true oferece o controle (EXISTENTE/INVALIDO/DUPLICADO não).
    await expect(optIns).toHaveCount(2);
    for (const box of await optIns.all()) await expect(box).not.toBeChecked();
    await expect(table.getByRole("row").filter({ hasText: "Consultoria Sintética C" }).locator("input[data-alias-optin]")).toHaveCount(0);
    await expect(page.getByTestId("alias-optin-panel")).toContainText("nenhuma sigla é criada por padrão");
    await expect(page.getByTestId("alias-optin-count")).toContainText("Siglas marcadas: 0");

    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await expect(dialog).toContainText("Siglas de atalho a criar: 0");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(page.getByTestId("catalog-import-result")).toBeVisible();
    const body = calls(state, "POST", "/confirm").at(-1)!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["item_ids"]);
  });

  test("unidades: opt-in por item envia alias_item_ids como subconjunto de item_ids", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    const table = page.getByRole("table", { name: "Itens da prévia de unidades" });
    const row = table.getByRole("row").filter({ hasText: "Unidade Estadual Sintética de Teste" });
    await row.getByRole("checkbox", { name: /Criar sigla de atalho para esta unidade/ }).check();
    await expect(page.getByTestId("alias-optin-count")).toContainText("Siglas marcadas: 1");

    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await expect(dialog).toContainText("Siglas de atalho a criar: 1");
    await expect(dialog).toContainText("passa a decidir a unidade dos bens importados");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(page.getByTestId("catalog-import-result")).toBeVisible();

    const body = calls(state, "POST", "/confirm").at(-1)!.body as { item_ids: string[]; alias_item_ids: string[] };
    expect(Object.keys(body).sort()).toEqual(["alias_item_ids", "item_ids"]);
    expect(body.alias_item_ids).toEqual(["42100000-0000-4000-8000-000000000001"]);
    for (const id of body.alias_item_ids) expect(body.item_ids).toContain(id);
  });

  test("unidades: marcação em massa só afeta itens selecionados; desmarcar o item descarta a sigla", async ({ page }) => {
    const state = await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    const table = page.getByRole("table", { name: "Itens da prévia de unidades" });
    const second = table.getByRole("row").filter({ hasText: "Procuradoria Sintética B" });

    await second.getByRole("checkbox", { name: /Selecionar/ }).uncheck();
    // Item fora da importação não aceita sigla.
    await expect(second.locator("input[data-alias-optin]")).toBeDisabled();
    await page.getByRole("button", { name: /Criar sigla nos itens selecionados desta página \(1\)/ }).click();
    await expect(page.getByTestId("alias-optin-count")).toContainText("Siglas marcadas: 1");
    await page.getByRole("button", { name: "Limpar siglas marcadas" }).click();
    await expect(page.getByTestId("alias-optin-count")).toContainText("Siglas marcadas: 0");

    await second.getByRole("checkbox", { name: /Selecionar/ }).check();
    await page.getByRole("button", { name: /Criar sigla nos itens selecionados desta página \(2\)/ }).click();
    await expect(page.getByTestId("alias-optin-count")).toContainText("Siglas marcadas: 2");
    // Desmarca o item 2 da importação: a sigla dele não vai no corpo.
    await second.getByRole("checkbox", { name: /Selecionar/ }).uncheck();

    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await expect(dialog).toContainText("Siglas de atalho a criar: 1");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(page.getByTestId("catalog-import-result")).toBeVisible();
    const body = calls(state, "POST", "/confirm").at(-1)!.body as { item_ids: string[]; alias_item_ids: string[] };
    expect(body.alias_item_ids).toEqual(["42100000-0000-4000-8000-000000000001"]);
    expect(body.item_ids).not.toContain("42100000-0000-4000-8000-000000000002");
  });

  test("salas e pessoas não oferecem sigla de atalho", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "rooms");
    await expect(page.locator("input[data-alias-optin]")).toHaveCount(0);
    await expect(page.getByTestId("alias-optin-panel")).toHaveCount(0);
  });

  test("falha por item aparece no resultado (linha, nome e motivo)", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { failures: true } });
    await generateCatalogPreview(page, "units");
    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    const result = page.getByTestId("catalog-import-result");
    await expect(result).toHaveAttribute("data-outcome", "partial");
    await expect(result).toContainText("Importação parcial");
    await expect(result.locator("[data-stat=Criados]")).toHaveText("1");
    await expect(result.locator("[data-stat=Rejeitados]")).toHaveText("1");
    await expect(page.getByTestId("catalog-import-status")).toContainText("Importação parcial");
    await expect(page.getByTestId("catalog-import-failures")).toContainText(
      "Linha 2 — Unidade Estadual Sintética de Teste: Falha sintética ao gravar este item.",
    );
    // Linhas inválidas/duplicadas da prévia são explicadas por classificação e motivo.
    await expect(page.getByTestId("catalog-import-unwritten")).toContainText("Inválidos: 1");
    await expect(page.getByTestId("catalog-import-unwritten")).toContainText("Duplicados: 1");
    await expect(page.getByTestId("catalog-import-unwritten-reasons")).toContainText("Sigla vazia ou longa demais: 1");
    expect(await axeViolations(page)).toEqual([]);
  });

  test("falha total (HTTP 200, created=0, só rejeitados): sem verde, sem 'gravados', toast de erro", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { allFail: true } });
    await generateCatalogPreview(page, "units");
    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    const result = page.getByTestId("catalog-import-result");
    await expect(result).toHaveAttribute("data-outcome", "failure");
    await expect(result).toContainText("Nenhum item foi salvo");
    await expect(result).not.toContainText(/gravados|concluída com sucesso/i);
    await expect(result.locator("[data-stat=Salvos]")).toHaveText("0");
    await expect(result.locator("[data-stat=Rejeitados]")).toHaveText("3");
    await expect(result.locator("[data-stat=Criados]")).toHaveText("0");
    await expect(page.getByTestId("catalog-import-failures").getByRole("listitem")).toHaveCount(3);
    // Indicador de erro, nunca "Importação concluída"; borda de sucesso ausente.
    await expect(page.getByTestId("catalog-import-status")).toContainText("Nenhum item salvo");
    await expect(page.getByTestId("catalog-import-status")).not.toContainText("concluída");
    await expect(result).not.toHaveClass(/border-metric-green/);
    const toast = page.locator("[data-sonner-toast][data-type=error]");
    await expect(toast).toContainText("Nenhum item foi salvo: 3 rejeitado(s)");
    await expect(page.locator("[data-sonner-toast][data-type=success]")).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("salas: pendência unidade_sem_alias avisada na prévia e no resultado (sem verde de sucesso falso)", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "rooms");
    await expect(page.getByTestId("catalog-import-alias-dependency")).toContainText(
      "1 linha(s) estão sem alias e NÃO serão gravadas",
    );
    const dialog = await openConfirm(page, "Confirmar importação de salas");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    const result = page.getByTestId("catalog-import-result");
    await expect(result).toHaveAttribute("data-outcome", "success");
    await expect(page.getByTestId("catalog-import-alias-warning")).toContainText(
      "1 linha(s) não foram gravadas porque a sigla da coluna UNIDADE não tem alias",
    );
    await expect(result.locator("[data-unwritten-reason=unidade_sem_alias]")).toContainText("1");
    await expect(page.getByTestId("catalog-import-unwritten")).toContainText("Conflitantes: 1");
    expect(await axeViolations(page)).toEqual([]);
  });

  test("unidades: sem aviso de dependência de alias", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    await generateCatalogPreview(page, "units");
    await expect(page.getByTestId("catalog-import-alias-dependency")).toHaveCount(0);
  });

  test("diálogo não fecha durante a gravação (Esc ignorado) e o botão mostra carregamento", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { confirmDelayMs: 1500 } });
    await generateCatalogPreview(page, "units");
    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await expect(dialog).toContainText("Serão criados: 2 (Novo). Serão atualizados: 1 (Existente).");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(dialog.getByRole("button", { name: "Gravando…" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("catalog-import-result")).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test("409 na confirmação (já confirmada/expirada): mensagem fixa e nova prévia exigida", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { confirmStatus: 409 } });
    await generateCatalogPreview(page, "units");
    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("alert").filter({ hasText: "expirada, já confirmada" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Gerar prévia de unidades" })).toBeEnabled();
  });

  test("500 na confirmação: erro fica no diálogo, que continua aberto para nova tentativa", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { confirmStatus: 500 } });
    await generateCatalogPreview(page, "units");
    const dialog = await openConfirm(page, "Confirmar importação de unidades");
    await dialog.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Não foi possível confirmar a importação");
    await expect(dialog.getByRole("alert")).not.toContainText("erro sintético");
    await expect(dialog.getByRole("button", { name: "Confirmar importação" })).toBeEnabled();
  });

  test("prévia expirada desabilita a confirmação e avisa", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { expired: true } });
    await generateCatalogPreview(page, "units");
    await expect(page.getByText("Esta prévia expirou. Gere uma nova prévia para continuar.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();
  });
});

test.describe("cadastros — mensagens de erro fixas na prévia", () => {
  const cases: [string, MockOptions, RegExp][] = [
    ["409 aba não configurada", { role: "ADM", catalogImport: { previewStatus: 409 } }, /aba deste cadastro não está configurada/],
    ["422 planilha inválida", { role: "ADM", catalogImport: { previewStatus: 422 } }, /não tem a estrutura esperada/],
    ["502 planilha indisponível", { role: "ADM", catalogImport: { previewStatus: 502 } }, /Não foi possível ler a planilha/],
    ["429 limite", { role: "ADM", catalogImport: { previewStatus: 429 } }, /Muitas solicitações/],
    ["403 genérico (RH)", { role: "RH" }, /Você não tem permissão para esta importação\./],
    ["403 genérico (USER)", { role: "USER" }, /Você não tem permissão para esta importação\./],
    ["ADM sem MFA (AAL2)", { role: "ADM", aal: "aal1" }, /verificação em duas etapas \(AAL2\)/],
  ];
  for (const [title, opts, message] of cases) {
    test(title, async ({ page }) => {
      await open(page, CADASTROS_PATH, opts);
      await page.getByRole("button", { name: "Gerar prévia de unidades" }).click();
      const alert = page.getByRole("main").getByRole("alert").filter({ hasText: message });
      await expect(alert).toBeVisible();
      // Nunca ecoa o texto do backend.
      await expect(page.getByRole("main")).not.toContainText("erro sintético");
      await expect(page.getByTestId("catalog-import-status")).toContainText("Falha na leitura");
    });
  }

  test("erro de itens (404): pede nova prévia", async ({ page }) => {
    await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { itemsStatus: 404 } });
    await page.getByRole("button", { name: "Gerar prévia de unidades" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Gere uma nova prévia." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar importação" })).toBeDisabled();
  });
});

test.describe("menu e acesso", () => {
  test("item do menu aparece só para ADM e leva à tela", async ({ page }) => {
    await open(page, CADASTROS_PATH);
    const link = page.getByRole("link", { name: "Importação de Dados → Cadastros de apoio" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Importação de Dados → Google Sheets" })).toBeVisible();
  });

  test("USER não vê o item no menu", async ({ page }) => {
    await open(page, "/", { role: "USER" });
    await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Cadastros de apoio/ })).toHaveCount(0);
  });
});

test.describe("bens — pendências de vínculo na prévia", () => {
  test("mostra pending_counts (só > 0), carrega o relatório do servidor e liga aos cadastros", async ({ page }) => {
    const state = await open(page, BENS_PATH);
    await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
    const panel = page.getByTestId("pending-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-pending-code=sala_nao_encontrada]")).toContainText("Sala não encontrada: 5");
    await expect(panel.locator("[data-pending-code=unidade_sem_alias]")).toContainText("Unidade sem alias");
    await expect(panel.locator("[data-pending-code=sala_ambigua]")).toHaveCount(0);
    await expect(panel).toContainText("Não bloqueiam a confirmação");
    await expect(panel.getByRole("link", { name: /Importar cadastros de apoio/ })).toHaveAttribute(
      "href",
      "/administracao/importacao/cadastros",
    );

    await panel.getByRole("button", { name: "Carregar relatório de pendências" }).click();
    await expect(panel.getByText("Relatório carregado do servidor.")).toBeVisible();
    await expect(panel.locator("[data-pending-code=sala_ambigua]")).toContainText("Sala ambígua (mais de uma correspondência): 0");
    const pending = calls(state, "GET", "/pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.url).toBe("/api/v1/imports/google-sheets/40000000-0000-4000-8000-000000000001/pending");

    // O fluxo existente segue funcionando: a confirmação continua habilitada.
    await expect(page.getByRole("button", { name: "Confirmar Importação" })).toBeEnabled();
  });

  test("falha ao carregar o relatório: mensagem fixa, sem derrubar a prévia", async ({ page }) => {
    await open(page, BENS_PATH, { role: "ADM", catalogImport: { pendingStatus: 500 } });
    await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
    await page.getByRole("button", { name: "Carregar relatório de pendências" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível carregar o relatório de pendências." })).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
  });
});

// -----------------------------------------------------------------------------
// Bens — resultado da confirmação (mesmo contrato D2 dos cadastros). O STATUS do
// job do backend decide o tom: FALHOU nunca é verde nem "nada salvo" neutro;
// PARCIAL nunca é verde. Quadro de resultado testado em 320/768/1366 px.
// -----------------------------------------------------------------------------

async function confirmBens(page: Page) {
  await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
  await expect(page.getByTestId("pending-panel")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar Importação" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
  await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
  const result = page.getByTestId("catalog-import-result");
  await expect(result).toBeVisible();
  return result;
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

const RESULT_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
] as const;

test.describe("bens — resultado da confirmação", () => {
  test("falha total (HTTP 200, status FALHOU): sem verde, sem 'gravados', toast de erro, axe", async ({ page }) => {
    await open(page, BENS_PATH, { role: "ADM", catalogImport: { allFail: true } });
    const result = await confirmBens(page);
    await expect(result).toHaveAttribute("data-outcome", "failure");
    await expect(result).toContainText("Nenhum item foi salvo");
    await expect(result).not.toContainText(/gravados|concluída com sucesso/i);
    await expect(result.locator("[data-stat=Salvos]")).toHaveText("0");
    await expect(result.locator("[data-stat=Rejeitados]")).toHaveText("5");
    await expect(page.getByTestId("catalog-import-failures").getByRole("listitem")).toHaveCount(5);
    // Número patrimonial é TEXTO (zeros à esquerda preservados); nenhuma descrição.
    await expect(page.getByTestId("catalog-import-failures")).toContainText("Linha 2 — Patrimônio 000123");
    await expect(result).not.toHaveClass(/border-metric-green/);
    await expect(page.getByTestId("import-request-status")).toContainText("Nenhum item salvo");
    await expect(page.getByTestId("import-request-status")).not.toContainText("concluída");
    await expect(page.locator("[data-sonner-toast][data-type=error]")).toContainText("Nenhum item foi salvo: 5 rejeitado(s)");
    await expect(page.locator("[data-sonner-toast][data-type=success]")).toHaveCount(0);
    // Nova prévia exigida: a anterior foi consumida.
    await expect(page.getByRole("button", { name: "Confirmar Importação" })).toBeDisabled();
    expect(await axeViolations(page)).toEqual([]);
  });

  test("parcial (status PARCIAL): laranja, parte salva e parte rejeitada, axe", async ({ page }) => {
    await open(page, BENS_PATH, { role: "ADM", catalogImport: { failures: true } });
    const result = await confirmBens(page);
    await expect(result).toHaveAttribute("data-outcome", "partial");
    await expect(result).toContainText("Importação parcial");
    await expect(result.locator("[data-stat=Rejeitados]")).toHaveText("1");
    await expect(result.locator("[data-stat=Salvos]")).toHaveText("4");
    await expect(result).not.toHaveClass(/border-metric-green/);
    await expect(page.getByTestId("import-request-status")).toContainText("Importação parcial");
    await expect(page.locator("[data-sonner-toast][data-type=success]")).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("sucesso: verde, não gravados por motivo e avisos de pendências de vínculo e de alias", async ({ page }) => {
    const state = await open(page, BENS_PATH);
    const result = await confirmBens(page);
    await expect(result).toHaveAttribute("data-outcome", "success");
    await expect(result.locator("[data-stat=Salvos]")).toHaveText("5");
    await expect(result.locator("[data-stat=Inalterados]")).toHaveText("0");
    await expect(page.getByTestId("catalog-import-unwritten")).toContainText("Inválidos: 1");
    await expect(page.getByTestId("catalog-import-unwritten")).toContainText("Duplicados: 1");
    await expect(page.getByTestId("catalog-import-unwritten")).toContainText("Conflitantes: 1");
    await expect(result.locator("[data-unwritten-reason=patrimonio_conflitante]")).toContainText("1");
    await expect(page.getByTestId("catalog-import-alias-warning")).toContainText("não tem alias cadastrado");
    const links = page.getByTestId("catalog-import-link-pending");
    await expect(links.locator("[data-link-pending=sala_nao_encontrada]")).toContainText("Sala não encontrada: 2");
    await expect(links.locator("[data-link-pending=pessoa_nao_encontrada]")).toContainText(
      "Pessoa responsável não encontrada: 1",
    );
    await expect(page.locator("[data-sonner-toast][data-type=success]")).toBeVisible();
    // Corpo enviado: só preview_id e selected_item_ids (nada privilegiado).
    const confirm = calls(state, "POST", "/v1/imports/google-sheets/confirm");
    expect(Object.keys(confirm[0]!.body as object).sort()).toEqual(["preview_id", "selected_item_ids"]);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("status fora do contrato nunca é verde", async ({ page }) => {
    await open(page, BENS_PATH, { role: "ADM", catalogImport: { assetsUnknownStatus: true } });
    const result = await confirmBens(page);
    await expect(result).toHaveAttribute("data-outcome", "partial");
    await expect(result).not.toHaveClass(/border-metric-green/);
  });

  test("resposta degradada (gravou, sem detalhamento): aviso explícito e totais do backend", async ({ page }) => {
    await open(page, BENS_PATH, { role: "ADM", catalogImport: { assetsDegraded: true } });
    const result = await confirmBens(page);
    await expect(page.getByTestId("catalog-import-degraded")).toContainText("Os dados foram gravados");
    await expect(result.locator("[data-stat=Salvos]")).toHaveText("5");
    await expect(page.getByTestId("catalog-import-unwritten")).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
  });

  for (const viewport of RESULT_VIEWPORTS) {
    test(`quadro de resultado sem rolagem horizontal e sem violações axe em ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, BENS_PATH, { role: "ADM", catalogImport: { failures: true } });
      const result = await confirmBens(page);
      await expect(result).toHaveAttribute("data-outcome", "partial");
      await waitForAnimations(page);
      expect(await noHorizontalScroll(page)).toBe(true);
      const box = await result.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

test.describe("cadastros — quadro de resultado responsivo", () => {
  for (const viewport of RESULT_VIEWPORTS) {
    test(`falha total sem rolagem horizontal em ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, CADASTROS_PATH, { role: "ADM", catalogImport: { allFail: true } });
      await generateCatalogPreview(page, "units");
      const dialog = await openConfirm(page, "Confirmar importação de unidades");
      await dialog.getByRole("button", { name: "Confirmar importação" }).click();
      const result = page.getByTestId("catalog-import-result");
      await expect(result).toHaveAttribute("data-outcome", "failure");
      await waitForAnimations(page);
      expect(await noHorizontalScroll(page)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});
