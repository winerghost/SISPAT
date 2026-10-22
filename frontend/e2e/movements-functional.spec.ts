import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { ASSET_IDS, LONG_DESCRIPTION, type AssetMock } from "./support/asset-mocks";
import { ROOM_IDS } from "./support/catalog-mocks";
import { MOVEMENT_IDS, OTHER_ACTOR_ID, type MovementMock } from "./support/movement-mocks";
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
// Movimentações — lista, detalhe, solicitar, aprovar/rejeitar, cancelar.
// Mocks sintéticos que seguem docs/architecture/movements-api.md. A autorização,
// o escopo, as transições, os vínculos e o controle de versão do bem são do
// BACKEND (simulados no mock); aqui validamos o que a interface envia e como
// explica cada resposta. O nome do arquivo casa com o projeto "e2e".
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const PATH = "/movimentacoes";
const [U1, U2] = UNITS as [(typeof UNITS)[0], (typeof UNITS)[0]];
const U1_LABEL = "PSU-TO — Procuradoria Seccional Sintética de Palmas";
const U2_LABEL = "ESC-02 — Escritório Sintético Avançado";
const ROOM_A_LABEL = "Sala 101 Sintética com Nome Bastante Longo para Testar a Quebra de Linha em 320px";

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

const table = (page: Page) => page.getByRole("table", { name: "Movimentações" });
const rows = (page: Page) => table(page).locator("tbody tr");

function movement(state: MockState, id: string): MovementMock {
  return state.movements.find((m) => m.id === id)!;
}

function asset(state: MockState, id: string): AssetMock {
  return state.assets.find((a) => a.id === id)!;
}

async function openSheet(page: Page, number: string, status: string): Promise<Locator> {
  await expect(table(page)).toBeVisible();
  await page
    .getByRole("button", { name: `Ver detalhes da movimentação do patrimônio ${number}, ${status}`, exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: new RegExp(`Movimentação do patrimônio ${number}`) });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Origem e destino" })).toBeVisible();
  return sheet;
}

