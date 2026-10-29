import type { Page, Route } from "@playwright/test";

// =============================================================================
// Mocks SINTÉTICOS dos painéis do catálogo (ONDA 3). Nada é real. Espelham
// docs/architecture/dashboard-api.md:
//   GET  /api/v1/dashboard/panels
//   GET  /api/v1/dashboard/panels/<id>/data?unit_id&familia&categoria
//   GET  /api/v1/dashboard/panels/<id>/export?format=csv|xlsx
//   GET  /api/v1/dashboard/classificacao/revisao?page&page_size&unit_id&sort
//   GET  /api/v1/dashboard/classificacao/revisao/export
//   POST /api/v1/assets/<id>/category-override {category, version}
// Como o backend: 404 para painel proibido ao perfil, parâmetro desconhecido ->
// 400. Arquivo próprio (dentro de e2e/dashboard-*) para não colidir com os
// mocks compartilhados.
// =============================================================================

export type Role = "ADM" | "USER" | "RH";
type Size = "P" | "M" | "G";
const ALL: Role[] = ["ADM", "USER", "RH"];

interface Entry {
  id: string;
  label: string;
  description: string;
  group: string;
  sizes: Size[];
  default_size: Size;
  exportable: boolean;
  roles: Role[];
}

export const CATALOG: Entry[] = [
  { id: "kpi_workstations", label: "Postos de trabalho", description: "Computadores, Notebooks e Monitores.", group: "indicadores", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ALL },
  { id: "kpi_infrastructure", label: "Infraestrutura de TI", description: "Impressoras, Nobreaks e outros.", group: "indicadores", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ALL },
  { id: "kpi_furniture", label: "Mobiliário", description: "Gaveteiros, Armários, Mesas e Estações.", group: "indicadores", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ALL },
  { id: "equipment_by_unit_table", label: "Equipamentos de TI por unidade", description: "Tabela com exportação.", group: "tabelas", sizes: ["M", "G"], default_size: "G", exportable: true, roles: ALL },
  { id: "furniture_by_unit_table", label: "Mobiliário por unidade", description: "Tabela com exportação.", group: "tabelas", sizes: ["M", "G"], default_size: "G", exportable: true, roles: ALL },
  { id: "equipment_by_unit_chart", label: "Equipamentos por unidade (gráfico)", description: "Barras agrupadas.", group: "graficos", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "located_by_unit_chart", label: "Localização dos bens por unidade", description: "Barras por situação de localização; clique lista os bens.", group: "graficos", sizes: ["P", "M", "G"], default_size: "G", exportable: false, roles: ALL },
  { id: "category_distribution", label: "Distribuição por categoria", description: "Percentual por família e categoria.", group: "graficos", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ALL },
  { id: "notebooks_without_docking", label: "Notebooks sem docking", description: "Estimativa por unidade.", group: "analises", sizes: ["P", "M", "G"], default_size: "M", exportable: false, roles: ["ADM", "USER"] },
  { id: "workstation_ratio", label: "Monitores por computador", description: "Razão por posto.", group: "analises", sizes: ["P", "M", "G"], default_size: "P", exportable: false, roles: ["ADM", "USER"] },
  { id: "unclassified_review", label: "Pendentes de revisão", description: "Bens OUTROS com baixa confiança.", group: "administracao", sizes: ["M", "G"], default_size: "M", exportable: false, roles: ["ADM"] },
  { id: "classification_overrides", label: "Correções manuais de categoria", description: "Últimas correções.", group: "administracao", sizes: ["M", "G"], default_size: "M", exportable: false, roles: ["ADM"] },
  { id: "sync_status", label: "Sincronização do Sheets", description: "Última importação e divergências.", group: "administracao", sizes: ["P", "M", "G"], default_size: "P", exportable: false, roles: ["ADM"] },
];

const TI_COLS = [
  { id: "COMPUTADOR", label: "Computador" },
  { id: "NOTEBOOK", label: "Notebook" },
  { id: "MONITOR", label: "Monitor" },
];
const MOB_COLS = [
  { id: "MESA", label: "Mesa" },
  { id: "ARMARIO", label: "Armário" },
];

