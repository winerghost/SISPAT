import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions } from "./support/mocks";
import { waitForAnimations } from "./support/screens";

// =============================================================================
// "Personalizar painéis" — catálogo de 13 painéis (ONDA 3). Contrato MOCKADO
// (espelha docs/architecture/dashboard-api.md):
//   GET /api/v1/dashboard/panels        -> {panels, sizes, default_layout, preferences:{panels, version}}
//   PUT /api/v1/dashboard/preferences   -> {version, panels} | {version, restore_default:true}
//   400 sem painel visível/tamanho inválido; 403 panel_forbidden; 409 version_conflict.
// O catálogo por perfil é decidido pelo mock (como o backend): a tela só renderiza.
// Cobre: perfis ADM/USER/RH, teclado (foco + aria-live), arrastar, tamanho P/M/G,
// salvar/restaurar/cancelar, estado honesto, 400/403/409, loading/erro/resposta
// inválida, foco preso, Esc, axe e 320/768/1920px.
// =============================================================================

test.use({ viewport: { width: 1366, height: 900 } });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const CORS = (route: Route) => ({
  "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "authorization,content-type",
  vary: "origin",
});

type Size = "P" | "M" | "G";
interface CatalogEntry {
  id: string;
  label: string;
  description: string;
  group: string;
  sizes: Size[];
  default_size: Size;
  exportable: boolean;
  roles: ("ADM" | "USER" | "RH")[];
}

const ALL: ("ADM" | "USER" | "RH")[] = ["ADM", "USER", "RH"];
const CATALOG: CatalogEntry[] = [
  { id: "kpi_workstations", label: "Postos de trabalho", description: "Cartões de Computadores, Notebooks e Monitores.", group: "indicadores", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "kpi_infrastructure", label: "Infraestrutura de TI", description: "Impressoras, Nobreaks, Estabilizadores e Docking.", group: "indicadores", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "kpi_furniture", label: "Mobiliário", description: "Gaveteiros, Armários, Mesas e Estações.", group: "indicadores", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "equipment_by_unit_table", label: "Equipamentos de TI por unidade", description: "Tabela com exportação.", group: "tabelas", sizes: ["M", "G"], default_size: "G", exportable: true, roles: ALL },
  { id: "furniture_by_unit_table", label: "Mobiliário por unidade", description: "Tabela com exportação.", group: "tabelas", sizes: ["M", "G"], default_size: "G", exportable: true, roles: ALL },
  { id: "equipment_by_unit_chart", label: "Equipamentos por unidade (gráfico)", description: "Barras agrupadas.", group: "graficos", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "located_by_unit_chart", label: "Localização dos bens por unidade", description: "Barras por situação de localização.", group: "graficos", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "category_distribution", label: "Distribuição por categoria", description: "Percentual por família e categoria.", group: "graficos", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ALL },
  { id: "notebooks_without_docking", label: "Notebooks sem docking", description: "Estimativa por unidade.", group: "analises", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ["ADM", "USER"] },
  { id: "workstation_ratio", label: "Monitores por computador", description: "Razão por posto.", group: "analises", sizes: ["P", "M", "G"], default_size: "P", exportable: false, roles: ["ADM", "USER"] },
  { id: "unclassified_review", label: "Pendentes de revisão", description: "Bens OUTROS com baixa confiança.", group: "administracao", sizes: ["M", "G"], default_size: "M", exportable: false, roles: ["ADM"] },
  { id: "classification_overrides", label: "Correções manuais de categoria", description: "Últimas correções.", group: "administracao", sizes: ["M", "G"], default_size: "M", exportable: false, roles: ["ADM"] },
  { id: "sync_status", label: "Sincronização do Sheets", description: "Última importação e divergências.", group: "administracao", sizes: ["P", "M", "G"], default_size: "P", exportable: false, roles: ["ADM"] },
];

