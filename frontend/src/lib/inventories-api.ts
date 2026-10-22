// =============================================================================
// SISPAT-AGU — inventories-api.ts
// =============================================================================
// Tipos e chamadas da API de inventários (`/api/v1/inventories`) e de locais
// (`GET /api/v1/locations`). Contrato: docs/architecture/inventories-api.md. Só
// transporte: perfil, escopo de unidade, AAL2, estados, transições, política de
// 1 conferência por bem e o resultado derivado (ENCONTRADO / NAO_ENCONTRADO /
// DIVERGENTE) são decididos pelo backend Flask.
//
// - Inventários e conferências são IMUTÁVEIS: não existe PUT/PATCH/DELETE. Só criar
//   (POST) e as transições únicas start/close/cancel (ADM) e a conferência de bem
//   (`POST /<id>/items`, ADM e USER).
// - Conferidor (`checked_by`), data (`checked_at`) e `result` vêm SEMPRE do servidor.
// - A conferência NÃO altera `assets.located` (decisão do backend).
// - Número patrimonial é TEXTO. IDs sempre com `encodeURIComponent`.
// =============================================================================

import { apiClient } from "@/lib/api-client";

export type InventoryStatus = "ABERTO" | "EM_ANDAMENTO" | "CONCLUIDO" | "CANCELADO";

export type InventoryItemResult = "ENCONTRADO" | "NAO_ENCONTRADO" | "DIVERGENTE";

export interface InventoryUnitRef {
  id: string;
  code: string;
  name: string;
}

export interface InventoryRecord {
  id: string;
  name: string;
  unit_id: string;
  unit: InventoryUnitRef | null;
  /** AAAA-MM-DD (data de calendário). */
  start_date: string | null;
  end_date: string | null;
  status: InventoryStatus;
  created_by: string;
  created_at: string | null;
  closed_at: string | null;
}

export type InventorySort =
  | "created_at"
  | "-created_at"
  | "name"
  | "-name"
  | "start_date"
  | "-start_date"
  | "status"
  | "-status";

export interface InventoryListParams {
  q?: string;
  unit_id?: string;
  status?: InventoryStatus;
  sort?: InventorySort;
  page?: number;
  /** 50, 100 ou 200 (padrão do backend: 50). */
  page_size?: number;
}

export interface InventoriesListResponse {
  total: number;
  page: number;
  page_size: number;
  inventories: InventoryRecord[];
}

/** Resumo calculado NO SERVIDOR; a tela só exibe estes números. */
export interface InventorySummary {
  inventory_id: string;
  status: InventoryStatus;
  total_assets: number;
  checked: number;
  pending: number;
  found: number;
  not_found: number;
  divergent: number;
  /** 0 a 100 (uma casa decimal). */
  progress_percent: number;
}

export interface InventoryItemAssetRef {
  id: string;
  patrimony_number: string;
  description: string | null;
  deleted: boolean;
}

export interface InventoryItemRecord {
  id: string;
  inventory_id: string;
  asset: InventoryItemAssetRef;
  found: boolean;
  result: InventoryItemResult;
  registered_location_id: string | null;
  observed_location_id: string | null;
  checked_by: string | null;
  checked_at: string | null;
  /** Texto livre (nunca HTML). */
  notes: string | null;
}

export type InventoryItemSort = "checked_at" | "-checked_at";

export interface InventoryItemsParams {
  result?: InventoryItemResult;
  sort?: InventoryItemSort;
  page?: number;
  page_size?: number;
}

export interface InventoryItemsResponse {
  total: number;
  page: number;
  page_size: number;
  items: InventoryItemRecord[];
}

/** Criação (`extra="forbid"`): `name` 1..200, `unit_id`, `start_date` opcional AAAA-MM-DD. */
export interface CreateInventoryRequest {
  name: string;
  unit_id: string;
  start_date?: string;
}

/** start/close/cancel: motivo opcional (até 500; só `has_reason` vai à auditoria). */
export interface InventoryActionRequest {
  reason?: string;
}

/** Conferência. `observed_location_id` só com `found=true`; notas até 500. */
export interface CheckInventoryItemRequest {
  asset_id: string;
  found: boolean;
  observed_location_id?: string;
  notes?: string;
}

export type InventoryAction = "start" | "close" | "cancel";

const INVENTORIES = "/v1/inventories";

function itemPath(id: string, suffix = ""): string {
  return `${INVENTORIES}/${encodeURIComponent(id)}${suffix}`;
}

export function listInventories(params: InventoryListParams = {}): Promise<InventoriesListResponse> {
  return apiClient.get<InventoriesListResponse>(INVENTORIES, {
    searchParams: {
      q: params.q?.trim() || undefined,
      unit_id: params.unit_id || undefined,
      status: params.status,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

export function getInventory(id: string): Promise<InventoryRecord> {
  return apiClient.get<InventoryRecord>(itemPath(id));
}

export function getInventorySummary(id: string): Promise<InventorySummary> {
  return apiClient.get<InventorySummary>(itemPath(id, "/summary"));
}

export function listInventoryItems(id: string, params: InventoryItemsParams = {}): Promise<InventoryItemsResponse> {
  return apiClient.get<InventoryItemsResponse>(itemPath(id, "/items"), {
    searchParams: { result: params.result, sort: params.sort, page: params.page, page_size: params.page_size },
  });
}

export function createInventory(payload: CreateInventoryRequest): Promise<InventoryRecord> {
  return apiClient.post<InventoryRecord>(INVENTORIES, payload);
}

export function transitionInventory(
  id: string,
  action: InventoryAction,
  payload: InventoryActionRequest,
): Promise<InventoryRecord> {
  return apiClient.post<InventoryRecord>(itemPath(id, `/${action}`), payload);
}

export function checkInventoryItem(id: string, payload: CheckInventoryItemRequest): Promise<InventoryItemRecord> {
  return apiClient.post<InventoryItemRecord>(itemPath(id, "/items"), payload);
}

// -----------------------------------------------------------------------------
// Locais de guarda (`GET /api/v1/locations`, somente leitura, escopo de unidade)
// -----------------------------------------------------------------------------

export interface LocationRecord {
  id: string;
  unit_id: string;
  room_id: string | null;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface LocationsListResponse {
  total: number;
  page: number;
  page_size: number;
  locations: LocationRecord[];
}

export interface LocationListParams {
  unit_id?: string;
  room_id?: string;
  active?: boolean;
  q?: string;
  sort?: "name" | "-name" | "created_at" | "-created_at" | "updated_at" | "-updated_at";
  page?: number;
  /** 50, 100 ou 200. */
  page_size?: number;
}

export function listLocations(params: LocationListParams = {}): Promise<LocationsListResponse> {
  return apiClient.get<LocationsListResponse>("/v1/locations", {
    searchParams: {
      unit_id: params.unit_id || undefined,
      room_id: params.room_id || undefined,
      active: params.active,
      q: params.q?.trim() || undefined,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}
