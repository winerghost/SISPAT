// =============================================================================
// Mocks SINTÉTICOS da API de movimentações (`/api/v1/movements`) — contrato
// docs/architecture/movements-api.md.
// =============================================================================
// Nenhum dado é real. O handler imita as regras do backend que a UI precisa
// explicar: ADM + AAL2, escopo (origem OU destino na lista; alheio/inexistente/
// malformado = mesmo 404), allowlist de consulta e de corpo (campo privilegiado
// => 400), RH somente leitura e SEM `reason`/`requested_by`/`approved_by`,
// aprovar/rejeitar só ADM com escopo de origem E destino (403 se faltar uma),
// cancelar só pelo solicitante ou ADM, transição única de PENDENTE
// (409 invalid_transition), `asset_version` + instantâneo de origem
// (409 version_conflict), bem excluído (409 asset_unavailable), unidade/vínculos
// inativos ou de outra unidade, pendente duplicada (409 movement_pending),
// nada mudaria (409 no_change) e semântica de sala/responsável ausente x null.
// Não existe PUT/PATCH/DELETE (405). A aprovação ALTERA o bem do mock (version+1).
// A autoridade continua sendo o backend real. Sem dependência de `mocks.ts`
// (evita import circular): as respostas saem pelo callback `respond`.
// =============================================================================

import { ACTOR_ID, ASSET_IDS, OUT_OF_SCOPE_UNIT_ID, type AssetHandlerState, type AssetMock } from "./asset-mocks";
import { mockPage, mockPageSize } from "./page-size";
import type { CatalogUnitRef } from "./catalog-mocks";
import { PERSON_IDS, ROOM_IDS } from "./catalog-mocks";

const XSS = `<img src=x onerror="window.__xss=1">`;
const BASE = Date.UTC(2026, 9, 2, 12, 0, 0);
const iso = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000).toISOString();

/** Outro usuário (não é quem está logado): para testar "cancelar só solicitante/ADM". */
export const OTHER_ACTOR_ID = "00000000-0000-4000-8000-0000000000e3";

export const MOVEMENT_IDS = {
  pendingUnit: "d0000000-0000-4000-8000-000000000001",
  pendingRoom: "d0000000-0000-4000-8000-000000000002",
  approved: "d0000000-0000-4000-8000-000000000003",
  rejected: "d0000000-0000-4000-8000-000000000004",
  cancelled: "d0000000-0000-4000-8000-000000000005",
  hidden: "d0000000-0000-4000-8000-000000000006",
  halfScope: "d0000000-0000-4000-8000-000000000007",
} as const;

export interface MovementMock {
  id: string;
  asset_id: string;
  movement_type: string;
  status: "PENDENTE" | "APROVADA" | "REJEITADA" | "CANCELADA";
  origin_unit_id: string;
  destination_unit_id: string;
  origin_room_id: string | null;
  destination_room_id: string | null;
  previous_responsible_id: string | null;
  new_responsible_id: string | null;
  reason: string | null;
  requested_by: string;
  approved_by: string | null;
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
}

export interface MovementMockState {
  movements: MovementMock[];
  movementClock: number;
  /** Erro HTTP forçado em `GET /movements`. */
  forceMovementListStatus: number | null;
  /** Erro forçado em POST (solicitar/aprovar/rejeitar/cancelar): `{status, code}`. */
  forceMovementWriteError: { status: number; code: string } | null;
}

export interface MovementHandlerState extends MovementMockState, AssetHandlerState {}

