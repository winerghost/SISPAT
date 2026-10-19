import { expect, test, type Page } from "@playwright/test";

import { INACTIVE_UNIT } from "./support/catalog-mocks";
import {
  API_URL,
  expectNoXss,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
  type Role,
} from "./support/mocks";

// =============================================================================
// Menu sem 404 (onda 1): nenhum item do menu pode resultar em 404, as telas de
// consulta são SOMENTE LEITURA, e os módulos ainda sem backend mostram o painel
// honesto "Módulo em preparação" (sem dados). Mocks sintéticos; a autorização
// real é do backend — aqui validamos o que a interface mostra e envia.
// O nome do arquivo casa com o projeto "e2e" (testMatch /functional\.spec\.ts/).
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const COMMON_LEAVES = [
  "/",
  "/dashboard",
  "/patrimonios",
  "/unidades",
  "/salas-localizacoes",
  "/responsaveis",
  "/inventarios",
  "/movimentacoes",
  "/relatorios",
  "/importacoes",
];
const SETTINGS_LEAVES = ["/configuracoes/perfil", "/configuracoes/seguranca", "/configuracoes/aparencia"];
const ADMIN_LEAVES = [
  "/administracao/usuarios",
  "/administracao/unidades",
  "/administracao/salas",
  "/administracao/responsaveis",
  "/administracao/perfis-permissoes",
  "/administracao/vinculos-unidades",
  "/administracao/auditoria",
  "/administracao/integracoes",
  "/administracao/importacao/google-sheets",
  "/administracao/importacao/cadastros",
  "/administracao/configuracoes-sistema",
];
const ADMIN_MODULES = [
  "/administracao/vinculos-unidades",
  "/administracao/auditoria",
  "/administracao/integracoes",
  "/administracao/configuracoes-sistema",
];
/** Módulos sem backend abertos por todos os perfis. */
const OPEN_MODULES: [string, string][] = [["/relatorios", "Relatórios"]];

/** Hrefs esperados no menu lateral por perfil (ordenados). */
function expectedMenu(role: Role): string[] {
  const hrefs = [...COMMON_LEAVES, ...SETTINGS_LEAVES];
  if (role === "ADM") hrefs.push(...ADMIN_LEAVES, "/configuracoes/inteligencia-artificial");
  return hrefs.sort();
}

async function open(page: Page, path: string, opts: MockOptions): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  const response = await page.goto(path);
  expect(response?.status(), `HTTP de ${path}`).toBe(200);
  await waitForHydration(page);
  return state;
}

function apiPaths(state: MockState): string[] {
  return state.calls
    .filter((c) => c.url.startsWith("/api/v1/") && c.method !== "OPTIONS")
    .map((c) => `${c.method} ${c.url.split("?")[0]!.replace("/api", "")}`);
}

// ---------------------------------------------------------------------------
// Menu por perfil e nenhuma rota 404
// ---------------------------------------------------------------------------

test.describe("menu lateral por perfil", () => {
  for (const role of ["ADM", "USER", "RH"] as const) {
    test(`${role}: links do menu = os esperados do perfil`, async ({ page }) => {
      await open(page, "/", { role });
      const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
      await expect(nav.getByRole("link", { name: "Patrimônios" })).toBeVisible();
      const hrefs = (await nav.locator("a").evaluateAll((els) => els.map((el) => el.getAttribute("href")))).sort();
      expect(hrefs).toEqual(expectedMenu(role));
      // O grupo Administração (e o item "Importações" visível a todos) segue a regra de perfil.
      await expect(nav.getByRole("button", { name: "Administração" })).toHaveCount(role === "ADM" ? 1 : 0);
    });
  }
});

