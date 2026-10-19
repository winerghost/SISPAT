import { expect, test, type Page, type Request } from "@playwright/test";

import { INACTIVE_UNIT, PERSON_IDS, PERSON_PHONE, ROOM_IDS } from "./support/catalog-mocks";
import {
  API_URL,
  expectNoXss,
  installMocks,
  seedSession,
  UNITS,
  waitForHydration,
  type MockOptions,
  type MockState,
} from "./support/mocks";

// =============================================================================
// Cadastros de apoio — salas, pessoas responsáveis e unidades (ADM).
// Mocks sintéticos que seguem docs/architecture/cadastros-apoio-api.md. A
// autorização, a unicidade, a unidade inativa e a concorrência são do BACKEND
// (simuladas no mock); aqui validamos o que a interface envia e como explica
// cada resposta. O nome do arquivo casa com o projeto "e2e".
// =============================================================================

test.use({ viewport: { width: 1366, height: 768 } });

const ROOMS_PATH = "/administracao/salas";
const PEOPLE_PATH = "/administracao/responsaveis";
const UNITS_PATH = "/administracao/unidades";
const [U1, U2, U3] = UNITS as [(typeof UNITS)[0], (typeof UNITS)[0], (typeof UNITS)[0]];
const XSS_ROOM = 'Sala <img src=x onerror="window.__xss=1">';
const LONG_ROOM = "Sala 101 Sintética com Nome Bastante Longo para Testar a Quebra de Linha em 320px";

async function open(page: Page, path: string, opts: MockOptions = { role: "ADM" }): Promise<MockState> {
  const state = await installMocks(page, opts);
  await seedSession(page, opts);
  await page.goto(path);
  await waitForHydration(page);
  return state;
}

function calls(state: MockState, method: string, pathPart: string) {
  return state.calls.filter((c) => c.method === method && c.url.includes(pathPart));
}

