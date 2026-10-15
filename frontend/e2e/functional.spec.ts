import { expect, test, type Page } from "@playwright/test";

import {
  ENROLL_SECRET,
  expectNoXss,
  installMocks,
  type MockOptions,
  type MockState,
  LEGACY_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  seedSession,
  waitForHydration,
} from "./support/mocks";

// =============================================================================
// Fluxos funcionais com mocks sintéticos (Supabase Auth + API Flask).
// O AuthGuard do cliente é só UX — a autorização real é do backend; aqui
// validamos o comportamento visível da interface.
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const PROTECTED = [
  "/",
  "/configuracoes",
  "/configuracoes/seguranca",
  "/configuracoes/inteligencia-artificial",
  "/administracao/usuarios",
  "/administracao/importacao/google-sheets",
];

test.describe("proteção de rotas sem sessão", () => {
  for (const path of PROTECTED) {
    test(`${path} → /login, sem renderizar conteúdo protegido`, async ({ page }) => {
      const state = await installMocks(page);
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
      // Nenhuma chamada à API patrimonial/administrativa sem sessão.
      expect(state.calls.filter((c) => c.url.startsWith("/api/v1/") && c.method !== "OPTIONS")).toEqual([]);
    });
  }

  test("rotas públicas não redirecionam", async ({ page }) => {
    await installMocks(page);
    await page.goto("/ativar-conta");
    await waitForHydration(page);
    await expect(page).toHaveURL(/\/ativar-conta$/);
    await expect(page.getByText("Este link de convite é inválido")).toBeVisible();
  });
});

