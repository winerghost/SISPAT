import { expect, test, type Page, type Request } from "@playwright/test";

import {
  ADMIN_ID,
  API_URL,
  COMMON_USER_ID,
  expectNoXss,
  installMocks,
  RH_USER_ID,
  seedSession,
  TINY_PNG,
  USER_ID,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Gestão de usuários (Etapa 2) e "Meu perfil" — fluxos funcionais com mocks
// sintéticos que seguem o contrato de docs/architecture/modulo-configuracoes.md.
// A autorização/escopo/último ADM/REAUTH são do BACKEND (simulados no mock);
// aqui validamos o que a interface envia e como ela explica cada resposta.
// O nome do arquivo casa com o projeto "e2e" (testMatch /functional\.spec\.ts/).
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

// Mesmo padrão de e2e/responsive.spec.ts: o `next dev` compila cada rota na
// 1ª visita; só a navegação para uma rota ainda não compilada usa este limite.
const FIRST_COMPILE_TIMEOUT = 45_000;

const USERS_PATH = "/administracao/usuarios";
const RH_NAME = "Pessoa Sintética RH";
const ADMIN_NAME = "Pessoa Sintética Administradora com Nome Bastante Longo para Teste";
const COMMON_NAME = 'Usuário <img src=x onerror="window.__xss=1">';
const SELF_NAME = "Pessoa Sintética";

async function openUsers(page: Page, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(USERS_PATH);
  await waitForHydration(page);
  return state;
}

async function openSheet(page: Page, name: string, tab?: string) {
  await page.getByRole("button", { name: `Gerenciar ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name, exact: true });
  await expect(sheet).toBeVisible();
  if (tab) await sheet.getByRole("tab", { name: tab }).click();
  return sheet;
}

function calls(state: MockState, method: string, pathPart: string) {
  return state.calls.filter((c) => c.method === method && c.url.includes(pathPart));
}

function waitApi(page: Page, method: string, suffix: string | RegExp): Promise<Request> {
  return page.waitForRequest((r) => {
    if (r.method() !== method || !r.url().startsWith(API_URL)) return false;
    const path = new URL(r.url()).pathname;
    return typeof suffix === "string" ? path.endsWith(suffix) : suffix.test(path);
  });
}

test.describe("usuários — lista", () => {
  test("colunas, avatar assinado só para quem tem foto e último acesso em America/Araguaina", async ({ page }) => {
    await openUsers(page);
    const table = page.getByRole("table", { name: "Usuários" });
    for (const header of ["Nome", "E-mail", "Perfil", "Unidades", "Status", "Último acesso"]) {
      await expect(table.getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    const adminRow = table.getByRole("row").filter({ hasText: "administradora.sintetica" });
    await expect(adminRow).toContainText("PSU-TO — Procuradoria Seccional Sintética de Palmas");
    // 2026-10-13T18:30Z → 15:30 em Araguaína (UTC-3).
    await expect(adminRow).toContainText("13/10/2026");
    await expect(adminRow).toContainText("15:30");
    const img = adminRow.locator("img");
    await expect(img).toHaveAttribute("src", /\/storage\/v1\/object\/sign\/avatars\//);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // Sem foto: iniciais, e nenhuma URL assinada pedida para essa pessoa.
    const rhRow = table.getByRole("row").filter({ hasText: "rh.sintetico" });
    await expect(rhRow.locator("img")).toHaveCount(0);
    await expect(rhRow).toContainText("PR");
    await expect(rhRow).toContainText("Inativo");
    const commonRow = table.getByRole("row").filter({ hasText: "usuario.sintetico" });
    await expect(commonRow).toContainText("Nunca");
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("busca com debounce, filtros (aria-pressed / select) e ordenação enviam a allowlist", async ({ page }) => {
    const state = await openUsers(page);
    const rows = page.getByRole("table", { name: "Usuários" }).locator("tbody tr");
    await expect(rows).toHaveCount(4);

    const search = waitApi(page, "GET", "/v1/users");
    await page.getByLabel("Buscar por nome ou e-mail").fill("rh.sint");
    const searchUrl = new URL((await search).url());
    expect(searchUrl.searchParams.get("q")).toBe("rh.sint");
    await expect(rows).toHaveCount(1);
    // Debounce: não houve uma requisição por tecla.
    expect(calls(state, "GET", "q=r").length).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(4);

    const roles = page.getByRole("group", { name: "Filtrar por perfil" });
    const adm = roles.getByRole("button", { name: "ADM", exact: true });
    const byRole = waitApi(page, "GET", "/v1/users");
    await adm.click();
    expect(new URL((await byRole).url()).searchParams.get("role")).toBe("ADM");
    await expect(adm).toHaveAttribute("aria-pressed", "true");
    await expect(roles.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "false");
    await expect(rows).toHaveCount(2);

    const byUnit = waitApi(page, "GET", "/v1/users");
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    const unitUrl = new URL((await byUnit).url());
    expect(unitUrl.searchParams.get("unit_id")).toBe("60000000-0000-4000-8000-000000000002");
    expect(unitUrl.searchParams.get("role")).toBe("ADM");
    await expect(page.getByText("Nenhum usuário encontrado para os filtros atuais.")).toBeVisible();

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    const inactive = waitApi(page, "GET", "/v1/users");
    await page.getByRole("group", { name: "Filtrar por situação" }).getByRole("button", { name: "Inativos" }).click();
    expect(new URL((await inactive).url()).searchParams.get("active")).toBe("false");
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(4);

    // Ordenação por coluna permitida: Nome asc (padrão) → desc.
    const nameHeader = page.getByRole("columnheader", { name: /Nome/ });
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    const sorted = waitApi(page, "GET", "/v1/users");
    await nameHeader.getByRole("button").click();
    expect(new URL((await sorted).url()).searchParams.get("sort")).toBe("-name");
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    await expect(rows.first()).toContainText("Usuário");

    const byLogin = waitApi(page, "GET", "/v1/users");
    await page.getByRole("columnheader", { name: /Último acesso/ }).getByRole("button").click();
    expect(new URL((await byLogin).url()).searchParams.get("sort")).toBe("last_login_at");

    // Nenhum parâmetro fora da allowlist do contrato.
    const allowed = new Set(["q", "role", "unit_id", "active", "sort", "page", "page_size"]);
    for (const call of calls(state, "GET", "/v1/users?")) {
      for (const key of new URL(call.url, "http://x").searchParams.keys()) expect(allowed.has(key)).toBe(true);
    }
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role}: sem papel ADM em /me a tela explica e nem pede dados administrativos`, async ({ page }) => {
      const state = await openUsers(page, { role });
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Você não tem permissão");
      await expect(page.getByRole("table")).toHaveCount(0);
      // Negar por padrão na UI; o backend também nega (403) se chamado.
      expect(state.calls.some((c) => c.url.startsWith("/api/v1/users") || c.url.startsWith("/api/v1/units"))).toBe(false);
    });
  }

  test("ADM sem AAL2: orienta a confirmar a verificação em duas etapas", async ({ page }) => {
    await openUsers(page, { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("main").getByRole("alert").first()).toContainText("verificação em duas etapas (AAL2)");
  });
});

test.describe("usuários — perfil e unidades", () => {
  test("promover a ADM exige confirmação explícita e envia confirm_privilege_change", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, RH_NAME);
    await expect(sheet.getByRole("radio", { name: /RH — Recursos Humanos/ })).toBeChecked();
    // Vínculo fora do escopo: só informativo.
    await expect(sheet.getByText("FORA-09 — Unidade Sintética Fora do Escopo")).toBeVisible();

    await sheet.getByRole("radio", { name: /ADM — Administração/ }).check();
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    const confirm = page.getByRole("dialog", { name: "Promover a administrador" });
    await expect(confirm).toContainText("passará a ter o perfil ADM");
    await expect(confirm).toContainText("verificação em duas etapas");
    // Cancelar não envia nada.
    await confirm.getByRole("button", { name: "Cancelar" }).click();
    await expect(confirm).toBeHidden();
    expect(calls(state, "PATCH", `/v1/users/${RH_USER_ID}`)).toHaveLength(0);

    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    const req = waitApi(page, "PATCH", `/v1/users/${RH_USER_ID}`);
    await confirm.getByRole("button", { name: "Confirmar promoção" }).click();
    expect((await req).postDataJSON()).toEqual({ version: 2, role: "ADM", confirm_privilege_change: true });
    await expect(confirm).toBeHidden();
    await expect(page.getByText("Perfil e unidades atualizados.")).toBeVisible();
    await expect(sheet.getByRole("radio", { name: /ADM — Administração/ })).toBeChecked();
    expect(state.users.find((u) => u.id === RH_USER_ID)).toMatchObject({ role: "ADM", version: 3 });
  });

  test("backend pede confirmação (400 confirmation_required): o diálogo é reaberto", async ({ page }) => {
    await openUsers(page);
    const sheet = await openSheet(page, ADMIN_NAME);
    await sheet.getByRole("radio", { name: /USER — Usuário/ }).check();
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    const confirm = page.getByRole("dialog", { name: "Remover privilégio de administrador" });
    await expect(confirm).toContainText("Perderá imediatamente o acesso à área administrativa.");
    // Simula o backend exigindo confirmação mesmo assim, só na 1ª tentativa.
    let rejected = false;
    await page.route(
      (url) => url.href.startsWith(API_URL) && url.pathname.endsWith(`/v1/users/${ADMIN_ID}`),
      async (route) => {
        if (route.request().method() !== "PATCH" || rejected) return route.fallback();
        rejected = true;
        return route.fulfill({
          status: 400,
          headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
          body: JSON.stringify({ error: { code: "confirmation_required", message: "detalhe técnico cru" } }),
        });
      },
    );
    await confirm.getByRole("button", { name: "Confirmar remoção do privilégio" }).click();
    await expect(confirm).toBeVisible();
    await expect(page.getByText("detalhe técnico cru")).toHaveCount(0);
    await confirm.getByRole("button", { name: "Confirmar remoção do privilégio" }).click();
    await expect(page.getByText("Perfil e unidades atualizados.")).toBeVisible();
  });

  test("unidades por checkbox: PATCH só com unit_ids; fora do escopo → mensagem humana", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, COMMON_NAME);
    const units = sheet.getByRole("group", { name: /Unidades vinculadas/ });
    await expect(units.getByRole("checkbox", { name: /PSU-TO/ })).toBeChecked();
    await expect(units.getByRole("checkbox", { name: /ESC-02/ })).toBeChecked();

    // Desmarcar tudo: validação de UX (o backend exige 1..50).
    await units.getByRole("checkbox", { name: /PSU-TO/ }).uncheck();
    await units.getByRole("checkbox", { name: /ESC-02/ }).uncheck();
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    await expect(sheet.getByRole("alert")).toHaveText("Selecione ao menos uma unidade.");
    expect(calls(state, "PATCH", "/v1/users/")).toHaveLength(0);

    await units.getByRole("checkbox", { name: /PSU-TO/ }).check();
    const req = waitApi(page, "PATCH", `/v1/users/${COMMON_USER_ID}`);
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    expect((await req).postDataJSON()).toEqual({
      version: 1,
      unit_ids: ["60000000-0000-4000-8000-000000000001"],
    });
    await expect(page.getByText("Perfil e unidades atualizados.")).toBeVisible();

    // A unidade NUC-03 sai do escopo do ADM no servidor (a tela ainda a mostra).
    state.units = state.units.filter((u) => u.code !== "NUC-03");
    await units.getByRole("checkbox", { name: /NUC-03/ }).check();
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "Uma ou mais unidades escolhidas estão fora do seu escopo de administração. Escolha apenas unidades da lista.",
    );
    // Nome da unidade com marcador XSS é texto.
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("409 version_conflict: recarrega o usuário e avisa; salvar de novo usa a versão nova", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, COMMON_NAME);
    // Outra pessoa alterou o usuário no meio tempo.
    const target = state.users.find((u) => u.id === COMMON_USER_ID)!;
    target.version = 9;

    await sheet.getByRole("radio", { name: /RH — Recursos Humanos/ }).check();
    const reload = waitApi(page, "GET", `/v1/users/${COMMON_USER_ID}`);
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    await expect(sheet.getByRole("alert").filter({ hasText: "Outra pessoa alterou este usuário" })).toBeVisible();
    await reload;
    // Formulário remontado com o estado do servidor (perfil original).
    await expect(sheet.getByRole("radio", { name: /USER — Usuário/ })).toBeChecked();

    await sheet.getByRole("radio", { name: /RH — Recursos Humanos/ }).check();
    const req = waitApi(page, "PATCH", `/v1/users/${COMMON_USER_ID}`);
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    expect((await req).postDataJSON()).toEqual({ version: 9, role: "RH" });
    await expect(page.getByText("Perfil e unidades atualizados.")).toBeVisible();
  });

  test("último ADM (409 last_admin) e próprio usuário (bloqueado + 409 self_change_forbidden)", async ({ page }) => {
    const state = await openUsers(page);
    // Só a administradora segue como ADM ativa.
    state.users.find((u) => u.id === USER_ID)!.active = false;
    const sheet = await openSheet(page, ADMIN_NAME);
    await sheet.getByRole("radio", { name: /USER — Usuário/ }).check();
    await sheet.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    await page
      .getByRole("dialog", { name: "Remover privilégio de administrador" })
      .getByRole("button", { name: "Confirmar remoção do privilégio" })
      .click();
    await expect(sheet.getByRole("alert")).toContainText("último administrador (ADM) ativo");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Próprio usuário: a UI já orienta e bloqueia (só UX)...
    state.users.find((u) => u.id === USER_ID)!.active = true;
    const self = await openSheet(page, SELF_NAME);
    await expect(self.getByText("Este é o seu usuário.")).toBeVisible();
    await expect(self.getByRole("button", { name: "Salvar perfil e unidades" })).toBeDisabled();
    await self.getByRole("tab", { name: "Conta" }).click();
    await expect(self.getByRole("button", { name: "Desativar conta" })).toBeDisabled();
    await expect(self.getByRole("button", { name: "Resetar MFA" })).toBeDisabled();
    await page.keyboard.press("Escape");

    // ...e, se o backend recusar mesmo assim, a mensagem é humana (nunca a crua).
    await page.route(
      (url) => url.href.startsWith(API_URL) && url.pathname.endsWith(`/v1/users/${COMMON_USER_ID}`),
      (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({
              status: 409,
              headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
              body: JSON.stringify({ error: { code: "self_change_forbidden", message: "raw backend text" } }),
            })
          : route.fallback(),
    );
    const common = await openSheet(page, COMMON_NAME);
    await common.getByRole("radio", { name: /RH — Recursos Humanos/ }).check();
    await common.getByRole("button", { name: "Salvar perfil e unidades" }).click();
    await expect(common.getByRole("alert")).toContainText("Você não pode alterar o próprio perfil");
    await expect(page.getByText("raw backend text")).toHaveCount(0);
  });

  test("ID inexistente/fora do escopo (404) → aviso neutro", async ({ page }) => {
    const state = await openUsers(page);
    await expect(page.getByRole("table", { name: "Usuários" })).toBeVisible();
    // O usuário some do escopo depois de listado.
    state.users = state.users.filter((u) => u.id !== RH_USER_ID);
    await page.getByRole("button", { name: `Gerenciar ${RH_NAME}`, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Usuário não encontrado, ou fora do seu escopo de unidades.")).toBeVisible();
    await expect(sheet.getByRole("tablist")).toHaveCount(0);
  });
});

test.describe("usuários — conta", () => {
  test("desativar (com motivo) e reativar: confirmação explica e resultado vem do backend", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, COMMON_NAME, "Conta");
    await sheet.getByRole("button", { name: "Desativar conta" }).click();
    const dialog = page.getByRole("dialog", { name: "Desativar conta" });
    await expect(dialog).toContainText("não conseguirá mais entrar");
    await expect(dialog).toContainText("sessões abertas");
    await dialog.getByLabel("Motivo (opcional)").fill("Servidor sintético removido da lotação.");
    const req = waitApi(page, "POST", "/deactivate");
    await dialog.getByRole("button", { name: "Desativar conta" }).click();
    expect((await req).postDataJSON()).toEqual({ version: 1, reason: "Servidor sintético removido da lotação." });
    await expect(dialog).toBeHidden();
    await expect(sheet.getByTestId("resultado-acao-conta")).toHaveText("Conta desativada e sessões encerradas.");
    await expect(sheet.getByText("Desativada", { exact: true })).toBeVisible();

    await sheet.getByRole("button", { name: "Reativar conta" }).click();
    const reactivate = page.getByRole("dialog", { name: "Reativar conta" });
    const req2 = waitApi(page, "POST", "/activate");
    await reactivate.getByRole("button", { name: "Reativar conta" }).click();
    expect((await req2).postDataJSON()).toEqual({ version: 2 });
    await expect(sheet.getByTestId("resultado-acao-conta")).toContainText("Conta reativada.");
    expect(state.users.find((u) => u.id === COMMON_USER_ID)).toMatchObject({ active: true, version: 3 });
  });

  test("encerrar sessões e redefinição de senha (sent / unavailable)", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, COMMON_NAME, "Conta");

    await sheet.getByRole("button", { name: "Encerrar sessões" }).click();
    const sessions = page.getByRole("dialog", { name: "Encerrar sessões" });
    await expect(sessions).toContainText("A conta continua ativa");
    await sessions.getByRole("button", { name: "Encerrar sessões" }).click();
    await expect(sheet.getByTestId("resultado-acao-conta")).toContainText("Sessões encerradas em");
    expect(calls(state, "POST", "/revoke-sessions")[0]?.body).toBeUndefined();

    await sheet.getByRole("button", { name: "Enviar redefinição de senha" }).click();
    const reset = page.getByRole("dialog", { name: "Enviar redefinição de senha" });
    await expect(reset).toContainText("Você não vê o link nem a nova senha.");
    await reset.getByRole("button", { name: "Enviar e-mail" }).click();
    await expect(sheet.getByTestId("resultado-acao-conta")).toHaveText(
      "E-mail de redefinição de senha enviado para usuario.sintetico@exemplo.invalid.",
    );

    state.passwordReset = "unavailable";
    await sheet.getByRole("button", { name: "Enviar redefinição de senha" }).click();
    await reset.getByRole("button", { name: "Enviar e-mail" }).click();
    await expect(sheet.getByTestId("resultado-acao-conta")).toHaveText(
      "O envio de e-mail está indisponível no momento. Nada foi alterado; tente novamente mais tarde.",
    );
  });

  test("resetar MFA: REAUTH_REQUIRED pede o código do autenticador e repete a chamada", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, COMMON_NAME, "Conta");
    await sheet.getByRole("button", { name: "Resetar MFA" }).click();
    const dialog = page.getByRole("dialog", { name: "Resetar verificação em duas etapas" });
    await expect(dialog).toContainText("últimos 5 minutos");
    await dialog.getByRole("button", { name: "Resetar MFA" }).click();

    // 403 REAUTH_REQUIRED → mesmo diálogo vira a confirmação do código.
    const reauth = page.getByRole("dialog", { name: "Confirme sua identidade" });
    await expect(reauth).toBeVisible();
    const code = reauth.getByLabel("Código do autenticador");
    await code.fill("000000");
    await reauth.getByRole("button", { name: "Confirmar código" }).click();
    await expect(reauth.getByRole("alert")).toContainText("Código inválido ou expirado.");
    expect(calls(state, "POST", "/mfa-reset")).toHaveLength(1);

    await code.fill("123456");
    const retry = waitApi(page, "POST", "/mfa-reset");
    await reauth.getByRole("button", { name: "Confirmar código" }).click();
    await retry;
    await expect(reauth).toBeHidden();
    await expect(sheet.getByTestId("resultado-acao-conta")).toContainText("1 fator(es) removido(s)");
    expect(calls(state, "POST", "/mfa-reset")).toHaveLength(2);
    // O desafio TOTP foi o do Supabase (mesmo fluxo do login), sem guardar o código.
    expect(state.calls.some((c) => /\/factors\/[^/]+\/verify$/.test(c.url))).toBe(true);
  });
});

