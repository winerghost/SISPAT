// =============================================================================
// Mocks SINTÉTICOS da API de patrimônios (`/api/v1/assets`) — contrato
// docs/architecture/assets-api.md.
// =============================================================================
// Nenhum dado é real. O handler imita as regras do backend que a UI precisa
// explicar: ADM + AAL2, escopo de unidade (alheio/inexistente/excluído = mesmo
// 404), `include_deleted` só ADM (403 aos demais), allowlist de consulta e de
// corpo (mass assignment => 400), campos por perfil (USER não envia
// `patrimony_number` na edição, `owner_unit_id` nem `located`; RH é somente
// leitura e NÃO recebe `notes`), número patrimonial único entre bens ativos
// (sem distinguir caixa), `version` (409 version_conflict), vínculos na mesma
// unidade (409 link_unit_mismatch), vínculos inativos (409 link_inactive), unidade
// inativa (409 unit_inactive), exclusão/restauração LÓGICAS só ADM e histórico.
// A autoridade continua sendo o backend real. Sem dependência de `mocks.ts`
// (evita import circular): as respostas saem pelo callback `respond`.
// =============================================================================

import type { CatalogUnitRef, PersonMock, RoomMock, UnitDetailMock } from "./catalog-mocks";
import { PERSON_IDS, ROOM_IDS } from "./catalog-mocks";

const XSS = `<img src=x onerror="window.__xss=1">`;
/** Vínculo importado com marcador XSS (deve aparecer como TEXTO literal). */
export const BOND_XSS = "<img src=x onerror=window.__xss=1>";
/** Valor reservado do filtro "Sem vínculo". */
export const BOND_NONE = "__none__";
const BASE = Date.UTC(2026, 9, 2, 12, 0, 0);
const iso = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000).toISOString();

export const OUT_OF_SCOPE_UNIT_ID = "60000000-0000-4000-8000-000000000009";
export const ACTOR_ID = "00000000-0000-4000-8000-0000000000e2";

export const ASSET_IDS = {
  long: "a0000000-0000-4000-8000-000000000001",
  zeros: "a0000000-0000-4000-8000-000000000002",
  xss: "a0000000-0000-4000-8000-000000000003",
  slash: "a0000000-0000-4000-8000-000000000004",
  deleted: "a0000000-0000-4000-8000-000000000005",
  outOfScope: "a0000000-0000-4000-8000-000000000006",
  third: "a0000000-0000-4000-8000-000000000007",
  similar: "a0000000-0000-4000-8000-000000000008",
} as const;

export const LOCATION_ID = "b0000000-0000-4000-8000-000000000001";

export const LONG_DESCRIPTION =
  "Computador desktop sintético com descrição bastante longa para testar a quebra de linha em telas de 320px";