test.describe("login / logout", () => {
  test("USER sem MFA: login → / e logout → /login com sessão limpa", async ({ page }) => {
    await installMocks(page, { role: "USER", hasVerifiedFactor: false });
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("usuario.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();

    const sair = page.getByRole("button", { name: "Sair do sistema" });
    await expect(sair).toBeVisible();
    await sair.click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Sair do sistema" })).toBeHidden();
    const stored = await page.evaluate(
      ([s, l]) => ({ session: sessionStorage.getItem(s), legacy: localStorage.getItem(l) }),
      [SESSION_STORAGE_KEY, LEGACY_STORAGE_KEY] as const,
    );
    expect(stored).toEqual({ session: null, legacy: null });
    // Após logout, rota protegida volta a exigir login.
    await page.goto("/administracao/usuarios");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("F-5: /me falha após o login → sessão Supabase local encerrada, permanece no /login", async ({ page }) => {
    await installMocks(page, { role: "USER", hasVerifiedFactor: false, meStatus: 401 });
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("inativo.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.locator("#login-error")).toHaveText(
      "Não foi possível confirmar sua sessão agora. Tente novamente.",
    );
    await expect(page).toHaveURL(/\/login$/);
    await expect
      .poll(() => page.evaluate((k) => sessionStorage.getItem(k), SESSION_STORAGE_KEY))
      .toBeNull();
  });

  test("credenciais inválidas: mensagem genérica", async ({ page }) => {
    await installMocks(page);
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("invalido@exemplo.invalid");
    await page.getByLabel("Senha").fill("x");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.locator("#login-error")).toHaveText("E-mail ou senha incorretos.");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("ADM com MFA: desafio TOTP, código errado e depois correto", async ({ page }) => {
    await installMocks(page, { role: "ADM", aal: "aal1" });
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    const codigo = page.getByLabel("Código de verificação");
    await expect(codigo).toBeFocused();
    await codigo.fill("000000");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(page.locator("#login-error")).toHaveText("Código inválido ou expirado. Tente novamente.");
    await codigo.fill("123456");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("ADM sem fator TOTP: cadastro do primeiro fator no login (bootstrap)", () => {
  async function loginAsAdmWithoutFactor(page: Page, opts: MockOptions = {}) {
    const state = await installMocks(page, { role: "ADM", aal: "aal1", hasVerifiedFactor: false, ...opts });
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    return state;
  }
  const enrollHeading = (page: Page) =>
    page.getByRole("heading", { level: 1, name: "Ativar verificação em duas etapas" });

  test("mostra QR + chave (sem 'Contate um administrador'), foco no código; código certo → aal2 → /", async ({
    page,
  }) => {
    await loginAsAdmWithoutFactor(page);
    await expect(enrollHeading(page)).toBeVisible();
    await expect(page.getByText("Contate um administrador")).toHaveCount(0);
    await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
    await expect(page.getByText(ENROLL_SECRET.slice(0, 4))).toBeVisible();
    const codigo = page.getByLabel("Código de 6 dígitos");
    await expect(codigo).toBeFocused();

    // Segredo nunca em storage nem na URL.
    const leak = await page.evaluate((secret) => {
      const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href;
      return dump.includes(secret) || dump.includes(secret.slice(0, 12));
    }, ENROLL_SECRET);
    expect(leak).toBe(false);

    await codigo.fill("123456");
    await page.getByRole("button", { name: "Verificar e ativar" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 45_000 });
  });

  test("enroll concluído avisa o backend (POST sem corpo, só uma vez)", async ({ page }) => {
    const state = await loginAsAdmWithoutFactor(page);
    await page.getByLabel("Código de 6 dígitos").fill("123456");
    await page.getByRole("button", { name: "Verificar e ativar" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 45_000 });
    const notices = state.calls.filter((c) => c.url.endsWith("/v1/security/mfa/factor-added-notice"));
    expect(notices.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(notices[0]?.body).toBeUndefined();
  });

  test("aviso de fator falha (500): login segue normalmente (best-effort)", async ({ page }) => {
    await loginAsAdmWithoutFactor(page, { factorNoticeStatus: 500 });
    await page.getByLabel("Código de 6 dígitos").fill("123456");
    await page.getByRole("button", { name: "Verificar e ativar" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 45_000 });
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });

  test("código errado no enroll NÃO dispara o aviso", async ({ page }) => {
    const state = await loginAsAdmWithoutFactor(page);
    await page.getByLabel("Código de 6 dígitos").fill("000000");
    await page.getByRole("button", { name: "Verificar e ativar" }).click();
    await expect(page.locator("#login-error")).toBeVisible();
    expect(state.calls.some((c) => c.url.endsWith("/factor-added-notice"))).toBe(false);
  });

  test("código errado → erro genérico; continua na etapa", async ({ page }) => {
    await loginAsAdmWithoutFactor(page);
    const codigo = page.getByLabel("Código de 6 dígitos");
    await codigo.fill("000000");
    await page.getByRole("button", { name: "Verificar e ativar" }).click();
    await expect(page.locator("#login-error")).toHaveText("Código inválido ou expirado. Tente novamente.");
    await expect(enrollHeading(page)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("Voltar remove o fator pendente (unenroll), encerra a sessão e volta ao e-mail", async ({ page }) => {
    const state = await loginAsAdmWithoutFactor(page);
    await expect(enrollHeading(page)).toBeVisible();
    await page.getByRole("button", { name: "Voltar" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
    await expect(page.getByLabel("E-mail")).toBeFocused();
    await expect
      .poll(() => state.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/factors/factor-novo-e2e")))
      .toBe(true);
    await expect.poll(() => state.calls.some((c) => c.url.includes("/logout"))).toBe(true);
    // O segredo não sobrevive no DOM.
    await expect(page.getByText(ENROLL_SECRET.slice(0, 4))).toHaveCount(0);
  });

  test("fator não verificado antigo é descartado antes de criar o novo", async ({ page }) => {
    const state = await loginAsAdmWithoutFactor(page, { hasStaleUnverifiedFactor: true });
    await expect(enrollHeading(page)).toBeVisible();
    const del = state.calls.findIndex((c) => c.method === "DELETE" && c.url.endsWith("/factors/factor-stale-e2e"));
    const post = state.calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/factors"));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThan(del);
  });

  test("QR ausente/não-SVG não vira <img>: só a chave manual (o auth-js só prefixa valor não vazio)", async ({ page }) => {
    await loginAsAdmWithoutFactor(page, { enrollQrCode: "" });
    await expect(enrollHeading(page)).toBeVisible();
    await expect(page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
    await expect(page.getByText(ENROLL_SECRET.slice(0, 4))).toBeVisible();
    expect((await expectNoXss(page)).executed).toBeUndefined();
  });
});

test.describe("importação Google Sheets", () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/importacao/google-sheets");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
    await expect(page.getByText("Página 1 de 1 — 8 item(ns)")).toBeVisible();
  });

  test("filtro por classificação envia status e filtra linhas", async ({ page }) => {
    const request = page.waitForRequest((r) => r.url().includes("/items") && r.url().includes("status=INVALIDO"));
    await page.getByRole("button", { name: "Inválido" }).click();
    await request;
    await expect(page.getByRole("button", { name: "Inválido" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Página 1 de 1 — 1 item(ns)")).toBeVisible();
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows).toHaveCount(1);
    // Linha inválida: checkbox desabilitado, com motivo acessível.
    await expect(rows.first().getByRole("checkbox")).toBeDisabled();

    await page.getByRole("button", { name: "Todos" }).click();
    await expect(page.getByText("Página 1 de 1 — 8 item(ns)")).toBeVisible();
  });

  test("pesquisa (debounce) envia search e filtra", async ({ page }) => {
    const request = page.waitForRequest((r) => r.url().includes("/items") && r.url().includes("search=cadeira"));
    await page.getByLabel("Buscar itens da prévia").fill("cadeira");
    await request;
    await expect(page.getByText("Página 1 de 1 — 3 item(ns)")).toBeVisible();
    await page.getByLabel("Buscar itens da prévia").fill("inexistente-xyz");
    await expect(page.getByText("Nenhum item encontrado para os filtros atuais.")).toBeVisible();
  });

  test("seleção → modal com contagens → confirmação", async ({ page }) => {
    await page.getByRole("checkbox", { name: "Selecionar item 000123" }).uncheck();
    await page.getByRole("button", { name: "Confirmar Importação" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
    await expect(dialog.getByText("Serão criados (Novo)").locator("..")).toContainText("2");
    await expect(dialog.getByText("Serão atualizados (Existente)").locator("..")).toContainText("2");
    const confirm = page.waitForRequest((r) => r.url().endsWith("/confirm") && r.method() === "POST");
    await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
    const body = (await confirm).postDataJSON() as { selected_item_ids: string[] };
    expect(body.selected_item_ids).toHaveLength(4);
    await expect(page.getByText("Última importação concluída com sucesso.")).toBeVisible();
  });

  test("marcadores XSS nas descrições/erros são exibidos como texto, sem executar", async ({ page }) => {
    await expect(page.getByText('Mesa sintética <img src=x onerror="window.__xss=1">')).toBeVisible();
    await expect(page.getByText("Armário sintético <script>window.__xss=2</script>")).toBeVisible();
    const xss = await expectNoXss(page);
    expect(xss).toEqual({ executed: undefined, injectedImgs: 0 });
  });
});

test.describe("convite de usuário", () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "Convidar Usuário" }).click();
  });

  test("validação: obrigatórios, e-mail inválido e unidades vazias", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
    let posted = false;
    page.on("request", (r) => {
      if (r.url().endsWith("/users/invite") && r.method() === "POST") posted = true;
    });

    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    expect(await dialog.getByLabel("Nome").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);

    await dialog.getByLabel("Nome").fill("Pessoa Sintética Convidada");
    await dialog.getByLabel("E-mail institucional").fill("sem-arroba");
    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    expect(
      await dialog.getByLabel("E-mail institucional").evaluate((el: HTMLInputElement) => el.validity.typeMismatch),
    ).toBe(true);

    await dialog.getByLabel("E-mail institucional").fill("convidada@exemplo.invalid");
    // Unidades: checkboxes vindos de GET /units (sem UUID livre); nenhuma marcada.
    const units = dialog.getByRole("group", { name: "Unidades" });
    await expect(units.getByRole("checkbox")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Selecione ao menos uma unidade.");
    await expect(units).toHaveAccessibleDescription("Selecione ao menos uma unidade.");
    await expect(units.getByRole("checkbox").first()).toBeFocused();
    expect(posted).toBe(false);
  });

  test("envio válido e conflito 409", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
    await dialog.getByLabel("Nome").fill("Pessoa Sintética Convidada");
    await dialog.getByLabel("E-mail institucional").fill("duplicado@exemplo.invalid");
    await dialog.getByLabel("Perfil").selectOption("RH");
    await dialog.getByRole("checkbox", { name: /PSU-TO/ }).check();
    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Já existe um convite pendente para este e-mail.");

    await dialog.getByLabel("E-mail institucional").fill("nova@exemplo.invalid");
    const req = page.waitForRequest((r) => r.url().endsWith("/users/invite") && r.method() === "POST");
    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    expect((await req).postDataJSON()).toMatchObject({
      email: "nova@exemplo.invalid",
      intended_role_code: "RH",
      unit_ids: ["60000000-0000-4000-8000-000000000001"],
    });
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Convite enviado para nova@exemplo.invalid.")).toBeVisible();
  });

  test("nomes com marcador XSS na lista não executam", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.getByText('Usuário <img src=x onerror="window.__xss=1">')).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });
});

test("segurança: ativar MFA avisa o backend; falha do aviso (500) não bloqueia", async ({ page }) => {
  const state = await installMocks(page, { role: "USER", hasVerifiedFactor: false, factorNoticeStatus: 500 });
  await seedSession(page, { role: "USER", hasVerifiedFactor: false });
  await page.goto("/configuracoes/seguranca");
  await waitForHydration(page);
  await page.getByRole("button", { name: "Ativar MFA" }).click();
  await page.getByLabel("Código do aplicativo").fill("123456");
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verificação em duas etapas ativada." })).toBeVisible();
  expect(state.calls.filter((c) => c.method === "POST" && c.url.endsWith("/factor-added-notice"))).toHaveLength(1);
  await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
});

test("segurança: nome do fator com marcador XSS é texto; remover → modal → DELETE", async ({ page }) => {
  const state = await installMocks(page, { role: "ADM" });
  await seedSession(page, { role: "ADM" });
  await page.goto("/configuracoes/seguranca");
  await waitForHydration(page);
  await expect(page.getByText('Autenticador <img src=x onerror="window.__xss=1">')).toBeVisible();
  await page.getByRole("button", { name: "Remover" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remover" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(state.calls.some((c) => c.method === "DELETE" && c.url.includes("/security/mfa/factors/"))).toBe(true);
  expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
});

// ---------------------------------------------------------------------------
// Configurações — índice e Inteligência Artificial (contrato:
// docs/architecture/modulo-configuracoes.md). A autorização real é do backend:
// o mock responde 403 para USER/RH e AAL2_REQUIRED para ADM em aal1.
// ---------------------------------------------------------------------------

const IA_PATH = "/configuracoes/inteligencia-artificial";

async function openIa(page: Page, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(IA_PATH);
  await waitForHydration(page);
  return state;
}

function aiPatches(state: MockState) {
  return state.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/v1/settings/ai"));
}

test.describe("configurações — índice", () => {
  test("ADM vê Segurança e Inteligência Artificial", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/configuracoes");
    await waitForHydration(page);
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: /Segurança/ })).toBeVisible();
    await expect(main.getByRole("link", { name: /Inteligência Artificial/ })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Trilha de navegação" })).toContainText("Configurações");
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role} não vê o cartão de IA`, async ({ page }) => {
      await installMocks(page, { role });
      await seedSession(page, { role });
      await page.goto("/configuracoes");
      await waitForHydration(page);
      const main = page.getByRole("main");
      await expect(main.getByRole("link", { name: /Segurança/ })).toBeVisible();
      await expect(main.getByRole("link", { name: /Inteligência Artificial/ })).toHaveCount(0);
    });
  }
});

test.describe("configurações — Inteligência Artificial", () => {
  test("salvar envia version e campos do contrato; tela reflete a resposta", async ({ page }) => {
    const state = await openIa(page);
    await expect(page.getByRole("navigation", { name: "Trilha de navegação" })).toContainText(
      "Inteligência Artificial",
    );
    await expect(
      page.getByText("Conteúdo gerado por IA pode conter erros. A IA é consultiva e não altera dados."),
    ).toBeVisible();
    const salvar = page.getByRole("button", { name: "Salvar" });
    await expect(salvar).toBeDisabled();

    const geral = page.getByRole("switch", { name: "Ligar a Inteligência Artificial" });
    await expect(geral).toHaveAttribute("aria-checked", "false");
    await geral.check();
    await expect(geral).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("Provedor", { exact: true }).selectOption("openai");
    const modelo = page.getByLabel("Modelo", { exact: true });
    await expect(modelo.locator("option")).toHaveText(["openai-modelo-sintetico-a", "openai-modelo-sintetico-b"]);
    await modelo.selectOption("openai-modelo-sintetico-b");
    await page.getByRole("switch", { name: "Pergunte ao SISPAT" }).check();
    await page.getByLabel("Teto mensal de tokens").fill("300000");

    const req = page.waitForRequest((r) => r.url().endsWith("/v1/settings/ai") && r.method() === "PATCH");
    await salvar.click();
    expect((await req).postDataJSON()).toEqual({
      version: 1,
      enabled: true,
      provider: "openai",
      model: "openai-modelo-sintetico-b",
      features: { alerts_explain: false, executive_summary: false, assistant: true, data_quality: false },
      monthly_token_cap: 300000,
    });
    await expect(page.getByText("Configurações de IA salvas.")).toBeVisible();
    await expect(page.locator("[data-state='success']").filter({ hasText: "Ativa" })).toBeVisible();
    await expect(salvar).toBeDisabled();
    expect(state.ai.version).toBe(2);

    // Testar conexão: resultado do backend em linguagem humana.
    await page.getByRole("button", { name: "Testar conexão" }).click();
    await expect(page.getByText("Conexão funcionando")).toBeVisible();
    await expect(page.getByText("O provedor respondeu em 840 ms.")).toBeVisible();
  });

  test("409 version_conflict: recarrega a versão nova e avisa", async ({ page }) => {
    const state = await openIa(page);
    const teto = page.getByLabel("Teto mensal de tokens");
    await expect(teto).toHaveValue("200000");
    // Outra pessoa salvou no meio tempo.
    state.ai = { ...state.ai, version: 7, monthly_token_cap: 123456 };

    await teto.fill("999");
    const reload = page.waitForRequest((r) => r.url().endsWith("/v1/settings/ai") && r.method() === "GET");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Outra pessoa alterou estas configurações" })).toBeVisible();
    await reload;
    await expect(teto).toHaveValue("123456");
    expect(aiPatches(state)).toHaveLength(1);
    expect((aiPatches(state)[0]!.body as { version: number }).version).toBe(1);

    // Salvar de novo usa a versão recarregada.
    await teto.fill("150000");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Configurações de IA salvas.")).toBeVisible();
    expect((aiPatches(state)[1]!.body as { version: number }).version).toBe(7);
  });

  test("DeepSeek exige aceite LGPD com checkbox e envia acknowledge_international_transfer", async ({ page }) => {
    const state = await openIa(page);
    const provedor = page.getByLabel("Provedor", { exact: true });
    await provedor.selectOption("deepseek");
    const dialog = page.getByRole("dialog", { name: "Transferência internacional de dados" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("servidores fora do Brasil");
    await expect(dialog).toContainText("dados agregados e anonimizados");

    // Cancelar mantém o provedor anterior.
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    await expect(provedor).toHaveValue("none");

    await provedor.selectOption("deepseek");
    await expect(dialog).toBeVisible();
    const confirmar = dialog.getByRole("button", { name: "Confirmar e usar DeepSeek" });
    await expect(confirmar).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await confirmar.click();
    await expect(dialog).toBeHidden();
    await expect(provedor).toHaveValue("deepseek");
    await expect(page.getByLabel("Modelo", { exact: true })).toHaveValue("deepseek-modelo-sintetico-a");

    const req = page.waitForRequest((r) => r.url().endsWith("/v1/settings/ai") && r.method() === "PATCH");
    await page.getByRole("button", { name: "Salvar" }).click();
    expect((await req).postDataJSON()).toMatchObject({
      version: 1,
      provider: "deepseek",
      model: "deepseek-modelo-sintetico-a",
      acknowledge_international_transfer: true,
    });
    await expect(page.getByText("Configurações de IA salvas.")).toBeVisible();
    expect(state.ai.deepseek_acknowledged).toBe(true);
    await expect(page.getByText("Aceite de transferência internacional de dados (LGPD) já registrado.")).toBeVisible();
  });

  test("AI_ENABLED=false no servidor: aviso claro; chaves só como Configurada/Não configurada", async ({ page }) => {
    await openIa(page, { role: "ADM", ai: { env_enabled: false } });
    await expect(
      page.getByText("A IA está desligada no servidor (AI_ENABLED). Peça ao responsável pela infraestrutura."),
    ).toBeVisible();
    const chaves = page.getByRole("list", { name: "Situação das chaves" });
    await expect(chaves.getByText("Configurada", { exact: true })).toHaveCount(2);
    await expect(chaves.getByText("Não configurada", { exact: true })).toHaveCount(1);
  });

  test("ADM sem AAL2: mensagem de verificação em duas etapas", async ({ page }) => {
    await openIa(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("main").getByRole("alert")).toContainText("verificação em duas etapas (AAL2)");
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role}: backend nega (403) e nenhum formulário aparece`, async ({ page }) => {
      const state = await openIa(page, { role });
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Você não tem permissão");
      await expect(page.getByRole("switch")).toHaveCount(0);
      expect(aiPatches(state)).toHaveLength(0);
    });
  }
});

test.describe("logomarca AGU no login", () => {
  for (const width of [320, 768, 1920]) {
    test(`carrega, sem rolagem horizontal e sem layout shift (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await installMocks(page);
      await page.goto("/login");
      await waitForHydration(page);
      const logo = page.getByRole("img", { name: "Logomarca da Advocacia-Geral da União" });
      await expect(logo).toBeVisible();
      await expect.poll(() => logo.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      // Texto da marca do sistema permanece visível.
      await expect(page.getByRole("banner").getByText("SISPAT-AGU", { exact: true })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await logo.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
      // Logo centralizada horizontalmente no viewport (±1px).
      const viewportCenter = await page.evaluate(() => document.documentElement.clientWidth / 2);
      expect(Math.abs(box!.x + box!.width / 2 - viewportCenter)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("tela pública autônoma (/login e /ativar-conta, sem shell do app)", () => {
  for (const path of ["/login", "/ativar-conta"]) {
    test(`${path}: sem sidebar/menu/header do app; marca, <main> e rodapé próprios`, async ({ page }) => {
      await installMocks(page);
      await page.goto(path);
      await waitForHydration(page);

      // Shell do app ausente.
      await expect(page.getByRole("navigation", { name: "Navegação principal" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Abrir menu de navegação" })).toHaveCount(0);
      await expect(page.locator("aside")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Trilha de navegação" })).toHaveCount(0);

      // Marca + landmarks próprios.
      const banner = page.getByRole("banner");
      await expect(banner.getByText("SISPAT-AGU", { exact: true })).toBeVisible();
      const logo = banner.getByRole("img", { name: "Logomarca da Advocacia-Geral da União" });
      await expect(logo).toBeVisible();
      await expect.poll(() => logo.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(page.locator("main#conteudo")).toHaveCount(1);
      const footer = page.getByRole("contentinfo");
      await expect(footer).toContainText("Sistema de Gestão Patrimonial — AGU, Palmas/TO");
      await expect(footer).toContainText(`© ${new Date().getFullYear()}`);
      await expect(footer).toContainText("Acesso apenas por convite");

      // Sem cadastro aberto, sem "esqueci a senha" (não há fluxo implementado).
      await expect(page.getByRole("link", { name: /cadastre|criar conta|registr|esqueceu/i })).toHaveCount(0);

      // Viewport inteiro, sem rolagem horizontal.
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        height: document.documentElement.scrollHeight,
        vh: window.innerHeight,
      }));
      expect(m.overflow).toBeLessThanOrEqual(0);
      expect(m.height).toBeGreaterThanOrEqual(m.vh);
    });
  }

  test("skip link leva ao <main> da tela pública", async ({ page }) => {
    await installMocks(page);
    await page.goto("/login");
    await waitForHydration(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Pular para o conteúdo" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#conteudo")).toBeFocused();
  });

  test("rota protegida sem sessão → /login, estável (sem loop de redirecionamento)", async ({ page }) => {
    await installMocks(page);
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    await page.goto("/configuracoes");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
    const settled = navigations;
    await page.waitForTimeout(1000);
    expect(navigations, "sem novas navegações após estabilizar").toBe(settled);
    expect(navigations).toBeLessThanOrEqual(3);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("área do app mantém o shell (menu) com sessão", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/");
    await waitForHydration(page);
    await expect(page.getByRole("navigation", { name: "Navegação principal", exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
  });
});

test.describe("auditoria de fronteira (F-1/F-6/F-10)", () => {
  test("F-6: sem sessão, Sidebar/Header do app não são renderizados antes do redirecionamento", async ({ page }) => {
    await installMocks(page);
    const seen: number[] = [];
    await page.exposeFunction("__reportChrome", (n: number) => seen.push(n));
    await page.addInitScript(() => {
      const probe = () => {
        const n = document.querySelectorAll('aside, nav[aria-label="Navegação principal"]').length;
        (window as unknown as { __reportChrome?: (n: number) => void }).__reportChrome?.(n);
      };
      new MutationObserver(probe).observe(document, { childList: true, subtree: true });
    });
    await page.goto("/administracao/usuarios");
    await expect(page).toHaveURL(/\/login$/);
    await page.waitForTimeout(500);
    expect(seen.filter((n) => n > 0)).toEqual([]);
  });

  test("F-10: 429 usa mensagem genérica com Retry-After (nunca a mensagem do backend)", async ({ page }) => {
    await installMocks(page, { role: "ADM", usersRateLimitRetryAfter: 90 });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    await expect(page.getByText("Aguarde 2 minutos e tente de novo.")).toBeVisible();
    await expect(page.getByText("SISPAT_BACKEND_MSG")).toHaveCount(0);
  });

  test("F-10: 429 sem Retry-After legível cai em mensagem genérica", async ({ page }) => {
    await installMocks(page, { role: "ADM", usersRateLimitRetryAfter: 0 });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    await expect(page.getByText("Aguarde alguns minutos e tente de novo.")).toBeVisible();
  });

  test("F-1: Bearer só vai para a origem da API", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    const origins = new Set<string>();
    page.on("request", (req) => {
      if (req.headers()["authorization"]?.startsWith("Bearer ")) origins.add(new URL(req.url()).origin);
    });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    expect([...origins].every((o) => o === "http://127.0.0.1:5000" || o === "http://127.0.0.1:54321")).toBe(true);
    expect(origins.has("http://127.0.0.1:5000")).toBe(true);
  });
});