export function defaultMovements(units: CatalogUnitRef[]): MovementMockState {
  const [u1, u2, u3] = units as [CatalogUnitRef, CatalogUnitRef, CatalogUnitRef];
  const move = (id: string, minutes: number, extra: Partial<MovementMock> & Pick<MovementMock, "asset_id" | "origin_unit_id" | "destination_unit_id">): MovementMock => ({
    id,
    movement_type: "TRANSFERENCIA_UNIDADE",
    status: "PENDENTE",
    origin_room_id: null,
    destination_room_id: null,
    previous_responsible_id: null,
    new_responsible_id: null,
    reason: null,
    requested_by: OTHER_ACTOR_ID,
    approved_by: null,
    created_at: iso(minutes),
    approved_at: null,
    completed_at: null,
    ...extra,
  });
  return {
    movements: [
      // Origem = estado atual do bem 000123 (u1, sala A, pessoa A). Pedido por "mim".
      move(MOVEMENT_IDS.pendingUnit, -3 * 1440, {
        asset_id: ASSET_IDS.long,
        origin_unit_id: u1.id,
        destination_unit_id: u2.id,
        origin_room_id: ROOM_IDS.a,
        previous_responsible_id: PERSON_IDS.a,
        destination_room_id: ROOM_IDS.other,
        reason: "Transferência sintética para o escritório avançado.",
        requested_by: ACTOR_ID,
      }),
      // Mesma unidade (u1): só a sala muda. Pedido por OUTRA pessoa.
      move(MOVEMENT_IDS.pendingRoom, -2 * 1440, {
        asset_id: ASSET_IDS.zeros,
        movement_type: "MUDANCA_SALA",
        origin_unit_id: u1.id,
        destination_unit_id: u1.id,
        destination_room_id: ROOM_IDS.a,
        reason: `Troca de sala ${XSS}`,
      }),
      move(MOVEMENT_IDS.approved, 30, {
        asset_id: ASSET_IDS.slash,
        status: "APROVADA",
        origin_unit_id: u3.id,
        destination_unit_id: u2.id,
        reason: "Aprovada no passado (sintética).",
        approved_by: OTHER_ACTOR_ID,
        approved_at: iso(40),
        completed_at: iso(40),
      }),
      move(MOVEMENT_IDS.rejected, 50, {
        asset_id: ASSET_IDS.xss,
        status: "REJEITADA",
        origin_unit_id: u2.id,
        destination_unit_id: u1.id,
        approved_by: OTHER_ACTOR_ID,
        approved_at: iso(55),
      }),
      move(MOVEMENT_IDS.cancelled, 60, {
        asset_id: ASSET_IDS.third,
        status: "CANCELADA",
        origin_unit_id: u3.id,
        destination_unit_id: u1.id,
        requested_by: ACTOR_ID,
      }),
      // Fora do escopo (origem e destino): nunca aparece, nem por id (404).
      move(MOVEMENT_IDS.hidden, 70, {
        asset_id: ASSET_IDS.outOfScope,
        origin_unit_id: OUT_OF_SCOPE_UNIT_ID,
        destination_unit_id: OUT_OF_SCOPE_UNIT_ID,
      }),
      // Escopo só no DESTINO: aparece na lista; aprovar/rejeitar => 403 (falta a origem).
      move(MOVEMENT_IDS.halfScope, 80, {
        asset_id: ASSET_IDS.outOfScope,
        origin_unit_id: OUT_OF_SCOPE_UNIT_ID,
        destination_unit_id: u1.id,
      }),
    ],
    movementClock: 300,
    forceMovementListStatus: null,
    forceMovementWriteError: null,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export interface MovementRequestContext {
  state: MovementHandlerState;
  method: string;
  path: string;
  searchParams: URLSearchParams;
  rawKeys: string[];
  body: unknown;
  respond: (status: number, body?: unknown) => Promise<void>;
}

type Err = (status: number, code: string, message?: string) => Promise<true>;

const ROUTE_RE = /^\/v1\/movements(?:\/([^/]+)(?:\/(approve|reject|cancel))?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PARAMS = new Set([
  "status",
  "movement_type",
  "asset_id",
  "origin_unit_id",
  "destination_unit_id",
  "created_from",
  "created_to",
  "sort",
  "page",
  "page_size",
]);
const STATUSES = new Set(["PENDENTE", "APROVADA", "REJEITADA", "CANCELADA", "CONCLUIDA"]);
const MOVEMENT_TYPES = new Set(["TRANSFERENCIA_UNIDADE", "MUDANCA_SALA", "TROCA_RESPONSAVEL"]);
const SORTS = new Set(["created_at", "status"]);
const CREATE_KEYS = new Set([
  "asset_id",
  "asset_version",
  "destination_unit_id",
  "destination_room_id",
  "new_responsible_id",
  "reason",
]);

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function validReason(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && value.length <= 500);
}

/** Trata `/v1/movements*`. `true` = tratada. */
export async function handleMovements(ctx: MovementRequestContext): Promise<boolean> {
  const match = ctx.path.match(ROUTE_RE);
  if (!match) return false;
  const [, id, action] = match as unknown as [string, string | undefined, "approve" | "reject" | "cancel" | undefined];
  const { state, method, respond } = ctx;
  const err: Err = async (status, code, message = "erro sintético") => {
    await respond(status, { error: { code, message } });
    return true;
  };

  if (state.role === "ADM" && state.aal !== "aal2") return err(403, "AAL2_REQUIRED", "MFA obrigatório");

  if (!id) {
    if (method === "GET") return list(ctx, err);
    if (method === "POST") return create(ctx, err);
    return err(405, "method_not_allowed");
  }
  if (!action) {
    if (method === "GET") return detail(ctx, id, err);
    return err(405, "method_not_allowed"); // sem PUT/PATCH/DELETE: histórico imutável
  }
  if (method !== "POST") return err(405, "method_not_allowed");
  return transition(ctx, id, action, err);
}

// -- Auxiliares ---------------------------------------------------------------

function scopeIds(state: MovementHandlerState): Set<string> {
  return new Set(Object.keys(state.unitDetails));
}

function unitRef(state: MovementHandlerState, unitId: string | null) {
  if (!unitId) return null;
  const unit = state.unitDetails[unitId];
  if (unit) return { id: unit.id, code: unit.code, name: unit.name };
  return { id: unitId, code: "FORA-09", name: "Unidade Sintética Fora do Escopo" };
}

function named<T extends { id: string; name: string }>(list: T[], id: string | null) {
  const found = list.find((item) => item.id === id);
  return found ? { id: found.id, name: found.name } : null;
}

function view(state: MovementHandlerState, m: MovementMock): Record<string, unknown> {
  const asset = state.assets.find((a) => a.id === m.asset_id);
  const base: Record<string, unknown> = {
    id: m.id,
    asset_id: m.asset_id,
    asset: asset
      ? {
          id: asset.id,
          patrimony_number: asset.patrimony_number,
          description: asset.description,
          deleted: asset.deleted_at !== null,
        }
      : null,
    movement_type: m.movement_type,
    status: m.status,
    origin_unit_id: m.origin_unit_id,
    origin_unit: unitRef(state, m.origin_unit_id),
    destination_unit_id: m.destination_unit_id,
    destination_unit: unitRef(state, m.destination_unit_id),
    origin_room_id: m.origin_room_id,
    origin_room: named(state.rooms, m.origin_room_id),
    destination_room_id: m.destination_room_id,
    destination_room: named(state.rooms, m.destination_room_id),
    previous_responsible_id: m.previous_responsible_id,
    previous_responsible: named(state.people, m.previous_responsible_id),
    new_responsible_id: m.new_responsible_id,
    new_responsible: named(state.people, m.new_responsible_id),
    created_at: m.created_at,
    approved_at: m.approved_at,
    completed_at: m.completed_at,
  };
  // Leitor só com escopo no DESTINO: o backend OMITE (chave ausente, não null) sala/responsável
  // de origem e motivo. A UI não pode exibir "null"/"undefined" nem tratar isso como "sem sala".
  if (!scopeIds(state).has(m.origin_unit_id)) {
    delete base.origin_room_id;
    delete base.origin_room;
    delete base.previous_responsible_id;
    delete base.previous_responsible;
    if (state.role === "RH") return base;
    return { ...base, requested_by: m.requested_by, approved_by: m.approved_by };
  }
  if (state.role === "RH") return base; // RH não recebe motivo nem autoria
  return { ...base, reason: m.reason, requested_by: m.requested_by, approved_by: m.approved_by };
}

/** Origem OU destino no escopo (leitura). */
function readable(state: MovementHandlerState, m: MovementMock): boolean {
  const scope = scopeIds(state);
  return scope.has(m.origin_unit_id) || scope.has(m.destination_unit_id);
}

function find(state: MovementHandlerState, id: string): MovementMock | null {
  if (!UUID_RE.test(id)) return null;
  const m = state.movements.find((x) => x.id === id);
  return m && readable(state, m) ? m : null;
}

// -- Listagem e detalhe ---------------------------------------------------------

async function list(ctx: MovementRequestContext, err: Err): Promise<boolean> {
  const { state, searchParams, rawKeys, respond } = ctx;
  if (state.forceMovementListStatus && state.forceMovementListStatus >= 400) {
    return err(
      state.forceMovementListStatus,
      state.forceMovementListStatus === 403 ? "FORBIDDEN" : "INTERNAL",
      "SISPAT_BACKEND_MSG",
    );
  }
  if (rawKeys.some((key) => !LIST_PARAMS.has(key)) || new Set(rawKeys).size !== rawKeys.length) {
    return err(400, "validation_error");
  }
  const status = searchParams.get("status");
  const movementType = searchParams.get("movement_type");
  const sort = searchParams.get("sort") ?? "-created_at";
  const field = sort.replace(/^-/, "");
  const page = mockPage(searchParams);
  const pageSize = mockPageSize(searchParams);
  const from = searchParams.get("created_from");
  const to = searchParams.get("created_to");
  for (const key of ["asset_id", "origin_unit_id", "destination_unit_id"]) {
    const value = searchParams.get(key);
    if (value !== null && !UUID_RE.test(value)) return err(400, "validation_error");
  }
  const badDate = (value: string | null) => value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)));
  if (
    (status !== null && !STATUSES.has(status)) ||
    (movementType !== null && !MOVEMENT_TYPES.has(movementType)) ||
    !SORTS.has(field) ||
    badDate(from) ||
    badDate(to) ||
    page === null ||
    pageSize === null
  ) {
    return err(400, "validation_error");
  }
  const assetId = searchParams.get("asset_id");
  const origin = searchParams.get("origin_unit_id");
  const destination = searchParams.get("destination_unit_id");
  const dir = sort.startsWith("-") ? -1 : 1;
  const rows = state.movements
    .filter(
      (m) =>
        readable(state, m) &&
        (!status || m.status === status) &&
        (!movementType || m.movement_type === movementType) &&
        (!assetId || m.asset_id === assetId) &&
        (!origin || m.origin_unit_id === origin) &&
        (!destination || m.destination_unit_id === destination) &&
        (!from || m.created_at.slice(0, 10) >= from) &&
        (!to || m.created_at.slice(0, 10) <= to),
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
    movements: rows.slice((page - 1) * pageSize, page * pageSize).map((m) => view(state, m)),
  });
  return true;
}

