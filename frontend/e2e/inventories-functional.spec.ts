import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { ASSET_IDS, type AssetMock } from "./support/asset-mocks";
import { INV_LOCATION_IDS, INVENTORY_IDS, type InventoryMock } from "./support/inventory-mocks";
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
// Inventários — lista, detalhe (resumo calculado no servidor, itens conferidos,
// bens da unidade), criar, iniciar/encerrar/cancelar e conferir bem.
// Mocks sintéticos que seguem docs/architecture/inventories-api.md. A autorização,
// o escopo, os estados, a política de 1 conferência por bem e o resultado derivado
// são do BACKEND (simulados no mock); aqui validamos o que a interface envia e como
// explica cada resposta. O nome do arquivo casa com o projeto "e2e".
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const PATH = "/inventarios";
const [U1, U2] = UNITS as [(typeof UNITS)[0], (typeof UNITS)[0]];
const U1_LABEL = "PSU-TO — Procuradoria Seccional Sintética de Palmas";
const OPEN_NAME = "Inventário PSU-TO ainda aberto";
const RUNNING_NAME = "Inventário Anual PSU-TO com um nome bastante longo para testar a quebra de linha em 320px";
const FULL_NAME = "Inventário ESC-02 em andamento";
const DONE_NAME = "Inventário NUC-03 concluído";

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

function waitApi(page: Page, method: string, suffix: string | RegExp): Promise<Request> {
  return page.waitForRequest((r) => {
    if (r.method() !== method || !r.url().startsWith(API_URL)) return false;
    const path = new URL(r.url()).pathname;
    return typeof suffix === "string" ? path.endsWith(suffix) : suffix.test(path);
  });
}

const table = (page: Page) => page.getByRole("table", { name: "Inventários" });
const rows = (page: Page) => table(page).locator("tbody tr");

