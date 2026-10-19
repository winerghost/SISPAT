// =============================================================================
// Mocks SINTÉTICOS dos cadastros de apoio (salas, pessoas responsáveis e
// unidades) — contrato docs/architecture/cadastros-apoio-api.md.
// =============================================================================
// Nenhum dado é real: nomes, e-mails (.invalid) e telefones são artificiais. O
// handler imita as regras do backend que a UI precisa explicar (ADM + AAL2,
// allowlists de consulta/corpo, unicidade, unidade inativa, `expected_updated_at`,
// idempotência de ativar/inativar, chaves `phone`/`address` só para ADM), mas
// a autoridade continua sendo o backend real. Sem dependência de `mocks.ts`
// (evita import circular): as respostas saem pelo callback `respond`.
// =============================================================================

export interface CatalogUnitRef {
  id: string;
  code: string;
  name: string;
}

export interface RoomMock {
  id: string;
  unit_id: string;
  name: string;
  description: string | null;
  floor: string | null;
  active: boolean;
  source_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonMock {
  id: string;
  unit_id: string;
  name: string;
  email: string | null;
  /** Só dígitos (o backend guarda assim). */
  phone: string | null;
  institutional_identifier: string | null;
  active: boolean;
  source_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnitDetailMock {
  id: string;
  code: string;
  name: string;
  description: string | null;
  address: string | null;
  active: boolean;
  source_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogMockState {
  rooms: RoomMock[];
  people: PersonMock[];
  unitDetails: Record<string, UnitDetailMock>;
  /** Omite a chave `phone` das respostas (simula quem não é ADM). */
  hidePhone: boolean;
  /** Omite a chave `address` das respostas de unidade. */
  hideAddress: boolean;
  /** Relógio determinístico: cada escrita avança 1 minuto. */
  clock: number;
}

export interface CatalogHandlerState extends CatalogMockState {
  role: string;
  aal: string;
  /** Unidades ATIVAS do escopo (`GET /v1/units`); compartilhada com a gestão de usuários. */
  units: CatalogUnitRef[];
}

const XSS = `<img src=x onerror="window.__xss=1">`;
const BASE = Date.UTC(2026, 9, 1, 12, 0, 0);
const iso = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000).toISOString();

export const ROOM_IDS = {
  a: "80000000-0000-4000-8000-000000000001",
  inactive: "80000000-0000-4000-8000-000000000002",
  xss: "80000000-0000-4000-8000-000000000003",
  other: "80000000-0000-4000-8000-000000000004",
} as const;

export const PERSON_IDS = {
  a: "90000000-0000-4000-8000-000000000001",
  inactive: "90000000-0000-4000-8000-000000000002",
  xss: "90000000-0000-4000-8000-000000000003",
  noPhone: "90000000-0000-4000-8000-000000000004",
} as const;

export const PERSON_PHONE = "63991234567";

/** Unidade sintética inativa: só aparece em `GET /v1/units/catalog`. */
export const INACTIVE_UNIT: CatalogUnitRef = {
  id: "60000000-0000-4000-8000-000000000007",
  code: "INAT-07",
  name: "Unidade Sintética Inativa",
};

export function defaultCatalog(units: CatalogUnitRef[], opts: { hidePhone?: boolean; hideAddress?: boolean } = {}): CatalogMockState {
  const [u1, u2, u3] = units as [CatalogUnitRef, CatalogUnitRef, CatalogUnitRef];
  const room = (id: string, unit: CatalogUnitRef, name: string, extra: Partial<RoomMock> = {}): RoomMock => ({
    id,
    unit_id: unit.id,
    name,
    description: null,
    floor: null,
    active: true,
    source_record_id: null,
    created_at: iso(0),
    updated_at: iso(10),
    ...extra,
  });
  const person = (id: string, unit: CatalogUnitRef, name: string, extra: Partial<PersonMock> = {}): PersonMock => ({
    id,
    unit_id: unit.id,
    name,
    email: null,
    phone: null,
    institutional_identifier: null,
    active: true,
    source_record_id: null,
    created_at: iso(0),
    updated_at: iso(10),
    ...extra,
  });
  const unitDetail = (unit: CatalogUnitRef, extra: Partial<UnitDetailMock> = {}): UnitDetailMock => ({
    id: unit.id,
    code: unit.code,
    name: unit.name,
    description: `Descrição sintética de ${unit.code}.`,
    address: "Quadra sintética 100 Norte, Palmas/TO (endereço fictício)",
    active: true,
    source_record_id: `origem-${unit.code.toLowerCase()}`,
    created_at: iso(0),
    updated_at: iso(10),
    ...extra,
  });

  return {
    rooms: [
      room(ROOM_IDS.a, u1, "Sala 101 Sintética com Nome Bastante Longo para Testar a Quebra de Linha em 320px", {
        description: "Descrição sintética da sala.",
        floor: "1º andar",
        source_record_id: "sala-linha-2",
      }),
      room(ROOM_IDS.inactive, u1, "Almoxarifado Sintético", { active: false, floor: "Térreo" }),
      room(ROOM_IDS.xss, u2, `Sala ${XSS}`, { floor: "2º andar" }),
      room(ROOM_IDS.other, u2, "Auditório Sintético"),
    ],
    people: [
      person(PERSON_IDS.a, u1, "Pessoa Responsável Sintética com Nome Bastante Longo para Teste de Layout", {
        email: "responsavel.sintetica.com.email.extremamente.longo@exemplo.invalid",
        phone: PERSON_PHONE,
        institutional_identifier: "ID-0001",
        source_record_id: "resp-linha-2",
      }),
      person(PERSON_IDS.inactive, u1, "Responsável Inativa Sintética", {
        email: "inativa.sintetica@exemplo.invalid",
        phone: "6333211234",
        active: false,
      }),
      person(PERSON_IDS.xss, u2, `Responsável ${XSS}`, { email: "xss.sintetico@exemplo.invalid", phone: "63988887777" }),
      person(PERSON_IDS.noPhone, u3, "Responsável Sem Telefone", { institutional_identifier: "ID-0004" }),
    ],
    // Inclui uma unidade INATIVA (fora de `GET /v1/units`, só no cadastro).
    unitDetails: Object.fromEntries(
      [...units, INACTIVE_UNIT].map((unit) => [
        unit.id,
        unitDetail(unit, unit.id === INACTIVE_UNIT.id ? { active: false, updated_at: iso(20) } : {}),
      ]),
    ),
    hidePhone: opts.hidePhone ?? false,
    hideAddress: opts.hideAddress ?? false,
    clock: 100,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export interface CatalogRequestContext {
  state: CatalogHandlerState;
  method: string;
  path: string;
  searchParams: URLSearchParams;
  body: unknown;
  respond: (status: number, body?: unknown) => Promise<void>;
}

const LIST_PARAMS = new Set(["q", "unit_id", "active", "sort", "page", "page_size"]);
const ROOM_SORTS = new Set(["name", "created_at", "updated_at"]);
const PERSON_SORTS = new Set(["name", "email", "created_at", "updated_at"]);
const ROOM_CREATE = new Set(["unit_id", "name", "description", "floor"]);
const ROOM_PATCH = new Set(["name", "description", "floor", "expected_updated_at"]);
const PERSON_CREATE = new Set(["unit_id", "name", "email", "phone", "institutional_identifier"]);
const PERSON_PATCH = new Set(["name", "email", "phone", "institutional_identifier", "expected_updated_at"]);
const UNIT_PATCH = new Set(["name", "description", "address", "expected_updated_at"]);
const ACTION_BODY = new Set(["reason", "expected_updated_at"]);

const ROUTE_RE = /^\/v1\/(rooms|responsible-people|units)(?:\/([^/]+)(?:\/(deactivate|activate))?)?$/;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

function phoneDigits(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const digits = value.replace(/[\s().+-]/g, "");
  return /^[0-9]{10,13}$/.test(digits) ? digits : "invalid";
}

/** Trata `/v1/rooms*`, `/v1/responsible-people*` e `/v1/units/<id>*`. `true` = tratada. */
export async function handleCatalog(ctx: CatalogRequestContext): Promise<boolean> {
  const match = ctx.path.match(ROUTE_RE);
  if (!match) return false;
  const [, resource, id, action] = match as unknown as [string, string, string | undefined, "deactivate" | "activate" | undefined];
  // `GET /v1/units` (sem id) é do seletor de unidades (mocks.ts).
  if (resource === "units" && !id) return false;

  const { state, method, respond } = ctx;
  const err: Err = async (status, code, message = "erro sintético") => {
    await respond(status, { error: { code, message } });
    return true;
  };

  const isAdm = state.role === "ADM";
  if (isAdm && state.aal !== "aal2") return err(403, "AAL2_REQUIRED", "MFA obrigatório");
  const write = method !== "GET";
  // Escrita e unidades: só ADM; leitura de salas/pessoas: qualquer perfil.
  if (!isAdm && (write || resource === "units")) return err(403, "FORBIDDEN", "Proibido");

  const next = () => iso(state.clock++);

  if (resource === "units" && id === "catalog" && !action) return handleUnitCatalog(ctx, err);
  if (resource === "units") return handleUnit(ctx, id!, action, err, next);
  return resource === "rooms" ? handleRoom(ctx, id, action, err, next) : handlePerson(ctx, id, action, err, next);
}

type Err = (status: number, code: string, message?: string) => Promise<true>;

function checkList(ctx: CatalogRequestContext, sorts: Set<string>) {
  for (const key of ctx.searchParams.keys()) if (!LIST_PARAMS.has(key)) return null;
  const q = (ctx.searchParams.get("q") ?? "").toLowerCase();
  const sort = ctx.searchParams.get("sort") ?? "name";
  const field = sort.replace(/^-/, "");
  if (!sorts.has(field) || q.length > 100) return null;
  return {
    q,
    unitId: ctx.searchParams.get("unit_id"),
    active: ctx.searchParams.get("active"),
    field,
    dir: sort.startsWith("-") ? -1 : 1,
    page: Number(ctx.searchParams.get("page") ?? 1),
    pageSize: Number(ctx.searchParams.get("page_size") ?? 25),
  };
}

function sortBy<T extends object>(list: T[], field: string, dir: number): T[] {
  return [...list].sort((a, b) => {
    const va = String((a as Record<string, unknown>)[field] ?? "");
    const vb = String((b as Record<string, unknown>)[field] ?? "");
    return va.localeCompare(vb, "pt-BR") * dir;
  });
}

function unitInScope(state: CatalogHandlerState, unitId: unknown): boolean {
  return typeof unitId === "string" && state.units.some((unit) => unit.id === unitId) ||
    (typeof unitId === "string" && !!state.unitDetails[unitId] && !state.unitDetails[unitId]!.active);
}

function forbiddenKeys(body: unknown, allowed: Set<string>): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return true;
  return Object.keys(body).some((key) => !allowed.has(key));
}

function emptyPatch(body: Record<string, unknown>): boolean {
  return Object.keys(body).filter((key) => key !== "expected_updated_at").length === 0;
}

async function handleAction(
  ctx: CatalogRequestContext,
  target: { active: boolean; updated_at: string; unit_id?: string },
  action: "deactivate" | "activate",
  err: Err,
  next: () => string,
  unitActive: (unitId: string) => boolean,
): Promise<boolean | "ok"> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (forbiddenKeys(ctx.body ?? {}, ACTION_BODY)) return err(400, "validation_error");
  if (body.expected_updated_at !== undefined && body.expected_updated_at !== target.updated_at) {
    return err(409, "version_conflict");
  }
  const activate = action === "activate";
  if (target.active === activate) return "ok"; // idempotente: 200 sem alteração
  if (activate && target.unit_id && !unitActive(target.unit_id)) return err(409, "unit_inactive");
  target.active = activate;
  target.updated_at = next();
  return "ok";
}

// Salas -------------------------------------------------------------------------

async function handleRoom(
  ctx: CatalogRequestContext,
  id: string | undefined,
  action: "deactivate" | "activate" | undefined,
  err: Err,
  next: () => string,
): Promise<boolean> {
  const { state, method, respond } = ctx;
  const unitActive = (unitId: string) => state.unitDetails[unitId]?.active !== false;
  const duplicate = (unitId: string, name: string, exceptId?: string) =>
    state.rooms.some((r) => r.unit_id === unitId && r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());

  if (!id) {
    if (method === "GET") {
      const query = checkList(ctx, ROOM_SORTS);
      if (!query) return err(400, "validation_error");
      const list = sortBy(
        state.rooms.filter(
          (r) =>
            (!query.q || r.name.toLowerCase().includes(query.q)) &&
            (!query.unitId || r.unit_id === query.unitId) &&
            (query.active === null || String(r.active) === query.active),
        ),
        query.field,
        query.dir,
      );
      await respond(200, {
        total: list.length,
        page: query.page,
        page_size: query.pageSize,
        rooms: list.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      });
      return true;
    }
    if (method === "POST") {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (forbiddenKeys(ctx.body, ROOM_CREATE)) return err(400, "validation_error");
      const name = clean(body.name);
      if (!name) return err(400, "validation_error");
      if (typeof body.unit_id !== "string" || !unitInScope(state, body.unit_id)) return err(404, "not_found");
      if (!unitActive(body.unit_id)) return err(409, "unit_inactive");
      if (duplicate(body.unit_id, name)) return err(409, "conflict", "Já existe um registro com estes dados.");
      const stamp = next();
      const room: RoomMock = {
        id: `80000000-0000-4000-8000-${String(100 + state.rooms.length).padStart(12, "0")}`,
        unit_id: body.unit_id,
        name,
        description: clean(body.description),
        floor: clean(body.floor),
        active: true,
        source_record_id: null,
        created_at: stamp,
        updated_at: stamp,
      };
      state.rooms.push(room);
      await respond(201, room);
      return true;
    }
    return false;
  }

  const room = state.rooms.find((r) => r.id === id);
  if (!room) return err(404, "not_found", "Não encontrado");

  if (!action && method === "GET") {
    await respond(200, room);
    return true;
  }
  if (!action && method === "PATCH") {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (forbiddenKeys(ctx.body, ROOM_PATCH) || emptyPatch(body)) return err(400, "validation_error");
    if (body.expected_updated_at !== undefined && body.expected_updated_at !== room.updated_at) {
      return err(409, "version_conflict");
    }
    if ("name" in body) {
      const name = clean(body.name);
      if (!name) return err(400, "validation_error");
      if (duplicate(room.unit_id, name, room.id)) return err(409, "conflict", "Já existe um registro com estes dados.");
      room.name = name;
    }
    if ("description" in body) room.description = clean(body.description);
    if ("floor" in body) room.floor = clean(body.floor);
    room.updated_at = next();
    await respond(200, room);
    return true;
  }
  if (action && method === "POST") {
    const result = await handleAction(ctx, room, action, err, next, unitActive);
    if (result !== "ok") return result;
    await respond(200, room);
    return true;
  }
  return false;
}

// Pessoas responsáveis ----------------------------------------------------------

function personView(state: CatalogHandlerState, person: PersonMock): Record<string, unknown> {
  // USER: o backend devolve só `id, name, unit_id, active` (e só pessoas vinculadas a bens).
  if (state.role === "USER") {
    return { id: person.id, name: person.name, unit_id: person.unit_id, active: person.active };
  }
  const { phone, ...rest } = person;
  return state.hidePhone ? rest : { ...rest, phone };
}

async function handlePerson(
  ctx: CatalogRequestContext,
  id: string | undefined,
  action: "deactivate" | "activate" | undefined,
  err: Err,
  next: () => string,
): Promise<boolean> {
  const { state, method, respond } = ctx;
  const unitActive = (unitId: string) => state.unitDetails[unitId]?.active !== false;
  const taken = (email: string | null, identifier: string | null, exceptId?: string) =>
    state.people.some(
      (p) =>
        p.id !== exceptId &&
        ((email !== null && p.email === email) || (identifier !== null && p.institutional_identifier === identifier)),
    );
  const emailOf = (value: unknown): string | null | "invalid" => {
    const text = clean(value);
    if (text === null) return null;
    return /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/.test(text) ? text.toLowerCase() : "invalid";
  };

  if (!id) {
    if (method === "GET") {
      const query = checkList(ctx, PERSON_SORTS);
      if (!query) return err(400, "validation_error");
      const list = sortBy(
        state.people.filter(
          (p) =>
            (!query.q || p.name.toLowerCase().includes(query.q) || (p.email ?? "").toLowerCase().includes(query.q)) &&
            (!query.unitId || p.unit_id === query.unitId) &&
            (query.active === null || String(p.active) === query.active),
        ),
        query.field,
        query.dir,
      );
      await respond(200, {
        total: list.length,
        page: query.page,
        page_size: query.pageSize,
        people: list.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((p) => personView(state, p)),
      });
      return true;
    }
    if (method === "POST") {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (forbiddenKeys(ctx.body, PERSON_CREATE)) return err(400, "validation_error");
      const name = clean(body.name);
      const email = emailOf(body.email);
      const phone = phoneDigits(body.phone);
      if (!name || email === "invalid" || phone === "invalid") return err(400, "validation_error");
      if (typeof body.unit_id !== "string" || !unitInScope(state, body.unit_id)) return err(404, "not_found");
      if (!unitActive(body.unit_id)) return err(409, "unit_inactive");
      const identifier = clean(body.institutional_identifier);
      if (taken(email, identifier)) return err(409, "conflict", "Já existe um registro com estes dados.");
      const stamp = next();
      const person: PersonMock = {
        id: `90000000-0000-4000-8000-${String(100 + state.people.length).padStart(12, "0")}`,
        unit_id: body.unit_id,
        name,
        email,
        phone,
        institutional_identifier: identifier,
        active: true,
        source_record_id: null,
        created_at: stamp,
        updated_at: stamp,
      };
      state.people.push(person);
      await respond(201, personView(state, person));
      return true;
    }
    return false;
  }

  const person = state.people.find((p) => p.id === id);
  if (!person) return err(404, "not_found", "Não encontrado");

  if (!action && method === "GET") {
    await respond(200, personView(state, person));
    return true;
  }
  if (!action && method === "PATCH") {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (forbiddenKeys(ctx.body, PERSON_PATCH) || emptyPatch(body)) return err(400, "validation_error");
    if (body.expected_updated_at !== undefined && body.expected_updated_at !== person.updated_at) {
      return err(409, "version_conflict");
    }
    const name = "name" in body ? clean(body.name) : person.name;
    const email = "email" in body ? emailOf(body.email) : person.email;
    const phone = "phone" in body ? phoneDigits(body.phone) : person.phone;
    if (!name || email === "invalid" || phone === "invalid") return err(400, "validation_error");
    const identifier = "institutional_identifier" in body ? clean(body.institutional_identifier) : person.institutional_identifier;
    if (taken(email, identifier, person.id)) return err(409, "conflict", "Já existe um registro com estes dados.");
    Object.assign(person, { name, email, phone, institutional_identifier: identifier, updated_at: next() });
    await respond(200, personView(state, person));
    return true;
  }
  if (action && method === "POST") {
    const result = await handleAction(ctx, person, action, err, next, unitActive);
    if (result !== "ok") return result;
    await respond(200, personView(state, person));
    return true;
  }
  return false;
}

// Unidades ----------------------------------------------------------------------

const UNIT_CATALOG_PARAMS = new Set(["q", "active", "sort", "page", "page_size"]);
const UNIT_SORTS = new Set(["name", "code", "updated_at"]);

/** `GET /v1/units/catalog`: ativas e inativas; `address` só sem `hideAddress`. */
async function handleUnitCatalog(ctx: CatalogRequestContext, err: Err): Promise<boolean> {
  const { state, method, searchParams, respond } = ctx;
  if (method !== "GET") return false;
  const keys = [...searchParams.keys()];
  const sort = searchParams.get("sort") ?? "name";
  const active = searchParams.get("active") ?? "all";
  const q = (searchParams.get("q") ?? "").toLowerCase();
  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("page_size") ?? 25);
  if (
    keys.some((key) => !UNIT_CATALOG_PARAMS.has(key)) ||
    new Set(keys).size !== keys.length ||
    !UNIT_SORTS.has(sort.replace(/^-/, "")) ||
    !["true", "false", "all"].includes(active) ||
    q.length > 100 ||
    !(page >= 1) ||
    !(pageSize >= 1 && pageSize <= 100)
  ) {
    return err(400, "validation_error");
  }
  const all = Object.values(state.unitDetails).filter(
    (u) =>
      (!q || u.name.toLowerCase().includes(q) || u.code.toLowerCase().includes(q)) &&
      (active === "all" || String(u.active) === active),
  );
  const list = sortBy(all, sort.replace(/^-/, ""), sort.startsWith("-") ? -1 : 1);
  await respond(200, {
    total: list.length,
    page,
    page_size: pageSize,
    units: list.slice((page - 1) * pageSize, page * pageSize).map((u) => {
      const item = {
        id: u.id,
        code: u.code,
        name: u.name,
        active: u.active,
        updated_at: u.updated_at,
        source_record_id: u.source_record_id,
      };
      return state.hideAddress ? item : { ...item, address: u.address };
    }),
  });
  return true;
}

async function handleUnit(
  ctx: CatalogRequestContext,
  id: string,
  action: "deactivate" | "activate" | undefined,
  err: Err,
  next: () => string,
): Promise<boolean> {
  const { state, method, respond } = ctx;
  const detail = state.unitDetails[id];
  if (!detail) return err(404, "not_found", "Não encontrado");
  const view = () => {
    const { address, ...rest } = detail;
    return state.hideAddress ? rest : { ...rest, address };
  };
  const syncList = () => {
    const index = state.units.findIndex((unit) => unit.id === id);
    if (!detail.active) {
      if (index >= 0) state.units.splice(index, 1);
    } else if (index >= 0) {
      state.units[index] = { id, code: detail.code, name: detail.name };
    } else {
      state.units.push({ id, code: detail.code, name: detail.name });
    }
  };

  if (!action && method === "GET") {
    await respond(200, view());
    return true;
  }
  if (!action && method === "PATCH") {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (forbiddenKeys(ctx.body, UNIT_PATCH) || emptyPatch(body)) return err(400, "validation_error");
    if (body.expected_updated_at !== undefined && body.expected_updated_at !== detail.updated_at) {
      return err(409, "version_conflict");
    }
    if ("name" in body) {
      const name = clean(body.name);
      if (!name) return err(400, "validation_error");
      detail.name = name;
    }
    if ("description" in body) detail.description = clean(body.description);
    if ("address" in body) detail.address = clean(body.address);
    detail.updated_at = next();
    syncList();
    await respond(200, view());
    return true;
  }
  if (action && method === "POST") {
    const result = await handleAction(ctx, detail, action, err, next, () => true);
    if (result !== "ok") return result;
    syncList();
    await respond(200, view());
    return true;
  }
  return false;
}