export interface AssetMock {
  id: string;
  patrimony_number: string;
  description: string | null;
  notes: string | null;
  unit_id: string;
  owner_unit_id: string | null;
  responsible_person_id: string | null;
  room_id: string | null;
  location_id: string | null;
  located: "SIM" | "NAO" | "DESCONHECIDO";
  /** Vínculo (1ª coluna RESPONSAVEL da planilha); só leitura, vem da importação. */
  bond_status: string | null;
  registration_date: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

export interface AssetHistoryMock {
  asset_id: string;
  id: string;
  operation: string;
  occurred_at: string;
  actor_user_id: string | null;
  result: string;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

export interface LocationMock {
  id: string;
  name: string;
  unit_id: string;
  room_id: string | null;
  active: boolean;
}

export interface AssetMockState {
  assets: AssetMock[];
  history: AssetHistoryMock[];
  locations: LocationMock[];
  assetClock: number;
  /** Erro HTTP forçado em `GET /assets` (testa o estado de erro e "tentar novamente"). */
  forceListStatus: number | null;
  /** Erro forçado em POST/PATCH/delete/restore: `{status, code}`. */
  forceWriteError: { status: number; code: string } | null;
  /** Erro HTTP forçado em `GET /assets/<id>/history`. */
  forceHistoryStatus: number | null;
  /** Erro HTTP forçado em `GET /assets/bond-statuses` (o filtro "Vínculo" fica indisponível). */
  forceBondStatusesStatus: number | null;
}

export interface AssetHandlerState extends AssetMockState {
  role: string;
  aal: string;
  rooms: RoomMock[];
  people: PersonMock[];
  unitDetails: Record<string, UnitDetailMock>;
}

export function defaultAssets(units: CatalogUnitRef[]): AssetMockState {
  const [u1, u2, u3] = units as [CatalogUnitRef, CatalogUnitRef, CatalogUnitRef];
  const asset = (id: string, unitId: string, number: string, extra: Partial<AssetMock> = {}): AssetMock => ({
    id,
    patrimony_number: number,
    description: null,
    notes: null,
    unit_id: unitId,
    owner_unit_id: null,
    responsible_person_id: null,
    room_id: null,
    location_id: null,
    located: "DESCONHECIDO",
    bond_status: null,
    registration_date: null,
    created_at: iso(0),
    updated_at: iso(10),
    deleted_at: null,
    version: 1,
    ...extra,
  });
  const entry = (
    assetId: string,
    n: number,
    operation: string,
    previous: Record<string, unknown> | null,
    next: Record<string, unknown> | null,
  ): AssetHistoryMock => ({
    asset_id: assetId,
    id: `c0000000-0000-4000-8000-${String(assetId.slice(-3) + String(n).padStart(3, "0")).padStart(12, "0")}`,
    operation,
    occurred_at: iso(n * 5),
    actor_user_id: ACTOR_ID,
    result: "SUCESSO",
    previous_values: previous,
    new_values: next,
  });

  return {
    assets: [
      asset(ASSET_IDS.long, u1.id, "000123", {
        description: LONG_DESCRIPTION,
        notes: "Observação sintética do bem.",
        responsible_person_id: PERSON_IDS.a,
        room_id: ROOM_IDS.a,
        location_id: LOCATION_ID,
        located: "SIM",
        bond_status: "Servidor",
        registration_date: "2024-02-29",
        version: 3,
      }),
      asset(ASSET_IDS.zeros, u1.id, "0000456", {
        description: "Cadeira giratória sintética",
        owner_unit_id: u2.id,
        notes: null,
        bond_status: "Ocioso",
      }),
      asset(ASSET_IDS.xss, u2.id, "XSS-001", {
        description: `Monitor ${XSS}`,
        notes: `Nota ${XSS}`,
        room_id: ROOM_IDS.other,
        located: "NAO",
        bond_status: BOND_XSS,
      }),
      asset(ASSET_IDS.slash, u2.id, "A-2025/007", { description: "Projetor sintético", located: "SIM" }),
      asset(ASSET_IDS.deleted, u1.id, "DEL-0001", {
        description: "Bem excluído sintético",
        deleted_at: iso(30),
        version: 2,
        bond_status: "Ocioso",
      }),
      asset(ASSET_IDS.outOfScope, OUT_OF_SCOPE_UNIT_ID, "FORA-001", {
        description: "Bem de unidade fora do escopo",
        bond_status: "Ocioso",
      }),
      asset(ASSET_IDS.third, u3.id, "007", { description: "Armário sintético", bond_status: "Terceirizado" }),
      asset(ASSET_IDS.similar, u1.id, "00123", { description: "Mesa sintética", bond_status: "ocioso" }),
    ],
    history: [
      entry(ASSET_IDS.long, 1, "ASSET_CREATED", null, { patrimony_number: "000123", located: "DESCONHECIDO" }),
      entry(
        ASSET_IDS.long,
        2,
        "ASSET_UPDATED",
        { description: "Computador sintético", room_id: null },
        { description: LONG_DESCRIPTION, room_id: ROOM_IDS.a },
      ),
      entry(ASSET_IDS.long, 3, "ASSET_UPDATED", { located: "DESCONHECIDO" }, { located: "SIM" }),
      entry(ASSET_IDS.deleted, 1, "ASSET_CREATED", null, { patrimony_number: "DEL-0001" }),
      entry(ASSET_IDS.deleted, 2, "ASSET_DELETED", { deleted_at: null }, { deleted_at: iso(30) }),
    ],
    locations: [{ id: LOCATION_ID, name: "Bancada A sintética", unit_id: u1.id, room_id: ROOM_IDS.a, active: true }],
    assetClock: 200,
    forceListStatus: null,
    forceWriteError: null,
    forceHistoryStatus: null,
    forceBondStatusesStatus: null,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export interface AssetRequestContext {
  state: AssetHandlerState;
  method: string;
  path: string;
  searchParams: URLSearchParams;
  /** Chaves de consulta na ordem recebida (detecta parâmetro repetido). */
  rawKeys: string[];
  body: unknown;
  respond: (status: number, body?: unknown) => Promise<void>;
}

type Err = (status: number, code: string, message?: string) => Promise<true>;

const ROUTE_RE = /^\/v1\/assets(?:\/([^/]+)(?:\/(history|delete|restore))?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PARAMS = new Set([
  "q",
  "unit_id",
  "owner_unit_id",
  "room_id",
  "responsible_person_id",
  "located",
  "bond_status",
  "include_deleted",
  "sort",
  "page",
  "page_size",
]);
const SORTS = new Set(["patrimony_number", "description", "bond_status", "created_at", "updated_at"]);
const LOCATED = new Set(["SIM", "NAO", "DESCONHECIDO"]);
// Contrato do backend: page_size ∈ {50, 100, 200} (padrão 50); outro valor => 400.
const PAGE_SIZES = new Set([50, 100, 200]);
const CREATE_KEYS = new Set([
  "unit_id",
  "patrimony_number",
  "description",
  "notes",
  "owner_unit_id",
  "responsible_person_id",
  "room_id",
  "location_id",
  "located",
  "registration_date",
]);
const PATCH_KEYS = new Set([...CREATE_KEYS].filter((key) => key !== "unit_id").concat("version"));
const ADM_ONLY_CREATE = ["owner_unit_id", "located"];
const ADM_ONLY_PATCH = ["patrimony_number", "owner_unit_id", "located"];
const LINK_KEYS = ["room_id", "location_id", "responsible_person_id"] as const;

function normalizeNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length >= 1 && text.length <= 64 ? text : null;
}

function freeText(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.replace(/[ \t]+/g, " ").trim();
  if (text.length > 2000) return "invalid";
  return text === "" ? null : text;
}

function dateValue(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return "invalid";
  const year = Number(value.slice(0, 4));
  return year >= 1900 && !Number.isNaN(Date.parse(value)) ? value.trim() : "invalid";
}

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

/** Trata `/v1/assets*`. `true` = tratada. */
export async function handleAssets(ctx: AssetRequestContext): Promise<boolean> {
  const match = ctx.path.match(ROUTE_RE);
  if (!match) return false;
  const [, id, action] = match as unknown as [string, string | undefined, "history" | "delete" | "restore" | undefined];
  const { state, method, respond } = ctx;
  const err: Err = async (status, code, message = "erro sintético") => {
    await respond(status, { error: { code, message } });
    return true;
  };

  const isAdm = state.role === "ADM";
  if (isAdm && state.aal !== "aal2") return err(403, "AAL2_REQUIRED", "MFA obrigatório");

  if (id === "bond-statuses" && !action) {
    if (method === "GET") return bondStatuses(ctx, err);
    return false;
  }
  if (!id) {
    if (method === "GET") return listAssets(ctx, err);
    if (method === "POST") return createAsset(ctx, err);
    return false;
  }
  if (!action) {
    if (method === "GET") return getAsset(ctx, id, err);
    if (method === "PATCH") return patchAsset(ctx, id, err);
    return false; // não existe DELETE (405 no backend)
  }
  if (action === "history" && method === "GET") return history(ctx, id, err);
  if ((action === "delete" || action === "restore") && method === "POST") return lifecycle(ctx, id, action, err);
  return false;
}

// -- Auxiliares ---------------------------------------------------------------

function scopeIds(state: AssetHandlerState): Set<string> {
  return new Set(Object.keys(state.unitDetails));
}

function inScope(state: AssetHandlerState, asset: AssetMock): boolean {
  const scope = scopeIds(state);
  return scope.has(asset.unit_id) || (asset.owner_unit_id !== null && scope.has(asset.owner_unit_id));
}

function unitRef(state: AssetHandlerState, unitId: string | null) {
  if (!unitId) return null;
  const unit = state.unitDetails[unitId];
  return unit ? { id: unit.id, code: unit.code, name: unit.name } : { id: unitId, code: "—", name: "—" };
}

/** Projeção por perfil: ADM e USER recebem `notes` & cia.; RH não recebe nenhuma dessas chaves; `deleted_by` só ADM. */
function view(state: AssetHandlerState, asset: AssetMock): Record<string, unknown> {
  const room = state.rooms.find((r) => r.id === asset.room_id);
  const person = state.people.find((p) => p.id === asset.responsible_person_id);
  const location = state.locations.find((l) => l.id === asset.location_id);
  const base: Record<string, unknown> = {
    id: asset.id,
    patrimony_number: asset.patrimony_number,
    description: asset.description,
    unit_id: asset.unit_id,
    unit: unitRef(state, asset.unit_id),
    owner_unit_id: asset.owner_unit_id,
    owner_unit: unitRef(state, asset.owner_unit_id),
    responsible_person_id: asset.responsible_person_id,
    responsible_person: person ? { id: person.id, name: person.name } : null,
    room_id: asset.room_id,
    room: room ? { id: room.id, name: room.name } : null,
    location_id: asset.location_id,
    location: location ? { id: location.id, name: location.name } : null,
    located: asset.located,
    bond_status: asset.bond_status,
    registration_date: asset.registration_date,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    deleted_at: asset.deleted_at,
    version: asset.version,
  };
  if (state.role === "RH") return base;
  const extra: Record<string, unknown> = {
    ...base,
    notes: asset.notes,
    assigned_user_id: null,
    source_record_id: null,
    source_system: "sheets",
    source_updated_at: null,
    created_by: ACTOR_ID,
    updated_by: ACTOR_ID,
  };
  if (state.role === "ADM") extra.deleted_by = asset.deleted_at ? ACTOR_ID : null;
  return extra;
}

function record(state: AssetHandlerState, asset: AssetMock, operation: string, previous: Record<string, unknown> | null, next: Record<string, unknown> | null) {
  state.history.push({
    asset_id: asset.id,
    id: `c1000000-0000-4000-8000-${String(state.assetClock++).padStart(12, "0")}`,
    operation,
    occurred_at: iso(state.assetClock),
    actor_user_id: ACTOR_ID,
    result: "SUCESSO",
    previous_values: previous,
    new_values: next,
  });
}

/** Ativo (não excluído) e no escopo; ADM com `include_deleted=true` também enxerga excluídos. */
function visible(state: AssetHandlerState, id: string, includeDeleted: boolean): AssetMock | null {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset || !inScope(state, asset)) return null;
  if (asset.deleted_at && !includeDeleted) return null;
  return asset;
}

function checkIncludeDeleted(ctx: AssetRequestContext): { ok: true; include: boolean } | { ok: false; status: number; code: string } {
  const raw = ctx.searchParams.get("include_deleted");
  if (raw === null) return { ok: true, include: false };
  if (raw !== "true" && raw !== "false") return { ok: false, status: 400, code: "validation_error" };
  if (raw === "true" && ctx.state.role !== "ADM") return { ok: false, status: 403, code: "forbidden" };
  return { ok: true, include: raw === "true" };
}

function duplicateNumber(state: AssetHandlerState, number: string, exceptId?: string): boolean {
  return state.assets.some(
    (a) => a.id !== exceptId && !a.deleted_at && a.patrimony_number.toLowerCase() === number.toLowerCase(),
  );
}

// -- Listagem ---------------------------------------------------------------

async function listAssets(ctx: AssetRequestContext, err: Err): Promise<boolean> {
  const { state, searchParams, rawKeys, respond } = ctx;
  if (state.forceListStatus && state.forceListStatus >= 400) {
    return err(state.forceListStatus, state.forceListStatus === 403 ? "FORBIDDEN" : "INTERNAL", "SISPAT_BACKEND_MSG");
  }
  if (rawKeys.some((key) => !LIST_PARAMS.has(key)) || new Set(rawKeys).size !== rawKeys.length) {
    return err(400, "validation_error");
  }
  const included = checkIncludeDeleted(ctx);
  if (!included.ok) return err(included.status, included.code);

  const q = (searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const sort = searchParams.get("sort") ?? "patrimony_number";
  const field = sort.replace(/^-/, "");
  const located = searchParams.get("located");
  const bond = searchParams.get("bond_status");
  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("page_size") ?? 50);
  for (const key of ["unit_id", "owner_unit_id", "room_id", "responsible_person_id"]) {
    const value = searchParams.get(key);
    if (value !== null && !UUID_RE.test(value)) return err(400, "validation_error");
  }
  if (
    q.length > 100 ||
    (bond !== null && (bond.trim() === "" || bond.length > 100)) ||
    !SORTS.has(field) ||
    (located !== null && !LOCATED.has(located)) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !PAGE_SIZES.has(pageSize)
  ) {
    return err(400, "validation_error");
  }

  const unitId = searchParams.get("unit_id");
  const ownerId = searchParams.get("owner_unit_id");
  const roomId = searchParams.get("room_id");
  const personId = searchParams.get("responsible_person_id");
  const dir = sort.startsWith("-") ? -1 : 1;
  const list = state.assets
    .filter(
      (a) =>
        inScope(state, a) &&
        (included.include || !a.deleted_at) &&
        (!q || a.patrimony_number.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q)) &&
        (!unitId || a.unit_id === unitId) &&
        (!ownerId || a.owner_unit_id === ownerId) &&
        (!roomId || a.room_id === roomId) &&
        (!personId || a.responsible_person_id === personId) &&
        (!located || a.located === located) &&
        matchesBond(a, bond),
    )
    .sort((a, b) => {
      const va = String((a as unknown as Record<string, unknown>)[field] ?? "");
      const vb = String((b as unknown as Record<string, unknown>)[field] ?? "");
      return va.localeCompare(vb, "pt-BR") * dir || a.id.localeCompare(b.id);
    });
  await respond(200, {
    total: list.length,
    page,
    page_size: pageSize,
    assets: list.slice((page - 1) * pageSize, page * pageSize).map((a) => view(state, a)),
  });
  return true;
}

/** `bond_status` sem distinguir caixa; `__none__` = sem vínculo. */
function matchesBond(asset: AssetMock, bond: string | null): boolean {
  if (bond === null) return true;
  if (bond === BOND_NONE) return asset.bond_status === null;
  return asset.bond_status !== null && asset.bond_status.toLowerCase() === bond.trim().toLowerCase();
}

/** `GET /assets/bond-statuses`: valores distintos (sem caixa) no escopo, bens ativos, com contagem. */
async function bondStatuses(ctx: AssetRequestContext, err: Err): Promise<boolean> {
  const { state, respond } = ctx;
  if (ctx.rawKeys.length > 0) return err(400, "validation_error");
  if (state.forceBondStatusesStatus && state.forceBondStatusesStatus >= 400) {
    return err(state.forceBondStatusesStatus, "INTERNAL", "SISPAT_BACKEND_MSG");
  }
  const counts = new Map<string, { value: string; count: number }>();
  for (const asset of state.assets) {
    if (!inScope(state, asset) || asset.deleted_at || asset.bond_status === null) continue;
    const key = asset.bond_status.toLowerCase();
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { value: asset.bond_status, count: 1 });
  }
  const items = [...counts.values()].sort((a, b) => a.value.localeCompare(b.value, "pt-BR"));
  await respond(200, { items });
  return true;
}

// -- Detalhe e histórico ------------------------------------------------------

async function getAsset(ctx: AssetRequestContext, id: string, err: Err): Promise<boolean> {
  if (ctx.rawKeys.some((key) => key !== "include_deleted")) return err(400, "validation_error");
  const included = checkIncludeDeleted(ctx);
  if (!included.ok) return err(included.status, included.code);
  const asset = UUID_RE.test(id) ? visible(ctx.state, id, included.include) : null;
  if (!asset) return err(404, "not_found", "Não encontrado");
  await ctx.respond(200, view(ctx.state, asset));
  return true;
}

async function history(ctx: AssetRequestContext, id: string, err: Err): Promise<boolean> {
  const { state, searchParams, respond } = ctx;
  if (ctx.rawKeys.some((key) => !["include_deleted", "page", "page_size"].includes(key))) {
    return err(400, "validation_error");
  }
  const included = checkIncludeDeleted(ctx);
  if (!included.ok) return err(included.status, included.code);
  const asset = UUID_RE.test(id) ? visible(state, id, included.include) : null;
  if (!asset) return err(404, "not_found", "Não encontrado");
  if (state.forceHistoryStatus && state.forceHistoryStatus >= 400) {
    return err(state.forceHistoryStatus, state.forceHistoryStatus === 403 ? "FORBIDDEN" : "INTERNAL", "SISPAT_BACKEND_MSG");
  }
  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("page_size") ?? 50);
  if (!(page >= 1) || !PAGE_SIZES.has(pageSize)) return err(400, "validation_error");
  const entries = state.history
    .filter((h) => h.asset_id === id)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      occurred_at: entry.occurred_at,
      actor_user_id: entry.actor_user_id,
      result: entry.result,
      previous_values: entry.previous_values,
      new_values: entry.new_values,
    }));
  await respond(200, {
    total: entries.length,
    page,
    page_size: pageSize,
    entries: entries.slice((page - 1) * pageSize, page * pageSize),
  });
  return true;
}

