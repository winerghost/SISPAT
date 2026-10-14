import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, SUPABASE_URL, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Login / autenticação — animações sem perder acessibilidade.
// =============================================================================
// 1) Erro de credenciais entra animado (opacity < 1 ao montar) e mantém
//    role="alert" + aria-describedby nos campos.
// 2) `<Button loading>` durante o submit (aria-busy, desabilitado, rótulo).
// 3) Troca senha → MFA com fade e foco no campo do código; "Voltar" devolve o
//    foco ao e-mail; feedback "Acesso confirmado" após a verificação real.
// 4) Reduced motion: erro aparece sem deslocamento.
// 5) Sem erros de console; axe limpo após as animações.
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axeViolations(page: Page) {
  await waitForAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** Registra a opacidade do wrapper de cada role=alert/status no instante em que é inserido. */
async function recordInsertions(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __inserted: { role: string; text: string; opacity: number; transform: string }[] };
    w.__inserted = [];
    new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const target = node.matches("[role=alert],[role=status]")
            ? node
            : node.querySelector<HTMLElement>("[role=alert],[role=status]");
          if (!target) return;
          const cs = getComputedStyle(node);
          w.__inserted.push({
            role: target.getAttribute("role") ?? "",
            text: target.textContent?.trim() ?? "",
            opacity: parseFloat(cs.opacity),
            transform: cs.transform,
          });
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function inserted(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __inserted: { role: string; text: string; opacity: number; transform: string }[] })
        .__inserted,
  );
}

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Respostas 4xx/5xx simuladas pelos mocks (ex.: 400 de credenciais) geram
    // "Failed to load resource" — esperado, não é erro de runtime.
    if (/Failed to load resource/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function gotoLogin(page: Page, opts: Parameters<typeof installMocks>[1] = {}) {
  const state = await installMocks(page, opts);
  await page.goto("/login");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
  return state;
}

test("erro de credenciais: entrada animada, role=alert e associado aos campos", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoLogin(page);
  await recordInsertions(page);
  await page.getByLabel("E-mail").fill("invalido@exemplo.invalid");
  await page.getByLabel("Senha").fill("x");
  await page.getByRole("button", { name: "Entrar" }).click();

  const alert = page.getByRole("alert").filter({ hasText: "E-mail ou senha incorretos." });
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("id", "login-error");
  await expect(page.getByLabel("E-mail")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Senha")).toHaveAccessibleDescription("E-mail ou senha incorretos.");

  const rec = (await inserted(page)).find((r) => r.role === "alert");
  expect(rec, "alerta registrado na inserção").toBeTruthy();
  expect(rec!.opacity, "erro entra com fade (opacidade inicial < 1)").toBeLessThan(1);

  await waitForAnimations(page);
  const final = await alert.evaluate((el) => getComputedStyle(el.parentElement!).opacity);
  expect(final).toBe("1");
  expect(await axeViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("submit: botão em loading (aria-busy, desabilitado) enquanto o Supabase responde", async ({ page }) => {
  await gotoLogin(page);
  // Atrasa só o token (registrado depois de installMocks → tem precedência).
  await page.route(`${SUPABASE_URL}/auth/v1/token**`, async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fallback();
  });
  await page.getByLabel("E-mail").fill("invalido@exemplo.invalid");
  await page.getByLabel("Senha").fill("x");
  await page.getByRole("button", { name: "Entrar" }).click();

  const busy = page.getByRole("button", { name: "Entrando…" });
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(busy).toBeDisabled();
  await expect(busy.locator("svg.animate-spin-slow")).toHaveCount(1);
  await expect(page.locator("#login-error[role=alert]")).toHaveText("E-mail ou senha incorretos.");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Entrar" })).not.toHaveAttribute("aria-busy", "true");
});

test("senha → MFA: troca com fade, foco no código, Voltar devolve foco e sucesso confirma", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoLogin(page, { role: "ADM", aal: "aal1" });
  await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
  await page.getByLabel("Senha").fill("senha-sintetica-123");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Verificação em duas etapas" })).toBeVisible();
  const codigo = page.getByLabel("Código de verificação");
  await expect(codigo).toBeFocused();
  await waitForAnimations(page);
  expect(await axeViolations(page)).toEqual([]);

  // Voltar: descarta a etapa e devolve o foco ao e-mail (não cai no <body>).
  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
  await expect(page.getByLabel("E-mail")).toBeFocused();

  // De novo até o MFA; código errado → alerta; certo → status + redirect.
  await page.getByLabel("Senha").fill("senha-sintetica-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(codigo).toBeFocused();
  await codigo.fill("000000");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.locator("#login-error[role=alert]")).toHaveText("Código inválido ou expirado. Tente novamente.");
  await expect(codigo).toHaveAttribute("aria-describedby", "login-error");

  await recordInsertions(page);
  await codigo.fill("123456");
  await page.getByRole("button", { name: "Verificar" }).click();
  // `next dev` compila "/" sob demanda: sob carga a navegação pode passar de 15s.
  await expect(page).toHaveURL(/\/$/, { timeout: 45_000 });
  await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
  const statuses = (await inserted(page)).filter((r) => r.role === "status").map((r) => r.text);
  expect(statuses).toContain("Acesso confirmado. Redirecionando…");
  expect(errors).toEqual([]);
});

test.describe("prefers-reduced-motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("erro aparece sem deslocamento e a etapa MFA mantém o foco", async ({ page }) => {
    await gotoLogin(page, { role: "ADM", aal: "aal1" });
    await recordInsertions(page);
    await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-sintetica-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    const codigo = page.getByLabel("Código de verificação");
    await expect(codigo).toBeFocused();
    await codigo.fill("000000");
    await page.getByRole("button", { name: "Verificar" }).click();
    const alert = page.locator("#login-error[role=alert]");
    await expect(alert).toHaveText("Código inválido ou expirado. Tente novamente.");
    const rec = (await inserted(page)).find((r) => r.role === "alert");
    expect(rec, "alerta registrado").toBeTruthy();
    expect(rec!.transform, "sem deslocamento sob reduced motion").toBe("none");
    expect(rec!.opacity).toBe(1);
  });
});

