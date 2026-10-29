import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { activationRedirectFor } from "../src/lib/activation-redirect";
import {
  AUTH_FAILURE_MESSAGES,
  classifyAuthError,
  MIN_PASSWORD_LENGTH,
} from "../src/app/(publico)/ativar-conta/activation-errors";
import { installMocks, seedSession, VALID_INVITE_TOKEN_HASH, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// /ativar-conta com ?token_hash=...&type=invite (anti-scanner de e-mail).
// A página NÃO consome o token ao carregar; só o clique em "Continuar" chama
// verifyOtp (POST /auth/v1/verify). Comando:
//   cd frontend && npx playwright test --project=e2e e2e/activate-invite-functional.spec.ts
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Mesmo padrão de users-functional.spec.ts:31-33: o `next dev` compila cada
// rota na 1ª visita; só a navegação para uma rota ainda não compilada (aqui
// /login, no fim da redefinição) usa este limite. Não é defeito de produto.
const FIRST_COMPILE_TIMEOUT = 45_000;
const GOOD = `/ativar-conta?token_hash=${VALID_INVITE_TOKEN_HASH}&type=invite`;

function verifyCalls(state: { calls: { method: string; url: string }[] }) {
  return state.calls.filter((c) => c.url.startsWith("/auth/v1/verify"));
}

async function axe(page: Page) {
  await waitForAnimations(page);
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return r.violations.map((v) => v.id);
}

test.describe("ativação por token_hash", () => {
  test("carregar não consome o token; URL é limpa; sem storage", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(GOOD);
    await waitForHydration(page);
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a ativação" })).toBeFocused();
    await page.waitForTimeout(500);
    expect(verifyCalls(state)).toEqual([]);
    expect(page.url()).not.toContain("token_hash");
    expect(new URL(page.url()).search).toBe("");
    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(stored).not.toContain(VALID_INVITE_TOKEN_HASH);
    expect(await axe(page)).toEqual([]);
  });

  test("Referrer-Policy no-referrer em /ativar-conta; demais rotas mantêm a padrão", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    const res = await page.goto(GOOD);
    expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res?.headers()["content-security-policy"]).toBeTruthy();
    const other = await page.request.get("/login");
    expect(other.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("clicar chama verifyOtp uma vez e segue para definir senha e ativar", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(GOOD);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).dblclick();
    await expect(page.getByLabel("Nova senha")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Defina sua senha" })).toBeFocused();
    const calls = verifyCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.stringify(state.calls.find((c) => c.url.startsWith("/auth/v1/verify"))?.body)).toContain(
      '"type":"invite"',
    );
    expect(await axe(page)).toEqual([]);

    await page.getByLabel("Nova senha").fill("senha-sintetica-123");
    await page.getByLabel("Confirmar senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Ativar conta" }).click();
    await expect(page.getByText(/Conta ativada com sucesso/)).toBeVisible();
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(true);
  });

  test("token expirado/usado: fase inválida sem detalhes do erro", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?token_hash=hash-expirado&type=invite");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Este link de convite já foi usado ou expirou.")).toBeVisible();
    await expect(page.getByText(/otp_expired|Email link/)).toHaveCount(0);
    expect(verifyCalls(state)).toHaveLength(1);
    expect(await axe(page)).toEqual([]);
  });

  test("formato inválido (type errado) vai direto a inválido, sem chamar verify", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?token_hash=abc&type=magiclink");
    await waitForHydration(page);
    // `type` desconhecido => modo neutro (F3): a tela não afirma que é convite.
    await expect(page.getByText("Este link é inválido ou já expirou.")).toBeVisible();
    expect(verifyCalls(state)).toEqual([]);
    expect(page.url()).not.toContain("token_hash");
  });

  test("#error=access_denied&error_code=otp_expired mostra a mensagem amigável", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta#error=access_denied&error_code=otp_expired&error_description=x");
    await waitForHydration(page);
    // Sem `type` no link o texto é neutro (F3); com `type=invite` ele fala de convite.
    await expect(page.getByText("Este link já foi usado ou expirou.")).toBeVisible();
    expect(page.url()).not.toContain("error");
  });

  test("#error=...&type=invite: mensagem de convite (texto por modo)", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta#error=access_denied&error_code=otp_expired&error_description=x&type=invite");
    await waitForHydration(page);
    await expect(page.getByText("Este link de convite já foi usado ou expirou.")).toBeVisible();
    expect(page.url()).not.toContain("error");
  });

  test("fluxo legado: #access_token continua levando a definir senha", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "u1", aud: "authenticated", exp: expires, role: "authenticated" }),
    ).toString("base64url");
    const jwt = `${header}.${payload}.sig`;
    await page.goto(
      `/ativar-conta#access_token=${jwt}&refresh_token=r&expires_in=3600&token_type=bearer&type=invite`,
    );
    await waitForHydration(page);
    await expect(page.getByLabel("Nova senha")).toBeVisible();
  });

  test("convite: o fluxo de convite chama activate-invite (e não é tratado como recuperação)", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(GOOD);
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1, name: "Ativar conta" })).toBeVisible();
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByLabel("Nova senha").fill("senha-sintetica-123");
    await page.getByLabel("Confirmar senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Ativar conta" }).click();
    await expect(page.getByText(/Conta ativada com sucesso/)).toBeVisible();
    expect(state.calls.filter((c) => c.url === "/api/v1/users/activate-invite")).toHaveLength(1);
    expect(state.calls.some((c) => c.url.startsWith("/auth/v1/logout"))).toBe(false);
  });

  for (const width of [320, 768, 1920]) {
    test(`confirmação sem overflow horizontal a ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await installMocks(page, { role: "USER" });
      await page.goto(GOOD);
      await waitForHydration(page);
      await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

// =============================================================================
// Recuperação de senha: o e-mail "Reset Password" também cai em /ativar-conta.
// Com `type=recovery` a página valida com verifyOtp({type:"recovery"}), troca a
// senha (PUT /auth/v1/user), NÃO chama activate-invite (usuário já ativo => 404),
// encerra a sessão local e leva ao /login.
// =============================================================================

const RECOVERY = `/ativar-conta?token_hash=${VALID_INVITE_TOKEN_HASH}&type=recovery`;

test.describe("recuperação de senha (type=recovery)", () => {
  test("carregar não consome o token; textos de redefinição; URL limpa", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1, name: "Redefinir senha" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a redefinição" })).toBeFocused();
    await page.waitForTimeout(500);
    expect(verifyCalls(state)).toEqual([]);
    expect(new URL(page.url()).search).toBe("");
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toContain(VALID_INVITE_TOKEN_HASH);
    expect(await axe(page)).toEqual([]);
  });

  test("verifyOtp(recovery) + nova senha: sucesso SEM activate-invite, sessão encerrada, vai ao login", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeFocused();
    expect(JSON.stringify(state.calls.find((c) => c.url.startsWith("/auth/v1/verify"))?.body)).toContain(
      '"type":"recovery"',
    );

    await page.getByLabel("Nova senha").fill("senha-sintetica-456");
    await page.getByLabel("Confirmar senha").fill("senha-sintetica-456");
    await page.getByRole("button", { name: "Redefinir senha" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Senha redefinida com sucesso" })).toBeVisible();
    expect(await axe(page)).toEqual([]);

    expect(state.calls.some((c) => c.method === "PUT" && c.url.startsWith("/auth/v1/user"))).toBe(true);
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
    expect(state.calls.some((c) => c.url.startsWith("/auth/v1/logout"))).toBe(true);
    await expect(page.getByText(/não é mais válido|Não foi possível/)).toHaveCount(0);
    // Redireciona sozinho para o login.
    await expect(page).toHaveURL(/\/login$/, { timeout: FIRST_COMPILE_TIMEOUT });
  });

  test("botão 'Ir para o login' leva ao login sem esperar", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByLabel("Nova senha").fill("senha-sintetica-456");
    await page.getByLabel("Confirmar senha").fill("senha-sintetica-456");
    await page.getByRole("button", { name: "Redefinir senha" }).click();
    await page.getByRole("link", { name: "Ir para o login" }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: FIRST_COMPILE_TIMEOUT });
  });

  test("link de recuperação expirado/usado: mensagem própria, sem detalhes do erro", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?token_hash=hash-expirado&type=recovery");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Este link de recuperação já foi usado ou expirou.", { exact: false })).toBeVisible();
    await expect(page.getByText(/otp_expired|Email link/)).toHaveCount(0);
    expect(verifyCalls(state)).toHaveLength(1);
    expect(await axe(page)).toEqual([]);
  });

  test("legado (#access_token...&type=recovery): redefine sem activate-invite", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "u1", aud: "authenticated", exp: expires, role: "authenticated" }),
    ).toString("base64url");
    await page.goto(
      `/ativar-conta#access_token=${header}.${payload}.sig&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery`,
    );
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();
    await page.getByLabel("Nova senha").fill("senha-sintetica-456");
    await page.getByLabel("Confirmar senha").fill("senha-sintetica-456");
    await page.getByRole("button", { name: "Redefinir senha" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
  });

  for (const width of [320, 1920]) {
    test(`recuperação sem overflow horizontal a ${width}px (confirmar e sucesso)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await installMocks(page, { role: "USER" });
      await page.goto(RECOVERY);
      await waitForHydration(page);
      const overflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: "Continuar" }).click();
      await page.getByLabel("Nova senha").fill("senha-sintetica-456");
      await page.getByLabel("Confirmar senha").fill("senha-sintetica-456");
      await page.getByRole("button", { name: "Redefinir senha" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  }
});


// =============================================================================
// Unitários puros (sem navegador): mapeador de erros e redirecionamento da raiz.
// =============================================================================

test.describe("unitário: mapeador de erros do Supabase Auth", () => {
  test("mensagens fixas por code/status; nunca a mensagem crua", () => {
    const cases: [unknown, keyof typeof AUTH_FAILURE_MESSAGES][] = [
      [{ code: "weak_password", status: 422, message: "Password should be at least 6" }, "weak_password"],
      [{ code: "same_password", status: 422 }, "same_password"],
      [{ code: "insufficient_aal", status: 401 }, "mfa_required"],
      // F4: cada causa tem destino próprio (antes tudo virava "expired").
      [{ code: "session_not_found", status: 403 }, "session_lost"],
      [{ name: "AuthSessionMissingError", status: 400 }, "session_lost"],
      [{ code: "otp_expired", status: 403 }, "expired"],
      [{ code: "access_denied", status: 403 }, "link_invalid"],
      [{ code: "bad_jwt", status: 401 }, "link_invalid"],
      // Anti-enumeração: `user_not_found` não pode ter mensagem própria.
      [{ code: "user_not_found", status: 400 }, "generic"],
      [{ status: 401 }, "session_lost"],
      [{ name: "AuthRetryableFetchError", status: 0 }, "network"],
      [{ code: "over_request_rate_limit", status: 429 }, "rate_limited"],
      [{ status: 400, message: "algo sem código" }, "generic"],
      // 5xx é falha de servidor/transporte (retentável), não "código desconhecido".
      [{ code: "codigo_desconhecido", status: 500 }, "network"],
      [{ code: "codigo_desconhecido", status: 400 }, "generic"],
      [new Error("boom"), "generic"],
      [null, "generic"],
      ["texto", "generic"],
    ];
    for (const [input, kind] of cases) {
      const failure = classifyAuthError(input);
      expect(failure.kind).toBe(kind);
      expect(failure.message).toBe(AUTH_FAILURE_MESSAGES[kind]);
      expect(failure.message).not.toMatch(/Password should|boom|algo sem código/);
    }
  });

  test("mínimo de senha local é 12 (constante única)", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(AUTH_FAILURE_MESSAGES.weak_password).toContain("12");
  });
});

test.describe("unitário: redirecionamento da raiz", () => {
  test("só token_hash+type válidos; destino fixo; resto descartado", () => {
    expect(activationRedirectFor("?token_hash=abc123&type=invite")).toBe("/ativar-conta?token_hash=abc123&type=invite");
    expect(activationRedirectFor("?type=recovery&token_hash=a.b_c-d~e%2Bf&next=https://evil.example")).toBe(
      "/ativar-conta?token_hash=a.b_c-d~e%2Bf&type=recovery",
    );
    expect(activationRedirectFor("?token_hash=abc&type=magiclink")).toBeNull();
    expect(activationRedirectFor("?token_hash=abc")).toBeNull();
    expect(activationRedirectFor("?type=invite")).toBeNull();
    expect(activationRedirectFor("?token_hash=ab%20c&type=invite")).toBeNull();
    expect(activationRedirectFor("?token_hash=https://evil.example&type=invite")).toBeNull();
    expect(activationRedirectFor(`?token_hash=${"a".repeat(513)}&type=invite`)).toBeNull();
    expect(activationRedirectFor("")).toBeNull();
  });
});

// =============================================================================
// Erros ao definir a senha, passo TOTP, link expirado, sessão preexistente.
// =============================================================================

const PASSWORD = "senha-sintetica-789";
const RECOVERY_URL = `/ativar-conta?token_hash=${VALID_INVITE_TOKEN_HASH}&type=recovery`;

async function fillAndSubmit(page: Page, button: string, password = PASSWORD) {
  await page.getByLabel("Nova senha").fill(password);
  await page.getByLabel("Confirmar senha").fill(password);
  await page.getByRole("button", { name: button }).click();
}

function putCalls(state: { calls: { method: string; url: string }[] }) {
  return state.calls.filter((c) => c.method === "PUT" && c.url.startsWith("/auth/v1/user"));
}

test.describe("erros ao definir a senha (mensagens fixas)", () => {
  test("senha curta: validação local de 12 caracteres, sem chamar o Supabase", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(GOOD);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByLabel("Nova senha").fill("curta-123");
    await page.getByLabel("Confirmar senha").fill("curta-123");
    // O navegador bloqueia por minLength; desliga a validação nativa para exercitar a do app.
    await page.locator("form").evaluate((f) => f.setAttribute("novalidate", ""));
    await page.getByRole("button", { name: "Ativar conta" }).click();
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("pelo menos 12 caracteres");
    expect(putCalls(state)).toHaveLength(0);
  });

  test("weak_password: mensagem fixa, sem texto cru; nova tentativa conclui", async ({ page }) => {
    const state = await installMocks(page, {
      role: "USER",
      userUpdateErrors: [{ status: 422, error_code: "weak_password", msg: "Password is known to be weak SENTINELA-CRUA" }],
    });
    await page.goto(GOOD);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Ativar conta");
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("não atende aos requisitos de segurança");
    await expect(page.getByText(/SENTINELA-CRUA|known to be weak/)).toHaveCount(0);
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
    expect(await axe(page)).toEqual([]);

    await page.getByLabel("Nova senha").fill("outra-senha-sintetica-1");
    await page.getByLabel("Confirmar senha").fill("outra-senha-sintetica-1");
    await page.getByRole("button", { name: "Ativar conta" }).click();
    await expect(page.getByText(/Conta ativada com sucesso/)).toBeVisible();
  });

  test("same_password: mensagem fixa em PT-BR", async ({ page }) => {
    await installMocks(page, {
      role: "USER",
      userUpdateErrors: [{ status: 422, error_code: "same_password", msg: "New password should be different" }],
    });
    await page.goto(RECOVERY_URL);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Redefinir senha");
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("diferente da senha atual");
    await expect(page.getByText(/should be different/)).toHaveCount(0);
  });

  test("erro sem código: mensagem genérica, sem texto cru", async ({ page }) => {
    await installMocks(page, { role: "USER", userUpdateErrors: [{ status: 400, msg: "detalhe-interno-vazado" }] });
    await page.goto(GOOD);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Ativar conta");
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("Não foi possível definir a senha agora");
    await expect(page.getByText(/detalhe-interno-vazado/)).toHaveCount(0);
  });

  test("sessão perdida (session_not_found): mensagem de sessão, nunca 'expirou' (F4)", async ({ page }) => {
    await installMocks(page, {
      role: "USER",
      userUpdateErrors: [{ status: 403, error_code: "session_not_found", msg: "x" }],
    });
    await page.goto(GOOD);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Ativar conta");
    await expect(page.getByText("A validação deste link não está mais ativa.")).toBeVisible();
    await expect(page.getByText("já foi usado ou expirou")).toHaveCount(0);
  });

  test("token, hash e senha nunca em console, DOM ou storage", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (m) => logs.push(m.text()));
    page.on("pageerror", (e) => logs.push(String(e)));
    await installMocks(page, {
      role: "USER",
      userUpdateErrors: [{ status: 422, error_code: "weak_password", msg: "weak" }],
    });
    await page.goto(GOOD);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Ativar conta");
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("requisitos de segurança");
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    // Texto visível (o valor digitado vive só no input, que o React espelha no atributo value).
    const dom = await page.evaluate(() => document.body.innerText);
    for (const secret of [PASSWORD, VALID_INVITE_TOKEN_HASH]) {
      expect(stored).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      expect(dom).not.toContain(secret);
    }
    expect(logs.join("\n")).toContain("weak_password");
    expect(new URL(page.url()).search).toBe("");
  });
});

test.describe("passo TOTP (insufficient_aal)", () => {
  test("recuperação: sessão aal1 com TOTP pede o código ANTES da senha; código errado não avança", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", hasVerifiedFactor: true, verifySessionHasFactor: true });
    await page.goto(RECOVERY_URL);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a verificação em duas etapas" })).toBeFocused();
    await expect(page.getByLabel("Nova senha")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);

    await page.getByLabel("Código de verificação").fill("000000");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("Código inválido ou expirado");
    await expect(page.getByLabel("Nova senha")).toHaveCount(0);

    await page.getByLabel("Código de verificação").fill("123456");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();
    expect(putCalls(state)).toHaveLength(0);

    await fillAndSubmit(page, "Redefinir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toContain("123456");
  });

  test("insufficient_aal no envio: pede o TOTP e repete a troca de senha em seguida", async ({ page }) => {
    const state = await installMocks(page, {
      role: "USER",
      hasVerifiedFactor: true,
      userUpdateErrors: [{ status: 401, error_code: "insufficient_aal", msg: "AAL2 session is required" }],
    });
    await page.goto(RECOVERY_URL);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Redefinir senha");
    await expect(page.getByLabel("Código de verificação")).toBeVisible();
    await expect(page.getByText(/AAL2 session is required/)).toHaveCount(0);

    await page.getByLabel("Código de verificação").fill("123456");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(putCalls(state)).toHaveLength(2);
  });

  test("sem fator TOTP disponível: insufficient_aal mostra mensagem genérica", async ({ page }) => {
    await installMocks(page, {
      role: "USER",
      hasVerifiedFactor: false,
      userUpdateErrors: [{ status: 401, error_code: "insufficient_aal", msg: "x" }],
    });
    await page.goto(RECOVERY_URL);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await fillAndSubmit(page, "Redefinir senha");
    await expect(page.locator("#ativar-erro, #ativar-mfa-erro")).toContainText("Não foi possível definir a senha agora");
  });
});

test.describe("link expirado e entradas inesperadas", () => {
  test("#error_code=otp_expired (sem 'error'): link já usado ou expirado", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta#error_code=otp_expired");
    await waitForHydration(page);
    await expect(page.getByText("já foi usado ou expirou", { exact: false })).toBeVisible();
    expect(page.url()).not.toContain("otp_expired");
  });

  test("type desconhecido: inválido, sem chamar verify", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(`/ativar-conta?token_hash=${VALID_INVITE_TOKEN_HASH}&type=signup`);
    await waitForHydration(page);
    await expect(page.getByText("é inválido ou já expirou", { exact: false })).toBeVisible();
    expect(verifyCalls(state)).toEqual([]);
    expect(page.url()).not.toContain("token_hash");
  });

  test("sessão preexistente (outra pessoa) NÃO é aceita sem credencial no link", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER", aal: "aal2", hasVerifiedFactor: false });
    await page.goto("/ativar-conta");
    await waitForHydration(page);
    await expect(page.getByText("Este link é inválido ou já expirou.")).toBeVisible();
    await expect(page.getByLabel("Nova senha")).toHaveCount(0);
    expect(putCalls(state)).toHaveLength(0);
  });
});

test.describe("raiz repassa token_hash para /ativar-conta", () => {
  test("/?token_hash&type=invite sem sessão cai em /ativar-conta e NÃO consome o token", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(`/?token_hash=${VALID_INVITE_TOKEN_HASH}&type=invite`);
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
    await expect(page).toHaveURL(/\/ativar-conta$/);
    expect(verifyCalls(state)).toEqual([]);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByLabel("Nova senha")).toBeVisible();
  });

  test("type=recovery repassa só os dois parâmetros (descarta next=)", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto(`/?token_hash=${VALID_INVITE_TOKEN_HASH}&type=recovery&next=https://evil.example`);
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a redefinição" })).toBeVisible();
    expect(page.url()).not.toContain("evil");
    expect(new URL(page.url()).pathname).toBe("/ativar-conta");
  });

  test("type inválido na raiz: segue o comportamento normal (login)", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto(`/?token_hash=${VALID_INVITE_TOKEN_HASH}&type=magiclink`);
    await expect(page).toHaveURL(/\/login$/);
  });
});
