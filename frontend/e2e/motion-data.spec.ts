import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { API_URL, installMocks, PREVIEW_ITEMS, seedSession, waitForHydration } from "./support/mocks";
import { VIEWPORTS, waitForAnimations } from "./support/screens";

// =============================================================================
// Telas de dados (importação Google Sheets, usuários, formulário de convite):
// estados reais de requisição, contadores com valores EXATOS do mock,
// transição de filtro sem perder resultados, seleção, modal (Esc/foco),
// sucesso só após a resposta do backend, erro de API, formulário com erros
// animados e loading, reduced motion, overflow em 9 resoluções, console limpo.
// Ver docs/ux/evidence/telas-dados.md.
// =============================================================================

const IMPORT_PATH = "/administracao/importacao/google-sheets";
const USERS_PATH = "/administracao/usuarios";

const count = (c: string) => PREVIEW_ITEMS.filter((i) => i.classification === c).length;
const EXPECTED_SUMMARY: Record<string, number> = {
  total: PREVIEW_ITEMS.length,
  novo: count("NOVO"),
  existente: count("EXISTENTE"),
  duplicado: count("DUPLICADO"),
  invalido: count("INVALIDO"),
  conflitante: count("CONFLITANTE"),
};
const ELIGIBLE = count("NOVO") + count("EXISTENTE");

/**
 * Segura uma requisição da API mockada até `release()`; então devolve ao mock
 * padrão (`fallback`) ou responde com `fulfill` customizado. Preflight OPTIONS
 * passa direto.
 */
async function holdRequest(
  page: Page,
  pathRegex: RegExp,
  method: string,
  respond?: (route: Route) => Promise<void>,
): Promise<{ release: () => void; hit: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let markHit!: () => void;
  const hit = new Promise<void>((resolve) => (markHit = resolve));
  await page.route(
    (url) => url.href.startsWith(API_URL) && pathRegex.test(url.pathname),
    async (route) => {
      if (route.request().method() !== method) return route.fallback();
      markHit();
      await gate;
      if (respond) return respond(route);
      return route.fallback();
    },
  );
  return { release, hit };
}

function jsonError(route: Route, status: number): Promise<void> {
  const origin = route.request().headers()["origin"] ?? "*";
  return route.fulfill({
    status,
    headers: { "access-control-allow-origin": origin, "content-type": "application/json" },
    body: JSON.stringify({ error: { code: "INTERNAL", message: "detalhe interno que não deve aparecer" } }),
  });
}

async function openAs(page: Page, path: string): Promise<void> {
  await installMocks(page, { role: "ADM" });
  await seedSession(page, { role: "ADM" });
  await page.goto(path);
  await waitForHydration(page);
}

const status = (page: Page) => page.getByTestId("import-request-status");
const counterText = (page: Page, metric: string) =>
  page.locator(`[data-metric="${metric}"] .tabular-nums > span[aria-hidden="true"]`);

async function generatePreview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
  await expect(page.getByText(`Exibindo 1–${PREVIEW_ITEMS.length} de ${PREVIEW_ITEMS.length} item(ns)`)).toBeVisible();
}

test.use({ viewport: { width: 1366, height: 768 } });