function waitApi(page: Page, method: string, suffix: string | RegExp): Promise<Request> {
  return page.waitForRequest((r) => {
    if (r.method() !== method || !r.url().startsWith(API_URL)) return false;
    const path = new URL(r.url()).pathname;
    return typeof suffix === "string" ? path.endsWith(suffix) : suffix.test(path);
  });
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

test.describe("salas — lista", () => {
  test("colunas, unidade com sigla, situação com texto, data em America/Araguaina e XSS inerte", async ({ page }) => {
    await open(page, ROOMS_PATH);
    const table = page.getByRole("table", { name: "Salas" });
    for (const header of ["Nome", "Unidade", "Andar", "Situação", "Atualizada em"]) {
      await expect(table.getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
    }
    const longRow = table.getByRole("row").filter({ hasText: "Quebra de Linha" });
    await expect(longRow).toContainText("PSU-TO — Procuradoria Seccional Sintética de Palmas");
    await expect(longRow).toContainText("1º andar");
    // 2026-10-01T12:10Z → 09:10 em Araguaína (UTC-3).
    await expect(longRow).toContainText("01/10/2026");
    await expect(longRow).toContainText("09:10");
    await expect(longRow).toContainText("Ativa");
    await expect(table.getByRole("row").filter({ hasText: "Almoxarifado Sintético" })).toContainText("Inativa");
    // Nome com marcador XSS é texto.
    await expect(table.getByText(XSS_ROOM)).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("busca com debounce, unidade, situação e ordenação enviam só a allowlist", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    const rows = page.getByRole("table", { name: "Salas" }).locator("tbody tr");
    await expect(rows).toHaveCount(4);

    const search = waitApi(page, "GET", "/v1/rooms");
    await page.getByLabel("Buscar sala por nome").fill("audit");
    expect(new URL((await search).url()).searchParams.get("q")).toBe("audit");
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(4);

    const byUnit = waitApi(page, "GET", "/v1/rooms");
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    expect(new URL((await byUnit).url()).searchParams.get("unit_id")).toBe(U2.id);
    await expect(rows).toHaveCount(2);
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    const inactive = waitApi(page, "GET", "/v1/rooms");
    const group = page.getByRole("group", { name: "Filtrar por situação" });
    await group.getByRole("button", { name: "Inativas" }).click();
    expect(new URL((await inactive).url()).searchParams.get("active")).toBe("false");
    await expect(group.getByRole("button", { name: "Inativas" })).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(4);

    const nameHeader = page.getByRole("columnheader", { name: /Nome/ });
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    const sorted = waitApi(page, "GET", "/v1/rooms");
    await nameHeader.getByRole("button").click();
    expect(new URL((await sorted).url()).searchParams.get("sort")).toBe("-name");
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");

    const allowed = new Set(["q", "unit_id", "active", "sort", "page", "page_size"]);
    for (const call of calls(state, "GET", "/v1/rooms?")) {
      for (const key of new URL(call.url, "http://x").searchParams.keys()) expect(allowed.has(key)).toBe(true);
    }
  });

  test("filtro sem resultado mostra estado vazio com orientação", async ({ page }) => {
    await open(page, ROOMS_PATH);
    await page.getByLabel("Buscar sala por nome").fill("nada-corresponde");
    await expect(page.getByText("Nenhuma sala encontrada para os filtros atuais.")).toBeVisible();
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role}: sem papel ADM a tela explica e nem pede dados`, async ({ page }) => {
      const state = await open(page, ROOMS_PATH, { role });
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Você não tem permissão");
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Nova sala" })).toBeDisabled();
      expect(state.calls.some((c) => c.url.startsWith("/api/v1/rooms") || c.url.startsWith("/api/v1/units"))).toBe(false);
    });
  }

  test("ADM sem AAL2: orienta a confirmar a verificação em duas etapas", async ({ page }) => {
    await open(page, ROOMS_PATH, { role: "ADM", aal: "aal1" });
    await expect(page.getByRole("main").getByRole("alert").first()).toContainText("verificação em duas etapas (AAL2)");
  });
});

test.describe("salas — criar e editar", () => {
  test("criar: valida no cliente (UX), envia só os campos preenchidos e a lista é recarregada", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    await page.getByRole("button", { name: "Nova sala" }).click();
    const dialog = page.getByRole("dialog", { name: "Nova sala" });

    await dialog.getByRole("button", { name: "Criar sala" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Selecione a unidade." })).toBeVisible();
    await expect(dialog.getByRole("alert").filter({ hasText: "Informe o nome da sala." })).toBeVisible();
    expect(calls(state, "POST", "/v1/rooms")).toHaveLength(0);

    await dialog.getByLabel("Unidade").selectOption({ label: "NUC-03 — Núcleo Sintético <img src=x onerror=\"window.__xss=1\">" });
    await dialog.getByLabel("Nome").fill("  Sala   Nova   Sintética ");
    await dialog.getByLabel("Andar").fill("3º andar");
    const req = waitApi(page, "POST", "/v1/rooms");
    await dialog.getByRole("button", { name: "Criar sala" }).click();
    expect((await req).postDataJSON()).toEqual({ unit_id: U3.id, name: "Sala   Nova   Sintética", floor: "3º andar" });
    await expect(page.getByText("Sala criada.")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("table", { name: "Salas" }).getByText("Sala Nova Sintética")).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("409: duplicada e unidade inativa têm mensagens próprias, sem vazar o erro do banco", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    await page.getByRole("button", { name: "Nova sala" }).click();
    const dialog = page.getByRole("dialog", { name: "Nova sala" });
    await dialog.getByLabel("Unidade").selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    await dialog.getByLabel("Nome").fill("auditório sintético");
    await dialog.getByRole("button", { name: "Criar sala" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Já existe uma sala com estes dados nesta unidade. Revise o nome e tente de novo.",
    );
    await expect(page.getByText("erro sintético")).toHaveCount(0);

    state.unitDetails[U2.id]!.active = false;
    await dialog.getByLabel("Nome").fill("Sala Livre");
    await dialog.getByRole("button", { name: "Criar sala" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "A unidade está inativa. Reative a unidade antes de criar ou reativar registros nela.",
    );
  });

  test("editar: unidade e origem são somente leitura; PATCH só com o campo alterado + expected_updated_at", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    await page.getByRole("button", { name: `Editar ${LONG_ROOM}` }).click();
    const dialog = page.getByRole("dialog", { name: "Editar sala" });
    await expect(dialog).toContainText("PSU-TO — Procuradoria Seccional Sintética de Palmas");
    await expect(dialog).toContainText("sala-linha-2");
    // Unidade não é editável: nenhum select no diálogo.
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    const save = dialog.getByRole("button", { name: "Salvar sala" });
    await expect(save).toBeDisabled();

    await dialog.getByLabel("Andar").fill("2º andar");
    const req = waitApi(page, "PATCH", `/v1/rooms/${ROOM_IDS.a}`);
    await save.click();
    const body = (await req).postDataJSON();
    expect(body).toEqual({ expected_updated_at: "2026-10-01T12:10:00.000Z", floor: "2º andar" });
    expect(Object.keys(body)).not.toContain("unit_id");
    await expect(page.getByText("Sala atualizada.")).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(state.rooms.find((r) => r.id === ROOM_IDS.a)?.floor).toBe("2º andar");
  });

  test("409 version_conflict: recarrega o registro, avisa, e salvar de novo usa o updated_at novo", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    await page.getByRole("button", { name: "Editar Auditório Sintético" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar sala" });
    await expect(dialog.getByLabel("Nome")).toHaveValue("Auditório Sintético");
    // Outra pessoa alterou a sala no meio tempo.
    const target = state.rooms.find((r) => r.id === ROOM_IDS.other)!;
    target.floor = "Mezanino";
    target.updated_at = "2026-10-02T10:00:00.000Z";

    await dialog.getByLabel("Descrição").fill("Nova descrição sintética");
    await dialog.getByRole("button", { name: "Salvar sala" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Outra pessoa alterou este registro" })).toBeVisible();
    // Formulário remontado com o estado do servidor.
    await expect(dialog.getByLabel("Andar")).toHaveValue("Mezanino");

    await dialog.getByLabel("Descrição").fill("Nova descrição sintética");
    const req = waitApi(page, "PATCH", `/v1/rooms/${ROOM_IDS.other}`);
    await dialog.getByRole("button", { name: "Salvar sala" }).click();
    expect((await req).postDataJSON()).toEqual({
      expected_updated_at: "2026-10-02T10:00:00.000Z",
      description: "Nova descrição sintética",
    });
    await expect(page.getByText("Sala atualizada.")).toBeVisible();
  });

  test("404 (sala sumiu do escopo): mensagem neutra, sem salvar", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
    state.rooms = state.rooms.filter((r) => r.id !== ROOM_IDS.other);
    await page.getByRole("button", { name: "Editar Auditório Sintético" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar sala" });
    await expect(dialog.getByText("Registro não encontrado, ou fora do seu escopo de unidades.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Salvar sala" })).toBeDisabled();
  });
});

test.describe("salas — inativar e reativar", () => {
  test("não há exclusão: confirmação explica que o registro é preservado; motivo opcional; resultado vem do backend", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    await expect(page.getByRole("button", { name: /Excluir/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Inativar Auditório Sintético" }).click();
    const dialog = page.getByRole("dialog", { name: "Inativar sala" });
    await expect(dialog).toContainText("NÃO é excluída");
    await expect(dialog).toContainText("continuam vinculados e legíveis");
    await dialog.getByLabel("Motivo (opcional)").fill("Sala desativada para reforma sintética.");
    const req = waitApi(page, "POST", `/v1/rooms/${ROOM_IDS.other}/deactivate`);
    await dialog.getByRole("button", { name: "Inativar" }).click();
    expect((await req).postDataJSON()).toEqual({
      reason: "Sala desativada para reforma sintética.",
      expected_updated_at: "2026-10-01T12:10:00.000Z",
    });
    await expect(page.getByText("Registro inativado. Ele foi preservado.")).toBeVisible();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("table", { name: "Salas" }).getByRole("row").filter({ hasText: "Auditório Sintético" });
    await expect(row).toContainText("Inativa");
    expect(state.rooms.find((r) => r.id === ROOM_IDS.other)?.active).toBe(false);
    // Nenhuma chamada DELETE existe.
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);

    await row.getByRole("button", { name: "Reativar Auditório Sintético" }).click();
    const reactivate = page.getByRole("dialog", { name: "Reativar sala" });
    const req2 = waitApi(page, "POST", `/v1/rooms/${ROOM_IDS.other}/activate`);
    await reactivate.getByRole("button", { name: "Reativar" }).click();
    expect((await req2).postDataJSON()).toEqual({ expected_updated_at: expect.any(String) });
    await expect(row).toContainText("Ativa");
  });

  test("reativar com unidade inativa (409 unit_inactive) explica; conflito de versão fecha e recarrega", async ({ page }) => {
    const state = await open(page, ROOMS_PATH);
    state.unitDetails[U1.id]!.active = false;
    await page.getByRole("button", { name: "Reativar Almoxarifado Sintético" }).click();
    const dialog = page.getByRole("dialog", { name: "Reativar sala" });
    await dialog.getByRole("button", { name: "Reativar" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "A unidade está inativa. Reative a unidade antes de criar ou reativar registros nela.",
    );
    await dialog.getByRole("button", { name: "Cancelar" }).click();

    state.rooms.find((r) => r.id === ROOM_IDS.other)!.updated_at = "2026-10-03T00:00:00.000Z";
    await page.getByRole("button", { name: "Inativar Auditório Sintético" }).click();
    await page.getByRole("dialog", { name: "Inativar sala" }).getByRole("button", { name: "Inativar" }).click();
    await expect(page.getByText("Outra pessoa alterou este registro enquanto você editava.")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Inativar sala" })).toBeHidden();
    expect(state.rooms.find((r) => r.id === ROOM_IDS.other)?.active).toBe(true);
  });

  test("403 do backend vira mensagem genérica, sem detalhe", async ({ page }) => {
    await open(page, ROOMS_PATH);
    await page.route(
      (url) => url.href.startsWith(API_URL) && url.pathname.endsWith(`/v1/rooms/${ROOM_IDS.other}/deactivate`),
      (route) =>
        route.fulfill({
          status: 403,
          headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
          body: JSON.stringify({ error: { code: "FORBIDDEN", message: "detalhe técnico cru" } }),
        }),
    );
    await page.getByRole("button", { name: "Inativar Auditório Sintético" }).click();
    const dialog = page.getByRole("dialog", { name: "Inativar sala" });
    await dialog.getByRole("button", { name: "Inativar" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Você não tem permissão para esta ação.");
    await expect(page.getByText("detalhe técnico cru")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Pessoas responsáveis
// ---------------------------------------------------------------------------

test.describe("responsáveis — lista e telefone (LGPD)", () => {
  test("telefone só mascarado na lista; número completo não aparece na página nem em storage/cookies", async ({ page }) => {
    await open(page, PEOPLE_PATH);
    const table = page.getByRole("table", { name: "Pessoas responsáveis" });
    await expect(table.getByRole("columnheader", { name: "Telefone" })).toBeVisible();
    const row = table.getByRole("row").filter({ hasText: "ID-0001" });
    await expect(row.getByTestId("telefone-mascarado")).toHaveText("(••) •••••-4567");
    await expect(row).toContainText("PSU-TO — Procuradoria Seccional Sintética de Palmas");
    await expect(row).toContainText("Ativo");
    await expect(table.getByRole("row").filter({ hasText: "Inativa Sintética" })).toContainText("Inativo");
    await expect(table.getByRole("row").filter({ hasText: "Sem Telefone" }).getByTestId("telefone-mascarado")).toHaveText("—");

    const leaks = await page.evaluate(
      ([digits]) => {
        const haystack = [
          document.body.innerText,
          JSON.stringify({ ...window.localStorage }),
          JSON.stringify({ ...window.sessionStorage }),
          document.cookie,
        ].join("|");
        return haystack.includes(digits!) || haystack.includes("99123-4567");
      },
      [PERSON_PHONE],
    );
    expect(leaks).toBe(false);
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("sem a chave phone (não é ADM): coluna e campo de telefone não existem", async ({ page }) => {
    await open(page, PEOPLE_PATH, { role: "ADM", catalogHidePhone: true });
    const table = page.getByRole("table", { name: "Pessoas responsáveis" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Telefone" })).toHaveCount(0);
    await page.getByRole("button", { name: "Editar Responsável Sem Telefone" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar pessoa responsável" });
    await expect(dialog.getByLabel("Nome")).toBeVisible();
    await expect(dialog.getByLabel("Telefone")).toHaveCount(0);
  });

  test("busca por nome/e-mail, unidade e situação enviam a allowlist", async ({ page }) => {
    await open(page, PEOPLE_PATH);
    const rows = page.getByRole("table", { name: "Pessoas responsáveis" }).locator("tbody tr");
    await expect(rows).toHaveCount(4);
    const search = waitApi(page, "GET", "/v1/responsible-people");
    await page.getByLabel("Buscar pessoa por nome ou e-mail").fill("inativa.sint");
    expect(new URL((await search).url()).searchParams.get("q")).toBe("inativa.sint");
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    const byUnit = waitApi(page, "GET", "/v1/responsible-people");
    await page.getByLabel("Unidade", { exact: true }).selectOption({ label: "PSU-TO — Procuradoria Seccional Sintética de Palmas" });
    expect(new URL((await byUnit).url()).searchParams.get("unit_id")).toBe(U1.id);
    await expect(rows).toHaveCount(2);
    const sorted = waitApi(page, "GET", "/v1/responsible-people");
    await page.getByRole("columnheader", { name: /E-mail/ }).getByRole("button").click();
    expect(new URL((await sorted).url()).searchParams.get("sort")).toBe("email");
  });
});

test.describe("responsáveis — criar, editar, inativar", () => {
  test("criar envia o telefone ao backend; duplicidade (409) tem mensagem própria", async ({ page }) => {
    const state = await open(page, PEOPLE_PATH);
    await page.getByRole("button", { name: "Nova pessoa" }).click();
    const dialog = page.getByRole("dialog", { name: "Nova pessoa responsável" });
    await dialog.getByRole("button", { name: "Criar pessoa" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Informe o nome." })).toBeVisible();
    expect(calls(state, "POST", "/v1/responsible-people")).toHaveLength(0);

    await dialog.getByLabel("Unidade").selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    await dialog.getByLabel("Nome").fill("Pessoa Nova Sintética");
    await dialog.getByLabel("E-mail").fill("nova.sintetica@exemplo.invalid");
    await dialog.getByLabel("Telefone").fill("(63) 98888-0000");
    const req = waitApi(page, "POST", "/v1/responsible-people");
    await dialog.getByRole("button", { name: "Criar pessoa" }).click();
    expect((await req).postDataJSON()).toEqual({
      unit_id: U2.id,
      name: "Pessoa Nova Sintética",
      email: "nova.sintetica@exemplo.invalid",
      phone: "(63) 98888-0000",
    });
    await expect(page.getByText("Pessoa responsável criada.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Pessoas responsáveis" }).getByText("Pessoa Nova Sintética")).toBeVisible();

    await page.getByRole("button", { name: "Nova pessoa" }).click();
    const again = page.getByRole("dialog", { name: "Nova pessoa responsável" });
    await again.getByLabel("Unidade").selectOption({ label: "ESC-02 — Escritório Sintético Avançado" });
    await again.getByLabel("Nome").fill("Outra Pessoa");
    await again.getByLabel("E-mail").fill("nova.sintetica@exemplo.invalid");
    await again.getByRole("button", { name: "Criar pessoa" }).click();
    await expect(again.getByRole("alert")).toHaveText(
      "Já existe uma pessoa responsável com estes dados (e-mail ou identificador institucional). Revise e tente de novo.",
    );
  });

  test("e-mail inválido é barrado no cliente (UX) e telefone inválido é recusado pelo backend (400)", async ({ page }) => {
    const state = await open(page, PEOPLE_PATH);
    await page.getByRole("button", { name: "Editar Responsável Sem Telefone" }).click();
    const dialog = page.getByRole("dialog", { name: "Editar pessoa responsável" });
    await dialog.getByLabel("E-mail").fill("isto-nao-e-email");
    await dialog.getByRole("button", { name: "Salvar pessoa" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Informe um e-mail válido." })).toBeVisible();
    expect(calls(state, "PATCH", "/v1/responsible-people/")).toHaveLength(0);

    await dialog.getByLabel("E-mail").fill("valido.sintetico@exemplo.invalid");
    await dialog.getByLabel("Telefone").fill("123");
    await dialog.getByRole("button", { name: "Salvar pessoa" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Os dados enviados não foram aceitos. Revise os campos e tente novamente.",
    );
  });

  test("editar: telefone preenchido para o ADM; PATCH só com o que mudou (sem unit_id/source)", async ({ page }) => {
    const state = await open(page, PEOPLE_PATH);
    await page.getByRole("button", { name: /^Editar Pessoa Responsável Sintética/ }).click();
    const dialog = page.getByRole("dialog", { name: "Editar pessoa responsável" });
    await expect(dialog.getByLabel("Telefone")).toHaveValue("(63) 99123-4567");
    await expect(dialog).toContainText("resp-linha-2");
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    const save = dialog.getByRole("button", { name: "Salvar pessoa" });
    await expect(save).toBeDisabled();

    // Reformatar o mesmo número não é alteração.
    await dialog.getByLabel("Telefone").fill("63 99123 4567");
    await expect(save).toBeDisabled();
    await dialog.getByLabel("Telefone").fill("(63) 3333-1111");
    const req = waitApi(page, "PATCH", `/v1/responsible-people/${PERSON_IDS.a}`);
    await save.click();
    expect((await req).postDataJSON()).toEqual({
      expected_updated_at: "2026-10-01T12:10:00.000Z",
      phone: "(63) 3333-1111",
    });
    await expect(page.getByText("Pessoa responsável atualizada.")).toBeVisible();
    expect(state.people.find((p) => p.id === PERSON_IDS.a)?.phone).toBe("6333331111");

    // Limpar um opcional envia null.
    await page.getByRole("button", { name: /^Editar Pessoa Responsável Sintética/ }).click();
    const again = page.getByRole("dialog", { name: "Editar pessoa responsável" });
    await again.getByLabel("Identificador institucional").fill("");
    const clear = waitApi(page, "PATCH", `/v1/responsible-people/${PERSON_IDS.a}`);
    await again.getByRole("button", { name: "Salvar pessoa" }).click();
    expect(((await clear).postDataJSON() as Record<string, unknown>).institutional_identifier).toBeNull();
  });

  test("inativar/reativar: texto claro de preservação e sem DELETE", async ({ page }) => {
    const state = await open(page, PEOPLE_PATH);
    await page.getByRole("button", { name: "Inativar Responsável Sem Telefone" }).click();
    const dialog = page.getByRole("dialog", { name: "Inativar pessoa responsável" });
    await expect(dialog).toContainText("NÃO é excluída");
    const req = waitApi(page, "POST", `/v1/responsible-people/${PERSON_IDS.noPhone}/deactivate`);
    await dialog.getByRole("button", { name: "Inativar" }).click();
    await req;
    const row = page.getByRole("table", { name: "Pessoas responsáveis" }).getByRole("row").filter({ hasText: "Sem Telefone" });
    await expect(row).toContainText("Inativo");
    await row.getByRole("button", { name: "Reativar Responsável Sem Telefone" }).click();
    await page.getByRole("dialog", { name: "Reativar pessoa responsável" }).getByRole("button", { name: "Reativar" }).click();
    await expect(row).toContainText("Ativo");
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unidades
// ---------------------------------------------------------------------------

test.describe("unidades", () => {
  test("lista ativas e inativas com situação em texto; XSS inerte", async ({ page }) => {
    await open(page, UNITS_PATH);
    const table = page.getByRole("table", { name: "Unidades" });
    await expect(table.locator("tbody tr")).toHaveCount(4);
    await expect(table).toContainText("PSU-TO");
    await expect(table).toContainText("Escritório Sintético Avançado");
    await expect(table.getByRole("row").filter({ hasText: "INAT-07" })).toContainText("Inativa");
    await expect(table.getByRole("row").filter({ hasText: "ESC-02" })).toContainText("Ativa");
    await expect(page.getByText("4 unidade(s)")).toBeVisible();
    expect(await expectNoXss(page)).toEqual({ executed: undefined, injectedImgs: 0 });
  });

  test("busca no servidor com debounce, situação e ordenação enviam só a allowlist", async ({ page }) => {
    const state = await open(page, UNITS_PATH);
    const rows = page.getByRole("table", { name: "Unidades" }).locator("tbody tr");
    await expect(rows).toHaveCount(4);

    const search = waitApi(page, "GET", "/v1/units/catalog");
    await page.getByLabel("Buscar unidade por sigla ou nome").fill("inat-");
    expect(new URL((await search).url()).searchParams.get("q")).toBe("inat-");
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(rows).toHaveCount(4);

    const group = page.getByRole("group", { name: "Filtrar por situação" });
    const inactive = waitApi(page, "GET", "/v1/units/catalog");
    await group.getByRole("button", { name: "Inativas" }).click();
    expect(new URL((await inactive).url()).searchParams.get("active")).toBe("false");
    await expect(group.getByRole("button", { name: "Inativas" })).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(1);
    const active = waitApi(page, "GET", "/v1/units/catalog");
    await group.getByRole("button", { name: "Ativas", exact: true }).click();
    expect(new URL((await active).url()).searchParams.get("active")).toBe("true");
    await expect(rows).toHaveCount(3);
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    const codeHeader = page.getByRole("columnheader", { name: /Sigla/ });
    const sorted = waitApi(page, "GET", "/v1/units/catalog");
    await codeHeader.getByRole("button").click();
    expect(new URL((await sorted).url()).searchParams.get("sort")).toBe("code");
    await expect(codeHeader).toHaveAttribute("aria-sort", "ascending");

    const allowed = new Set(["q", "active", "sort", "page", "page_size"]);
    for (const call of calls(state, "GET", "/v1/units/catalog")) {
      for (const key of new URL(call.url, "http://x").searchParams.keys()) expect(allowed.has(key)).toBe(true);
    }
    // O seletor `GET /v1/units` não é usado por esta tela.
    expect(state.calls.some((c) => c.method === "GET" && /\/v1\/units(\?|$)/.test(c.url))).toBe(false);
  });

  test("filtro sem resultado mostra estado vazio com orientação", async ({ page }) => {
    await open(page, UNITS_PATH);
    await page.getByLabel("Buscar unidade por sigla ou nome").fill("nada-corresponde");
    await expect(page.getByText("Nenhuma unidade encontrada para os filtros atuais.")).toBeVisible();
  });

  test("reativar unidade inativa pela linha: POST activate com expected_updated_at", async ({ page }) => {
    const state = await open(page, UNITS_PATH);
    const row = page.getByRole("table", { name: "Unidades" }).getByRole("row").filter({ hasText: "INAT-07" });
    await row.getByRole("button", { name: /Reativar INAT-07/ }).click();
    const confirm = page.getByRole("dialog", { name: "Reativar unidade" });
    const req = waitApi(page, "POST", `/v1/units/${INACTIVE_UNIT.id}/activate`);
    await confirm.getByRole("button", { name: "Reativar" }).click();
    expect((await req).postDataJSON()).toEqual({ expected_updated_at: "2026-10-01T12:20:00.000Z" });
    await expect(page.getByText("Registro reativado.")).toBeVisible();
    await expect(row).toContainText("Ativa");
    await expect(row.getByRole("button", { name: /Inativar INAT-07/ })).toBeVisible();
    expect(state.unitDetails[INACTIVE_UNIT.id]?.active).toBe(true);
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("reativar unidade inativa pelo diálogo de edição", async ({ page }) => {
    const state = await open(page, UNITS_PATH);
    await page.getByRole("button", { name: /Gerenciar INAT-07/ }).click();
    const dialog = page.getByRole("dialog", { name: "Editar unidade" });
    await expect(dialog.getByRole("button", { name: "Reativar unidade" })).toBeVisible();
    await dialog.getByRole("button", { name: "Reativar unidade" }).click();
    await page.getByRole("dialog", { name: "Reativar unidade" }).getByRole("button", { name: "Reativar" }).click();
    await expect(page.getByText("Registro reativado.")).toBeVisible();
    expect(state.unitDetails[INACTIVE_UNIT.id]?.active).toBe(true);
  });

  test("editar: sigla/origem imutáveis, endereço só ADM; PATCH só com o que mudou", async ({ page }) => {
    const state = await open(page, UNITS_PATH);
    await page.getByRole("button", { name: /Gerenciar ESC-02/ }).click();
    const dialog = page.getByRole("dialog", { name: "Editar unidade" });
    await expect(dialog.getByLabel("Nome")).toHaveValue("Escritório Sintético Avançado");
    await expect(dialog).toContainText("ESC-02");
    await expect(dialog).toContainText("origem-esc-02");
    await expect(dialog.getByLabel("Endereço")).toHaveValue(/Quadra sintética 100 Norte/);
    // Sigla não é campo editável.
    await expect(dialog.getByRole("textbox", { name: /Sigla/ })).toHaveCount(0);
    const save = dialog.getByRole("button", { name: "Salvar unidade" });
    await expect(save).toBeDisabled();

    await dialog.getByLabel("Nome").fill("Escritório Sintético Renomeado");
    const req = waitApi(page, "PATCH", `/v1/units/${U2.id}`);
    await save.click();
    const body = (await req).postDataJSON();
    expect(body).toEqual({ expected_updated_at: "2026-10-01T12:10:00.000Z", name: "Escritório Sintético Renomeado" });
    expect(Object.keys(body)).not.toContain("code");
    await expect(page.getByText("Unidade atualizada.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Unidades" })).toContainText("Escritório Sintético Renomeado");
    expect(state.unitDetails[U2.id]?.name).toBe("Escritório Sintético Renomeado");
  });

  test("sem a chave address o campo de endereço não existe", async ({ page }) => {
    await open(page, UNITS_PATH, { role: "ADM", catalogHideAddress: true });
    await page.getByRole("button", { name: /Gerenciar ESC-02/ }).click();
    const dialog = page.getByRole("dialog", { name: "Editar unidade" });
    await expect(dialog.getByLabel("Nome")).toBeVisible();
    await expect(dialog.getByLabel("Endereço")).toHaveCount(0);
  });

  test("inativar: confirmação preserva o registro; a unidade sai da lista ativa e do seletor", async ({ page }) => {
    const state = await open(page, UNITS_PATH);
    await page.getByRole("button", { name: /Gerenciar ESC-02/ }).click();
    await page.getByRole("button", { name: "Inativar unidade" }).click();
    const confirm = page.getByRole("dialog", { name: "Inativar unidade" });
    await expect(confirm).toContainText("NÃO é excluída");
    const req = waitApi(page, "POST", `/v1/units/${U2.id}/deactivate`);
    await confirm.getByRole("button", { name: "Inativar" }).click();
    expect((await req).postDataJSON()).toEqual({ expected_updated_at: "2026-10-01T12:10:00.000Z" });
    await expect(page.getByText("Registro inativado. Ele foi preservado.")).toBeVisible();
    // Continua na lista (situação "Todas"), agora como inativa.
    const row = page.getByRole("table", { name: "Unidades" }).getByRole("row").filter({ hasText: "ESC-02" });
    await expect(row).toContainText("Inativa");
    expect(state.unitDetails[U2.id]?.active).toBe(false);
    expect(state.units.some((u) => u.id === U2.id)).toBe(false);
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("conflito de versão ao salvar: recarrega e avisa", async ({ page }) => {
    const state = await open(page, UNITS_PATH);
    await page.getByRole("button", { name: /Gerenciar PSU-TO/ }).click();
    const dialog = page.getByRole("dialog", { name: "Editar unidade" });
    await expect(dialog.getByLabel("Nome")).toBeVisible();
    state.unitDetails[U1.id]!.updated_at = "2026-10-05T00:00:00.000Z";
    state.unitDetails[U1.id]!.description = "Descrição alterada por outra pessoa";
    await dialog.getByLabel("Nome").fill("Procuradoria Renomeada");
    await dialog.getByRole("button", { name: "Salvar unidade" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Outra pessoa alterou este registro" })).toBeVisible();
    await expect(dialog.getByLabel("Descrição")).toHaveValue("Descrição alterada por outra pessoa");
  });

  for (const role of ["USER", "RH"] as const) {
    test(`${role}: tela nega por padrão e não consulta o backend`, async ({ page }) => {
      const state = await open(page, UNITS_PATH, { role });
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Você não tem permissão");
      expect(state.calls.some((c) => c.url.startsWith("/api/v1/units"))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

test.describe("menu — cadastros de apoio", () => {
  test("ADM vê os três itens em Administração; USER não vê", async ({ page }) => {
    await open(page, "/", { role: "ADM" });
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    await nav.getByRole("button", { name: "Administração" }).click();
    for (const label of ["Cadastro de Unidades", "Cadastro de Salas", "Cadastro de Responsáveis"]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("USER: sem o grupo Administração", async ({ page }) => {
    await open(page, "/", { role: "USER" });
    const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
    await expect(nav.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Administração" })).toHaveCount(0);
  });
});
