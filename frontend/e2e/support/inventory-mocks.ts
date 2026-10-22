// =============================================================================
// Mocks SINTÉTICOS da API de inventários (`/api/v1/inventories`) e de locais
// (`GET /api/v1/locations`) — contrato docs/architecture/inventories-api.md.
// =============================================================================
// Nenhum dado é real. O handler imita as regras do backend que a UI precisa
// explicar: leitura/conferência para ADM e USER (permissão inventory.check; RH =
// 403), criar/iniciar/encerrar/cancelar só ADM (USER = 403), ADM + AAL2, escopo de
// unidade (alheio/inexistente/malformado = mesmo 404), allowlist de consulta e de
// corpo (campo privilegiado/desconhecido => 400), estados ABERTO -> EM_ANDAMENTO
// -> CONCLUIDO e ABERTO|EM_ANDAMENTO -> CANCELADO (409 invalid_transition),
// conferência só em EM_ANDAMENTO (409 inventory_not_started / inventory_closed),
// 1 conferência por bem (409 already_checked), bem de outra unidade/excluído/
// inexistente (404), local de outra unidade (404) ou inativo (409 link_inactive),
// `observed_location_id` só com found=true, resultado DERIVADO no servidor
// (NAO_ENCONTRADO / DIVERGENTE / ENCONTRADO), resumo calculado no servidor e
// conferidor/data do servidor. A conferência NÃO altera o bem. Não existe
// PUT/PATCH/DELETE (405). A autoridade continua sendo o backend real. Sem
// dependência de `mocks.ts` (evita import circular): as respostas saem pelo
// callback `respond`.
// =============================================================================

import { ACTOR_ID, ASSET_IDS, LOCATION_ID, OUT_OF_SCOPE_UNIT_ID, type AssetHandlerState } from "./asset-mocks";
import type { CatalogUnitRef } from "./catalog-mocks";

const XSS = `<img src=x onerror="window.__xss=1">`;
const BASE = Date.UTC(2026, 9, 2, 12, 0, 0);
const iso = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000).toISOString();

export const OTHER_CHECKER_ID = "00000000-0000-4000-8000-0000000000e3";

export const INVENTORY_IDS = {
  open: "e0000000-0000-4000-8000-000000000001",
  running: "e0000000-0000-4000-8000-000000000002",
  runningFull: "e0000000-0000-4000-8000-000000000003",
  done: "e0000000-0000-4000-8000-000000000004",
  cancelled: "e0000000-0000-4000-8000-000000000005",
  hidden: "e0000000-0000-4000-8000-000000000006",
} as const;

export const INV_LOCATION_IDS = {
  bancadaA: LOCATION_ID,
  bancadaB: "b0000000-0000-4000-8000-000000000002",
  inactive: "b0000000-0000-4000-8000-000000000003",
  xss: "b0000000-0000-4000-8000-000000000004",
  otherUnit: "b0000000-0000-4000-8000-000000000005",
} as const;

export type InventoryStatusMock = "ABERTO" | "EM_ANDAMENTO" | "CONCLUIDO" | "CANCELADO";

export interface InventoryMock {
  id: string;
  name: string;
  unit_id: string;
  start_date: string;
  end_date: string | null;
  status: InventoryStatusMock;
  created_by: string;
  created_at: string;
  closed_at: string | null;
}

export interface InventoryItemMock {
  id: string;
  inventory_id: string;
  asset_id: string;
  found: boolean;
  observed_location_id: string | null;
  checked_by: string;
  checked_at: string;
  notes: string | null;
}

export interface InventoryLocationMock {
  id: string;
  name: string;
  unit_id: string;
  room_id: string | null;
  active: boolean;
}

export interface InventoryMockState {
  inventories: InventoryMock[];
  inventoryItems: InventoryItemMock[];
  inventoryLocations: InventoryLocationMock[];
  inventoryClock: number;
  /** Erro HTTP forçado em `GET /inventories` (lista). */
  forceInventoryListStatus: number | null;
  /** Erro HTTP forçado em `GET /inventories/<id>/items`. */
  forceInventoryItemsStatus: number | null;
  /** Erro forçado em qualquer POST de inventário (criar/transição/conferir): `{status, code}`. */
  forceInventoryWriteError: { status: number; code: string } | null;
}

export interface InventoryHandlerState extends InventoryMockState, AssetHandlerState {}