async function detail(ctx: MovementRequestContext, id: string, err: Err): Promise<boolean> {
  if (ctx.rawKeys.length > 0) return err(400, "validation_error");
  const m = find(ctx.state, id);
  if (!m) return err(404, "not_found", "Não encontrado");
  await ctx.respond(200, view(ctx.state, m));
  return true;
}

// -- Vínculos -------------------------------------------------------------------

type Link = { kind: "room" | "person"; value: string };

/** Valida sala/pessoa contra o escopo, a unidade de destino e a atividade. `true` = erro respondido. */
async function checkLink(state: MovementHandlerState, destinationUnitId: string, link: Link, err: Err): Promise<boolean> {
  const target =
    link.kind === "room"
      ? state.rooms.find((r) => r.id === link.value)
      : state.people.find((p) => p.id === link.value);
  if (!target || !scopeIds(state).has(target.unit_id)) {
    await err(404, "not_found", "Não encontrado");
    return true;
  }
  if (target.unit_id !== destinationUnitId) {
    await err(409, "link_unit_mismatch");
    return true;
  }
  if (!target.active) {
    await err(409, "link_inactive");
    return true;
  }
  return false;
}

// -- Solicitar --------------------------------------------------------------------

async function create(ctx: MovementRequestContext, err: Err): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role === "RH") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceMovementWriteError) return err(state.forceMovementWriteError.status, state.forceMovementWriteError.code);
  if (!isRecord(body) || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) return err(400, "validation_error");
  const { asset_id: assetId, asset_version: version, destination_unit_id: destId } = body;
  if (
    typeof assetId !== "string" ||
    typeof destId !== "string" ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    !validReason(body.reason) ||
    (body.destination_room_id !== undefined && body.destination_room_id !== null && typeof body.destination_room_id !== "string") ||
    (body.new_responsible_id !== undefined && body.new_responsible_id !== null && typeof body.new_responsible_id !== "string")
  ) {
    return err(400, "validation_error");
  }

  const scope = scopeIds(state);
  const asset: AssetMock | undefined = UUID_RE.test(assetId) ? state.assets.find((a) => a.id === assetId) : undefined;
  if (!asset || asset.deleted_at || !scope.has(asset.unit_id)) return err(404, "not_found", "Não encontrado");
  if (!UUID_RE.test(destId) || !scope.has(destId)) return err(404, "not_found", "Não encontrado");
  if (state.unitDetails[destId]?.active === false) return err(409, "unit_inactive");
  if (version !== asset.version) return err(409, "version_conflict");
  if (state.movements.some((m) => m.asset_id === asset.id && m.status === "PENDENTE")) {
    return err(409, "movement_pending");
  }

  const sameUnit = destId === asset.unit_id;
  const hasRoom = "destination_room_id" in body;
  const hasPerson = "new_responsible_id" in body;
  const roomValue = (body.destination_room_id as string | null | undefined) ?? null;
  const personValue = (body.new_responsible_id as string | null | undefined) ?? null;
  // Ausente: outra unidade => vazio; mesma unidade => mantém. `null` explícito => limpa.
  const newRoom = hasRoom ? roomValue : sameUnit ? asset.room_id : null;
  const newPerson = hasPerson ? personValue : sameUnit ? asset.responsible_person_id : null;
  if (newRoom && (await checkLink(state, destId, { kind: "room", value: newRoom }, err))) return true;
  if (newPerson && (await checkLink(state, destId, { kind: "person", value: newPerson }, err))) return true;

  const roomChanged = (newRoom ?? null) !== (asset.room_id ?? null);
  const personChanged = (newPerson ?? null) !== (asset.responsible_person_id ?? null);
  if (sameUnit && !roomChanged && !personChanged) return err(409, "no_change");

  const movement: MovementMock = {
    id: `d1000000-0000-4000-8000-${String(state.movementClock++).padStart(12, "0")}`,
    asset_id: asset.id,
    movement_type: !sameUnit ? "TRANSFERENCIA_UNIDADE" : roomChanged ? "MUDANCA_SALA" : "TROCA_RESPONSAVEL",
    status: "PENDENTE",
    origin_unit_id: asset.unit_id,
    destination_unit_id: destId,
    origin_room_id: asset.room_id,
    destination_room_id: newRoom,
    previous_responsible_id: asset.responsible_person_id,
    new_responsible_id: newPerson,
    reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null,
    requested_by: ACTOR_ID,
    approved_by: null,
    created_at: iso(state.movementClock),
    approved_at: null,
    completed_at: null,
  };
  state.movements.push(movement);
  await respond(201, view(state, movement));
  return true;
}

