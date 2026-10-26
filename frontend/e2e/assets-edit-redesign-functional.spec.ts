import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

import { ASSET_IDS, type AssetMock } from "./support/asset-mocks";
import { API_URL, installMocks, seedSession, waitForHydration, type MockOptions, type MockState } from "./support/mocks";

// =============================================================================
// Patrimônios — redesign do Detalhe (cabeçalho, cartões, barra de ações fixa) e
// da Edição (seções, "alterado", resumo, barra fixa, confirmação ao sair, 409
// sem perder o rascunho, salas/responsáveis com carregando/erro). Mocks
// sintéticos; autorização, escopo e version são do BACKEND (simulado no mock).
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const CONFLICT_TEXT = "Outra pessoa alterou este bem enquanto você editava.";

async function open(
  page: Page,
  opts: MockOptions = { role: "USER" },
  prepare?: (state: MockState) => void,
  /** Rotas extras: registradas DEPOIS dos mocks (têm prioridade no Playwright). */
  afterInstall?: () => Promise<void>,
) {
  const state = await installMocks(page, opts);
  prepare?.(state);
  await afterInstall?.();
  await seedSession(page, opts);
  await page.goto("/patrimonios");
  await waitForHydration(page);
  return state;
}

function waitPatch(page: Page, id: string): Promise<Request> {
  return page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().startsWith(API_URL) && new URL(r.url()).pathname.endsWith(id),
  );
}

