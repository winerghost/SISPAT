import { expect, test, type Page } from "@playwright/test";

import { EMPTY_BLOCKS, KPI_CARDS, defaultDashboard, emptyDashboard, emptyTech } from "./support/dashboard-mocks";
import {
  installMocks,
  seedSession,
  waitForHydration,
  XSS_IMG,
  type MockOptions,
  type MockState,
} from "./support/mocks";
import { expectDashboardLoaded } from "./support/screens";

// =============================================================================
// /dashboard e /dashboard/relatorio. Contrato mockado:
// GET /api/v1/dashboard/{resumo,por-unidade,por-situacao,aquisicoes-mensais,
// localizacao-por-unidade,por-vinculo,pendencias-cadastro,por-sala,inventario}.
// (Filtros na URL: dashboard-filters-functional.spec.ts.)
// Cobre números exatos do backend, variação, indicadores indisponíveis (nunca
// números inventados), gráficos acessíveis, estados por bloco, validação por
// allowlist, texto puro, navegação e impressão.
// (axe + 320–1920px: telas dashboard-* em support/screens.ts.)
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

async function open(page: Page, path: string, opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);

test.describe("dashboard", () => {
  test("KPIs mostram exatamente os números do backend", async ({ page }) => {
    await open(page, "/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const kpis = block(page, "indicadores");
    await expect(kpis.locator("[data-stat-card]")).toHaveCount(KPI_CARDS);
    await expect(kpis.locator("[data-stat-card=total-bens]")).toContainText(/1\.?234/);
    await expect(kpis.locator("[data-stat-card=total-bens]")).toContainText("37 novos nos últimos 30 dias");
    await expect(kpis.locator("[data-stat-card=localizados]")).toContainText(/1\.?100/);
    await expect(kpis.locator("[data-stat-card=nao-localizados]")).toContainText("90");
    await expect(kpis.locator("[data-stat-card=nao-localizados]")).toContainText("44 com localização desconhecida");
    await expect(kpis.locator("[data-stat-card=movimentacoes-pendentes]")).toContainText("12");
    await expect(kpis.locator("[data-stat-card=inventarios-abertos]")).toContainText("2");
  });

  test("número do KPI usa a escala heading do DESIGN.md (36px)", async ({ page }) => {
    await open(page, "/dashboard");
    const value = block(page, "indicadores").locator("[data-stat-card=total-bens] .text-heading").first();
    await expect(value).toContainText(/1\.?234/);
    await expect(value).toHaveCSS("font-size", "36px");
    await expect(value).toHaveCSS("line-height", "39.6px");
    await block(page, "indicadores").screenshot({ path: "test-results/kpi-36px.png" });
  });

  test("variação positiva: selo com sinal e texto", async ({ page }) => {
    await open(page, "/dashboard");
    const delta = block(page, "indicadores").locator("[data-stat-card=total-bens] [data-stat-delta]");
    await expect(delta).toContainText("+3,5%");
    await expect(delta).toContainText("aumento de 3,5%");
  });

  test("variação negativa: selo com sinal de menos", async ({ page }) => {
    const base = defaultDashboard().resumo;
    const resumo = { ...base, variacao: { ...base.variacao, total_bens: -2.1 } };
    await open(page, "/dashboard", { role: "USER", dashboard: { resumo } });
    await expect(block(page, "indicadores").locator("[data-stat-delta]")).toContainText("−2,1%");
  });

  test("variação null: nenhum selo", async ({ page }) => {
    const base = defaultDashboard().resumo;
    const resumo = { ...base, variacao: { ...base.variacao, total_bens: null } };
    await open(page, "/dashboard", { role: "USER", dashboard: { resumo } });
    await expect(block(page, "indicadores").locator("[data-stat-card]")).toHaveCount(KPI_CARDS);
    await expect(page.locator("[data-stat-delta]")).toHaveCount(0);
  });

  test("indicadores indisponíveis: explica a ausência e não exibe número", async ({ page }) => {
    await open(page, "/dashboard");
    const box = page.locator("[data-dashboard-unavailable]");
    await expect(box.getByRole("heading", { name: "Indicadores indisponíveis" })).toBeVisible();
    await expect(box).toContainText("O cadastro de bens ainda não possui valor");
    for (const label of ["Valor total", "Em manutenção", "Baixas no ano"]) {
      await expect(box.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(box.getByText("Indisponível", { exact: true })).toHaveCount(3);
    expect(await box.innerText()).not.toMatch(/\d|R\$/);
  });

  test("gráficos: role=img com resumo, legenda e tabela alternativa", async ({ page }) => {
    await open(page, "/dashboard");
    await expectDashboardLoaded(page);

    const bars = block(page, "por-unidade");
    const barsImg = bars.getByRole("img", { name: /Gráfico de barras agrupadas/ });
    await expect(barsImg).toBeVisible();
    await expect(barsImg).toHaveAttribute("aria-label", /Sede Sintética Palmas/);
    // 5 tipos => 3 maiores + "Outros (2)" (soma dos demais).
    const legend = bars.getByRole("list", { name: /Legenda/ });
    await expect(legend.getByText("Mobiliario")).toBeVisible();
    await expect(legend.getByText("Outros (2)")).toBeVisible();
    await expect(bars.locator("[data-chart-surface=nivo] svg")).toHaveCount(1);

    const donut = block(page, "por-situacao");
    // Padrão da situação = pizza (preferência `dashboard_charts.status`).
    await expect(donut.getByRole("img", { name: /Gráfico de pizza/ })).toBeVisible();
    await expect(donut.getByRole("list", { name: /Legenda/ })).toContainText("Nao localizado");
    await expect(donut.getByRole("list", { name: /Legenda/ })).toContainText("90");

    const line = block(page, "aquisicoes-mensais");
    await expect(line.getByRole("img", { name: /Gráfico de linhas/ })).toBeVisible();
    // Mês abreviado pt-BR (America/Araguaina), não "2026-10".
    const lineTable = line.getByRole("table", { name: "Bens adquiridos por mês" });
    await expect(lineTable).not.toContainText("2026-10");
    await expect(lineTable.getByRole("row", { name: /out.*37/i })).toHaveCount(1);
    await expect(lineTable.getByRole("row", { name: /jul.*0/i })).toHaveCount(1);

    // Seleção por teclado na legenda da pizza (aria-pressed).
    const pick = donut.getByRole("button", { name: /Nao localizado/ });
    await pick.focus();
    await page.keyboard.press("Enter");
    await expect(pick).toHaveAttribute("aria-pressed", "true");
  });

  test("tabela de detalhamento: linhas por unidade e linha de total", async ({ page }) => {
    await open(page, "/dashboard");
    await expectDashboardLoaded(page);
    const table = page.getByRole("table", { name: "Detalhamento de bens por unidade e tipo" });
    await expect(table.getByRole("columnheader", { name: "Unidade" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Outros (2)" })).toBeVisible();
    await expect(table.locator("tbody th[scope=row]")).toHaveCount(3);
    const total = table.locator("tfoot tr[data-unit-total]");
    await expect(total).toContainText("Total");
    await expect(total).toContainText(/1\.?234/); // 700 + 400 + 134
    await expect(total).toContainText("660"); // mobiliário
  });

  test("nomes vindos do backend são texto puro (sem HTML/XSS)", async ({ page }) => {
    const rows = defaultDashboard()["por-unidade"];
    rows[0]!.unidade = `Unid ${XSS_IMG}`;
    await open(page, "/dashboard", { role: "USER", dashboard: { "por-unidade": rows } });
    await expectDashboardLoaded(page);
    await expect(page.getByRole("table", { name: /Detalhamento/ }).getByText(`Unid ${XSS_IMG}`)).toBeVisible();
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("sem bens: estados vazios honestos, sem gráficos nem números de exemplo", async ({ page }) => {
    await open(page, "/dashboard", { role: "RH", dashboard: emptyDashboard(), dashboardTech: emptyTech() });
    await expect(page.locator("[data-dashboard-empty]")).toHaveCount(EMPTY_BLOCKS, { timeout: 15_000 });
    await expect(block(page, "por-unidade")).toContainText("Nenhum bem cadastrado");
    await expect(block(page, "por-situacao")).toContainText("Nenhum bem para classificar");
    await expect(block(page, "aquisicoes-mensais")).toContainText("Nenhuma aquisição no período");
    await expect(block(page, "por-vinculo")).toContainText("Nenhum bem para classificar");
    // Pendências e inventário: zeros REAIS do backend (cartões, sem gráfico).
    await expect(block(page, "pendencias-cadastro").locator("[data-stat-card=sem-sala]")).toContainText("0");
    await expect(block(page, "inventario").locator("[data-stat-card=conferidos]")).toContainText("0");
    await expect(page.locator("[data-chart-surface]")).toHaveCount(0);
    await expect(page.locator("figure")).toHaveCount(0);
    // KPIs reais (zeros do backend) continuam exibidos; sem variação.
    await expect(block(page, "indicadores").locator("[data-stat-card=total-bens]")).toContainText("0");
    await expect(page.locator("[data-stat-delta]")).toHaveCount(0);
  });

  test("erro em um bloco não derruba os outros; nova tentativa recupera", async ({ page }) => {
    const state = await open(page, "/dashboard", { role: "USER", dashboardStatus: { "por-situacao": 500 } });
    const failed = block(page, "por-situacao");
    const retry = failed.getByRole("button", { name: "Tentar novamente" });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await expect(failed).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(block(page, "indicadores").locator("[data-stat-card]")).toHaveCount(KPI_CARDS);
    await expect(block(page, "por-unidade").locator("figure")).toBeVisible({ timeout: 20_000 });

    state.dashboardStatus = {};
    await retry.click();
    await expect(failed.locator("figure")).toBeVisible({ timeout: 20_000 });
    await expect(failed.getByRole("button", { name: "Tentar novamente" })).toHaveCount(0);
  });

  test("resposta fora da allowlist é rejeitada (valor_total numérico => erro)", async ({ page }) => {
    const resumo = { ...defaultDashboard().resumo, valor_total: 999999 };
    await open(page, "/dashboard", { role: "USER", dashboard: { resumo } });
    const kpis = block(page, "indicadores");
    await expect(kpis.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 20_000 });
    await expect(kpis.locator("[data-stat-card]")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("999");
  });

  test("KPIs em 2 colunas no celular e 5 (uma linha) no desktop largo", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, "/dashboard");
    const cards = block(page, "indicadores").locator("[data-stat-card]");
    await expect(cards).toHaveCount(KPI_CARDS);
    const distinctTops = async () =>
      new Set(await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))).size;
    expect(await distinctTops()).toBe(3);
    await page.setViewportSize({ width: 1366, height: 800 });
    await expect.poll(distinctTops).toBe(1);
  });

  test("reduced motion: valores finais exatos", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "/dashboard");
    await expectDashboardLoaded(page);
    await expect(block(page, "indicadores").locator("[data-stat-card=total-bens]")).toContainText(/1\.?234/);
  });
});

test.describe("navegação", () => {
  test("menu lateral tem Dashboard logo após Home e leva a /dashboard", async ({ page }) => {
    await open(page, "/", { role: "USER" });
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    const hrefs = await nav.locator("a").evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    expect(hrefs.slice(0, 2)).toEqual(["/", "/dashboard"]);
    await nav.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  });

  test("atalho da Home linka para /dashboard", async ({ page }) => {
    await open(page, "/", { role: "USER" });
    await page.getByRole("link", { name: "Abrir o Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 45_000 }); // 1ª compilação do `next dev`
  });

  for (const role of ["ADM", "USER", "RH"] as const) {
    test(`${role}: acessa /dashboard`, async ({ page }) => {
      await open(page, "/dashboard", { role });
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await expect(block(page, "indicadores").locator("[data-stat-card]")).toHaveCount(KPI_CARDS);
    });
  }
});

test.describe("relatório imprimível", () => {
  test("mesma composição, botão Imprimir chama window.print", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed += 1;
      };
    });
    await open(page, "/dashboard/relatorio", { role: "USER" });
    await expect(page.getByRole("heading", { level: 1, name: "Relatório patrimonial" })).toBeVisible();
    await expectDashboardLoaded(page);
    await expect(page.locator("[data-report-sheet]")).toContainText(/Emitido em/);
    await page.getByRole("button", { name: "Imprimir / Salvar PDF" }).click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  });

  test("em mídia print: sem sidebar/header/botões, sem rolagem interna e fundo branco", async ({ page }) => {
    await open(page, "/dashboard/relatorio", { role: "USER" });
    await expectDashboardLoaded(page);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("navigation", { name: "Navegação principal", exact: true })).toBeHidden();
    await expect(page.getByRole("banner")).toBeHidden();
    await expect(page.getByRole("button", { name: "Imprimir / Salvar PDF" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Voltar ao dashboard" })).toBeHidden();
    const info = await page.evaluate(() => {
      const main = document.getElementById("conteudo")!;
      const sheet = document.querySelector("[data-report-sheet]")!;
      return {
        mainOverflow: getComputedStyle(main).overflowY,
        sheetBg: getComputedStyle(sheet).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        blockBreak: Array.from(document.querySelectorAll("[data-dashboard-block]")).every(
          (el) => getComputedStyle(el).breakInside === "avoid",
        ),
      };
    });
    expect(info.mainOverflow).toBe("visible");
    expect(info.sheetBg).toBe("rgb(255, 255, 255)");
    expect(info.bodyBg).toBe("rgb(255, 255, 255)");
    expect(info.docScrollWidth).toBeLessThanOrEqual(info.innerWidth);
    expect(info.blockBreak).toBe(true);
    // Gráficos continuam presentes no papel.
    await expect(block(page, "aquisicoes-mensais").locator("figure")).toBeVisible();
  });
});