test.describe("usuários — foto e histórico", () => {
  test("foto: inválida no cliente, rejeitada pelo servidor, envio válido e remoção", async ({ page }) => {
    const state = await openUsers(page);
    const sheet = await openSheet(page, COMMON_NAME, "Foto");
    const input = sheet.getByLabel("Escolher foto");

    // Tipo não aceito: barrado no cliente (UX), sem chamada ao servidor.
    await input.setInputFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("texto") });
    await expect(sheet.getByRole("alert")).toHaveText("Formato não aceito. Escolha uma foto JPEG, PNG ou WebP.");
    // Grande demais: idem.
    await input.setInputFiles({ name: "grande.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
    await expect(sheet.getByRole("alert")).toHaveText("A foto deve ter no máximo 2 MB.");
    expect(calls(state, "PUT", "/avatar")).toHaveLength(0);

    // Extensão/tipo "corretos" mas bytes falsos: o servidor decide (400 unsupported_image).
    await input.setInputFiles({ name: "falsa.png", mimeType: "image/png", buffer: Buffer.from("isto não é imagem") });
    await sheet.getByRole("button", { name: "Enviar foto" }).click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "Imagem não aceita. Envie uma foto JPEG, PNG ou WebP de até 4096 px de lado.",
    );

    // Válida: pré-visualização local (blob:) e depois PUT multipart.
    await sheet.getByLabel("Escolher outra foto").setInputFiles({ name: "rosto.png", mimeType: "image/png", buffer: TINY_PNG });
    await expect(sheet.getByText("Pré-visualização — a foto ainda não foi enviada.")).toBeVisible();
    await expect(sheet.locator("img[src^='blob:']")).toHaveCount(1);
    const put = waitApi(page, "PUT", `/v1/users/${COMMON_USER_ID}/avatar`);
    await sheet.getByRole("button", { name: "Enviar foto" }).click();
    const request = await put;
    expect(request.headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.postDataBuffer()!.includes(TINY_PNG)).toBe(true);
    await expect(page.getByText("Foto atualizada.")).toBeVisible();
    await expect(sheet.locator("img[src*='/storage/v1/object/sign/avatars/']").first()).toBeVisible();
    await expect(sheet.locator("img[src^='blob:']")).toHaveCount(0);

    await sheet.getByRole("button", { name: "Remover foto" }).click();
    const confirm = page.getByRole("dialog", { name: "Remover foto" });
    await expect(confirm).toContainText("As iniciais do nome passam a ser exibidas no lugar.");
    const del = waitApi(page, "DELETE", `/v1/users/${COMMON_USER_ID}/avatar`);
    await confirm.getByRole("button", { name: "Remover foto" }).click();
    await del;
    await expect(page.getByText("Foto removida.")).toBeVisible();
    await expect(sheet.getByText("Sem foto — as iniciais são exibidas no lugar.")).toBeVisible();
    expect(state.users.find((u) => u.id === COMMON_USER_ID)!.has_avatar).toBe(false);
  });

  test("Storage fora do ar (503): aviso claro, o resto da tela segue", async ({ page }) => {
    await openUsers(page, { role: "ADM", storageUnavailable: true });
    await expect(page.getByRole("table", { name: "Usuários" }).locator("tbody tr")).toHaveCount(4);
    const sheet = await openSheet(page, ADMIN_NAME, "Foto");
    await expect(sheet.getByRole("alert")).toContainText("armazenamento de fotos está indisponível");
    await sheet.getByRole("tab", { name: "Perfil e unidades" }).click();
    await expect(sheet.getByRole("radio", { name: /ADM — Administração/ })).toBeChecked();
  });

  test("histórico: paginado, changes como texto e marcador XSS inerte", async ({ page }) => {
    await openUsers(page);
    let sheet = await openSheet(page, COMMON_NAME, "Histórico");
    const list = sheet.getByRole("list", { name: "Histórico de alterações" });
    await expect(list.locator(":scope > li")).toHaveCount(2);
    await expect(list).toContainText("Unidades alteradas");
    await expect(list).toContainText(
      "Unidades: PSU-TO — Procuradoria Seccional Sintética de Palmas → PSU-TO — Procuradoria Seccional Sintética de Palmas, ESC-02 — Escritório Sintético Avançado",
    );
    await expect(list).toContainText("Perfil: <script>window.__xss=2</script> → USER");
    await expect(list).toContainText("pelo sistema");
    await expect(list).toContainText("10/10/2026");
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
    await page.keyboard.press("Escape");

    sheet = await openSheet(page, ADMIN_NAME, "Histórico");
    await expect(sheet.getByText("Página 1 de 2 · 12 evento(s)")).toBeVisible();
    const page2 = waitApi(page, "GET", `/v1/users/${ADMIN_ID}/audit`);
    await sheet.getByRole("button", { name: "Próxima" }).click();
    expect(new URL((await page2).url()).searchParams.get("page")).toBe("2");
    await expect(sheet.getByText("Página 2 de 2 · 12 evento(s)")).toBeVisible();
    await expect(sheet.getByRole("list", { name: "Histórico de alterações" }).locator(":scope > li")).toHaveCount(2);
  });
});