// -- Vínculos ---------------------------------------------------------------

/** Valida salas/locais/pessoas contra o escopo e a unidade do bem. */
async function checkLinks(
  state: AssetHandlerState,
  unitId: string,
  body: Record<string, unknown>,
  current: AssetMock | null,
  err: Err,
): Promise<true | null> {
  for (const key of LINK_KEYS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return err(400, "validation_error");
    const target =
      key === "room_id"
        ? state.rooms.find((r) => r.id === value)
        : key === "location_id"
          ? state.locations.find((l) => l.id === value)
          : state.people.find((p) => p.id === value);
    if (!target || !scopeIds(state).has(target.unit_id)) return err(404, "not_found", "Não encontrado");
    if (target.unit_id !== unitId) return err(409, "link_unit_mismatch");
    const wasCurrent = current !== null && current[key] === value;
    if (!target.active && !wasCurrent) return err(409, "link_inactive");
  }
  return null;
}

// -- Criação ----------------------------------------------------------------

async function createAsset(ctx: AssetRequestContext, err: Err): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role === "RH") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceWriteError) return err(state.forceWriteError.status, state.forceWriteError.code);
  if (!isRecord(body) || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) return err(400, "validation_error");
  if (state.role !== "ADM" && ADM_ONLY_CREATE.some((key) => key in body)) return err(400, "validation_error");

  const number = normalizeNumber(body.patrimony_number);
  const description = freeText(body.description);
  const notes = freeText(body.notes);
  const date = dateValue(body.registration_date);
  const located = body.located === undefined ? "DESCONHECIDO" : body.located;
  if (!number || description === "invalid" || notes === "invalid" || date === "invalid" || !LOCATED.has(String(located))) {
    return err(400, "validation_error");
  }
  if (typeof body.unit_id !== "string" || !scopeIds(state).has(body.unit_id)) return err(404, "not_found");
  if (state.unitDetails[body.unit_id]?.active === false) return err(409, "unit_inactive");
  if (body.owner_unit_id !== undefined && body.owner_unit_id !== null) {
    if (typeof body.owner_unit_id !== "string" || !scopeIds(state).has(body.owner_unit_id)) return err(404, "not_found");
    if (state.unitDetails[body.owner_unit_id]?.active === false) return err(409, "unit_inactive");
  }
  if (duplicateNumber(state, number)) return err(409, "conflict", "Já existe um registro com estes dados.");
  const linkError = await checkLinks(state, body.unit_id, body, null, err);
  if (linkError) return true;

  const stamp = iso(state.assetClock++);
  const asset: AssetMock = {
    id: `a0000000-0000-4000-8000-${String(1000 + state.assets.length).padStart(12, "0")}`,
    patrimony_number: number,
    description,
    notes,
    unit_id: body.unit_id,
    owner_unit_id: (body.owner_unit_id as string | null | undefined) ?? null,
    responsible_person_id: (body.responsible_person_id as string | null | undefined) ?? null,
    room_id: (body.room_id as string | null | undefined) ?? null,
    location_id: (body.location_id as string | null | undefined) ?? null,
    located: located as AssetMock["located"],
    bond_status: null,
    registration_date: date,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    version: 1,
  };
  state.assets.push(asset);
  record(state, asset, "ASSET_CREATED", null, { patrimony_number: number, located: asset.located });
  await respond(201, view(state, asset));
  return true;
}

