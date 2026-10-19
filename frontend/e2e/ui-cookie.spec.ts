import { expect, test, type BrowserContext } from "@playwright/test";

import {
  clearUiCookie,
  DEFAULT_UI_PREFERENCES,
  parseUiCookie,
  serializeUiCookie,
} from "../src/lib/ui-preferences";
import { installMocks, seedSession, waitForHydration } from "./support/mocks";

// =============================================================================
// Cookie `sispat-ui`: parser estrito (unitário) e limpeza no logout / 401.
// =============================================================================

test.describe("parseUiCookie", () => {
  for (const density of ["comfortable", "compact"] as const) {
    for (const scale of [100, 112, 125] as const) {
      test(`aceita ${density}.${scale}`, () => {
        expect(parseUiCookie(`${density}.${scale}`)).toEqual({ density, font_scale: scale });
        expect(parseUiCookie(serializeUiCookie({ density, font_scale: scale }))).toEqual({
          density,
          font_scale: scale,
        });
      });
    }
  }

  const invalid: (string | null | undefined)[] = [
    undefined,
    null,
    "",
    "compact",
    "compact.",
    "compact.130",
    "compact.112.1",
    "Compact.112",
    "dense.100",
    " compact.112",
    "compact.112 ",
    "compact.112\n",
    "compact.1e2",
    "comfortable.0100",
    "<script>.100",
    "compact.112;admin=1",
    "../../etc.100",
  ];
  for (const raw of invalid) {
    test(`valor inválido ${JSON.stringify(raw)} → padrões`, () => {
      expect(parseUiCookie(raw)).toEqual(DEFAULT_UI_PREFERENCES);
    });
  }

  test("não devolve o objeto compartilhado dos padrões", () => {
    expect(parseUiCookie("x")).not.toBe(DEFAULT_UI_PREFERENCES);
  });

  test("clearUiCookie fora do navegador não lança", () => {
    expect(() => clearUiCookie()).not.toThrow();
  });
});

test.describe("limpeza do cookie sispat-ui", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  async function uiCookie(context: BrowserContext) {
    return (await context.cookies()).find((c) => c.name === "sispat-ui");
  }

  test("logout apaga o cookie", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "sispat-ui", value: "compact.125", url: baseURL ?? "http://localhost:3100" }]);
    await installMocks(page, { role: "USER" });
    await seedSession(page, { role: "USER" });
    await page.goto("/");
    await waitForHydration(page);
    expect(await uiCookie(context)).toBeDefined();

    await page.getByRole("button", { name: "Sair do sistema" }).click();
    await page.waitForURL("**/login");
    expect(await uiCookie(context)).toBeUndefined();
  });

  test("401 global (sessão expirada) apaga o cookie", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "sispat-ui", value: "compact.125", url: baseURL ?? "http://localhost:3100" }]);
    await installMocks(page, { role: "USER", alertsStatus: 401 });
    await seedSession(page, { role: "USER" });
    await page.goto("/");
    await page.waitForURL("**/login", { timeout: 15_000 });
    expect(await uiCookie(context)).toBeUndefined();
  });
});
