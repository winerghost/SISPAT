import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { DASHBOARD_ENDPOINTS, defaultDashboard, type DashboardEndpoint } from "./support/dashboard-mocks";
import {
  UNITS,
  XSS_IMG,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";
import { DASHBOARD_FILTERED_QUERY, expectDashboardLoaded, openMobileFilters, waitForAnimations } from "./support/screens";

// =============================================================================
// Filtros do dashboard na URL (docs/ux/DASHBOARD_PERSONALIZACAO.md).
// Contrato mockado: GET /api/v1/dashboard/* com os filtros em query string; o
// mock recusa (400) chave desconhecida/repetida/vazia/inválida, como o backend.
// Cobre: filtro → URL (debounce) → TODAS as requisições com os parâmetros;
// URL reabre filtrada; valor inválido na URL é descartado; "Limpar filtros";
// relatório herda e lista os filtros; sala depende da unidade; período
// inválido não é enviado; erro em um painel não derruba os outros; XSS nos
// rótulos; teclado no "Mais filtros"; axe com o painel aberto.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const [UNIT_1] = UNITS;
const UNIT_1_LABEL = `${UNIT_1!.code} — ${UNIT_1!.name}`;

async function open(page: Page, path = "/dashboard", opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);
const summary = (page: Page) => page.locator("[data-dashboard-filter-summary]");
const filters = (page: Page) => page.locator("[data-dashboard-filters]");
/** Seletor nativo da barra de filtros pelo rótulo visível (exato). */
const select = (page: Page, name: string) => filters(page).getByRole("combobox", { name, exact: true });

/** Query strings das chamadas GET a um endpoint do dashboard. */
function calls(state: MockState, endpoint: DashboardEndpoint): URLSearchParams[] {
  return state.calls
    .filter((c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `/api/v1/dashboard/${endpoint}`)
    .map((c) => new URL(c.url, "http://x").searchParams);
}

/** Todo endpoint (de painel) recebeu ao menos uma chamada com estes parâmetros. */
async function expectAllEndpointsCalledWith(state: MockState, expected: Record<string, string>): Promise<void> {
  const panels = DASHBOARD_ENDPOINTS.filter((e) => e !== "tipos");
  await expect
    .poll(() =>
      panels.filter(
        (endpoint) =>
          !calls(state, endpoint).some((params) => Object.entries(expected).every(([k, v]) => params.get(k) === v)),
      ),
    )
    .toEqual([]);
}

function no400(state: MockState): void {
  // O mock responde 400 a qualquer lixo; nenhuma chamada do dashboard pode ter
  // chave fora da allowlist ou repetida.
  const allowed = new Set([
    "unit_id",
    "owner_unit_id",
    "room_id",
    "responsible_person_id",
    "has_room",
    "has_responsible",
    "located",
    "bond_status",
    "tipo",
    "registrado_desde",
    "registrado_ate",
    "inventario",
    "movimentacao_pendente",
    "meses",
  ]);
  for (const endpoint of DASHBOARD_ENDPOINTS) {
    for (const params of calls(state, endpoint)) {
      for (const key of new Set(params.keys())) {
        expect(allowed.has(key), `${endpoint}: ${key}`).toBe(true);
        expect(params.getAll(key)).toHaveLength(1);
      }
    }
  }
}

test.describe("filtros na URL", () => {
  test("filtro altera a URL sem recarregar e todas as requisições levam o parâmetro", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await expect(summary(page)).toContainText("Sem filtros");
    // Marca a página: se houver recarga, o marcador some.
    await page.evaluate(() => ((window as unknown as { __sameDoc: boolean }).__sameDoc = true));

    await select(page, "Localizado").selectOption("NAO");
    await select(page, "Vínculo").selectOption("Ocioso");
    await expect(page).toHaveURL(/\/dashboard\?located=NAO&bond_status=Ocioso$/);
    expect(await page.evaluate(() => (window as unknown as { __sameDoc?: boolean }).__sameDoc)).toBe(true);

    await expectAllEndpointsCalledWith(state, { located: "NAO", bond_status: "Ocioso" });
    expect(calls(state, "aquisicoes-mensais").at(-1)?.get("meses")).toBe("6");
    // Debounce: as duas trocas seguidas viram UMA rodada (nenhuma chamada só com o 1º filtro).
    expect(calls(state, "resumo").filter((p) => p.get("located") === "NAO" && !p.has("bond_status"))).toHaveLength(0);
    // `/tipos` nunca recebe o próprio `tipo`.
    await select(page, "Tipo").selectOption("INFORMATICA");
    await expect(page).toHaveURL(/tipo=INFORMATICA/);
    await expectAllEndpointsCalledWith(state, { tipo: "INFORMATICA" });
    expect(calls(state, "tipos").some((p) => p.has("tipo"))).toBe(false);

    await expect(summary(page)).toContainText("Os números refletem os filtros:");
    await expect(summary(page)).toContainText("Localizado: Não; Vínculo: Ocioso; Tipo: Informatica");
    await expect(summary(page)).toHaveAttribute("role", "status");
    await expectDashboardLoaded(page);
    no400(state);
  });

  test("URL com filtros reabre a tela já filtrada (link compartilhável)", async ({ page }) => {
    const state = await open(page, `/dashboard?${DASHBOARD_FILTERED_QUERY}`);
    await expectDashboardLoaded(page);
    await expect(select(page, "Unidade de uso")).toHaveValue(UNIT_1!.id);
    await expect(select(page, "Localizado")).toHaveValue("NAO");
    await expect(select(page, "Vínculo")).toHaveValue("Ocioso");
    await expect(page.getByRole("button", { name: /Mais filtros \(2\)/ })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("De", { exact: true })).toHaveValue("2026-01-01");
    await expect(select(page, "Inventário")).toHaveValue("nao_conferido");

    await expect(summary(page)).toContainText(`Unidade de uso: ${UNIT_1_LABEL}`);
    await expect(summary(page)).toContainText("Localizado: Não");
    await expect(summary(page)).toContainText("Vínculo: Ocioso");
    await expect(summary(page)).toContainText("Registrado desde: 01/01/2026");
    await expect(summary(page)).toContainText("Inventário: Não conferido");
    await expectAllEndpointsCalledWith(state, {
      unit_id: UNIT_1!.id,
      located: "NAO",
      bond_status: "Ocioso",
      registrado_desde: "2026-01-01",
      inventario: "nao_conferido",
    });
    // Nenhuma chamada sem os filtros (a tela abre já filtrada).
    expect(calls(state, "resumo").every((p) => p.get("located") === "NAO")).toBe(true);
    no400(state);
  });

  test("valor inválido, repetido ou desconhecido na URL é descartado sem quebrar a tela", async ({ page }) => {
    const state = await open(
      page,
      "/dashboard?located=XYZ&unit_id=nao-e-uuid&tipo=OUTROS&foo=bar&bond_status=Ocioso&bond_status=Servidor" +
        "&registrado_desde=2026-02-30&has_room=talvez&inventario=conferido",
    );
    await expectDashboardLoaded(page);
    // Só o válido sobrevive; a URL é normalizada.
    await expect(page).toHaveURL(/\/dashboard\?inventario=conferido$/);
    await expect(summary(page)).toContainText("Inventário: Conferido");
    await expect(summary(page)).not.toContainText("XYZ");
    await expect(select(page, "Localizado")).toHaveValue("");
    for (const endpoint of DASHBOARD_ENDPOINTS.filter((e) => e !== "tipos")) {
      expect(calls(state, endpoint).length, endpoint).toBeGreaterThan(0);
      for (const params of calls(state, endpoint)) {
        for (const key of ["located", "unit_id", "tipo", "foo", "bond_status", "registrado_desde", "has_room"]) {
          expect(params.has(key), `${endpoint}: ${key}`).toBe(false);
        }
      }
    }
    await expect(page.locator("[data-dashboard-error]")).toHaveCount(0);
    no400(state);
  });

  test("período inválido não é enviado e é explicado ao lado das datas", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await page.getByRole("button", { name: "Mais filtros" }).click();
    await page.getByLabel("De", { exact: true }).fill("2026-05-01");
    await page.getByLabel("Até", { exact: true }).fill("2026-01-01");
    await expect(page.getByText(/Período não aplicado/)).toBeVisible();
    await expect(page.getByLabel("Até", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/registrado_desde=2026-05-01$/);
    await page.getByLabel("Até", { exact: true }).fill("2026-08-31");
    await expect(page).toHaveURL(/registrado_desde=2026-05-01&registrado_ate=2026-08-31$/);
    await expect(page.getByText(/Período não aplicado/)).toHaveCount(0);
    await expectAllEndpointsCalledWith(state, { registrado_desde: "2026-05-01", registrado_ate: "2026-08-31" });
    no400(state);
  });

  test("Sala e Pessoa só habilitam após a unidade; trocar a unidade limpa a sala", async ({ page }) => {
    const state = await open(page);
    await expectDashboardLoaded(page);
    await page.getByRole("button", { name: "Mais filtros" }).click();
    const room = select(page, "Sala");
    await expect(room).toBeDisabled();
    await expect(select(page, "Pessoa responsável")).toBeDisabled();
    await expect(page.getByText("Escolha a unidade de uso para filtrar por sala.")).toBeVisible();

    await select(page, "Unidade de uso").selectOption(UNIT_1!.id);
    await expect(room).toBeEnabled();
    await expect(room.locator("option", { hasText: "Almoxarifado Sintético" })).toHaveCount(1);
    await room.selectOption({ label: "Almoxarifado Sintético" });
    await expect(page).toHaveURL(/unit_id=.*&room_id=80000000-0000-4000-8000-000000000002/);
    await expect(summary(page)).toContainText("Sala: Almoxarifado Sintético");
    await expectAllEndpointsCalledWith(state, { room_id: "80000000-0000-4000-8000-000000000002" });

    await select(page, "Unidade de uso").selectOption(UNITS[1]!.id);
    await expect(page).toHaveURL(new RegExp(`unit_id=${UNITS[1]!.id}$`));
    await expect(room).toHaveValue("");
    no400(state);
  });

  test("Limpar filtros volta ao total e limpa a URL", async ({ page }) => {
    const state = await open(page, `/dashboard?${DASHBOARD_FILTERED_QUERY}`);
    await expectDashboardLoaded(page);
    const clear = filters(page).getByRole("button", { name: "Limpar filtros" });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(summary(page)).toContainText("Sem filtros");
    await expect(select(page, "Vínculo")).toHaveValue("");
    await expect(clear).toBeDisabled();
    await expect.poll(() => calls(state, "resumo").some((p) => [...p.keys()].length === 0)).toBe(true);
    await expectDashboardLoaded(page);
  });

  test("voltar do navegador reabre a URL anterior com os filtros dela", async ({ page }) => {
    await open(page, "/dashboard?located=SIM");
    await expectDashboardLoaded(page);
    await page.goto("/dashboard?located=DESCONHECIDO");
    await waitForHydration(page);
    await expect(select(page, "Localizado")).toHaveValue("DESCONHECIDO");
    await page.goBack();
    await expect(select(page, "Localizado")).toHaveValue("SIM");
    await expect(summary(page)).toContainText("Localizado: Sim");
  });
});

test.describe("relatório", () => {
  test("Imprimir relatório preserva os filtros; o relatório lista os filtros e os aplica", async ({ page }) => {
    const state = await open(page, `/dashboard?${DASHBOARD_FILTERED_QUERY}`);
    await expectDashboardLoaded(page);
    const link = page.getByRole("link", { name: "Imprimir relatório" });
    await expect(link).toHaveAttribute("href", `/dashboard/relatorio?${DASHBOARD_FILTERED_QUERY}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/relatorio\\?${DASHBOARD_FILTERED_QUERY.replace(/[?.]/g, "\\$&")}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Relatório patrimonial" })).toBeVisible();
    const list = page.locator("[data-report-filters]");
    await expect(list.getByRole("heading", { name: "Filtros aplicados" })).toBeVisible();
    for (const text of [
      `Unidade de uso: ${UNIT_1_LABEL}`,
      "Localizado: Não",
      "Vínculo: Ocioso",
      "Registrado desde: 01/01/2026",
      "Inventário: Não conferido",
    ]) {
      await expect(list.getByText(text, { exact: true })).toBeVisible();
    }
    await expectDashboardLoaded(page);
    // Navegação cliente reaproveita o cache (queryKeys com os filtros); numa
    // carga nova o próprio relatório envia os filtros a todos os endpoints.
    state.calls.length = 0;
    await page.reload();
    await waitForHydration(page);
    await expectDashboardLoaded(page);
    await expectAllEndpointsCalledWith(state, { located: "NAO", bond_status: "Ocioso", inventario: "nao_conferido" });
    no400(state);
    // O relatório não oferece controles de filtro e volta com os mesmos filtros.
    await expect(page.locator("[data-dashboard-filters]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Voltar ao dashboard" })).toHaveAttribute(
      "href",
      `/dashboard?${DASHBOARD_FILTERED_QUERY}`,
    );
  });

  test("relatório sem filtros diz que não há filtro", async ({ page }) => {
    await open(page, "/dashboard/relatorio");
    await expect(page.locator("[data-report-filters]")).toContainText("Nenhum — todos os bens visíveis para o perfil.");
  });
});

test.describe("painéis novos", () => {
  test("erro em um painel novo não derruba os outros; nova tentativa recupera", async ({ page }) => {
    const state = await open(page, "/dashboard", { role: "USER", dashboardStatus: { "por-vinculo": 500, inventario: 500 } });
    const failed = block(page, "por-vinculo");
    await expect(failed.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 20_000 });
    await expect(block(page, "inventario").locator("[data-dashboard-error]")).toBeVisible();
    await expect(failed).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(block(page, "por-sala").locator("figure")).toBeVisible({ timeout: 20_000 });
    await expect(block(page, "localizacao-por-unidade").locator("figure")).toBeVisible();
    await expect(block(page, "pendencias-cadastro").locator("[data-stat-card]")).toHaveCount(4);

    state.dashboardStatus = {};
    await failed.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(failed.locator("figure")).toBeVisible({ timeout: 20_000 });
  });

  test("rótulos da planilha (vínculo, sala, unidade) são texto puro: XSS não executa", async ({ page }) => {
    const base = defaultDashboard();
    const dashboard = {
      "por-vinculo": [{ id: "x", label: `Vínculo ${XSS_IMG}`, value: 10 }, ...base["por-vinculo"]],
      "por-sala": [{ id: "80000000-0000-4000-8000-0000000000ee", label: `Sala ${XSS_IMG}`, value: 9 }, ...base["por-sala"]],
      "localizacao-por-unidade": [
        { unidade: `Unid ${XSS_IMG}`, sim: 1, nao: 1, desconhecido: 0, total: 2 },
        ...base["localizacao-por-unidade"],
      ],
    };
    await open(page, "/dashboard", { role: "USER", dashboard });
    await expectDashboardLoaded(page);
    await expect(block(page, "por-vinculo").getByRole("list", { name: /Legenda/ })).toContainText(`Vínculo ${XSS_IMG}`);
    await expect(block(page, "por-sala").getByRole("table")).toContainText(`Sala ${XSS_IMG}`);
    await expect(block(page, "localizacao-por-unidade").getByRole("table")).toContainText(`Unid ${XSS_IMG}`);
    // Unidades (com XSS no nome) também aparecem como texto no seletor.
    await expect(select(page, "Unidade de uso").locator("option", { hasText: "NUC-03" })).toHaveCount(1);
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("números exatos do backend nos painéis novos", async ({ page }) => {
    await open(page);
    await expectDashboardLoaded(page);
    const loc = block(page, "localizacao-por-unidade");
    await expect(loc.getByRole("img", { name: /Gráfico de barras empilhadas/ })).toBeVisible();
    await expect(loc.getByRole("table").getByRole("row", { name: /Sede Sintética Palmas.*50.*620.*30/ })).toHaveCount(1);
    await expect(block(page, "por-vinculo").getByRole("list", { name: /Legenda/ })).toContainText("Sem vínculo");
    await expect(block(page, "por-sala").getByRole("table")).toContainText("Recepção Sintética");
    const pend = block(page, "pendencias-cadastro");
    await expect(pend.locator("[data-stat-card=sem-responsavel]")).toContainText("140");
    await expect(pend.locator("[data-stat-card=ociosos]")).toContainText("200");
    const inv = block(page, "inventario");
    await expect(inv.locator("[data-stat-card=conferidos]")).toContainText("900");
    await expect(inv.locator("[data-stat-card=nao-encontrados]")).toContainText("30");
  });
});

test.describe("teclado e acessibilidade", () => {
  test("Mais filtros: disclosure por teclado (Enter/Espaço), foco segue para os campos", async ({ page }) => {
    await open(page);
    await expectDashboardLoaded(page);
    const more = page.getByRole("button", { name: "Mais filtros" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const controls = await more.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toBeHidden();

    await more.focus();
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
    await expect(more).toBeFocused();
    await expect(more).toHaveCSS("box-shadow", /rgb/);

    // Tab percorre os campos visíveis e chega aos de "Mais filtros".
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await select(page, "Unidade pertencente").evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);

    await more.focus();
    await page.keyboard.press(" ");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(select(page, "Unidade pertencente")).toHaveCount(0);
  });

  test("axe com Mais filtros aberto e período inválido (WCAG 2.2 AA)", async ({ page }) => {
    await open(page, `/dashboard?${DASHBOARD_FILTERED_QUERY}`);
    await expectDashboardLoaded(page);
    await page.getByLabel("Até", { exact: true }).fill("2020-01-01");
    await expect(page.getByText(/Período não aplicado/)).toBeVisible();
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  for (const width of [320, 768]) {
    test(`${width}px: filtros sem rolagem horizontal, alvos >= 24px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, `/dashboard?${DASHBOARD_FILTERED_QUERY}`);
      await expectDashboardLoaded(page);
      // < 768px a barra é recolhível (fechada por padrão): abre para medir os campos.
      await openMobileFilters(page);
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
      for (const control of await filters(page).locator("select:visible, input:visible, button:visible").all()) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(24);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    });
  }
});