// -- Edição -----------------------------------------------------------------

async function patchAsset(ctx: AssetRequestContext, id: string, err: Err): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role === "RH") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceWriteError) return err(state.forceWriteError.status, state.forceWriteError.code);
  if (!isRecord(body) || Object.keys(body).some((key) => !PATCH_KEYS.has(key))) return err(400, "validation_error");
  if (state.role !== "ADM" && ADM_ONLY_PATCH.some((key) => key in body)) return err(400, "validation_error");
  const version = body.version;
  const editable = Object.keys(body).filter((key) => key !== "version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || editable.length === 0) {
    return err(400, "validation_error");
  }
  if (("patrimony_number" in body && body.patrimony_number === null) || ("located" in body && body.located === null)) {
    return err(400, "validation_error");
  }
  const asset = UUID_RE.test(id) ? visible(state, id, false) : null;
  if (!asset) return err(404, "not_found", "Não encontrado");
  if (version !== asset.version) return err(409, "version_conflict");

  const next: Partial<AssetMock> = {};
  if ("patrimony_number" in body) {
    const number = normalizeNumber(body.patrimony_number);
    if (!number) return err(400, "validation_error");
    if (duplicateNumber(state, number, asset.id)) return err(409, "conflict", "Já existe um registro com estes dados.");
    next.patrimony_number = number;
  }
  for (const key of ["description", "notes"] as const) {
    if (key in body) {
      const value = freeText(body[key]);
      if (value === "invalid") return err(400, "validation_error");
      next[key] = value;
    }
  }
  if ("registration_date" in body) {
    const value = dateValue(body.registration_date);
    if (value === "invalid") return err(400, "validation_error");
    next.registration_date = value;
  }
  if ("located" in body) {
    if (!LOCATED.has(String(body.located))) return err(400, "validation_error");
    next.located = body.located as AssetMock["located"];
  }
  if ("owner_unit_id" in body) {
    const owner = body.owner_unit_id;
    if (owner !== null) {
      if (typeof owner !== "string" || !scopeIds(state).has(owner)) return err(404, "not_found");
      if (state.unitDetails[owner]?.active === false && owner !== asset.owner_unit_id) return err(409, "unit_inactive");
    }
    next.owner_unit_id = owner as string | null;
  }
  const linkError = await checkLinks(state, asset.unit_id, body, asset, err);
  if (linkError) return true;
  for (const key of LINK_KEYS) if (key in body) next[key] = (body[key] as string | null) ?? null;

  // Local pertence a uma sala: trocar a sala mantendo o local de outra sala é recusado.
  const finalRoom = "room_id" in next ? next.room_id : asset.room_id;
  const finalLocation = "location_id" in next ? next.location_id : asset.location_id;
  const location = state.locations.find((l) => l.id === finalLocation);
  if (location && location.room_id && location.room_id !== finalRoom) return err(409, "link_unit_mismatch");

  const previous: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(next)) {
    const before = (asset as unknown as Record<string, unknown>)[key];
    if (before === value) continue;
    if (key !== "notes") {
      previous[key] = before;
      after[key] = value;
    }
    (asset as unknown as Record<string, unknown>)[key] = value;
    changed = true;
  }
  if (changed) {
    asset.version += 1;
    asset.updated_at = iso(state.assetClock++);
    record(state, asset, "ASSET_UPDATED", previous, after);
  }
  await respond(200, view(state, asset));
  return true;
}

