import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration } from "./support/mocks";

// =============================================================================
// Fundação de animações — garantias de segurança do movimento.
// =============================================================================
// 1) prefers-reduced-motion: conteúdo visível, sem transform, inclusive após
//    navegação client-side (onde a transição de página normalmente roda).
// 2) Transição de rota não quebra foco: skip link → <main> continua.
// 3) Modal: entrada animada, Esc fecha e devolve o foco ao gatilho.
// 4) Sem erros de console/hidratação em /login e /.
// 5) HTML do SSR não esconde conteúdo (sem opacity:0 inline no wrapper).
// =============================================================================

async function pageWrapperStyle(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-animated-page]");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, transform: cs.transform };
  });
}

async function gotoHomeAuthenticated(page: Page) {
  await installMocks(page, { role: "ADM" });
  await seedSession(page, { role: "ADM" });
  await page.goto("/");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function navigateToUsuarios(page: Page) {
  const nav = page.getByRole("navigation", { name: "Navegação principal" });
  const link = nav.getByRole("link", { name: "Usuários" }).first();
  if (!(await link.isVisible())) {
    await nav.getByRole("button", { name: "Administração" }).click();
  }
  await link.click();
  await expect(page).toHaveURL(/\/administracao\/usuarios$/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Convidar Usuário" })).toBeVisible();
}

test.describe("fundação de animações", () => {
  test("reduced motion: conteúdo visível e sem transform (carga e navegação)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoHomeAuthenticated(page);
    expect(await pageWrapperStyle(page)).toEqual({ opacity: "1", transform: "none" });

    await navigateToUsuarios(page);
    // Imediatamente após a navegação — sem esperar animação terminar.
    expect(await pageWrapperStyle(page)).toEqual({ opacity: "1", transform: "none" });

    // Skeleton shimmer desligado (pseudo-elemento oculto) e animações ~0.
    const anim = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "skeleton-shimmer";
      document.body.appendChild(probe);
      const after = getComputedStyle(probe, "::after").display;
      probe.remove();
      return after;
    });
    expect(anim).toBe("none");
  });

  test("transição de rota: termina estável e não quebra skip link/foco", async ({ page }) => {
    await gotoHomeAuthenticated(page);
    await navigateToUsuarios(page);
    await expect
      .poll(() => pageWrapperStyle(page), { timeout: 5_000 })
      .toEqual({ opacity: "1", transform: "none" });

    // A remontagem do template não joga o foco para o <body>.
    const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
    expect(activeTag).not.toBe("BODY");

    // Skip link continua levando ao <main>, e o próximo Tab entra no conteúdo
    // da página (dentro do wrapper animado), não volta para o topo.
    const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
    await skip.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#conteudo")).toBeFocused();
    await page.keyboard.press("Tab");
    const insidePage = await page.evaluate(
      () => !!document.activeElement?.closest("[data-animated-page]"),
    );
    expect(insidePage).toBeTruthy();
  });

  test("modal: entrada animada, Esc fecha e devolve o foco", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    const trigger = page.getByRole("button", { name: "Convidar Usuário" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
    await expect(dialog).toBeVisible();
    const animationName = await dialog.evaluate((el) => getComputedStyle(el).animationName);
    expect(animationName).toBe("sf-dialog-in");
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Mesmo fluxo sob reduced motion (animationend precisa continuar disparando).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  for (const path of ["/login", "/"] as const) {
    test(`sem erros de console/hidratação em ${path}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        // Requisições para fora de localhost são abortadas de propósito pelos mocks.
        if (/Failed to load resource|net::ERR_FAILED/.test(text)) return;
        errors.push(text);
      });
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      await installMocks(page, { role: "ADM" });
      if (path === "/") await seedSession(page, { role: "ADM" });
      await page.goto(path);
      await waitForHydration(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForTimeout(500);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("SSR: wrapper de página não chega escondido no HTML", async ({ page }) => {
    await installMocks(page);
    const res = await page.request.get("/login");
    const html = await res.text();
    const tag = html.match(/<div[^>]*data-animated-page[^>]*>/)?.[0];
    expect(tag, "wrapper AnimatedPage presente no HTML").toBeTruthy();
    expect(tag).not.toMatch(/opacity\s*:\s*0/);
    expect(tag).not.toMatch(/translate/);
  });
});
