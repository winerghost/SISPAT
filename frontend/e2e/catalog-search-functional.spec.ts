import { expect, test, type Page } from "@playwright/test";

import type { PersonMock } from "./support/catalog-mocks";
import { installMocks, seedSession, UNITS, waitForHydration, type MockOptions, type MockState } from "./support/mocks";

// =============================================================================
// Busca, filtros e paginação 50/100/200 dos cadastros de consulta e de
// administração (/responsaveis, /salas-localizacoes, /unidades). O backend só
// aceita page_size ∈ {50, 100, 200}; os mocks imitam essa regra (400 caso
// contrário). Dados 100% sintéticos.
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const SEARCH = "Buscar pessoa responsável por nome, e-mail ou identificador";
const U1 = UNITS[0]!;

function extraPeople(count: number): PersonMock[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `91000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    unit_id: U1.id,
    name: `Pessoa Teste ${String(i + 1).padStart(3, "0")}`,
    email: `teste${i + 1}@exemplo.invalid`,
    phone: null,
    institutional_identifier: `TST-${i + 1}`,
    active: true,
    source_record_id: null,
    created_at: "2026-10-01T12:00:00.000Z",
    updated_at: "2026-10-01T12:00:00.000Z",
  }));
}

async function open(page: Page, path: string, opts: MockOptions = { role: "ADM" }, extra = 0): Promise<MockState> {
  const state = await installMocks(page, opts);
  state.people.push(...extraPeople(extra));
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

function peopleCalls(state: MockState) {
  return state.calls
    .filter((c) => c.method === "GET" && /\/v1\/responsible-people\?/.test(c.url))
    .map((c) => new URL(c.url, "http://x").searchParams);
}

const summary = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

test.describe("/responsaveis — busca", () => {
  test("trim, espaços colapsados, caixa e envio real de q ao backend; limpar devolve o foco", async ({ page }) => {
    const state = await open(page, "/responsaveis");
    const rows = page.getByRole("table", { name: "Pessoas responsáveis" }).locator("tbody tr");
    await expect(rows).toHaveCount(4);

    const box = page.getByRole("searchbox", { name: SEARCH });
    await expect(box).toHaveAttribute("maxlength", "100");
    await box.fill("   SEM    telefone  ");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Responsável Sem Telefone");
    const last = peopleCalls(state).at(-1)!;
    expect(last.get("q")).toBe("SEM telefone");
    expect(last.get("page")).toBe("1");
    expect(last.get("page_size")).toBe("50");

    await expect(summary(page, "Exibindo 1–1 de 1 registro(s)")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("");
    await expect(rows).toHaveCount(4);
    // Lista sem q volta do cache do React Query (mesma chave da carga inicial): sem nova chamada.
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toHaveCount(0);
  });

  test("busca por e-mail e identificador (ADM) e só por nome (USER)", async ({ page }) => {
    await open(page, "/responsaveis", { role: "ADM" });
    const rows = page.getByRole("table", { name: "Pessoas responsáveis" }).locator("tbody tr");
    await page.getByRole("searchbox", { name: SEARCH }).fill("inativa.sintetica@");
    await expect(rows).toHaveCount(1);
    await page.getByRole("searchbox", { name: SEARCH }).fill("id-0004");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Sem Telefone");
  });

  test("USER: rótulo informa busca por nome", async ({ page }) => {
    await open(page, "/responsaveis", { role: "USER" });
    const box = page.getByRole("searchbox", { name: "Buscar pessoa responsável por nome" });
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("placeholder", "Buscar por nome…");
  });

  test("sem resultado: estado vazio orienta e permite limpar", async ({ page }) => {
    await open(page, "/responsaveis");
    await page.getByRole("searchbox", { name: SEARCH }).fill("nada-corresponde");
    await expect(page.getByText("Nenhuma pessoa encontrada para os filtros atuais.")).toBeVisible();
    await expect(summary(page, "Nenhum registro(s)")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.getByRole("table", { name: "Pessoas responsáveis" }).locator("tbody tr")).toHaveCount(4);
  });

  test("digitar e apagar dentro do debounce não derruba a página atual; busca nova volta à página 1", async ({ page }) => {
    const state = await open(page, "/responsaveis", { role: "ADM" }, 116); // 120 no total
    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(summary(page, "Exibindo 51–100 de 120")).toBeVisible();
    const box = page.getByRole("searchbox", { name: SEARCH });
    // Digita "x" e apaga na MESMA tarefa (determinístico: sempre dentro do debounce de 300 ms).
    await box.evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      for (const value of ["x", ""]) {
        set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.waitForTimeout(600);
    await expect(summary(page, "Exibindo 51–100 de 120")).toBeVisible();
    expect(peopleCalls(state).some((p) => p.get("q") === "x")).toBe(false);

    await box.fill("Teste 01");
    await expect(summary(page, "Exibindo 1–")).toBeVisible();
    expect(peopleCalls(state).at(-1)!.get("page")).toBe("1");
  });
});

test.describe("paginação 50/100/200", () => {
  test("/responsaveis: botões, troca de tamanho (envia só 50/100/200), zebra", async ({ page }) => {
    const state = await open(page, "/responsaveis", { role: "ADM" }, 146); // 150 no total
    const rows = page.getByRole("table", { name: "Pessoas responsáveis" }).locator("tbody tr");
    await expect(rows).toHaveCount(50);
    await expect(summary(page, "Exibindo 1–50 de 150 registro(s)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Anterior" })).toBeDisabled();

    const size = page.getByLabel("Registros por página");
    await expect(size.locator("option")).toHaveText(["50", "100", "200"]);

    // Zebra: linha par (2ª) com fundo diferente da ímpar.
    const bg = (n: number) => rows.nth(n).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bg(1)).not.toBe(await bg(0));
    expect(await bg(1)).not.toBe("rgba(0, 0, 0, 0)");

    await page.getByRole("button", { name: "Última" }).click();
    await expect(summary(page, "Exibindo 101–150 de 150")).toBeVisible();
    await expect(rows).toHaveCount(50);
    await expect(page.getByRole("button", { name: "Próxima" })).toBeDisabled();
    await page.getByRole("button", { name: "Anterior" }).click();
    await expect(summary(page, "Exibindo 51–100 de 150")).toBeVisible();

    await size.selectOption("100");
    await expect(summary(page, "Exibindo 1–100 de 150")).toBeVisible();
    await expect(rows).toHaveCount(100);
    const at100 = peopleCalls(state).at(-1)!;
    expect(at100.get("page_size")).toBe("100");
    expect(at100.get("page")).toBe("1");

    await size.selectOption("200");
    await expect(summary(page, "Exibindo 1–150 de 150")).toBeVisible();
    await expect(rows).toHaveCount(150);
    expect(peopleCalls(state).at(-1)!.get("page_size")).toBe("200");
    for (const params of peopleCalls(state)) {
      expect(["50", "100", "200"]).toContain(params.get("page_size"));
    }
  });

  test("/administracao/responsaveis e /administracao/salas usam a mesma barra", async ({ page }) => {
    test.slow();
    await open(page, "/administracao/responsaveis", { role: "ADM" }, 60);
    await expect(summary(page, "Exibindo 1–50 de 64")).toBeVisible();
    await page.getByLabel("Registros por página").selectOption("100");
    await expect(summary(page, "Exibindo 1–64 de 64")).toBeVisible();
    await page.goto("/administracao/salas");
    await waitForHydration(page);
    await expect(summary(page, "Exibindo 1–4 de 4")).toBeVisible();
    // Preferência de tamanho persiste na sessão do navegador (dado não sensível).
    await expect(page.getByLabel("Registros por página")).toHaveValue("100");
  });

  test("/unidades pagina no cliente com 50/100/200", async ({ page }) => {
    await open(page, "/unidades", { role: "RH" });
    await expect(summary(page, "Exibindo 1–4 de 4 registro(s)")).toBeVisible();
    await expect(page.getByLabel("Registros por página").locator("option")).toHaveText(["50", "100", "200"]);
  });
});

test.describe("320px", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  for (const path of ["/responsaveis", "/salas-localizacoes", "/unidades", "/administracao/responsaveis"]) {
    test(`${path}: sem rolagem horizontal da página`, async ({ page }) => {
      await open(page, path, { role: "ADM" }, 60);
      await expect(page.getByLabel("Registros por página")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