const unitRow = (unidade: string, vals: Record<string, number>) => ({
  unidade,
  total: Object.values(vals).reduce((a, b) => a + b, 0),
  valores: vals,
});

// ---------------------------------------------------------------------------
// Painel de localização (located_by_unit_chart): dados e registros SINTÉTICOS.
// ---------------------------------------------------------------------------

export const PFN_UNIT_ID = "60000000-0000-4000-8000-000000000001";
export const CGU_UNIT_ID = "60000000-0000-4000-8000-000000000002";
export const LOCATED_SERIES = [
  { id: "SIM", label: "Localizados" },
  { id: "NAO", label: "Não localizados" },
  { id: "DESCONHECIDO", label: "Não informado" },
];
const LOCATED_COUNTS: { unidade: string; unit_id: string | null; v: Record<string, number> }[] = [
  { unidade: "PFN-TO", unit_id: PFN_UNIT_ID, v: { SIM: 120, NAO: 12, DESCONHECIDO: 3 } },
  { unidade: "CGU-TO", unit_id: CGU_UNIT_ID, v: { SIM: 5, NAO: 0, DESCONHECIDO: 2 } },
  { unidade: "Outras", unit_id: null, v: { SIM: 4, NAO: 2, DESCONHECIDO: 0 } },
];
export const LOCATED_CHART = {
  familia: "TI",
  familia_label: "Tecnologia da Informação",
  series: LOCATED_SERIES,
  unidades: LOCATED_COUNTS.map((u) => ({
    unidade: u.unidade,
    unit_id: u.unit_id,
    total: Object.values(u.v).reduce((a, b) => a + b, 0),
    valores: u.v,
  })),
  total: 148,
};

interface LocatedMockRecord {
  id: string;
  patrimony_number: string;
  description: string | null;
  unidade: string;
  sala: string | null;
  located: string;
  equipment_category: string | null;
  classification_confidence: string | null;
  group: string;
}