test("ativar conta: indicador de etapas e erro animado com role=alert", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await installMocks(page, { role: "USER" });
  await seedSession(page, { role: "USER" });
  await page.goto("/ativar-conta");
  await waitForHydration(page);
  const steps = page.getByRole("list", { name: "Etapas da ativação" });
  await expect(steps).toBeVisible();
  await expect(steps.locator("[aria-current='step']")).toContainText("Definir senha");
  await page.getByLabel("Nova senha").fill("12345678");
  await page.getByLabel("Confirmar senha").fill("87654321");
  await page.getByRole("button", { name: "Ativar conta" }).click();
  await expect(page.locator("#ativar-erro[role=alert]")).toHaveText("As senhas não coincidem.");
  await expect(page.getByLabel("Confirmar senha")).toHaveAccessibleDescription("As senhas não coincidem.");
  expect(await axeViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("segurança: etapas QR → código → concluído só após a verificação real", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await installMocks(page, { role: "USER", hasVerifiedFactor: false });
  await seedSession(page, { role: "USER", hasVerifiedFactor: false });
  await page.goto("/configuracoes/seguranca");
  await waitForHydration(page);
  await page.getByRole("button", { name: "Ativar MFA" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();

  const steps = page.getByRole("list", { name: "Etapas da ativação do MFA" });
  await expect(steps.locator("[aria-current='step']")).toContainText("Escanear QR code");
  const input = page.getByLabel("Código do aplicativo");
  await input.fill("000000");
  await expect(steps.locator("[aria-current='step']")).toContainText("Informar código");

  // Código errado: alerta, sem "concluído".
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.locator("#mfa-erro[role=alert]")).toHaveText("Código inválido ou expirado. Tente novamente.");
  await expect(page.getByText("Verificação em duas etapas ativada.")).toHaveCount(0);

  await input.fill("123456");
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verificação em duas etapas ativada." })).toBeVisible();
  await expect(steps.locator("[aria-current='step']")).toHaveCount(0);
  await expect(steps.getByText("(concluída)")).toHaveCount(3);
  // (O mock não promove o fator a "verified" em GET /user, então a lista não muda aqui.)
  expect(await axeViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
});
