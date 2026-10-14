import { expect, test } from "@playwright/test";

import {
  expectNoXss,
  installMocks,
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
  "/configuracoes/seguranca",
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
    const units = dialog.getByLabel("Unidades (IDs separados por vírgula)");
    await units.fill(" , , ");
    await dialog.getByRole("button", { name: "Enviar convite" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Informe ao menos uma unidade (ID).");
    await expect(units).toHaveAttribute("aria-invalid", "true");
    await expect(units).toHaveAccessibleDescription("Informe ao menos uma unidade (ID).");
    expect(posted).toBe(false);
  });

  test("envio válido e conflito 409", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
    await dialog.getByLabel("Nome").fill("Pessoa Sintética Convidada");
    await dialog.getByLabel("E-mail institucional").fill("duplicado@exemplo.invalid");
    await dialog.getByLabel("Perfil").selectOption("RH");
    await dialog.getByLabel("Unidades (IDs separados por vírgula)").fill("60000000-0000-4000-8000-000000000001");
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