test.describe("importação — estados e contadores", () => {
  test("idle → lendo (skeleton) → prévia pronta com contadores exatos e tabela", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await expect(status(page)).toContainText("Aguardando pré-visualização");
    await expect(page.getByText("Nenhuma prévia gerada nesta sessão.")).toBeVisible();

    const preview = await holdRequest(page, /\/imports\/google-sheets\/preview$/, "POST");
    await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
    await preview.hit;
    await expect(status(page)).toContainText("Lendo planilha…");
    await expect(page.getByRole("status").filter({ hasText: "Lendo a planilha do Google Sheets…" })).toBeVisible();
    // Sem barra de progresso simulada.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    // Botão em loading (aria-busy), rótulo de estado real.
    await expect(page.getByRole("button", { name: "Gerando pré-visualização…" })).toHaveAttribute("aria-busy", "true");
    // Nada de prévia antes da resposta.
    await expect(page.getByRole("group", { name: "Resumo quantitativo da pré-visualização" })).toHaveCount(0);

    preview.release();
    await expect(status(page)).toContainText("Prévia pronta");
    for (const [metric, value] of Object.entries(EXPECTED_SUMMARY)) {
      await expect(counterText(page, metric)).toHaveText(String(value));
    }
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(PREVIEW_ITEMS.length);
    // Alerta de revisão discreto (status, não alert) com ícone + texto.
    const review = page.getByRole("status").filter({ hasText: "exigem revisão" });
    await expect(review).toContainText(
      `${count("DUPLICADO") + count("INVALIDO") + count("CONFLITANTE")} registro(s)`,
    );
    // Badges com ícone + texto.
    const firstBadge = page.getByRole("table").locator("tbody tr").first().locator("td").last();
    await expect(firstBadge.locator("svg")).toHaveCount(1);
    await expect(firstBadge).toContainText("Novo");

    await waitForAnimations(page);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
  });

  test("filtro: resultados anteriores mantidos (aria-busy) até a resposta; depois só os filtrados", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await generatePreview(page);
    const table = page.getByRole("table");
    const rows = table.locator("tbody tr");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.href.startsWith(API_URL) && url.pathname.endsWith("/items") && url.search.includes("status=INVALIDO"),
      async (route) => {
        if (route.request().method() === "GET") await gate;
        await route.fallback();
      },
    );
    await page.getByRole("button", { name: "Inválido" }).click();
    await expect(table).toHaveAttribute("aria-busy", "true");
    await expect(rows).toHaveCount(PREVIEW_ITEMS.length);
    // O texto "Atualizando…" saiu com a PaginationBar; o estado ocupado segue em aria-busy (acima).

    release();
    await expect(rows).toHaveCount(1);
    await expect(table).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("Exibindo 1–1 de 1 item(ns)")).toBeVisible();
    await waitForAnimations(page);
    // Termina estável: opacidade 1 nas linhas.
    expect(await rows.first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  });

  test("busca sem resultados mostra estado vazio animado", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await generatePreview(page);
    await page.getByLabel("Buscar itens da prévia").fill("inexistente-xyz");
    await expect(page.getByText("Nenhum item encontrado para os filtros atuais.")).toBeVisible();
    await expect(page.getByText("Ajuste a busca ou escolha outra classificação.")).toBeVisible();
  });

  test("seleção: checkbox + linha selecionada; modal com Esc e retorno de foco", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await generatePreview(page);
    const checkbox = page.getByRole("checkbox", { name: "Selecionar item 000123" });
    const row = page.getByRole("row").filter({ has: checkbox });
    await expect(row).toHaveAttribute("data-state", "selected");
    await checkbox.uncheck();
    await expect(row).not.toHaveAttribute("data-state", "selected");
    await checkbox.check();
    await expect(row).toHaveAttribute("data-state", "selected");

    const trigger = page.getByRole("button", { name: "Confirmar Importação" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("confirmação: sucesso só após a resposta (atrasada) do backend", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await generatePreview(page);
    const confirm = await holdRequest(page, /\/imports\/google-sheets\/confirm$/, "POST");

    await page.getByRole("button", { name: "Confirmar Importação" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
    await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
    await confirm.hit;

    await expect(status(page)).toContainText("Confirmando importação…");
    await expect(dialog.getByRole("button", { name: "Confirmando…" })).toHaveAttribute("aria-busy", "true");
    await expect(dialog).toBeVisible();
    // Esc não fecha durante o envio.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    // Nenhum sinal de sucesso antes da resposta.
    await page.waitForTimeout(400);
    await expect(page.getByTestId("catalog-import-result")).toHaveCount(0);
    await expect(page.getByText(/Importação concluída:/)).toHaveCount(0);

    confirm.release();
    const result = page.getByTestId("catalog-import-result");
    await expect(result).toHaveAttribute("data-outcome", "success");
    await expect(page.getByText(/Importação concluída: \d+ criado/)).toBeVisible();
    await expect(status(page)).toContainText("Importação concluída");
    // Números = os do backend (criados + atualizados), sem animação.
    await expect(result.locator("[data-stat=Salvos]")).toHaveText(String(ELIGIBLE));
  });

  const PREVIEW_ERRORS: Array<[number, RegExp]> = [
    [500, /O servidor não conseguiu concluir a leitura da planilha/],
    [503, /A leitura demorou mais que o esperado/],
    [504, /A leitura demorou mais que o esperado/],
  ];
  for (const [code, message] of PREVIEW_ERRORS) {
    test(`erro ${code} na prévia: mensagem acionável, sem detalhes internos`, async ({ page }) => {
      await openAs(page, IMPORT_PATH);
      await holdRequest(page, /\/imports\/google-sheets\/preview$/, "POST", (route) => jsonError(route, code)).then(
        (h) => h.release(),
      );
      await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
      await expect(page.locator("main").getByRole("alert")).toHaveText(message);
      await expect(status(page)).toContainText("Falha na leitura");
      await expect(page.getByText("detalhe interno")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
    });
  }

  test("erro de rede na prévia: mensagem própria", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await page.route(
      (url) => url.href.startsWith(API_URL) && /\/imports\/google-sheets\/preview$/.test(url.pathname),
      (route) => (route.request().method() === "POST" ? route.abort("failed") : route.fallback()),
    );
    await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("Sem resposta do servidor");
  });

  test("duplo clique na prévia dispara uma única requisição", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/imports\/google-sheets\/preview$/.test(new URL(r.url()).pathname)) posts++;
    });
    const hold = await holdRequest(page, /\/imports\/google-sheets\/preview$/, "POST");
    const button = page.getByRole("button", { name: "Pré-visualizar Importação" });
    await button.dblclick();
    await hold.hit;
    const busy = page.getByRole("button", { name: "Gerando pré-visualização…" });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute("aria-busy", "true");
    await expect(status(page)).toContainText("Lendo planilha…");
    hold.release();
    await expect(page.getByRole("group", { name: "Resumo quantitativo da pré-visualização" })).toBeVisible();
    expect(posts).toBe(1);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("contadores mostram o valor final imediatamente", async ({ page }) => {
    await openAs(page, IMPORT_PATH);
    await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
    const group = page.getByRole("group", { name: "Resumo quantitativo da pré-visualização" });
    await group.waitFor();
    // Leitura única, sem retry: já deve estar no valor final.
    const snapshot = await page.evaluate(() =>
      Object.fromEntries(
        Array.from(document.querySelectorAll("[data-metric]")).map((el) => [
          el.getAttribute("data-metric"),
          el.querySelector('.tabular-nums > span[aria-hidden="true"]')?.textContent,
        ]),
      ),
    );
    expect(snapshot).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_SUMMARY).map(([k, v]) => [k, String(v)])),
    );
    // Linhas sem deslocamento residual.
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(PREVIEW_ITEMS.length);
    const transform = await page.getByRole("table").locator("tbody tr").first().evaluate((el) => getComputedStyle(el).transform);
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(transform);
  });
});

