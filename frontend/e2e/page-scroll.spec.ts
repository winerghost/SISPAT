import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { collectScrollReport } from "./support/layout-checks";
import { openScreen, SCREENS, type ScreenDef } from "./support/screens";

// =============================================================================
// Rolagem única da página (regressão do "scroll duplo")
// =============================================================================
// O app é uma "tela de aplicativo": o <main id="conteudo"> rola internamente e a
// janela NUNCA rola. Elementos `position:absolute` (sr-only da paginação, dos
// gráficos etc.) escapavam do <main> por falta de containing block e criavam uma
// segunda barra de rolagem, desproporcional, na janela. Aqui:
//   - documentElement.scrollHeight <= innerHeight (+1);
//   - window.scrollTo(0, 9999) não altera scrollY;
//   - <main> sem rolagem "fantasma" (scrollHeight além do último conteúdo visível);
//   - sem rolagem horizontal;
//   - span.sr-only injetado ao fim do <main> não faz a janela rolar;
//   - axe WCAG 2.x A/AA na mesma passada.
// =============================================================================

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;

/** Rotas principais, derivadas do catálogo de telas (e2e/support/screens.ts). */
const SCREEN_IDS = [
  "dashboard",
  "dashboard-painel",
  "patrimonios-adm",
  "unidades",
  "salas",
  "responsaveis",
  "usuarios",
  "auditoria",
  "cadastros-vazio",
  "relatorios-adm",
  "perfil",
  "aparencia",
  "movimentacoes-adm",
  "inventarios-adm",
  "importacao",
] as const;

function byId(id: string): ScreenDef {
  const screen = SCREENS.find((s) => s.id === id);
  if (!screen) throw new Error(`Tela inexistente no catálogo: ${id}`);
  return screen;
}

/** /patrimonios com muitos itens (mock) e o seletor "Registros por página". */
function bulkAssets(pageSize: 100 | 200): ScreenDef {
  return {
    id: `patrimonios-${pageSize}-por-pagina`,
    title: `Patrimônios — ${pageSize} por página`,
    path: "/patrimonios",
    session: { role: "ADM", assetsBulk: 250 },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await page.getByLabel("Registros por página").selectOption(String(pageSize));
      await expect(page.getByText(new RegExp(`Exibindo 1–${pageSize} de `))).toBeVisible();
      await expect(page.getByRole("table", { name: "Patrimônios" }).locator("tbody tr")).toHaveCount(pageSize);
    },
  };
}

const SCREENS_UNDER_TEST: ScreenDef[] = [...SCREEN_IDS.map(byId), bulkAssets(100), bulkAssets(200)];

async function assertSingleScroll(page: Page, screen: ScreenDef, viewport: { width: number; height: number }) {
  const report = await collectScrollReport(page);
  const ctx = JSON.stringify(report);

  expect.soft(report.docScrollHeight, `scrollHeight do documento > innerHeight: ${ctx}`).toBeLessThanOrEqual(
    report.docClientHeight + 1,
  );
  expect.soft(report.scrollYAfter, `window.scrollTo(0,9999) rolou a janela: ${ctx}`).toBe(0);
  expect.soft(report.docScrollWidth, `rolagem horizontal: ${ctx}`).toBeLessThanOrEqual(viewport.width);
  expect.soft(report.mainGhostPx, `rolagem fantasma no <main>: ${ctx}`).toBeLessThanOrEqual(2);

  // span.sr-only (position:absolute) ao fim do <main>: não pode estender a rolagem da janela.
  await page.evaluate(() => {
    const span = document.createElement("span");
    span.className = "sr-only";
    span.textContent = "sentinela de rolagem";
    document.querySelector("main")!.appendChild(span);
  });
  const after = await collectScrollReport(page);
  expect.soft(after.docScrollHeight, `sr-only injetado estendeu o documento: ${JSON.stringify(after)}`).toBeLessThanOrEqual(
    after.docClientHeight + 1,
  );
  expect.soft(after.scrollYAfter, `sr-only injetado rolou a janela: ${JSON.stringify(after)}`).toBe(0);
  await page.evaluate(() => document.querySelector("main")!.lastElementChild?.remove());
  void screen;
}

for (const viewport of VIEWPORTS) {
  test.describe(`rolagem única ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const screen of SCREENS_UNDER_TEST) {
      test(screen.id, async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        await openScreen(page, screen);

        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("nextjs-portal").analyze();
        await testInfo.attach("axe-violations", {
          body: JSON.stringify(axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2),
          contentType: "application/json",
        });
        expect.soft(axe.violations.map((v) => v.id), "violações axe").toEqual([]);

        await assertSingleScroll(page, screen, viewport);
      });
    }
  });
}