function makeLocatedRecords(): LocatedMockRecord[] {
  const out: LocatedMockRecord[] = [];
  let n = 0;
  for (const u of LOCATED_COUNTS) {
    for (const [located, count] of Object.entries(u.v)) {
      for (let i = 0; i < count; i++) {
        n += 1;
        out.push({
          id: `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
          patrimony_number: String(100000 + n),
          description: `Bem sintético ${n}`,
          unidade: u.unit_id === null ? `Unidade extra ${i % 2}` : u.unidade,
          sala: i % 3 === 0 ? null : `Sala ${i % 5}`,
          located,
          equipment_category: i % 2 ? "NOTEBOOK" : "MONITOR",
          classification_confidence: "ALTA",
          group: u.unit_id ?? "outras",
        });
      }
    }
  }
  return out;
}

export interface LocatedRecordsMock {
  /** Status forçado (404/500...). */
  status: number | null;
  /** Sempre página vazia (200, total 0). */
  empty: boolean;
  /** Substitui a descrição dos registros (XSS). */
  description?: string;
  /** Query strings recebidas. */
  calls: string[];
}

export function defaultLocatedRecordsMock(init: Partial<LocatedRecordsMock> = {}): LocatedRecordsMock {
  return { status: null, empty: false, calls: [], ...init };
}

const LOCATED_DATA = makeLocatedRecords();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Espelha o contrato de GET .../located_by_unit_chart/records (validação rígida, página vazia = 200). */
export function locatedRecordsReply(query: URLSearchParams, mock: LocatedRecordsMock): { status: number; body: unknown } {
  mock.calls.push(query.toString());
  const bad = { status: 400, body: { error: { code: "validation_error", message: "SISPAT_BACKEND_MSG" } } };
  if (mock.status) return { status: mock.status, body: { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } } };
  const allowed = new Set(["unit_id", "located", "familia", "categoria", "page", "page_size", "sort"]);
  if ([...query.keys()].some((k) => !allowed.has(k))) return bad;
  const unit = query.get("unit_id");
  if (!unit || (unit !== "outras" && !UUID_RE.test(unit))) return bad;
  const located = query.get("located");
  if (located && !["SIM", "NAO", "DESCONHECIDO"].includes(located)) return bad;
  const pageSize = Number(query.get("page_size") ?? 50);
  const page = Number(query.get("page") ?? 1);
  if (![50, 100, 200].includes(pageSize) || !Number.isInteger(page) || page < 1) return bad;
  const sort = query.get("sort") ?? "patrimony_number";
  if (!/^-?(patrimony_number|description|located)$/.test(sort)) return bad;
  let rows = mock.empty ? [] : LOCATED_DATA.filter((r) => r.group === unit && (!located || r.located === located));
  const field = sort.replace("-", "") as "patrimony_number" | "description" | "located";
  rows = [...rows].sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (sort.startsWith("-") ? -1 : 1));
  const items = rows.slice((page - 1) * pageSize, page * pageSize).map(({ group: _g, ...r }) => ({
    ...r,
    description: mock.description ?? r.description,
  }));
  return {
    status: 200,
    body: { items, total: rows.length, page, page_size: pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)) },
  };
}

export function panelPayload(id: string): { tipo: string; dados: unknown } {
  switch (id) {
    case "kpi_workstations":
      return { tipo: "cartoes", dados: { itens: [{ id: "COMPUTADOR", label: "Computador", value: 120 }, { id: "NOTEBOOK", label: "Notebook", value: 80 }, { id: "MONITOR", label: "Monitor", value: 200 }], total: 400 } };
    case "kpi_infrastructure":
      return { tipo: "cartoes", dados: { itens: [{ id: "IMPRESSORA", label: "Impressora", value: 30 }, { id: "NOBREAK", label: "Nobreak", value: 0 }], total: 30 } };
    case "kpi_furniture":
      return { tipo: "cartoes", dados: { itens: [{ id: "MESA", label: "Mesa", value: 55 }, { id: "ARMARIO", label: "Armário", value: 12 }], total: 67 } };
    case "equipment_by_unit_table": {
      const linhas = [unitRow("PFN-TO", { COMPUTADOR: 20, NOTEBOOK: 10, MONITOR: 31 }), unitRow("CGU-TO", { COMPUTADOR: 5, NOTEBOOK: 0, MONITOR: 7 })];
      return { tipo: "tabela", dados: { colunas: TI_COLS, linhas, total: 73 } };
    }
    case "furniture_by_unit_table": {
      const linhas = [unitRow("PFN-TO", { MESA: 9, ARMARIO: 3 })];
      return { tipo: "tabela", dados: { colunas: MOB_COLS, linhas, total: 12 } };
    }
    case "equipment_by_unit_chart":
      return { tipo: "grafico", dados: { familia: "TI", familia_label: "Tecnologia da Informação", series: TI_COLS, unidades: [unitRow("PFN-TO", { COMPUTADOR: 20, NOTEBOOK: 10, MONITOR: 31 }), unitRow("CGU-TO", { COMPUTADOR: 5, NOTEBOOK: 0, MONITOR: 7 })], total: 73 } };
    case "located_by_unit_chart":
      return { tipo: "grafico", dados: LOCATED_CHART };
    case "category_distribution":
      return { tipo: "distribuicao", dados: { total: 200, familias: [{ id: "TI", label: "Tecnologia da Informação", value: 150, percentual: 75.0 }, { id: "MOBILIARIO", label: "Mobiliário", value: 50, percentual: 25.0 }], categorias: [{ id: "COMPUTADOR", label: "Computador", familia: "TI", value: 100, percentual: 50.0 }, { id: "MESA", label: "Mesa", familia: "MOBILIARIO", value: 50, percentual: 25.0 }] } };
    case "notebooks_without_docking":
      return { tipo: "ranking", dados: { metodo: "diferenca_de_contagens_por_unidade", notebooks: 80, docking: 30, sem_docking: 50, por_unidade: [{ unidade: "PFN-TO", notebooks: 50, docking: 10, sem_docking: 40 }] } };
    case "workstation_ratio":
      return { tipo: "razao", dados: { computadores: 120, notebooks: 0, monitores: 200, monitores_por_computador: 1.67, monitores_por_notebook: null } };
    case "unclassified_review":
      return { tipo: "fila", dados: { total_pendentes: 7, por_unidade: [{ unidade: "PFN-TO", value: 7 }] } };
    case "classification_overrides":
      return { tipo: "lista", dados: { total: 2, por_categoria: [{ id: "MESA", label: "Mesa", value: 2 }], recentes: [{ asset_id: "a1", patrimony_number: "000123", description: "Mesa de reunião", categoria_anterior: "Outros", categoria_nova: "Mesa", em: "2026-10-26T15:00:00+00:00" }] } };
    case "sync_status":
      return { tipo: "status", dados: { ultima_importacao: { confirmada_em: "2026-10-25T12:00:00+00:00", linhas: 100, novos: 10, existentes: 80, duplicados: 5, invalidos: 3, conflitantes: 2 }, ultimo_job: null, conflitos_pendentes: 4 } };
    default:
      return { tipo: "cartoes", dados: { itens: [], total: 0 } };
  }
}

// ---------------------------------------------------------------------------
// Handlers do catálogo para os mocks COMPARTILHADOS (support/mocks.ts): mesma
// fonte (`CATALOG` + `panelPayload`) de `mockEquipment`, sem duplicar dados.
//   GET /v1/dashboard/panels · GET /v1/dashboard/panels/<id>/data ·
//   PUT /v1/dashboard/preferences
// ---------------------------------------------------------------------------

export interface PanelPrefMock {
  id: string;
  visible: boolean;
  size: Size;
}

export interface PanelsMockState {
  version: number;
  /** Preferências efetivas; `null` = padrão do perfil. */
  panels: PanelPrefMock[] | null;
  /** Status forçado em `GET /dashboard/panels`. */
  catalogStatus: number | null;
  /** `data` por painel: status forçado (ex.: 500) ou "empty". */
  dataStatus: Record<string, number | "empty">;
  /** Status forçado em `PUT /dashboard/preferences`. */
  putStatus: number | null;
  delayDataMs: number;
  /** Corpo CRU devolvido por `GET /dashboard/panels` (resposta inválida/maliciosa), quando definido. */
  rawCatalog?: unknown;
  /** Substitui `{tipo, dados}` de um painel (ex.: rótulos maliciosos). */
  payloadOverride?: Record<string, { tipo: string; dados: unknown }>;
  /** Chamadas recebidas (para asserções): método + caminho + query. */
  calls: { method: string; url: string; body?: unknown }[];
  /** Registros do painel de localização. */
  located: LocatedRecordsMock;
}

export function defaultPanelsMock(init: Partial<PanelsMockState> = {}): PanelsMockState {
  return { version: 0, panels: null, catalogStatus: null, dataStatus: {}, putStatus: null, delayDataMs: 0, calls: [], located: defaultLocatedRecordsMock(), ...init };
}

const EMPTY_PAYLOADS: Record<string, unknown> = {
  cartoes: { itens: [], total: 0 },
  tabela: { colunas: TI_COLS, linhas: [], total: 0 },
  grafico: { familia: "TI", familia_label: "Tecnologia da Informação", series: TI_COLS, unidades: [], total: 0 },
  distribuicao: { total: 0, familias: [], categorias: [] },
  ranking: { metodo: "x", notebooks: 0, docking: 0, sem_docking: 0, por_unidade: [] },
  razao: { computadores: 0, notebooks: 0, monitores: 0, monitores_por_computador: null, monitores_por_notebook: null },
  lista: { total: 0, por_categoria: [], recentes: [] },
};

export interface PanelsApiRequest {
  panels: PanelsMockState;
  role: Role;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  respond: (status: number, payload: unknown) => Promise<void>;
}

/** `true` quando a rota é do catálogo de painéis (e já foi respondida). */
export async function handleDashboardPanels(req: PanelsApiRequest): Promise<boolean> {
  const { panels: st, role, method, path, query, body, respond } = req;
  const err = (status: number, code: string) => respond(status, { error: { code, message: "SISPAT_BACKEND_MSG" } });
  const allowed = CATALOG.filter((c) => c.roles.includes(role));
  const defaults: PanelPrefMock[] = allowed.map((c) => ({ id: c.id, visible: true, size: c.default_size }));
  if (path.startsWith("/v1/dashboard/panels") || path === "/v1/dashboard/preferences") {
    st.calls.push({ method, url: path + (query.size ? `?${query.toString()}` : ""), body });
  }

  if (path === "/v1/dashboard/panels" && method === "GET") {
    if (st.catalogStatus) return (await err(st.catalogStatus, "INTERNAL")), true;
    if (st.rawCatalog !== undefined) return (await respond(200, st.rawCatalog)), true;
    await respond(200, {
      panels: allowed.map(({ roles: _roles, ...entry }) => entry),
      sizes: ["P", "M", "G"],
      default_layout: defaults,
      preferences: { panels: st.panels ?? defaults, version: st.version },
    });
    return true;
  }

  const data = path.match(/^\/v1\/dashboard\/panels\/([a-z_]+)\/data$/);
  if (data && method === "GET") {
    const id = data[1]!;
    if (st.delayDataMs) await new Promise((r) => setTimeout(r, st.delayDataMs));
    const allowedKeys = new Set(["unit_id", "familia", "categoria"]);
    if ([...query.keys()].some((k) => !allowedKeys.has(k))) return (await err(400, "validation_error")), true;
    if (!allowed.some((c) => c.id === id)) return (await err(404, "not_found")), true;
    const forced = st.dataStatus[id];
    if (typeof forced === "number") return (await err(forced, "INTERNAL")), true;
    const payload = st.payloadOverride?.[id] ?? panelPayload(id);
    await respond(200, {
      panel_id: id,
      tipo: payload.tipo,
      dados: forced === "empty" ? (EMPTY_PAYLOADS[payload.tipo] ?? payload.dados) : payload.dados,
      filtros_aplicados: forced === "empty" ? [] : [...query.keys()],
    });
    return true;
  }

  if (path === "/v1/dashboard/panels/located_by_unit_chart/records" && method === "GET") {
    if (!allowed.some((c) => c.id === "located_by_unit_chart")) return (await err(404, "not_found")), true;
    const r = locatedRecordsReply(query, st.located);
    await respond(r.status, r.body);
    return true;
  }

  if (path === "/v1/dashboard/preferences" && method === "PUT") {
    if (st.putStatus) return (await err(st.putStatus, st.putStatus === 409 ? "version_conflict" : "INTERNAL")), true;
    const incoming = (body ?? {}) as { version?: number; panels?: PanelPrefMock[]; restore_default?: boolean };
    if (incoming.version !== st.version) return (await err(409, "version_conflict")), true;
    if (incoming.restore_default) {
      st.panels = null;
    } else {
      const list = incoming.panels ?? [];
      const permitted = new Map(allowed.map((c) => [c.id, c]));
      if (list.some((p) => !permitted.has(p.id))) return (await err(403, "panel_forbidden")), true;
      if (!list.some((p) => p.visible) || list.some((p) => !permitted.get(p.id)!.sizes.includes(p.size))) {
        return (await err(400, "validation_error")), true;
      }
      st.panels = [...list, ...defaults.filter((d) => !list.some((p) => p.id === d.id))];
    }
    st.version += 1;
    await respond(200, { panels: st.panels ?? defaults, version: st.version });
    return true;
  }
  return false;
}

export const CATEGORIES = [
  { id: "NOTEBOOK", label: "Notebook", familia: "TI", familia_label: "Tecnologia da Informação" },
  { id: "MESA", label: "Mesa", familia: "MOBILIARIO", familia_label: "Mobiliário" },
  { id: "OUTROS", label: "Outros", familia: "OUTROS", familia_label: "Outros" },
];

interface QueueItem {
  id: string;
  patrimony_number: string;
  description: string;
  unidade: string;
  equipment_category: string;
  classification_confidence: string;
  version: number;
}

export interface EquipmentState {
  role: Role;
  /** `data` por painel: status forçado (ex.: 500) ou "empty". */
  dataStatus: Record<string, number | "empty">;
  catalogStatus: number | null;
  calls: { method: string; url: string; body?: unknown }[];
  queue: QueueItem[];
  queueStatus: number | null;
  /** Próxima resposta do override: status forçado. */
  overrideStatus: number | null;
  /** Corpo/versão aceitos: se `version` divergir -> 409. */
  overrides: { id: string; body: unknown }[];
  delayData: number;
  /** Registros do painel de localização (status/vazio/XSS). */
  located: LocatedRecordsMock;
  /** Substitui `{tipo, dados}` de um painel (rótulos maliciosos). */
  payloadOverride?: Record<string, { tipo: string; dados: unknown }>;
}

function makeQueue(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    patrimony_number: String(1000 + i),
    description: `Item sem classificação ${i + 1}`,
    unidade: i % 2 ? "CGU-TO" : "PFN-TO",
    equipment_category: "OUTROS",
    classification_confidence: "BAIXA",
    version: 3,
  }));
}

export async function mockEquipment(page: Page, role: Role, init: Partial<EquipmentState> & { queueSize?: number } = {}): Promise<EquipmentState> {
  const { queueSize = 3, ...rest } = init;
  const state: EquipmentState = {
    role,
    dataStatus: {},
    catalogStatus: null,
    calls: [],
    queue: makeQueue(queueSize),
    queueStatus: null,
    overrideStatus: null,
    overrides: [],
    delayData: 0,
    located: defaultLocatedRecordsMock(),
    ...rest,
  };
  const cors = (route: Route) => ({
    "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "authorization,content-type",
    "access-control-expose-headers": "Content-Disposition",
    vary: "origin",
  });
  const reply = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: { ...cors(route), "content-type": "application/json" }, body: JSON.stringify(body) });
  const err = (route: Route, status: number, code: string) =>
    reply(route, status, { error: { code, message: "SISPAT_BACKEND_MSG" } });
  const allowed = CATALOG.filter((c) => c.roles.includes(role));
  const defaults = allowed.map((c) => ({ id: c.id, visible: true, size: c.default_size }));

  await page.route("**/api/v1/dashboard/panels", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    if (method !== "GET") return route.fallback();
    state.calls.push({ method, url: new URL(route.request().url()).pathname });
    if (state.catalogStatus) return err(route, state.catalogStatus, "INTERNAL");
    return reply(route, 200, {
      panels: allowed.map(({ roles: _r, ...entry }) => entry),
      sizes: ["P", "M", "G"],
      default_layout: defaults,
      preferences: { panels: defaults, version: 0 },
    });
  });

  await page.route("**/api/v1/dashboard/panels/*/data**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    const url = new URL(request.url());
    state.calls.push({ method: request.method(), url: url.pathname + url.search });
    const id = url.pathname.split("/").at(-2) ?? "";
    if (state.delayData) await new Promise((r) => setTimeout(r, state.delayData));
    const allowedKeys = new Set(["unit_id", "familia", "categoria"]);
    if ([...url.searchParams.keys()].some((k) => !allowedKeys.has(k))) return err(route, 400, "validation_error");
    if (!allowed.some((c) => c.id === id)) return err(route, 404, "not_found");
    const forced = state.dataStatus[id];
    if (typeof forced === "number") return err(route, forced, "INTERNAL");
    const payload = state.payloadOverride?.[id] ?? panelPayload(id);
    if (forced === "empty") {
      const emptied: Record<string, unknown> = { cartoes: { itens: [], total: 0 }, tabela: { colunas: TI_COLS, linhas: [], total: 0 }, grafico: { familia: "TI", familia_label: "Tecnologia da Informação", series: TI_COLS, unidades: [], total: 0 }, distribuicao: { total: 0, familias: [], categorias: [] }, ranking: { metodo: "x", notebooks: 0, docking: 0, sem_docking: 0, por_unidade: [] }, razao: { computadores: 0, notebooks: 0, monitores: 0, monitores_por_computador: null, monitores_por_notebook: null }, lista: { total: 0, por_categoria: [], recentes: [] } };
      return reply(route, 200, { panel_id: id, tipo: payload.tipo, dados: emptied[payload.tipo] ?? payload.dados, filtros_aplicados: [] });
    }
    return reply(route, 200, { panel_id: id, tipo: payload.tipo, dados: payload.dados, filtros_aplicados: [...url.searchParams.keys()] });
  });

  await page.route("**/api/v1/dashboard/panels/*/records**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    const url = new URL(request.url());
    state.calls.push({ method: request.method(), url: url.pathname + url.search });
    if (state.delayData) await new Promise((r) => setTimeout(r, state.delayData));
    const id = url.pathname.split("/").at(-2) ?? "";
    if (id !== "located_by_unit_chart" || !allowed.some((c) => c.id === id)) return err(route, 404, "not_found");
    const r = locatedRecordsReply(url.searchParams, state.located);
    return reply(route, r.status, r.body);
  });

  await page.route("**/api/v1/dashboard/panels/*/export**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    const url = new URL(request.url());
    state.calls.push({ method: request.method(), url: url.pathname + url.search });
    const format = url.searchParams.get("format");
    const body = format === "xlsx" ? "PK" : "Unidade;Total\r\nPFN-TO;61\r\n";
    return route.fulfill({
      status: 200,
      headers: { ...cors(route), "content-type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8" },
      body,
    });
  });

  await page.route("**/api/v1/dashboard/classificacao/revisao/export**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    state.calls.push({ method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search });
    return route.fulfill({ status: 200, headers: { ...cors(route), "content-type": "text/csv; charset=utf-8" }, body: "Patrimonio\r\n1000\r\n" });
  });

  await page.route(/\/api\/v1\/dashboard\/classificacao\/revisao(\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    const url = new URL(request.url());
    state.calls.push({ method: request.method(), url: url.pathname + url.search });
    if (role !== "ADM") return err(route, 403, "FORBIDDEN");
    if (state.queueStatus) return err(route, state.queueStatus, "INTERNAL");
    const pageSize = Number(url.searchParams.get("page_size") ?? 50);
    const pageNo = Number(url.searchParams.get("page") ?? 1);
    if (![50, 100, 200].includes(pageSize)) return err(route, 400, "validation_error");
    const items = state.queue.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    return reply(route, 200, {
      items,
      total: state.queue.length,
      page: pageNo,
      page_size: pageSize,
      pages: Math.max(1, Math.ceil(state.queue.length / pageSize)),
      categorias: CATEGORIES,
    });
  });

  await page.route(/\/api\/v1\/assets\/[^/]+\/category-override$/, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
    const id = new URL(request.url()).pathname.split("/").at(-2) ?? "";
    const body = request.postDataJSON() as { category: string; version: number };
    state.calls.push({ method: request.method(), url: new URL(request.url()).pathname, body });
    state.overrides.push({ id, body });
    if (state.overrideStatus) {
      const status = state.overrideStatus;
      state.overrideStatus = null;
      if (status === 409) {
        // Outra pessoa já alterou o bem: a versão do servidor avançou.
        const item = state.queue.find((q) => q.id === id);
        if (item) item.version += 1;
      }
      return err(route, status, status === 409 ? "version_conflict" : "FORBIDDEN");
    }
    const item = state.queue.find((q) => q.id === id);
    if (!item || item.version !== body.version) return err(route, 409, "version_conflict");
    state.queue = state.queue.filter((q) => q.id !== id);
    return reply(route, 200, { id, version: body.version + 1, categoria_efetiva: body.category });
  });

  return state;
}