/** Acrescenta `count` inventários no escopo (clones do 1º do mock com ids únicos). */
function seedInventories(state: MockState, count: number) {
  const template = state.inventories[0]!;
  for (let i = 0; i < count; i += 1) {
    state.inventories.push({ ...template, id: `e4000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
  }
}

function inventory(state: MockState, id: string): InventoryMock {
  return state.inventories.find((i) => i.id === id)!;
}

function asset(state: MockState, id: string): AssetMock {
  return state.assets.find((a) => a.id === id)!;
}

async function openSheet(page: Page, name: string, status: string): Promise<Locator> {
  await expect(table(page)).toBeVisible();
  await page.getByRole("button", { name: `Ver detalhes do inventário ${name}, ${status}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `Inventário ${name}`, exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("inventory-summary")).toBeVisible();
  return sheet;
}

async function goToAssets(sheet: Locator): Promise<Locator> {
  await sheet.getByRole("tab", { name: "Bens da unidade" }).click();
  const list = sheet.getByRole("list", { name: "Bens da unidade" });
  await expect(list).toBeVisible();
  return list;
}

/** Abre o diálogo de conferência de um bem do inventário em andamento da PSU-TO. */
async function startCheck(page: Page, number: string): Promise<{ sheet: Locator; dialog: Locator }> {
  const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
  await goToAssets(sheet);
  await sheet.getByRole("button", { name: `Conferir o patrimônio ${number}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Conferir bem" });
  await expect(dialog).toBeVisible();
  return { sheet, dialog };
}

const metric = (sheet: Locator, id: string) => sheet.getByTestId(`metric-${id}`).locator("dd");

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

test.describe("inventários — lista", () => {
  test("colunas, estado com ícone+texto, datas em America/Araguaina e escopo", async ({ page }) => {
    await open(page);
    for (const header of ["Inventário", "Unidade", "Estado", "Início", "Criado em"]) {
      await expect(table(page).getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    // 6 inventários no mock, 1 totalmente fora do escopo (nunca aparece).
    await expect(page.getByText("Exibindo 1–5 de 5 inventário(s)")).toBeVisible();
    await expect(rows(page)).toHaveCount(5);

    const running = rows(page).filter({ hasText: "Inventário Anual PSU-TO" });
    await expect(running).toContainText("PSU-TO");
    await expect(running).toContainText("Em andamento");
    await expect(running).toContainText("01/10/2026");
    // 2026-09-29T12:00Z → 09:00 em Araguaína (UTC-3).
    await expect(running).toContainText("29/09/2026");
    await expect(running).toContainText("09:00");
    for (const status of ["Aberto", "Em andamento", "Concluído", "Cancelado"]) {
      await expect(table(page).getByText(status, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    }
    // Mais recentes primeiro (padrão do backend).
    await expect(rows(page).first()).toContainText("Inventário cancelado");
    // Imutável: sem editar/excluir.
    await expect(page.getByRole("button", { name: /Editar|Excluir/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Novo inventário" })).toBeVisible();
    // O nome com marcação HTML é texto inerte.
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("filtros, busca e ordenação enviam só a allowlist e voltam à página 1", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(5);

    const byStatus = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Estado", { exact: true }).selectOption("EM_ANDAMENTO");
    expect(new URL((await byStatus).url()).searchParams.get("status")).toBe("EM_ANDAMENTO");
    await expect(rows(page)).toHaveCount(2);

    const byUnit = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: U1_LABEL });
    expect(new URL((await byUnit).url()).searchParams.get("unit_id")).toBe(U1.id);
    await expect(rows(page)).toHaveCount(1);

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(5);

    const bySearch = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Buscar inventário por nome").fill("ESC-02");
    expect(new URL((await bySearch).url()).searchParams.get("q")).toBe("ESC-02");
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    const bySort = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Ordenar por").selectOption("created_at");
    expect(new URL((await bySort).url()).searchParams.get("sort")).toBe("created_at");
    await expect(rows(page).first()).toContainText("Inventário PSU-TO ainda aberto");
  });

  test("ordenação pelos cabeçalhos usa aria-sort e a allowlist", async ({ page }) => {
    await open(page);
    const head = table(page).getByRole("columnheader", { name: /Estado/ });
    await expect(head).toHaveAttribute("aria-sort", "none");
    const request = waitApi(page, "GET", "/v1/inventories");
    await head.getByRole("button").click();
    expect(new URL((await request).url()).searchParams.get("sort")).toBe("status");
    await expect(head).toHaveAttribute("aria-sort", "ascending");
  });

  test("estado vazio com e sem filtro", async ({ page }) => {
    await open(page, { role: "USER" });
    await page.getByLabel("Buscar inventário por nome").fill("nada-corresponde");
    await expect(page.getByText("Nenhum inventário encontrado para os filtros atuais.")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(5);
  });

  test("lista vazia no escopo (sem filtro)", async ({ page }) => {
    await open(page, { role: "USER" }, (state) => {
      state.inventories = [];
    });
    await expect(page.getByText("Nenhum inventário no seu escopo.")).toBeVisible();
  });

  const LIST_ERRORS: [number, string][] = [
    [500, "Não foi possível carregar os inventários."],
    [403, "Você não tem permissão para consultar os inventários."],
    [404, "Nada foi encontrado no seu escopo de unidades."],
  ];
  for (const [status, message] of LIST_ERRORS) {
    test(`erro ${status} da listagem: mensagem fixa, sem eco do backend`, async ({ page }) => {
      const state = await open(page, { role: "USER", inventoriesListStatus: status });
      await expect(page.getByRole("main").getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
      if (status === 500) {
        state.forceInventoryListStatus = null;
        await page.getByRole("button", { name: "Tentar novamente" }).click();
        await expect(rows(page)).toHaveCount(5);
      }
    });
  }

  test("ADM sem AAL2: orienta a confirmar a verificação em duas etapas", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("main").getByRole("alert").first()).toContainText("verificação em duas etapas (AAL2)");
  });

  test("paginação 50/100/200: total do backend, troca de tamanho volta à página 1", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (s) => seedInventories(s, 125));
    // 5 no escopo + 125 = 130.
    await expect(page.getByText("Exibindo 1–50 de 130 inventário(s)")).toBeVisible();
    await expect(rows(page)).toHaveCount(50);
    const bar = page.getByRole("navigation", { name: "Paginação" });
    await expect(bar.getByLabel("Registros por página")).toHaveValue("50");

    const next = waitApi(page, "GET", "/v1/inventories");
    await bar.getByRole("button", { name: "Próxima" }).click();
    const nextParams = new URL((await next).url()).searchParams;
    expect(nextParams.get("page")).toBe("2");
    expect(nextParams.get("page_size")).toBe("50");
    await expect(page.getByText("Exibindo 51–100 de 130 inventário(s)")).toBeVisible();

    await bar.getByRole("button", { name: "Última" }).click();
    await expect(page.getByText("Exibindo 101–130 de 130 inventário(s)")).toBeVisible();
    await expect(rows(page)).toHaveCount(30);

    const bigger = waitApi(page, "GET", "/v1/inventories");
    await bar.getByLabel("Registros por página").selectOption("100");
    const params = new URL((await bigger).url()).searchParams;
    expect(params.get("page_size")).toBe("100");
    expect(params.get("page")).toBe("1");
    await expect(rows(page)).toHaveCount(100);

    await bar.getByLabel("Registros por página").selectOption("200");
    await expect(page.getByText("Exibindo 1–130 de 130 inventário(s)")).toBeVisible();
    await expect(rows(page)).toHaveCount(130);

    const sizes = state.calls
      .filter((c) => c.method === "GET")
      .map((c) => new URL(c.url, "http://x").searchParams.get("page_size"))
      .filter((v): v is string => v !== null);
    for (const size of sizes) expect(["50", "100", "200"]).toContain(size);
  });

  test("zebra: linhas pares têm fundo próprio e as ímpares não", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(5);
    await page.mouse.move(0, 0);
    const background = (index: number) =>
      rows(page).nth(index).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await background(0)).toBe("rgba(0, 0, 0, 0)");
    expect(await background(1)).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("busca (aparada), estado, unidade e ordenação enviam só a allowlist e voltam à página 1", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (s) => seedInventories(s, 125));
    const bar = page.getByRole("navigation", { name: "Paginação" });
    await expect(page.getByText("Exibindo 1–50 de 130 inventário(s)")).toBeVisible();
    await bar.getByRole("button", { name: "Próxima" }).click();
    await expect(page.getByText("Exibindo 51–100 de 130 inventário(s)")).toBeVisible();

    // Só espaços: não vira filtro nem muda a página.
    await page.getByLabel("Buscar inventário por nome").fill("   ");
    await page.waitForTimeout(600);
    await expect(page.getByText("Exibindo 51–100 de 130 inventário(s)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);
    await expect(page.getByLabel("Buscar inventário por nome")).toHaveAttribute("maxlength", "100");

    const search = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Buscar inventário por nome").fill("  Anual  ");
    const searchParams = new URL((await search).url()).searchParams;
    expect(searchParams.get("q")).toBe("Anual");
    expect(searchParams.get("page")).toBe("1");
    await expect(rows(page)).toHaveCount(1);

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.getByText("Exibindo 1–50 de 130 inventário(s)")).toBeVisible();

    const byStatus = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Estado", { exact: true }).selectOption("EM_ANDAMENTO");
    const statusParams = new URL((await byStatus).url()).searchParams;
    expect(statusParams.get("status")).toBe("EM_ANDAMENTO");
    expect(statusParams.get("page")).toBe("1");

    const byUnit = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: U1_LABEL });
    expect(new URL((await byUnit).url()).searchParams.get("unit_id")).toBe(U1.id);

    const bySort = waitApi(page, "GET", "/v1/inventories");
    await page.getByLabel("Ordenar por").selectOption("name");
    expect(new URL((await bySort).url()).searchParams.get("sort")).toBe("name");

    const allowed = new Set(["q", "unit_id", "status", "sort", "page", "page_size"]);
    for (const call of state.calls.filter((c) => c.method === "GET" && /\/v1\/inventories\?/.test(c.url))) {
      for (const key of new URL(call.url, "http://x").searchParams.keys()) expect(allowed.has(key)).toBe(true);
    }
  });

  test("itens conferidos e bens da unidade usam PaginationBar (50/100/200)", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (s) => {
      for (let i = 0; i < 55; i += 1) {
        s.inventoryItems.push({
          id: `e5000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          inventory_id: INVENTORY_IDS.running,
          asset_id: ASSET_IDS.zeros,
          found: true,
          observed_location_id: null,
          checked_by: "00000000-0000-4000-8000-0000000000e2",
          checked_at: new Date(Date.UTC(2026, 9, 5, 12, i)).toISOString(),
          notes: null,
        });
      }
    });
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await expect(sheet.getByText(/Exibindo 1–50 de \d+ conferência\(s\)/)).toBeVisible();
    const items = sheet.getByRole("list", { name: "Itens conferidos" });
    await expect(items.locator(":scope > li")).toHaveCount(50);
    const next = waitApi(page, "GET", /\/v1\/inventories\/[^/]+\/items$/);
    await sheet.getByRole("button", { name: "Próxima" }).click();
    const params = new URL((await next).url()).searchParams;
    expect(params.get("page")).toBe("2");
    expect(params.get("page_size")).toBe("50");

    await sheet.getByRole("tab", { name: "Bens da unidade" }).click();
    await expect(sheet.getByRole("list", { name: "Bens da unidade" })).toBeVisible();
    await expect(sheet.getByText(/Exibindo 1–\d+ de \d+ bem\(ns\)/)).toBeVisible();
    await expect(sheet.getByLabel("Registros por página")).toHaveValue("50");

    for (const call of state.calls.filter((c) => c.method === "GET")) {
      const size = new URL(call.url, "http://x").searchParams.get("page_size");
      if (size !== null) expect(["50", "100", "200"]).toContain(size);
    }
  });

  for (const width of [320, 375]) {
    test(`lista com paginação sem rolagem horizontal da página a ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, { role: "ADM" }, (s) => seedInventories(s, 60));
      await expect(page.getByText("Exibindo 1–50 de 65 inventário(s)")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Paginação" }).getByLabel("Registros por página")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("USER: lista sem o botão de criar e com texto explicativo", async ({ page }) => {
    await open(page, { role: "USER" });
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Novo inventário" })).toHaveCount(0);
    await expect(page.getByText("criar, iniciar, encerrar e cancelar são ações de administrador")).toBeVisible();
  });

  test("RH não vê inventários: mensagem fixa e nenhuma chamada de dados", async ({ page }) => {
    const state = await open(page, { role: "RH" });
    await expect(page.getByTestId("access-restricted")).toContainText("Seu perfil (RH) não tem acesso aos inventários");
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Novo inventário" })).toHaveCount(0);
    const dataCalls = state.calls.filter((c) => /\/v1\/(inventories|locations|assets|units\/accessible)/.test(c.url));
    expect(dataCalls).toEqual([]);
    // Mesmo forçando a chamada, o mock (como o backend) responde 403 ao RH.
    const status = await page.evaluate(
      async ({ url }) => (await fetch(url, { headers: { authorization: "Bearer e2e" } })).status,
      { url: `${API_URL}/v1/inventories` },
    );
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

test.describe("inventários — detalhe", () => {
  test("em andamento: resumo calculado no servidor, barra = progress_percent e itens conferidos", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await expect(metric(sheet, "total")).toHaveText("3");
    await expect(metric(sheet, "checked")).toHaveText("1");
    await expect(metric(sheet, "pending")).toHaveText("2");
    await expect(metric(sheet, "found")).toHaveText("1");
    await expect(metric(sheet, "not-found")).toHaveText("0");
    await expect(metric(sheet, "divergent")).toHaveText("0");
    const bar = sheet.getByRole("progressbar", { name: "Progresso da conferência" });
    await expect(bar).toHaveAttribute("aria-valuenow", "33.3");
    await expect(sheet.getByTestId("progress-text")).toHaveText("33.3% conferido");
    await expect(sheet.getByText("Números calculados pelo servidor", { exact: false })).toBeVisible();

    // O percentual exibido vem do servidor: muda quando o servidor muda.
    const summary = state.calls.filter((c) => c.url.endsWith(`/${INVENTORY_IDS.running}/summary`));
    expect(summary.length).toBeGreaterThan(0);

    const items = sheet.getByRole("list", { name: "Itens conferidos" });
    await expect(items).toContainText("000123");
    await expect(items).toContainText("Encontrado");
    await expect(items).toContainText("Conferido na bancada.");
    await expect(items).toContainText("Local observado: Bancada A sintética");
    await expect(items).toContainText("Conferidor (identificador)");
    // Ações do ADM no estado EM_ANDAMENTO: encerrar e cancelar; nunca iniciar.
    await expect(sheet.getByRole("button", { name: "Encerrar", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancelar inventário", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Iniciar", exact: true })).toHaveCount(0);
    // Imutável e sem alterar o bem.
    await expect(sheet.getByText("NÃO altera o campo “Localizado”", { exact: false })).toBeVisible();
    await expect(sheet.getByText("Histórico imutável", { exact: false })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /Editar|Excluir/ })).toHaveCount(0);
  });

  test("aberto: só iniciar e cancelar; avisa que conferências exigem iniciar e não oferece Conferir", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, OPEN_NAME, "Aberto");
    await expect(metric(sheet, "checked")).toHaveText("0");
    await expect(sheet.getByTestId("progress-text")).toHaveText("0% conferido");
    await expect(sheet.getByRole("button", { name: "Iniciar", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancelar inventário", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Encerrar", exact: true })).toHaveCount(0);
    await expect(sheet.getByTestId("checks-closed-note")).toContainText("só são aceitas depois que o inventário for iniciado");
    await expect(sheet.getByTestId("items-empty")).toContainText("Nenhum bem foi conferido");
    await goToAssets(sheet);
    await expect(sheet.getByRole("button", { name: /^Conferir o patrimônio/ })).toHaveCount(0);
    await expect(sheet.getByText("Pendente", { exact: true }).first()).toBeVisible();
  });

  test("resultados derivados: não encontrado e divergente, filtro por resultado e texto inerte", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, FULL_NAME, "Em andamento");
    await expect(metric(sheet, "checked")).toHaveText("2");
    await expect(metric(sheet, "pending")).toHaveText("0");
    await expect(metric(sheet, "not-found")).toHaveText("1");
    await expect(metric(sheet, "divergent")).toHaveText("1");
    await expect(sheet.getByTestId("progress-text")).toHaveText("100% conferido");

    const items = sheet.getByRole("list", { name: "Itens conferidos" });
    await expect(items).toContainText("Não encontrado");
    await expect(items).toContainText("Divergente");
    await expect(items).toContainText("Nota <img src=x");
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });

    const request = waitApi(page, "GET", `/v1/inventories/${INVENTORY_IDS.runningFull}/items`);
    await sheet.getByLabel("Resultado", { exact: true }).selectOption("DIVERGENTE");
    expect(new URL((await request).url()).searchParams.get("result")).toBe("DIVERGENTE");
    await expect(items.locator("li")).toHaveCount(1);
    await expect(items).toContainText("A-2025/007");
    await expect(items).toContainText("Local observado: Local <img src=x");
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
    // Sem pendentes: nada a conferir, e o texto de pendência não existe.
    await goToAssets(sheet);
    await expect(sheet.getByRole("button", { name: /^Conferir o patrimônio/ })).toHaveCount(0);
  });

  test("encerrado: sem ações nem Conferir, explica a imutabilidade", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, DONE_NAME, "Concluído");
    await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
    await expect(sheet.getByText("Encerrado em")).toBeVisible();
    await expect(sheet.getByText("Término")).toBeVisible();
    await expect(sheet.getByTestId("checks-closed-note")).toContainText("não aceita novas conferências");
    await expect(sheet.getByText("definitiva e imutável", { exact: false })).toBeVisible();
    await expect(sheet.getByTestId("progress-text")).toHaveText("100% conferido");
  });

  test("cancelado: sem ações; rótulo 'Cancelado em'", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, `Inventário cancelado <img src=x onerror="window.__xss=1">`, "Cancelado");
    await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
    await expect(sheet.getByText("Cancelado em")).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("USER: vê o resumo e confere, mas nunca iniciar/encerrar/cancelar", async ({ page }) => {
    await open(page, { role: "USER" });
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
    await goToAssets(sheet);
    await expect(sheet.getByRole("button", { name: "Conferir o patrimônio 0000456", exact: true })).toBeVisible();
  });

  test("inventário que saiu do escopo: 404 uniforme, sem eco do backend", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(5);
    state.inventories = state.inventories.filter((i) => i.id !== INVENTORY_IDS.running);
    await page
      .getByRole("button", { name: `Ver detalhes do inventário ${RUNNING_NAME}, Em andamento`, exact: true })
      .click();
    const sheet = page.getByRole("dialog", { name: `Inventário ${RUNNING_NAME}`, exact: true });
    await expect(sheet.getByText("Inventário não encontrado, ou fora do seu escopo de unidades.")).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Voltar à lista" }).click();
    await expect(rows(page)).toHaveCount(4);
  });

  test("falha ao carregar os itens: mensagem fixa e nova tentativa", async ({ page }) => {
    const state = await open(page);
    state.forceInventoryItemsStatus = 500;
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await expect(sheet.getByRole("alert").filter({ hasText: "Não foi possível carregar as conferências." })).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    state.forceInventoryItemsStatus = null;
    await sheet.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(sheet.getByRole("list", { name: "Itens conferidos" })).toBeVisible();
  });

  test("bens da unidade: pendentes e conferidos, busca com debounce e ocultar conferidos", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    const list = await goToAssets(sheet);
    await expect(list.locator("li")).toHaveCount(3);
    await expect(list.locator("li").filter({ hasText: "000123" })).toContainText("Encontrado");
    await expect(list.locator("li").filter({ hasText: "000123" }).getByRole("button")).toHaveCount(0);
    await expect(list.locator("li").filter({ hasText: "0000456" })).toContainText("Pendente");
    // A lista é da unidade do inventário (escopo do servidor): o bem de outra unidade não aparece.
    await expect(list).not.toContainText("XSS-001");
    const calls = state.calls.filter((c) => c.url.includes("/v1/assets?") && c.url.includes(`unit_id=${U1.id}`));
    expect(calls.length).toBeGreaterThan(0);

    await sheet.getByRole("switch", { name: "Ocultar bens já conferidos" }).check();
    await expect(list.locator("li")).toHaveCount(2);
    await expect(list).not.toContainText("000123");
    await sheet.getByRole("switch", { name: "Ocultar bens já conferidos" }).uncheck();

    const request = page.waitForRequest((r) => r.url().includes("/v1/assets?") && r.url().includes("q=cadeira"));
    await sheet.getByLabel("Buscar bem da unidade por número patrimonial ou descrição").fill("cadeira");
    expect(new URL((await request).url()).searchParams.get("q")).toBe("cadeira");
    await expect(list.locator("li")).toHaveCount(1);
    await expect(list).toContainText("0000456");
  });
});

// ---------------------------------------------------------------------------
// Criar
// ---------------------------------------------------------------------------

test.describe("inventários — criar", () => {
  test("ADM cria por unidade: corpo mínimo, nasce ABERTO e aparece na lista", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(5);
    await page.getByRole("button", { name: "Novo inventário" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo inventário" });
    await expect(dialog).toContainText("não podem ser editados depois");
    // Só unidades ATIVAS (INAT-07 não é oferecida).
    await expect(dialog.getByRole("option", { name: /INAT-07/ })).toHaveCount(0);
    await dialog.getByLabel("Nome", { exact: false }).first().fill("  Inventário   de teste  ");
    await dialog.getByLabel("Unidade", { exact: false }).selectOption({ label: U1_LABEL });
    const request = waitApi(page, "POST", "/v1/inventories");
    await dialog.getByRole("button", { name: "Criar inventário" }).click();
    // Sem data: o servidor usa hoje. Sem status/created_by: nada privilegiado vai do cliente.
    expect((await request).postDataJSON()).toEqual({ name: "Inventário   de teste", unit_id: U1.id });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Inventário criado. Ele só aceita conferências depois de iniciado.")).toBeVisible();
    await expect(page.getByText("Exibindo 1–6 de 6 inventário(s)")).toBeVisible();
    await expect(rows(page).first()).toContainText("Inventário de teste");
    await expect(rows(page).first()).toContainText("Aberto");
    expect(state.inventories.at(-1)).toMatchObject({ status: "ABERTO", unit_id: U1.id });
  });

  test("envia a data de início quando informada", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Novo inventário" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo inventário" });
    await dialog.getByLabel("Nome", { exact: false }).first().fill("Com data");
    await dialog.getByLabel("Unidade", { exact: false }).selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    await dialog.getByLabel("Data de início (opcional)").fill("2026-11-01");
    const request = waitApi(page, "POST", "/v1/inventories");
    await dialog.getByRole("button", { name: "Criar inventário" }).click();
    expect((await request).postDataJSON()).toEqual({ name: "Com data", unit_id: U2.id, start_date: "2026-11-01" });
    await expect(dialog).toBeHidden();
  });

  test("campos obrigatórios: nome e unidade, sem chamada de escrita", async ({ page }) => {
    const state = await open(page);
    await page.getByRole("button", { name: "Novo inventário" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo inventário" });
    await dialog.getByRole("button", { name: "Criar inventário" }).click();
    await expect(dialog.getByText("Informe o nome do inventário.")).toBeVisible();
    await dialog.getByLabel("Nome", { exact: false }).first().fill("Só o nome");
    await dialog.getByRole("button", { name: "Criar inventário" }).click();
    await expect(dialog.getByText("Escolha a unidade do inventário.")).toBeVisible();
    expect(state.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/inventories"))).toHaveLength(0);
  });

  const CREATE_ERRORS: [number, string, string][] = [
    [409, "unit_inactive", "A unidade está inativa"],
    [404, "not_found", "Inventário não encontrado, ou fora do seu escopo"],
    [403, "forbidden", "Você não tem permissão para esta ação"],
    [400, "validation_error", "Os dados enviados não foram aceitos"],
    [429, "rate_limited", "Muitas solicitações em pouco tempo"],
    [403, "AAL2_REQUIRED", "verificação em duas etapas (AAL2)"],
  ];
  for (const [status, code, snippet] of CREATE_ERRORS) {
    test(`erro ${status} ${code}: mensagem fixa, sem eco do backend`, async ({ page }) => {
      const state = await open(page);
      await page.getByRole("button", { name: "Novo inventário" }).click();
      const dialog = page.getByRole("dialog", { name: "Novo inventário" });
      await dialog.getByLabel("Nome", { exact: false }).first().fill("Falha");
      await dialog.getByLabel("Unidade", { exact: false }).selectOption({ label: U1_LABEL });
      state.forceInventoryWriteError = { status, code };
      await dialog.getByRole("button", { name: "Criar inventário" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: snippet })).toBeVisible();
      await expect(page.getByText("erro sintético")).toHaveCount(0);
      await expect(dialog).toBeVisible();
    });
  }

  test("USER nunca vê o botão de criar; o backend (mock) também nega com 403", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    await expect(page.getByRole("button", { name: "Novo inventário" })).toHaveCount(0);
    const status = await page.evaluate(
      async ({ url, unit }) =>
        (
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer e2e" },
            body: JSON.stringify({ name: "x", unit_id: unit }),
          })
        ).status,
      { url: `${API_URL}/v1/inventories`, unit: U1.id },
    );
    expect(status).toBe(403);
    expect(state.inventories).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Iniciar, encerrar e cancelar
// ---------------------------------------------------------------------------

test.describe("inventários — iniciar, encerrar e cancelar", () => {
  test("iniciar: explica o efeito, envia corpo vazio e passa a aceitar conferências", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, OPEN_NAME, "Aberto");
    await sheet.getByRole("button", { name: "Iniciar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Iniciar inventário" });
    await expect(dialog).toContainText("EM ANDAMENTO");
    await expect(dialog).toContainText("A transição é única");
    const request = waitApi(page, "POST", `/v1/inventories/${INVENTORY_IDS.open}/start`);
    await dialog.getByRole("button", { name: "Iniciar inventário" }).click();
    expect((await request).postDataJSON()).toEqual({});
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Inventário iniciado. Já aceita conferências.")).toBeVisible();
    expect(inventory(state, INVENTORY_IDS.open).status).toBe("EM_ANDAMENTO");
    await expect(sheet.getByRole("button", { name: "Encerrar", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Iniciar", exact: true })).toHaveCount(0);
    await goToAssets(sheet);
    await expect(sheet.getByRole("button", { name: /^Conferir o patrimônio/ }).first()).toBeVisible();
  });

  test("encerrar: avisa que é DEFINITIVO e IMUTÁVEL, envia o motivo e remove todas as ações", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await sheet.getByRole("button", { name: "Encerrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Encerrar inventário" });
    await expect(dialog).toContainText("DEFINITIVO");
    await expect(dialog).toContainText("IMUTÁVEL");
    await expect(dialog).toContainText("não pode ser reaberto");
    await expect(dialog).toContainText("não altera os bens");
    await dialog.getByLabel("Motivo (opcional)").fill("Conferência concluída.");
    const request = waitApi(page, "POST", `/v1/inventories/${INVENTORY_IDS.running}/close`);
    await dialog.getByRole("button", { name: "Encerrar definitivamente" }).click();
    expect((await request).postDataJSON()).toEqual({ reason: "Conferência concluída." });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Inventário encerrado. Ele agora é imutável.")).toBeVisible();
    expect(inventory(state, INVENTORY_IDS.running)).toMatchObject({ status: "CONCLUIDO" });
    expect(inventory(state, INVENTORY_IDS.running).closed_at).not.toBeNull();
    await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
    await expect(sheet.getByText("Encerrado em")).toBeVisible();
    await goToAssets(sheet);
    await expect(sheet.getByRole("button", { name: /^Conferir o patrimônio/ })).toHaveCount(0);
  });

  test("cancelar: definitivo, corpo vazio; as conferências feitas permanecem", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await sheet.getByRole("button", { name: "Cancelar inventário", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cancelar inventário" });
    await expect(dialog).toContainText("CANCELADO");
    await expect(dialog).toContainText("as conferências já feitas permanecem registradas");
    const request = waitApi(page, "POST", `/v1/inventories/${INVENTORY_IDS.running}/cancel`);
    await dialog.getByRole("button", { name: "Cancelar definitivamente" }).click();
    expect((await request).postDataJSON()).toEqual({});
    await expect(dialog).toBeHidden();
    expect(inventory(state, INVENTORY_IDS.running).status).toBe("CANCELADO");
    expect(state.inventoryItems.filter((i) => i.inventory_id === INVENTORY_IDS.running)).toHaveLength(1);
    await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
    await expect(sheet.getByText("Cancelado em")).toBeVisible();
  });

  test("409 invalid_transition (outra pessoa já encerrou): fecha, avisa e recarrega o estado", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await sheet.getByRole("button", { name: "Encerrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Encerrar inventário" });
    inventory(state, INVENTORY_IDS.running).status = "CONCLUIDO";
    await dialog.getByRole("button", { name: "Encerrar definitivamente" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Esta ação não é permitida no estado atual do inventário", { exact: false }).first()).toBeVisible();
    await expect(sheet.getByText("Este inventário mudou desde que foi carregado", { exact: false })).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
  });

  test("iniciar um inventário já encerrado no servidor: invalid_transition, sem mudar nada", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, OPEN_NAME, "Aberto");
    await sheet.getByRole("button", { name: "Iniciar", exact: true }).click();
    inventory(state, INVENTORY_IDS.open).status = "CANCELADO";
    await page.getByRole("dialog", { name: "Iniciar inventário" }).getByRole("button", { name: "Iniciar inventário" }).click();
    await expect(sheet.getByText("Este inventário mudou desde que foi carregado", { exact: false })).toBeVisible();
    expect(inventory(state, INVENTORY_IDS.open).status).toBe("CANCELADO");
  });

  const WRITE_ERRORS: [number, string, string][] = [
    [403, "forbidden", "Você não tem permissão para esta ação"],
    [400, "validation_error", "Os dados enviados não foram aceitos"],
    [429, "rate_limited", "Muitas solicitações em pouco tempo"],
    [403, "AAL2_REQUIRED", "verificação em duas etapas (AAL2)"],
    [409, "conflict", "conflito com outra operação"],
    [500, "INTERNAL", "Não foi possível iniciar o inventário agora"],
  ];
  for (const [status, code, snippet] of WRITE_ERRORS) {
    test(`erro ${status} ${code} ao iniciar: mensagem fixa, sem eco do backend`, async ({ page }) => {
      const state = await open(page);
      const sheet = await openSheet(page, OPEN_NAME, "Aberto");
      await sheet.getByRole("button", { name: "Iniciar", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Iniciar inventário" });
      state.forceInventoryWriteError = { status, code };
      await dialog.getByRole("button", { name: "Iniciar inventário" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: snippet })).toBeVisible();
      await expect(page.getByText("erro sintético")).toHaveCount(0);
      expect(inventory(state, INVENTORY_IDS.open).status).toBe("ABERTO");
    });
  }

  test("404 ao encerrar (saiu do escopo): fecha com mensagem fixa", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await sheet.getByRole("button", { name: "Encerrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Encerrar inventário" });
    state.inventories = state.inventories.filter((i) => i.id !== INVENTORY_IDS.running);
    await dialog.getByRole("button", { name: "Encerrar definitivamente" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Inventário não encontrado, ou fora do seu escopo de unidades.").first()).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });

  test("USER: o backend (mock) nega start/close/cancel com 403 e nada muda", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const statuses = await page.evaluate(
      async ({ base, id }) => {
        const out: number[] = [];
        for (const action of ["start", "close", "cancel"]) {
          const response = await fetch(`${base}/v1/inventories/${id}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer e2e" },
            body: "{}",
          });
          out.push(response.status);
        }
        return out;
      },
      { base: API_URL, id: INVENTORY_IDS.running },
    );
    expect(statuses).toEqual([403, 403, 403]);
    expect(inventory(state, INVENTORY_IDS.running).status).toBe("EM_ANDAMENTO");
  });
});

