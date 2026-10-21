import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, VALID_INVITE_TOKEN_HASH, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// /ativar-conta com ?token_hash=...&type=invite (anti-scanner de e-mail).
// A página NÃO consome o token ao carregar; só o clique em "Continuar" chama
// verifyOtp (POST /auth/v1/verify). Comando:
//   cd frontend && npx playwright test --project=e2e e2e/activate-invite-functional.spec.ts
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
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
    await expect(page.getByText("Este link de convite é inválido ou já expirou.")).toBeVisible();
    await expect(page.getByText(/otp_expired|Email link/)).toHaveCount(0);
    expect(verifyCalls(state)).toHaveLength(1);
    expect(await axe(page)).toEqual([]);
  });

  test("formato inválido (type errado) vai direto a inválido, sem chamar verify", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?token_hash=abc&type=magiclink");
    await waitForHydration(page);
    await expect(page.getByText("Este link de convite é inválido")).toBeVisible();
    expect(verifyCalls(state)).toEqual([]);
    expect(page.url()).not.toContain("token_hash");
  });

  test("#error=access_denied&error_code=otp_expired mostra a mensagem amigável", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta#error=access_denied&error_code=otp_expired&error_description=x");
    await waitForHydration(page);
    await expect(page.getByText("Este link de convite é inválido ou já expirou.")).toBeVisible();
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
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
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
    await expect(page).toHaveURL(/\/login$/);
  });

  test("link de recuperação expirado/usado: mensagem própria, sem detalhes do erro", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?token_hash=hash-expirado&type=recovery");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Este link de recuperação é inválido ou já expirou.", { exact: false })).toBeVisible();
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
