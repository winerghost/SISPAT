import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration } from "./support/mocks";
import { openScreen, SCREENS } from "./support/screens";

// =============================================================================
// Acessibilidade — WCAG 2.2 AA
// =============================================================================
// 1) axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) em cada tela, em
//    desktop (1366) e mobile (375).
// 2) Verificações "manuais" automatizadas: lang, skip link, teclado, foco
//    visível, modal (foco preso, Esc fecha, foco devolvido), labels,
//    headings, erros associados, contraste dos tokens do DESIGN.md e fonte.
// =============================================================================

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    // Indicador do `next dev` (só existe em desenvolvimento).
    .exclude("nextjs-portal")
    .analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`),
  }));
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 375, height: 667 },
]) {
  test.describe(`axe ${viewport.width}px`, () => {
    test.use({ viewport });
    for (const screen of SCREENS) {
      test(screen.id, async ({ page }, testInfo) => {
        await openScreen(page, screen);
        const violations = await axe(page);
        await testInfo.attach("axe-violations", {
          body: JSON.stringify(violations, null, 2),
          contentType: "application/json",
        });
        expect(violations).toEqual([]);
      });
    }
  });
}

test.describe("verificações manuais automatizadas", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("documento em pt-BR e título", async ({ page }) => {
    await installMocks(page);
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
    await expect(page).toHaveTitle(/SISPAT-AGU/);
  });

  test("skip link é o primeiro Tab, visível no foco e leva ao <main>", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/");
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box, "skip link visível no foco").not.toBeNull();
    expect(box!.width, `largura do skip link ${JSON.stringify(box)}`).toBeGreaterThan(24);
    expect(box!.height, `altura do skip link ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(24);
    await page.keyboard.press("Enter");
    await expect(page.locator("main#conteudo")).toBeFocused();
  });

  test("login: navegação por teclado até 'Entrar' com foco visível", async ({ page }) => {
    await installMocks(page);
    await page.goto("/login");
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
    // Skip link → <main>, e daí os campos (evita percorrer a navegação inteira).
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Pular para o conteúdo" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#conteudo")).toBeFocused();
    const reached: string[] = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const focusVisible =
          (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) ||
          (cs.boxShadow !== "none" && cs.boxShadow !== "") ||
          // Inputs: borda troca para bone (#eeeeee) no foco.
          cs.borderColor === "rgb(238, 238, 238)";
        return {
          name: el.getAttribute("aria-label") || el.textContent?.trim() || el.getAttribute("type") || el.tagName,
          focusVisible,
        };
      });
      if (!info) continue;
      expect.soft(info.focusVisible, `foco visível em ${info.name}`).toBeTruthy();
      reached.push(info.name);
      if (info.name === "Entrar") break;
    }
    expect(reached).toContain("email");
    expect(reached).toContain("password");
    expect(reached).toContain("Entrar");
  });

  test("importação: Tab alcança ações principais com foco visível", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/importacao/google-sheets");
    await waitForHydration(page);
    await expect(page.getByRole("button", { name: "Pré-visualizar Importação" })).toBeVisible();
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (name === "Pré-visualizar Importação") found = true;
    }
    expect(found).toBeTruthy();
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow);
    expect(ring).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("table")).toBeVisible();
    // Filtros por teclado (aria-pressed).
    const filtro = page.getByRole("button", { name: "Inválido" });
    await filtro.focus();
    await page.keyboard.press("Enter");
    await expect(filtro).toHaveAttribute("aria-pressed", "true");
  });

  test("modal de convite: foco preso, Esc fecha e devolve o foco", async ({ page }) => {
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/administracao/usuarios");
    await waitForHydration(page);
    const trigger = page.getByRole("button", { name: "Convidar Usuário" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
    await expect(dialog).toBeVisible();
    // Foco inicial dentro do diálogo e preso durante 20 Tabs / Shift+Tabs.
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press(key);
        const inside = await page.evaluate(
          () => !!document.activeElement?.closest("[role='dialog']"),
        );
        expect(inside, `${key} #${i} saiu do diálogo`).toBeTruthy();
      }
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("menu móvel: foco preso, Esc fecha e devolve o foco", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await installMocks(page, { role: "ADM" });
    await seedSession(page, { role: "ADM" });
    await page.goto("/");
    await waitForHydration(page);
    const trigger = page.getByRole("button", { name: "Abrir menu de navegação" });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "SISPAT-AGU" });
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']")),
      ).toBeTruthy();
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("modal de confirmação da importação: Esc fecha", async ({ page }) => {
    const screen = SCREENS.find((s) => s.id === "importacao-confirmar")!;
    await openScreen(page, screen);
    const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
    await expect(dialog.getByRole("button", { name: "Cancelar" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Confirmar Importação" })).toBeFocused();
  });

  // Um teste por tela (antes: loop único de ~6 min isolado e >20 min sob carga,
  // estourando o limite). Mesmas asserções, paralelizáveis e com falha localizada.
  for (const screen of SCREENS) {
    test(`headings: ${screen.id}: um único h1 e sem saltos de nível`, async ({ page }) => {
      test.setTimeout(120_000);
      await openScreen(page, screen);
      const levels = await page.evaluate(() =>
        Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
          .filter((h) => !h.closest("[aria-hidden='true']") && (h as HTMLElement).offsetParent !== null)
          .map((h) => Number(h.tagName[1])),
      );
      const h1Count = await page.locator("main h1").count();
      expect.soft(h1Count, `${screen.id}: h1 em <main>`).toBe(1);
      for (let i = 1; i < levels.length; i++) {
        expect.soft(levels[i]! - levels[i - 1]!, `${screen.id}: salto de heading ${levels.join(",")}`).toBeLessThanOrEqual(1);
      }
    });
  }

  test("login: erro anunciado (role=alert) e associado aos campos", async ({ page }) => {
    await installMocks(page);
    await page.goto("/login");
    await waitForHydration(page);
    await page.getByLabel("E-mail").fill("invalido@exemplo.invalid");
    await page.getByLabel("Senha").fill("senha-errada");
    await page.getByRole("button", { name: "Entrar" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "E-mail ou senha incorretos." });
    await expect(alert).toBeVisible();
    const alertId = await alert.getAttribute("id");
    expect(alertId).toBeTruthy();
    for (const label of ["E-mail", "Senha"]) {
      const input = page.getByLabel(label);
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(input).toHaveAttribute("aria-describedby", new RegExp(alertId!));
      await expect(input).toHaveAccessibleDescription("E-mail ou senha incorretos.");
    }
  });

  test("ativar conta: validação anunciada e associada", async ({ page }) => {
    await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER" });
    await page.goto("/ativar-conta");
    await waitForHydration(page);
    await page.getByLabel("Nova senha").fill("12345678");
    await page.getByLabel("Confirmar senha").fill("87654321");
    await page.getByRole("button", { name: "Ativar conta" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "As senhas não coincidem." })).toBeVisible();
    await expect(page.getByLabel("Confirmar senha")).toHaveAccessibleDescription("As senhas não coincidem.");
  });

  test("todos os campos têm rótulo acessível", async ({ page }) => {
    for (const id of ["login", "ativar-conta", "seguranca-ativar", "usuarios-convite", "importacao"]) {
      const fresh = await page.context().newPage();
      await openScreen(fresh, SCREENS.find((s) => s.id === id)!);
      const unlabeled = await fresh.evaluate(() =>
        Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"))
          .filter((el) => !el.closest("[aria-hidden='true']"))
          .filter((el) => {
            const input = el as HTMLInputElement;
            const byLabel = input.labels && input.labels.length > 0;
            return !byLabel && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby");
          })
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      expect.soft(unlabeled, `${id}: campos sem rótulo`).toEqual([]);
      await fresh.close();
    }
  });

  test("fonte Geist/Geist Mono do DESIGN.md é de fato aplicada", async ({ page }) => {
    await installMocks(page);
    await page.goto("/login");
    await waitForHydration(page);
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        heading: getComputedStyle(document.querySelector("h1")!).fontFamily,
        eyebrow: getComputedStyle(document.querySelector(".text-eyebrow")!).fontFamily,
      };
    });
    expect(fonts.heading).toMatch(/^'?GeistSans/);
    expect(fonts.eyebrow).toMatch(/^'?GeistMono/);
  });
});

// -----------------------------------------------------------------------------
// Contraste dos pares de tokens do DESIGN.md efetivamente usados na UI.
// -----------------------------------------------------------------------------

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

const T = {
  canvas: "#101010",
  carbon: "#1d1a18",
  ash: "#3d3a39",
  graphite: "#4d4947",
  granite: "#8a8380",
  stone: "#b8b3b0",
  bone: "#eeeeee",
  chalk: "#fafafa",
  orange: "#ee6018",
  green: "#a0ca92",
};

test.describe("contraste dos tokens (WCAG 1.4.3 / 1.4.11)", () => {
  const usedTextPairs: [string, string, string][] = [
    ["bone sobre canvas (texto principal)", T.bone, T.canvas],
    ["warm-granite sobre canvas (texto secundário)", T.granite, T.canvas],
    ["warm-granite sobre carbon-lift (placeholder/sidebar)", T.granite, T.carbon],
    ["pale-stone sobre canvas (eyebrows)", T.stone, T.canvas],
    ["pale-stone sobre carbon-lift", T.stone, T.carbon],
    ["signal-orange sobre canvas (erros)", T.orange, T.canvas],
    ["signal-orange sobre carbon-lift (erros em card)", T.orange, T.carbon],
    ["metric-green sobre canvas (sucesso)", T.green, T.canvas],
    ["metric-green sobre carbon-lift", T.green, T.carbon],
    ["obsidian sobre bone (texto em diálogo)", T.canvas, T.bone],
    ["graphite-mid sobre bone (descrição/rótulos em diálogo)", T.graphite, T.bone],
    ["obsidian sobre chalk (botão light)", T.canvas, T.chalk],
    ["bone sobre carbon-lift (botão default/inputs)", T.bone, T.carbon],
  ];
  for (const [label, fg, bg] of usedTextPairs) {
    test(`${label} >= 4.5:1`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("pares PROIBIDOS para texto (documentados): laranja/verde/granite sobre bone", () => {
    // Estes pares NÃO podem ser usados para texto — por isso FormMessage
    // surface="light" e Button variant="outlineOnLight" existem.
    expect(contrast(T.orange, T.bone)).toBeLessThan(4.5);
    expect(contrast(T.green, T.bone)).toBeLessThan(4.5);
    expect(contrast(T.granite, T.bone)).toBeLessThan(4.5);
  });

  test("componentes não-texto: borda de foco bone sobre canvas >= 3:1", () => {
    expect(contrast(T.bone, T.canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(T.canvas, T.bone)).toBeGreaterThanOrEqual(3);
  });
});
