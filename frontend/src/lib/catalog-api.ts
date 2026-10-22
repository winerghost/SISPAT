// =============================================================================
// SISPAT-AGU — catalog-api.ts
// =============================================================================
// Tipos e chamadas dos cadastros de apoio (salas, pessoas responsáveis e
// unidades). Contrato: docs/architecture/cadastros-apoio-api.md. Só transporte:
// perfil, escopo de unidade, AAL2, unicidade, unidade inativa e concorrência
// (`expected_updated_at`) são decididos pelo backend Flask.
//
// Não existe DELETE: "excluir" é `deactivate` (o registro é preservado).
// `phone` (pessoas) e `address` (unidades) só vêm para ADM — a CHAVE nem existe
// na resposta para os demais perfis; a UI testa a presença da chave.
//
// Caminhos começam em `/v1/...` (NEXT_PUBLIC_API_URL já inclui `/api`). IDs são
// sempre `encodeURIComponent`. Nenhum valor pessoal é logado ou vai para a URL.
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";

// -----------------------------------------------------------------------------
// Tipos do contrato
// -----------------------------------------------------------------------------

export interface RoomRecord {
  id: string;
  unit_id: string;
  name: string;
  description: string | null;
  floor: string | null;
  active: boolean;
  source_record_id: string | null;
  /** ISO 8601 UTC. */
  created_at: string | null;
  updated_at: string | null;
}

export interface PersonRecord {
  id: string;
  unit_id: string;
  name: string;
  email: string | null;
  institutional_identifier: string | null;
  active: boolean;
  source_record_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Dado pessoal: a chave só existe para ADM. Ausente => não exibir o campo. */
  phone?: string | null;
}

export interface UnitRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  source_record_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Só ADM recebe a chave. */
  address?: string | null;
}

export type RoomSort = "name" | "-name" | "created_at" | "-created_at" | "updated_at" | "-updated_at";
export type PersonSort = RoomSort | "email" | "-email";

export interface CatalogListParams<TSort extends string> {
  /** Trecho do nome (e-mail, nas pessoas), até 100 caracteres. */
  q?: string;
  unit_id?: string;
  active?: boolean;
  sort?: TSort;
  page?: number;
  /** 50, 100 ou 200 (padrão do backend: 50). */
  page_size?: number;
}

interface PageInfo {
  total: number;
  page: number;
  page_size: number;
}

export interface RoomsListResponse extends PageInfo {
  rooms: RoomRecord[];
}

export interface PeopleListResponse extends PageInfo {
  people: PersonRecord[];
}

/** Criação (`extra="forbid"`): só estes campos. `unit_id` existe apenas aqui. */
export interface CreateRoomRequest {
  unit_id: string;
  name: string;
  description?: string | null;
  floor?: string | null;
}

export interface CreatePersonRequest {
  unit_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  institutional_identifier?: string | null;
}

/** PATCH: ao menos um campo; `null` limpa opcionais; `name` nunca nulo. */
export interface UpdateRoomRequest {
  name?: string;
  description?: string | null;
  floor?: string | null;
  expected_updated_at?: string;
}

export interface UpdatePersonRequest {
  name?: string;
  email?: string | null;
  phone?: string | null;
  institutional_identifier?: string | null;
  expected_updated_at?: string;
}

export interface UpdateUnitRequest {
  name?: string;
  description?: string | null;
  address?: string | null;
  expected_updated_at?: string;
}

/** Corpo opcional de deactivate/activate. */
export interface ActiveActionRequest {
  /** Até 500 caracteres. */
  reason?: string;
  expected_updated_at?: string;
}

// -----------------------------------------------------------------------------
// Construção das chamadas por recurso
// -----------------------------------------------------------------------------

function listSearchParams<TSort extends string>(params: CatalogListParams<TSort>) {
  return {
    q: params.q?.trim() || undefined,
    unit_id: params.unit_id,
    active: params.active,
    sort: params.sort,
    page: params.page,
    page_size: params.page_size,
  };
}

function itemPath(base: string, id: string, suffix = ""): string {
  return `${base}/${encodeURIComponent(id)}${suffix}`;
}

const ROOMS = "/v1/rooms";
const PEOPLE = "/v1/responsible-people";
const UNITS = "/v1/units";