/** Abre o diálogo de solicitação e escolhe o bem pela busca. */
async function startRequest(page: Page, search: string, optionLabel: string): Promise<Locator> {
  await expect(table(page)).toBeVisible();
  await page.getByRole("button", { name: "Solicitar movimentação" }).click();
  const dialog = page.getByRole("dialog", { name: "Solicitar movimentação" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Bem — buscar por patrimônio ou descrição/).fill(search);
  await dialog.getByLabel(/Bem — resultados/).selectOption({ label: optionLabel });
  await expect(dialog.getByText("Situação atual do bem")).toBeVisible();
  return dialog;
}

/** Cookies só podem ter preferências de aparência (sem dados patrimoniais). */
function document_cookie_free(cookie: string): boolean {
  return !/000123|movimenta|asset/i.test(cookie);
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

test.describe("movimentações — lista", () => {
  test("colunas, origem → destino em texto, estado com ícone+texto, fuso America/Araguaina e escopo", async ({ page }) => {
    await open(page);
    for (const header of ["Bem", "Movimento", "Estado", "Solicitada em"]) {
      await expect(table(page).getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    // 7 movimentações no mock, 1 totalmente fora do escopo (nunca aparece).
    await expect(page.getByText("Exibindo 1–6 de 6 movimentação(ões)")).toBeVisible();
    await expect(rows(page)).toHaveCount(6);

    const first = rows(page).filter({ hasText: "000123" });
    await expect(first).toContainText("De");
    await expect(first).toContainText("PSU-TO");
    await expect(first).toContainText("Para");
    await expect(first).toContainText("ESC-02");
    await expect(first).toContainText("Pendente");
    await expect(first).toContainText("Transferência de unidade");
    // 2026-09-29T12:00Z → 09:00 em Araguaína (UTC-3).
    await expect(first).toContainText("29/09/2026");
    await expect(first).toContainText("09:00");

    for (const status of ["Pendente", "Aprovada", "Rejeitada", "Cancelada"]) {
      await expect(table(page).getByText(status, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    }
    // Mais recentes primeiro (padrão do backend).
    await expect(rows(page).first()).toContainText("FORA-001");
    // Sem editar/excluir: o histórico é imutável.
    await expect(page.getByRole("button", { name: /Editar|Excluir/ })).toHaveCount(0);
  });

  test("filtros e ordenação enviam só a allowlist e voltam à página 1", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(6);

    const byStatus = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Estado", { exact: true }).selectOption("PENDENTE");
    expect(new URL((await byStatus).url()).searchParams.get("status")).toBe("PENDENTE");
    await expect(rows(page)).toHaveCount(3);

    const byOrigin = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Unidade de origem").selectOption({ label: U1_LABEL });
    expect(new URL((await byOrigin).url()).searchParams.get("origin_unit_id")).toBe(U1.id);
    await expect(rows(page)).toHaveCount(2);

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(6);

    const byDestination = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Unidade de destino").selectOption({ label: U2_LABEL });
    expect(new URL((await byDestination).url()).searchParams.get("destination_unit_id")).toBe(U2.id);
    await expect(rows(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    const byFrom = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Solicitada a partir de").fill("2026-10-01");
    expect(new URL((await byFrom).url()).searchParams.get("created_from")).toBe("2026-10-01");
    await expect(rows(page)).toHaveCount(4);
    const byTo = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Solicitada até").fill("2026-10-02");
    expect(new URL((await byTo).url()).searchParams.get("created_to")).toBe("2026-10-02");
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    const bySort = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Ordenar por").selectOption("created_at");
    expect(new URL((await bySort).url()).searchParams.get("sort")).toBe("created_at");
    await expect(rows(page).first()).toContainText("000123");
  });

  test("filtro Tipo: rótulos dos relatórios, só envia quando selecionado, reseta página e Limpar filtros limpa", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (st) => {
      const template = st.movements[0]!;
      for (let i = 0; i < 60; i += 1) {
        st.movements.push({ ...template, id: `d2000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
      }
    });
    const select = page.getByLabel("Tipo", { exact: true });
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveText([
      "Todos os tipos",
      "Transferência entre unidades",
      "Mudança de sala",
      "Troca de responsável",
    ]);
    const typeCalls = () =>
      state.calls
        .filter((c) => c.method === "GET" && /\/v1\/movements\?/.test(c.url))
        .map((c) => new URL(c.url, "http://x").searchParams.get("movement_type"));
    // Sem seleção: o parâmetro nem é enviado.
    expect(typeCalls().every((value) => value === null)).toBe(true);

    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page.getByText(/Exibindo 51–/)).toBeVisible();

    const byType = waitApi(page, "GET", "/v1/movements");
    await select.selectOption("MUDANCA_SALA");
    const query = new URL((await byType).url()).searchParams;
    expect(query.get("movement_type")).toBe("MUDANCA_SALA");
    expect(query.get("page")).toBe("1");
    await expect(rows(page)).toHaveCount(1);

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(select).toHaveValue("");
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);
    await expect(page.getByText(/Exibindo 1–50 de 66/)).toBeVisible();
  });

  test("filtro Tipo: valor fora da allowlist recebe 400 do backend (mock fiel) e a UI mostra erro fixo", async ({ page }) => {
    await open(page);
    const invalid = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Tipo", { exact: true }).evaluate((el) => {
      const select = el as HTMLSelectElement;
      select.add(new Option("Fora da allowlist", "OUTRO"));
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "OUTRO");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(new URL((await invalid).url()).searchParams.get("movement_type")).toBe("OUTRO");
    await expect(page.getByText("A busca ou os filtros não foram aceitos.")).toBeVisible();
  });

  test("datas created_from/created_to vão exatamente como escolhidas (dia civil, sem conversão por Date/UTC)", async ({ page }) => {
    await open(page);
    const byFrom = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Solicitada a partir de").fill("2026-10-31");
    const fromUrl = (await byFrom).url();
    expect(new URL(fromUrl).searchParams.get("created_from")).toBe("2026-10-31");
    expect(fromUrl).toContain("created_from=2026-10-31&");
    const byTo = waitApi(page, "GET", "/v1/movements");
    await page.getByLabel("Solicitada até").fill("2026-11-01");
    const toUrl = (await byTo).url();
    expect(new URL(toUrl).searchParams.get("created_to")).toBe("2026-11-01");
    expect(toUrl).not.toMatch(/T\d{2}|%3A|Z(&|$)/);
  });

  test("filtro por bem usa a busca de /assets e envia asset_id", async ({ page }) => {
    await open(page);
    await page.getByLabel(/Filtrar por bem — buscar/).fill("000123");
    await page.getByLabel(/Filtrar por bem — resultados/).selectOption({ label: `000123 — ${LONG_DESCRIPTION}` });
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("000123");
    await page.getByRole("button", { name: "Remover filtro de bem" }).click();
    await expect(rows(page)).toHaveCount(6);
  });

  test("ordenação pelos cabeçalhos usa aria-sort e a allowlist", async ({ page }) => {
    await open(page);
    const head = table(page).getByRole("columnheader", { name: /Estado/ });
    await expect(head).toHaveAttribute("aria-sort", "none");
    const request = waitApi(page, "GET", "/v1/movements");
    await head.getByRole("button").click();
    expect(new URL((await request).url()).searchParams.get("sort")).toBe("status");
    await expect(head).toHaveAttribute("aria-sort", "ascending");
  });

  test("estado vazio com e sem filtro", async ({ page }) => {
    await open(page, { role: "USER" });
    await page.getByLabel("Solicitada a partir de").fill("2026-12-01");
    await expect(page.getByText("Nenhuma movimentação encontrada para os filtros atuais.")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows(page)).toHaveCount(6);
  });

  const LIST_ERRORS: [number, string][] = [
    [500, "Não foi possível carregar as movimentações."],
    [403, "Você não tem permissão para consultar as movimentações."],
    [404, "Nada foi encontrado no seu escopo de unidades."],
  ];
  for (const [status, message] of LIST_ERRORS) {
    test(`erro ${status} da listagem: mensagem fixa, sem eco do backend`, async ({ page }) => {
      const state = await open(page, { role: "USER", movementsListStatus: status });
      await expect(page.getByRole("main").getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
      if (status === 500) {
        state.forceMovementListStatus = null;
        await page.getByRole("button", { name: "Tentar novamente" }).click();
        await expect(rows(page)).toHaveCount(6);
      }
    });
  }

  test("ADM sem AAL2: orienta a confirmar a verificação em duas etapas", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("main").getByRole("alert").first()).toContainText("verificação em duas etapas (AAL2)");
  });

  test("paginação 50/100/200: total confirmado, navegação e page_size sempre válido", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, (st) => {
      const template = st.movements[0]!;
      for (let i = 0; i < 125; i += 1) {
        st.movements.push({ ...template, id: `d2000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
      }
    });
    await expect(page.getByText("Exibindo 1–50 de 131 movimentação(ões)")).toBeVisible();
    await expect(rows(page)).toHaveCount(50);
    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page.getByText("Exibindo 51–100 de 131 movimentação(ões)")).toBeVisible();
    await page.getByRole("button", { name: "Última" }).click();
    await expect(page.getByText("Exibindo 101–131 de 131 movimentação(ões)")).toBeVisible();
    await expect(rows(page)).toHaveCount(31);
    await page.getByLabel("Registros por página").selectOption("100");
    await expect(page.getByText("Exibindo 1–100 de 131 movimentação(ões)")).toBeVisible();
    await page.getByLabel("Registros por página").selectOption("200");
    await expect(rows(page)).toHaveCount(131);

    // Filtrar na página 2 volta à página 1.
    await page.getByLabel("Registros por página").selectOption("50");
    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page.getByText("Exibindo 51–100 de 131 movimentação(ões)")).toBeVisible();
    await page.getByLabel("Estado", { exact: true }).selectOption("PENDENTE");
    await expect(page.getByText(/Exibindo 1–50 de \d+ movimentação\(ões\)/)).toBeVisible();

    const queries = state.calls
      .filter((c) => c.method === "GET" && /\/v1\/movements\?/.test(c.url))
      .map((c) => new URL(c.url, "http://x").searchParams);
    for (const query of queries) {
      expect(["50", "100", "200"]).toContain(query.get("page_size"));
      for (const key of query.keys()) {
        expect(["status", "movement_type", "asset_id", "origin_unit_id", "destination_unit_id", "created_from", "created_to", "sort", "page", "page_size"]).toContain(key);
      }
    }
  });

  test("zebra nas linhas e seletor de bem do filtro usa page_size válido", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(6);
    await page.mouse.move(0, 0);
    const bg = (n: number) => rows(page).nth(n).evaluate((el) => getComputedStyle(el).backgroundColor);
    const [a, b, c] = [await bg(0), await bg(1), await bg(2)];
    expect(a).toBe(c);
    expect(b).not.toBe(a);

    await page.getByLabel(/Filtrar por bem — buscar/).fill("000123");
    await expect(page.getByLabel(/Filtrar por bem — resultados/)).toBeVisible();
    const lookups = state.calls.filter((c) => c.method === "GET" && /\/v1\/assets\?/.test(c.url));
    expect(lookups.length).toBeGreaterThan(0);
    for (const call of lookups) {
      expect(["50", "100", "200"]).toContain(new URL(call.url, "http://x").searchParams.get("page_size"));
    }
  });

  test("busca de bem: trim e limite de 100 caracteres", async ({ page }) => {
    const state = await open(page);
    const search = page.getByLabel(/Filtrar por bem — buscar/);
    await search.fill("   000123   ");
    await expect(page.getByLabel(/Filtrar por bem — resultados/)).toBeVisible();
    const q = state.calls
      .filter((c) => /\/v1\/assets\?/.test(c.url))
      .map((c) => new URL(c.url, "http://x").searchParams.get("q"));
    expect(q.at(-1)).toBe("000123");
    await search.fill("y".repeat(150));
    await expect(search).toHaveValue("y".repeat(100));
  });
});

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

test.describe("movimentações — detalhe", () => {
  test("ADM: origem → destino em texto claro, motivo e autoria, ações só em PENDENTE", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, "000123", "Pendente");
    const flow = sheet.getByRole("region", { name: "Origem e destino" });
    await expect(flow).toContainText("Origem");
    await expect(flow).toContainText("PSU-TO — Procuradoria Seccional Sintética de Palmas");
    await expect(flow).toContainText("Pessoa Responsável Sintética");
    await expect(flow).toContainText("Destino");
    await expect(flow).toContainText("ESC-02 — Escritório Sintético Avançado");
    await expect(flow).toContainText("Auditório Sintético");
    await expect(flow).toContainText("sem responsável");
    await expect(sheet.getByText("Transferência sintética para o escritório avançado.")).toBeVisible();
    await expect(sheet.getByText("Solicitante (identificador)")).toBeVisible();
    await expect(sheet.getByText("Histórico imutável", { exact: false })).toBeVisible();
    for (const name of ["Aprovar", "Rejeitar", "Cancelar solicitação"]) {
      await expect(sheet.getByRole("button", { name })).toBeVisible();
    }
    await expect(sheet.getByRole("button", { name: /Editar|Excluir/ })).toHaveCount(0);
  });

  test("movimentação decidida não oferece nenhuma ação e mostra data e autoria da decisão", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, "A-2025/007", "Aprovada");
    await expect(sheet.getByText("Aprovada em")).toBeVisible();
    await expect(sheet.getByText("Aprovada por (identificador)")).toBeVisible();
    await expect(sheet.getByText("Concluída em")).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Ações da movimentação" })).toHaveCount(0);
  });

  test("RH: sem motivo, solicitante nem aprovador, e sem ações nem botão de solicitar", async ({ page }) => {
    await open(page, { role: "RH" });
    await expect(page.getByRole("button", { name: "Solicitar movimentação" })).toHaveCount(0);
    await expect(page.getByText("Seu perfil é somente de consulta.")).toBeVisible();
    const sheet = await openSheet(page, "000123", "Pendente");
    await expect(sheet.getByText("Motivo da solicitação")).toHaveCount(0);
    await expect(sheet.getByText("Transferência sintética para o escritório avançado.")).toHaveCount(0);
    await expect(sheet.getByText("Solicitante (identificador)")).toHaveCount(0);
    await expect(sheet.getByText("Aprovada por (identificador)")).toHaveCount(0);
    await expect(sheet.getByRole("group", { name: "Ações da movimentação" })).toHaveCount(0);
    await expect(sheet.getByText("Solicitada em")).toBeVisible();
  });

  test("motivo com marcação HTML é texto inerte (sem XSS)", async ({ page }) => {
    await open(page);
    const sheet = await openSheet(page, "0000456", "Pendente");
    await expect(sheet.getByText("Troca de sala <img src=x", { exact: false })).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("leitor só com escopo no destino: chaves de origem/motivo ausentes, sem 'null'/'undefined' nem aviso falso", async ({ page }) => {
    const state = await open(page);
    // O mock imita o backend: origem fora do escopo => chaves OMITIDAS (não null).
    const row = state.movements.find((m) => m.id === MOVEMENT_IDS.halfScope)!;
    row.reason = "Motivo que este leitor não pode ver.";
    const sheet = await openSheet(page, "FORA-001", "Pendente");
    const flow = sheet.getByRole("region", { name: "Origem e destino" });
    await expect(flow).toContainText("FORA-09 — Unidade Sintética Fora do Escopo");
    await expect(flow).toContainText("indisponível (fora do seu escopo)");
    // Ausência não é "sem sala"/"sem responsável" na origem (só o destino pode dizer isso).
    const origin = flow.locator("div", { hasText: /^Origem/ }).first();
    await expect(origin).not.toContainText("sem sala");
    await expect(origin).not.toContainText("sem responsável");
    await expect(sheet.getByTestId("origin-scope-note")).toBeVisible();
    await expect(sheet.getByText("Motivo da solicitação")).toHaveCount(0);
    await expect(sheet.getByText("Motivo que este leitor não pode ver.")).toHaveCount(0);
    expect(await sheet.innerText()).not.toMatch(/null|undefined/);
    // A linha da lista também tolera a ausência.
    await page.keyboard.press("Escape");
    expect(await rows(page).filter({ hasText: "FORA-001" }).innerText()).not.toMatch(/null|undefined/);
    await expect(rows(page).filter({ hasText: "FORA-001" })).toContainText("indisponível (fora do seu escopo)");
  });

  test("RH só-destino: a resposta realmente não traz as chaves de origem", async ({ page }) => {
    await open(page, { role: "RH" });
    const body = await page.evaluate(
      async ({ url }) => {
        const response = await fetch(url, { headers: { authorization: "Bearer e2e" } });
        return (await response.json()) as Record<string, unknown>;
      },
      { url: `${API_URL}/v1/movements/${MOVEMENT_IDS.halfScope}` },
    );
    for (const key of ["origin_room_id", "origin_room", "previous_responsible_id", "previous_responsible", "reason"]) {
      expect(key in body, key).toBe(false);
    }
    expect("destination_room_id" in body).toBe(true);
  });

  test("USER: cancelar só na própria solicitação; nunca aprovar nem rejeitar", async ({ page }) => {
    await open(page, { role: "USER" });
    const mine = await openSheet(page, "000123", "Pendente");
    await expect(mine.getByRole("button", { name: "Cancelar solicitação" })).toBeVisible();
    await expect(mine.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
    await expect(mine.getByRole("button", { name: "Rejeitar" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(mine).toBeHidden();

    const other = await openSheet(page, "0000456", "Pendente");
    await expect(other.getByRole("button", { name: "Cancelar solicitação" })).toHaveCount(0);
    await expect(other.getByRole("group", { name: "Ações da movimentação" })).toHaveCount(0);
  });

  test("movimentação que saiu do escopo: 404 uniforme, sem eco do backend", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(6);
    state.movements = state.movements.filter((m) => m.id !== MOVEMENT_IDS.pendingUnit);
    await page
      .getByRole("button", { name: "Ver detalhes da movimentação do patrimônio 000123, Pendente", exact: true })
      .click();
    const sheet = page.getByRole("dialog", { name: /Movimentação do patrimônio 000123/ });
    await expect(sheet.getByText("Movimentação não encontrada, ou fora do seu escopo de unidades.")).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Voltar à lista" }).click();
    await expect(rows(page)).toHaveCount(5);
  });
});

// ---------------------------------------------------------------------------
// Solicitar
// ---------------------------------------------------------------------------

test.describe("movimentações — solicitar", () => {
  test("outra unidade: sala/responsável ausentes (ficam vazios) e o bem não é alterado", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const dialog = await startRequest(page, "00123", "00123 — Mesa sintética");
    await expect(dialog.getByText("Situação atual do bem")).toBeVisible();
    // Antes de escolher a unidade, sala e responsável ficam desativados.
    await expect(dialog.getByLabel("Sala de destino")).toBeDisabled();
    await dialog.getByLabel(/Unidade de destino/).selectOption({ label: U2_LABEL });
    await expect(dialog.getByText("Outra unidade: sem escolher uma sala, o bem ficará SEM sala no destino.")).toBeVisible();
    await expect(dialog.getByText("Outra unidade: sem escolher um responsável, o bem ficará SEM responsável no destino.")).toBeVisible();
    await expect(dialog.getByRole("option", { name: "Remover a sala (deixar vazia)" })).toHaveCount(0);

    const before = { ...asset(state, ASSET_IDS.similar) };
    await dialog.getByLabel("Motivo (opcional)").fill("Reforço da equipe do escritório.");
    const request = waitApi(page, "POST", "/v1/movements");
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    expect((await request).postDataJSON()).toEqual({
      asset_id: ASSET_IDS.similar,
      asset_version: 1,
      destination_unit_id: U2.id,
      reason: "Reforço da equipe do escritório.",
    });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Solicitação registrada. O bem só será alterado se um administrador aprovar.")).toBeVisible();
    await expect(page.getByText("Exibindo 1–7 de 7 movimentação(ões)")).toBeVisible();
    await expect(rows(page).first()).toContainText("00123");
    // Nada mudou no bem: a aprovação é outra etapa.
    expect(asset(state, ASSET_IDS.similar)).toEqual(before);
    expect(state.movements.at(-1)).toMatchObject({ status: "PENDENTE", requested_by: "00000000-0000-4000-8000-0000000000e2" });
  });

  test("mesma unidade: ausente mantém, null remove e, sem mudança, o envio fica bloqueado", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const dialog = await startRequest(page, "XSS-001", "XSS-001 — Monitor <img src=x onerror=\"window.__xss=1\">");
    await dialog.getByLabel(/Unidade de destino/).selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    // Mesma unidade do bem (ESC-02): opções de manter e remover.
    await expect(dialog.getByRole("option", { name: "Manter a sala atual" })).toBeAttached();
    await expect(dialog.getByRole("option", { name: "Remover a sala (deixar vazia)" })).toBeAttached();
    await expect(dialog.getByRole("option", { name: "Manter o responsável atual" })).toBeAttached();
    await expect(dialog.getByText("Mesma unidade do bem: “Manter a sala atual” não altera a sala", { exact: false })).toBeVisible();
    // Nada a mudar => bloqueado (dica de UX; o backend responde no_change).
    await expect(dialog.getByText("Nada mudaria no bem", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Solicitar movimentação" })).toBeDisabled();

    await dialog.getByLabel("Sala de destino").selectOption("__limpar__");
    await expect(dialog.getByRole("button", { name: "Solicitar movimentação" })).toBeEnabled();
    const request = waitApi(page, "POST", "/v1/movements");
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    // `null` explícito: remove a sala; responsável ausente: mantém.
    expect((await request).postDataJSON()).toEqual({
      asset_id: ASSET_IDS.xss,
      asset_version: 1,
      destination_unit_id: U2.id,
      destination_room_id: null,
    });
    await expect(dialog).toBeHidden();
    expect(state.movements.at(-1)).toMatchObject({ movement_type: "MUDANCA_SALA", destination_room_id: null });
  });

  test("mesma unidade com nova sala: envia o id e a movimentação vira MUDANCA_SALA", async ({ page }) => {
    const state = await open(page, { role: "ADM" });
    const dialog = await startRequest(page, "00123", "00123 — Mesa sintética");
    await dialog.getByLabel(/Unidade de destino/).selectOption({ label: U1_LABEL });
    await dialog.getByLabel("Sala de destino").selectOption({ label: ROOM_A_LABEL });
    const request = waitApi(page, "POST", "/v1/movements");
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    expect((await request).postDataJSON()).toEqual({
      asset_id: ASSET_IDS.similar,
      asset_version: 1,
      destination_unit_id: U1.id,
      destination_room_id: ROOM_IDS.a,
    });
    await expect(dialog).toBeHidden();
    expect(state.movements.at(-1)).toMatchObject({ movement_type: "MUDANCA_SALA", destination_room_id: ROOM_IDS.a });
  });

  test("campos obrigatórios: bem e unidade, com foco no primeiro inválido", async ({ page }) => {
    await open(page, { role: "USER" });
    await page.getByRole("button", { name: "Solicitar movimentação" }).click();
    const dialog = page.getByRole("dialog", { name: "Solicitar movimentação" });
    await expect(dialog.getByLabel(/Unidade de destino/)).toBeDisabled();
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    await expect(dialog.getByText("Escolha o bem a movimentar.")).toBeVisible();
  });

  test("409 movement_pending: mensagem fixa e nada é criado", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const dialog = await startRequest(page, "000123", `000123 — ${LONG_DESCRIPTION}`);
    await dialog.getByLabel(/Unidade de destino/).selectOption({ label: U2_LABEL });
    const count = state.movements.length;
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "já tem uma movimentação pendente" })).toBeVisible();
    expect(state.movements).toHaveLength(count);
    await expect(dialog).toBeVisible();
  });

  test("409 version_conflict: recarrega o bem, avisa e o reenvio usa a nova asset_version", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const dialog = await startRequest(page, "00123", "00123 — Mesa sintética");
    await dialog.getByLabel(/Unidade de destino/).selectOption({ label: U2_LABEL });
    // Outra pessoa altera o bem antes do envio.
    asset(state, ASSET_IDS.similar).version = 6;
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "O bem foi alterado por outra pessoa" })).toBeVisible();
    const request = waitApi(page, "POST", "/v1/movements");
    await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
    expect((await request).postDataJSON()).toMatchObject({ asset_id: ASSET_IDS.similar, asset_version: 6 });
    await expect(dialog).toBeHidden();
  });

  const WRITE_ERRORS: [number, string, string][] = [
    [409, "no_change", "não mudaria nada no bem"],
    [409, "asset_unavailable", "não está mais disponível"],
    [409, "unit_inactive", "unidade de destino está inativa"],
    [409, "link_inactive", "sala ou o responsável escolhido está inativo"],
    [409, "link_unit_mismatch", "não pertence à unidade de destino"],
    [409, "invalid_transition", "não está mais pendente"],
    [400, "validation_error", "Os dados enviados não foram aceitos"],
    [403, "forbidden", "Você não tem permissão para esta ação"],
    [404, "not_found", "Movimentação não encontrada, ou fora do seu escopo"],
    [429, "rate_limited", "Muitas solicitações em pouco tempo"],
    [403, "AAL2_REQUIRED", "verificação em duas etapas (AAL2)"],
  ];
  for (const [status, code, snippet] of WRITE_ERRORS) {
    test(`erro ${status} ${code}: mensagem fixa, sem eco do backend`, async ({ page }) => {
      const state = await open(page, { role: "USER" });
      const dialog = await startRequest(page, "00123", "00123 — Mesa sintética");
      await dialog.getByLabel(/Unidade de destino/).selectOption({ label: U2_LABEL });
      state.forceMovementWriteError = { status, code };
      await dialog.getByRole("button", { name: "Solicitar movimentação" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: snippet })).toBeVisible();
      await expect(page.getByText("erro sintético")).toHaveCount(0);
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    });
  }

  test("Esc fecha o diálogo de solicitação", async ({ page }) => {
    await open(page, { role: "USER" });
    await page.getByRole("button", { name: "Solicitar movimentação" }).click();
    const dialog = page.getByRole("dialog", { name: "Solicitar movimentação" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Aprovar
// ---------------------------------------------------------------------------

test.describe("movimentações — aprovar", () => {
  test("explica o efeito definitivo, envia asset_version e o bem muda no sucesso", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Aprovar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
    await expect(dialog).toContainText("ALTERA O BEM de forma definitiva");
    await expect(dialog).toContainText("o histórico é imutável");
    await expect(dialog.getByText("Situação atual do bem: PSU-TO")).toBeVisible();
    await expect(dialog.getByText("O bem mudou desde a solicitação")).toHaveCount(0);

    expect(asset(state, ASSET_IDS.long).unit_id).toBe(U1.id);
    const request = waitApi(page, "POST", `/v1/movements/${MOVEMENT_IDS.pendingUnit}/approve`);
    await dialog.getByRole("button", { name: "Aprovar e alterar o bem" }).click();
    // Só `asset_version` (versão do bem que o aprovador viu).
    expect((await request).postDataJSON()).toEqual({ asset_version: 3 });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Movimentação aprovada. O bem foi atualizado.")).toBeVisible();

    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("APROVADA");
    expect(asset(state, ASSET_IDS.long)).toMatchObject({ unit_id: U2.id, room_id: ROOM_IDS.other, version: 4 });
    expect(state.history.some((h) => h.asset_id === ASSET_IDS.long && h.operation === "ASSET_MOVED")).toBe(true);
    await expect(sheet.getByText("Aprovada", { exact: true }).first()).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Ações da movimentação" })).toHaveCount(0);
  });

  test("409 version_conflict: recarrega o bem, avisa e a nova confirmação usa a nova versão", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Aprovar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
    await expect(dialog.getByText("Situação atual do bem: PSU-TO")).toBeVisible();
    // Outra pessoa altera o bem (só a versão) depois que o diálogo leu a situação.
    asset(state, ASSET_IDS.long).version = 7;
    await dialog.getByRole("button", { name: "Aprovar e alterar o bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "O bem foi alterado por outra pessoa" })).toBeVisible();
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("PENDENTE");
    await expect(dialog).toBeVisible();

    const request = waitApi(page, "POST", `/approve`);
    await dialog.getByRole("button", { name: "Aprovar e alterar o bem" }).click();
    expect((await request).postDataJSON()).toEqual({ asset_version: 7 });
    await expect(dialog).toBeHidden();
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("APROVADA");
  });

  test("bem que mudou desde a solicitação: avisa antes e o backend recusa sem alterar nada", async ({ page }) => {
    const state = await open(page);
    asset(state, ASSET_IDS.long).room_id = ROOM_IDS.other; // sai da sala de origem registrada
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Aprovar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
    await expect(dialog.getByText("O bem mudou desde a solicitação")).toBeVisible();
    await dialog.getByRole("button", { name: "Aprovar e alterar o bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "O bem foi alterado por outra pessoa" })).toBeVisible();
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("PENDENTE");
    expect(asset(state, ASSET_IDS.long).unit_id).toBe(U1.id);
  });

  test("409 invalid_transition: fecha, avisa e recarrega o estado atual", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Aprovar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
    await expect(dialog.getByText("Situação atual do bem: PSU-TO")).toBeVisible();
    // Outra pessoa cancela antes da decisão.
    movement(state, MOVEMENT_IDS.pendingUnit).status = "CANCELADA";
    await dialog.getByRole("button", { name: "Aprovar e alterar o bem" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("não está mais pendente", { exact: false }).first()).toBeVisible();
    await expect(sheet.getByText("Esta movimentação mudou desde que foi carregada", { exact: false })).toBeVisible();
    await expect(sheet.getByText("Cancelada", { exact: true }).first()).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Ações da movimentação" })).toHaveCount(0);
    expect(asset(state, ASSET_IDS.long).unit_id).toBe(U1.id);
  });

  test("asset_unavailable (bem excluído no meio do caminho) não altera nada", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Aprovar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
    await expect(dialog.getByText("Situação atual do bem: PSU-TO")).toBeVisible();
    state.forceMovementWriteError = { status: 409, code: "asset_unavailable" };
    await dialog.getByRole("button", { name: "Aprovar e alterar o bem" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "não está mais disponível" })).toBeVisible();
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("PENDENTE");
  });

  test("sem acesso ao bem (só o destino no escopo): a aprovação fica bloqueada, sem chamada de escrita", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "FORA-001", "Pendente");
    await sheet.getByRole("button", { name: "Aprovar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
    await expect(dialog.getByText("a aprovação está bloqueada", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Aprovar e alterar o bem" })).toBeDisabled();
    expect(state.calls.filter((c) => c.method === "POST" && c.url.includes("/approve"))).toHaveLength(0);
  });

  test("quem não é ADM nunca vê Aprovar/Rejeitar (e o backend também nega com 403)", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, "0000456", "Pendente");
    await expect(sheet.getByRole("button", { name: /Aprovar|Rejeitar/ })).toHaveCount(0);
    // Mesmo forçando a chamada, o mock (como o backend) responde 403 e nada muda.
    const status = await page.evaluate(
      async ({ url }) => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e" }, body: JSON.stringify({ asset_version: 1 }) });
        return response.status;
      },
      { url: `${API_URL}/v1/movements/${MOVEMENT_IDS.pendingRoom}/approve` },
    );
    expect(status).toBe(403);
    expect(movement(state, MOVEMENT_IDS.pendingRoom).status).toBe("PENDENTE");
  });
});

// ---------------------------------------------------------------------------
// Rejeitar e cancelar
// ---------------------------------------------------------------------------

test.describe("movimentações — rejeitar e cancelar", () => {
  test("rejeitar exige motivo, envia só {reason} e não altera o bem", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Rejeitar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rejeitar movimentação" });
    await expect(dialog).toContainText("o bem NÃO é alterado");
    await dialog.getByRole("button", { name: "Rejeitar movimentação" }).click();
    await expect(dialog.getByText("Informe o motivo da rejeição.")).toBeVisible();
    expect(state.calls.filter((c) => c.method === "POST" && c.url.includes("/reject"))).toHaveLength(0);

    await dialog.getByLabel(/Motivo da rejeição/).fill("Destino sem espaço disponível.");
    const request = waitApi(page, "POST", `/v1/movements/${MOVEMENT_IDS.pendingUnit}/reject`);
    await dialog.getByRole("button", { name: "Rejeitar movimentação" }).click();
    expect((await request).postDataJSON()).toEqual({ reason: "Destino sem espaço disponível." });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Movimentação rejeitada. O bem não foi alterado.")).toBeVisible();
    expect(movement(state, MOVEMENT_IDS.pendingUnit)).toMatchObject({ status: "REJEITADA", approved_by: expect.any(String) });
    expect(asset(state, ASSET_IDS.long)).toMatchObject({ unit_id: U1.id, version: 3 });
    await expect(sheet.getByText("Rejeitada em")).toBeVisible();
  });

  test("solicitante (USER) cancela a própria solicitação; o corpo vai sem motivo", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Cancelar solicitação" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancelar solicitação" });
    await expect(dialog).toContainText("CANCELADA");
    await expect(dialog).toContainText("histórico é imutável");
    const request = waitApi(page, "POST", `/v1/movements/${MOVEMENT_IDS.pendingUnit}/cancel`);
    await dialog.getByRole("button", { name: "Cancelar solicitação" }).click();
    expect((await request).postDataJSON()).toEqual({});
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Solicitação cancelada. O bem não foi alterado.")).toBeVisible();
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("CANCELADA");
    expect(movement(state, MOVEMENT_IDS.pendingUnit).approved_by).toBeNull();
  });

  test("ADM cancela solicitação de outra pessoa, com motivo", async ({ page }) => {
    const state = await open(page);
    const sheet = await openSheet(page, "0000456", "Pendente");
    expect(movement(state, MOVEMENT_IDS.pendingRoom).requested_by).toBe(OTHER_ACTOR_ID);
    await sheet.getByRole("button", { name: "Cancelar solicitação" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancelar solicitação" });
    await dialog.getByLabel("Motivo (opcional)").fill("Pedido duplicado.");
    const request = waitApi(page, "POST", `/v1/movements/${MOVEMENT_IDS.pendingRoom}/cancel`);
    await dialog.getByRole("button", { name: "Cancelar solicitação" }).click();
    expect((await request).postDataJSON()).toEqual({ reason: "Pedido duplicado." });
    await expect(dialog).toBeHidden();
    expect(movement(state, MOVEMENT_IDS.pendingRoom).status).toBe("CANCELADA");
  });

  test("403 do backend ao cancelar: mensagem fixa e o estado permanece", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    const sheet = await openSheet(page, "000123", "Pendente");
    await sheet.getByRole("button", { name: "Cancelar solicitação" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancelar solicitação" });
    state.forceMovementWriteError = { status: 403, code: "forbidden" };
    await dialog.getByRole("button", { name: "Cancelar solicitação" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Você não tem permissão para esta ação" })).toBeVisible();
    await expect(page.getByText("erro sintético")).toHaveCount(0);
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("PENDENTE");
  });
});

// ---------------------------------------------------------------------------
// Segurança de apresentação
// ---------------------------------------------------------------------------

test.describe("movimentações — segurança de apresentação", () => {
  test("não existe rota nem botão de edição/exclusão; o mock devolve 405", async ({ page }) => {
    const state = await open(page);
    await expect(rows(page)).toHaveCount(6);
    const statuses = await page.evaluate(
      async ({ url }) => {
        const out: number[] = [];
        for (const method of ["PUT", "PATCH", "DELETE"]) {
          out.push((await fetch(url, { method, headers: { "content-type": "application/json", authorization: "Bearer e2e" }, body: method === "DELETE" ? undefined : "{}" })).status);
        }
        return out;
      },
      { url: `${API_URL}/v1/movements/${MOVEMENT_IDS.pendingUnit}` },
    );
    expect(statuses).toEqual([405, 405, 405]);
    expect(movement(state, MOVEMENT_IDS.pendingUnit).status).toBe("PENDENTE");
  });

  test("nenhum dado da tela (bens, movimentações, motivos) é persistido no navegador", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(6);
    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }),
    );
    for (const text of ["000123", "Transferência sintética", MOVEMENT_IDS.pendingUnit]) {
      expect(stored).not.toContain(text);
    }
    expect(document_cookie_free(await page.evaluate(() => document.cookie))).toBe(true);
  });
});
