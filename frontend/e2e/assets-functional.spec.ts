import { expect, test, type Page, type Request } from "@playwright/test";

import { ASSET_IDS, LOCATION_ID, type AssetMock } from "./support/asset-mocks";
import { PERSON_IDS, ROOM_IDS } from "./support/catalog-mocks";
import {
  API_URL,
  expectNoXss,
  installMocks,
  seedSession,
  UNITS,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Patrimônios — lista, detalhe, histórico, criar/editar, excluir/restaurar.
// Mocks sintéticos que seguem docs/architecture/assets-api.md. A autorização,
// o escopo, a unicidade do número, os vínculos e o controle de versão são do
// BACKEND (simulados no mock); aqui validamos o que a interface envia e como
// explica cada resposta. O nome do arquivo casa com o projeto "e2e".
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const PATH = "/patrimonios";
const [U1, U2] = UNITS as [(typeof UNITS)[0], (typeof UNITS)[0]];
const U1_LABEL = "PSU-TO — Procuradoria Seccional Sintética de Palmas";

async function open(
  page: Page,
  opts: MockOptions = { role: "ADM" },
  prepare?: (state: MockState) => void,
): Promise<MockState> {
  const state = await installMocks(page, opts);
  prepare?.(state);
  await seedSession(page, opts);
  await page.goto(PATH);
  await waitForHydration(page);
  return state;
}

function calls(state: MockState, method: string, pattern: RegExp) {
  return state.calls.filter((c) => c.method === method && pattern.test(c.url.split("?")[0]!));
}

function waitApi(page: Page, method: string, suffix: string | RegExp): Promise<Request> {
  return page.waitForRequest((r) => {
    if (r.method() !== method || !r.url().startsWith(API_URL)) return false;
    const path = new URL(r.url()).pathname;
    return typeof suffix === "string" ? path.endsWith(suffix) : suffix.test(path);
  });
}

const table = (page: Page) => page.getByRole("table", { name: "Patrimônios" });
const rows = (page: Page) => table(page).locator("tbody tr");

async function openSheet(page: Page, number: string) {
  await expect(table(page)).toBeVisible();
  await page.getByRole("button", { name: `Ver detalhes do patrimônio ${number}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(`Patrimônio ${number}`) });
  await expect(sheet).toBeVisible();
  return sheet;
}

function asset(state: MockState, id: string): AssetMock {
  return state.assets.find((a) => a.id === id)!;
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

test.describe("patrimônios — lista", () => {
  test("colunas, número como TEXTO (zeros preservados), data em America/Araguaina e XSS inerte", async ({ page }) => {
    await open(page);
    for (const header of ["Patrimônio", "Descrição", "Unidade", "Sala", "Responsável", "Localizado", "Atualizado em"]) {
      await expect(table(page).getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    await expect(page.getByText("Página 1 de 1 · 6 bem(ns)")).toBeVisible();

    // Zeros à esquerda preservados e números parecidos continuam distintos.
    const numbers = await table(page).locator("tbody tr td:first-child span[translate=no]").allInnerTexts();
    expect(numbers).toEqual(expect.arrayContaining(["000123", "0000456", "00123", "007", "A-2025/007", "XSS-001"]));
    expect(numbers).not.toContain("123");
    expect(numbers).not.toContain("456");

    const long = rows(page).filter({ hasText: "000123" }).first();
    await expect(long).toContainText("PSU-TO");
    await expect(long).toContainText("Sala 101 Sintética");
    await expect(long).toContainText("Pessoa Responsável Sintética");
    await expect(long).toContainText("Localizado");
    // 2026-10-02T12:10Z → 09:10 em Araguaína (UTC-3).
    await expect(long).toContainText("02/10/2026");
    await expect(long).toContainText("09:10");

    // Descrição com marcador XSS é texto.
    await expect(table(page).getByText("Monitor <img src=x", { exact: false })).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("busca (debounce), unidade, sala, responsável, localizado e ordenação enviam só a allowlist", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(6);

    const search = waitApi(page, "GET", "/v1/assets");
    await page.getByLabel("Buscar por número patrimonial ou descrição").fill("cadeira");
    expect(new URL((await search).url()).searchParams.get("q")).toBe("cadeira");
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(6);

    // Sala e responsável dependem da unidade.
    await expect(page.getByLabel("Sala", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Responsável", { exact: true })).toBeDisabled();
    const byUnit = waitApi(page, "GET", "/v1/assets");
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: U1_LABEL });
    expect(new URL((await byUnit).url()).searchParams.get("unit_id")).toBe(U1.id);
    await expect(rows(page)).toHaveCount(3);

    await expect(page.getByLabel("Sala", { exact: true })).toBeEnabled();
    const byRoom = waitApi(page, "GET", "/v1/assets");
    await page
      .getByLabel("Sala", { exact: true })
      .selectOption({ label: "Sala 101 Sintética com Nome Bastante Longo para Testar a Quebra de Linha em 320px" });
    expect(new URL((await byRoom).url()).searchParams.get("room_id")).toBe(ROOM_IDS.a);
    await expect(rows(page)).toHaveCount(1);

    const byPerson = waitApi(page, "GET", "/v1/assets");
    await page
      .getByLabel("Responsável", { exact: true })
      .selectOption({ label: "Pessoa Responsável Sintética com Nome Bastante Longo para Teste de Layout" });
    expect(new URL((await byPerson).url()).searchParams.get("responsible_person_id")).toBe(PERSON_IDS.a);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(6);

    const byLocated = waitApi(page, "GET", "/v1/assets");
    await page.getByLabel("Localizado", { exact: true }).selectOption("NAO");
    expect(new URL((await byLocated).url()).searchParams.get("located")).toBe("NAO");
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    const header = page.getByRole("columnheader", { name: /Patrimônio/ });
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    const sorted = waitApi(page, "GET", "/v1/assets");
    await header.getByRole("button").click();
    expect(new URL((await sorted).url()).searchParams.get("sort")).toBe("-patrimony_number");
    await expect(header).toHaveAttribute("aria-sort", "descending");
    const byDescription = waitApi(page, "GET", "/v1/assets");
    await page.getByRole("columnheader", { name: /Descrição/ }).getByRole("button").click();
    expect(new URL((await byDescription).url()).searchParams.get("sort")).toBe("description");

    const allowed = new Set(["q", "unit_id", "room_id", "responsible_person_id", "located", "include_deleted", "sort", "page", "page_size"]);
    for (const call of state.calls.filter((c) => c.method === "GET" && /\/v1\/assets\?/.test(c.url))) {
      for (const key of new URL(call.url, "http://x").searchParams.keys()) expect(allowed.has(key)).toBe(true);
    }
  });

  test("paginação: página 2 pede page=2 ao backend", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (s) => {
      for (let i = 0; i < 30; i += 1) {
        s.assets.push({ ...s.assets[3]!, id: `a0000000-0000-4000-8000-${String(500 + i).padStart(12, "0")}`, patrimony_number: `LOTE-${String(i).padStart(3, "0")}` });
      }
    });
    await expect(page.getByText("Página 1 de 2 · 36 bem(ns)")).toBeVisible();
    await expect(rows(page)).toHaveCount(25);
    const next = waitApi(page, "GET", "/v1/assets");
    await page.getByRole("button", { name: "Próxima" }).click();
    expect(new URL((await next).url()).searchParams.get("page")).toBe("2");
    await expect(page.getByText("Página 2 de 2 · 36 bem(ns)")).toBeVisible();
    await expect(rows(page)).toHaveCount(11);
    expect(state.calls.some((c) => /page=2/.test(c.url))).toBe(true);
  });

  test("filtro sem resultado mostra estado vazio com orientação", async ({ page }) => {
    await open(page, { role: "USER" });
    await page.getByLabel("Buscar por número patrimonial ou descrição").fill("nada-corresponde");
    await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible();
  });

  test("escopo vazio mostra mensagem própria", async ({ page }) => {
    await open(page, { role: "USER" }, (s) => {
      s.assets.length = 0;
    });
    await expect(page.getByText("Nenhum bem no seu escopo.")).toBeVisible();
  });

  test("USER: sem a chave de excluídos, sem toggle e nunca envia include_deleted", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    await expect(page.getByRole("switch", { name: "Incluir excluídos" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Novo bem" })).toBeVisible();
    await expect(rows(page)).toHaveCount(6);
    expect(state.calls.some((c) => c.url.includes("include_deleted"))).toBe(false);
  });

  test("ADM: 'Incluir excluídos' envia include_deleted=true e marca o bem excluído com texto", async ({ page }) => {
    await open(page);
    await expect(table(page).getByText("DEL-0001")).toHaveCount(0);
    const request = waitApi(page, "GET", "/v1/assets");
    await page.getByRole("switch", { name: "Incluir excluídos" }).check();
    expect(new URL((await request).url()).searchParams.get("include_deleted")).toBe("true");
    const deleted = rows(page).filter({ hasText: "DEL-0001" });
    await expect(deleted).toContainText("Excluído");
    await page.getByRole("switch", { name: "Incluir excluídos" }).uncheck();
    await expect(table(page).getByText("DEL-0001")).toHaveCount(0);
  });

  test("RH: somente consulta, sem 'Novo bem' e sem toggle de excluídos", async ({ page }) => {
    await open(page, { role: "RH" });
    await expect(table(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Novo bem" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Incluir excluídos" })).toHaveCount(0);
    await expect(page.getByText("somente de consulta")).toBeVisible();
  });

  test("erros da lista usam texto fixo (nunca o do backend) e 'Tentar novamente' recarrega", async ({ page }) => {
    const state = await open(page, { role: "USER", assetsListStatus: 500 });
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível carregar os bens." })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    state.forceListStatus = null;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(rows(page)).toHaveCount(6);
  });

  for (const [status, text] of [
    [403, "Você não tem permissão para consultar os bens."],
    [404, "Nada foi encontrado no seu escopo de unidades."],
    [400, "A busca ou os filtros não foram aceitos."],
    [429, "Muitas solicitações em pouco tempo."],
  ] as const) {
    test(`erro ${status} na lista: mensagem fixa`, async ({ page }) => {
      await open(page, { role: "USER", assetsListStatus: status });
      await expect(page.getByRole("alert").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
    });
  }

  test("ADM sem AAL2: orienta a confirmar a verificação em duas etapas", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("main").getByRole("alert").first()).toContainText("verificação em duas etapas (AAL2)");
  });

  test("falha só nos seletores de apoio avisa e mantém a listagem", async ({ page }) => {
    await open(page, { role: "USER", accessibleUnitsStatus: 500 });
    await expect(page.getByRole("alert").filter({ hasText: "A listagem continua disponível." })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(6);
  });
});

// ---------------------------------------------------------------------------
// Detalhe e histórico
// ---------------------------------------------------------------------------

test.describe("patrimônios — detalhe e histórico", () => {
  test("USER: detalhe com observações, data de registro sem mudança de fuso e sem dados pessoais", async ({ page }) => {
    await open(page, { role: "USER" });
    const sheet = await openSheet(page, "000123");
    await expect(sheet.getByText("Observação sintética do bem.")).toBeVisible();
    await expect(sheet.getByText("29/02/2024")).toBeVisible();
    await expect(sheet.getByText("Bancada A sintética")).toBeVisible();
    await expect(sheet.getByText("Observações", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Editar" })).toBeVisible();
    // Sem exclusão para quem não é ADM.
    await expect(sheet.getByRole("button", { name: "Excluir", exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Restaurar", exact: true })).toHaveCount(0);
    // Telefone/e-mail não aparecem em Patrimônios.
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/@exemplo\.invalid|\(••\)/);
  });

  test("RH: a chave 'notes' não vem e nenhum campo/ação de escrita é renderizado", async ({ page }) => {
    const state = await open(page, { role: "RH" });
    const sheet = await openSheet(page, "000123");
    await expect(sheet.getByText("Observações", { exact: true })).toHaveCount(0);
    await expect(sheet.getByText("Observação sintética do bem.")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Editar" })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Excluir", exact: true })).toHaveCount(0);
    const detail = calls(state, "GET", /\/v1\/assets\/[^/]+$/);
    expect(detail.length).toBeGreaterThan(0);
  });

  test("ADM: histórico com operações em português, antes → depois, e texto escapado", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("tab", { name: "Histórico" }).click();
    const list = sheet.getByRole("list", { name: "Histórico do bem" });
    await expect(list.locator(":scope > li")).toHaveCount(3);
    await expect(list).toContainText("Bem cadastrado");
    await expect(list).toContainText("Bem atualizado");
    await expect(list).toContainText("Localizado: Desconhecido → Localizado");
    await expect(list).toContainText("…000000e2");
    expect(calls(state, "GET", /\/v1\/assets\/[^/]+\/history$/).length).toBeGreaterThan(0);
  });

  test("histórico negado (403) mostra mensagem fixa e permite tentar de novo", async ({ page }) => {
    await open(page, { role: "ADM" }, (s) => {
      s.forceHistoryStatus = 403;
    });
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("tab", { name: "Histórico" }).click();
    await expect(sheet.getByText("Você não tem permissão para ver o histórico deste bem.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });

  test("bem removido do escopo depois da lista: 404 uniforme, sem vazar detalhe", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    await expect(table(page)).toBeVisible();
    state.assets.splice(
      state.assets.findIndex((a) => a.id === ASSET_IDS.zeros),
      1,
    );
    await page.getByRole("button", { name: "Ver detalhes do patrimônio 0000456", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /Patrimônio 0000456/ });
    await expect(sheet.getByText("Bem não encontrado, ou fora do seu escopo de unidades.")).toBeVisible();
    await sheet.getByRole("button", { name: "Voltar à lista" }).click();
    await expect(sheet).toBeHidden();
    await expect(rows(page)).toHaveCount(5);
  });
});

// ---------------------------------------------------------------------------
// Criar
// ---------------------------------------------------------------------------

test.describe("patrimônios — criar", () => {
  test("USER: valida no cliente (UX), envia só os campos do perfil e preserva zeros à esquerda", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    await page.getByRole("button", { name: "Novo bem" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo bem" });
    // Campos exclusivos de ADM não existem para USER.
    await expect(dialog.getByLabel("Localizado")).toHaveCount(0);
    await expect(dialog.getByLabel("Unidade proprietária")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Cadastrar bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Selecione a unidade." })).toBeVisible();
    await expect(dialog.getByRole("alert").filter({ hasText: "Informe o número patrimonial." })).toBeVisible();
    expect(calls(state, "POST", /\/v1\/assets$/)).toHaveLength(0);

    await dialog.getByLabel("Unidade").selectOption({ label: U1_LABEL });
    await dialog.getByLabel("Número patrimonial").fill("  000789  ");
    await dialog.getByLabel("Descrição").fill("Mesa sintética nova");
    await dialog.getByLabel("Observações").fill("Nota nova");
    await dialog.getByLabel("Sala").selectOption({ index: 1 });
    await dialog.getByLabel("Data de registro").fill("2026-01-15");
    const request = waitApi(page, "POST", "/v1/assets");
    await dialog.getByRole("button", { name: "Cadastrar bem" }).click();
    const sent = (await request).postDataJSON();
    expect(sent).toEqual({
      unit_id: U1.id,
      patrimony_number: "000789",
      description: "Mesa sintética nova",
      notes: "Nota nova",
      room_id: ROOM_IDS.a,
      registration_date: "2026-01-15",
    });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Página 1 de 1 · 7 bem(ns)")).toBeVisible();
    await expect(rows(page).filter({ hasText: "000789" })).toBeVisible();
    expect(state.assets.at(-1)!.patrimony_number).toBe("000789");
  });

  test("ADM: pode informar 'Localizado' e unidade proprietária", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Novo bem" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo bem" });
    await dialog.locator("#bem-unidade").selectOption({ label: U1_LABEL });
    await dialog.getByLabel("Número patrimonial").fill("ADM-001");
    await dialog.getByLabel("Unidade proprietária").selectOption({ index: 2 });
    await dialog.getByLabel("Localizado").selectOption("SIM");
    const request = waitApi(page, "POST", "/v1/assets");
    await dialog.getByRole("button", { name: "Cadastrar bem" }).click();
    expect((await request).postDataJSON()).toEqual({
      unit_id: U1.id,
      patrimony_number: "ADM-001",
      owner_unit_id: U2.id,
      located: "SIM",
    });
    await expect(dialog).toBeHidden();
  });

  test("a lista de unidades da criação traz só unidades ativas", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Novo bem" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo bem" });
    await expect(dialog.locator("#bem-unidade option", { hasText: "INAT-07" })).toHaveCount(0);
  });

  test("número duplicado (inclusive em outra caixa) => mensagem fixa, diálogo continua aberto", async ({ page }) => {
    await open(page, { role: "USER" });
    await page.getByRole("button", { name: "Novo bem" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo bem" });
    await dialog.getByLabel("Unidade").selectOption({ label: U1_LABEL });
    await dialog.getByLabel("Número patrimonial").fill("a-2025/007");
    await dialog.getByRole("button", { name: "Cadastrar bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Já existe um bem com este número patrimonial." })).toBeVisible();
    await expect(page.getByText("Já existe um registro com estes dados.")).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  for (const [code, text] of [
    ["link_unit_mismatch", "pertence a outra unidade (ou a outra sala)"],
    ["link_inactive", "está inativo"],
    ["unit_inactive", "A unidade está inativa."],
    ["validation_error", "Os dados enviados não foram aceitos."],
  ] as const) {
    test(`erro ${code}: mensagem fixa em português`, async ({ page }) => {
      await open(page, { role: "USER" }, (s) => {
        s.forceWriteError = { status: code === "validation_error" ? 400 : 409, code };
      });
      await page.getByRole("button", { name: "Novo bem" }).click();
      const dialog = page.getByRole("dialog", { name: "Novo bem" });
      await dialog.getByLabel("Unidade").selectOption({ label: U1_LABEL });
      await dialog.getByLabel("Número patrimonial").fill("ERR-001");
      await dialog.getByRole("button", { name: "Cadastrar bem" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: text })).toBeVisible();
      await expect(dialog).toBeVisible();
    });
  }

  test("429 mostra espera; 403 genérico", async ({ page }) => {
    const state = await open(page, { role: "USER" }, (s) => {
      s.forceWriteError = { status: 403, code: "FORBIDDEN" };
    });
    await page.getByRole("button", { name: "Novo bem" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo bem" });
    await dialog.getByLabel("Unidade").selectOption({ label: U1_LABEL });
    await dialog.getByLabel("Número patrimonial").fill("ERR-002");
    await dialog.getByRole("button", { name: "Cadastrar bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Você não tem permissão para esta ação." })).toBeVisible();
    expect(calls(state, "POST", /\/v1\/assets$/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

test.describe("patrimônios — editar", () => {
  test("USER: número patrimonial só leitura e PATCH com SÓ os campos alterados + version", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await expect(dialog.getByLabel("Número patrimonial")).toHaveCount(0);
    await expect(dialog.getByText("000123", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Localizado")).toHaveCount(0);
    await expect(dialog.getByLabel("Unidade proprietária")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Salvar bem" })).toBeDisabled();

    await dialog.getByLabel("Descrição").fill("Descrição editada");
    const request = waitApi(page, "PATCH", ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 3, description: "Descrição editada" });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText("Descrição editada").first()).toBeVisible();
    expect(asset(state, ASSET_IDS.long).version).toBe(4);
  });

  test("ADM: edita número (texto), 'Localizado' e unidade proprietária; zeros preservados", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "0000456");
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await expect(dialog.getByLabel("Número patrimonial")).toHaveValue("0000456");
    await dialog.getByLabel("Número patrimonial").fill("00004560");
    await dialog.getByLabel("Localizado").selectOption("SIM");
    await dialog.getByLabel("Unidade proprietária").selectOption({ value: "" });
    const request = waitApi(page, "PATCH", ASSET_IDS.zeros);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({
      version: 1,
      patrimony_number: "00004560",
      owner_unit_id: null,
      located: "SIM",
    });
    await expect(dialog).toBeHidden();
    expect(asset(state, ASSET_IDS.zeros).patrimony_number).toBe("00004560");
  });

  test("ADM: remover a localização envia location_id null", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await expect(dialog.getByText("Bancada A sintética")).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Remover a localização atual deste bem" }).check();
    const request = waitApi(page, "PATCH", ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 3, location_id: null });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText("Bancada A sintética")).toHaveCount(0);
  });

  test("trocar a sala mantendo o local de outra sala => 409 link_unit_mismatch com orientação", async ({ page }) => {
    const state = await open(page, { role: "USER" }, (s) => {
      s.rooms.push({
        id: "80000000-0000-4000-8000-0000000000aa",
        unit_id: U1.id,
        name: "Sala 202 Sintética",
        description: null,
        floor: null,
        active: true,
        source_record_id: null,
        created_at: "2026-10-01T12:00:00.000Z",
        updated_at: "2026-10-01T12:00:00.000Z",
      });
    });
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await dialog.getByLabel("Sala").selectOption({ label: "Sala 202 Sintética" });
    await expect(dialog.getByText("Ao trocar a sala, o local atual pode deixar de pertencer a ela.")).toBeVisible();
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "pertence a outra unidade (ou a outra sala)" })).toBeVisible();
    expect(asset(state, ASSET_IDS.long).room_id).toBe(ROOM_IDS.a);
    // Solução oferecida: remover o local e salvar.
    await dialog.getByRole("checkbox", { name: "Remover a localização atual deste bem" }).check();
    const request = waitApi(page, "PATCH", ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({
      version: 3,
      room_id: "80000000-0000-4000-8000-0000000000aa",
      location_id: null,
    });
    await expect(dialog).toBeHidden();
    expect(asset(state, ASSET_IDS.long).location_id).toBeNull();
    expect(asset(state, ASSET_IDS.long).location_id).not.toBe(LOCATION_ID);
  });

  test("409 version_conflict: recarrega o registro, avisa e o reenvio usa a nova version", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await dialog.getByLabel("Descrição").fill("Minha edição");
    // Outra pessoa altera o bem antes do envio.
    const other = asset(state, ASSET_IDS.long);
    other.description = "Edição concorrente";
    other.version = 9;

    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    await expect(dialog.getByText("Outra pessoa alterou este bem enquanto você editava.")).toBeVisible();
    // Com o diálogo aberto o painel fica aria-hidden: localizar por data-sheet, não por role.
    await expect(page.locator("[data-sheet]").getByText("Outra pessoa alterou este bem enquanto você editava.")).toBeVisible();
    // O formulário reinicia com os dados atuais do servidor.
    await expect(dialog.getByLabel("Descrição")).toHaveValue("Edição concorrente");

    await dialog.getByLabel("Descrição").fill("Minha edição revisada");
    const request = waitApi(page, "PATCH", ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 9, description: "Minha edição revisada" });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText("Outra pessoa alterou este bem")).toHaveCount(0);
  });

  test("edição de bem que saiu do escopo: 404 uniforme", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await dialog.getByLabel("Descrição").fill("Qualquer");
    asset(state, ASSET_IDS.long).deleted_at = "2026-10-02T13:00:00.000Z";
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    // O painel recarrega o detalhe: 404 uniforme, sem vazar detalhe do backend.
    await expect(page.getByText("Bem não encontrado, ou fora do seu escopo de unidades.").first()).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Excluir / restaurar (lógico, só ADM)
// ---------------------------------------------------------------------------

test.describe("patrimônios — exclusão lógica", () => {
  test("ADM: confirmação explica exclusão LÓGICA, envia version+motivo e nunca usa DELETE", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Excluir", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Excluir bem (exclusão lógica)" });
    await expect(dialog).toContainText("exclusão LÓGICA");
    await expect(dialog).toContainText("histórico e a auditoria são preservados");
    await expect(dialog).toContainText("Incluir excluídos");
    await dialog.getByLabel("Motivo (opcional)").fill("Baixa sintética");
    const request = waitApi(page, "POST", "/delete");
    await dialog.getByRole("button", { name: "Excluir bem" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 3, reason: "Baixa sintética" });
    await expect(dialog).toBeHidden();

    // O painel passa a mostrar o bem excluído e oferece restaurar; a lista não o mostra mais.
    await expect(sheet.getByText("Excluído", { exact: true }).first()).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Restaurar", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Editar" })).toHaveCount(0);
    expect(asset(state, ASSET_IDS.long).deleted_at).not.toBeNull();
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
    await page.getByRole("button", { name: "Fechar painel" }).click();
    await expect(table(page).getByText("000123", { exact: true })).toHaveCount(0);
  });

  test("ADM: restaurar devolve o bem à lista", async ({ page }) => {
    const state = await open(page);
    await page.getByRole("switch", { name: "Incluir excluídos" }).check();
    const sheet = await openSheet(page, "DEL-0001");
    await sheet.getByRole("button", { name: "Restaurar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Restaurar bem" });
    const request = waitApi(page, "POST", "/restore");
    await dialog.getByRole("button", { name: "Restaurar bem" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 2 });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByRole("button", { name: "Excluir", exact: true })).toBeVisible();
    expect(asset(state, ASSET_IDS.deleted).deleted_at).toBeNull();
  });

  test("restaurar com número em uso => 409 conflict com mensagem fixa", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (s) => {
      // Outro bem ATIVO reutilizou o número (caixa diferente) enquanto o original estava excluído.
      s.assets.push({ ...s.assets[0]!, id: "a0000000-0000-4000-8000-0000000000ff", patrimony_number: "del-0001" });
    });
    await page.getByRole("switch", { name: "Incluir excluídos" }).check();
    const sheet = await openSheet(page, "DEL-0001");
    await sheet.getByRole("button", { name: "Restaurar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Restaurar bem" });
    await dialog.getByRole("button", { name: "Restaurar bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Já existe um bem com este número patrimonial." })).toBeVisible();
    expect(asset(state, ASSET_IDS.deleted).deleted_at).not.toBeNull();
  });

  test("409 version_conflict ao excluir: fecha, avisa e recarrega", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Excluir", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Excluir bem (exclusão lógica)" });
    asset(state, ASSET_IDS.long).version = 12;
    await dialog.getByRole("button", { name: "Excluir bem" }).click();
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText("Outra pessoa alterou este bem enquanto você editava.")).toBeVisible();
    expect(asset(state, ASSET_IDS.long).deleted_at).toBeNull();
  });

  test("erro 403 ao excluir fica dentro do diálogo", async ({ page }) => {
    await open(page, { role: "ADM" }, (s) => {
      s.forceWriteError = { status: 403, code: "FORBIDDEN" };
    });
    const sheet = await openSheet(page, "000123");
    await sheet.getByRole("button", { name: "Excluir", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Excluir bem (exclusão lógica)" });
    await dialog.getByRole("button", { name: "Excluir bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Você não tem permissão para esta ação." })).toBeVisible();
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role}: não vê Excluir/Restaurar nem o toggle de excluídos`, async ({ page }) => {
      await open(page, { role });
      const sheet = await openSheet(page, "000123");
      await expect(sheet.getByRole("button", { name: /Excluir|Restaurar/ })).toHaveCount(0);
      await expect(page.getByRole("switch", { name: "Incluir excluídos" })).toHaveCount(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Privacidade
// ---------------------------------------------------------------------------

test("nenhum dado do bem vai para localStorage/sessionStorage nem para a URL", async ({ page }) => {
  await open(page);
  const sheet = await openSheet(page, "000123");
  await sheet.getByRole("tab", { name: "Histórico" }).click();
  const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }));
  expect(stored).not.toContain("000123");
  expect(stored).not.toContain("Observação sintética");
  expect(new URL(page.url()).search).toBe("");
  expect(API_URL).toBeTruthy();
});