// Salas ------------------------------------------------------------------------

export function listRooms(params: CatalogListParams<RoomSort> = {}): Promise<RoomsListResponse> {
  return apiClient.get<RoomsListResponse>(ROOMS, { searchParams: listSearchParams(params) });
}
export function getRoom(id: string): Promise<RoomRecord> {
  return apiClient.get<RoomRecord>(itemPath(ROOMS, id));
}
export function createRoom(payload: CreateRoomRequest): Promise<RoomRecord> {
  return apiClient.post<RoomRecord>(ROOMS, payload);
}
export function updateRoom(id: string, payload: UpdateRoomRequest): Promise<RoomRecord> {
  return apiClient.patch<RoomRecord>(itemPath(ROOMS, id), payload);
}
export function setRoomActive(id: string, active: boolean, payload: ActiveActionRequest): Promise<RoomRecord> {
  return apiClient.post<RoomRecord>(itemPath(ROOMS, id, active ? "/activate" : "/deactivate"), payload);
}

// Pessoas responsáveis ---------------------------------------------------------

export function listPeople(params: CatalogListParams<PersonSort> = {}): Promise<PeopleListResponse> {
  return apiClient.get<PeopleListResponse>(PEOPLE, { searchParams: listSearchParams(params) });
}
export function getPerson(id: string): Promise<PersonRecord> {
  return apiClient.get<PersonRecord>(itemPath(PEOPLE, id));
}
export function createPerson(payload: CreatePersonRequest): Promise<PersonRecord> {
  return apiClient.post<PersonRecord>(PEOPLE, payload);
}
export function updatePerson(id: string, payload: UpdatePersonRequest): Promise<PersonRecord> {
  return apiClient.patch<PersonRecord>(itemPath(PEOPLE, id), payload);
}
export function setPersonActive(id: string, active: boolean, payload: ActiveActionRequest): Promise<PersonRecord> {
  return apiClient.post<PersonRecord>(itemPath(PEOPLE, id, active ? "/activate" : "/deactivate"), payload);
}

// Unidades. `GET /units` (users-api.ts: só ativas, id/code/name) é o seletor de
// outras telas e NÃO é usado aqui; o cadastro usa `GET /units/catalog` (ADM+AAL2),
// que inclui inativas, busca, ordenação e paginação no servidor.

export type UnitSort = "name" | "-name" | "code" | "-code" | "updated_at" | "-updated_at";

export interface UnitCatalogItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  updated_at: string | null;
  source_record_id: string | null;
  /** Só ADM recebe a chave. */
  address?: string | null;
}

export interface UnitsCatalogResponse extends PageInfo {
  units: UnitCatalogItem[];
}

export function listUnitsCatalog(params: CatalogListParams<UnitSort> = {}): Promise<UnitsCatalogResponse> {
  return apiClient.get<UnitsCatalogResponse>(`${UNITS}/catalog`, {
    searchParams: {
      q: params.q?.trim() || undefined,
      // Padrão do backend é `all`: omitir o parâmetro.
      active: params.active === undefined ? undefined : params.active ? "true" : "false",
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

// Consulta (todos os perfis): `GET /units/accessible` devolve as unidades do
// ESCOPO do usuário (ativas e inativas), sem parâmetros: `{units: [{id, code,
// name, active}]}`. Só leitura; o escopo é decidido pelo backend.

export interface AccessibleUnit {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface AccessibleUnitsResponse {
  units: AccessibleUnit[];
}

export function listAccessibleUnits(): Promise<AccessibleUnitsResponse> {
  return apiClient.get<AccessibleUnitsResponse>(`${UNITS}/accessible`);
}

export function getUnit(id: string): Promise<UnitRecord> {
  return apiClient.get<UnitRecord>(itemPath(UNITS, id));
}
export function updateUnit(id: string, payload: UpdateUnitRequest): Promise<UnitRecord> {
  return apiClient.patch<UnitRecord>(itemPath(UNITS, id), payload);
}
export function setUnitActive(id: string, active: boolean, payload: ActiveActionRequest): Promise<UnitRecord> {
  return apiClient.post<UnitRecord>(itemPath(UNITS, id, active ? "/activate" : "/deactivate"), payload);
}

export { ApiError };
