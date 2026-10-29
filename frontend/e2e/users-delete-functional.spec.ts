import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request, type Route } from "@playwright/test";

import { collectLayoutReport } from "./support/layout-checks";
import {
  API_URL,
  COMMON_USER_ID,
  expectNoXss,
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Frente C — exclusão de usuário e revogação total de acesso na tela
// (`/administracao/usuarios` → painel do usuário → aba "Conta").
// =============================================================================
// O backend é a autoridade: permissão, AAL2, escopo de unidade, "último ADM",
// `version` e a conferência do `confirm_text` são decididos lá. Aqui testamos
// APENAS o que a interface envia e como explica cada resposta.
//
// IMPORTANTE: as respostas de `POST /api/v1/users/<id>/delete` são
// INTERCEPTADAS no navegador (o mock compartilhado `e2e/support/mocks.ts` não
// conhece a rota). Elas reproduzem o contrato REAL confirmado pelo backend:
//   corpo `{version, confirm_text}` (campo extra → 400);
//   200 → `UserSummary` anonimizado (`name: "Usuário excluído"`,
//         `email: "excluido+<id>@anonimizado.invalid"`, `active: false`,
//         `role: null`, `units: []`, `version+1`) + chave extra `deleted_at`;
//   400 `confirmation_mismatch`; 409 `version_conflict` /
//   `self_change_forbidden` / `last_admin`; 403 AAL2/permissão (`users.delete`);
//   404 idêntico p/ inexistente, malformado, de outra unidade e já excluído;
//   429 `rate_limited`; 503 `rate_limit_unavailable`. Nenhum guard emite 423.
// `POST /users/<id>/revoke` JÁ EXISTE no backend (200 `{status, user_id}`);
// o mock compartilhado ainda responde 204, então também é interceptado aqui.
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const USERS_PATH = "/administracao/usuarios";
const COMMON_NAME = 'Usuário <img src=x onerror="window.__xss=1">';
const COMMON_EMAIL = "usuario.sintetico@exemplo.invalid";
const SELF_NAME = "Pessoa Sintética";
const DELETE_DIALOG = "Excluir usuário definitivamente";
const REVOKE_DIALOG = "Revogar todo o acesso";

const JSON_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "true",
  "content-type": "application/json",
} as const;

type DeleteOutcome =
  | { status: 200 }
  | { status: 400; code: "confirmation_mismatch" | "validation_error" }
  | { status: 409; code: "version_conflict" | "self_change_forbidden" | "last_admin" }
  | { status: 404 }
  | { status: 403; code: "REAUTH_REQUIRED" | "aal2_required" }
  | { status: 503; code: "rate_limit_unavailable" };

interface DeleteRoute {
  /** Fila de respostas; a última se repete. */
  outcomes: DeleteOutcome[];
  /** Atraso (ms) antes de responder — para testar o bloqueio de duplo envio. */
  delayMs: number;
  requests: { body: unknown }[];
}

/**
 * Intercepta `POST /v1/users/<id>/delete` (rota em implementação no backend).
 * Em 200 devolve o resumo ANONIMIZADO e remove o usuário de `state.users`,
 * como o backend fará (`deleted_at IS NULL` em todo GET do módulo).
 */
async function interceptDelete(page: Page, state: MockState, userId: string): Promise<DeleteRoute> {
  const ctrl: DeleteRoute = { outcomes: [{ status: 200 }], delayMs: 0, requests: [] };
  await page.route(
    (url) => url.href.startsWith(API_URL) && url.pathname.endsWith(`/v1/users/${userId}/delete`),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { version?: number; confirm_text?: string };
      ctrl.requests.push({ body });
      const outcome = ctrl.outcomes.length > 1 ? ctrl.outcomes.shift()! : ctrl.outcomes[0]!;
      if (ctrl.delayMs) await new Promise((resolve) => setTimeout(resolve, ctrl.delayMs));
      if (outcome.status === 200) {
        const target = state.users.find((u) => u.id === userId);
        state.users = state.users.filter((u) => u.id !== userId);
        return route.fulfill({
          status: 200,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            id: userId,
            // Como o backend: rótulo fixo e endereço único NÃO roteável.
            name: "Usuário excluído",
            email: `excluido+${userId}@anonimizado.invalid`,
            active: false,
            role: null,
            units: [],
            has_avatar: false,
            created_at: target?.created_at ?? "2026-02-01T12:00:00Z",
            last_login_at: null,
            deactivated_at: "2026-10-28T12:00:00Z",
            deleted_at: "2026-10-28T12:00:00Z",
            anonymized_at: "2026-10-28T12:00:00Z",
            version: (target?.version ?? 1) + 1,
          }),
        });
      }
      const error =
        outcome.status === 404
          ? { code: "not_found", message: "texto cru do backend que a tela nunca mostra" }
          : { code: outcome.code, message: "texto cru do backend que a tela nunca mostra" };
      return route.fulfill({ status: outcome.status, headers: JSON_HEADERS, body: JSON.stringify({ error }) });
    },
  );
  return ctrl;
}

