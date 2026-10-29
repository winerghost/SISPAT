import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { activationRedirectFor } from "../src/lib/activation-redirect";
import { parseActivationLink, serializeLegacyHash } from "../src/lib/activation-link";
import {
  AUTH_FAILURE_MESSAGES,
  classifyAuthError,
} from "../src/app/(publico)/ativar-conta/activation-errors";
import {
  installMocks,
  seedSession,
  VALID_INVITE_TOKEN_HASH,
  VALID_PKCE_CODE,
  waitForHydration,
  type MockState,
} from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Regressão das correções F1–F6 do link público de ativação/redefinição.
// =============================================================================
// F1 erro na QUERY STRING (antes só o hash era lido; `error_description` ficava
//    na URL e no histórico)
// F2 link PKCE `?code=` (antes um link VÁLIDO aparecia como inválido)
// F3 sem `type` na URL o modo caía para "convite" silenciosamente
// F4 `otp_expired`, `access_denied`/`bad_jwt`, `over_request_rate_limit` e o
//    resto deixam de ter a MESMA mensagem "expirou" — sem mensagem própria para
//    `user_not_found` (seria oráculo de enumeração de usuários)
// F5 falha de REDE não descarta mais a credencial de uso único
// F6 link legado de recuperação caindo na raiz não loga mais a pessoa no sistema
//
// Invariante que NÃO pode quebrar (correção do incidente de 2026-10-27): carregar
// a página — o que um scanner de antivírus de e-mail faz — não consome o link;
// só o clique da pessoa chama `/auth/v1/verify` ou `/token?grant_type=pkce`.
//
// Comando:
//   cd frontend && npx playwright test --project=e2e e2e/password-recovery-link-functional.spec.ts
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** `next dev` compila cada rota na 1ª visita (padrão de users-functional.spec.ts:31). */
const FIRST_COMPILE_TIMEOUT = 45_000;

const RECOVERY = `/ativar-conta?token_hash=${VALID_INVITE_TOKEN_HASH}&type=recovery`;
const CODE_RECOVERY = `/ativar-conta?code=${VALID_PKCE_CODE}&type=recovery`;
const PASSWORD = "senha-sintetica-recuperada";

function verifyCalls(state: MockState) {
  return state.calls.filter((c) => c.url.startsWith("/auth/v1/verify"));
}

function pkceCalls(state: MockState) {
  return state.calls.filter((c) => c.url.startsWith("/auth/v1/token?grant_type=pkce"));
}

async function axe(page: Page) {
  await waitForAnimations(page);
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return r.violations.map((v) => v.id);
}

async function setPassword(page: Page, button: string) {
  await page.getByLabel("Nova senha").fill(PASSWORD);
  await page.getByLabel("Confirmar senha").fill(PASSWORD);
  await page.getByRole("button", { name: button }).click();
}

/** Sessão implícita sintética no hash (fluxo legado do Supabase). */
function legacyHash(type: "invite" | "recovery"): string {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "u1", aud: "authenticated", exp: expires, role: "authenticated" }),
  ).toString("base64url");
  return `#access_token=${header}.${payload}.sig&refresh_token=r&expires_in=3600&token_type=bearer&type=${type}`;
}

// ---------------------------------------------------------------------------
// F1 + F3 + F4 — erro do provedor na query string
// ---------------------------------------------------------------------------

