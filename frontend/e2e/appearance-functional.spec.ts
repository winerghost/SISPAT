import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  installMocks,
  seedSession,
  waitForHydration,
  type MockOptions,
  type MockState,
  type PreferencesMock,
} from "./support/mocks";
import { waitForAnimations, VIEWPORTS } from "./support/screens";

// =============================================================================
// Aparência (Etapa 3): densidade + tamanho de fonte.
// Contrato mockado: GET/PATCH /api/v1/me/preferences. Cobre: cookie `sispat-ui`
// lido no SSR (sem flash), parse estrito, axe/contraste nas 3 escalas x 2
// densidades, 320-1920px sem rolagem horizontal, salvar só com confirmação do
// backend, 409 e erro de carga.
// =============================================================================

const PATH = "/configuracoes/aparencia";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const DENSITIES = ["comfortable", "compact"] as const;
const SCALES = [100, 112, 125] as const;

test.use({ viewport: { width: 1366, height: 768 } });

async function setUiCookie(context: BrowserContext, baseURL: string | undefined, value: string): Promise<void> {
  await context.addCookies([{ name: "sispat-ui", value, url: baseURL ?? "http://localhost:3100" }]);
}

async function openPath(page: Page, path: string, opts: MockOptions = { role: "USER" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

function prefsPatches(state: MockState) {
  return state.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/v1/me/preferences"));
}

async function htmlAttrs(page: Page) {
  return page.evaluate(() => ({
    density: document.documentElement.getAttribute("data-density"),
    scale: document.documentElement.getAttribute("data-font-scale"),
  }));
}

test.describe("SSR sem flash — cookie sispat-ui no HTML inicial", () => {
  test("sem cookie: padrões comfortable/100", async ({ request }) => {
    const html = await (await request.get("/login")).text();
    expect(html).toMatch(/<html[^>]*data-density="comfortable"/);
    expect(html).toMatch(/<html[^>]*data-font-scale="100"/);
  });

  for (const density of DENSITIES) {
    for (const scale of SCALES) {
      test(`cookie ${density}.${scale} aparece no <html> do servidor`, async ({ request }) => {
        const response = await request.get("/login", { headers: { cookie: `sispat-ui=${density}.${scale}` } });
        const html = await response.text();
        expect(html).toMatch(new RegExp(`<html[^>]*data-density="${density}"`));
        expect(html).toMatch(new RegExp(`<html[^>]*data-font-scale="${scale}"`));
        // A CSP com nonce continua sendo emitida pelo middleware.
        expect(response.headers()["content-security-policy"]).toContain("nonce-");
      });
    }
  }

  for (const bad of [
    "compact.999",
    "compact",
    "compact.112.x",
    "COMPACT.112",
    "x.100",
    "compact.1e2",
    "%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "compact.112%0Ainjetado",
    "",
  ]) {
    test(`cookie inválido "${bad}" é ignorado (padrões)`, async ({ request }) => {
      const html = await (await request.get("/login", { headers: { cookie: `sispat-ui=${bad}` } })).text();
      expect(html).toMatch(/<html[^>]*data-density="comfortable"/);
      expect(html).toMatch(/<html[^>]*data-font-scale="100"/);
      // O valor bruto nunca é refletido na marcação do <html>.
      const htmlTag = /<html[^>]*>/.exec(html)?.[0] ?? "";
      expect(htmlTag).not.toContain("injetado");
      expect(htmlTag).not.toContain("script");
    });
  }

  test("no navegador o atributo já está no <html> antes da hidratação", async ({ page, context, baseURL }) => {
    await setUiCookie(context, baseURL, "compact.125");
    await installMocks(page);
    await page.route("**/_next/static/chunks/**", (route) => route.abort());
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(await htmlAttrs(page)).toEqual({ density: "compact", scale: "125" });
    const rootFont = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    expect(rootFont).toBe("20px");
  });
});

test.describe("escala aplicada só por tokens", () => {
  for (const [scale, px] of [
    [100, "16px"],
    [112, "17.92px"],
    [125, "20px"],
  ] as const) {
    test(`fonte ${scale}% = root ${px}`, async ({ page, context, baseURL }) => {
      await setUiCookie(context, baseURL, `comfortable.${scale}`);
      await installMocks(page);
      await page.goto("/login");
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(px);
    });
  }

  test("compacta reduz o padding dos cartões (24px -> 16px)", async ({ page, context, baseURL }) => {
    await setUiCookie(context, baseURL, "compact.100");
    await installMocks(page);
    await page.goto("/login");
    const padding = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--card-padding").trim(),
    );
    expect(padding).toBe("16px");
  });
});

test.describe("axe / contraste (WCAG 2.2 AA) — 3 escalas x 2 densidades", () => {
  for (const density of DENSITIES) {
    for (const scale of SCALES) {
      for (const path of [PATH, "/administracao/usuarios"]) {
        test(`${path} em ${density}.${scale}`, async ({ page, context, baseURL }, testInfo) => {
          await setUiCookie(context, baseURL, `${density}.${scale}`);
          const prefs: Partial<PreferencesMock> = { density, font_scale: scale, version: 2 };
          await openPath(page, path, { role: "ADM", prefs });
          if (path === PATH) {
            await expect(page.getByRole("radio", { name: scale === 100 ? "100%" : `${scale}%` })).toBeChecked();
          } else {
            await expect(page.getByRole("table")).toBeVisible();
          }
          await waitForAnimations(page);
          const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
          const violations = results.violations.map((v) => ({
            id: v.id,
            help: v.help,
            nodes: v.nodes.map((n) => n.target.join(" ")),
          }));
          await testInfo.attach("axe-violations", {
            body: JSON.stringify(violations, null, 2),
            contentType: "application/json",
          });
          expect(violations).toEqual([]);
        });
      }
    }
  }
});

test.describe("320-1920px sem rolagem horizontal nos extremos (compacta/125 e confortável/125)", () => {
  for (const viewport of VIEWPORTS) {
    for (const density of DENSITIES) {
      test(`${viewport.width}px ${density}.125`, async ({ page, context, baseURL }) => {
        await page.setViewportSize(viewport);
        await setUiCookie(context, baseURL, `${density}.125`);
        const prefs: Partial<PreferencesMock> = { density, font_scale: 125, version: 1 };
        for (const path of [PATH, "/configuracoes", "/"]) {
          await openPath(page, path, { role: "ADM", prefs });
          await waitForAnimations(page);
          const overflow = await page.evaluate(() => ({
            doc: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            main: (() => {
              const main = document.querySelector("main");
              return main ? main.scrollWidth - main.clientWidth : 0;
            })(),
          }));
          expect(overflow.doc, `${path}: rolagem horizontal do documento`).toBeLessThanOrEqual(viewport.width);
          expect(overflow.main, `${path}: rolagem horizontal do <main>`).toBeLessThanOrEqual(1);
        }
      });
    }
  }
});

test.describe("tela de Aparência", () => {
  test("índice e menu levam à página; aviso de tema único e prévia", async ({ page }) => {
    await openPath(page, "/configuracoes");
    const card = page.getByRole("main").getByRole("link", { name: /Aparência/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(/\/configuracoes\/aparencia$/);
    await expect(page.getByRole("heading", { level: 1, name: "Aparência" })).toBeVisible();
    await expect(page.getByText("Factory dark é o único tema oficial.")).toBeVisible();
    await expect(page.getByTestId("aparencia-previa")).toContainText("não são dados reais");
    await expect(page.getByRole("navigation", { name: "Trilha de navegação" })).toContainText("Aparência");
  });

  test("USER, RH e ADM veem Aparência no índice", async ({ page }) => {
    for (const role of ["USER", "RH", "ADM"] as const) {
      await openPath(page, "/configuracoes", { role });
      await expect(page.getByRole("main").getByRole("link", { name: /Aparência/ })).toBeVisible();
    }
  });

  test("carrega do backend, aplica no <html> e grava o cookie (sem token)", async ({ page, context }) => {
    await openPath(page, PATH, { role: "USER", prefs: { density: "compact", font_scale: 112, version: 4 } });
    await expect(page.getByRole("radio", { name: "Compacta" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "112%" })).toBeChecked();
    expect(await htmlAttrs(page)).toEqual({ density: "compact", scale: "112" });
    const cookie = (await context.cookies()).find((c) => c.name === "sispat-ui");
    expect(cookie?.value).toBe("compact.112");
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.value).not.toMatch(/eyJ|bearer|token/i);
    // Nada de preferências/tokens em localStorage.
    const local = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(local).not.toContain("sispat-ui");
    expect(local).not.toContain("compact");
  });

  test("salvar: PATCH com version, só muda após confirmação do backend; cookie e <html> atualizados", async ({
    page,
    context,
  }) => {
    const state = await openPath(page, PATH);
    await expect(page.getByRole("radio", { name: "Confortável" })).toBeChecked();
    const salvar = page.getByRole("button", { name: "Salvar" });
    await expect(salvar).toBeDisabled();

    // Segura o PATCH para provar que nada é aplicado antes da confirmação.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/v1/me/preferences", async (route) => {
      if (route.request().method() === "PATCH") await gate;
      await route.fallback();
    });

    await page.getByRole("radio", { name: "Compacta" }).check();
    await page.getByRole("radio", { name: "112%" }).check();
    // Prévia reflete o rascunho; a interface real ainda não mudou.
    await expect(page.getByTestId("aparencia-previa")).toHaveAttribute("data-density", "compact");
    expect(await htmlAttrs(page)).toEqual({ density: "comfortable", scale: "100" });
    await expect(salvar).toBeEnabled();

    const request = page.waitForRequest((r) => r.url().endsWith("/v1/me/preferences") && r.method() === "PATCH");
    await salvar.click();
    expect((await request).postDataJSON()).toEqual({ version: 0, density: "compact", font_scale: 112 });
    // Pendente: ainda sem efeito na interface nem no cookie.
    expect(await htmlAttrs(page)).toEqual({ density: "comfortable", scale: "100" });
    expect((await context.cookies()).find((c) => c.name === "sispat-ui")?.value).toBe("comfortable.100");
    release();

    await expect(page.getByText("Preferências de aparência salvas.")).toBeVisible();
    expect(await htmlAttrs(page)).toEqual({ density: "compact", scale: "112" });
    expect((await context.cookies()).find((c) => c.name === "sispat-ui")?.value).toBe("compact.112");
    expect(state.prefs).toEqual({
      density: "compact",
      font_scale: 112,
      dashboard_charts: { units: "grouped", status: "pie", monthly: "line" },
      version: 1,
    });
    await expect(page.getByRole("button", { name: "Salvar" })).toBeDisabled();

    // Recarregar: o servidor já devolve o atributo no HTML (sem flash).
    const response = await page.reload({ waitUntil: "domcontentloaded" });
    expect(await response?.text()).toMatch(/<html[^>]*data-density="compact"/);
  });

  test("409 version_conflict: recarrega a versão nova, avisa e permite salvar de novo", async ({ page }) => {
    const state = await openPath(page, PATH);
    await page.getByRole("radio", { name: "Compacta" }).check();
    // Outra sessão salvou no meio tempo.
    state.prefs = { ...state.prefs, density: "comfortable", font_scale: 125, version: 5 };
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText(/foram alteradas em outra sessão/)).toBeVisible();
    // Estado do servidor reaplicado; nada do rascunho vazou para a interface.
    await expect(page.getByRole("radio", { name: "125%" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Confortável" })).toBeChecked();
    expect(await htmlAttrs(page)).toEqual({ density: "comfortable", scale: "125" });

    await page.getByRole("radio", { name: "Compacta" }).check();
    const request = page.waitForRequest((r) => r.url().endsWith("/v1/me/preferences") && r.method() === "PATCH");
    await page.getByRole("button", { name: "Salvar" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 5, density: "compact" });
    await expect(page.getByText("Preferências de aparência salvas.")).toBeVisible();
    expect(await htmlAttrs(page)).toEqual({ density: "compact", scale: "125" });
  });

  test("erro ao carregar: mensagem, sem controles, e tentar novamente funciona", async ({ page }) => {
    const state = await openPath(page, PATH, { role: "USER", prefsGetStatus: 500 });
    await expect(page.getByText("Não foi possível carregar suas preferências de aparência.")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    state.prefsGetStatus = null;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByRole("radio", { name: "Confortável" })).toBeChecked();
  });

  test("descartar alterações restaura o rascunho", async ({ page }) => {
    const state = await openPath(page, PATH);
    await page.getByRole("radio", { name: "125%" }).check();
    await page.getByRole("button", { name: "Descartar alterações" }).click();
    await expect(page.getByRole("radio", { name: "100%" })).toBeChecked();
    expect(prefsPatches(state)).toHaveLength(0);
  });

  test("navegação por teclado: setas trocam a opção do grupo", async ({ page }) => {
    await openPath(page, PATH);
    await page.getByRole("radio", { name: "Confortável" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "Compacta" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Compacta" })).toBeFocused();
  });
});