// -- Excluir / restaurar (lógico) --------------------------------------------

async function lifecycle(ctx: AssetRequestContext, id: string, action: "delete" | "restore", err: Err): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role !== "ADM") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceWriteError) return err(state.forceWriteError.status, state.forceWriteError.code);
  if (!isRecord(body) || Object.keys(body).some((key) => !["version", "reason"].includes(key))) {
    return err(400, "validation_error");
  }
  const reason = body.reason;
  if (
    typeof body.version !== "number" ||
    !Number.isInteger(body.version) ||
    body.version < 1 ||
    (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 500))
  ) {
    return err(400, "validation_error");
  }
  const asset = UUID_RE.test(id) ? visible(state, id, true) : null;
  if (!asset) return err(404, "not_found", "Não encontrado");
  // Excluir bem já excluído e restaurar bem ativo => 404.
  if ((action === "delete") === (asset.deleted_at !== null)) return err(404, "not_found", "Não encontrado");
  if (body.version !== asset.version) return err(409, "version_conflict");
  if (action === "restore" && duplicateNumber(state, asset.patrimony_number, asset.id)) {
    return err(409, "conflict", "Já existe um registro com estes dados.");
  }
  const stamp = iso(state.assetClock++);
  const previousDeleted = asset.deleted_at;
  asset.deleted_at = action === "delete" ? stamp : null;
  asset.version += 1;
  asset.updated_at = stamp;
  record(state, asset, action === "delete" ? "ASSET_DELETED" : "ASSET_RESTORED", { deleted_at: previousDeleted }, { deleted_at: asset.deleted_at });
  await respond(200, view(state, asset));
  return true;
}
