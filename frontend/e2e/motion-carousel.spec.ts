import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { collectLayoutReport } from "./support/layout-checks";
import { installMocks, waitForHydration } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// Carrossel (Embla) — exercitado pelo InfoSlider do painel lateral do login
// (>= lg). Não há rota de demonstração: ImageCarousel/AssetGallery não são
// testados aqui (ver docs/ux/evidence/auth-carrossel.md).
// =============================================================================

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const LABEL = "Orientações de uso do sistema";

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function openLogin(page: Page): Promise<Locator> {
  await installMocks(page);
  await page.goto("/login");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
  return page.getByRole("region", { name: LABEL });
}

async function expectSelected(carousel: Locator, index: number, total = 4) {
  await expect(carousel).toHaveAttribute("data-selected-index", String(index));
  await expect(carousel.getByRole("button", { name: `Slide ${index + 1} de ${total}` })).toHaveAttribute(
    "aria-current",
    "true",
  );
  // Só o slide atual fica fora de `inert` (os demais saem do Tab e da árvore a11y).
  const active = carousel.locator("[aria-roledescription='slide']:not([inert])");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("aria-label", new RegExp(`${index + 1} de ${total}$`));
}

/** Tira o mouse e o foco do carrossel (as pausas por hover/foco deixam de valer). */
async function leaveCarousel(page: Page) {
  await page.mouse.move(2, 2);
  await page.getByLabel("E-mail").focus();
}

test.describe("desktop (1366)", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("semântica APG: região, slides, controles rotulados e axe limpo", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const carousel = await openLogin(page);
    await expect(carousel).toBeVisible();
    await expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
    const slides = carousel.locator("[role='group'][aria-roledescription='slide']");
    await expect(slides).toHaveCount(4);
    await expect(carousel.getByRole("button", { name: "Slide anterior" })).toBeVisible();
    await expect(carousel.getByRole("button", { name: "Próximo slide" })).toBeVisible();
    await expect(carousel.getByRole("group", { name: "Escolher slide" }).getByRole("button")).toHaveCount(4);
    await expect(carousel.getByRole("button", { name: /Pausar rotação automática/ })).toBeVisible();
    await expectSelected(carousel, 0);
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Tab chega primeiro aos campos do login (painel vem depois no DOM)", async ({ page }) => {
    await openLogin(page);
    await page.getByLabel("E-mail").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Senha")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Entrar" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("region", { name: LABEL })).toBeFocused();
  });

  test("botões anterior/próximo e indicadores (com loop)", async ({ page }) => {
    const carousel = await openLogin(page);
    await carousel.getByRole("button", { name: "Próximo slide" }).click();
    await expectSelected(carousel, 1);
    await carousel.getByRole("button", { name: "Slide anterior" }).click();
    await expectSelected(carousel, 0);
    await carousel.getByRole("button", { name: "Slide anterior" }).click();
    await expectSelected(carousel, 3);
    await carousel.getByRole("button", { name: "Slide 3 de 4" }).click();
    await expectSelected(carousel, 2);
    await expect(carousel.getByText("Nunca compartilhe códigos")).toBeVisible();
    // Interação pausa o autoplay até o usuário retomar.
    await leaveCarousel(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "paused");
    await expect(carousel.getByRole("button", { name: /Retomar rotação automática/ })).toBeVisible();
  });

  test("teclado: ←/→/Home/End com o carrossel focado", async ({ page }) => {
    const carousel = await openLogin(page);
    await carousel.focus();
    await page.keyboard.press("ArrowRight");
    await expectSelected(carousel, 1);
    await page.keyboard.press("ArrowRight");
    await expectSelected(carousel, 2);
    await page.keyboard.press("ArrowLeft");
    await expectSelected(carousel, 1);
    await page.keyboard.press("End");
    await expectSelected(carousel, 3);
    await page.keyboard.press("Home");
    await expectSelected(carousel, 0);
    // Também com o foco num controle interno.
    await carousel.getByRole("button", { name: "Próximo slide" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expectSelected(carousel, 3);
  });

  test("arraste com mouse troca de slide", async ({ page }) => {
    const carousel = await openLogin(page);
    const viewport = carousel.locator("[aria-roledescription='slide']").first();
    const box = (await viewport.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.8, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.8 - i * 0.07), y);
    await page.mouse.up();
    await expectSelected(carousel, 1);
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.07), y);
    await page.mouse.up();
    await expectSelected(carousel, 0);
  });

  test("autoplay: avança sozinho; pausa com foco, hover e botão (WCAG 2.2.2)", async ({ page }) => {
    test.setTimeout(60_000);
    const carousel = await openLogin(page);
    await leaveCarousel(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "playing");
    await expect(carousel).toHaveAttribute("data-selected-index", "1", { timeout: 12_000 });

    // Foco dentro do carrossel pausa; sair retoma.
    await carousel.focus();
    await expect(carousel).toHaveAttribute("data-autoplay", "paused");
    await leaveCarousel(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "playing");

    // Hover pausa.
    await carousel.hover();
    await expect(carousel).toHaveAttribute("data-autoplay", "paused");
    await leaveCarousel(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "playing");

    // Botão Pausar: continua pausado mesmo sem foco/hover; Retomar volta.
    await carousel.getByRole("button", { name: /Pausar rotação automática/ }).click();
    await leaveCarousel(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "paused");
    const before = await carousel.getAttribute("data-selected-index");
    await page.waitForTimeout(1_000);
    await expect(carousel).toHaveAttribute("data-selected-index", before!);
    // Região de slides vira aria-live=polite quando não gira (APG).
    await expect(carousel.locator("[aria-live]")).toHaveAttribute("aria-live", "polite");
    await carousel.getByRole("button", { name: /Retomar rotação automática/ }).click();
    await leaveCarousel(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "playing");
    await expect(carousel.locator("[aria-live]")).toHaveAttribute("aria-live", "off");
  });

  test("navegação por botão: troca com fade de 200ms (só opacity)", async ({ page }) => {
    const carousel = await openLogin(page);
    // Registra as chamadas a Element.animate (a animação de 200ms pode terminar antes de inspecionarmos).
    await page.evaluate(() => {
      const w = window as unknown as { __anims: { slide: string | null; keyframes: string; duration: unknown; easing: unknown }[] };
      w.__anims = [];
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        const opts = (typeof options === "object" ? options : { duration: options }) as KeyframeAnimationOptions;
        w.__anims.push({
          slide: this.getAttribute("aria-roledescription"),
          keyframes: JSON.stringify(keyframes),
          duration: opts?.duration,
          easing: opts?.easing,
        });
        return orig.call(this, keyframes, options);
      };
    });
    await carousel.getByRole("button", { name: "Próximo slide" }).click();
    await expectSelected(carousel, 1);
    const anims = await page.evaluate(
      () => (window as unknown as { __anims: { slide: string | null }[] }).__anims.filter((a) => a.slide === "slide"),
    );
    expect(anims).toEqual([
      {
        slide: "slide",
        keyframes: JSON.stringify([{ opacity: 0 }, { opacity: 1 }]),
        duration: 200,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    ]);
  });
});