async function openSheet(page: Page, number = "000123") {
  await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
  await page.getByRole("button", { name: `Ver detalhes do patrimônio ${number}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: new RegExp(`Patrimônio ${number}`) });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openEdit(page: Page, number = "000123") {
  const sheet = await openSheet(page, number);
  await sheet.getByRole("button", { name: "Editar" }).click();
  const dialog = page.getByRole("dialog", { name: "Editar bem" });
  await expect(dialog).toBeVisible();
  return { sheet, dialog };
}

const asset = (state: MockState, id: string): AssetMock => state.assets.find((a) => a.id === id)!;
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const discardDialog = (page: Page) => page.getByRole("dialog", { name: "Descartar alterações?" });

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

test.describe("detalhe — cabeçalho, cartões e ações", () => {
  test("cabeçalho: eyebrow, número como TEXTO em fonte mono e selos com texto", async ({ page }) => {
    await open(page, { role: "ADM" });
    const sheet = await openSheet(page);
    const title = sheet.getByRole("heading", { level: 2 });
    await expect(title).toContainText("Patrimônio");
    const number = title.locator("span[translate=no]");
    await expect(number).toHaveText("000123");
    expect(await number.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase())).toMatch(/mono|menlo|consolas/);
    expect(await number.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(28);
    // Selos: ícone + texto (nunca só cor).
    await expect(sheet.getByText("Localizado", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Vínculo: Servidor")).toBeVisible();
    await expect(sheet.locator("span.inline-flex svg[aria-hidden=true]").first()).toBeVisible();
  });

  test("seções em ordem, 'REVISÃO N' em mono e observações em largura total", async ({ page }) => {
    await open(page, { role: "ADM" });
    const sheet = await openSheet(page);
    const titles = await sheet.locator("section h3").allTextContents();
    expect(titles).toEqual(["Identificação", "Localização e responsável", "Classificação técnica", "Vínculo", "Registro"]);
    const revision = sheet.locator("section span.font-mono", { hasText: /Revisão/ });
    await expect(revision).toHaveText("Revisão 3");
    const notes = sheet.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^Observações$/ }) });
    await expect(notes).toHaveClass(/col-span-2/);
    // Aba Histórico intacta.
    await sheet.getByRole("tab", { name: "Histórico" }).click();
    await expect(sheet.getByRole("list", { name: "Histórico do bem" })).toBeVisible();
  });

  test("ações: Editar é primário (Chalk, nunca laranja); Excluir é outline separado; alvos >= 44px", async ({ page }) => {
    await open(page, { role: "ADM" });
    const sheet = await openSheet(page);
    const group = sheet.getByRole("group", { name: "Ações do bem" });
    const edit = group.getByRole("button", { name: "Editar" });
    const remove = group.getByRole("button", { name: "Excluir", exact: true });
    expect(await edit.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(250, 250, 250)");
    expect(await remove.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(await remove.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
    for (const button of [edit, remove]) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Separados: Excluir fica à direita de Editar.
    expect((await remove.boundingBox())!.x).toBeGreaterThan((await edit.boundingBox())!.x + (await edit.boundingBox())!.width);
  });

  test("320x568: barra de ações fica visível ao rolar, empilha e não há rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page, { role: "ADM" });
    const sheet = await openSheet(page);
    const group = sheet.getByRole("group", { name: "Ações do bem" });
    const inView = async () => {
      const box = (await group.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(568 + 1);
    };
    await inView();
    await page.locator("[data-sheet]").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await inView();
    await page.locator("[data-sheet]").evaluate((el) => el.scrollTo(0, 0));
    await inView();
    const edit = (await group.getByRole("button", { name: "Editar" }).boundingBox())!;
    const remove = (await group.getByRole("button", { name: "Excluir", exact: true }).boundingBox())!;
    expect(remove.y).toBeGreaterThan(edit.y); // empilhados
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
  });

  test("RH: sem barra de ações nem controles de escrita", async ({ page }) => {
    await open(page, { role: "RH" });
    const sheet = await openSheet(page);
    await expect(sheet.getByRole("group", { name: "Ações do bem" })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: /Editar|Excluir|Restaurar/ })).toHaveCount(0);
    await expect(sheet.locator("section h3")).toHaveCount(5);
  });
});

// ---------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------

test.describe("edição — seções, alterações e barra fixa", () => {
  test("seções agrupadas; 'Somente administrador' só para ADM; USER vê o número com cadeado e ajuda", async ({ page }) => {
    await open(page, { role: "ADM" });
    const { dialog } = await openEdit(page);
    const titles = await dialog.locator("h3").allTextContents();
    expect(titles).toEqual(["Identificação", "Localização e responsável", "Classificação técnica", "Somente administrador"]);
    await expect(dialog.getByLabel("Unidade proprietária")).toBeVisible();
    await expect(dialog.getByLabel("Localizado")).toBeVisible();
  });

  test("USER: número só leitura com cadeado e texto de ajuda; sem campos de administrador", async ({ page }) => {
    await open(page, { role: "USER" });
    const { dialog } = await openEdit(page);
    expect(await dialog.locator("h3").allTextContents()).toEqual([
      "Identificação",
      "Localização e responsável",
      "Classificação técnica",
    ]);
    await expect(dialog.getByText("Somente um administrador altera o número patrimonial.")).toBeVisible();
    await expect(dialog.getByText("000123", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Número patrimonial")).toHaveCount(0);
    await expect(dialog.getByLabel("Unidade proprietária")).toHaveCount(0);
    await expect(dialog.getByLabel("Localizado")).toHaveCount(0);
    // O cadeado é decorativo (o texto de ajuda explica).
    await expect(dialog.locator("svg[aria-hidden=true].lucide-lock").first()).toBeVisible();
  });

  test("foco inicial no primeiro campo editável e retorno ao botão Editar ao fechar", async ({ page }) => {
    await open(page, { role: "USER" });
    const { sheet, dialog } = await openEdit(page);
    await expect(dialog.getByLabel("Descrição")).toBeFocused();
    await dialog.getByRole("button", { name: "Cancelar" }).click(); // sem alterações: fecha direto
    await expect(dialog).toBeHidden();
    await expect(sheet.getByRole("button", { name: "Editar" })).toBeFocused();
  });

  test("ADM: foco inicial no número patrimonial", async ({ page }) => {
    await open(page, { role: "ADM" });
    const { dialog } = await openEdit(page);
    await expect(dialog.getByLabel("Número patrimonial")).toBeFocused();
  });

  test("controles com contraste correto sobre a superfície clara do diálogo", async ({ page }) => {
    await open(page, { role: "ADM" });
    const { dialog } = await openEdit(page);
    for (const label of ["Descrição", "Sala", "Data de registro", "Número patrimonial"]) {
      const control = dialog.getByLabel(label);
      expect(await control.evaluate((el) => getComputedStyle(el).backgroundColor), label).toBe("rgb(250, 250, 250)");
      expect(await control.evaluate((el) => getComputedStyle(el).color), label).toBe("rgb(16, 16, 16)");
    }
  });

  test("marca 'alterado' por campo, contador, resumo e PATCH com exatamente os campos alterados + version", async ({ page }) => {
    await open(page, { role: "USER" });
    const { sheet, dialog } = await openEdit(page);
    const save = dialog.getByRole("button", { name: "Salvar bem" });
    const status = dialog.getByRole("status").filter({ hasText: /alteraç|Sem alterações|Salvando/ });

    // Sem alterações: estado anunciado, explicação associada e Salvar indisponível.
    await expect(status).toHaveText("Sem alterações");
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute("aria-disabled", "true");
    const describedBy = await save.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText("Salvar fica disponível depois que você alterar algum campo.");
    await expect(dialog.locator("summary")).toHaveCount(0);
    await expect(dialog.locator("label .sr-only", { hasText: "alterado" })).toHaveCount(0);

    await dialog.getByLabel("Descrição").fill("Descrição nova do bem");
    await dialog.getByLabel("Data de registro").fill("2026-02-03");
    await dialog.getByLabel("Observações").fill("Observação nova");
    await expect(status).toHaveText("3 alterações");
    await expect(save).toBeEnabled();
    await expect(save).not.toHaveAttribute("aria-disabled", "true");

    // Marca por campo (ponto + texto para leitor de tela); campos intactos não têm marca.
    for (const id of ["bem-descricao", "bem-data", "bem-observacoes"]) {
      await expect(dialog.locator(`label[for=${id}] .sr-only`)).toHaveText("alterado");
      await expect(dialog.locator(`label[for=${id}] span.rounded-full`)).toHaveCount(1);
    }
    await expect(dialog.locator("label[for=bem-sala] .sr-only")).toHaveCount(0);

    // Contador + resumo "Campo: antigo → novo" só dos campos alterados.
    await expect(dialog.locator("summary")).toContainText("3 campos alterados");
    await dialog.locator("summary").click();
    const items = dialog.getByRole("list", { name: "Resumo das alterações" }).locator("li");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Descrição:");
    await expect(items.nth(0)).toContainText("→ Descrição nova do bem");
    await expect(items.nth(1)).toContainText("Observações: Observação sintética do bem. → Observação nova");
    await expect(items.nth(2)).toContainText("Data de registro: 29/02/2024 → 03/02/2026");

    // Desfazer uma alteração a retira do resumo e do contador.
    await dialog.getByLabel("Observações").fill("Observação sintética do bem.");
    await expect(dialog.locator("summary")).toContainText("2 campos alterados");
    await expect(items).toHaveCount(2);

    const request = waitPatch(page, ASSET_IDS.long);
    await save.click();
    expect((await request).postDataJSON()).toEqual({
      version: 3,
      description: "Descrição nova do bem",
      registration_date: "2026-02-03",
    });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText("Descrição nova do bem").first()).toBeVisible();
  });

  test("trocar a categoria que limpa o Tipo de TI avisa o usuário", async ({ page }) => {
    await open(page, { role: "USER" }, (s) => {
      Object.assign(asset(s, ASSET_IDS.long), { asset_category: "TECNOLOGIA", tech_type: "MONITOR" });
    });
    const { dialog } = await openEdit(page);
    await dialog.getByLabel("Categoria").selectOption("MOBILIARIO");
    await expect(dialog.getByText("Tipo de TI “Monitor” foi limpo")).toBeVisible();
    await expect(dialog.getByLabel("Tipo de TI")).toHaveValue("");
    await expect(dialog.getByRole("status").filter({ hasText: "2 alterações" })).toBeVisible();
  });

  test("sair com alterações pede confirmação (Cancelar, Esc, X e overlay); sem alterações fecha direto", async ({ page }) => {
    await open(page, { role: "USER" });
    const { sheet, dialog } = await openEdit(page);

    // Sem alterações: Esc fecha direto.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(discardDialog(page)).toHaveCount(0);

    await sheet.getByRole("button", { name: "Editar" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Descrição").fill("Rascunho a proteger");

    for (const how of ["cancelar", "esc", "x", "overlay"] as const) {
      if (how === "cancelar") await dialog.getByRole("button", { name: "Cancelar" }).click();
      else if (how === "esc") await page.keyboard.press("Escape");
      else if (how === "x") await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
      else await page.mouse.click(5, 5);
      const confirm = discardDialog(page);
      await expect(confirm, how).toBeVisible();
      await expect(confirm).toContainText("Você alterou 1 campo alterado");
      // Um único nível: continuar editando mantém o rascunho.
      await confirm.getByRole("button", { name: "Continuar editando" }).click();
      await expect(confirm).toBeHidden();
      await expect(dialog.getByLabel("Descrição")).toHaveValue("Rascunho a proteger");
    }

    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await discardDialog(page).getByRole("button", { name: "Descartar alterações" }).click();
    await expect(dialog).toBeHidden();
    await expect(sheet.getByRole("button", { name: "Editar" })).toBeFocused();
    await expect(sheet.getByText("Rascunho a proteger")).toHaveCount(0);
  });

  test("erro de servidor fica visível na barra fixa, com foco e role=alert, texto da tabela fixa", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page, { role: "USER" }, (s) => {
      s.forceWriteError = { status: 403, code: "FORBIDDEN" };
    });
    const { dialog } = await openEdit(page);
    await dialog.getByLabel("Descrição").fill("Qualquer");
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    const alert = dialog.getByRole("alert").filter({ hasText: "Você não tem permissão para esta ação." });
    await expect(alert).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    const box = (await alert.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(568);
    expect(box.y).toBeGreaterThanOrEqual(0);
    // Foco no contêiner do erro.
    const focusInsideAlert = await page.evaluate(() => {
      const active = document.activeElement;
      return !!active && !!active.querySelector("[role=alert]");
    });
    expect(focusInsideAlert).toBe(true);
  });

  test("320x568: barra de ações permanece visível ao rolar o formulário e não há rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page, { role: "ADM" });
    const { dialog } = await openEdit(page);
    const save = dialog.getByRole("button", { name: "Salvar bem" });
    const inView = async () => {
      const box = (await save.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(568);
      expect(box.height).toBeGreaterThanOrEqual(43.5); // 44px (h-11), com tolerância da animação de entrada
    };
    await inView();
    await dialog.locator("form > div").first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await inView();
    await expect(dialog.getByLabel("Localizado")).toBeVisible();
    const dialogBox = (await dialog.boundingBox())!;
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(568);
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Salas e responsáveis (campos dependentes)
// ---------------------------------------------------------------------------

test.describe("edição — salas e responsáveis", () => {
  test("mostra 'Carregando salas…' enquanto a lista não chega", async ({ page }) => {
    await open(page, { role: "USER" }, undefined, async () => {
      await page.route(/\/v1\/rooms(\?|$)/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fallback();
      });
    });
    const { dialog } = await openEdit(page);
    await expect(dialog.getByText("Carregando salas…")).toBeVisible();
    await expect(dialog.getByLabel("Sala")).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByText("Carregando salas…")).toHaveCount(0, { timeout: 10_000 });
  });

  test("falha nas salas: aviso fixo e 'Recarregar salas' refaz a consulta", async ({ page }) => {
    const state = await open(page, { role: "USER" });
    state.lookupListStatus = 500;
    const { dialog } = await openEdit(page);
    await expect(dialog.getByText("Não foi possível carregar as salas.")).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
    state.lookupListStatus = null;
    await dialog.getByRole("button", { name: "Recarregar salas" }).click();
    await expect(dialog.getByText("Não foi possível carregar as salas.")).toHaveCount(0);
    await expect(dialog.getByLabel("Sala").locator("option")).not.toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// Conflito de versão (409): rascunho preservado
// ---------------------------------------------------------------------------

test.describe("edição — conflito 409 sem perder o rascunho", () => {
  async function conflictFlow(page: Page) {
    const state = await open(page, { role: "USER" });
    const { sheet, dialog } = await openEdit(page);
    await dialog.getByLabel("Descrição").fill("Minha edição");
    await dialog.getByLabel("Observações").fill("Minha observação");
    const other = asset(state, ASSET_IDS.long);
    other.description = "Edição concorrente";
    other.version = 9;
    await dialog.getByRole("button", { name: "Salvar bem" }).click();
    await expect(dialog.getByText(CONFLICT_TEXT)).toBeVisible();
    return { state, sheet, dialog };
  }

  test("preserva o rascunho, lista 'no servidor' só dos campos divergentes e foca o aviso", async ({ page }) => {
    const { dialog } = await conflictFlow(page);
    await expect(dialog.getByText("Este bem foi alterado por outra pessoa")).toBeVisible();
    await expect(dialog.getByLabel("Descrição")).toHaveValue("Minha edição");
    await expect(dialog.getByLabel("Observações")).toHaveValue("Minha observação");
    const differences = dialog.getByRole("list", { name: "Campos que diferem do servidor" }).locator("li");
    await expect(differences).toHaveCount(1); // observações não mudaram no servidor
    await expect(differences.first()).toContainText("Descrição");
    await expect(differences.first()).toContainText("sua alteração: Minha edição");
    await expect(differences.first()).toContainText("no servidor: Edição concorrente");
    // Aviso único (o painel por trás não o repete) e foco nele.
    await expect(page.locator("[data-sheet]").getByText(CONFLICT_TEXT)).toHaveCount(0);
    await expect(dialog.getByRole("alert").filter({ hasText: "Este bem foi alterado por outra pessoa" })).toBeFocused();
  });

  test("'Manter minhas alterações e salvar de novo' reenvia SÓ os campos alterados com a nova version", async ({ page }) => {
    const { state, sheet, dialog } = await conflictFlow(page);
    const request = waitPatch(page, ASSET_IDS.long);
    await dialog.getByRole("button", { name: "Manter minhas alterações e salvar de novo" }).click();
    expect((await request).postDataJSON()).toEqual({
      version: 9,
      description: "Minha edição",
      notes: "Minha observação",
    });
    await expect(dialog).toBeHidden();
    expect(asset(state, ASSET_IDS.long).description).toBe("Minha edição");
    await expect(sheet.getByText(CONFLICT_TEXT)).toHaveCount(0);
  });

  test("'Descartar e usar dados do servidor' troca o rascunho e limpa o aviso", async ({ page }) => {
    const { sheet, dialog } = await conflictFlow(page);
    await dialog.getByRole("button", { name: "Descartar e usar dados do servidor" }).click();
    await expect(dialog.getByText("Este bem foi alterado por outra pessoa")).toHaveCount(0);
    await expect(dialog.getByLabel("Descrição")).toHaveValue("Edição concorrente");
    await expect(dialog.getByLabel("Observações")).toHaveValue("Observação sintética do bem.");
    await expect(dialog.getByRole("button", { name: "Salvar bem" })).toBeDisabled();
    // Fecha sem pedir confirmação (nada alterado) e o painel não mostra aviso velho.
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    await expect(sheet.getByText(CONFLICT_TEXT)).toHaveCount(0);
  });

  test("axe WCAG 2.2 AA e sem rolagem horizontal a 320px com o aviso de conflito", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await conflictFlow(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Acessibilidade
// ---------------------------------------------------------------------------

test("axe WCAG 2.2 AA: detalhe e edição (com alterações e resumo aberto), ADM e 320px", async ({ page }) => {
  for (const width of [1366, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 768 });
    await open(page, { role: "ADM" });
    const sheet = await openSheet(page);
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
    expect(results.violations.map((v) => v.id), `detalhe ${width}`).toEqual([]);
    await sheet.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar bem" });
    await dialog.getByLabel("Descrição").fill("Alterada");
    await dialog.locator("summary").click();
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
    expect(results.violations.map((v) => v.id), `edição ${width}`).toEqual([]);
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
  }
});