interface PanelsState {
  role: "ADM" | "USER" | "RH";
  version: number;
  panels: { id: string; visible: boolean; size: Size }[];
  gets: number;
  puts: { method: string; body: Record<string, unknown> }[];
  getStatus: number | null;
  getDelayMs: number;
  /** Corpo bruto devolvido pelo GET (resposta inválida), quando definido. */
  rawGet: unknown;
  /** Força o status do PUT. */
  putStatus: { status: number; code: string } | null;
  putGate: Promise<void> | null;
}

const allowed = (role: PanelsState["role"]) => CATALOG.filter((c) => c.roles.includes(role));
const defaults = (role: PanelsState["role"]) => allowed(role).map((c) => ({ id: c.id, visible: true, size: c.default_size }));

async function mockPanels(page: Page, role: PanelsState["role"], init: Partial<PanelsState> = {}): Promise<PanelsState> {
  const state: PanelsState = {
    role,
    version: 0,
    panels: defaults(role),
    gets: 0,
    puts: [],
    getStatus: null,
    getDelayMs: 0,
    rawGet: undefined,
    putStatus: null,
    putGate: null,
    ...init,
  };
  const reply = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: { ...CORS(route), "content-type": "application/json" }, body: JSON.stringify(body) });

  await page.route("**/api/v1/dashboard/panels", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    if (method !== "GET") return route.fallback();
    state.gets += 1;
    if (state.getDelayMs) await new Promise((r) => setTimeout(r, state.getDelayMs));
    if (state.getStatus) return reply(route, state.getStatus, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
    if (state.rawGet !== undefined) return reply(route, 200, state.rawGet);
    const catalog = allowed(state.role).map(({ roles: _roles, ...rest }) => rest);
    return reply(route, 200, {
      panels: catalog,
      sizes: ["P", "M", "G"],
      default_layout: defaults(state.role),
      preferences: { panels: state.panels, version: state.version },
    });
  });

  await page.route("**/api/v1/dashboard/preferences", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    if (request.method() !== "PUT") return route.fallback();
    const body = request.postDataJSON() as { version: number; panels?: PanelsState["panels"]; restore_default?: boolean };
    state.puts.push({ method: request.method(), body });
    if (state.putGate) await state.putGate;
    if (state.putStatus) {
      return reply(route, state.putStatus.status, { error: { code: state.putStatus.code, message: "SISPAT_BACKEND_MSG" } });
    }
    if (body.version !== state.version) {
      return reply(route, 409, { error: { code: "version_conflict", message: "SISPAT_BACKEND_MSG" } });
    }
    const permitted = new Map(allowed(state.role).map((c) => [c.id, c]));
    if (body.restore_default) {
      state.panels = defaults(state.role);
    } else {
      const incoming = body.panels ?? [];
      if (incoming.some((p) => !permitted.has(p.id))) {
        return reply(route, 403, { error: { code: "panel_forbidden", message: "SISPAT_BACKEND_MSG" } });
      }
      if (!incoming.some((p) => p.visible) || incoming.some((p) => !permitted.get(p.id)!.sizes.includes(p.size))) {
        return reply(route, 400, { error: { code: "validation_error", message: "SISPAT_BACKEND_MSG" } });
      }
      const rest = defaults(state.role).filter((d) => !incoming.some((p) => p.id === d.id));
      state.panels = [...incoming, ...rest];
    }
    state.version += 1;
    return reply(route, 200, { panels: state.panels, version: state.version });
  });
  return state;
}

async function open(
  page: Page,
  role: PanelsState["role"] = "ADM",
  init: Partial<PanelsState> = {},
  mock: MockOptions = {},
): Promise<PanelsState> {
  const opts: MockOptions = { role: role === "RH" ? "RH" : role, ...mock };
  await installMocks(page, opts);
  const state = await mockPanels(page, role, init);
  await seedSession(page, opts);
  await page.goto("/dashboard");
  await waitForHydration(page);
  await expect(trigger(page)).toBeVisible();
  return state;
}

