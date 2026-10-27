import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { AUDIT_FIRST_ID, AUDIT_SECURITY_ID, AUDIT_XSS, AUDIT_XSS_ID, defaultAuditLogs } from "./support/audit-mocks";
import {
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";
import { waitForAnimations } from "./support/screens";
import {
  auditUrlQuery,
  dayEndUtc,
  dayStartUtc,
  parseAuditUrl,
  periodError,
} from "../src/lib/audit-filters";

// =============================================================================
// /administracao/auditoria — consulta SOMENTE LEITURA (ADM + AAL2 + audit.read).
// Mocks sintéticos de GET /v1/admin/audit-logs[/<id>]. A autorização e a
// projeção sem segredos são do BACKEND (simuladas no mock); aqui validamos o que
// a interface mostra, envia (só GET, só parâmetros da allowlist) e a ausência de
// overflow horizontal/violações axe. O nome casa com o projeto "e2e".
// =============================================================================

const PATH = "/administracao/auditoria";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const TABLE = "Registros de auditoria";

test.use({ viewport: { width: 1366, height: 768 } });

async function open(page: Page, opts: MockOptions = { role: "ADM" }, path = PATH): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

function auditCalls(state: MockState): string[] {
  return state.calls.filter((c) => c.url.includes("/v1/admin/audit-logs")).map((c) => `${c.method} ${c.url}`);
}

function lastListQuery(state: MockState): URLSearchParams {
  const list = auditCalls(state).filter((c) => /GET \/api\/v1\/admin\/audit-logs(\?|$)/.test(c));
  return new URL(list[list.length - 1]!.split(" ")[1]!, "http://x").searchParams;
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

test.describe("filtros da URL (puro)", () => {
  test("parse defensivo: chave repetida, valor fora do padrão e desconhecida são descartados", () => {
    const state = parseAuditUrl(
      new URLSearchParams(
        "event_type=USER_ROLE_CHANGED&event_type=OUTRO&entity_type=Invalido!&result=FALHA&severity=ultra&from=2026-02-31&page=0&id=nao-uuid&x=1",
      ),
    );
    expect(state.filters).toEqual({ result: "FALHA", sort: "-occurred_at" });
    expect(state.page).toBe(1);
    expect(state.id).toBeUndefined();
  });

  test("query canônica: sem padrões, ordem estável, ida e volta", () => {
    const raw = "entity_type=user&result=SUCESSO&from=2026-10-01&to=2026-10-20&sort=occurred_at&page=3";
    const state = parseAuditUrl(new URLSearchParams(raw));
    expect(auditUrlQuery(state)).toBe(raw);
    expect(auditUrlQuery(parseAuditUrl(new URLSearchParams("sort=-occurred_at&page=1")))).toBe("");
  });

  test("page_size: só 50/100/200 (outro valor vira 50) e vai à query só quando não é o padrão", () => {
    expect(parseAuditUrl(new URLSearchParams("page_size=100")).pageSize).toBe(100);
    for (const bad of ["25", "0", "abc", "1000", "50&page_size=100"]) {
      expect(parseAuditUrl(new URLSearchParams({ page_size: bad })).pageSize).toBe(50);
    }
    expect(parseAuditUrl(new URLSearchParams("page_size=50&page_size=100")).pageSize).toBe(50);
    const state = parseAuditUrl(new URLSearchParams("page_size=200&page=2"));
    expect(auditUrlQuery(state)).toBe("page=2&page_size=200");
    expect(auditUrlQuery(parseAuditUrl(new URLSearchParams("page_size=50")))).toBe("");
  });

  test("período só com 'de': futuro ou mais de 90 dias antes de agora é recusado", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    expect(periodError("2026-10-22", undefined, now)).toMatch(/futuro/);
    expect(periodError("2026-06-01", undefined, now)).toMatch(/90 dias/);
    expect(periodError("2026-09-01", undefined, now)).toBeNull();
    expect(periodError(undefined, "2026-01-01", now)).toBeNull();
  });

  test("datas em America/Araguaina (UTC-3) viram instantes UTC; período máximo de 90 dias", () => {
    expect(dayStartUtc("2026-10-01")).toBe("2026-10-01T03:00:00.000Z");
    expect(dayEndUtc("2026-10-01")).toBe("2026-10-02T02:59:59.999Z");
    expect(periodError("2026-10-10", "2026-10-01")).toMatch(/anterior/);
    expect(periodError("2026-01-01", "2026-10-01")).toMatch(/90 dias/);
    expect(periodError("2026-09-01", "2026-10-01")).toBeNull();
  });
});

test.describe("ADM — lista", () => {
  test("tabela com colunas, datas em Araguaina, paginação e somente GET (allowlist)", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "Auditoria" })).toBeVisible();
    const table = page.getByRole("table", { name: TABLE });
    await expect(table).toBeVisible();
    for (const header of ["Data e hora", "Evento", "Entidade", "Resultado", "Severidade", "Autor"]) {
      await expect(table.getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    await expect(page.getByText("Exibindo 1–30 de 30 registro(s)")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(30);
    // 2026-10-20T14:00Z (registro 1) = 11:00 em America/Araguaina (UTC-3).
    await expect(table.locator("tbody tr").first().locator("time")).toHaveText(/20\/10\/2026.*11:00/);
    expect(await table.locator("tbody tr").first().textContent()).toContain("Perfil alterado");

    const query = lastListQuery(state);
    expect([...query.keys()].sort()).toEqual(["page", "page_size", "sort"]);
    expect(query.get("page_size")).toBe("50");
    expect(auditCalls(state).every((c) => c.startsWith("GET "))).toBe(true);
    // 30 registros cabem numa página de 50: sem próxima página.
    await expect(page.getByRole("button", { name: "Próxima" })).toBeDisabled();
  });

  test("50/100/200 e paginação: page/page_size na URL e sempre valores válidos", async ({ page }) => {
    const opts = { role: "ADM" as const, auditLogs: defaultAuditLogs(120) };
    const state = await open(page, opts);
    const table = page.getByRole("table", { name: TABLE });
    await expect(page.getByText("Exibindo 1–50 de 120 registro(s)")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(50);

    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText("Exibindo 51–100 de 120 registro(s)")).toBeVisible();
    await page.getByRole("button", { name: "Última" }).click();
    await expect(page.getByText("Exibindo 101–120 de 120 registro(s)")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(20);

    await page.getByLabel("Registros por página").selectOption("100");
    await expect(page).toHaveURL(/page_size=100/);
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(page.getByText("Exibindo 1–100 de 120 registro(s)")).toBeVisible();
    await page.getByLabel("Registros por página").selectOption("200");
    await expect(page.getByText("Exibindo 1–120 de 120 registro(s)")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(120);

    const sizes = auditCalls(state)
      .filter((c) => /audit-logs\?/.test(c))
      .map((c) => new URL(c.split(" ")[1]!, "http://x").searchParams.get("page_size"));
    for (const size of sizes) expect(["50", "100", "200"]).toContain(size);
  });

  test("zebra nas linhas da tabela", async ({ page }) => {
    await open(page);
    const rows = page.getByRole("table", { name: TABLE }).locator("tbody tr");
    await expect(rows).toHaveCount(30);
    await page.mouse.move(0, 0);
    const bg = (n: number) => rows.nth(n).evaluate((el) => getComputedStyle(el).backgroundColor);
    const [a, b, c] = [await bg(0), await bg(1), await bg(2)];
    expect(a).toBe(c);
    expect(b).not.toBe(a);
  });

  test("mudar filtro volta para a página 1 e preserva o tamanho de página", async ({ page }) => {
    await open(page, { role: "ADM", auditLogs: defaultAuditLogs(120) }, `${PATH}?page=2&page_size=50`);
    await expect(page.getByText("Exibindo 51–100 de 120 registro(s)")).toBeVisible();
    await page.getByLabel("Resultado").selectOption("SUCESSO");
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(page).toHaveURL(/result=SUCESSO/);
    await expect(page.getByText(/Exibindo 1–50 de \d+ registro\(s\)/)).toBeVisible();
  });

  test("page_size inválido na URL (25) vira 50 e nunca chega ao backend", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, `${PATH}?page_size=25`);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    expect(lastListQuery(state).get("page_size")).toBe("50");
  });

  test("filtros viram parâmetros da allowlist, vão para a URL e podem ser limpos", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await page.getByLabel("Resultado").selectOption("FALHA");
    await page.getByLabel("Tipo de entidade").fill("user");
    await page.getByLabel("De (data)").fill("2026-10-01");
    await page.getByLabel("Até (data)").fill("2026-10-21");
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    await expect(page).toHaveURL(/result=FALHA/);
    await expect(page).toHaveURL(/entity_type=user/);
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toBeVisible();
    await expect.poll(() => lastListQuery(state).get("result")).toBe("FALHA");
    const query = lastListQuery(state);
    expect(query.get("entity_type")).toBe("user");
    expect(query.get("from")).toBe("2026-10-01T03:00:00.000Z");
    expect(query.get("to")).toBe("2026-10-22T02:59:59.999Z");
    const table = page.getByRole("table", { name: TABLE });
    for (const cell of await table.locator("tbody tr td:nth-child(4)").allTextContents()) {
      expect(cell).toContain("Falha");
    }

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page).not.toHaveURL(/result=/);
    await expect(page.getByText("Exibindo 1–30 de 30 registro(s)")).toBeVisible();
  });

  test("filtros inválidos na URL são descartados e nunca chegam ao backend", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, `${PATH}?evil=1&severity=ultra&result=FALHA&result=SUCESSO&entity_type=A!`);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    const query = lastListQuery(state);
    expect([...query.keys()].sort()).toEqual(["page", "page_size", "sort"]);
  });

  test("validação de UX no formulário: evento fora do padrão e período > 90 dias não enviam", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    const before = auditCalls(state).length;
    await page.getByLabel("Evento", { exact: true }).fill("a");
    await page.getByLabel("De (data)").fill("2026-01-01");
    await page.getByLabel("Até (data)").fill("2026-10-01");
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    await expect(page.getByText(/Use letras maiúsculas/)).toBeVisible();
    await expect(page.getByText("O período máximo é de 90 dias.")).toBeVisible();
    expect(auditCalls(state).length).toBe(before);
  });

  test("ordenação por data inverte e usa sort na allowlist", async ({ page }) => {
    const state = await open(page);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await page.getByRole("button", { name: /Data e hora/ }).click();
    await expect.poll(() => lastListQuery(state).get("sort")).toBe("occurred_at");
    await expect(page.getByRole("columnheader", { name: /Data e hora/ })).toHaveAttribute("aria-sort", "ascending");
  });

  test("vazio: mensagem e limpar filtros", async ({ page }) => {
    await open(page, { role: "ADM" }, `${PATH}?entity_type=inexistente`);
    await expect(page.getByText("Nenhum registro encontrado para os filtros atuais.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Limpar filtros" })).toBeVisible();
  });
});