export function defaultInventories(units: CatalogUnitRef[]): InventoryMockState {
  const [u1, u2, u3] = units as [CatalogUnitRef, CatalogUnitRef, CatalogUnitRef];
  const inventory = (
    id: string,
    minutes: number,
    name: string,
    unitId: string,
    status: InventoryStatusMock,
    extra: Partial<InventoryMock> = {},
  ): InventoryMock => ({
    id,
    name,
    unit_id: unitId,
    start_date: "2026-10-01",
    end_date: null,
    status,
    created_by: OTHER_CHECKER_ID,
    created_at: iso(minutes),
    closed_at: null,
    ...extra,
  });
  const item = (
    n: number,
    inventoryId: string,
    assetId: string,
    found: boolean,
    extra: Partial<InventoryItemMock> = {},
  ): InventoryItemMock => ({
    id: `e1000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    inventory_id: inventoryId,
    asset_id: assetId,
    found,
    observed_location_id: null,
    checked_by: OTHER_CHECKER_ID,
    checked_at: iso(100 + n),
    notes: null,
    ...extra,
  });
  return {
    inventories: [
      inventory(INVENTORY_IDS.open, -4 * 1440, "Inventário PSU-TO ainda aberto", u1.id, "ABERTO"),
      inventory(INVENTORY_IDS.running, -3 * 1440, "Inventário Anual PSU-TO com um nome bastante longo para testar a quebra de linha em 320px", u1.id, "EM_ANDAMENTO"),
      inventory(INVENTORY_IDS.runningFull, -2 * 1440, "Inventário ESC-02 em andamento", u2.id, "EM_ANDAMENTO"),
      inventory(INVENTORY_IDS.done, -1 * 1440, "Inventário NUC-03 concluído", u3.id, "CONCLUIDO", {
        end_date: "2026-10-02",
        closed_at: iso(-60),
      }),
      inventory(INVENTORY_IDS.cancelled, 0, `Inventário cancelado ${XSS}`, u1.id, "CANCELADO", {
        end_date: "2026-10-02",
        closed_at: iso(5),
      }),
      // Fora do escopo: nunca aparece, nem por id (404).
      inventory(INVENTORY_IDS.hidden, 10, "Inventário de unidade fora do escopo", OUT_OF_SCOPE_UNIT_ID, "EM_ANDAMENTO"),
    ],
    inventoryItems: [
      // PSU-TO (3 bens ativos): 000123 conferido no local cadastrado => ENCONTRADO.
      item(1, INVENTORY_IDS.running, ASSET_IDS.long, true, { observed_location_id: LOCATION_ID, notes: "Conferido na bancada." }),
      // ESC-02 (2 bens): todos conferidos. XSS-001 não encontrado; A-2025/007 em local diferente do cadastrado.
      item(2, INVENTORY_IDS.runningFull, ASSET_IDS.xss, false, { notes: `Nota ${XSS}` }),
      item(3, INVENTORY_IDS.runningFull, ASSET_IDS.slash, true, { observed_location_id: INV_LOCATION_IDS.xss }),
      // NUC-03 concluído (1 bem).
      item(4, INVENTORY_IDS.done, ASSET_IDS.third, true),
    ],
    inventoryLocations: [
      { id: INV_LOCATION_IDS.bancadaA, name: "Bancada A sintética", unit_id: u1.id, room_id: null, active: true },
      { id: INV_LOCATION_IDS.bancadaB, name: "Bancada B sintética", unit_id: u1.id, room_id: null, active: true },
      { id: INV_LOCATION_IDS.inactive, name: "Armário inativo sintético", unit_id: u1.id, room_id: null, active: false },
      { id: INV_LOCATION_IDS.xss, name: `Local ${XSS}`, unit_id: u2.id, room_id: null, active: true },
      { id: INV_LOCATION_IDS.otherUnit, name: "Local de outra unidade", unit_id: u3.id, room_id: null, active: true },
    ],
    inventoryClock: 400,
    forceInventoryListStatus: null,
    forceInventoryItemsStatus: null,
    forceInventoryWriteError: null,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export interface InventoryRequestContext {
  state: InventoryHandlerState;
  method: string;
  path: string;
  searchParams: URLSearchParams;
  rawKeys: string[];
  body: unknown;
  respond: (status: number, body?: unknown) => Promise<void>;
}

type Err = (status: number, code: string, message?: string) => Promise<true>;

const ROUTE_RE = /^\/v1\/inventories(?:\/([^/]+)(?:\/(summary|items|start|close|cancel))?)?$/;
const LOCATIONS_RE = /^\/v1\/locations$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PARAMS = new Set(["q", "unit_id", "status", "sort", "page", "page_size"]);
const ITEM_PARAMS = new Set(["result", "sort", "page", "page_size"]);
const LOCATION_PARAMS = new Set(["q", "unit_id", "room_id", "active", "sort", "page", "page_size"]);
const STATUSES = new Set(["ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"]);
const RESULTS = new Set(["ENCONTRADO", "NAO_ENCONTRADO", "DIVERGENTE"]);
const SORTS = new Set(["created_at", "name", "start_date", "status"]);
const LOCATION_SORTS = new Set(["name", "created_at", "updated_at"]);
const CREATE_KEYS = new Set(["name", "unit_id", "start_date"]);
const CHECK_KEYS = new Set(["asset_id", "found", "observed_location_id", "notes"]);
const TRANSITIONS: Record<string, Record<string, InventoryStatusMock>> = {
  start: { ABERTO: "EM_ANDAMENTO" },
  close: { EM_ANDAMENTO: "CONCLUIDO" },
  cancel: { ABERTO: "CANCELADO", EM_ANDAMENTO: "CANCELADO" },
};

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function pageParams(searchParams: URLSearchParams) {
  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("page_size") ?? 50);
  // Contrato do backend: page_size ∈ {50, 100, 200}; outro valor => 400.
  const valid = Number.isInteger(page) && page >= 1 && [50, 100, 200].includes(pageSize);
  return { page, pageSize, valid };
}

const badKeys = (rawKeys: string[], allowed: Set<string>) =>
  rawKeys.some((key) => !allowed.has(key)) || new Set(rawKeys).size !== rawKeys.length;

/** Trata `/v1/inventories*` e `/v1/locations`. `true` = tratada. */
export async function handleInventories(ctx: InventoryRequestContext): Promise<boolean> {
  const { state, method, respond } = ctx;
  const err: Err = async (status, code, message = "erro sintético") => {
    await respond(status, { error: { code, message } });
    return true;
  };

  if (LOCATIONS_RE.test(ctx.path)) {
    if (state.role === "ADM" && state.aal !== "aal2") return err(403, "AAL2_REQUIRED", "MFA obrigatório");
    if (method !== "GET") return err(405, "method_not_allowed");
    return listLocations(ctx, err);
  }

  const match = ctx.path.match(ROUTE_RE);
  if (!match) return false;
  const [, id, sub] = match as unknown as [string, string | undefined, string | undefined];

  // `inventory.check` é ADM e USER; RH nunca.
  if (state.role === "RH") return err(403, "FORBIDDEN", "Proibido");
  if (state.role === "ADM" && state.aal !== "aal2") return err(403, "AAL2_REQUIRED", "MFA obrigatório");

  if (!id) {
    if (method === "GET") return list(ctx, err);
    if (method === "POST") return create(ctx, err);
    return err(405, "method_not_allowed");
  }
  if (!sub) {
    if (method === "GET") return detail(ctx, id, err);
    return err(405, "method_not_allowed"); // sem PUT/PATCH/DELETE: imutável
  }
  if (sub === "summary") return method === "GET" ? summary(ctx, id, err) : err(405, "method_not_allowed");
  if (sub === "items") {
    if (method === "GET") return listItems(ctx, id, err);
    if (method === "POST") return check(ctx, id, err);
    return err(405, "method_not_allowed");
  }
  if (method !== "POST") return err(405, "method_not_allowed");
  return transition(ctx, id, sub as "start" | "close" | "cancel", err);
}

// -- Auxiliares ---------------------------------------------------------------

function scopeIds(state: InventoryHandlerState): Set<string> {
  return new Set(Object.keys(state.unitDetails));
}

function unitRef(state: InventoryHandlerState, unitId: string) {
  const unit = state.unitDetails[unitId];
  if (unit) return { id: unit.id, code: unit.code, name: unit.name };
  return { id: unitId, code: "FORA-09", name: "Unidade Sintética Fora do Escopo" };
}

function view(state: InventoryHandlerState, inv: InventoryMock): Record<string, unknown> {
  return {
    id: inv.id,
    name: inv.name,
    unit_id: inv.unit_id,
    unit: unitRef(state, inv.unit_id),
    start_date: inv.start_date,
    end_date: inv.end_date,
    status: inv.status,
    created_by: inv.created_by,
    created_at: inv.created_at,
    closed_at: inv.closed_at,
  };
}

function find(state: InventoryHandlerState, id: string): InventoryMock | null {
  if (!UUID_RE.test(id)) return null;
  const inv = state.inventories.find((x) => x.id === id);
  return inv && scopeIds(state).has(inv.unit_id) ? inv : null;
}

type ItemResult = "ENCONTRADO" | "NAO_ENCONTRADO" | "DIVERGENTE";

/** Resultado derivado NO SERVIDOR (nunca vem do cliente). */
function derive(found: boolean, observed: string | null, registered: string | null): ItemResult {
  if (!found) return "NAO_ENCONTRADO";
  if (observed !== null && observed !== registered) return "DIVERGENTE";
  return "ENCONTRADO";
}

function itemView(state: InventoryHandlerState, item: InventoryItemMock): Record<string, unknown> {
  const asset = state.assets.find((a) => a.id === item.asset_id)!;
  return {
    id: item.id,
    inventory_id: item.inventory_id,
    asset: {
      id: asset.id,
      patrimony_number: asset.patrimony_number,
      description: asset.description,
      deleted: asset.deleted_at !== null,
    },
    found: item.found,
    result: derive(item.found, item.observed_location_id, asset.location_id),
    registered_location_id: asset.location_id,
    observed_location_id: item.observed_location_id,
    checked_by: item.checked_by,
    checked_at: item.checked_at,
    notes: item.notes,
  };
}

// -- Leitura ---------------------------------------------------------------------

async function list(ctx: InventoryRequestContext, err: Err): Promise<boolean> {
  const { state, searchParams, rawKeys, respond } = ctx;
  if (state.forceInventoryListStatus && state.forceInventoryListStatus >= 400) {
    return err(
      state.forceInventoryListStatus,
      state.forceInventoryListStatus === 403 ? "FORBIDDEN" : "INTERNAL",
      "SISPAT_BACKEND_MSG",
    );
  }
  if (badKeys(rawKeys, LIST_PARAMS)) return err(400, "validation_error");
  const status = searchParams.get("status");
  const unitId = searchParams.get("unit_id");
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();
  const sort = searchParams.get("sort") ?? "-created_at";
  const field = sort.replace(/^-/, "");
  const { page, pageSize, valid } = pageParams(searchParams);
  if (
    (status !== null && !STATUSES.has(status)) ||
    (unitId !== null && !UUID_RE.test(unitId)) ||
    !SORTS.has(field) ||
    q.length > 100 ||
    !valid
  ) {
    return err(400, "validation_error");
  }
  const dir = sort.startsWith("-") ? -1 : 1;
  const rows = state.inventories
    .filter(
      (inv) =>
        scopeIds(state).has(inv.unit_id) &&
        (!status || inv.status === status) &&
        (!unitId || inv.unit_id === unitId) &&
        (!q || inv.name.toLowerCase().includes(q)),
    )
    .sort((a, b) => {
      const va = String((a as unknown as Record<string, unknown>)[field]);
      const vb = String((b as unknown as Record<string, unknown>)[field]);
      return va.localeCompare(vb) * dir || a.id.localeCompare(b.id);
    });
  await respond(200, {
    total: rows.length,
    page,
    page_size: pageSize,
    inventories: rows.slice((page - 1) * pageSize, page * pageSize).map((inv) => view(state, inv)),
  });
  return true;
}

async function detail(ctx: InventoryRequestContext, id: string, err: Err): Promise<boolean> {
  if (ctx.rawKeys.length > 0) return err(400, "validation_error");
  const inv = find(ctx.state, id);
  if (!inv) return err(404, "not_found", "Não encontrado");
  await ctx.respond(200, view(ctx.state, inv));
  return true;
}

async function summary(ctx: InventoryRequestContext, id: string, err: Err): Promise<boolean> {
  const { state } = ctx;
  if (ctx.rawKeys.length > 0) return err(400, "validation_error");
  const inv = find(state, id);
  if (!inv) return err(404, "not_found", "Não encontrado");
  const total = state.assets.filter((a) => a.unit_id === inv.unit_id && a.deleted_at === null).length;
  const results = state.inventoryItems
    .filter((i) => i.inventory_id === inv.id)
    .map((i) => {
      const asset = state.assets.find((a) => a.id === i.asset_id)!;
      return derive(i.found, i.observed_location_id, asset.location_id);
    });
  const count = (r: ItemResult) => results.filter((x) => x === r).length;
  const checked = results.length;
  await ctx.respond(200, {
    inventory_id: inv.id,
    status: inv.status,
    total_assets: total,
    checked,
    pending: Math.max(total - checked, 0),
    found: count("ENCONTRADO"),
    not_found: count("NAO_ENCONTRADO"),
    divergent: count("DIVERGENTE"),
    progress_percent: total ? Math.round((1000 * checked) / total) / 10 : 0,
  });
  return true;
}

async function listItems(ctx: InventoryRequestContext, id: string, err: Err): Promise<boolean> {
  const { state, searchParams, rawKeys, respond } = ctx;
  if (state.forceInventoryItemsStatus && state.forceInventoryItemsStatus >= 400) {
    return err(state.forceInventoryItemsStatus, "INTERNAL", "SISPAT_BACKEND_MSG");
  }
  if (badKeys(rawKeys, ITEM_PARAMS)) return err(400, "validation_error");
  const inv = find(state, id);
  if (!inv) return err(404, "not_found", "Não encontrado");
  const result = searchParams.get("result");
  const sort = searchParams.get("sort") ?? "-checked_at";
  const { page, pageSize, valid } = pageParams(searchParams);
  if ((result !== null && !RESULTS.has(result)) || !["checked_at", "-checked_at"].includes(sort) || !valid) {
    return err(400, "validation_error");
  }
  const dir = sort.startsWith("-") ? -1 : 1;
  const rows = state.inventoryItems
    .filter((i) => i.inventory_id === inv.id)
    .map((i) => ({ raw: i, view: itemView(state, i) }))
    .filter((row) => !result || row.view.result === result)
    .sort((a, b) => a.raw.checked_at.localeCompare(b.raw.checked_at) * dir || a.raw.id.localeCompare(b.raw.id));
  await respond(200, {
    total: rows.length,
    page,
    page_size: pageSize,
    items: rows.slice((page - 1) * pageSize, page * pageSize).map((row) => row.view),
  });
  return true;
}

async function listLocations(ctx: InventoryRequestContext, err: Err): Promise<boolean> {
  const { state, searchParams, rawKeys, respond } = ctx;
  if (badKeys(rawKeys, LOCATION_PARAMS)) return err(400, "validation_error");
  const unitId = searchParams.get("unit_id");
  const active = searchParams.get("active");
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();
  const sort = searchParams.get("sort") ?? "name";
  const { page, pageSize, valid } = pageParams(searchParams);
  if (
    (unitId !== null && !UUID_RE.test(unitId)) ||
    (active !== null && !["true", "false"].includes(active)) ||
    !LOCATION_SORTS.has(sort.replace(/^-/, "")) ||
    !valid
  ) {
    return err(400, "validation_error");
  }
  const scope = scopeIds(state);
  const rows = state.inventoryLocations
    .filter(
      (l) =>
        scope.has(l.unit_id) &&
        (!unitId || l.unit_id === unitId) &&
        (active === null || l.active === (active === "true")) &&
        (!q || l.name.toLowerCase().includes(q)),
    )
    .sort((a, b) => a.name.localeCompare(b.name) * (sort.startsWith("-") ? -1 : 1));
  await respond(200, {
    total: rows.length,
    page,
    page_size: pageSize,
    locations: rows.slice((page - 1) * pageSize, page * pageSize).map((l) => ({
      id: l.id,
      unit_id: l.unit_id,
      room_id: l.room_id,
      name: l.name,
      description: null,
      active: l.active,
      created_at: iso(0),
      updated_at: iso(0),
    })),
  });
  return true;
}

// -- Escrita ---------------------------------------------------------------------

async function create(ctx: InventoryRequestContext, err: Err): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role !== "ADM") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceInventoryWriteError) return err(state.forceInventoryWriteError.status, state.forceInventoryWriteError.code);
  if (!isRecord(body) || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) return err(400, "validation_error");
  const { name, unit_id: unitId, start_date: startDate } = body;
  if (
    typeof name !== "string" ||
    name.trim().length < 1 ||
    name.trim().length > 200 ||
    typeof unitId !== "string" ||
    (startDate !== undefined && (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)))
  ) {
    return err(400, "validation_error");
  }
  if (!UUID_RE.test(unitId) || !scopeIds(state).has(unitId)) return err(404, "not_found", "Não encontrado");
  if (state.unitDetails[unitId]?.active === false) return err(409, "unit_inactive");
  const inv: InventoryMock = {
    id: `e2000000-0000-4000-8000-${String(state.inventoryClock++).padStart(12, "0")}`,
    name: name.trim().replace(/\s+/g, " "),
    unit_id: unitId,
    start_date: (startDate as string | undefined) ?? "2026-10-17",
    end_date: null,
    status: "ABERTO",
    created_by: ACTOR_ID,
    created_at: iso(state.inventoryClock),
    closed_at: null,
  };
  state.inventories.push(inv);
  await respond(201, view(state, inv));
  return true;
}

async function transition(
  ctx: InventoryRequestContext,
  id: string,
  action: "start" | "close" | "cancel",
  err: Err,
): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role !== "ADM") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceInventoryWriteError) return err(state.forceInventoryWriteError.status, state.forceInventoryWriteError.code);
  const payload = body === undefined ? {} : body;
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== "reason") ||
    (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.length > 500))
  ) {
    return err(400, "validation_error");
  }
  const inv = find(state, id);
  if (!inv) return err(404, "not_found", "Não encontrado");
  const target = TRANSITIONS[action]![inv.status];
  if (!target) return err(409, "invalid_transition");
  inv.status = target;
  if (target === "CONCLUIDO" || target === "CANCELADO") {
    inv.closed_at = iso(state.inventoryClock++);
    inv.end_date = "2026-10-17";
  }
  await respond(200, view(state, inv));
  return true;
}

async function check(ctx: InventoryRequestContext, id: string, err: Err): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.forceInventoryWriteError) return err(state.forceInventoryWriteError.status, state.forceInventoryWriteError.code);
  if (!isRecord(body) || Object.keys(body).some((key) => !CHECK_KEYS.has(key))) return err(400, "validation_error");
  const { asset_id: assetId, found, observed_location_id: observedId, notes } = body;
  if (
    typeof assetId !== "string" ||
    typeof found !== "boolean" ||
    (observedId !== undefined && observedId !== null && typeof observedId !== "string") ||
    (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > 500)) ||
    (!found && observedId !== undefined && observedId !== null)
  ) {
    return err(400, "validation_error");
  }
  const inv = find(state, id);
  if (!inv) return err(404, "not_found", "Não encontrado");
  if (inv.status === "CONCLUIDO" || inv.status === "CANCELADO") return err(409, "inventory_closed");
  if (inv.status !== "EM_ANDAMENTO") return err(409, "inventory_not_started");
  const asset = UUID_RE.test(assetId)
    ? state.assets.find((a) => a.id === assetId && a.unit_id === inv.unit_id && a.deleted_at === null)
    : undefined;
  if (!asset) return err(404, "not_found", "Não encontrado");
  let observed: string | null = null;
  if (observedId) {
    const location = UUID_RE.test(observedId)
      ? state.inventoryLocations.find((l) => l.id === observedId && l.unit_id === inv.unit_id)
      : undefined;
    if (!location) return err(404, "not_found", "Não encontrado");
    if (!location.active) return err(409, "link_inactive");
    observed = location.id;
  }
  if (state.inventoryItems.some((i) => i.inventory_id === inv.id && i.asset_id === asset.id)) {
    return err(409, "already_checked");
  }
  const text = typeof notes === "string" && notes.trim() ? notes.trim() : null;
  const item: InventoryItemMock = {
    id: `e3000000-0000-4000-8000-${String(state.inventoryClock++).padStart(12, "0")}`,
    inventory_id: inv.id,
    asset_id: asset.id,
    found,
    observed_location_id: observed,
    checked_by: ACTOR_ID, // sempre o usuário autenticado
    checked_at: iso(state.inventoryClock),
    notes: text,
  };
  state.inventoryItems.push(item);
  await respond(201, itemView(state, item)); // não altera o bem (`located` e local permanecem)
  return true;
}