test.describe("usuários — tabela e convite", () => {
  test("tabela: linhas, hover/foco com transição, estado ativo com ícone + texto", async ({ page }) => {
    await openAs(page, USERS_PATH);
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows).toHaveCount(4);
    const transition = await rows.first().evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(transition).toContain("background-color");
    // Colunas: Nome, E-mail, Perfil, Unidades, Status, Último acesso, Ações.
    const ativo = rows.first().locator("td").nth(4);
    await expect(ativo).toContainText("Ativo");
    await expect(ativo.locator("svg")).toHaveCount(1);
  });

  test("convite: obrigatórios (* + aria-required), erros animados, foco e loading até a resposta", async ({ page }) => {
    await openAs(page, USERS_PATH);
    await page.getByRole("button", { name: "Convidar Usuário" }).click();
    const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
    const nome = dialog.getByLabel("Nome");
    await expect(nome).toHaveAttribute("aria-required", "true");
    await expect(dialog.getByText("Campos marcados com * são obrigatórios.")).toBeVisible();

    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    await expect(dialog.getByRole("alert")).toHaveCount(3);
    await expect(nome).toBeFocused();
    await expect(nome).toHaveAttribute("aria-invalid", "true");
    await expect(nome).toHaveAccessibleDescription("Informe o nome.");
    await nome.fill("Pessoa Sintética");
    await expect(nome).not.toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("alert")).toHaveCount(2);

    // Seção expansível com aria-expanded.
    const toggle = dialog.getByRole("button", { name: "Justificativa (opcional)" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByLabel("Justificativa", { exact: true })).toBeVisible();

    await dialog.getByLabel("E-mail institucional").fill("atrasado@exemplo.invalid");
    await dialog.getByRole("checkbox", { name: /PSU-TO/ }).check();
    const invite = await holdRequest(page, /\/users\/invite$/, "POST");
    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    await invite.hit;
    await expect(dialog.getByRole("button", { name: "Enviar convite" })).toHaveAttribute("aria-busy", "true");
    await page.waitForTimeout(300);
    await expect(page.getByText("Convite enviado para atrasado@exemplo.invalid.")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    invite.release();
    await expect(page.getByText("Convite enviado para atrasado@exemplo.invalid.")).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test("lista com erro de API: mensagem genérica e Tentar novamente", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.route(
      (url) => url.href.startsWith(API_URL) && url.pathname.endsWith("/v1/users"),
      (route) => (route.request().method() === "GET" ? jsonError(route, 500) : route.fallback()),
    );
    await page.goto(USERS_PATH);
    await waitForHydration(page);
    await expect(page.locator("main").getByRole("alert")).toHaveText("Não foi possível carregar a lista de usuários. Tente novamente.", {
      timeout: 20_000,
    });
  });
});

test.describe("sem overflow horizontal nas 9 resoluções", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openAs(page, IMPORT_PATH);
      await generatePreview(page);
      await waitForAnimations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

      await page.goto(USERS_PATH);
      await waitForHydration(page);
      await expect(page.getByRole("table")).toBeVisible();
      await page.getByRole("button", { name: "Convidar Usuário" }).click();
      await page.getByRole("dialog", { name: "Convidar Usuário" }).getByRole("button", { name: "Enviar convite" }).click();
      await waitForAnimations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
  }
});

test("sem erros de console/hidratação no fluxo de importação e usuários", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR_FAILED/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await openAs(page, IMPORT_PATH);
  await generatePreview(page);
  await page.getByRole("button", { name: "Inválido" }).click();
  await expect(page.getByText("Exibindo 1–1 de 1 item(ns)")).toBeVisible();
  await page.goto(USERS_PATH);
  await waitForHydration(page);
  await expect(page.getByRole("table")).toBeVisible();
  await waitForAnimations(page);
  expect(errors).toEqual([]);
});