test.describe("ADM — detalhe", () => {
  test("abre o painel, mostra alterações e campos omitidos, e fecha com Esc devolvendo o foco", async ({ page }) => {
    const state = await open(page);
    const button = page.getByRole("button", { name: /^Ver detalhes do registro USER_ROLE_CHANGED/ }).first();
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Perfil alterado" });
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`id=${AUDIT_FIRST_ID}`));
    await expect(sheet.getByTestId("audit-changes")).toContainText("USER");
    await expect(sheet.getByTestId("audit-changes")).toContainText("RH");
    await expect(sheet.getByTestId("audit-omitted")).toContainText("2 campo(s) não exibido(s)");
    expect(auditCalls(state)).toContain(`GET /api/v1/admin/audit-logs/${AUDIT_FIRST_ID}`);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/id=/);
    await expect(button).toBeFocused();
  });

  test("evento de segurança mostra requisição com REDE (nunca IP completo) e detalhes", async ({ page }) => {
    await open(page, { role: "ADM" }, `${PATH}?id=${AUDIT_SECURITY_ID}`);
    const sheet = page.getByTestId("audit-detail");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("203.0.113.0/24")).toBeVisible();
    await expect(sheet.getByTestId("audit-details")).toContainText("admin.audit.detail");
    expect(await sheet.textContent()).not.toMatch(/203\.0\.113\.\d{1,3}(?!\/)(?!\d)/);
  });

  test("texto hostil vindo da API é inerte (sem HTML, sem execução)", async ({ page }) => {
    await open(page, { role: "ADM" }, `${PATH}?id=${AUDIT_XSS_ID}`);
    const sheet = page.getByTestId("audit-detail");
    await expect(sheet).toContainText(AUDIT_XSS);
    expect(await sheet.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("404 (inexistente ou alheio): mensagem única, sem nova tentativa, volta à lista", async ({ page }) => {
    await open(page, { role: "ADM" }, `${PATH}?id=b0000000-0000-4000-8000-000000000999`);
    await expect(page.getByText("Registro não encontrado, ou fora do seu escopo de unidades.")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Tentar novamente" })).toHaveCount(0);
    await page.getByRole("button", { name: "Voltar à lista" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).not.toHaveURL(/id=/);
  });

  test("id malformado na URL é descartado (nenhuma chamada de detalhe)", async ({ page }) => {
    const state = await open(page, { role: "ADM" }, `${PATH}?id=../../x`);
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(auditCalls(state).filter((c) => /audit-logs\/.+/.test(c))).toEqual([]);
  });
});

test.describe("acesso restrito (negar por padrão)", () => {
  for (const role of ["USER", "RH"] as const) {
    test(`${role}: painel de acesso restrito, sem chamar /admin/audit-logs`, async ({ page }) => {
      const state = await open(page, { role });
      await expect(page.getByTestId("access-restricted")).toBeVisible();
      await expect(page.getByRole("table", { name: TABLE })).toHaveCount(0);
      expect(auditCalls(state)).toEqual([]);
    });
  }

  test("/me com erro: nega por padrão", async ({ page }) => {
    const state = await open(page, { role: "ADM", meStatus: 500 });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
    expect(auditCalls(state)).toEqual([]);
  });

  test("ADM com AAL1: backend nega (AAL2_REQUIRED) e a tela vira acesso restrito", async ({ page }) => {
    await open(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
    await expect(page.getByRole("table", { name: TABLE })).toHaveCount(0);
  });

  test("403 do backend: acesso restrito sem vazar detalhe", async ({ page }) => {
    await open(page, { role: "ADM", auditStatus: 403 });
    await expect(page.getByTestId("access-restricted")).toBeVisible();
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
  });
});

test.describe("estados", () => {
  test("carregando: esqueleto anunciado até a resposta chegar", async ({ page }) => {
    await open(page, { role: "ADM", auditDelayMs: 1500 });
    await expect(page.getByRole("status").filter({ hasText: "Carregando registros de auditoria…" })).toBeVisible();
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible({ timeout: 10_000 });
  });

  test("erro 500: mensagem útil sem detalhe do backend e tentar de novo recupera", async ({ page }) => {
    const state = await open(page, { role: "ADM", auditStatus: 500 });
    await expect(page.getByText("Não foi possível carregar a trilha de auditoria. Tente novamente.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("detalhe interno sintético")).toHaveCount(0);
    state.auditStatus = null;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
  });

  test("lista vazia sem filtros", async ({ page }) => {
    await open(page, { role: "ADM", auditLogs: [] });
    await expect(page.getByText("Nenhum registro de auditoria no período.")).toBeVisible();
  });
});

test.describe("responsivo e acessibilidade", () => {
  for (const width of [320, 768, 1280, 1920]) {
    test(`${width}px: sem overflow horizontal e sem violações axe (lista e detalhe)`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await open(page);
      await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await waitForAnimations(page);
      expect(await axeViolations(page)).toEqual([]);

      await page.getByRole("button", { name: /^Ver detalhes do registro USER_ROLE_CHANGED/ }).first().click();
      await expect(page.getByTestId("audit-detail")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await waitForAnimations(page);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});