test.describe("Meu perfil (/configuracoes/perfil)", () => {
  test("sem sessão → /login", async ({ page }) => {
    const state = await installMocks(page);
    await page.goto("/configuracoes/perfil");
    await expect(page).toHaveURL(/\/login$/, { timeout: FIRST_COMPILE_TIMEOUT });
    expect(state.calls.filter((c) => c.url.startsWith("/api/v1/") && c.method !== "OPTIONS")).toEqual([]);
  });

  test("USER: nome/e-mail somente leitura; envia e remove a própria foto via /me/avatar", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER" });
    await page.goto("/configuracoes/perfil");
    await waitForHydration(page);
    const main = page.getByRole("main");
    await expect(main.getByText("pessoa.sintetica@exemplo.invalid")).toBeVisible();
    await expect(main.getByRole("textbox")).toHaveCount(0);
    await expect(main.getByText("Sem foto — as iniciais são exibidas no lugar.")).toBeVisible();

    const put = waitApi(page, "PUT", "/v1/me/avatar");
    await main.getByLabel("Escolher foto").setInputFiles({ name: "eu.png", mimeType: "image/png", buffer: TINY_PNG });
    await main.getByRole("button", { name: "Enviar foto" }).click();
    expect((await put).url()).not.toContain(USER_ID);
    await expect(page.getByText("Foto atualizada.")).toBeVisible();
    await expect(main.locator("img[src*='/storage/v1/object/sign/avatars/me.webp']")).toBeVisible();
    expect(state.meHasAvatar).toBe(true);

    await main.getByRole("button", { name: "Remover foto" }).click();
    await page.getByRole("dialog", { name: "Remover foto" }).getByRole("button", { name: "Remover foto" }).click();
    await expect(page.getByText("Foto removida.")).toBeVisible();
    expect(calls(state, "DELETE", "/v1/me/avatar")).toHaveLength(1);
    // Nenhuma rota administrativa de usuários foi chamada por um USER.
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/users"))).toBe(false);
  });

  test("header: has_avatar=false em /me → iniciais, sem pedir URL assinada", async ({ page }) => {
    const state = await installMocks(page, { role: "RH" });
    await seedSession(page, { role: "RH" });
    await page.goto("/");
    await waitForHydration(page);
    const link = page.getByRole("link", { name: "Meu perfil (Pessoa Sintética)" });
    await expect(link).toBeVisible();
    await expect(link).toContainText("PS");
    expect(state.calls.some((c) => c.url.includes("/avatar-url"))).toBe(false);
    await link.click();
    await expect(page).toHaveURL(/\/configuracoes\/perfil$/, { timeout: FIRST_COMPILE_TIMEOUT });
    await expect(page.getByRole("heading", { level: 1, name: "Meu perfil" })).toBeVisible();
  });

  test("UA-FE-01: has_avatar=true em /me → header e Meu perfil mostram a foto assinada", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", meHasAvatar: true });
    await seedSession(page, { role: "USER" });
    await page.goto("/configuracoes/perfil");
    await waitForHydration(page);
    const header = page.getByRole("link", { name: "Meu perfil (Pessoa Sintética)" });
    await expect(header.locator("img[src*='/storage/v1/object/sign/avatars/me.webp']")).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });
    const main = page.getByRole("main");
    await expect(main.locator("img[src*='/storage/v1/object/sign/avatars/me.webp']")).toBeVisible();
    await expect(main.getByRole("button", { name: "Remover foto" })).toBeVisible();
    // A imagem carrega sob a CSP restrita ao prefixo do bucket `avatars`.
    await expect
      .poll(() => header.locator("img").evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // Header e página compartilham a mesma URL assinada (uma só chamada).
    expect(state.calls.filter((c) => c.method === "GET" && c.url.endsWith("/v1/me/avatar-url"))).toHaveLength(1);
  });
});

