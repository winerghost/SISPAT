import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";
import { defaultTech } from "./support/dashboard-mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Painéis de TECNOLOGIA (ids tech_*). Onda 3: /dashboard desenha só o catálogo
// de painéis; os blocos de Tecnologia antigos agora compõem apenas o relatório
// imprimível (/dashboard/relatorio, onde estes testes rodam, tema papel). A
// exportação CSV/XLSX e os filtros por clique/barra eram só da tela antiga: o
// equivalente atual é a exportação dos painéis do catálogo (seção própria abaixo).
// Contrato MOCKADO:
//   GET /api/v1/dashboard/tecnologia/{resumo,por-categoria,por-unidade,
//       por-status,sem-responsavel,tempo-registro}  (+ filtros categoria/tipo_ti/status)
//   GET /api/v1/dashboard/tecnologia/export?format=csv|xlsx
// Cobre: renderização com números do backend, valores ausentes como "não
// informado", tabela alternativa (sr-only) e resumo, filtros na URL (os de
// classificação SÓ nas consultas de Tecnologia), exportação, erro isolado por
// bloco, painel oculto não consulta, RH sem dados pessoais, axe e 320px.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const TECH_BLOCKS = [
  "tecnologia-indicadores",
  "tecnologia-categoria",
  "tecnologia-por-unidade",
  "tecnologia-situacao",
  "tecnologia-sem-responsavel",
  "tecnologia-tempo-registro",
] as const;
const TECH_PATHS = ["resumo", "por-categoria", "por-unidade", "por-status", "sem-responsavel", "tempo-registro"];

async function open(page: Page, opts: MockOptions = { role: "USER" }, path = "/dashboard/relatorio"): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

const block = (page: Page, id: string) => page.locator(`[data-dashboard-block=${id}]`);

async function expectTechLoaded(page: Page) {
  await expect(block(page, "tecnologia-indicadores").locator("[data-stat-card]")).toHaveCount(6, { timeout: 20_000 });
  for (const id of ["tecnologia-categoria", "tecnologia-por-unidade", "tecnologia-situacao", "tecnologia-tempo-registro"]) {
    await expect(block(page, id).locator("figure").first()).toBeVisible({ timeout: 20_000 });
  }
  await expect(block(page, "tecnologia-sem-responsavel").locator("[data-stat-card]")).toHaveCount(3, { timeout: 20_000 });
}

