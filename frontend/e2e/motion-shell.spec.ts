import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type Role } from "./support/mocks";
import { VIEWPORTS, waitForAnimations } from "./support/screens";

// =============================================================================
// Shell animado — sidebar recolhível, indicador ativo, submenu, menu móvel,
// filtro de navegação por perfil (UX), reduced motion, overflow e console.
// =============================================================================

const DESKTOP = { width: 1366, height: 768 };

async function openHome(page: Page, role: Role = "ADM"): Promise<void> {
  await installMocks(page, { role });
  await seedSession(page, { role });
  const me = page.waitForResponse((r) => r.url().includes("/v1/me") && r.request().method() === "GET");
  await page.goto("/");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
  await me;
}

function desktopNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Navegação principal", exact: true });
}

async function asideWidth(page: Page): Promise<number> {
  return page.locator("aside").evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

/** Distância entre o centro do indicador e o centro do alvo (px). */
async function indicatorOffset(nav: Locator, target: Locator): Promise<number> {
  const indicator = nav.locator("[data-nav-indicator]");
  const a = await indicator.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR_FAILED/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe("sidebar desktop", () => {
  test.use({ viewport: DESKTOP });

  test("recolher/expandir por mouse: largura, aria-expanded, rótulos e tooltip", async ({ page }) => {
    await openHome(page);
    const collapse = page.getByRole("button", { name: "Recolher menu lateral" });
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    const controls = await collapse.getAttribute("aria-controls");
    await expect(page.locator(`[id="${controls}"]`)).toHaveCount(1);
    expect(await asideWidth(page)).toBe(256);

    await collapse.click();
    const expand = page.getByRole("button", { name: "Expandir menu lateral" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => asideWidth(page)).toBe(64);

    // Só ícones, mas o nome acessível continua (rótulo sr-only).
    const link = desktopNav(page).getByRole("link", { name: "Patrimônios" });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(48);

    // Tooltip visual no hover; Esc o fecha (WCAG 1.4.13).
    await link.hover();
    const tooltip = page.locator("[data-nav-tooltip]");
    await expect(tooltip).toHaveText("Patrimônios");
    await link.focus();
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);

    // Estado persiste na aba (sessionStorage) após recarregar.
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByRole("button", { name: "Expandir menu lateral" })).toBeVisible();
    await expect.poll(() => asideWidth(page)).toBe(64);
    expect(await page.evaluate(() => window.sessionStorage.getItem("sispat-sidebar-collapsed"))).toBe("1");

    await page.getByRole("button", { name: "Expandir menu lateral" }).click();
    await expect.poll(() => asideWidth(page)).toBe(256);
  });

  test("recolher/expandir por teclado e navegação por setas", async ({ page }) => {
    await openHome(page);
    const collapse = page.getByRole("button", { name: "Recolher menu lateral" });
    await collapse.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Expandir menu lateral" })).toBeFocused();
    await expect.poll(() => asideWidth(page)).toBe(64);
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Recolher menu lateral" })).toBeFocused();
    await expect.poll(() => asideWidth(page)).toBe(256);

    const nav = desktopNav(page);
    await nav.getByRole("link", { name: "Home" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(nav.getByRole("link", { name: "Patrimônios" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(nav.getByRole("link", { name: "Configurações" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(nav.getByRole("link", { name: "Home" })).toBeFocused();

    // Foco visível (anel bone) nos itens.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const ring = await nav
      .getByRole("link", { name: "Home" })
      .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe("none");
  });

  test("indicador ativo acompanha a navegação; submenu com aria-controls", async ({ page }) => {
    await openHome(page);
    const nav = desktopNav(page);
    const home = nav.getByRole("link", { name: "Home" });
    await expect(home).toHaveAttribute("aria-current", "page");
    await expect.poll(() => indicatorOffset(nav, home)).toBeLessThanOrEqual(2);

    const group = nav.getByRole("button", { name: "Administração" });
    await expect(group).toHaveAttribute("aria-expanded", "false");
    const submenuId = await group.getAttribute("aria-controls");
    const submenu = page.locator(`[id="${submenuId}"]`);
    await expect(submenu).toBeHidden();
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(submenu).toBeVisible();

    const usuarios = nav.getByRole("link", { name: "Usuários" });
    await usuarios.click();
    await expect(page).toHaveURL(/\/administracao\/usuarios$/);
    await expect(usuarios).toHaveAttribute("aria-current", "page");
    await expect(home).not.toHaveAttribute("aria-current", "page");
    await expect.poll(() => indicatorOffset(nav, usuarios)).toBeLessThanOrEqual(2);

    // Fechando o submenu, o indicador vai para o botão do grupo ativo.
    await group.click();
    await expect(submenu).toBeHidden();
    await expect.poll(() => indicatorOffset(nav, group)).toBeLessThanOrEqual(2);

    // Indicador usa tween (sem spring): sem transform residual estranho e um único indicador.
    await expect(nav.locator("[data-nav-indicator]")).toHaveCount(1);
  });

  test("sem overflow horizontal com a sidebar recolhida/expandida", async ({ page }) => {
    for (const viewport of VIEWPORTS.filter((v) => v.width >= 1024)) {
      await page.setViewportSize(viewport);
      await openHome(page);
      for (const label of ["Recolher menu lateral", "Expandir menu lateral"]) {
        await page.getByRole("button", { name: label }).click();
        await page.waitForTimeout(300);
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(sw, `${viewport.width}: ${label}`).toBeLessThanOrEqual(viewport.width);
      }
    }
  });
});

test.describe("menu móvel", () => {
  for (const width of [320, 375, 768]) {
    test(`abre/fecha com Esc, overlay e foco (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openHome(page);
      const trigger = page.getByRole("button", { name: "Abrir menu de navegação" });
      const drawer = page.getByRole("dialog", { name: "SISPAT-AGU" });

      await trigger.click();
      await expect(drawer).toBeVisible();
      // Animação de entrada (slide via transform) termina com a gaveta no lugar.
      await waitForAnimations(page);
      const box = await drawer.boundingBox();
      expect(Math.round(box!.x)).toBe(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);

      // Foco preso.
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))).toBeTruthy();
      }

      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();

      // Overlay fecha (clique fora da gaveta).
      await trigger.click();
      await expect(drawer).toBeVisible();
      await waitForAnimations(page);
      const drawerBox = await drawer.boundingBox();
      await page.mouse.click(Math.min(width - 4, drawerBox!.x + drawerBox!.width + 8), 400);
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();

      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(sw).toBeLessThanOrEqual(width);
    });
  }

  test("reduced motion: gaveta aparece sem deslocamento", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 375, height: 667 });
    await openHome(page);
    await page.getByRole("button", { name: "Abrir menu de navegação" }).click();
    const drawer = page.locator("[data-mobile-drawer]");
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(Math.round(box!.x)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
});

test.describe("navegação por perfil (UX — backend continua autorizando)", () => {
  for (const role of ["ADM", "USER", "RH"] as const) {
    test(`${role}: itens administrativos ${role === "ADM" ? "visíveis" : "ocultos"}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await openHome(page, role);
      const nav = desktopNav(page);
      await expect(nav.getByRole("link", { name: "Patrimônios" })).toBeVisible();
      const admin = nav.getByRole("button", { name: "Administração" });
      if (role === "ADM") {
        await expect(admin).toBeVisible();
      } else {
        await expect(admin).toHaveCount(0);
        await expect(nav.getByRole("link", { name: "Usuários" })).toHaveCount(0);
      }

      // Mesmo filtro no menu móvel.
      await page.setViewportSize({ width: 375, height: 667 });
      await page.getByRole("button", { name: "Abrir menu de navegação" }).click();
      const drawer = page.getByRole("dialog", { name: "SISPAT-AGU" });
      await expect(drawer.getByRole("link", { name: "Patrimônios" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Administração" })).toHaveCount(role === "ADM" ? 1 : 0);
    });
  }
});

test.describe("reduced motion e qualidade", () => {
  test("reduced motion: recolher a sidebar é imediato", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    await page.getByRole("button", { name: "Recolher menu lateral" }).click();
    // Transição global zerada (0.01ms) — sem esperar 200ms.
    expect(await asideWidth(page)).toBe(64);
  });

  test("sem erros de console/hidratação e axe limpo no shell (sidebar recolhida)", async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    await page.getByRole("button", { name: "Recolher menu lateral" }).click();
    await desktopNav(page).getByRole("link", { name: "Patrimônios" }).hover();
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("nextjs-portal")
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.waitForTimeout(300);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