test.describe("UA-FE-02 / UA-FE-03", () => {
  test("lista: URL assinada só para linhas visíveis e sem renovação em segundo plano", async ({ page }) => {
    await page.clock.install();
    const state = await installMocks(page, { role: "ADM" });
    const base = state.users[1]!;
    state.users = Array.from({ length: 25 }, (_, i) => ({
      ...base,
      id: `21000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      name: `Pessoa Sintética Foto ${String(i + 1).padStart(2, "0")}`,
      email: `foto${i + 1}@exemplo.invalid`,
      has_avatar: true,
    }));
    await seedSession(page, { role: "ADM" });
    await page.goto(USERS_PATH);
    await waitForHydration(page);
    const rows = page.getByRole("table", { name: "Usuários" }).locator("tbody tr");
    await expect(rows).toHaveCount(25);
    const avatarCalls = () => calls(state, "GET", "/avatar-url").length;
    await expect.poll(avatarCalls).toBeGreaterThan(0);
    await page.clock.runFor(1_000);
    const visibleOnly = avatarCalls();
    // Só as linhas na área visível (768px de altura) pediram URL.
    expect(visibleOnly).toBeLessThan(25);
    const last = state.users[24]!.id;
    expect(state.calls.some((c) => c.url.includes(`/users/${last}/avatar-url`))).toBe(false);

    // Sem renovação em segundo plano: 10 min depois, nenhuma chamada nova.
    await page.clock.runFor(10 * 60_000);
    expect(avatarCalls()).toBe(visibleOnly);

    // A linha final só pede a URL quando fica visível.
    await rows.last().scrollIntoViewIfNeeded();
    await expect.poll(() => state.calls.some((c) => c.url.includes(`/users/${last}/avatar-url`))).toBe(true);
  });

  test("reautenticação sem fator VERIFICADO não usa fator pendente: orienta sair e entrar", async ({ page }) => {
    const opts: MockOptions = { role: "ADM", hasVerifiedFactor: false, hasStaleUnverifiedFactor: true };
    const state = await openUsers(page, opts);
    const sheet = await openSheet(page, COMMON_NAME, "Conta");
    await sheet.getByRole("button", { name: "Resetar MFA" }).click();
    await page
      .getByRole("dialog", { name: "Resetar verificação em duas etapas" })
      .getByRole("button", { name: "Resetar MFA" })
      .click();
    const reauth = page.getByRole("dialog", { name: "Confirme sua identidade" });
    await reauth.getByLabel("Código do autenticador").fill("123456");
    await reauth.getByRole("button", { name: "Confirmar código" }).click();
    await expect(reauth.getByRole("alert")).toContainText("Saia do sistema e entre novamente");
    // Nenhum challenge/verify no fator pendente (não conclui cadastro).
    expect(state.calls.some((c) => /\/factors\/[^/]+\/(challenge|verify)$/.test(c.url))).toBe(false);
    expect(calls(state, "POST", "/mfa-reset")).toHaveLength(1);
  });
});