function techCalls(state: MockState, path: string) {
  return state.calls.filter(
    (c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `/api/v1/dashboard/tecnologia/${path}`,
  );
}

function baseCalls(state: MockState, endpoint: string) {
  return state.calls.filter(
    (c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `/api/v1/dashboard/${endpoint}`,
  );
}

test.describe("renderização", () => {
  test("seis painéis com os números do backend e rótulos de valor ausente", async ({ page }) => {
    await open(page);
    await expectTechLoaded(page);
    const stats = block(page, "tecnologia-indicadores");
    await expect(stats.locator("[data-stat-card=tec-tecnologia]")).toContainText("400");
    await expect(stats.locator("[data-stat-card=tec-nao-classificados]")).toContainText("120");
    await expect(stats.locator("[data-stat-card=tec-sem-responsavel]")).toContainText("35");
    await expect(stats).toContainText("nenhum valor é presumido");
    // Valores ausentes: texto "não classificado"/"não informado", nunca um valor padrão inventado.
    const category = block(page, "tecnologia-categoria");
    await expect(category.locator("table").first()).toContainText("Não classificado");
    await expect(category.locator("table").nth(1)).toContainText("Tipo não informado");
    await expect(block(page, "tecnologia-situacao").locator("table")).toContainText("Não informado");
  });

  test("cada gráfico tem resumo em texto e tabela alternativa com todos os números", async ({ page }) => {
    await open(page);
    await expectTechLoaded(page);
    const age = block(page, "tecnologia-tempo-registro");
    const table = age.locator("table");
    await expect(table).toContainText("Mais de 5 anos");
    await expect(table).toContainText("90");
    await expect(table).toContainText("Sem data de registro");
    // Rotulado como tempo desde o REGISTRO (não idade do equipamento nem garantia).
    await expect(age).toContainText("não é a idade do equipamento");
    await expect(age).toContainText("nenhum prazo de garantia é calculado");
    await expect(age.locator('[role="img"]').first()).toHaveAccessibleName(/tempo desde o registro/i);
    // Percentual vem pronto do backend.
    await expect(block(page, "tecnologia-sem-responsavel")).toContainText("8,8% dos bens de tecnologia");
  });

  test("RH: apenas contagens, sem dados pessoais", async ({ page }) => {
    await open(page, { role: "RH" });
    await expectTechLoaded(page);
    const text = (await page.locator("[data-dashboard-panels]").innerText()).toLowerCase();
    expect(text).not.toMatch(/@|fulano|cpf|matr[ií]cula/);
    await expect(block(page, "tecnologia-sem-responsavel")).toContainText("Somente contagens");
  });

  test("blocos vazios: estado honesto, sem gráfico de exemplo", async ({ page }) => {
    const empty = defaultTech();
    empty.resumo = { ...empty.resumo, tecnologia: 0 };
    empty["por-categoria"] = { categorias: [], tipos_ti: [] };
    empty["por-unidade"] = [];
    empty["por-status"] = [];
    empty["sem-responsavel"] = { tecnologia: 0, sem_responsavel: 0, percentual: null, por_unidade: [] };
    empty["tempo-registro"] = [];
    await open(page, { role: "USER", dashboardTech: empty });
    for (const id of TECH_BLOCKS.slice(1)) {
      await expect(block(page, id).locator("[data-dashboard-empty]")).toBeVisible({ timeout: 20_000 });
      await expect(block(page, id).locator("figure")).toHaveCount(0);
    }
  });
});

test.describe("erros e painel oculto", () => {
  test("erro em um bloco não derruba os demais e não mostra a mensagem do backend", async ({ page }) => {
    await open(page, { role: "USER", dashboardStatus: { "tecnologia/por-status": 500 } });
    const failing = block(page, "tecnologia-situacao");
    await expect(failing.locator("[data-dashboard-error]")).toBeVisible({ timeout: 20_000 });
    await expect(failing).toContainText("Nenhum valor foi estimado");
    await expect(failing.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    await expect(block(page, "tecnologia-indicadores").locator("[data-stat-card]")).toHaveCount(6);
  });

  test("painéis ocultos não consultam o backend", async ({ page }) => {
    const hidden = ["tech_summary", "tech_category", "tech_units", "tech_status", "tech_no_owner", "tech_age"];
    const order = [
      "kpis", "units", "status", "monthly", "location", "bond", "pending", "rooms", "inventory", ...hidden,
    ];
    const state = await open(page, { role: "USER", prefs: { dashboard_layout: { order, hidden } } });
    await expect(block(page, "indicadores").locator("[data-stat-card]")).toHaveCount(5, { timeout: 20_000 });
    for (const id of TECH_BLOCKS) await expect(block(page, id)).toHaveCount(0);
    for (const path of TECH_PATHS) expect(techCalls(state, path)).toHaveLength(0);
  });
});

test.describe("filtros na URL (herdados pelo relatório)", () => {
  test("classificação vai só às consultas de Tecnologia; os demais blocos não a recebem", async ({ page }) => {
    const state = await open(page, { role: "USER" }, "/dashboard/relatorio?categoria=TECNOLOGIA&status=EM_USO&located=SIM");
    await expectTechLoaded(page);
    const filters = page.locator("[data-report-filters]");
    await expect(filters).toContainText("Categoria: Tecnologia");
    await expect(filters).toContainText("Situação operacional: Em uso");
    const tech = techCalls(state, "por-categoria");
    expect(tech.length).toBeGreaterThan(0);
    for (const call of tech) {
      const q = new URL(call.url, "http://x").searchParams;
      expect([q.get("categoria"), q.get("status"), q.get("located")]).toEqual(["TECNOLOGIA", "EM_USO", "SIM"]);
    }
    for (const endpoint of ["resumo", "por-unidade", "por-situacao", "por-sala"]) {
      const calls = baseCalls(state, endpoint);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const q = new URL(call.url, "http://x").searchParams;
        expect(q.has("categoria") || q.has("status") || q.has("tipo_ti")).toBe(false);
        expect(q.get("located")).toBe("SIM");
      }
    }
    // `filtros_aplicados` da Tecnologia traz NOMES, não valores
    await expect(page.locator("main")).not.toContainText("filtros_aplicados");
  });

  test("valor inválido na URL é descartado e nunca chega ao backend", async ({ page }) => {
    const state = await open(page, { role: "USER" }, "/dashboard/relatorio?categoria=INVALIDA&tipo_ti=notebook");
    await expectTechLoaded(page);
    for (const path of TECH_PATHS) {
      for (const call of techCalls(state, path)) {
        const q = new URL(call.url, "http://x").searchParams;
        expect(q.has("categoria") || q.has("tipo_ti")).toBe(false);
      }
    }
  });
});

test.describe("sem Tecnologia antiga no /dashboard", () => {
  test("a tela do dashboard não renderiza nem consulta os blocos tecnologia-*", async ({ page }) => {
    const state = await open(page, { role: "USER" }, "/dashboard");
    await expect(page.locator("[data-equipment-panel]").first()).toBeVisible({ timeout: 20_000 });
    for (const id of TECH_BLOCKS) await expect(block(page, id)).toHaveCount(0);
    for (const path of [...TECH_PATHS, "export"]) expect(techCalls(state, path)).toHaveLength(0);
    await expect(page.locator("[data-tech-export]")).toHaveCount(0);
  });
});

test.describe("exportação (painéis do catálogo)", () => {
  test("relatório imprimível não mostra os botões de exportação", async ({ page }) => {
    await open(page, { role: "USER" }, "/dashboard/relatorio");
    await expectTechLoaded(page);
    await expect(page.locator("[data-tech-export]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Exportar/ })).toHaveCount(0);
  });

  test("erro 403 na exportação do catálogo mostra texto fixo, nunca a mensagem do backend", async ({ page }) => {
    await open(page, { role: "RH" }, "/dashboard");
    await page.route("**/api/v1/dashboard/panels/*/export**", (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({
            status: 204,
            headers: {
              "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
              "access-control-allow-headers": "authorization,content-type,accept",
            },
          })
        : route.fulfill({
            status: 403,
            headers: {
              "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
              "content-type": "application/json",
            },
            body: JSON.stringify({ error: { code: "FORBIDDEN", message: "SISPAT_BACKEND_MSG" } }),
          }),
    );
    const actions = page.locator("[data-equipment-export=equipment_by_unit_table]");
    await expect(actions).toBeVisible({ timeout: 20_000 });
    await actions.getByRole("button", { name: /Exportar CSV/ }).click();
    await expect(actions.getByRole("alert")).toHaveText("Seu perfil não tem permissão para exportar.");
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });
});

test.describe("acessibilidade e responsividade", () => {
  test("axe sem violações com os painéis de Tecnologia", async ({ page }) => {
    await open(page);
    await expectTechLoaded(page);
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });

  for (const width of [320, 768, 1920]) {
    test(`sem rolagem horizontal da página em ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await expectTechLoaded(page);
      await waitForAnimations(page);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main") ?? document.documentElement;
        return {
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          main: main.scrollWidth - main.clientWidth,
        };
      });
      expect(overflow.doc).toBeLessThanOrEqual(1);
      expect(overflow.main).toBeLessThanOrEqual(1);
    });
  }
});