// -- Aprovar / rejeitar / cancelar ------------------------------------------------

async function transition(
  ctx: MovementRequestContext,
  id: string,
  action: "approve" | "reject" | "cancel",
  err: Err,
): Promise<boolean> {
  const { state, body, respond } = ctx;
  if (state.role === "RH") return err(403, "FORBIDDEN", "Proibido");
  if (action !== "cancel" && state.role !== "ADM") return err(403, "FORBIDDEN", "Proibido");
  if (state.forceMovementWriteError) return err(state.forceMovementWriteError.status, state.forceMovementWriteError.code);

  const allowed = action === "approve" ? ["asset_version"] : ["reason"];
  const payload = body === undefined ? {} : body;
  if (!isRecord(payload) || Object.keys(payload).some((key) => !allowed.includes(key))) return err(400, "validation_error");
  if (action === "approve") {
    const v = payload.asset_version;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return err(400, "validation_error");
  } else if (!validReason(payload.reason)) {
    return err(400, "validation_error");
  }

  const m = find(state, id);
  if (!m) return err(404, "not_found", "Não encontrado");
  const scope = scopeIds(state);
  if (action !== "cancel" && !(scope.has(m.origin_unit_id) && scope.has(m.destination_unit_id))) {
    return err(403, "forbidden", "Proibido");
  }
  if (action === "cancel" && state.role !== "ADM" && m.requested_by !== ACTOR_ID) return err(403, "forbidden", "Proibido");
  if (m.status !== "PENDENTE") return err(409, "invalid_transition");

  const stamp = iso(state.movementClock++);
  if (action === "cancel") {
    m.status = "CANCELADA";
  } else if (action === "reject") {
    m.status = "REJEITADA";
    m.approved_by = ACTOR_ID;
    m.approved_at = stamp;
  } else {
    const asset = state.assets.find((a) => a.id === m.asset_id);
    if (!asset || asset.deleted_at) return err(409, "asset_unavailable");
    if (
      payload.asset_version !== asset.version ||
      asset.unit_id !== m.origin_unit_id ||
      (asset.room_id ?? null) !== (m.origin_room_id ?? null) ||
      (asset.responsible_person_id ?? null) !== (m.previous_responsible_id ?? null)
    ) {
      return err(409, "version_conflict");
    }
    if (state.unitDetails[m.destination_unit_id]?.active === false) return err(409, "unit_inactive");
    if (m.destination_room_id && (await checkLink(state, m.destination_unit_id, { kind: "room", value: m.destination_room_id }, err))) {
      return true;
    }
    if (m.new_responsible_id && (await checkLink(state, m.destination_unit_id, { kind: "person", value: m.new_responsible_id }, err))) {
      return true;
    }
    const previous = {
      unit_id: asset.unit_id,
      room_id: asset.room_id,
      responsible_person_id: asset.responsible_person_id,
    };
    asset.unit_id = m.destination_unit_id;
    asset.room_id = m.destination_room_id;
    asset.responsible_person_id = m.new_responsible_id;
    // Local incoerente com a nova unidade/sala é limpo (como no backend).
    const location = state.locations.find((l) => l.id === asset.location_id);
    if (location && (location.unit_id !== asset.unit_id || (location.room_id && location.room_id !== asset.room_id))) {
      asset.location_id = null;
    }
    asset.version += 1;
    asset.updated_at = stamp;
    state.history.push({
      asset_id: asset.id,
      id: `c2000000-0000-4000-8000-${String(state.movementClock).padStart(12, "0")}`,
      operation: "ASSET_MOVED",
      occurred_at: stamp,
      actor_user_id: ACTOR_ID,
      result: "SUCESSO",
      previous_values: previous,
      new_values: {
        unit_id: asset.unit_id,
        room_id: asset.room_id,
        responsible_person_id: asset.responsible_person_id,
      },
    });
    m.status = "APROVADA";
    m.approved_by = ACTOR_ID;
    m.approved_at = stamp;
    m.completed_at = stamp;
  }
  await respond(200, view(state, m));
  return true;
}