test.describe("nenhum item de menu resulta em 404", () => {
  for (const role of ["ADM", "USER", "RH"] as const) {
    for (const href of expectedMenu(role)) {
      test(`${role}: ${href}`, async ({ page }) => {
        await open(page, href, { role });
        await expect(page.locator("main h1").first()).toBeVisible();
        await expect(page.getByText("This page could not be found")).toHaveCount(0);
      });
    }
  }

  test("ADM: grupos pai /administracao e /configuracoes existem", async ({ page }) => {
    await open(page, "/configuracoes", { role: "ADM" });
    await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
    await page.goto("/administracao");
    await expect(page).toHaveURL(/\/administracao\/usuarios$/);
    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Rotas pai e importações
// ---------------------------------------------------------------------------

test.describe("/administracao e /importacoes", () => {
  test("ADM: /importacoes redireciona para a importação de cadastros", async ({ page }) => {
    await open(page, "/importacoes", { role: "ADM" });
    await expect(page).toHaveURL(/\/administracao\/importacao\/cadastros$/);
    await expect(page.getByRole("heading", { level: 1, name: "Cadastros de apoio" })).toBeVisible();
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role}: /administracao nega por padrão, sem chamar a API de usuários`, async ({ page }) => {
      const state = await open(page, "/administracao", { role });
      await expect(page.getByTestId("access-restricted")).toBeVisible();
      await expect(page).toHaveURL(/\/administracao$/);
      expect(apiPaths(state).filter((p) => p.includes("/v1/users"))).toEqual([]);
    });

    test(`${role}: /importacoes mostra acesso restrito`, async ({ page }) => {
      await open(page, "/importacoes", { role });
      await expect(page.getByRole("heading", { level: 1, name: "Importações" })).toBeVisible();
      await expect(page.getByTestId("access-restricted")).toContainText("administradores");
      await expect(page).toHaveURL(/\/importacoes$/);
    });
  }

  test("/me falha: /administracao não redireciona nem libera nada", async ({ page }) => {
    await open(page, "/administracao", { role: "ADM", meStatus: 500 });
    await expect(page).toHaveURL(/\/administracao$/);
    await expect(page.getByTestId("access-restricted")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Módulos sem backend
// ---------------------------------------------------------------------------

test.describe("módulos em preparação", () => {
  for (const [path, title] of OPEN_MODULES) {
    test(`${path}: painel honesto, sem tabela nem números, só /me no backend`, async ({ page }) => {
      const state = await open(page, path, { role: "USER" });
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      const panel = page.getByTestId("module-state-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { level: 2, name: "Módulo em preparação" })).toBeVisible();
      await expect(panel.getByRole("heading", { level: 3, name: "O que o módulo fará" })).toBeVisible();
      await expect(panel.getByRole("heading", { level: 3, name: "Próxima entrega" })).toBeVisible();
      await expect(panel.getByRole("link", { name: "Voltar ao início" })).toHaveAttribute("href", "/");
      // Nada de dados: sem tabela e sem dígitos no painel.
      await expect(page.getByRole("table")).toHaveCount(0);
      expect(await panel.innerText()).not.toMatch(/\d/);
      // Só identidade/preferências: nenhuma API de dados patrimoniais.
      expect(
        apiPaths(state).filter((p) => !["GET /v1/me", "GET /v1/me/preferences", "GET /v1/me/avatar-url"].includes(p)),
      ).toEqual([]);
    });
  }

  test("/patrimonios destaca o item no menu e aparece na trilha", async ({ page }) => {
    await open(page, "/patrimonios", { role: "USER" });
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    await expect(nav.getByRole("link", { name: "Patrimônios" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Trilha de navegação" })).toContainText("Patrimônios");
  });

  for (const path of ADMIN_MODULES) {
    test(`ADM: ${path} mostra o painel, com destaque no menu`, async ({ page }) => {
      await open(page, path, { role: "ADM" });
      await expect(page.getByTestId("module-state-panel")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Navegação principal", exact: true }).locator(`a[href="${path}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.getByRole("navigation", { name: "Trilha de navegação" })).toContainText("Administração");
    });

    for (const role of ["USER", "RH"] as const) {
      test(`${role}: ${path} nega por padrão`, async ({ page }) => {
        await open(page, path, { role });
        await expect(page.getByTestId("access-restricted")).toBeVisible();
        await expect(page.getByTestId("module-state-panel")).toHaveCount(0);
      });
    }

    test(`/me com erro: ${path} nega por padrão`, async ({ page }) => {
      await open(page, path, { role: "ADM", meStatus: 500 });
      await expect(page.getByTestId("access-restricted")).toBeVisible();
      await expect(page.getByTestId("module-state-panel")).toHaveCount(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Telas de consulta (somente leitura)
// ---------------------------------------------------------------------------

const WRITE_BUTTON = /^(Nov[ao]|Editar|Gerenciar|Inativar|Reativar|Salvar|Excluir)/;

async function expectReadOnly(page: Page, state: MockState): Promise<void> {
  await expect(page.getByRole("main").getByRole("button", { name: WRITE_BUTTON })).toHaveCount(0);
  expect(state.calls.filter((c) => !["GET", "OPTIONS"].includes(c.method) && c.url.startsWith("/api/"))).toEqual([]);
}

test.describe("/unidades (GET /units/accessible)", () => {
  test("USER: lista o escopo, inclusive inativa, sem ações nem atalho de cadastro", async ({ page }) => {
    const state = await open(page, "/unidades", { role: "USER" });
    const table = page.getByRole("table", { name: "Unidades" });
    await expect(table).toBeVisible();
    for (const header of ["Sigla", "Nome", "Situação"]) {
      await expect(table.getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    await expect(table.getByText("PSU-TO")).toBeVisible();
    await expect(table.getByText(INACTIVE_UNIT.code)).toBeVisible();
    await expect(table.getByText("Inativa", { exact: true })).toBeVisible();
    await expect(page.getByText("Página 1 de 1 · 4 unidade(s)")).toBeVisible();
    await expect(page.getByRole("link", { name: /Gerenciar cadastro/ })).toHaveCount(0);
    await expectReadOnly(page, state);
    expect(apiPaths(state)).toContain("GET /v1/units/accessible");
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("busca e situação filtram localmente (sem acento), ordenação e limpar filtros", async ({ page }) => {
    const state = await open(page, "/unidades", { role: "RH" });
    const table = page.getByRole("table", { name: "Unidades" });
    await expect(table).toBeVisible();
    await page.getByRole("searchbox", { name: "Buscar unidade por sigla ou nome" }).fill("escritorio");
    await expect(page.getByText("Página 1 de 1 · 1 unidade(s)")).toBeVisible();
    await expect(table.getByText("ESC-02")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.getByText("4 unidade(s)")).toBeVisible();
    await page.getByRole("group", { name: "Filtrar por situação" }).getByRole("button", { name: "Inativas" }).click();
    await expect(page.getByText("1 unidade(s)")).toBeVisible();
    await expect(table.getByText(INACTIVE_UNIT.code)).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await table.getByRole("button", { name: /^Sigla/ }).click();
    await expect(table.getByRole("columnheader", { name: /Sigla/ })).toHaveAttribute("aria-sort", "descending");
    // Busca e ordenação são locais: a API de unidades é consultada uma vez, sem parâmetros.
    expect(state.calls.filter((c) => c.url.includes("/units/accessible")).map((c) => c.url)).toEqual([
      "/api/v1/units/accessible",
    ]);
  });

  test("ADM: atalho para o cadastro de unidades", async ({ page }) => {
    await open(page, "/unidades", { role: "ADM" });
    await expect(page.getByRole("link", { name: /Gerenciar cadastro de unidades/ })).toHaveAttribute(
      "href",
      "/administracao/unidades",
    );
  });

  for (const [status, message] of [
    [403, "Você não tem permissão para consultar as unidades."],
    [404, "Nada foi encontrado no seu escopo de unidades."],
    [500, "Não foi possível carregar as unidades. Tente novamente."],
  ] as const) {
    test(`erro ${status}: mensagem fixa, sem eco do backend`, async ({ page }) => {
      await open(page, "/unidades", { role: "USER", accessibleUnitsStatus: status });
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    });
  }

  test("ADM sem AAL2: mensagem de verificação em duas etapas", async ({ page }) => {
    await open(page, "/unidades", { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("alert").filter({ hasText: "duas etapas" })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("/salas-localizacoes (GET /rooms)", () => {
  test("USER: colunas, filtro por unidade vai para a API, sem ações de escrita", async ({ page }) => {
    const state = await open(page, "/salas-localizacoes", { role: "USER" });
    const table = page.getByRole("table", { name: "Salas" });
    await expect(table).toBeVisible();
    for (const header of ["Nome", "Unidade", "Andar", "Situação", "Atualizada em"]) {
      await expect(table.getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    await expect(page.getByText("Página 1 de 1 · 4 sala(s)")).toBeVisible();
    await expect(page.getByRole("link", { name: /Gerenciar cadastro/ })).toHaveCount(0);
    await expectReadOnly(page, state);

    const request = page.waitForRequest((r) => r.url().includes("/v1/rooms?") && r.url().includes("unit_id="));
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: "PSU-TO — Procuradoria Seccional Sintética de Palmas" });
    expect(new URL((await request).url()).searchParams.get("unit_id")).toBe("60000000-0000-4000-8000-000000000001");
    await expect(page.getByText("Página 1 de 1 · 2 sala(s)")).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("busca com debounce e situação enviam parâmetros do contrato", async ({ page }) => {
    await open(page, "/salas-localizacoes", { role: "RH" });
    await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
    const request = page.waitForRequest((r) => r.url().includes("/v1/rooms?") && r.url().includes("q=audit"));
    await page.getByRole("searchbox", { name: "Buscar sala por nome" }).fill("audit");
    const url = new URL((await request).url());
    expect(url.searchParams.get("q")).toBe("audit");
    expect(url.searchParams.get("page_size")).toBe("25");
    await expect(page.getByText("Auditório Sintético")).toBeVisible();
    await expect(page.getByText("1 sala(s)")).toBeVisible();
  });

  test("ADM: atalho para o cadastro de salas", async ({ page }) => {
    await open(page, "/salas-localizacoes", { role: "ADM" });
    await expect(page.getByRole("link", { name: /Gerenciar cadastro de salas/ })).toHaveAttribute(
      "href",
      "/administracao/salas",
    );
  });

  test("lista de unidades do filtro indisponível: avisa, mas a listagem continua", async ({ page }) => {
    await open(page, "/salas-localizacoes", { role: "USER", accessibleUnitsStatus: 404 });
    await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "lista de unidades para o filtro" })).toBeVisible();
  });

  for (const [status, message] of [
    [403, "Você não tem permissão para consultar as salas."],
    [404, "Nada foi encontrado no seu escopo de unidades."],
  ] as const) {
    test(`erro ${status}: mensagem fixa`, async ({ page }) => {
      await open(page, "/salas-localizacoes", { role: "RH", lookupListStatus: status });
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    });
  }
});

test.describe("/responsaveis (GET /responsible-people)", () => {
  test("USER: só as colunas cujas chaves vieram (sem e-mail, telefone nem identificador)", async ({ page }) => {
    const state = await open(page, "/responsaveis", { role: "USER" });
    const table = page.getByRole("table", { name: "Pessoas responsáveis" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText([/^Nome/, /^Unidade/, /^Situação/]);
    await expect(table.getByText("Responsável Sem Telefone")).toBeVisible();
    await expect(page.getByTestId("telefone-mascarado")).toHaveCount(0);
    await expect(page.getByText("@exemplo.invalid")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Gerenciar cadastro/ })).toHaveCount(0);
    await expectReadOnly(page, state);
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("ADM: telefone só mascarado, nunca completo, e atalho para o cadastro", async ({ page }) => {
    await open(page, "/responsaveis", { role: "ADM" });
    const table = page.getByRole("table", { name: "Pessoas responsáveis" });
    await expect(table.getByRole("columnheader", { name: "Telefone" })).toBeVisible();
    await expect(table.getByText("(••) •••••-4567")).toBeVisible();
    await expect(page.getByText("63991234567")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Gerenciar cadastro de responsáveis/ })).toHaveAttribute(
      "href",
      "/administracao/responsaveis",
    );
  });

  test("RH sem a chave phone: coluna de telefone não existe", async ({ page }) => {
    await open(page, "/responsaveis", { role: "RH", catalogHidePhone: true });
    const table = page.getByRole("table", { name: "Pessoas responsáveis" });
    await expect(table.getByRole("columnheader", { name: "Telefone" })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: /E-mail/ })).toBeVisible();
    await expect(page.getByTestId("telefone-mascarado")).toHaveCount(0);
  });

  test("filtro de unidade e busca enviam parâmetros do contrato", async ({ page }) => {
    await open(page, "/responsaveis", { role: "USER" });
    await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
    const request = page.waitForRequest((r) => r.url().includes("/v1/responsible-people?") && r.url().includes("active=false"));
    await page.getByRole("group", { name: "Filtrar por situação" }).getByRole("button", { name: "Inativas" }).click();
    expect(new URL((await request).url()).searchParams.get("active")).toBe("false");
    await expect(page.getByText("Responsável Inativa Sintética")).toBeVisible();
  });

  test("erro 500: mensagem fixa e nova tentativa", async ({ page }) => {
    await open(page, "/responsaveis", { role: "RH", lookupListStatus: 500 });
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível carregar as pessoas responsáveis." })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });
});

test("toda chamada à API das telas novas sai com Authorization: Bearer", async ({ page }) => {
  const state = await installMocks(page, { role: "USER" });
  await seedSession(page, { role: "USER" });
  const unauthenticated: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(`${API_URL}/`) && request.method() !== "OPTIONS") {
      if (!(request.headers()["authorization"] ?? "").startsWith("Bearer ")) unauthenticated.push(request.url());
    }
  });
  for (const path of ["/unidades", "/salas-localizacoes", "/responsaveis", "/patrimonios", "/importacoes"]) {
    await page.goto(path);
    await waitForHydration(page);
    await page.waitForLoadState("networkidle");
  }
  expect(unauthenticated).toEqual([]);
  expect(state.calls.length).toBeGreaterThan(0);
});