/** Intercepta `POST /v1/users/<id>/revoke` com o 200 do backend atual. */
async function interceptRevoke(page: Page, userId: string, status: 200 | 409 | 429 = 200) {
  const requests: { body: unknown }[] = [];
  await page.route(
    (url) => url.href.startsWith(API_URL) && url.pathname.endsWith(`/v1/users/${userId}/revoke`),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      requests.push({ body: route.request().postDataJSON() });
      if (status === 200) {
        return route.fulfill({
          status: 200,
          headers: JSON_HEADERS,
          body: JSON.stringify({ status: "revoked", user_id: userId }),
        });
      }
      return route.fulfill({
        status,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: { code: "conflict", message: "texto cru" } }),
      });
    },
  );
  return requests;
}

async function openUsers(page: Page, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(USERS_PATH);
  await waitForHydration(page);
  return state;
}

async function openAccountTab(page: Page, name: string) {
  await expect(page.getByRole("table", { name: "Usuários" })).toBeVisible();
  await page.getByRole("button", { name: `Gerenciar ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name, exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("tab", { name: "Conta" }).click();
  return sheet;
}

function waitApi(page: Page, method: string, suffix: string): Promise<Request> {
  return page.waitForRequest(
    (r) => r.method() === method && r.url().startsWith(API_URL) && new URL(r.url()).pathname.endsWith(suffix),
  );
}

// -----------------------------------------------------------------------------

test.describe("usuários — exclusão (confirmação forte)", () => {
  test("a tela separa inativar de excluir e explica anonimização, irreversibilidade e auditoria", async ({
    page,
  }) => {
    await openUsers(page);
    const sheet = await openAccountTab(page, COMMON_NAME);

    // Desativar continua na lista de ações reversíveis e diz que NÃO é exclusão.
    const reversible = sheet.getByRole("list", { name: "Ações da conta" });
    await expect(reversible.getByRole("button", { name: "Desativar conta" })).toBeVisible();
    await expect(reversible).toContainText("não é exclusão");

    // Revogar e excluir ficam numa zona própria, com o aviso da diferença.
    const zone = sheet.getByRole("region", { name: "Ações de alto impacto" });
    await expect(zone).toContainText("Desativar uma conta é reversível");
    await expect(zone).toContainText("Excluir é definitivo e não tem desfazer");
    await expect(zone.getByRole("button", { name: "Revogar acesso" })).toBeVisible();
    await expect(zone.getByRole("button", { name: "Excluir usuário" })).toBeVisible();

    await zone.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    await expect(dialog).toBeVisible();
    // Sem eufemismo: o texto diz exatamente o que acontece.
    await expect(dialog).toContainText("Esta ação é irreversível.");
    await expect(dialog).toContainText("não existe desfazer, lixeira nem restauração");
    await expect(dialog).toContainText("Os dados pessoais são anonimizados");
    await expect(dialog).toContainText("O histórico de auditoria é preservado");
    await expect(dialog).toContainText("os registros dos eventos não são apagados");
    // Não promete que o excluído continua visível na tela de auditoria.
    await expect(dialog).toContainText("deixa de aparecer na tela de auditoria");
    await expect(dialog).toContainText("desaparece da listagem");
    await expect(dialog).toContainText("use “Desativar conta”, que é reversível");
  });

  test("exige o e-mail exato, envia version + confirm_text e o usuário sai da listagem", async ({ page }) => {
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    const confirm = dialog.getByRole("button", { name: "Excluir definitivamente" });
    const field = dialog.getByLabel("Para confirmar, digite o e-mail do usuário");

    // Nunca pré-selecionada: o botão começa desabilitado.
    await expect(confirm).toBeDisabled();
    await field.fill("usuario.sintetico@exemplo.invalido");
    await expect(confirm).toBeDisabled();
    await field.fill(COMMON_EMAIL);
    await expect(confirm).toBeEnabled();

    const request = waitApi(page, "POST", `/v1/users/${COMMON_USER_ID}/delete`);
    await confirm.click();
    expect((await request).postDataJSON()).toEqual({ version: 1, confirm_text: COMMON_EMAIL });

    await expect(dialog).toBeHidden();
    // O painel fecha (não há mais o que mostrar) e a linha desaparece da lista.
    await expect(sheet).toBeHidden();
    const table = page.getByRole("table", { name: "Usuários" });
    await expect(table.getByRole("row").filter({ hasText: COMMON_EMAIL })).toHaveCount(0);
    await expect(page.getByText(COMMON_EMAIL)).toHaveCount(0);
    expect(del.requests).toHaveLength(1);
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("duplo clique não envia duas exclusões (pending bloqueia)", async ({ page }) => {
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    del.delayMs = 700;
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
    const submit = dialog.locator('button[type="submit"]');
    await submit.click();
    // Enquanto a resposta não chega: botão desabilitado, form aria-busy e
    // qualquer reenvio (clique ou Enter) é ignorado pelo guard de `pending`.
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText("Excluindo…");
    await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "true");
    await submit.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    expect(del.requests).toHaveLength(1);
  });

  test("400 (confirm_text divergente), 409 (version) e 404 (fora do escopo) ficam humanos", async ({ page }) => {
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    del.outcomes = [
      { status: 400, code: "confirmation_mismatch" },
      { status: 404 },
      { status: 409, code: "version_conflict" },
    ];
    const sheet = await openAccountTab(page, COMMON_NAME);

    async function tryDelete() {
      await sheet.getByRole("button", { name: "Excluir usuário" }).click();
      const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
      await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
      await dialog.getByRole("button", { name: "Excluir definitivamente" }).click();
      return dialog;
    }

    // 400: o e-mail não bate para o backend — nada foi excluído.
    let dialog = await tryDelete();
    await expect(dialog.getByRole("alert")).toContainText("O e-mail digitado não confere");
    await expect(dialog.getByRole("alert")).toContainText("Nada foi excluído");
    await expect(page.getByText("texto cru do backend que a tela nunca mostra")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // 404: mesma resposta para inexistente e fora do escopo — aviso neutro.
    dialog = await tryDelete();
    await expect(dialog.getByRole("alert")).toContainText("Usuário não encontrado, ou fora do seu escopo");
    await page.keyboard.press("Escape");

    // 409: o diálogo fecha e o painel avisa que os dados foram recarregados.
    dialog = await tryDelete();
    await expect(dialog).toBeHidden();
    await expect(sheet).toContainText("Outra pessoa alterou este usuário");
    // A linha continua na lista: nenhuma das três tentativas excluiu nada.
    // (O painel é um diálogo: com ele aberto o resto do documento está
    // `aria-hidden`, então fechamos antes de consultar a tabela por papel.)
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("table", { name: "Usuários" })).toContainText(COMMON_EMAIL);
  });

  test("409 last_admin / self_change_forbidden e 503 rate_limit_unavailable têm texto próprio", async ({
    page,
  }) => {
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    del.outcomes = [
      { status: 409, code: "last_admin" },
      { status: 409, code: "self_change_forbidden" },
      { status: 503, code: "rate_limit_unavailable" },
    ];
    const sheet = await openAccountTab(page, COMMON_NAME);

    async function attempt() {
      await sheet.getByRole("button", { name: "Excluir usuário" }).click();
      const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
      await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
      await dialog.getByRole("button", { name: "Excluir definitivamente" }).click();
      return dialog;
    }

    let dialog = await attempt();
    await expect(dialog.getByRole("alert")).toContainText("último administrador (ADM) ativo");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    dialog = await attempt();
    await expect(dialog.getByRole("alert")).toContainText("Você não pode alterar o próprio perfil");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Rate limit indisponível: fail-closed, a tela diz que nada foi alterado.
    dialog = await attempt();
    await expect(dialog.getByRole("alert")).toContainText("controle de limite de requisições está indisponível");
    await expect(dialog.getByRole("alert")).toContainText("nada foi alterado");
    // Nenhum texto cru do backend em nenhuma das três respostas.
    await expect(page.getByText("texto cru do backend que a tela nunca mostra")).toHaveCount(0);
    expect(del.requests).toHaveLength(3);
  });

  test("400 de corpo recusado (campo extra) não é confundido com e-mail divergente", async ({ page }) => {
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    del.outcomes = [{ status: 400, code: "validation_error" }];
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
    await dialog.getByRole("button", { name: "Excluir definitivamente" }).click();
    await expect(dialog.getByRole("alert")).toContainText("não foi aceito pelo servidor");
    await expect(dialog.getByRole("alert")).not.toContainText("não confere");
    // O corpo enviado tem EXATAMENTE as duas chaves do contrato.
    expect(Object.keys(del.requests[0]!.body as object).sort()).toEqual(["confirm_text", "version"]);
  });

  test("403 REAUTH_REQUIRED pede o código do autenticador e repete a MESMA exclusão", async ({ page }) => {
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    del.outcomes = [{ status: 403, code: "REAUTH_REQUIRED" }, { status: 200 }];
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
    await dialog.getByRole("button", { name: "Excluir definitivamente" }).click();

    const reauth = page.getByRole("dialog", { name: "Confirme sua identidade" });
    await expect(reauth).toBeVisible();
    await expect(reauth).toContainText("antes de excluir definitivamente um usuário");
    await reauth.getByLabel("Código do autenticador").fill("123456");
    await reauth.getByRole("button", { name: "Confirmar código" }).click();

    await expect(reauth).toBeHidden();
    expect(del.requests).toHaveLength(2);
    // O segundo envio repete o MESMO corpo (o texto digitado não se perde).
    expect(del.requests[1]!.body).toEqual({ version: 1, confirm_text: COMMON_EMAIL });
    await expect(page.getByRole("table", { name: "Usuários" })).not.toContainText(COMMON_EMAIL);
  });

  test("nunca em massa e nunca na própria conta", async ({ page }) => {
    await openUsers(page);
    // A listagem não tem seleção múltipla nem ação em lote.
    const table = page.getByRole("table", { name: "Usuários" });
    await expect(table.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /excluir selecionados/i })).toHaveCount(0);

    const self = await openAccountTab(page, SELF_NAME);
    await expect(self.getByRole("button", { name: "Excluir usuário" })).toBeDisabled();
    await expect(self.getByRole("button", { name: "Revogar acesso" })).toBeDisabled();
    await expect(self).toContainText("Esta é a sua conta.");
  });

  test("usuário já anonimizado nunca mostra identificador — só o rótulo", async ({ page }) => {
    const state = await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    // Defesa em profundidade: o backend filtra `deleted_at IS NULL`, mas se uma
    // linha excluída chegar à tela, o identificador não pode aparecer.
    const target = state.users.find((u) => u.id === COMMON_USER_ID)!;
    target.name = "Usuário excluído";
    target.email = `excluido+${COMMON_USER_ID}@anonimizado.invalid`;
    target.active = false;
    Object.assign(target, { deleted_at: "2026-10-28T12:00:00Z", anonymized_at: "2026-10-28T12:00:00Z" });
    await page.goto(USERS_PATH);
    await waitForHydration(page);

    const table = page.getByRole("table", { name: "Usuários" });
    const row = table.getByRole("row").filter({ hasText: "Usuário excluído" });
    await expect(row).toContainText("Excluído");
    // Nem o e-mail original nem o endereço técnico da anonimização.
    await expect(page.getByText(COMMON_EMAIL)).toHaveCount(0);
    await expect(page.getByText("anonimizado.invalid")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Gerenciar Usuário excluído" })).toBeDisabled();
  });

  test("dado pessoal não vai para o console", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));
    const state = await openUsers(page);
    const del = await interceptDelete(page, state, COMMON_USER_ID);
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
    await dialog.getByRole("button", { name: "Excluir definitivamente" }).click();
    await expect(dialog).toBeHidden();
    expect(del.requests).toHaveLength(1);
    expect(logs.filter((line) => line.includes(COMMON_EMAIL) || line.includes("usuario.sintetico"))).toEqual([]);
  });
});

test.describe("usuários — revogação total do acesso", () => {
  test("o botão novo chama POST /revoke com o motivo e explica o efeito", async ({ page }) => {
    await openUsers(page);
    const requests = await interceptRevoke(page, COMMON_USER_ID);
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Revogar acesso" }).click();
    const dialog = page.getByRole("dialog", { name: REVOKE_DIALOG });
    await expect(dialog).toContainText("TODOS os vínculos de unidade");
    await expect(dialog).toContainText("isto NÃO exclui o usuário");
    await expect(dialog).toContainText("último administrador (ADM) ativo");
    await dialog.getByLabel("Motivo (opcional)").fill("Afastamento sintético.");
    await dialog.getByRole("button", { name: "Revogar acesso" }).click();

    await expect(dialog).toBeHidden();
    await expect(sheet.getByTestId("resultado-acao-conta")).toContainText("Acesso revogado");
    await expect(sheet.getByTestId("resultado-acao-conta")).toContainText("perfil e unidades removidos");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ reason: "Afastamento sintético." });
  });

  test("409 (própria conta / último ADM) mostra mensagem humana e nada muda", async ({ page }) => {
    await openUsers(page);
    await interceptRevoke(page, COMMON_USER_ID, 409);
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Revogar acesso" }).click();
    const dialog = page.getByRole("dialog", { name: REVOKE_DIALOG });
    await dialog.getByRole("button", { name: "Revogar acesso" }).click();
    await expect(dialog.getByRole("alert")).toContainText("último administrador (ADM) ativo");
    await expect(dialog.getByRole("alert")).toContainText("Nada foi alterado");
    await expect(page.getByText("texto cru")).toHaveCount(0);
  });

  test("sem motivo o corpo vai vazio (campo opcional)", async ({ page }) => {
    await openUsers(page);
    const requests = await interceptRevoke(page, COMMON_USER_ID);
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Revogar acesso" }).click();
    await page.getByRole("dialog", { name: REVOKE_DIALOG }).getByRole("button", { name: "Revogar acesso" }).click();
    await expect(sheet.getByTestId("resultado-acao-conta")).toBeVisible();
    expect(requests[0]!.body).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// Responsividade + axe (WCAG 2.2 AA) com o diálogo de exclusão aberto.
// -----------------------------------------------------------------------------

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const viewport of [
  { width: 320, height: 568 },
  { width: 768, height: 1024 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`exclusão ${viewport.width}px`, () => {
    test.use({ viewport });

    test("diálogo cabe na tela, sem rolagem horizontal, alvos >= 24px e sem violação axe", async ({
      page,
    }, testInfo) => {
      const state = await openUsers(page);
      await interceptDelete(page, state, COMMON_USER_ID);
      const sheet = await openAccountTab(page, COMMON_NAME);
      await sheet.getByRole("button", { name: "Excluir usuário" }).click();
      const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Para confirmar, digite o e-mail do usuário").fill(COMMON_EMAIL);
      await expect(dialog.getByRole("button", { name: "Excluir definitivamente" })).toBeEnabled();
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => {
          const iterations = a.effect?.getComputedTiming().iterations;
          return iterations === Infinity || a.playState !== "running";
        }),
      );

      const report = await collectLayoutReport(page);
      await testInfo.attach("layout-report", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      expect.soft(report.docScrollWidth, "rolagem horizontal do documento").toBeLessThanOrEqual(viewport.width);
      expect.soft(report.smallTargets, "alvos < 24px (WCAG 2.5.8)").toEqual([]);
      expect.soft(report.tinyText, "texto < 12px").toEqual([]);
      expect.soft(report.dialogIssues, "modal não cabe na tela").toEqual([]);

      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
      const violations = results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help }));
      await testInfo.attach("axe-violations", {
        body: JSON.stringify(violations, null, 2),
        contentType: "application/json",
      });
      expect(violations).toEqual([]);
    });

    test("foco preso no modal, Esc fecha e o foco volta ao botão de origem", async ({ page }) => {
      const state = await openUsers(page);
      await interceptDelete(page, state, COMMON_USER_ID);
      const sheet = await openAccountTab(page, COMMON_NAME);
      const trigger = sheet.getByRole("button", { name: "Excluir usuário" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
      await expect(dialog).toBeVisible();

      // Dez Tabs: o foco nunca escapa do diálogo.
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => {
          const active = document.activeElement;
          const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
          const top = dialogs[dialogs.length - 1];
          return !!active && !!top && top.contains(active);
        });
        expect(inside, `Tab ${i + 1} manteve o foco no modal`).toBe(true);
      }

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      // Fechar sem confirmar não exclui nada.
      expect(state.users.some((u) => u.id === COMMON_USER_ID)).toBe(true);
    });
  });
}

test.describe("exclusão — prefers-reduced-motion", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("com reduced motion o diálogo abre sem animação pendente", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await openUsers(page);
    await interceptDelete(page, state, COMMON_USER_ID);
    const sheet = await openAccountTab(page, COMMON_NAME);
    await sheet.getByRole("button", { name: "Excluir usuário" }).click();
    const dialog = page.getByRole("dialog", { name: DELETE_DIALOG });
    await expect(dialog).toBeVisible();
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((a) => {
          const iterations = a.effect?.getComputedTiming().iterations;
          return iterations !== Infinity && a.playState === "running";
        }).length,
    );
    expect(running).toBe(0);
  });
});