test.describe("toque (hasTouch)", () => {
  test.use({ viewport: { width: 1366, height: 768 }, hasTouch: true });

  test("arraste por toque troca de slide", async ({ page }) => {
    const carousel = await openLogin(page);
    const slide = carousel.locator("[aria-roledescription='slide']").first();
    const box = (await slide.boundingBox())!;
    const y = Math.round(box.y + box.height / 2);
    const startX = Math.round(box.x + box.width * 0.8);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: Math.round(startX - box.width * 0.07 * i), y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expectSelected(carousel, 1);
  });
});

test.describe("prefers-reduced-motion", () => {
  test.use({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });

  test("autoplay desligado, sem botão de pausa; navegação continua funcionando", async ({ page }) => {
    const carousel = await openLogin(page);
    await expect(carousel).toHaveAttribute("data-autoplay", "off");
    await expect(carousel.getByRole("button", { name: /rotação automática/ })).toHaveCount(0);
    await expect(carousel.locator("[aria-live]")).toHaveAttribute("aria-live", "polite");
    await carousel.getByRole("button", { name: "Próximo slide" }).click();
    await expectSelected(carousel, 1);
    const anims = await carousel
      .locator("[aria-roledescription='slide']")
      .nth(1)
      .evaluate((el) => el.getAnimations().length);
    expect(anims, "sem fade sob reduced motion").toBe(0);
  });
});

test.describe("mobile (< lg)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("painel lateral oculto e sem autoplay", async ({ page }) => {
    const carousel = await openLogin(page);
    await expect(carousel).toBeHidden();
    await expect(page.locator("[aria-roledescription='carousel']")).toHaveAttribute("data-autoplay", "off");
  });
});

for (const width of [320, 375, 768, 1024, 1440]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("login sem overflow horizontal (inclusive após trocar de slide) e sem erros de console", async ({
      page,
    }) => {
      const errors = trackConsoleErrors(page);
      const carousel = await openLogin(page);
      if (width >= 1024) {
        await carousel.getByRole("button", { name: "Slide 2 de 4" }).click();
        await expectSelected(carousel, 1);
        await leaveCarousel(page);
      }
      await waitForAnimations(page);
      const report = await collectLayoutReport(page);
      expect(report.docScrollWidth, "rolagem horizontal do documento").toBeLessThanOrEqual(width);
      expect(report.mainOverflowX, "rolagem horizontal do <main>").toBeLessThanOrEqual(1);
      expect(report.outOfViewport, "elementos fora do viewport").toEqual([]);
      expect(report.smallTargets, "alvos < 24px").toEqual([]);
      expect(report.overlapping, "alvos sobrepostos").toEqual([]);
      expect(report.tinyText, "texto < 12px").toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