// ---------------------------------------------------------------------------
// Conferir bem
// ---------------------------------------------------------------------------

test.describe("inventários — conferir bem", () => {
  test("encontrado sem local: resultado ENCONTRADO vem do servidor e o bem NÃO muda", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const before = { ...asset(state, ASSET_IDS.zeros) };
    const { sheet, dialog } = await startCheck(page, "0000456");
    await expect(dialog).toContainText("única e imutável");
    await expect(dialog).toContainText("NÃO altera o campo “Localizado”");
    await expect(dialog.getByLabel("Local observado (opcional)")).toBeDisabled();
    await dialog.getByLabel("Sim, foi encontrado").check();
    const request = waitApi(page, "POST", `/v1/inventories/${INVENTORY_IDS.running}/items`);
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    // Só o que a pessoa decidiu: nada de resultado, conferidor ou data.
    expect((await request).postDataJSON()).toEqual({ asset_id: ASSET_IDS.zeros, found: true });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Conferência registrada: Encontrado. O bem não foi alterado.")).toBeVisible();

    const list = sheet.getByRole("list", { name: "Bens da unidade" });
    await expect(list.locator("li").filter({ hasText: "0000456" })).toContainText("Encontrado");
    await expect(list.locator("li").filter({ hasText: "0000456" }).getByRole("button")).toHaveCount(0);
    // Resumo recalculado pelo servidor.
    await expect(metric(sheet, "checked")).toHaveText("2");
    await expect(metric(sheet, "pending")).toHaveText("1");
    await expect(sheet.getByTestId("progress-text")).toHaveText("66.7% conferido");
    // Conferidor e data são do servidor.
    expect(state.inventoryItems.at(-1)).toMatchObject({ asset_id: ASSET_IDS.zeros, found: true, checked_by: "00000000-0000-4000-8000-0000000000e2" });
    expect(asset(state, ASSET_IDS.zeros)).toEqual(before);
  });

  test("não encontrado: o local observado fica desativado e o corpo vai sem local", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const { sheet, dialog } = await startCheck(page, "0000456");
    await dialog.getByLabel("Sim, foi encontrado").check();
    await dialog.getByLabel("Local observado (opcional)").selectOption({ label: "Bancada B sintética" });
    await dialog.getByLabel("Não, não foi encontrado").check();
    await expect(dialog.getByLabel("Local observado (opcional)")).toBeDisabled();
    await dialog.getByLabel("Observações (opcional)").fill("Não estava na sala.");
    const request = waitApi(page, "POST", `/v1/inventories/${INVENTORY_IDS.running}/items`);
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    expect((await request).postDataJSON()).toEqual({ asset_id: ASSET_IDS.zeros, found: false, notes: "Não estava na sala." });
    await expect(page.getByText("Conferência registrada: Não encontrado.")).toBeVisible();
    await expect(metric(sheet, "not-found")).toHaveText("1");
    expect(state.inventoryItems.at(-1)).toMatchObject({ found: false, observed_location_id: null });
  });

  test("local diferente do cadastrado: DIVERGENTE; só locais ativos da unidade do inventário", async ({ page }) => {
    const state = await open(page);
    const { sheet, dialog } = await startCheck(page, "00123");
    await dialog.getByLabel("Sim, foi encontrado").check();
    await expect(dialog.getByRole("option", { name: "Bancada A sintética" })).toBeAttached();
    await expect(dialog.getByRole("option", { name: "Bancada B sintética" })).toBeAttached();
    await expect(dialog.getByRole("option", { name: "Armário inativo sintético" })).toHaveCount(0);
    await expect(dialog.getByRole("option", { name: "Local de outra unidade" })).toHaveCount(0);
    await expect(dialog.getByText("O bem não tem local cadastrado")).toBeVisible();
    await dialog.getByLabel("Local observado (opcional)").selectOption({ label: "Bancada B sintética" });
    const request = waitApi(page, "POST", `/v1/inventories/${INVENTORY_IDS.running}/items`);
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    expect((await request).postDataJSON()).toEqual({
      asset_id: ASSET_IDS.similar,
      found: true,
      observed_location_id: INV_LOCATION_IDS.bancadaB,
    });
    await expect(page.getByText("Conferência registrada: Divergente.")).toBeVisible();
    await expect(metric(sheet, "divergent")).toHaveText("1");
    const list = sheet.getByRole("list", { name: "Bens da unidade" });
    await expect(list.locator("li").filter({ hasText: "Mesa sintética" })).toContainText("Divergente");
    // O servidor pediu locais da unidade do inventário (escopo aplicado por ele).
    expect(state.calls.some((c) => c.url.includes("/v1/locations?") && c.url.includes(`unit_id=${U1.id}`))).toBe(true);
    // Divergência não corrige o bem.
    expect(asset(state, ASSET_IDS.similar).location_id).toBeNull();
  });

  test("local igual ao cadastrado continua ENCONTRADO", async ({ page }) => {
    await open(page, { role: "ADM" }, (state) => {
      state.inventoryItems = state.inventoryItems.filter((i) => i.inventory_id !== INVENTORY_IDS.running);
    });
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await goToAssets(sheet);
    await sheet.getByRole("button", { name: "Conferir o patrimônio 000123", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Conferir bem" });
    await dialog.getByLabel("Sim, foi encontrado").check();
    await expect(dialog.getByText("Local cadastrado do bem: Bancada A sintética")).toBeVisible();
    await dialog.getByLabel("Local observado (opcional)").selectOption({ label: "Bancada A sintética" });
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(page.getByText("Conferência registrada: Encontrado.")).toBeVisible();
  });

  test("obrigatório: informar se o bem foi encontrado (sem chamada de escrita)", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const { dialog } = await startCheck(page, "0000456");
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(dialog.getByText("Informe se o bem foi encontrado.")).toBeVisible();
    expect(state.calls.filter((c) => c.method === "POST" && c.url.includes("/items"))).toHaveLength(0);
  });

  test("observações são texto inerte (sem XSS) e não vão ao DOM como HTML", async ({ page }) => {
    await open(page, { role: "USER" });
    const { sheet, dialog } = await startCheck(page, "0000456");
    await dialog.getByLabel("Sim, foi encontrado").check();
    await dialog.getByLabel("Observações (opcional)").fill(`<img src=x onerror="window.__xss=1"> ok`);
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(dialog).toBeHidden();
    await sheet.getByRole("tab", { name: "Itens conferidos" }).click();
    await expect(sheet.getByRole("list", { name: "Itens conferidos" })).toContainText(`<img src=x onerror="window.__xss=1"> ok`);
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("409 already_checked (conferido por outra pessoa): mensagem fixa e a lista passa a mostrar o resultado", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const { sheet, dialog } = await startCheck(page, "0000456");
    await dialog.getByLabel("Sim, foi encontrado").check();
    // Outra pessoa confere o mesmo bem antes do envio.
    state.inventoryItems.push({
      id: "e5000000-0000-4000-8000-000000000001",
      inventory_id: INVENTORY_IDS.running,
      asset_id: ASSET_IDS.zeros,
      found: false,
      observed_location_id: null,
      checked_by: "00000000-0000-4000-8000-0000000000e3",
      checked_at: "2026-10-02T12:00:00.000Z",
      notes: null,
    });
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "já foi conferido neste inventário" })).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("não há reconferência");
    expect(state.inventoryItems.filter((i) => i.asset_id === ASSET_IDS.zeros)).toHaveLength(1);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    const list = sheet.getByRole("list", { name: "Bens da unidade" });
    await expect(list.locator("li").filter({ hasText: "0000456" })).toContainText("Não encontrado");
    await expect(list.locator("li").filter({ hasText: "0000456" }).getByRole("button")).toHaveCount(0);
  });

  test("409 inventory_closed (encerrado enquanto conferia): fecha, avisa e recarrega", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const { sheet, dialog } = await startCheck(page, "0000456");
    await dialog.getByLabel("Sim, foi encontrado").check();
    inventory(state, INVENTORY_IDS.running).status = "CONCLUIDO";
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("encerrado ou cancelado e não aceita conferências", { exact: false }).first()).toBeVisible();
    await expect(sheet.getByText("Este inventário mudou desde que foi carregado", { exact: false })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Conferir o patrimônio/ })).toHaveCount(0);
    expect(state.inventoryItems.filter((i) => i.asset_id === ASSET_IDS.zeros)).toHaveLength(0);
  });

  test("409 inventory_not_started: mensagem fixa e fecha", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const { dialog } = await startCheck(page, "0000456");
    await dialog.getByLabel("Sim, foi encontrado").check();
    state.forceInventoryWriteError = { status: 409, code: "inventory_not_started" };
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("ainda não foi iniciado", { exact: false }).first()).toBeVisible();
  });

  const CHECK_ERRORS: [number, string, string][] = [
    [409, "link_inactive", "local observado está inativo"],
    [409, "already_checked", "já foi conferido neste inventário"],
    [403, "forbidden", "Você não tem permissão para esta ação"],
    [404, "not_found", "Inventário não encontrado, ou fora do seu escopo"],
    [400, "validation_error", "Os dados enviados não foram aceitos"],
    [429, "rate_limited", "Muitas solicitações em pouco tempo"],
    [403, "AAL2_REQUIRED", "verificação em duas etapas (AAL2)"],
    [500, "INTERNAL", "Não foi possível registrar a conferência agora"],
  ];
  for (const [status, code, snippet] of CHECK_ERRORS) {
    test(`erro ${status} ${code} ao conferir: mensagem fixa, sem eco do backend`, async ({ page }) => {
      const state = await open(page, { role: "USER" });
      const { dialog } = await startCheck(page, "0000456");
      await dialog.getByLabel("Sim, foi encontrado").check();
      state.forceInventoryWriteError = { status, code };
      await dialog.getByRole("button", { name: "Registrar conferência" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: snippet })).toBeVisible();
      await expect(page.getByText("erro sintético")).toHaveCount(0);
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
      expect(state.inventoryItems.filter((i) => i.asset_id === ASSET_IDS.zeros)).toHaveLength(0);
    });
  }

  test("ADM também confere (inventory.check) e o sumário reflete o servidor", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    const { sheet, dialog } = await startCheck(page, "0000456");
    await dialog.getByLabel("Não, não foi encontrado").check();
    await dialog.getByRole("button", { name: "Registrar conferência" }).click();
    await expect(dialog).toBeHidden();
    await expect(metric(sheet, "checked")).toHaveText("2");
    expect(state.inventoryItems.at(-1)).toMatchObject({ found: false });
  });

  test("Esc fecha o diálogo de conferência sem enviar nada", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const { dialog } = await startCheck(page, "0000456");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(state.calls.filter((c) => c.method === "POST" && c.url.includes("/items"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Segurança de apresentação
// ---------------------------------------------------------------------------

test.describe("inventários — segurança de apresentação", () => {
  test("inventários e conferências são imutáveis: o mock devolve 405 e a UI não oferece editar/excluir", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(5);
    const item = state.inventoryItems[0]!;
    const statuses = await page.evaluate(
      async ({ base, id, itemId }) => {
        const out: number[] = [];
        for (const url of [`${base}/v1/inventories/${id}`, `${base}/v1/inventories/${id}/items/${itemId}`]) {
          for (const method of ["PUT", "PATCH", "DELETE"]) {
            const response = await fetch(url, {
              method,
              headers: { "content-type": "application/json", authorization: "Bearer e2e" },
              body: method === "DELETE" ? undefined : "{}",
            });
            out.push(response.status);
          }
        }
        return out;
      },
      { base: API_URL, id: INVENTORY_IDS.running, itemId: item.id },
    );
    expect(statuses).toEqual([405, 405, 405, 404, 404, 404]);
    expect(inventory(state, INVENTORY_IDS.running).status).toBe("EM_ANDAMENTO");
  });

  test("campos privilegiados vindos do cliente são rejeitados (mass assignment)", async ({ page }) => {
    const state = await open(page);
    const result = await page.evaluate(
      async ({ base, id, asset, unit }) => {
        const post = async (path: string, body: unknown) =>
          (
            await fetch(`${base}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer e2e" },
              body: JSON.stringify(body),
            })
          ).status;
        return [
          await post("/v1/inventories", { name: "x", unit_id: unit, status: "CONCLUIDO" }),
          await post("/v1/inventories", { name: "x", unit_id: unit, created_by: "x" }),
          await post(`/v1/inventories/${id}/items`, { asset_id: asset, found: true, result: "ENCONTRADO" }),
          await post(`/v1/inventories/${id}/items`, { asset_id: asset, found: true, checked_by: "x" }),
          await post(`/v1/inventories/${id}/items`, { asset_id: asset, found: false, observed_location_id: "x" }),
        ];
      },
      { base: API_URL, id: INVENTORY_IDS.running, asset: ASSET_IDS.zeros, unit: U1.id },
    );
    expect(result).toEqual([400, 400, 400, 400, 400]);
    expect(state.inventories).toHaveLength(6);
    expect(state.inventoryItems.filter((i) => i.inventory_id === INVENTORY_IDS.running)).toHaveLength(1);
  });

  test("nenhum dado da tela (inventários, bens, notas) é persistido no navegador", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await expect(sheet.getByRole("list", { name: "Itens conferidos" })).toBeVisible();
    // Teste de segurança: LÊ o storage só para provar que nenhum dado da tela foi gravado.
    const stored = await page.evaluate(() =>
      // eslint-disable-next-line no-restricted-properties
      JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage }, cookie: document.cookie }),
    );
    for (const text of ["Conferido na bancada", "Inventário Anual", INVENTORY_IDS.running, "000123"]) {
      expect(stored).not.toContain(text);
    }
  });

  test("toda chamada da tela sai com Authorization: Bearer", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER" });
    const unauthenticated: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(`${API_URL}/`) && request.method() !== "OPTIONS") {
        if (!(request.headers()["authorization"] ?? "").startsWith("Bearer ")) unauthenticated.push(request.url());
      }
    });
    await page.goto(PATH);
    await waitForHydration(page);
    const sheet = await openSheet(page, RUNNING_NAME, "Em andamento");
    await goToAssets(sheet);
    expect(unauthenticated).toEqual([]);
    expect(state.calls.some((c) => c.url.includes("/v1/inventories"))).toBe(true);
  });
});
