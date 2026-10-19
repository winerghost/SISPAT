// =============================================================================
// SISPAT-AGU — assets-api.ts
// =============================================================================
// Tipos e chamadas da API de patrimônios (`/api/v1/assets`). Contrato:
// docs/architecture/assets-api.md. Só transporte: perfil, escopo de unidade,
// AAL2, unicidade do número, vínculos e concorrência (`version`) são decididos
// pelo backend Flask.
//
// - O número patrimonial é TEXTO (zeros à esquerda preservados): nunca passa por
//   Number/parseInt nem por formatação numérica.
// - Chaves ausentes (RH não recebe `notes`, `created_by` etc.) simplesmente não
//   existem no objeto: a UI testa a presença da CHAVE.
// - Não existe DELETE: excluir/restaurar são `POST .../delete|restore` (lógico).
// - Caminhos começam em `/v1/...`; IDs sempre com `encodeURIComponent`.
// =============================================================================

import { apiClient } from "@/lib/api-client";

export type LocatedStatus = "SIM" | "NAO" | "DESCONHECIDO";

export interface AssetUnitRef {
  id: string;
  code: string;
  name: string;
}

export interface AssetNamedRef {
  id: string;
  name: string;
}

export interface AssetRecord {
  id: string;
  patrimony_number: string;
  description: string | null;
  unit_id: string;
  unit: AssetUnitRef;
  owner_unit_id: string | null;
  owner_unit: AssetUnitRef | null;
  responsible_person_id: string | null;
  responsible_person: AssetNamedRef | null;
  room_id: string | null;
  room: AssetNamedRef | null;
  location_id: string | null;
  location: AssetNamedRef | null;
  located: LocatedStatus;
  /** AAAA-MM-DD (data de calendário, sem fuso). */
  registration_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  version: number;
  /** ADM e USER; ausente para RH. */
  notes?: string | null;
}

export type AssetSort =
  | "patrimony_number"
  | "-patrimony_number"
  | "description"
  | "-description"
  | "created_at"
  | "-created_at"
  | "updated_at"
  | "-updated_at";

export interface AssetListParams {
  q?: string;
  unit_id?: string;
  room_id?: string;
  responsible_person_id?: string;
  located?: LocatedStatus;
  /** Só ADM (USER/RH recebem 403). */
  include_deleted?: boolean;
  sort?: AssetSort;
  page?: number;
  /** 1 a 100 (padrão do backend: 25). */
  page_size?: number;
}

export interface AssetsListResponse {
  total: number;
  page: number;
  page_size: number;
  assets: AssetRecord[];
}

/** Criação (`extra="forbid"`). `owner_unit_id` e `located` só ADM. */
export interface CreateAssetRequest {
  unit_id: string;
  patrimony_number: string;
  description?: string | null;
  notes?: string | null;
  responsible_person_id?: string | null;
  room_id?: string | null;
  location_id?: string | null;
  registration_date?: string | null;
  owner_unit_id?: string | null;
  located?: LocatedStatus;
}

/** PATCH: `version` + ao menos um campo; `null` limpa opcionais. */
export interface UpdateAssetRequest {
  version: number;
  patrimony_number?: string;
  description?: string | null;
  notes?: string | null;
  responsible_person_id?: string | null;
  room_id?: string | null;
  location_id?: string | null;
  registration_date?: string | null;
  owner_unit_id?: string | null;
  located?: LocatedStatus;
}

export interface AssetActionRequest {
  version: number;
  /** Até 500 caracteres (auditoria). */
  reason?: string;
}

export interface AssetHistoryEntry {
  id: string;
  operation: string;
  occurred_at: string;
  /** Apenas o identificador (sem nome/e-mail). */
  actor_user_id: string | null;
  result: string;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

export interface AssetHistoryResponse {
  total: number;
  page: number;
  page_size: number;
  entries: AssetHistoryEntry[];
}

const ASSETS = "/v1/assets";

function itemPath(id: string, suffix = ""): string {
  return `${ASSETS}/${encodeURIComponent(id)}${suffix}`;
}

export function listAssets(params: AssetListParams = {}): Promise<AssetsListResponse> {
  return apiClient.get<AssetsListResponse>(ASSETS, {
    searchParams: {
      q: params.q?.trim() || undefined,
      unit_id: params.unit_id || undefined,
      room_id: params.room_id || undefined,
      responsible_person_id: params.responsible_person_id || undefined,
      located: params.located,
      // Padrão do backend é `false`: só envia quando verdadeiro.
      include_deleted: params.include_deleted ? "true" : undefined,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

export function getAsset(id: string, options: { includeDeleted?: boolean } = {}): Promise<AssetRecord> {
  return apiClient.get<AssetRecord>(itemPath(id), {
    searchParams: { include_deleted: options.includeDeleted ? "true" : undefined },
  });
}

export function createAsset(payload: CreateAssetRequest): Promise<AssetRecord> {
  return apiClient.post<AssetRecord>(ASSETS, payload);
}

export function updateAsset(id: string, payload: UpdateAssetRequest): Promise<AssetRecord> {
  return apiClient.patch<AssetRecord>(itemPath(id), payload);
}

export function deleteAsset(id: string, payload: AssetActionRequest): Promise<AssetRecord> {
  return apiClient.post<AssetRecord>(itemPath(id, "/delete"), payload);
}

export function restoreAsset(id: string, payload: AssetActionRequest): Promise<AssetRecord> {
  return apiClient.post<AssetRecord>(itemPath(id, "/restore"), payload);
}

export function getAssetHistory(
  id: string,
  params: { page?: number; page_size?: number; includeDeleted?: boolean } = {},
): Promise<AssetHistoryResponse> {
  return apiClient.get<AssetHistoryResponse>(itemPath(id, "/history"), {
    searchParams: {
      page: params.page,
      page_size: params.page_size,
      include_deleted: params.includeDeleted ? "true" : undefined,
    },
  });
}