test.describe("F1: erro na query string", () => {
  test("type=recovery: texto de recuperação, URL e histórico limpos, sem consumir nada", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(
      "/ativar-conta?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&type=recovery",
    );
    await waitForHydration(page);

    await expect(page.getByRole("heading", { level: 1, name: "Redefinir senha" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Link de recuperação inválido" })).toBeFocused();
    await expect(page.getByText("Este link de recuperação já foi usado ou expirou.")).toBeVisible();
    // Nunca o texto de convite (era o defeito) nem a mensagem crua do provedor.
    // (o rodapé do layout público fala de convite: a asserção é só no cartão)
    await expect(page.locator("main").getByText(/convite/i)).toHaveCount(0);
    await expect(page.getByText(/Email link is invalid|otp_expired/)).toHaveCount(0);

    // F1: `history.replaceState` roda também para erro na query.
    const url = new URL(page.url());
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(page.url()).not.toContain("error");
    // A entrada do histórico foi SUBSTITUÍDA: voltar não traz o link de volta.
    const entry = await page.evaluate(() => window.location.href);
    expect(entry).not.toContain("error_description");

    expect(verifyCalls(state)).toEqual([]);
    expect(pkceCalls(state)).toEqual([]);
    expect(await axe(page)).toEqual([]);
  });

  test("F3: erro sem `type` usa texto NEUTRO (nunca 'convite')", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?error=access_denied&error_code=otp_expired&error_description=x");
    await waitForHydration(page);

    await expect(page.getByRole("heading", { level: 1, name: "Acesso por link" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Link inválido" })).toBeVisible();
    await expect(page.getByText("Este link já foi usado ou expirou.")).toBeVisible();
    await expect(page.locator("main").getByText(/convite|recuperação/i)).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
  });

  test("erro no hash continua funcionando (compatibilidade)", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta#error=access_denied&error_code=otp_expired&error_description=x&type=recovery");
    await waitForHydration(page);
    await expect(page.getByText("Este link de recuperação já foi usado ou expirou.")).toBeVisible();
    expect(page.url()).not.toContain("error");
  });
});

// ---------------------------------------------------------------------------
// F3 — `type` da QUERY STRING decide o modo (hoje os DOIS fluxos chegam assim:
// o convite passou a ser montado pelo backend, como a recuperação)
// ---------------------------------------------------------------------------

test.describe("F3: modo pelo `type` da query string", () => {
  test("type=invite: 'Ativar conta', verifyOtp({type:'invite'}) e activate-invite", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", singleUseLink: true });
    await page.goto(`/ativar-conta?token_hash=${VALID_INVITE_TOKEN_HASH}&type=invite`);
    await waitForHydration(page);

    await expect(page.getByRole("heading", { level: 1, name: "Ativar conta" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a ativação" })).toBeFocused();
    await expect(page.getByRole("list", { name: "Etapas da ativação" })).toBeVisible();
    expect(verifyCalls(state)).toEqual([]);

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina sua senha" })).toBeFocused();
    expect(verifyCalls(state)).toHaveLength(1);
    expect(JSON.stringify(verifyCalls(state)[0]?.body)).toContain('"type":"invite"');

    await setPassword(page, "Ativar conta");
    await expect(page.getByText(/Conta ativada com sucesso/)).toBeVisible();
    expect(state.calls.filter((c) => c.url === "/api/v1/users/activate-invite")).toHaveLength(1);
    expect(state.calls.some((c) => c.url.startsWith("/auth/v1/logout"))).toBe(false);
    expect(await axe(page)).toEqual([]);
  });

  test("type=recovery: 'Redefinir senha', verifyOtp({type:'recovery'}) e SEM activate-invite", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", singleUseLink: true });
    await page.goto(RECOVERY);
    await waitForHydration(page);

    await expect(page.getByRole("heading", { level: 1, name: "Redefinir senha" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a redefinição" })).toBeFocused();
    await expect(page.getByRole("list", { name: "Etapas da redefinição de senha" })).toBeVisible();
    expect(verifyCalls(state)).toEqual([]);

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeFocused();
    expect(JSON.stringify(verifyCalls(state)[0]?.body)).toContain('"type":"recovery"');

    await setPassword(page, "Redefinir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
    expect(state.calls.some((c) => c.url.startsWith("/auth/v1/logout"))).toBe(true);
    expect(await axe(page)).toEqual([]);
  });

  test("erro na query com type=invite: texto de CONVITE (nunca de recuperação)", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?error=access_denied&error_code=otp_expired&error_description=x&type=invite");
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1, name: "Ativar conta" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Link de convite inválido" })).toBeVisible();
    await expect(page.getByText("Este link de convite já foi usado ou expirou.")).toBeVisible();
    await expect(page.locator("main").getByText(/recupera/i)).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
  });
});

// ---------------------------------------------------------------------------
// F4 — mensagens distintas por causa (com a restrição anti-enumeração)
// ---------------------------------------------------------------------------

test.describe("F4: mensagem por causa", () => {
  const EXPIRED = "Este link de recuperação já foi usado ou expirou.";
  const INVALID = "Este link de recuperação é inválido ou já expirou.";
  const RATE = "Houve muitas tentativas com este link. Aguarde alguns minutos e abra o link do e-mail novamente.";

  for (const [code, expected] of [
    ["otp_expired", EXPIRED],
    ["access_denied", INVALID],
    ["bad_jwt", INVALID],
    ["over_request_rate_limit", RATE],
    // Restrição de segurança: `user_not_found` NÃO pode ter texto próprio.
    ["user_not_found", INVALID],
  ] as const) {
    test(`error_code=${code}`, async ({ page }) => {
      await installMocks(page, { role: "USER" });
      await page.goto(`/ativar-conta?error=access_denied&error_code=${code}&type=recovery`);
      await waitForHydration(page);
      await expect(page.getByText(expected, { exact: false })).toBeVisible();
      if (expected !== EXPIRED) await expect(page.getByText(EXPIRED)).toHaveCount(0);
      if (expected !== RATE) await expect(page.getByText(RATE)).toHaveCount(0);
    });
  }

  test("unitário: classificação separa as três causas do link e nada mais", () => {
    const kinds = (error: unknown) => classifyAuthError(error).kind;
    expect(kinds({ code: "otp_expired", status: 403 })).toBe("expired");
    expect(kinds({ code: "access_denied", status: 403 })).toBe("link_invalid");
    expect(kinds({ code: "bad_jwt", status: 401 })).toBe("link_invalid");
    expect(kinds({ code: "over_request_rate_limit", status: 429 })).toBe("rate_limited");
    expect(kinds({ status: 429 })).toBe("rate_limited");
    // Sessão perdida e 401 sem código NÃO são mais "expirou" (era o F4).
    expect(kinds({ code: "session_not_found", status: 403 })).toBe("session_lost");
    expect(kinds({ code: "refresh_token_already_used", status: 400 })).toBe("session_lost");
    expect(kinds({ name: "AuthSessionMissingError", status: 400 })).toBe("session_lost");
    expect(kinds({ status: 401 })).toBe("session_lost");
    // Falha de transporte (F5) e 5xx.
    expect(kinds({ name: "AuthRetryableFetchError", status: 0 })).toBe("network");
    expect(kinds({ status: 503 })).toBe("network");
    // Anti-enumeração: nada sobre a existência da conta.
    for (const code of ["user_not_found", "email_not_confirmed", "user_banned", "email_exists"]) {
      expect(kinds({ code, status: 400 })).toBe("generic");
      expect(classifyAuthError({ code, status: 400 }).message).toBe(AUTH_FAILURE_MESSAGES.generic);
    }
    // As mensagens das três causas do link são realmente diferentes entre si.
    const distinct = new Set([
      AUTH_FAILURE_MESSAGES.expired,
      AUTH_FAILURE_MESSAGES.link_invalid,
      AUTH_FAILURE_MESSAGES.rate_limited,
    ]);
    expect(distinct.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// F2 — link PKCE `?code=`
// ---------------------------------------------------------------------------

test.describe("F2: link PKCE (?code=)", () => {
  test("carregar não consome; duplo clique troca o código UMA vez e redefine a senha", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", singleUseLink: true });
    await page.goto(CODE_RECOVERY);
    await waitForHydration(page);

    // Antes da correção esta tela dizia "link inválido".
    await expect(page.getByRole("heading", { level: 1, name: "Redefinir senha" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(pkceCalls(state)).toEqual([]);
    expect(new URL(page.url()).search).toBe("");
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toContain(VALID_PKCE_CODE);
    expect(await axe(page)).toEqual([]);

    await page.getByRole("button", { name: "Continuar" }).dblclick();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeFocused();
    expect(pkceCalls(state)).toHaveLength(1);
    expect(JSON.stringify(pkceCalls(state)[0]?.body)).toContain(VALID_PKCE_CODE);

    await setPassword(page, "Redefinir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
  });

  test("código inválido: link inválido (não 'expirou') e sem nova tentativa", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?code=code-invalido-e2e&type=recovery");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Este link de recuperação é inválido ou já expirou.")).toBeVisible();
    expect(pkceCalls(state)).toHaveLength(1);
    expect(await axe(page)).toEqual([]);
  });

  test("F3: `?code=` sem `type` fica em modo neutro e conclui sem erro falso", async ({ page }) => {
    // Sem `type` não há como saber se era convite: o backend responde 404 em
    // activate-invite e a tela trata como senha definida, sem erro inventado.
    const state = await installMocks(page, { role: "USER", activateInviteStatus: 404 });
    await page.goto(`/ativar-conta?code=${VALID_PKCE_CODE}`);
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1, name: "Acesso por link" })).toBeVisible();
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina sua senha" })).toBeFocused();
    await setPassword(page, "Definir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha definida" })).toBeVisible();
    await expect(page.getByText(/não é mais válido|Não foi possível/)).toHaveCount(0);
    expect(state.calls.some((c) => c.url.startsWith("/auth/v1/logout"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Uso único, scanner e duplo clique (invariante do incidente)
// ---------------------------------------------------------------------------

test.describe("uso único do link", () => {
  test("1ª tentativa dá certo; a 2ª com o mesmo token diz que já foi usado", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", singleUseLink: true });
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();

    // Mesma pessoa reabrindo o link do e-mail (ou apertando "voltar").
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Este link de recuperação já foi usado ou expirou.")).toBeVisible();
    await expect(page.getByText(/otp_expired|Email link/)).toHaveCount(0);
    expect(verifyCalls(state)).toHaveLength(2);
  });

  test("GET de scanner NÃO consome o token: depois dele o clique ainda funciona", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", singleUseLink: true });

    // 1) GET cru, sem JavaScript (é o que o antivírus de e-mail faz).
    const raw = await page.request.get(RECOVERY);
    expect(raw.status()).toBe(200);
    // 2) Carregar a página de verdade e NÃO clicar.
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.waitForTimeout(700);
    expect(verifyCalls(state)).toEqual([]);

    // 3) O link continua valendo para a pessoa.
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();
    expect(verifyCalls(state)).toHaveLength(1);
  });

  test("duplo clique gera UMA única chamada a /auth/v1/verify", async ({ page }) => {
    const state = await installMocks(page, { role: "USER", singleUseLink: true });
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).dblclick();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();
    await page.waitForTimeout(300);
    expect(verifyCalls(state)).toHaveLength(1);
    expect(JSON.stringify(verifyCalls(state)[0]?.body)).toContain('"type":"recovery"');
  });
});

// ---------------------------------------------------------------------------
// F5 — falha de rede preserva a credencial
// ---------------------------------------------------------------------------

test.describe("F5: falha de rede não descarta o link", () => {
  test("rede cai no 1º clique: mensagem de tentar de novo e o 2º clique conclui", async ({ page }) => {
    const state = await installMocks(page, {
      role: "USER",
      singleUseLink: true,
      verifyNetworkFailures: 1,
    });
    await page.goto(RECOVERY);
    await waitForHydration(page);

    await page.getByRole("button", { name: "Continuar" }).click();
    const alert = page.locator("#ativar-erro[role=alert]");
    await expect(alert).toContainText("o link continua válido");
    // Continua na fase de confirmação (antes virava "link expirado").
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a redefinição" })).toBeVisible();
    await expect(page.getByText("já foi usado ou expirou")).toHaveCount(0);
    expect(verifyCalls(state)).toHaveLength(1);
    expect(await axe(page)).toEqual([]);

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();
    expect(verifyCalls(state)).toHaveLength(2);
    await setPassword(page, "Redefinir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// F6 — link legado de recuperação caindo na raiz
// ---------------------------------------------------------------------------

test.describe("F6: recuperação na raiz nunca libera o sistema", () => {
  test("/#access_token=...&type=recovery vai para a senha, sem entrar no app", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(`/${legacyHash("recovery")}`);

    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });
    expect(new URL(page.url()).pathname).toBe("/ativar-conta");
    // Nada do shell autenticado: sem menu lateral e sem a home.
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toHaveCount(0);
    expect(state.calls.some((c) => c.url.startsWith("/api/v1/dashboard"))).toBe(false);
    // O access_token não fica na URL nem no histórico.
    expect(page.url()).not.toContain("access_token");

    await setPassword(page, "Redefinir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(state.calls.some((c) => c.url === "/api/v1/users/activate-invite")).toBe(false);
    expect(state.calls.some((c) => c.url.startsWith("/auth/v1/logout"))).toBe(true);
  });

  test("/?token_hash=..&type=recovery na raiz: confirmação, sem consumir o token", async ({ page }) => {
    const state = await installMocks(page, { role: "USER" });
    await page.goto(`/?token_hash=${VALID_INVITE_TOKEN_HASH}&type=recovery`);
    await expect(page.getByRole("heading", { level: 2, name: "Confirme a redefinição" })).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });
    expect(verifyCalls(state)).toEqual([]);
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("sessão normal (login) continua entrando no app", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });
  });
});

// ---------------------------------------------------------------------------
// Unitários puros da leitura do link e do desvio da raiz
// ---------------------------------------------------------------------------

test.describe("unitário: leitura do link", () => {
  test("query e hash, com precedência da query e modo neutro sem `type`", () => {
    expect(parseActivationLink("?token_hash=abc&type=recovery", "")).toEqual({
      kind: "token",
      tokenHash: "abc",
      mode: "recovery",
    });
    // Erro vence qualquer credencial e vem tanto da query quanto do hash (F1).
    expect(parseActivationLink("?error=access_denied&error_code=otp_expired&type=recovery", "")).toEqual({
      kind: "error",
      failure: "expired",
      mode: "recovery",
      source: "provider",
      code: "otp_expired",
    });
    expect(parseActivationLink("", "#error_code=over_request_rate_limit")).toEqual({
      kind: "error",
      failure: "rate_limited",
      mode: "unknown",
      source: "provider",
      code: "over_request_rate_limit",
    });
    // F3: sem `type` o modo é "unknown" (nunca "invite").
    expect(parseActivationLink("?code=abc", "")).toEqual({ kind: "code", code: "abc", mode: "unknown" });
    expect(parseActivationLink("?token_hash=abc", "")?.kind).toBe("error");
    expect(parseActivationLink("?token_hash=abc", "")?.mode).toBe("unknown");
    // Formato inaceitável nunca segue adiante.
    expect(parseActivationLink("?code=ab%20c", "")).toMatchObject({ kind: "error", source: "link" });
    expect(parseActivationLink(`?code=${"a".repeat(513)}`, "")).toMatchObject({ kind: "error", source: "link" });
    // Nada de ativação na URL.
    expect(parseActivationLink("", "")).toBeNull();
    expect(parseActivationLink("?page=2", "")).toBeNull();
  });

  test("hash legado é reserializado por allowlist (descarta o resto)", () => {
    const hash = `${legacyHash("recovery")}&next=https://evil.example&provider_token=x`;
    const serialized = serializeLegacyHash(hash);
    expect(serialized).toContain("access_token=");
    expect(serialized).toContain("type=recovery");
    expect(serialized).not.toContain("evil");
    expect(serialized).not.toContain("provider_token");
    expect(serializeLegacyHash("#type=recovery")).toBe("");
    expect(serializeLegacyHash("")).toBe("");
  });

  test("desvio da raiz: destino fixo, só parâmetros da allowlist", () => {
    expect(activationRedirectFor("?token_hash=abc123&type=invite")).toBe(
      "/ativar-conta?token_hash=abc123&type=invite",
    );
    expect(activationRedirectFor(`?code=${VALID_PKCE_CODE}`)).toBe(`/ativar-conta?code=${VALID_PKCE_CODE}`);
    expect(activationRedirectFor("?code=abc&type=recovery&next=https://evil.example")).toBe(
      "/ativar-conta?code=abc&type=recovery",
    );
    expect(activationRedirectFor("?error=access_denied&error_code=otp_expired&error_description=x&type=recovery")).toBe(
      "/ativar-conta?error_code=otp_expired&type=recovery",
    );
    expect(activationRedirectFor("", legacyHash("recovery"))).toContain("/ativar-conta#access_token=");
    // Link malformado não desvia (segue o comportamento normal da raiz).
    expect(activationRedirectFor("?token_hash=abc&type=magiclink")).toBeNull();
    expect(activationRedirectFor("?type=recovery")).toBeNull();
    expect(activationRedirectFor("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Responsivo (320/768/1920) e prefers-reduced-motion
// ---------------------------------------------------------------------------

for (const width of [320, 768, 1920]) {
  test(`erro na query string sem rolagem horizontal e sem violação axe a ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await installMocks(page, { role: "USER" });
    await page.goto("/ativar-conta?error=access_denied&error_code=otp_expired&type=recovery");
    await waitForHydration(page);
    await expect(page.getByText("Este link de recuperação já foi usado ou expirou.")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });

  test(`confirmação do link PKCE sem rolagem horizontal a ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await installMocks(page, { role: "USER" });
    await page.goto(CODE_RECOVERY);
    await waitForHydration(page);
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });
}

test.describe("prefers-reduced-motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("alerta de rede entra sem deslocamento e o fluxo conclui", async ({ page }) => {
    await installMocks(page, { role: "USER", verifyNetworkFailures: 1 });
    await page.goto(RECOVERY);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Continuar" }).click();

    const alert = page.locator("#ativar-erro[role=alert]");
    await expect(alert).toBeVisible();
    const style = await alert.evaluate((el) => {
      const cs = getComputedStyle(el.parentElement ?? el);
      return { transform: cs.transform, opacity: cs.opacity };
    });
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(style.transform);
    expect(style.opacity).toBe("1");

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Defina a nova senha" })).toBeVisible();
    await setPassword(page, "Redefinir senha");
    await expect(page.getByRole("heading", { level: 2, name: "Senha redefinida" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
