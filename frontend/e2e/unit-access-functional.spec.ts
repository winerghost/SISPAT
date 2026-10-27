import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";
import { waitForAnimations } from "./support/screens";
import { defaultUnitAccess } from "./support/unit-access-mocks";


// =============================================================================
// /administracao/vinculos-unidades — consulta SOMENTE LEITURA (ADM).
// Mock sintético de GET /v1/admin/unit-access. A autorização é do BACKEND
// (simulada no mock); aqui validamos o que a interface mostra e envia (só GET,
// query em allowlist), os filtros na URL, os estados e overflow/axe.
// O nome do arquivo casa com o projeto "e2e" (testMatch /functional\.spec\.ts/).
// =============================================================================

const PATH = "/administracao/vinculos-unidades";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const UNIT_B = "60000000-0000-4000-8000-000000000002";
const TABLE = "Vínculos de usuários com unidades";

test.use({ viewport: { width: 1366, height: 768 } });

async function open(page: Page, opts: MockOptions = { role: "ADM" }, path = PATH): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

function accessCalls(state: MockState): string[] {
  return state.calls.filter((c) => c.url.includes("/v1/admin/unit-access")).map((c) => `${c.method} ${c.url}`);
}

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

test.describe("ADM — lista", () => {
  test("tabela paginada, só GET, sem e-mail/telefone, sem botões de escrita", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "Vínculos de Unidades" })).toBeVisible();
    const table = page.getByRole("table", { name: TABLE });
    await expect(table).toBeVisible();
    await expect(table.getByTestId("unit-access-row")).toHaveCount(30);
    await expect(page.getByText("Exibindo 1–30 de 30 usuário(s)")).toBeVisible();
    await expect(table.getByRole("list", { name: "Unidades de Pessoa Vinculada 05" }).getByText("PSU-TO")).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("@");
    await expect(page.getByRole("main").getByRole("button", { name: /^(Nov|Editar|Salvar|Excluir|Inativar|Vincular)/ })).toHaveCount(0);
    expect(accessCalls(state)).toEqual(["GET /api/v1/admin/unit-access?sort=name&page=1&page_size=50"]);
  });

  test("paginação 50/100/200 grava page/page_size na URL e mostra o restante", async ({ page }) => {
    const state = await open(page, { role: "ADM", unitAccess: defaultUnitAccess(130) });
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await expect(page.getByText("Exibindo 1–50 de 130 usuário(s)")).toBeVisible();
    await expect(page.getByTestId("unit-access-row")).toHaveCount(50);
    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page).toHaveURL(/\?page=2$/);
    await expect(page.getByText("Exibindo 51–100 de 130 usuário(s)")).toBeVisible();
    await page.getByRole("button", { name: "Última" }).click();
    await expect(page).toHaveURL(/\?page=3$/);
    await expect(page.getByTestId("unit-access-row")).toHaveCount(30);

    await page.getByLabel("Registros por página").selectOption("100");
    await expect(page).toHaveURL(/\?page_size=100$/);
    await expect(page.getByText("Exibindo 1–100 de 130 usuário(s)")).toBeVisible();
    await page.getByLabel("Registros por página").selectOption("200");
    await expect(page.getByTestId("unit-access-row")).toHaveCount(130);

    for (const call of accessCalls(state)) {
      const size = new URL(call.split(" ")[1]!, "http://x").searchParams.get("page_size");
      expect(["50", "100", "200"]).toContain(size);
    }
  });

  test("zebra nas linhas", async ({ page }) => {
    await open(page);
    const rows = page.getByTestId("unit-access-row");
    await expect(rows).toHaveCount(30);
    await page.mouse.move(0, 0);
    const bg = (n: number) => rows.nth(n).evaluate((el) => getComputedStyle(el).backgroundColor);
    const [a, b, c] = [await bg(0), await bg(1), await bg(2)];
    expect(a).toBe(c);
    expect(b).not.toBe(a);
  });

  test("filtro volta à página 1; 'Limpar filtros' preserva o tamanho de página", async ({ page }) => {
    await open(page, { role: "ADM", unitAccess: defaultUnitAccess(130) }, `${PATH}?page=2&page_size=100`);
    await expect(page.getByText("Exibindo 101–130 de 130 usuário(s)")).toBeVisible();
    await page.getByRole("group", { name: "Filtrar por perfil" }).getByRole("button", { name: "RH" }).click();
    await expect(page).toHaveURL(/\?role=RH&page_size=100$/);
    await expect(page.getByText(/Exibindo 1–\d+ de \d+ usuário\(s\)/)).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page).toHaveURL(/\?page_size=100$/);
    await expect(page.getByText("Exibindo 1–100 de 130 usuário(s)")).toBeVisible();
  });

  test("page_size inválido na URL (25) é normalizado e nunca chega ao backend", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, `${PATH}?page_size=25`);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await expect(page).toHaveURL(/\/administracao\/vinculos-unidades$/);
    for (const call of accessCalls(state)) expect(call).not.toContain("page_size=25");
  });

  test("nome vindo da API é texto inerte (sem HTML)", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("unit-access-row").first()).toContainText("<img src=x");
    expect(await page.locator("[data-testid=unit-access-row] img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

test.describe("ADM — filtros na URL", () => {
  test("pílulas e ordenação gravam a URL; 'Limpar filtros' restaura", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await page.getByRole("group", { name: "Filtrar por perfil" }).getByRole("button", { name: "RH" }).click();
    await expect(page).toHaveURL(/\?role=RH$/);
    await expect(page.getByText("Exibindo 1–10 de 10 usuário(s)")).toBeVisible();
    await page.getByRole("group", { name: "Filtrar por situação" }).getByRole("button", { name: "Inativos" }).click();
    await expect(page).toHaveURL(/\?role=RH&active=false$/);
    await page.getByRole("button", { name: /Usuário/ }).click();
    await expect(page).toHaveURL(/sort=-name/);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page).toHaveURL(/\/administracao\/vinculos-unidades$/);
    await expect(page.getByText("Exibindo 1–30 de 30 usuário(s)")).toBeVisible();
  });

  test("filtro por unidade usa a lista de unidades do escopo", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await expect(page.getByLabel("Unidade", { exact: true }).locator("option")).toHaveCount(4);
    await page.getByLabel("Unidade", { exact: true }).selectOption(UNIT_B);
    await expect(page).toHaveURL(new RegExp(`\\?unit_id=${UNIT_B}$`));
    await expect(page.getByText(/Exibindo 1–\d+ de \d+ usuário\(s\)/)).toBeVisible();
    expect(accessCalls(state).some((c) => c.includes(`unit_id=${UNIT_B}`))).toBe(true);
  });

  test("URL com lixo é normalizada e nenhum parâmetro inválido chega ao backend", async ({ page }) => {
    const state = await open(
      page,
      { role: "ADM" },
      `${PATH}?role=ROOT&active=talvez&sort=email&page=0&unit_id=nao-e-uuid&q=x&role=RH&foo=bar`,
    );
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await expect(page).toHaveURL(/\/administracao\/vinculos-unidades$/);
    for (const call of accessCalls(state)) {
      expect(call).not.toMatch(/ROOT|talvez|email|foo|q=x|nao-e-uuid/);
    }
  });

  test("filtros vindos do link são aplicados", async ({ page }) => {
    await open(page, { role: "ADM" }, `${PATH}?role=RH&active=true`);
    await expect(page.getByRole("group", { name: "Filtrar por perfil" }).getByRole("button", { name: "RH" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toBeVisible();
  });
});

test.describe("acesso restrito (negar por padrão)", () => {
  for (const role of ["USER", "RH"] as const) {
    test(`${role}: painel de acesso restrito, sem chamar /admin/unit-access`, async ({ page }) => {
      const state = await open(page, { role });
      await expect(page.getByTestId("access-restricted")).toBeVisible();
      await expect(page.getByRole("table", { name: TABLE })).toHaveCount(0);
      expect(accessCalls(state)).toEqual([]);
    });
  }

  test("/me com erro: nega por padrão", async ({ page }) => {
    await open(page, { role: "ADM", meStatus: 500 });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
  });

  test("ADM que recebe 403 do backend vê acesso restrito sem vazar detalhe", async ({ page }) => {
    await open(page, { role: "ADM", unitAccessStatus: 403 });
    const panel = page.getByTestId("access-restricted");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("verificação em duas etapas");
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
  });

  test("ADM com AAL1: backend nega (AAL2_REQUIRED) e a tela vira acesso restrito", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
  });
});

test.describe("estados", () => {
  test("carregando: esqueleto anunciado até a resposta chegar", async ({ page }) => {
    await open(page, { role: "ADM", unitAccessDelayMs: 1500 });
    await expect(page.getByRole("status").filter({ hasText: "Carregando vínculos…" })).toBeVisible();
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible({ timeout: 10_000 });
  });

  test("erro 500: mensagem sem detalhe do backend e 'Tentar novamente' recupera", async ({ page }) => {
    const state = await open(page, { role: "ADM", unitAccessStatus: 500 });
    await expect(page.getByText("Não foi possível carregar os vínculos de unidades. Tente novamente.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
    state.unitAccessStatus = null;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
  });

  test("vazio sem filtro e vazio com filtro têm mensagens distintas", async ({ page }) => {
    await open(page, { role: "ADM", unitAccess: [] });
    await expect(page.getByText("Nenhum vínculo encontrado.")).toBeVisible();
    await page.getByRole("group", { name: "Filtrar por perfil" }).getByRole("button", { name: "RH" }).click();
    await expect(page.getByText("Nenhum vínculo encontrado para os filtros atuais.")).toBeVisible();
  });

  test("usuário sem unidade no escopo mostra texto neutro", async ({ page }) => {
    const items = defaultUnitAccess().slice(0, 1).map((u) => ({ ...u, name: "Sem Unidade", units: [] }));
    await open(page, { role: "ADM", unitAccess: items });
    await expect(page.getByText("Nenhuma unidade do seu escopo")).toBeVisible();
  });
});

test.describe("responsivo e acessibilidade", () => {
  for (const width of [320, 768, 1280, 1920]) {
    test(`${width}px: sem overflow horizontal e sem violações axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await open(page);
      await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      // A entrada escalonada das linhas (fade) termina antes do axe medir contraste.
      await waitForAnimations(page);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test("item destacado no menu e ordenação com aria-sort", async ({ page }) => {
    await open(page);
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    await expect(nav.locator(`a[href="${PATH}"]`)).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("columnheader", { name: /Usuário/ })).toHaveAttribute("aria-sort", "ascending");
  });
});