const trigger = (page: Page) => page.getByRole("button", { name: "Personalizar painéis" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Personalizar painéis" });
const save = (d: Locator) => d.getByRole("button", { name: "Salvar" });
const announcement = (d: Locator) => d.locator("[data-layout-announcement]");

async function dialogOrder(d: Locator): Promise<string[]> {
  return d.locator("[data-layout-item]").evaluateAll((els) => els.map((el) => el.getAttribute("data-layout-item") ?? ""));
}
const ids = (role: PanelsState["role"]) => allowed(role).map((c) => c.id);

async function openDialog(page: Page): Promise<Locator> {
  await trigger(page).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.locator("[data-layout-item]").first()).toBeVisible();
  return d;
}

test.describe("catálogo por perfil (decidido pelo backend)", () => {
  for (const [role, count] of [["ADM", 13], ["USER", 10], ["RH", 8]] as const) {
    test(`${role}: lista exatamente ${count} painéis, na ordem do servidor`, async ({ page }) => {
      await open(page, role);
      const d = await openDialog(page);
      expect(await dialogOrder(d)).toEqual(ids(role));
      await expect(d.getByRole("checkbox")).toHaveCount(count);
      for (const box of await d.getByRole("checkbox").all()) await expect(box).toBeChecked();
      await expect(d.getByRole("button", { name: "Restaurar padrão" })).toBeDisabled();
      await expect(save(d)).toBeDisabled();
      // Painéis só-ADM nunca aparecem para outros perfis (a tela só renderiza o que veio).
      const adminOnly = ["Pendentes de revisão", "Correções manuais de categoria", "Sincronização do Sheets"];
      for (const label of adminOnly) {
        await expect(d.getByRole("checkbox", { name: new RegExp(label) })).toHaveCount(role === "ADM" ? 1 : 0);
      }
    });
  }

  test("tamanhos oferecidos respeitam o catálogo (tabelas só M/G)", async ({ page }) => {
    await open(page, "ADM");
    const d = await openDialog(page);
    const table = d.locator('[data-layout-item="equipment_by_unit_table"]');
    await expect(table.getByRole("radio")).toHaveCount(2);
    await expect(table.getByRole("radio", { name: "Pequeno" })).toHaveCount(0);
    await expect(d.locator('[data-layout-item="kpi_workstations"]').getByRole("radio")).toHaveCount(3);
    await expect(d.getByRole("group", { name: "Tamanho de Postos de trabalho" })).toBeVisible();
  });
});

test.describe("personalizar", () => {
  test("teclado: move (foco acompanha + aria-live), oculta, salva só após confirmar e persiste", async ({ page }) => {
    const state = await open(page, "USER");
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    const d = dialog(page);
    await expect(d).toBeVisible();

    const up = d.getByRole("button", { name: "Mover Distribuição por categoria para cima" });
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(up).toBeFocused();
    await expect(announcement(d)).toHaveText("Distribuição por categoria movido para a posição 7 de 10.");
    await page.keyboard.press("Enter");
    await expect(announcement(d)).toHaveText(/posição 6 de 10/);
    // "Mobiliário" oculto pelo teclado (Espaço no checkbox).
    const furniture = d.getByRole("checkbox", { name: /^Mobiliário \(/ });
    await furniture.focus();
    await page.keyboard.press(" ");
    await expect(furniture).not.toBeChecked();

    // Estado honesto: com o PUT pendente, nada foi confirmado e o botão fica ocupado.
    let release: () => void = () => {};
    state.putGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = page.waitForRequest((r) => r.url().endsWith("/v1/dashboard/preferences") && r.method() === "PUT");
    await save(d).click();
    const expectedOrder = [
      "kpi_workstations", "kpi_infrastructure", "kpi_furniture", "equipment_by_unit_table", "furniture_by_unit_table",
      "category_distribution", "equipment_by_unit_chart", "located_by_unit_chart", "notebooks_without_docking", "workstation_ratio",
    ];
    const sent = (await request).postDataJSON() as { version: number; panels: { id: string; visible: boolean; size: string }[] };
    expect(sent.version).toBe(0);
    expect(sent.panels.map((p) => p.id)).toEqual(expectedOrder);
    expect(sent.panels.filter((p) => !p.visible).map((p) => p.id)).toEqual(["kpi_furniture"]);
    await expect(save(d)).toHaveAttribute("aria-busy", "true");
    expect(state.version).toBe(0);
    release();

    await expect(d).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(page.locator("[data-dashboard-layout-saved]")).toHaveText("Painéis do dashboard atualizados.");
    expect(state.version).toBe(1);
    expect(state.puts).toHaveLength(1);

    // Reabrir mostra o estado CONFIRMADO.
    const again = await openDialog(page);
    expect(await dialogOrder(again)).toEqual(expectedOrder);
    await expect(again.getByRole("checkbox", { name: /^Mobiliário \(/ })).not.toBeChecked();
  });

  test("tamanho P/M/G: rádio nativo (setas), enviado ao backend", async ({ page }) => {
    const state = await open(page, "ADM");
    const d = await openDialog(page);
    const group = d.getByRole("group", { name: "Tamanho de Postos de trabalho" });
    const large = group.getByRole("radio", { name: "Grande" });
    await expect(large).toBeChecked();
    await large.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(group.getByRole("radio", { name: "Médio" })).toBeChecked();
    await d.locator('[data-layout-item="sync_status"]').getByRole("radio", { name: "Grande" }).check();

    await save(d).click();
    await expect(d).toHaveCount(0);
    const body = state.puts[0]!.body as { version: number; panels: { id: string; size: Size }[] };
    expect(body.version).toBe(0);
    expect(body.panels.find((p) => p.id === "kpi_workstations")!.size).toBe("M");
    expect(body.panels.find((p) => p.id === "sync_status")!.size).toBe("G");
    expect(body.panels).toHaveLength(13);
    expect("restore_default" in body).toBe(false);
  });

  test("arrastar pela alça reordena (barra de destino, aria-live) e só salva ao confirmar", async ({ page }) => {
    const state = await open(page, "ADM");
    const d = await openDialog(page);
    const grip = d.locator('[data-layout-item="kpi_workstations"] [data-layout-grip]');
    const target = d.locator('[data-layout-item="kpi_furniture"]');
    const g = (await grip.boundingBox())!;
    const t = (await target.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, t.y + t.height * 0.75, { steps: 6 });
    await expect(d.locator("[data-layout-drop]")).toHaveCount(1);
    await page.mouse.up();
    await expect(announcement(d)).toHaveText("Postos de trabalho movido para a posição 3 de 13.");
    expect((await dialogOrder(d)).slice(0, 3)).toEqual(["kpi_infrastructure", "kpi_furniture", "kpi_workstations"]);
    expect(state.puts).toHaveLength(0);
    await expect(d.locator("[data-layout-drop]")).toHaveCount(0);

    await save(d).click();
    await expect(d).toHaveCount(0);
    expect(state.panels.slice(0, 3).map((p) => p.id)).toEqual(["kpi_infrastructure", "kpi_furniture", "kpi_workstations"]);
  });

  test("restaurar padrão envia restore_default e volta ao padrão", async ({ page }) => {
    const custom = defaults("USER").reverse().map((p, i) => ({ ...p, visible: i !== 0 }));
    const state = await open(page, "USER", { version: 3, panels: custom });
    const d = await openDialog(page);
    expect((await dialogOrder(d))[0]).toBe("workstation_ratio");
    const request = page.waitForRequest((r) => r.url().endsWith("/v1/dashboard/preferences") && r.method() === "PUT");
    await d.getByRole("button", { name: "Restaurar padrão" }).click();
    expect((await request).postDataJSON()).toEqual({ version: 3, restore_default: true });
    await expect(d).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    expect(state.panels).toEqual(defaults("USER"));
    const again = await openDialog(page);
    expect(await dialogOrder(again)).toEqual(ids("USER"));
    await expect(again.getByRole("button", { name: "Restaurar padrão" })).toBeDisabled();
  });

  test("cancelar descarta o rascunho sem PUT", async ({ page }) => {
    const state = await open(page, "RH");
    const d = await openDialog(page);
    await d.getByRole("button", { name: "Mover Mobiliário para cima" }).click();
    await d.getByRole("button", { name: "Cancelar" }).click();
    await expect(d).toHaveCount(0);
    expect(state.puts).toHaveLength(0);
    expect(await dialogOrder(await openDialog(page))).toEqual(ids("RH"));
  });
});

test.describe("erros e contrato", () => {
  test("todos ocultos: aviso e salvar desabilitado (nenhum PUT)", async ({ page }) => {
    const state = await open(page, "RH");
    const d = await openDialog(page);
    for (const box of await d.getByRole("checkbox").all()) await box.uncheck();
    await expect(d.getByRole("alert")).toHaveText(/Mantenha pelo menos um painel visível/);
    await expect(save(d)).toBeDisabled();
    expect(state.puts).toHaveLength(0);
  });

  test("400 do backend: mensagem fixa (sem texto do servidor) e o diálogo continua aberto", async ({ page }) => {
    const state = await open(page, "USER", { putStatus: { status: 400, code: "validation_error" } });
    const d = await openDialog(page);
    await d.getByRole("checkbox", { name: /^Mobiliário \(/ }).uncheck();
    await save(d).click();
    await expect(d.getByRole("alert")).toHaveText(/Não foi possível salvar os painéis/);
    await expect(page.locator("body")).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(d).toBeVisible();
    expect(state.version).toBe(0);
  });

  test("409: avisa, recarrega do servidor (rascunho = servidor) e salva de novo com a versão nova", async ({ page }) => {
    const state = await open(page, "USER");
    const d = await openDialog(page);
    await d.getByRole("checkbox", { name: /^Mobiliário \(/ }).uncheck();
    // Outra sessão salvou antes: versão 4, "Notebooks sem docking" oculto.
    state.version = 4;
    state.panels = defaults("USER").map((p) => ({ ...p, visible: p.id !== "notebooks_without_docking" }));
    await save(d).click();
    await expect(d.getByRole("alert")).toContainText(/alteradas em outra sessão/);
    await expect(d.getByRole("checkbox", { name: /Notebooks sem docking/ })).not.toBeChecked();
    await expect(d.getByRole("checkbox", { name: /^Mobiliário \(/ })).toBeChecked();
    expect(state.gets).toBeGreaterThanOrEqual(2);

    await d.getByRole("checkbox", { name: /^Mobiliário \(/ }).uncheck();
    const request = page.waitForRequest((r) => r.url().endsWith("/v1/dashboard/preferences") && r.method() === "PUT");
    await save(d).click();
    expect((await request).postDataJSON()).toMatchObject({ version: 4 });
    await expect(d).toHaveCount(0);
    expect(state.panels.filter((p) => !p.visible).map((p) => p.id).sort()).toEqual(["kpi_furniture", "notebooks_without_docking"]);
  });

  test("403 panel_forbidden: mensagem fixa e catálogo recarregado", async ({ page }) => {
    const state = await open(page, "USER");
    const d = await openDialog(page);
    await d.getByRole("checkbox", { name: /^Mobiliário \(/ }).uncheck();
    state.putStatus = { status: 403, code: "panel_forbidden" };
    await save(d).click();
    await expect(d.getByRole("alert")).toContainText(/não está disponível para o seu perfil/);
    await expect(page.locator("body")).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(d.getByRole("checkbox", { name: /^Mobiliário \(/ })).toBeChecked();
    expect(state.gets).toBeGreaterThanOrEqual(2);
  });

  test("carregando: estado de loading acessível e depois a lista", async ({ page }) => {
    await open(page, "USER", { getDelayMs: 5000 });
    await trigger(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.locator("[data-layout-loading]")).toHaveText(/Carregando painéis/);
    await expect(save(d)).toBeDisabled();
    await expect(d.locator("[data-layout-item]")).toHaveCount(10, { timeout: 20_000 });
    await expect(d.locator("[data-layout-loading]")).toHaveCount(0);
  });

  test("falha ao carregar: erro, 'Tentar novamente' recupera", async ({ page }) => {
    const state = await open(page, "USER", { getStatus: 500 });
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.locator("[data-layout-load-error]")).toContainText("Não foi possível carregar os painéis");
    await expect(page.locator("body")).not.toContainText("SISPAT_BACKEND_MSG");
    await expect(d.getByRole("button", { name: "Restaurar padrão" })).toBeDisabled();
    state.getStatus = null;
    await d.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(d.locator("[data-layout-item]")).toHaveCount(10);
    await expect(d.locator("[data-layout-load-error]")).toHaveCount(0);
  });

  const invalid: { name: string; mutate: (body: Record<string, unknown>) => void }[] = [
    { name: "tamanho fora do catálogo", mutate: (b) => ((b.preferences as { panels: { size: string }[] }).panels[3]!.size = "P") },
    { name: "id fora do catálogo", mutate: (b) => ((b.preferences as { panels: { id: string }[] }).panels[0]!.id = "kpis") },
    { name: "id com HTML", mutate: (b) => ((b.preferences as { panels: { id: string }[] }).panels[0]!.id = "<img src=x>") },
    { name: "todos ocultos", mutate: (b) => (b.preferences as { panels: { visible: boolean }[] }).panels.forEach((p) => (p.visible = false)) },
  ];
  for (const { name, mutate } of invalid) {
    test(`resposta inválida (${name}): erro de carregamento, sem quebrar nem injetar HTML`, async ({ page }) => {
      const catalog = allowed("USER").map(({ roles: _r, ...rest }) => rest);
      const body: Record<string, unknown> = {
        panels: catalog,
        sizes: ["P", "M", "G"],
        default_layout: defaults("USER"),
        preferences: { panels: defaults("USER"), version: 0 },
      };
      mutate(body);
      await open(page, "USER", { rawGet: body });
      await trigger(page).click();
      await expect(dialog(page).locator("[data-layout-load-error]")).toBeVisible();
      await expect(dialog(page).locator("[data-layout-item]")).toHaveCount(0);
      expect(await page.locator("main img").count()).toBe(0);
    });
  }
});

test.describe("acessibilidade e responsividade", () => {
  test("axe com o diálogo aberto (WCAG 2.2 AA), foco preso e Esc devolve o foco ao gatilho", async ({ page }) => {
    await open(page, "ADM");
    const d = await openDialog(page);
    await d.getByRole("checkbox", { name: /^Mobiliário \(/ }).uncheck();
    await waitForAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    // Foco preso: Tab repetido nunca sai do diálogo.
    for (let i = 0; i < 70; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  for (const width of [320, 768, 1920]) {
    test(`${width}px: diálogo cabe na tela, alvos >= 24px, sem rolagem horizontal, axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1920 ? 1000 : 700 });
      await open(page, "ADM");
      const d = await openDialog(page);
      await waitForAnimations(page);
      const box = (await d.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      for (const control of await d.locator("button:visible, input").all()) {
        const b = (await control.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(16);
        if ((await control.getAttribute("type")) !== "checkbox") {
          expect(b.height).toBeGreaterThanOrEqual(24);
          expect(b.width).toBeGreaterThanOrEqual(24);
        }
      }
      // Nada dentro do diálogo transborda horizontalmente.
      const overflow = await d.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }

  test("prefers-reduced-motion: diálogo abre e fecha normalmente", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "USER");
    const d = await openDialog(page);
    await page.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });
});
